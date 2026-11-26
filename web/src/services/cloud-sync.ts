/** 工作区云端同步与平台运行时配置拉取：管理画布/资产/工作台合并、定时去抖推送及模型渠道自愈同步。 */
import { useSyncExternalStore } from "react";
import localforage from "localforage";

import { assetsApi, authApi, canvasApi, runtimeApi } from "@/services/api/server";
import {
    initWorkspaceBroadcastChannel,
    isCloudAuthenticated,
    notifyCloudWorkspaceChanged,
    setCloudSyncHydrated,
    WORKSPACE_CHANGED_EVENT,
} from "@/services/cloud-media";
import { ensureCloudMediaUploaded, stripBlobUrls } from "@/services/cloud-media-sync";
import { resolveMediaUrl, clearLocalMediaFileCache, prefetchUncachedMediaUrls } from "@/services/file-storage";
import { resolveImageUrl, clearLocalImageAndWorkbenchCaches, prefetchUncachedImageUrls } from "@/services/image-storage";
import { clearWorkbenchSyncCursors, syncWorkbenchLogsWithCloud } from "@/services/workbench-sync";
import { useCanvasStore, type CanvasDeletedProject, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

const LAST_SYNC_USER_KEY = "infinite-canvas:cloud_sync_uid";
const CANVAS_SYNC_CURSOR_KEY = "infinite-canvas:canvas_sync_cursor";
const PROJECT_SYNC_DEBOUNCE_MS = 800;

function clearAllSyncCursors() {
    localStorage.removeItem(CANVAS_SYNC_CURSOR_KEY);
    clearWorkbenchSyncCursors();
}

let listenersInitialized = false;
let applyingRemote = false;
let syncInFlight: Promise<void> | null = null;
let syncQueued = false;
let cloudWorkspaceSyncing = false;
const cloudSyncListeners = new Set<() => void>();
let runtimeSyncInFlight: Promise<boolean> | null = null;

function setCloudWorkspaceSyncing(next: boolean) {
    if (cloudWorkspaceSyncing === next) return;
    cloudWorkspaceSyncing = next;
    cloudSyncListeners.forEach((listener) => listener());
}

/** 订阅云端工作区是否正在同步中（用于在无本地缓存时展示加载态）。 */
export function useCloudSyncing() {
    return useSyncExternalStore(
        (listener) => {
            cloudSyncListeners.add(listener);
            return () => {
                cloudSyncListeners.delete(listener);
            };
        },
        () => cloudWorkspaceSyncing,
    );
}
const projectSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingProjectsToSync = new Map<string, CanvasProject>();
const deletedProjectIds = new Set<string>();
const cloudDeletedProjectIds = new Set<string>();
const cloudDeletedAssetIds = new Set<string>();

function waitForHydration(store: { getState: () => { hydrated: boolean }; subscribe: (listener: (state: { hydrated: boolean }) => void) => () => void }) {
    if (store.getState().hydrated) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const unsub = store.subscribe((state) => {
            if (!state.hydrated) return;
            unsub();
            resolve();
        });
    });
}

async function hydrateAsset(asset: Asset): Promise<Asset> {
    if (asset.kind === "image" && asset.data.storageKey) {
        const dataUrl = await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl || "");
        return {
            ...asset,
            coverUrl: !asset.coverUrl || asset.coverUrl.startsWith("blob:") ? dataUrl : asset.coverUrl,
            data: { ...asset.data, dataUrl },
        };
    }
    if (asset.kind === "video" && asset.data.storageKey) {
        const url = await resolveMediaUrl(asset.data.storageKey, asset.data.url || "");
        return {
            ...asset,
            coverUrl: !asset.coverUrl || asset.coverUrl.startsWith("blob:") ? url : asset.coverUrl,
            data: { ...asset.data, url },
        };
    }
    return asset;
}

async function pushProjectToCloud(project: CanvasProject, options?: { keepalive?: boolean }) {
    if (!isCloudAuthenticated() || deletedProjectIds.has(project.id)) return;
    if (!options?.keepalive) {
        const ok = await ensureCloudMediaUploaded(project);
        if (!ok || deletedProjectIds.has(project.id)) return;
    }
    if (!useCanvasStore.getState().projects.some((item) => item.id === project.id)) return;
    const res = await canvasApi.saveProject(project.id, stripBlobUrls(project) as unknown as Record<string, unknown>, options);
    if (res?.deletedMediaCount && res.deletedMediaCount > 0) {
        void authApi
            .me()
            .then((meRes) => useUserStore.getState().setUser(meRes.user))
            .catch(() => undefined);
        useAssetStore.getState().cleanupImages();
        notifyCloudWorkspaceChanged("media", { sync: false });
    }
}

