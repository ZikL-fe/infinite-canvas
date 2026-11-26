/** 生图/视频工作台生成历史云端同步与级联删除工具。 */
import localforage from "localforage";
import type LocalForage from "localforage";

import { authApi, workbenchApi } from "@/services/api/server";
import { isCloudAuthenticated, notifyCloudWorkspaceChanged } from "@/services/cloud-media";
import { ensureCloudMediaUploaded, stripBlobUrls } from "@/services/cloud-media-sync";
import {
    clearDirty,
    ensureSyncMetaHydrated,
    hasTombstone,
    isDirty,
    markDirty,
    markTombstone,
    unmarkTombstone,
    type SyncDomain,
} from "@/services/sync-tombstone";
import { useUserStore } from "@/stores/use-user-store";

export const imageWorkbenchLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });
export const videoWorkbenchLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });

const WORKBENCH_CURSOR_PREFIX = "infinite-canvas:workbench_sync_cursor:";
const syncInFlightByKind = new Map<"image" | "video", Promise<void>>();
const syncQueuedByKind = new Map<"image" | "video", Promise<void>>();

function domainOf(kind: "image" | "video"): SyncDomain {
    return kind === "video" ? "workbench_video" : "workbench_image";
}

/** 检查工作台记录是否已在当前会话或持久化墓碑中删除，避免在途同步或后台回填误写回。 */
export function isWorkbenchLogDeleted(id: string) {
    return hasTombstone("workbench_image", id) || hasTombstone("workbench_video", id);
}

/** 清理会话级已删工作台 ID 集合（退出登录或切换账号时由 clearAllSyncMeta 统一清理）。 */
export function clearDeletedWorkbenchLogIds() {
    // 持久化墓碑已由 clearAllSyncMeta 统一清理，保留空实现兼容调用方
}

/** 落盘前清理工作台日志中的临时预览 URL / dataUrl，与页面 serializeLog 保持一致口径。 */
export function sanitizeWorkbenchLogForStorage<T extends Record<string, unknown>>(log: T): T {
    const clean = stripBlobUrls(log) as Record<string, unknown>;
    if (Array.isArray(clean.images)) {
        clean.images = clean.images.map((item) =>
            item && typeof item === "object" ? { ...(item as Record<string, unknown>), dataUrl: "" } : item,
        );
    }
    if (Array.isArray(clean.references)) {
        clean.references = clean.references.map((item) =>
            item && typeof item === "object" ? { ...(item as Record<string, unknown>), dataUrl: "" } : item,
        );
    }
    if (clean.video && typeof clean.video === "object") {
        clean.video = { ...(clean.video as Record<string, unknown>), url: "" };
    }
    return clean as T;
}

function cursorStorageKey(kind: "image" | "video") {
    return `${WORKBENCH_CURSOR_PREFIX}${kind}`;
}

/** 清空生图/视频工作台增量同步游标（退出或切换账号时调用）。 */
export function clearWorkbenchSyncCursors() {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(cursorStorageKey("image"));
    localStorage.removeItem(cursorStorageKey("video"));
}

type BaseWorkbenchLog = {
    id: string;
    createdAt: number;
    updatedAt?: string;
    title: string;
    prompt: string;
    model: string;
    status: "pending" | "success" | "failed";
    durationMs: number;
};

function buildWorkbenchPayload<T extends BaseWorkbenchLog>(kind: "image" | "video", log: T) {
    const clean = stripBlobUrls(log);
    const { id: _id, title, prompt, model, status, durationMs, createdAt, updatedAt, ...rest } = clean;
    return {
        kind,
        title: title || "",
        prompt: prompt || "",
        model: model || "",
        status: status || "success",
        durationMs: Math.round(durationMs || 0),
        payload: rest,
        createdAt: new Date(createdAt || Date.now()).toISOString(),
        updatedAt: updatedAt || new Date().toISOString(),
    };
}

/** 将单条工作台生成记录推送到云端（仅在真正生成写入记录时才把暂存参考图上传到对象存储）。 */
export async function pushWorkbenchLogToCloud<T extends BaseWorkbenchLog>(kind: "image" | "video", log: T) {
    const domain = domainOf(kind);
    await ensureSyncMetaHydrated();
    if (!isCloudAuthenticated() || hasTombstone(domain, log.id)) return;
    markDirty(domain, log.id);
    await ensureCloudMediaUploaded(log).catch(() => false);
    if (!isCloudAuthenticated() || hasTombstone(domain, log.id)) return;
    const res = await workbenchApi.saveLog(log.id, buildWorkbenchPayload(kind, log)).catch((err) => {
        console.warn("[workbench-sync] 同步工作台记录失败:", err);
        return null;
    });
    if (res) {
        clearDirty(domain, log.id);
    }
    if (res?.deletedMediaCount && res.deletedMediaCount > 0) {
        void authApi
            .me()
            .then((meRes) => useUserStore.getState().setUser(meRes.user))
            .catch(() => undefined);
        notifyCloudWorkspaceChanged("media", { sync: false });
    }
}

