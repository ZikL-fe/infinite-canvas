import localforage from "localforage";
import { nanoid } from "nanoid";

import { createVideoThumbnail } from "@/lib/image-thumbnail";
import { storageApi } from "@/services/api/server";
import { withLocalProxy } from "@/stores/use-config-store";
import {
    clearCloudMediaUrlCache,
    deleteCloudMedia,
    fetchCloudMediaBlob,
    inferCloudMediaKind,
    isCloudAuthenticated,
    prefetchCloudMediaUrls,
    resolveCloudMediaUrl,
    uploadBlobToCloud,
} from "@/services/cloud-media";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const imageLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });
const videoLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });
const objectUrls = new Map<string, string>();

export async function uploadMediaFile(
    input: string | Blob,
    prefix = "file",
    options?: { sourceType?: "upload" | "ai_generated" | "canvas_import"; filename?: string; existingStorageKey?: string; localOnly?: boolean },
): Promise<UploadedFile> {
    const blob = typeof input === "string" ? await (await fetch(withLocalProxy(input))).blob() : input;
    const storageKey = options?.existingStorageKey || `${prefix}:${nanoid()}`;
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    const meta = blob.type.startsWith("video/") ? await readVideoMeta(url) : blob.type.startsWith("audio/") ? await readAudioMeta(url) : {};
    const thumbnailBlob = blob.type.startsWith("video/") ? await createVideoThumbnail(blob, 480).catch(() => undefined) : undefined;
    if (options?.existingStorageKey) {
        if (!options?.localOnly && thumbnailBlob && isCloudAuthenticated()) {
            void storageApi.uploadThumbnail(storageKey, thumbnailBlob).catch(() => undefined);
        }
    } else if (!options?.localOnly) {
        await uploadBlobToCloud(storageKey, blob, inferCloudMediaKind(storageKey, blob.type), {
            ...meta,
            filename: options?.filename,
            sourceType: options?.sourceType,
            thumbnailBlob,
        });
    }
    return { url, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
}

/** 过滤本地已缓存的音视频/文件 key，批量预取剩余云端签名地址。 */
export async function prefetchUncachedMediaUrls(keys: Iterable<string>) {
    const unique = Array.from(new Set(keys)).filter((key) => key.includes(":") && !key.startsWith("image:") && !objectUrls.has(key));
    if (!unique.length) return;
    const localKeys = new Set(await store.keys().catch(() => [] as string[]));
    const missing = unique.filter((key) => !localKeys.has(key));
    if (missing.length) await prefetchCloudMediaUrls(missing);
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
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

export async function getMediaBlob(storageKey: string) {
    const local = await store.getItem<Blob>(storageKey);
    if (local) return local;
    return fetchCloudMediaBlob(storageKey, async (blob) => {
        await store.setItem(storageKey, blob);
        const url = URL.createObjectURL(blob);
        objectUrls.set(storageKey, url);
    });
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
    await store.setItem(storageKey, blob);
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    await uploadBlobToCloud(storageKey, blob, inferCloudMediaKind(storageKey, blob.type));
    return url;
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    await deleteCloudMedia(keys);
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await store.removeItem(key);
        }),
    );
}

export async function cleanupUnusedMedia(usedData: unknown) {
    const usedKeys = collectMediaStorageKeys(usedData);
    await Promise.all([
        imageLogStore.iterate((value) => {
            collectMediaStorageKeys(value, usedKeys);
        }),
        videoLogStore.iterate((value) => {
            collectMediaStorageKeys(value, usedKeys);
        }),
    ]);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    if (unused.length) {
        await deleteStoredMedia(unused);
    }
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

export async function clearLocalMediaFileCache() {
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.clear();
    clearCloudMediaUrlCache();
    await store.clear().catch(() => undefined);
}

function readVideoMeta(url: string) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        const done = () => resolve({ width: video.videoWidth || 1280, height: video.videoHeight || 720, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined });
        video.onloadedmetadata = done;
        video.onerror = done;
        video.src = url;
    });
}

function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        const done = () => resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.src = url;
    });
}