async function pushAssetToCloud(asset: Asset) {
    if (!isCloudAuthenticated()) return;
    const ok = await ensureCloudMediaUploaded(asset);
    if (!ok) return;
    const res = await assetsApi.save(asset.id, stripBlobUrls(asset) as unknown as Record<string, unknown>);
    if (res?.deletedMediaCount && res.deletedMediaCount > 0) {
        void authApi
            .me()
            .then((meRes) => useUserStore.getState().setUser(meRes.user))
            .catch(() => undefined);
        useAssetStore.getState().cleanupImages();
        notifyCloudWorkspaceChanged("media", { sync: false });
    }
}

function mergeProjects(
    localProjects: CanvasProject[],
    localDeleted: CanvasDeletedProject[],
    remoteProjects: CanvasProject[],
    remoteDeleted: CanvasDeletedProject[],
) {
    const deletedMap = new Map<string, string>();
    for (const item of [...localDeleted, ...remoteDeleted]) {
        const prev = deletedMap.get(item.id);
        if (!prev || item.deletedAt > prev) deletedMap.set(item.id, item.deletedAt);
    }

    const localMap = new Map(localProjects.map((p) => [p.id, p]));
    const remoteMap = new Map(remoteProjects.map((p) => [p.id, p]));
    const allIds = new Set([...localMap.keys(), ...remoteMap.keys()]);

    const merged: CanvasProject[] = [];
    const toPush: CanvasProject[] = [];

    for (const id of allIds) {
        const local = localMap.get(id);
        const remote = remoteMap.get(id);
        const deletedAt = deletedMap.get(id);
        const latestUpdatedAt = [local?.updatedAt || "", remote?.updatedAt || ""].sort().pop() || "";

        if (deletedAt && deletedAt >= latestUpdatedAt) {
            continue;
        }

        if (local && (!remote || local.updatedAt > remote.updatedAt)) {
            merged.push(local);
            toPush.push(local);
        } else if (remote) {
            merged.push(remote);
        }
    }

    merged.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const remoteDeletedSet = new Set(remoteDeleted.map((d) => d.id));
    const deletedToPush = localDeleted.filter((d) => !remoteDeletedSet.has(d.id)).map((d) => d.id);
    const mergedDeleted = [...deletedMap.entries()].map(([id, deletedAt]) => ({ id, deletedAt }));

    return { merged, mergedDeleted, toPush, deletedToPush, changed: true };
}

