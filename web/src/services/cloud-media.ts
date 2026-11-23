/** 云端媒体读写桥接：负责对象存储直传/读取/清理，并将 AI 生成素材自动归档至已授权的 WebDAV。 */
import { storageApi } from "@/services/api/server";
import { useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

type CloudKind = "image" | "video" | "audio" | "file";

const inFlightUrls = new Map<string, Promise<string>>();
const inFlightBlobs = new Map<string, Promise<Blob | null>>();
let cloudSyncHydrated = false;

export function isCloudAuthenticated() {
    return Boolean(useUserStore.getState().accessToken);
}

export function setCloudSyncHydrated(value: boolean) {
    cloudSyncHydrated = value;
}

export function isCloudSyncHydrated() {
    return cloudSyncHydrated;
}

export function inferCloudMediaKind(storageKey: string, mimeType = ""): CloudKind {
    if (storageKey.startsWith("image:") || mimeType.startsWith("image/")) return "image";
    if (storageKey.startsWith("video") || mimeType.startsWith("video/")) return "video";
    if (storageKey.startsWith("audio") || mimeType.startsWith("audio/")) return "audio";
    return "file";
}

/** 将媒体文件上传至云端对象存储；若来源为 AI 生成且 WebDAV 配额有效，同步后台归档一份到 WebDAV。 */
export async function uploadBlobToCloud(
    storageKey: string,
    blob: Blob,
    kind: CloudKind,
    meta?: { width?: number; height?: number; durationMs?: number; filename?: string; sourceType?: "upload" | "ai_generated" | "canvas_import" },
) {
    if (!isCloudAuthenticated()) return;
    try {
        await storageApi.uploadBlobWithKey(storageKey, blob, kind, meta);
    } catch (error) {
        console.warn("[cloud-media] 上传对象存储失败（已保留本地缓存）:", error);
    }

    if (meta?.sourceType === "ai_generated") {
        const webdav = useConfigStore.getState().webdav;
        if (webdav.enabled !== false && webdav.url && !webdav.isExpired && !webdav.isQuotaExceeded) {
            void storageApi
                .uploadToWebdav(storageKey, blob, kind, meta.filename)
                .then((res) => {
                    useConfigStore.getState().updateWebdavConfig("usedBytes", res.usedBytes);
                    if (res.quotaBytes !== null && res.usedBytes >= res.quotaBytes) {
                        useConfigStore.getState().updateWebdavConfig("isQuotaExceeded", true);
                    }
                })
                .catch((error) => {
                    console.warn("[cloud-media] 自动保存至 WebDAV 失败:", error);
                });
        }
    }
}

export async function resolveCloudMediaUrl(storageKey: string, fallback = ""): Promise<string> {
    if (!isCloudAuthenticated() || !storageKey) return fallback;
    const pending = inFlightUrls.get(storageKey);
    if (pending) return pending;

    const promise = storageApi
        .getUrl(storageKey)
        .then((res) => res.url || fallback)
        .catch(() => fallback)
        .finally(() => {
            inFlightUrls.delete(storageKey);
        });
    inFlightUrls.set(storageKey, promise);
    return promise;
}

export async function fetchCloudMediaBlob(storageKey: string, cacheLocal: (blob: Blob) => Promise<void>): Promise<Blob | null> {
    if (!isCloudAuthenticated() || !storageKey) return null;
    const pending = inFlightBlobs.get(storageKey);
    if (pending) return pending;

    const promise = (async () => {
        try {
            const url = await resolveCloudMediaUrl(storageKey);
            if (!url) return null;
            const res = await fetch(url);
            if (!res.ok) return null;
            const blob = await res.blob();
            await cacheLocal(blob);
            return blob;
        } catch {
            return null;
        } finally {
            inFlightBlobs.delete(storageKey);
        }
    })();
    inFlightBlobs.set(storageKey, promise);
    return promise;
}

export async function deleteCloudMedia(keys: Iterable<string>) {
    if (!isCloudAuthenticated() || !cloudSyncHydrated) return;
    await Promise.all(Array.from(new Set(keys)).map((key) => storageApi.remove(key).catch(() => undefined)));
}
