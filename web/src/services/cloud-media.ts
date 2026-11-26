/** 云端媒体读写桥接：负责对象存储直传/读取/清理，并将 AI 生成素材自动归档至已授权的 WebDAV。 */
import { message as antdMessage } from "antd";

import i18n from "@/i18n";
import { authApi, storageApi } from "@/services/api/server";
import { useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

type CloudKind = "image" | "video" | "audio" | "file";
export type WorkspaceChangeScope = "canvas" | "image" | "video" | "assets" | "media" | "all";
export const WORKSPACE_CHANGED_EVENT = "infinite-canvas:workspace-data-changed";

const inFlightUrls = new Map<string, Promise<string>>();
const inFlightBlobs = new Map<string, Promise<Blob | null>>();
const urlCache = new Map<string, { url: string; expiresAt: number }>();
const thumbnailUrlCache = new Map<string, { url: string; expiresAt: number }>();
const missingCloudMediaKeys = new Set<string>();
const missingCloudThumbKeys = new Set<string>();
const URLS_BATCH_LIMIT = 100;
const DEFAULT_PRESIGN_EXPIRES_SECONDS = 900;
const PRESIGN_CACHE_BUFFER_SECONDS = 60;
const TAB_INSTANCE_ID = Math.random().toString(36).slice(2);
let syncChannel: BroadcastChannel | null = null;
let cloudSyncHydrated = false;
let lastQuotaWarningAt = 0;

function getSyncChannel() {
    if (typeof BroadcastChannel === "undefined") return null;
    if (!syncChannel) syncChannel = new BroadcastChannel("infinite-canvas:sync");
    return syncChannel;
}

/** 广播工作区/媒体数据变更到当前页面与同浏览器其他标签页。 */
export function notifyCloudWorkspaceChanged(scope: WorkspaceChangeScope = "all", options?: { sync?: boolean }) {
    if (typeof window === "undefined") return;
    const sync = options?.sync !== false;
    window.dispatchEvent(new CustomEvent(WORKSPACE_CHANGED_EVENT, { detail: { scope, sync } }));
    try {
        getSyncChannel()?.postMessage({ type: "workspace-data-changed", scope, sync, senderId: TAB_INSTANCE_ID });
    } catch {
        // ignore BroadcastChannel error
    }
}

/** 订阅来自其他浏览器标签页的工作区变更广播。 */
export function initWorkspaceBroadcastChannel(onRemoteChange: (scope: WorkspaceChangeScope, sync: boolean) => void) {
    const ch = getSyncChannel();
    if (!ch) return;
    ch.onmessage = (event: MessageEvent<{ type?: string; scope?: WorkspaceChangeScope; sync?: boolean; senderId?: string }>) => {
        const data = event.data;
        if (!data || data.type !== "workspace-data-changed" || data.senderId === TAB_INSTANCE_ID) return;
        onRemoteChange(data.scope || "all", data.sync !== false);
    };
}

/** 判断当前是否存在已登录的云端访问令牌。 */
export function isCloudAuthenticated() {
    return Boolean(useUserStore.getState().accessToken);
}

/** 判断当前用户云端存储配额是否已过期。 */
export function isUserCloudQuotaExpired() {
    const user = useUserStore.getState().user;
    if (!user?.storageQuotaExpiresAt) return false;
    return new Date(user.storageQuotaExpiresAt).getTime() <= Date.now();
}

/** 判断当前用户云端存储配额是否已超限（含可选待写入的增量字节数）。 */
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

/** 节流弹出云端存储配额到期或已满警告提示（3.5 秒内不重复弹出）。 */
export function notifyCloudStorageQuotaExceeded() {
    const now = Date.now();
    if (now - lastQuotaWarningAt < 3500) return;
    lastQuotaWarningAt = now;
    if (isUserCloudQuotaExpired()) {
        antdMessage.warning(i18n.t("cloud.quotaExpiredWarning"));
        return;
    }
    antdMessage.warning(i18n.t("cloud.quotaExceededWarning"));
}

/** 标记云端工作区首次全量同步是否已完成水合。 */
export function setCloudSyncHydrated(value: boolean) {
    cloudSyncHydrated = value;
}

/** 获取云端工作区是否已完成首屏水合同步。 */
export function isCloudSyncHydrated() {
    return cloudSyncHydrated;
}

/** 根据 storageKey 前缀或 MIME 类型推导媒体分类（image / video / audio / file）。 */
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
            missingCloudMediaKeys.delete(storageKey);
            missingCloudThumbKeys.delete(storageKey);
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
        if (webdav.enabled && !webdav.isExpired && !webdav.isQuotaExceeded) {
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

function computeCacheExpiresAt(expiresInSeconds?: number) {
    const ttlSeconds = typeof expiresInSeconds === "number" && expiresInSeconds > 0 ? expiresInSeconds : DEFAULT_PRESIGN_EXPIRES_SECONDS;
    const effectiveSeconds = ttlSeconds > PRESIGN_CACHE_BUFFER_SECONDS ? ttlSeconds - PRESIGN_CACHE_BUFFER_SECONDS : ttlSeconds * 0.5;
    return Date.now() + Math.max(1, effectiveSeconds) * 1000;
}

function readCachedUrl(cache: Map<string, { url: string; expiresAt: number }>, key?: string) {
    if (!key) return undefined;
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
        cache.delete(key);
        return undefined;
    }
    return entry.url;
}

/** 获取当前会话内存缓存中的云端缩略图预签名地址。 */
export function getCachedCloudThumbnailUrl(storageKey?: string) {
    return readCachedUrl(thumbnailUrlCache, storageKey);
}

/** 判断当前会话是否已确认云端桶中不存在该媒体文件（避免重复轮询/重试）。 */
export function isCloudMediaMissing(storageKey?: string) {
    return Boolean(storageKey && missingCloudMediaKeys.has(storageKey));
}

function isNotFoundCloudError(error: unknown) {
    if (!error || typeof error !== "object") return false;
    const status = (error as { status?: unknown }).status;
    if (status === 404 || status === 410) return true;
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("NoSuchKey") || message.includes("The specified key does not exist") || message.includes("未找到该文件");
}

/** 清理云端预签名 URL 内存缓存（退出登录或切换账号时调用）。 */
export function clearCloudMediaUrlCache() {
    urlCache.clear();
    thumbnailUrlCache.clear();
    missingCloudMediaKeys.clear();
    missingCloudThumbKeys.clear();
}

/** 清理指定媒体 key 的云端 URL 与缺失状态缓存。 */
export function evictCloudMediaUrlCache(keys: Iterable<string>) {
    for (const key of keys) {
        if (!key) continue;
        urlCache.delete(key);
        thumbnailUrlCache.delete(key);
        missingCloudMediaKeys.delete(key);
        missingCloudThumbKeys.delete(key);
    }
}

/** 批量预取云端媒体原图与缩略图签名地址并写入会话缓存，避免冷启动逐条请求。 */
export async function prefetchCloudMediaUrls(keys: Iterable<string>): Promise<void> {
    if (!isCloudAuthenticated()) return;
    const missing = Array.from(new Set(keys)).filter(
        (key) => key.includes(":") && !missingCloudMediaKeys.has(key) && !readCachedUrl(urlCache, key),
    );
    if (!missing.length) return;

    const chunks: string[][] = [];
    for (let i = 0; i < missing.length; i += URLS_BATCH_LIMIT) {
        chunks.push(missing.slice(i, i + URLS_BATCH_LIMIT));
    }

    await Promise.all(
        chunks.map(async (chunk) => {
            try {
                const res = await storageApi.getUrls(chunk);
                const expiresAt = computeCacheExpiresAt(res.expiresIn);
                const returnedUrls = res.urls || {};
                for (const id of chunk) {
                    const url = returnedUrls[id];
                    if (url) {
                        urlCache.set(id, { url, expiresAt });
                    } else {
                        missingCloudMediaKeys.add(id);
                    }
                }
                for (const [id, thumbUrl] of Object.entries(res.thumbnailUrls || {})) {
                    if (thumbUrl) thumbnailUrlCache.set(id, { url: thumbUrl, expiresAt });
                }
            } catch {
                // 单批预取失败时静默跳过，后续单图仍可回退单条接口
            }
        }),
    );
}

/** 获取指定云端媒体的可访问签名地址（优先命中会话缓存与缺失缓存，并发请求自动去重）。 */
export async function resolveCloudMediaUrl(storageKey: string, fallback = ""): Promise<string> {
    if (!isCloudAuthenticated() || !storageKey || missingCloudMediaKeys.has(storageKey)) return fallback;
    const cached = readCachedUrl(urlCache, storageKey);
    if (cached) return cached;
    const pending = inFlightUrls.get(storageKey);
    if (pending) return pending;

    const promise = storageApi
        .getUrl(storageKey)
        .then((res) => {
            if (res.url) {
                urlCache.set(storageKey, { url: res.url, expiresAt: computeCacheExpiresAt(res.expiresIn) });
            }
            return res.url || fallback;
        })
        .catch((error) => {
            if (isNotFoundCloudError(error)) {
                missingCloudMediaKeys.add(storageKey);
            }
            return fallback;
        })
        .finally(() => {
            inFlightUrls.delete(storageKey);
        });
    inFlightUrls.set(storageKey, promise);
    return promise;
}

/** 从云端下载媒体原文件 Blob 并回填本地 IndexedDB 缓存（S3 跨域失败时自动降级走服务端同源代理）。 */
export async function fetchCloudMediaBlob(storageKey: string, cacheLocal: (blob: Blob) => Promise<void>): Promise<Blob | null> {
    if (!isCloudAuthenticated() || !storageKey || missingCloudMediaKeys.has(storageKey)) return null;
    const pending = inFlightBlobs.get(storageKey);
    if (pending) return pending;

    const promise = (async () => {
        try {
            let blob: Blob | null = null;
            let confirmedMissing = false;
            const url = await resolveCloudMediaUrl(storageKey);
            if (url) {
                try {
                    const res = await fetch(url);
                    if (res.ok) blob = await res.blob();
                    else if (res.status === 404 || res.status === 410) confirmedMissing = true;
                } catch {
                    // 对象存储未开启 GET CORS 时降级走服务端同源下载接口
                }
            }
            if (confirmedMissing) {
                missingCloudMediaKeys.add(storageKey);
                return null;
            }
            if (!blob) {
                try {
                    blob = await storageApi.downloadBlob(storageKey);
                } catch (error) {
                    if (isNotFoundCloudError(error)) {
                        missingCloudMediaKeys.add(storageKey);
                        return null;
                    }
                    throw error;
                }
            }
            if (!blob || !blob.size) return null;
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

/** 拉取云端媒体缩略图 Blob（命中 404 时记入缺失缓存，避免页面滚动反复重试）。 */
export async function fetchCloudThumbnailBlob(storageKey: string): Promise<Blob | null> {
    if (!isCloudAuthenticated() || !storageKey || missingCloudMediaKeys.has(storageKey) || missingCloudThumbKeys.has(storageKey)) {
        return null;
    }
    try {
        let thumbnailUrl = readCachedUrl(thumbnailUrlCache, storageKey);
        if (!thumbnailUrl) {
            const res = await storageApi.getThumbnailUrl(storageKey);
            thumbnailUrl = res.thumbnailUrl;
            if (thumbnailUrl) {
                thumbnailUrlCache.set(storageKey, { url: thumbnailUrl, expiresAt: computeCacheExpiresAt() });
            }
        }
        if (!thumbnailUrl) {
            missingCloudThumbKeys.add(storageKey);
            return null;
        }
        const res = await fetch(thumbnailUrl);
        if (!res.ok) {
            if (res.status === 404 || res.status === 410) missingCloudThumbKeys.add(storageKey);
            return null;
        }
        return await res.blob();
    } catch {
        return null;
    }
}

export async function deleteCloudMedia(keys: Iterable<string>) {
    if (!isCloudAuthenticated() || !cloudSyncHydrated) return;
    await Promise.all(Array.from(new Set(keys)).map((key) => storageApi.remove(key).catch(() => undefined)));
}