function mergeProjectsIncremental(
    localProjects: CanvasProject[],
    localDeleted: CanvasDeletedProject[],
    remoteProjects: CanvasProject[],
    remoteDeleted: CanvasDeletedProject[],
    since: string,
) {
    const deletedMap = new Map<string, string>();
    for (const item of [...localDeleted, ...remoteDeleted]) {
        const prev = deletedMap.get(item.id);
        if (!prev || item.deletedAt > prev) deletedMap.set(item.id, item.deletedAt);
    }

    const localMap = new Map(localProjects.map((p) => [p.id, p]));
    const remoteMap = new Map(remoteProjects.map((p) => [p.id, p]));
    const mergedMap = new Map(localMap);
    const toPush: CanvasProject[] = [];
    let changed = false;

    for (const item of remoteDeleted) {
        const local = mergedMap.get(item.id);
        if (local && item.deletedAt >= local.updatedAt) {
            mergedMap.delete(item.id);
            changed = true;
        }
    }

    for (const [id, remote] of remoteMap) {
        const local = mergedMap.get(id);
        const deletedAt = deletedMap.get(id);
        const latestUpdatedAt = [local?.updatedAt || "", remote.updatedAt].sort().pop() || "";
        if (deletedAt && deletedAt >= latestUpdatedAt) {
            if (local) {
                mergedMap.delete(id);
                changed = true;
            }
            continue;
        }
        if (local && local.updatedAt > remote.updatedAt) {
            toPush.push(local);
        } else if (!local || remote.updatedAt > local.updatedAt) {
            mergedMap.set(id, remote);
            changed = true;
        }
    }

    for (const [id, local] of localMap) {
        if (remoteMap.has(id)) continue;
        const deletedAt = deletedMap.get(id);
        if (deletedAt && deletedAt >= local.updatedAt) {
            mergedMap.delete(id);
            changed = true;
            continue;
        }
        if (local.updatedAt >= since) {
            toPush.push(local);
        }
    }

    const merged = Array.from(mergedMap.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const remoteDeletedSet = new Set(remoteDeleted.map((d) => d.id));
    const deletedToPush = localDeleted.filter((d) => d.deletedAt >= since && !remoteDeletedSet.has(d.id)).map((d) => d.id);
    const mergedDeleted = [...deletedMap.entries()].map(([id, deletedAt]) => ({ id, deletedAt }));
    if (mergedDeleted.length !== localDeleted.length) changed = true;

    return { merged, mergedDeleted, toPush, deletedToPush, changed };
}

function mergeAssets(
    localAssets: Asset[],
    remoteAssets: Asset[],
    remoteDeleted: { id: string; deletedAt: string }[],
) {
    const deletedMap = new Map(remoteDeleted.map((item) => [item.id, item.deletedAt]));
    const localMap = new Map(localAssets.map((a) => [a.id, a]));
    const remoteMap = new Map(remoteAssets.map((a) => [a.id, a]));
    const allIds = new Set([...localMap.keys(), ...remoteMap.keys()]);

    const merged: Asset[] = [];
    const toPush: Asset[] = [];

    for (const id of allIds) {
        const local = localMap.get(id);
        const remote = remoteMap.get(id);
        const deletedAt = deletedMap.get(id);
        const latestUpdatedAt = [local?.updatedAt || "", remote?.updatedAt || ""].sort().pop() || "";

        if (deletedAt && deletedAt >= latestUpdatedAt) continue;

        if (local && (!remote || local.updatedAt > remote.updatedAt)) {
            merged.push(local);
            toPush.push(local);
        } else if (remote) {
            merged.push(remote);
        }
    }

    merged.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { merged, toPush };
}

/** 从服务端拉取脱敏渠道与 WebDAV 分配状态；支持并发去重及网络瞬断重试。 */
export async function syncRuntimeSettings(): Promise<boolean> {
    if (!isCloudAuthenticated()) {
        useConfigStore.getState().clearRuntimeConfig();
        return false;
    }
    if (runtimeSyncInFlight) return runtimeSyncInFlight;

    runtimeSyncInFlight = (async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const runtime = await runtimeApi.getConfig();
                useConfigStore.getState().applyRuntimeConfig(
                    runtime.channels.map((ch) => ({ ...ch, apiKey: "" })),
                    runtime.webdav,
                );
                return true;
            } catch (error) {
                if (attempt === 0) {
                    await new Promise((resolve) => setTimeout(resolve, 600));
                    continue;
                }
                console.warn("[cloud-sync] 拉取平台配置失败:", error);
            }
        }
        return false;
    })().finally(() => {
        runtimeSyncInFlight = null;
    });

    return runtimeSyncInFlight;
}

/** 在发起生成或重试前校验渠道配置；若本地 channels 为空（如热更新或瞬断），自动补拉平台配置后再校验。 */
export async function ensureRuntimeConfigForGeneration(
    generationConfig: AiConfig,
    model: string,
    checkReady: (config: AiConfig, model: string) => boolean,
): Promise<AiConfig | null> {
    if (checkReady(generationConfig, model)) return generationConfig;
    if (!isCloudAuthenticated() || generationConfig.channels.length > 0) return null;

    const synced = await syncRuntimeSettings();
    if (!synced) return null;

    const storeCfg = useConfigStore.getState().config;
    const merged: AiConfig = {
        ...generationConfig,
        channels: storeCfg.channels,
        models: storeCfg.models,
        baseUrl: storeCfg.baseUrl,
        apiKey: storeCfg.apiKey,
        apiFormat: storeCfg.apiFormat,
        channelMode: "local" as const,
    };
    const resolvedModel = model || merged.imageModel || merged.model;
    return checkReady(merged, resolvedModel) ? { ...merged, model: resolvedModel } : null;
}

