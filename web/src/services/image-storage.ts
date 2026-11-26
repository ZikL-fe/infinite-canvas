import localforage from "localforage";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { withLocalProxy } from "@/stores/use-config-store";
import { createImageThumbnail } from "@/lib/image-thumbnail";
import {
    clearCloudMediaUrlCache,
    evictCloudMediaUrlCache,
    fetchCloudMediaBlob,
    fetchCloudThumbnailBlob,
    getCachedCloudThumbnailUrl,
    isCloudMediaMissing,
    prefetchCloudMediaUrls,
    resolveCloudMediaUrl,
    uploadBlobToCloud,
} from "@/services/cloud-media";

export type UploadedImage = {
    url: string;
    storageKey?: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const previewStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_previews" });
const imageLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });
const videoLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });
const objectUrls = new Map<string, string>();
const previewUrls = new Map<string, string>();
const previewListeners = new Set<() => void>();
let previewRevision = 0;
const PREVIEW_CONCURRENCY = 4;
const pendingPreviewKeys = new Set<string>();
const failedPreviewKeys = new Set<string>();
const previewTaskQueue: string[] = [];
let activePreviewWorkers = 0;
let previewNotifyScheduled = false;
const IMAGE_PREVIEW_VERSION = 1;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const IMAGE_REMOTE_LOAD_TIMEOUT_MS = 10 * 60_000;
const IMAGE_DECODE_TIMEOUT_MS = 10_000;
const IMAGE_RESPONSE_ERROR = "ImageResponseError";
const IMAGE_TIMEOUT_ERROR = "ImageTimeoutError";

type StoredImagePreview = { version: number; blob?: Blob };

type ImageReadOptions = { signal?: AbortSignal; sourceType?: "upload" | "ai_generated" | "canvas_import"; filename?: string; existingStorageKey?: string; localOnly?: boolean };

export async function resolvePickedImage(
    payload: { dataUrl: string; storageKey?: string },
    options?: { localOnly?: boolean },
): Promise<{ url: string; storageKey?: string; mimeType: string }> {
    if (payload.storageKey) {
        const blob = await getImageBlob(payload.storageKey).catch(() => null);
        if (blob) {
            void ensureImagePreview(payload.storageKey);
            const url = await resolveImageUrl(payload.storageKey, payload.dataUrl);
            return {
                url,
                storageKey: payload.storageKey,
                mimeType: blob.type.startsWith("image/") ? blob.type : "",
            };
        }
    }
    if (!payload.dataUrl) throw new Error(i18n.t("common.imageReadFailed"));
    const stored = await uploadImage(payload.dataUrl, { existingStorageKey: payload.storageKey, localOnly: options?.localOnly });
    return { url: stored.url, storageKey: stored.storageKey, mimeType: stored.mimeType };
}

export async function uploadImage(input: string | Blob, options?: ImageReadOptions): Promise<UploadedImage> {
    if (typeof input !== "string") return storeImage(input, options);

    let blob: Blob;
    try {
        blob = await fetchImageBlob(input, options);
    } catch (error) {
        if (options?.signal?.aborted) throw error;
        if (options?.existingStorageKey) {
            const cloudBlob = await getImageBlob(options.existingStorageKey).catch(() => null);
            if (cloudBlob) return storeImage(cloudBlob, options);
        }
        if (isNamedError(error, IMAGE_RESPONSE_ERROR) || isNamedError(error, IMAGE_TIMEOUT_ERROR) || !/^https?:\/\//i.test(input)) throw error;
        const meta = await loadImageMeta(input, options, IMAGE_REMOTE_LOAD_TIMEOUT_MS);
        if (!meta) throw error;
        return { url: input, ...(options?.existingStorageKey ? { storageKey: options.existingStorageKey } : {}), width: meta.width, height: meta.height, bytes: 0, mimeType: "" };
    }
    return storeImage(blob, options);
}

async function storeImage(blob: Blob, options?: ImageReadOptions): Promise<UploadedImage> {
    const storageKey = options?.existingStorageKey || `image:${nanoid()}`;
    const alreadyInS3 = Boolean(options?.existingStorageKey);
    const url = URL.createObjectURL(blob);
    try {
        const meta = await loadImageMeta(url, options);
        if (!meta) throw new Error(i18n.t("common.imageReadFailed"));
        throwIfAborted(options?.signal);
        await store.setItem(storageKey, blob);
        throwIfAborted(options?.signal);
        objectUrls.set(storageKey, url);
        await storeImagePreview(storageKey, blob);
        if (!options?.localOnly) {
            const cloudThumb = (await createImageThumbnail(blob, 480).catch(() => undefined)) || blob;
            await uploadBlobToCloud(storageKey, blob, "image", {
                width: meta.width,
                height: meta.height,
                filename: options?.filename,
                sourceType: options?.sourceType,
                alreadyInS3,
                thumbnailBlob: cloudThumb,
            });
        }
        return { url, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type.startsWith("image/") ? blob.type : "" };
    } catch (error) {
        URL.revokeObjectURL(url);
        await store.removeItem(storageKey).catch(() => undefined);
        throw error;
    }
}

async function fetchImageBlob(url: string, options?: ImageReadOptions) {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (options?.signal?.aborted) abort();
    else options?.signal?.addEventListener("abort", abort, { once: true });
    const timer = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, IMAGE_DOWNLOAD_TIMEOUT_MS);
    try {
        const response = await fetch(withLocalProxy(url), { signal: controller.signal });
        if (!response.ok) throw namedError(IMAGE_RESPONSE_ERROR);
        return await response.blob();
    } catch (error) {
        if (timedOut) throw namedError(IMAGE_TIMEOUT_ERROR);
        if (options?.signal?.aborted) throw abortReason(options.signal);
        throw error;
    } finally {
        window.clearTimeout(timer);
        options?.signal?.removeEventListener("abort", abort);
    }
}

