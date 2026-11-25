/** 生图/视频工作台生成历史云端同步与级联删除工具。 */
import type LocalForage from "localforage";

import { authApi, workbenchApi } from "@/services/api/server";
import { isCloudAuthenticated, notifyCloudWorkspaceChanged } from "@/services/cloud-media";
import { ensureCloudMediaUploaded, stripBlobUrls } from "@/services/cloud-media-sync";
import { useUserStore } from "@/stores/use-user-store";

const deletedWorkbenchLogIds = new Set<string>();
const WORKBENCH_CURSOR_PREFIX = "infinite-canvas:workbench_sync_cursor:";

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
    if (!isCloudAuthenticated() || deletedWorkbenchLogIds.has(log.id)) return;
    await ensureCloudMediaUploaded(log).catch(() => false);
    const res = await workbenchApi.saveLog(log.id, buildWorkbenchPayload(kind, log)).catch((err) => {
        console.warn("[workbench-sync] 同步工作台记录失败:", err);
        return null;
    });
    if (res?.deletedMediaCount && res.deletedMediaCount > 0) {
        void authApi
            .me()
            .then((meRes) => useUserStore.getState().setUser(meRes.user))
            .catch(() => undefined);
        notifyCloudWorkspaceChanged("media", { sync: false });
    }
}

function logIsoTimestamp(log?: BaseWorkbenchLog) {
    if (!log) return "";
    return log.updatedAt || (log.createdAt ? new Date(log.createdAt).toISOString() : "");
}

/** 双向同步本地与云端工作台历史：首次全量、后续按 updatedSince 增量拉取并应用墓碑删除与本地补推。 */
export async function syncWorkbenchLogsWithCloud<T extends BaseWorkbenchLog>(
    kind: "image" | "video",
    localStore: LocalForage,
    serialize: (log: T) => T,
) {
    if (!isCloudAuthenticated()) return;

    const localItems: T[] = [];
    await localStore.iterate((value) => {
        if (value && typeof value === "object") localItems.push(value as T);
    });

    const cursorKey = cursorStorageKey(kind);
    const since = localItems.length > 0 && typeof localStorage !== "undefined" ? localStorage.getItem(cursorKey) || undefined : undefined;
    const remote = await workbenchApi.listLogs(kind, false, since).catch(() => null);
    if (!remote) return;

    const deletedMap = new Map(remote.deletedIds.map((d) => [d.id, d.deletedAt]));
    const localMap = new Map(localItems.map((item) => [item.id, item]));
    const remoteMap = new Map(remote.logs.map((item) => [String(item.id), item as unknown as T]));
    const toPush: T[] = [];
    const candidateIds = new Set<string>([...remoteMap.keys()]);
    if (remote.incremental && since) {
        for (const id of deletedMap.keys()) {
            if (localMap.has(id)) candidateIds.add(id);
        }
        for (const [id, local] of localMap) {
            if (logIsoTimestamp(local) >= since) candidateIds.add(id);
        }
    } else {
        for (const id of localMap.keys()) {
            candidateIds.add(id);
        }
    }

    for (const id of candidateIds) {
        const local = localMap.get(id);
        const remoteItem = remoteMap.get(id);
        const deletedAt = deletedMap.get(id);
        const latestIso = [logIsoTimestamp(local), logIsoTimestamp(remoteItem)].sort().pop() || "";

        if (deletedAt && deletedAt >= latestIso) {
            if (local) await localStore.removeItem(id).catch(() => undefined);
            continue;
        }

        if (local && !remoteItem) {
            const serialized = serialize(local);
            await localStore.setItem(id, serialized).catch(() => undefined);
            toPush.push(serialized);
        } else if (remoteItem) {
            const preferLocal =
                local &&
                ((local.status !== "pending" && remoteItem.status === "pending") ||
                    ((local.updatedAt || "") > (remoteItem.updatedAt || "")));
            if (preferLocal && local) {
                const serialized = serialize(local);
                await localStore.setItem(id, serialized).catch(() => undefined);
                toPush.push(serialized);
            } else if (!local || local.updatedAt !== remoteItem.updatedAt || local.status !== remoteItem.status) {
                const serialized = serialize(remoteItem);
                await localStore.setItem(id, serialized).catch(() => undefined);
            }
        }
    }

    for (const item of toPush) {
        await pushWorkbenchLogToCloud(kind, item);
    }

    if (remote.syncedAt && typeof localStorage !== "undefined") {
        localStorage.setItem(cursorKey, remote.syncedAt);
    }
}

/** 已登录时先确认云端批量删除工作台记录成功，再清理本地记录与孤立媒体并刷新配额。 */
export async function deleteWorkbenchLogsWithCloud(
    localStore: LocalForage,
    ids: string[],
    cleanupLocalMedia: () => void,
    kind?: "image" | "video",
) {
    if (!ids.length) return;
    ids.forEach((id) => deletedWorkbenchLogIds.add(id));
    if (isCloudAuthenticated()) {
        try {
            await workbenchApi.deleteLogs(ids, kind);
        } catch (error) {
            ids.forEach((id) => deletedWorkbenchLogIds.delete(id));
            throw error;
        }
        notifyCloudWorkspaceChanged(kind || "media", { sync: false });
        void authApi
            .me()
            .then((res) => useUserStore.getState().setUser(res.user))
            .catch(() => undefined);
    }
    await Promise.all(ids.map((id) => localStore.removeItem(id).catch(() => undefined)));
    cleanupLocalMedia();
}