export async function syncCloudWorkspace() {
    if (!isCloudAuthenticated()) return;
    if (syncInFlight) {
        syncQueued = true;
        return syncInFlight;
    }

    setCloudWorkspaceSyncing(true);
    syncInFlight = (async () => {
        try {
            await Promise.all([
                waitForHydration(useCanvasStore),
                waitForHydration(useAssetStore),
                syncRuntimeSettings(),
                authApi
                    .me()
                    .then((res) => useUserStore.getState().setUser(res.user))
                    .catch(() => undefined),
            ]);
            const currentUser = useUserStore.getState().user;
            if (!currentUser || !isCloudAuthenticated()) return;

            // 同浏览器切换不同账号时先清理上一位用户的本地缓存与媒体/工作台日志，避免数据串号
            const lastUid = localStorage.getItem(LAST_SYNC_USER_KEY);
            if (lastUid && lastUid !== currentUser.id) {
                clearAllSyncCursors();
                applyingRemote = true;
                try {
                    useCanvasStore.getState().replaceProjects([], []);
                    useAssetStore.getState().replaceAssets([]);
                } finally {
                    applyingRemote = false;
                }
                await Promise.all([clearLocalImageAndWorkbenchCaches(), clearLocalMediaFileCache()]);
                window.dispatchEvent(new CustomEvent("infinite-canvas:user-session-changed"));
            }
            localStorage.setItem(LAST_SYNC_USER_KEY, currentUser.id);

            const preLocalCanvas = useCanvasStore.getState();
            const hasLocalCanvas = preLocalCanvas.projects.length > 0 || preLocalCanvas.deletedProjects.length > 0;
            const canvasSince = hasLocalCanvas ? localStorage.getItem(CANVAS_SYNC_CURSOR_KEY) || undefined : undefined;

            const [remoteCanvas, remoteAssetRes] = await Promise.all([
                canvasApi.listProjects(false, canvasSince),
                assetsApi.list(),
                syncWorkbenchLogsWithCloud("image", localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" }), (log) => log),
                syncWorkbenchLogsWithCloud("video", localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" }), (log) => log),
            ]);
            const remoteProjects = remoteCanvas.projects as unknown as CanvasProject[];
            const remoteAssets = remoteAssetRes.assets as unknown as Asset[];

            const localCanvas = useCanvasStore.getState();
            const localAssets = useAssetStore.getState().assets;

            const canvasPlan =
                remoteCanvas.incremental && canvasSince
                    ? mergeProjectsIncremental(localCanvas.projects, localCanvas.deletedProjects, remoteProjects, remoteCanvas.deletedProjects, canvasSince)
                    : mergeProjects(localCanvas.projects, localCanvas.deletedProjects, remoteProjects, remoteCanvas.deletedProjects);
            const assetPlan = mergeAssets(localAssets, remoteAssets, remoteAssetRes.deletedIds);
            const assetKeys = assetPlan.merged.flatMap((asset) => (asset.kind === "image" || asset.kind === "video") && asset.data.storageKey ? [asset.data.storageKey] : []);
            await Promise.all([prefetchUncachedImageUrls(assetKeys), prefetchUncachedMediaUrls(assetKeys)]);
            const hydratedAssets = await Promise.all(assetPlan.merged.map(hydrateAsset));

            applyingRemote = true;
            try {
                if (canvasPlan.changed) {
                    useCanvasStore.getState().replaceProjects(canvasPlan.merged, canvasPlan.mergedDeleted);
                }
                useAssetStore.getState().replaceAssets(hydratedAssets);
            } finally {
                applyingRemote = false;
            }
            if (remoteCanvas.syncedAt) {
                localStorage.setItem(CANVAS_SYNC_CURSOR_KEY, remoteCanvas.syncedAt);
            }
            window.dispatchEvent(new CustomEvent("infinite-canvas:cloud-workspace-synced"));

            setCloudSyncHydrated(true);

            if (canvasPlan.deletedToPush.length) {
                await canvasApi
                    .deleteProjects(canvasPlan.deletedToPush)
                    .then(() =>
                        authApi
                            .me()
                            .then((res) => useUserStore.getState().setUser(res.user))
                            .catch(() => undefined),
                    )
                    .catch(() => undefined);
            }
            for (const project of canvasPlan.toPush) {
                await pushProjectToCloud(project).catch((err) => console.warn("[cloud-sync] 上传画布失败:", err));
            }
            for (const asset of assetPlan.toPush) {
                await pushAssetToCloud(asset).catch((err) => console.warn("[cloud-sync] 上传素材失败:", err));
            }
        } catch (error) {
            console.warn("[cloud-sync] 同步工作区失败:", error);
        } finally {
            syncInFlight = null;
            if (syncQueued) {
                syncQueued = false;
                void syncCloudWorkspace();
            } else {
                setCloudWorkspaceSyncing(false);
            }
        }
    })();

    return syncInFlight;
}

function scheduleProjectSync(project: CanvasProject) {
    pendingProjectsToSync.set(project.id, project);
    const existingTimer = projectSaveTimers.get(project.id);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
        projectSaveTimers.delete(project.id);
        pendingProjectsToSync.delete(project.id);
        void pushProjectToCloud(project).catch((err) => console.warn("[cloud-sync] 同步画布失败:", err));
    }, PROJECT_SYNC_DEBOUNCE_MS);
    projectSaveTimers.set(project.id, timer);
}