function loadImageMeta(url: string, options?: ImageReadOptions, timeoutMs = IMAGE_DECODE_TIMEOUT_MS) {
    return new Promise<{ width: number; height: number } | null>((resolve, reject) => {
        if (options?.signal?.aborted) return reject(abortReason(options.signal));
        const image = new Image();
        let settled = false;
        const finish = (value: { width: number; height: number } | null) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            options?.signal?.removeEventListener("abort", abort);
            image.onload = null;
            image.onerror = null;
            resolve(value);
        };
        const abort = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            image.onload = null;
            image.onerror = null;
            reject(abortReason(options!.signal!));
        };
        const timer = window.setTimeout(() => finish(null), timeoutMs);
        options?.signal?.addEventListener("abort", abort, { once: true });
        image.onload = () => finish(image.naturalWidth && image.naturalHeight ? { width: image.naturalWidth, height: image.naturalHeight } : null);
        image.onerror = () => finish(null);
        image.src = url;
    });
}

function namedError(name: string) {
    const error = new Error(i18n.t("common.imageReadFailed"));
    error.name = name;
    return error;
}

function isNamedError(error: unknown, name: string) {
    return error instanceof Error && error.name === name;
}

function abortReason(signal: AbortSignal) {
    return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw abortReason(signal);
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await store.getItem<Blob>(storageKey);
    if (blob) {
        const url = URL.createObjectURL(blob);
        objectUrls.set(storageKey, url);
        return url;
    }
    return resolveCloudMediaUrl(storageKey, fallback);
}

export async function getImageBlob(storageKey: string) {
    const local = await store.getItem<Blob>(storageKey);
    if (local) return local;
    return fetchCloudMediaBlob(storageKey, async (blob) => {
        await store.setItem(storageKey, blob);
        const url = URL.createObjectURL(blob);
        objectUrls.set(storageKey, url);
    });
}

/** 过滤掉本地 IndexedDB 或内存已缓存的图片 key，批量预取剩余云端签名地址。 */
export async function prefetchUncachedImageUrls(keys: Iterable<string>) {
    const unique = Array.from(new Set(keys)).filter((key) => key.startsWith("image:") && !objectUrls.has(key));
    if (!unique.length) return;
    const localKeys = new Set(await store.keys().catch(() => [] as string[]));
    const missing = unique.filter((key) => !localKeys.has(key));
    if (missing.length) await prefetchCloudMediaUrls(missing);
}

// 缩略图按图片的 storageKey 另存一份 WebP，只放在本地 IndexedDB 里，不写进节点数据，也不参与导出和 WebDAV 同步。
// 若会话内已通过批量接口拿到云端缩略图预签名 URL，则直接复用避免重复下载写库。
export function previewUrlFor(storageKey?: string) {
    if (!storageKey) return undefined;
    return previewUrls.get(storageKey) || getCachedCloudThumbnailUrl(storageKey);
}

// 缩略图在后台补，生成完成后合并到下一帧通知订阅界面重渲染，避免单张完成引起整页频繁抖动。
export function subscribeImagePreviews(listener: () => void) {
    previewListeners.add(listener);
    return () => {
        previewListeners.delete(listener);
    };
}

export function getImagePreviewRevision() {
    return previewRevision;
}

function schedulePreviewNotify() {
    if (previewNotifyScheduled) return;
    previewNotifyScheduled = true;
    const flush = () => {
        previewNotifyScheduled = false;
        previewRevision += 1;
        previewListeners.forEach((listener) => listener());
    };
    if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(flush);
    } else {
        queueMicrotask(flush);
    }
}

export async function ensureImagePreview(storageKey?: string) {
    if (!storageKey || failedPreviewKeys.has(storageKey) || isCloudMediaMissing(storageKey)) return undefined;
    const cached = previewUrlFor(storageKey);
    if (cached) return cached;
    const stored = await previewStore.getItem<StoredImagePreview>(storageKey).catch(() => null);
    if (stored?.version === IMAGE_PREVIEW_VERSION) return stored.blob ? cacheImagePreview(storageKey, stored.blob) : undefined;
    queueImagePreview(storageKey);
    return undefined;
}

