/** 云端媒体读写桥接：负责对象存储直传/读取/清理，并将 AI 生成素材自动归档至已授权的 WebDAV。 */
import { message as antdMessage } from "antd";

import { authApi, storageApi } from "@/services/api/server";
import { useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

type CloudKind = "image" | "video" | "audio" | "file";

const inFlightUrls = new Map<string, Promise<string>>();
const inFlightBlobs = new Map<string, Promise<Blob | null>>();
let cloudSyncHydrated = false;
let lastQuotaWarningAt = 0;

export function isCloudAuthenticated() {
    return Boolean(useUserStore.getState().accessToken);
}

export function isUserCloudQuotaExpired() {
    const user = useUserStore.getState().user;
    if (!user?.storageQuotaExpiresAt) return false;
    return new Date(user.storageQuotaExpiresAt).getTime() <= Date.now();
}

export function isUserCloudQuotaExceeded(incomingBytes = 0) {
    const user = useUserStore.getState().user;
    if (!user) return false;
    if (isUserCloudQuotaExpired()) return true;
    const quota = Math.max(0, Number(user.storageQuotaBytes ?? 0));
    const used = Math.max(0, Number(user.storageUsedBytes ?? 0));
    const incoming = Math.max(0, Number(incomingBytes ?? 0));
    if (quota <= 0 || used >= quota) return true;
    return incoming > 0 && used + incoming > quota;
}

export function notifyCloudStorageQuotaExceeded() {
    const now = Date.now();
    if (now - lastQuotaWarningAt < 3500) return;
    lastQuotaWarningAt = now;
    if (isUserCloudQuotaExpired()) {
        antdMessage.warning("您的云端存储配额已过期，已暂停云端上传（内容仍保存在本地），请联系管理员续期或扩容");
        return;
    }
    antdMessage.warning("云端存储配额不足，已暂停云端上传（内容仍保存在本地），请清理云端媒体或联系管理员扩容");
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
    meta?: {
        width?: number;
        height?: number;
        durationMs?: number;
        filename?: string;
        sourceType?: "upload" | "ai_generated" | "canvas_import";
        alreadyInS3?: boolean;
        thumbnailBlob?: Blob;
    },
) {
    if (!isCloudAuthenticated()) return;

    let user = useUserStore.getState().user;
    if (user && typeof user.storageQuotaBytes !== "number") {
        const refreshed = await authApi.me().catch(() => null);
        if (refreshed?.user) {
            useUserStore.getState().setUser(refreshed.user);
            user = refreshed.user;
        }
    }

    let uploadedToS3 = Boolean(meta?.alreadyInS3);
    if (meta?.alreadyInS3) {
        void authApi
            .me()
            .then((res) => useUserStore.getState().setUser(res.user))
            .catch(() => undefined);
    } else if (isUserCloudQuotaExceeded(blob.size)) {
        notifyCloudStorageQuotaExceeded();
    } else {
        try {
            await storageApi.uploadBlobWithKey(storageKey, blob, kind, meta);
            uploadedToS3 = true;
        } catch (error) {
            const msg = error instanceof Error ? error.message : "";
            if (msg.includes("配额不足") || msg.includes("已过期") || msg.includes("扩容") || msg.includes("续期")) {
                notifyCloudStorageQuotaExceeded();
                void authApi
                    .me()
                    .then((res) => useUserStore.getState().setUser(res.user))
                    .catch(() => undefined);
            } else {
                console.warn("[cloud-media] 上传对象存储失败（已保留本地缓存）:", error);
            }
        }
    }

    if (uploadedToS3 && meta?.thumbnailBlob) {
        void storageApi.uploadThumbnail(storageKey, meta.thumbnailBlob).catch(() => undefined);
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

export async function fetchCloudThumbnailBlob(storageKey: string): Promise<Blob | null> {
    if (!isCloudAuthenticated() || !storageKey) return null;
    try {
        const { thumbnailUrl } = await storageApi.getThumbnailUrl(storageKey);
        if (!thumbnailUrl) return null;
        const res = await fetch(thumbnailUrl);
        if (!res.ok) return null;
        return await res.blob();
    } catch {
        return null;
    }
}

export async function deleteCloudMedia(keys: Iterable<string>) {
    if (!isCloudAuthenticated() || !cloudSyncHydrated) return;
    await Promise.all(Array.from(new Set(keys)).map((key) => storageApi.remove(key).catch(() => undefined)));
}
