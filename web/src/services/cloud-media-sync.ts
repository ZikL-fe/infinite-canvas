/** 云端业务保存前的按需媒体上传与序列化辅助：避免草稿/未发送参考图提前占用云端存储空间。 */
import { createImageThumbnail, createVideoThumbnail } from "@/lib/image-thumbnail";
import { storageApi } from "@/services/api/server";
import {
    inferCloudMediaKind,
    isCloudAuthenticated,
    isUserCloudQuotaExceeded,
    notifyCloudStorageQuotaExceeded,
    notifyCloudWorkspaceChanged,
    uploadBlobToCloud,
} from "@/services/cloud-media";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";

const inFlightCloudUploads = new Map<string, Promise<boolean>>();

/** 递归剔除序列化数据中的临时 blob: URL，避免污染云端持久化结构。 */
export function stripBlobUrls<T>(value: T): T {
    if (typeof value === "string") {
        return (value.startsWith("blob:") ? "" : value) as unknown as T;
    }
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) {
        return value.map((item) => stripBlobUrls(item)) as unknown as T;
    }
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
        next[k] = stripBlobUrls(v);
    }
    return next as T;
}

/** 递归收集对象内全部 `storageKey`（格式为 `kind:id`）。 */
export function collectStorageKeys(value: unknown, keys = new Set<string>()): string[] {
    if (!value || typeof value !== "object") return [...keys];
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) {
        keys.add(value.storageKey);
    }
    Object.values(value).forEach((item) => {
        if (Array.isArray(item)) item.forEach((child) => collectStorageKeys(child, keys));
        else collectStorageKeys(item, keys);
    });
    return [...keys];
}

async function readImageDimensions(blob: Blob): Promise<{ width?: number; height?: number }> {
    if (typeof createImageBitmap === "function") {
        try {
            const bitmap = await createImageBitmap(blob);
            const width = bitmap.width;
            const height = bitmap.height;
            bitmap.close();
            if (width > 0 && height > 0) return { width, height };
        } catch {
            // fallback to Image element below
        }
    }
    return new Promise((resolve) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        const done = (width?: number, height?: number) => {
            URL.revokeObjectURL(url);
            resolve(width && height ? { width, height } : {});
        };
        img.onload = () => done(img.naturalWidth, img.naturalHeight);
        img.onerror = () => done();
        img.src = url;
    });
}

async function uploadSingleKeyIfMissing(key: string): Promise<boolean> {
    const existingTask = inFlightCloudUploads.get(key);
    if (existingTask) return existingTask;

    const task = (async () => {
        const blob = key.startsWith("image:") ? await getImageBlob(key) : await getMediaBlob(key);
        if (!blob) return true;
        if (isUserCloudQuotaExceeded(blob.size)) {
            notifyCloudStorageQuotaExceeded();
            return false;
        }
        const kind = inferCloudMediaKind(key, blob.type);
        const isImage = kind === "image" || blob.type.startsWith("image/");
        const isVideo = kind === "video" || blob.type.startsWith("video/");
        const [dims, thumbnailBlob] = await Promise.all([
            isImage ? readImageDimensions(blob) : Promise.resolve({}),
            isImage
                ? createImageThumbnail(blob, 480).catch(() => undefined).then((thumb) => thumb || blob)
                : isVideo
                  ? createVideoThumbnail(blob, 480).catch(() => undefined)
                  : Promise.resolve(undefined),
        ]);
        await uploadBlobToCloud(key, blob, kind, {
            ...dims,
            sourceType: "upload",
            ...(thumbnailBlob ? { thumbnailBlob } : {}),
        });
        return true;
    })().finally(() => {
        inFlightCloudUploads.delete(key);
    });

    inFlightCloudUploads.set(key, task);
    return task;
}

/** 仅在业务记录真正保存/同步到云端时，把尚未上云的本地暂存媒体补传至对象存储。 */
export async function ensureCloudMediaUploaded(payload: unknown): Promise<boolean> {
    if (!isCloudAuthenticated()) return false;
    const keys = collectStorageKeys(payload);
    if (!keys.length) return true;
    const { existingIds } = await storageApi.checkExists(keys).catch(() => ({ existingIds: [] as string[] }));
    const existing = new Set(existingIds);
    const missing = keys.filter((key) => !existing.has(key));
    if (!missing.length) return true;
    if (isUserCloudQuotaExceeded(0)) {
        notifyCloudStorageQuotaExceeded();
        return false;
    }
    let uploadedAny = false;
    for (const key of missing) {
        const ok = await uploadSingleKeyIfMissing(key);
        if (!ok) return false;
        uploadedAny = true;
    }
    if (uploadedAny) {
        notifyCloudWorkspaceChanged("media", { sync: false });
    }
    return true;
}