async function runWorkbenchLogSync<T extends BaseWorkbenchLog>(
    kind: "image" | "video",
    localStore: LocalForage,
    serialize: (log: T) => T,
) {
    if (!isCloudAuthenticated()) return;
    await ensureSyncMetaHydrated();
    const domain = domainOf(kind);

    const localItems: T[] = [];
    await localStore.iterate((value) => {
        if (value && typeof value === "object") localItems.push(value as T);
    });

    const cursorKey = cursorStorageKey(kind);
    const since = localItems.length > 0 && typeof localStorage !== "undefined" ? localStorage.getItem(cursorKey) || undefined : undefined;
    const remote = await workbenchApi.listLogs(kind, false, since).catch(() => null);
    if (!remote) return;

    const deletedSet = new Set(remote.deletedIds.map((d) => d.id));
    const localMap = new Map(localItems.map((item) => [item.id, item]));
    const remoteMap = new Map(remote.logs.map((item) => [String(item.id), item as unknown as T]));
    const toPush: T[] = [];
    const candidateIds = new Set<string>([...remoteMap.keys()]);
    if (remote.incremental && since) {
        for (const id of deletedSet) {
            if (localMap.has(id)) candidateIds.add(id);
        }
        // 增量同步仅补推本地明确标脏且未删除的记录，彻底摆脱浏览器与服务端时钟偏差
        for (const id of localMap.keys()) {
            if (hasTombstone(domain, id) || isDirty(domain, id)) {
                candidateIds.add(id);
            }
        }
    } else {
        for (const id of localMap.keys()) {
            candidateIds.add(id);
        }
    }

    for (const id of candidateIds) {
        const local = localMap.get(id);
        if (hasTombstone(domain, id)) {
            if (local) await localStore.removeItem(id).catch(() => undefined);
            continue;
        }
        const remoteItem = remoteMap.get(id);
        if (deletedSet.has(id)) {
            if (local) await localStore.removeItem(id).catch(() => undefined);
            clearDirty(domain, id);
            continue;
        }

        if (local && !remoteItem) {
            if (hasTombstone(domain, id)) continue;
            const serialized = serialize(local);
            await localStore.setItem(id, serialized).catch(() => undefined);
            if (!hasTombstone(domain, id)) toPush.push(serialized);
        } else if (remoteItem) {
            const preferLocal =
                local &&
                isDirty(domain, id) &&
                ((local.status !== "pending" && remoteItem.status === "pending") ||
                    (local.updatedAt || "") > (remoteItem.updatedAt || ""));
            if (preferLocal && local) {
                if (hasTombstone(domain, id)) continue;
                const serialized = serialize(local);
                await localStore.setItem(id, serialized).catch(() => undefined);
                if (!hasTombstone(domain, id)) toPush.push(serialized);
            } else if (!local || local.updatedAt !== remoteItem.updatedAt || local.status !== remoteItem.status) {
                if (hasTombstone(domain, id)) continue;
                const serialized = serialize(remoteItem);
                await localStore.setItem(id, serialized).catch(() => undefined);
                clearDirty(domain, id);
            }
        }
    }

    for (const item of toPush) {
        if (!hasTombstone(domain, item.id)) {
            await pushWorkbenchLogToCloud(kind, item);
        }
    }

    if (remote.syncedAt && typeof localStorage !== "undefined") {
        localStorage.setItem(cursorKey, remote.syncedAt);
    }
}

/** 双向同步本地与云端工作台历史：首次全量、后续按 updatedSince 增量拉取并应用墓碑删除与本地补推（按类型串行防并发写回）。 */
export function syncWorkbenchLogsWithCloud<T extends BaseWorkbenchLog>(
    kind: "image" | "video",
    localStore: LocalForage,
    serialize: (log: T) => T,
): Promise<void> {
    if (!isCloudAuthenticated()) return Promise.resolve();
    const queued = syncQueuedByKind.get(kind);
    if (queued) return queued;

    const inFlight = syncInFlightByKind.get(kind);
    if (inFlight) {
        let queuedPromise!: Promise<void>;
        queuedPromise = inFlight
            .catch(() => undefined)
            .then(async () => {
                if (syncQueuedByKind.get(kind) === queuedPromise) {
                    syncQueuedByKind.delete(kind);
                }
                syncInFlightByKind.set(kind, queuedPromise);
                try {
                    await runWorkbenchLogSync(kind, localStore, serialize);
                } finally {
                    if (syncInFlightByKind.get(kind) === queuedPromise) {
                        syncInFlightByKind.delete(kind);
                    }
                }
            });
        syncQueuedByKind.set(kind, queuedPromise);
        return queuedPromise;
    }

    let current!: Promise<void>;
    current = (async () => {
        try {
            await runWorkbenchLogSync(kind, localStore, serialize);
        } finally {
            if (syncInFlightByKind.get(kind) === current) {
                syncInFlightByKind.delete(kind);
            }
        }
    })();
    syncInFlightByKind.set(kind, current);
    return current;
}

/** 已登录时先确认云端批量删除工作台记录成功，再清理本地记录与孤立媒体并刷新配额。 */
export async function deleteWorkbenchLogsWithCloud(
    localStore: LocalForage,
    ids: string[],
    cleanupLocalMedia: () => void,
    kind?: "image" | "video",
) {
    if (!ids.length) return;
    const domains: SyncDomain[] = kind ? [domainOf(kind)] : ["workbench_image", "workbench_video"];
    domains.forEach((d) => markTombstone(d, ids));
    const authenticated = isCloudAuthenticated();
    if (authenticated) {
        try {
            await workbenchApi.deleteLogs(ids, kind);
        } catch (error) {
            domains.forEach((d) => unmarkTombstone(d, ids));
            throw error;
        }
    }
    await Promise.all(ids.map((id) => localStore.removeItem(id).catch(() => undefined)));
    cleanupLocalMedia();
    if (authenticated) {
        notifyCloudWorkspaceChanged(kind || "media", { sync: false });
        void authApi
            .me()
            .then((res) => useUserStore.getState().setUser(res.user))
            .catch(() => undefined);
    }
}