// 缩略图生成按并发上限排队执行，并按 storageKey 去重；云端图片优先拉取云端缩略图，避免下载原图。
function queueImagePreview(storageKey: string) {
    if (pendingPreviewKeys.has(storageKey) || failedPreviewKeys.has(storageKey)) return;
    pendingPreviewKeys.add(storageKey);
    previewTaskQueue.push(storageKey);
    while (activePreviewWorkers < PREVIEW_CONCURRENCY && previewTaskQueue.length) {
        activePreviewWorkers += 1;
        void runPreviewWorker().finally(() => {
            activePreviewWorkers = Math.max(0, activePreviewWorkers - 1);
        });
    }
}

async function runPreviewWorker() {
    while (previewTaskQueue.length) {
        const storageKey = previewTaskQueue.shift();
        if (!storageKey) continue;
        try {
            const cloudThumb = await fetchCloudThumbnailBlob(storageKey);
            if (cloudThumb) {
                await previewStore.setItem<StoredImagePreview>(storageKey, { version: IMAGE_PREVIEW_VERSION, blob: cloudThumb }).catch(() => undefined);
                cacheImagePreview(storageKey, cloudThumb);
                continue;
            }
            const original = await getImageBlob(storageKey);
            if (original) {
                await storeImagePreview(storageKey, original);
            } else {
                failedPreviewKeys.add(storageKey);
            }
        } catch {
            // 拉取失败后记入当前会话失败集合，避免页面重渲染或翻页反复重试缺失文件
            failedPreviewKeys.add(storageKey);
        } finally {
            pendingPreviewKeys.delete(storageKey);
        }
    }
}

async function storeImagePreview(storageKey: string, original: Blob) {
    const preview = await createImageThumbnail(original).catch(() => undefined);
    await previewStore.setItem<StoredImagePreview>(storageKey, { version: IMAGE_PREVIEW_VERSION, blob: preview }).catch(() => undefined);
    return preview ? cacheImagePreview(storageKey, preview) : undefined;
}

function cacheImagePreview(storageKey: string, preview: Blob) {
    const url = URL.createObjectURL(preview);
    previewUrls.set(storageKey, url);
    schedulePreviewNotify();
    return url;
}

async function deleteImagePreview(storageKey: string) {
    const url = previewUrls.get(storageKey);
    if (url) URL.revokeObjectURL(url);
    previewUrls.delete(storageKey);
    await previewStore.removeItem(storageKey).catch(() => undefined);
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    await deleteImagePreview(storageKey);
    await storeImagePreview(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    await uploadBlobToCloud(storageKey, blob, "image");
    return url;
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }, options?: ImageReadOptions) {
    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));
    if (!url || url.startsWith("data:")) return url;
    return blobToDataUrl(await fetchImageBlob(url, options));
}

/** 仅清理本地 IndexedDB 与对象 URL 缓存（云端媒体清理由服务端按跨模块引用安全回收）。 */
export async function purgeLocalStoredImages(keys: Iterable<string>) {
    const uniqueKeys = Array.from(new Set(keys)).filter(Boolean);
    if (!uniqueKeys.length) return;
    evictCloudMediaUrlCache(uniqueKeys);
    await Promise.all(
        uniqueKeys.map(async (key) => {
            pendingPreviewKeys.delete(key);
            failedPreviewKeys.delete(key);
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await deleteImagePreview(key);
            await store.removeItem(key).catch(() => undefined);
        }),
    );
}

export async function cleanupUnusedImages(usedData: unknown) {
    const usedKeys = collectImageStorageKeys(usedData);
    await Promise.all([
        imageLogStore.iterate((value) => {
            collectImageStorageKeys(value, usedKeys);
        }),
        videoLogStore.iterate((value) => {
            collectImageStorageKeys(value, usedKeys);
        }),
    ]);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    const orphanPreviews: string[] = [];
    await previewStore.iterate((_value, key) => {
        if (!usedKeys.has(key)) orphanPreviews.push(key);
    });
    await Promise.all([purgeLocalStoredImages(unused), ...orphanPreviews.map(deleteImagePreview)]);
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

export async function clearLocalImageAndWorkbenchCaches() {
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.clear();
    previewUrls.forEach((url) => URL.revokeObjectURL(url));
    previewUrls.clear();
    pendingPreviewKeys.clear();
    failedPreviewKeys.clear();
    previewTaskQueue.length = 0;
    clearCloudMediaUrlCache();
    previewListeners.forEach((listener) => listener());
    await Promise.all([
        store.clear().catch(() => undefined),
        previewStore.clear().catch(() => undefined),
        imageLogStore.clear().catch(() => undefined),
        videoLogStore.clear().catch(() => undefined),
    ]);
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(i18n.t("common.imageReadFailed")));
        reader.readAsDataURL(blob);
    });
}