/** 立即冲刷待推送的画布变更（用于退出登录或页面卸载前避免 800ms 防抖丢失最新节点/删除清理）。 */
export async function flushPendingCanvasSyncs(options?: { keepalive?: boolean }) {
    for (const timer of projectSaveTimers.values()) {
        clearTimeout(timer);
    }
    projectSaveTimers.clear();
    if (!pendingProjectsToSync.size || !isCloudAuthenticated()) {
        pendingProjectsToSync.clear();
        return;
    }
    const items = Array.from(pendingProjectsToSync.values());
    pendingProjectsToSync.clear();
    await Promise.allSettled(items.map((project) => pushProjectToCloud(project, options)));
}

export function initCloudSyncListeners() {
    if (listenersInitialized) return;
    listenersInitialized = true;

    if (typeof window !== "undefined") {
        window.addEventListener("pagehide", () => {
            void flushPendingCanvasSyncs({ keepalive: true });
        });
    }

    initWorkspaceBroadcastChannel((scope, sync) => {
        window.dispatchEvent(new CustomEvent(WORKSPACE_CHANGED_EVENT, { detail: { scope, sync } }));
        if (sync && isCloudAuthenticated()) {
            void syncCloudWorkspace();
        }
    });

    useCanvasStore.subscribe((state, prevState) => {
        if (applyingRemote || !state.hydrated || !isCloudAuthenticated()) return;

        const prevMap = new Map(prevState.projects.map((p) => [p.id, p]));
        for (const project of state.projects) {
            deletedProjectIds.delete(project.id);
            const prev = prevMap.get(project.id);
            if (!prev) {
                scheduleProjectSync(project);
                continue;
            }
            if (prev === project) continue;
            // 仅视口平移/缩放变化时不触发云端整画布上传与查重请求，避免拖拽/缩放掉帧
            const onlyViewportChanged =
                prev.title === project.title &&
                prev.nodes === project.nodes &&
                prev.connections === project.connections &&
                prev.chatSessions === project.chatSessions &&
                prev.activeChatId === project.activeChatId &&
                prev.backgroundMode === project.backgroundMode &&
                prev.showImageInfo === project.showImageInfo;
            if (!onlyViewportChanged) {
                scheduleProjectSync(project);
            }
        }

        const prevDeletedSet = new Set(prevState.deletedProjects.map((d) => d.id));
        const newlyDeleted = state.deletedProjects.filter((d) => !prevDeletedSet.has(d.id)).map((d) => d.id);
        const pendingCloudDeleted: string[] = [];
        for (const id of newlyDeleted) {
            deletedProjectIds.add(id);
            const timer = projectSaveTimers.get(id);
            if (timer) {
                clearTimeout(timer);
                projectSaveTimers.delete(id);
            }
            if (cloudDeletedProjectIds.has(id)) {
                cloudDeletedProjectIds.delete(id);
            } else {
                pendingCloudDeleted.push(id);
            }
        }
        if (pendingCloudDeleted.length) {
            void canvasApi
                .deleteProjects(pendingCloudDeleted)
                .then(() => {
                    notifyCloudWorkspaceChanged("canvas", { sync: false });
                    return authApi
                        .me()
                        .then((res) => useUserStore.getState().setUser(res.user))
                        .catch(() => undefined);
                })
                .catch((err) => console.warn("[cloud-sync] 删除远端画布失败:", err));
        }
    });

    useAssetStore.subscribe((state, prevState) => {
        if (applyingRemote || !state.hydrated || !isCloudAuthenticated()) return;

        const prevMap = new Map(prevState.assets.map((a) => [a.id, a]));
        const nextIds = new Set(state.assets.map((a) => a.id));

        for (const asset of state.assets) {
            const prev = prevMap.get(asset.id);
            if (!prev || prev !== asset) {
                void pushAssetToCloud(asset).catch((err) => console.warn("[cloud-sync] 同步素材失败:", err));
            }
        }

        for (const prevAsset of prevState.assets) {
            if (!nextIds.has(prevAsset.id)) {
                if (cloudDeletedAssetIds.has(prevAsset.id)) {
                    cloudDeletedAssetIds.delete(prevAsset.id);
                    continue;
                }
                void assetsApi
                    .remove(prevAsset.id)
                    .then(() => {
                        notifyCloudWorkspaceChanged("assets", { sync: false });
                        return authApi
                            .me()
                            .then((res) => useUserStore.getState().setUser(res.user))
                            .catch(() => undefined);
                    })
                    .catch((err) => console.warn("[cloud-sync] 删除远端素材失败:", err));
            }
        }
    });

    useUserStore.subscribe((state, prevState) => {
        if (!state.accessToken) {
            setCloudSyncHydrated(false);
            useConfigStore.getState().clearRuntimeConfig();
            if (prevState.accessToken || prevState.user) {
                localStorage.removeItem(LAST_SYNC_USER_KEY);
                clearAllSyncCursors();
                applyingRemote = true;
                try {
                    useCanvasStore.getState().replaceProjects([], []);
                    useAssetStore.getState().replaceAssets([]);
                } finally {
                    applyingRemote = false;
                }
                void Promise.all([clearLocalImageAndWorkbenchCaches(), clearLocalMediaFileCache()]).finally(() => {
                    window.dispatchEvent(new CustomEvent("infinite-canvas:user-session-changed"));
                });
            }
            return;
        }
        if (state.user && state.user.id !== prevState.user?.id) {
            void syncCloudWorkspace();
        }
    });
}

/** 先确认云端删除画布项目成功，再清理本地画布与孤立媒体缓存（接口失败会抛出错误且保留本地数据）。 */
export async function deleteCanvasProjectsWithCloud(ids: string[]) {
    if (!ids.length) return;
    for (const id of ids) {
        deletedProjectIds.add(id);
        const timer = projectSaveTimers.get(id);
        if (timer) {
            clearTimeout(timer);
            projectSaveTimers.delete(id);
        }
    }
    if (isCloudAuthenticated()) {
        try {
            await canvasApi.deleteProjects(ids);
        } catch (error) {
            ids.forEach((id) => deletedProjectIds.delete(id));
            throw error;
        }
        ids.forEach((id) => cloudDeletedProjectIds.add(id));
        notifyCloudWorkspaceChanged("canvas", { sync: false });
        void authApi
            .me()
            .then((res) => useUserStore.getState().setUser(res.user))
            .catch(() => undefined);
    }
    useCanvasStore.getState().deleteProjects(ids);
    useAssetStore.getState().cleanupImages();
}

/** 先确认云端删除资产成功，再移除本地资产与孤立媒体缓存（接口失败会抛出错误且保留本地数据）。 */
export async function deleteAssetsWithCloud(ids: string[]) {
    const uniqueIds = Array.from(new Set(ids)).filter(Boolean);
    if (!uniqueIds.length) return;
    if (isCloudAuthenticated()) {
        await assetsApi.batchRemove(uniqueIds);
        uniqueIds.forEach((id) => cloudDeletedAssetIds.add(id));
        notifyCloudWorkspaceChanged("assets", { sync: false });
        void authApi
            .me()
            .then((res) => useUserStore.getState().setUser(res.user))
            .catch(() => undefined);
    }
    useAssetStore.getState().removeAssets(uniqueIds);
}

/** 先确认云端删除单个资产成功，再移除本地资产与孤立媒体缓存。 */
export async function deleteAssetWithCloud(id: string) {
    if (!id) return;
    await deleteAssetsWithCloud([id]);
}
