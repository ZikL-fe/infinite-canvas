/** 工作区云端同步与平台运行时配置拉取：管理画布/资产/工作台合并、定时去抖推送及模型渠道自愈同步。 */
import { useSyncExternalStore } from "react";

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
import {
    clearAllSyncMeta,
    clearDirty,
    ensureSyncMetaHydrated,
    getTombstoneSet,
    hasTombstone,
    isDirty,
    markDirty,
    markTombstone,
    unmarkTombstone,
} from "@/services/sync-tombstone";
import {
    clearDeletedWorkbenchLogIds,
    clearWorkbenchSyncCursors,
    imageWorkbenchLogStore,
    sanitizeWorkbenchLogForStorage,
    syncWorkbenchLogsWithCloud,
    videoWorkbenchLogStore,
} from "@/services/workbench-sync";
import { useCanvasStore, type CanvasDeletedProject, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { resolveModelForCapability, useConfigStore, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
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
let profileRefreshInFlight: Promise<void> | null = null;

/** 在远端/WebDAV 数据应用到本地 Store 时屏蔽云端自动回推订阅，避免历史数据误推送复活。 */
export async function runWithApplyingRemote<T>(fn: () => T | Promise<T>): Promise<T> {
    const prev = applyingRemote;
    applyingRemote = true;
    try {
        return await fn();
    } finally {
        applyingRemote = prev;
    }
}

/** 去重刷新当前登录用户的资料与存储配额，避免批量删除/同步触发多次并发 `/auth/me`。 */
export function refreshUserProfileDeduped(): Promise<void> {
    if (!isCloudAuthenticated()) return Promise.resolve();
    if (profileRefreshInFlight) return profileRefreshInFlight;
    profileRefreshInFlight = authApi
        .me()
        .then((res) => {
            useUserStore.getState().setUser(res.user);
        })
        .catch(() => undefined)
        .finally(() => {
            profileRefreshInFlight = null;
        });
    return profileRefreshInFlight;
}

function resetCloudSyncSessionState() {
    for (const timer of projectSaveTimers.values()) {
        clearTimeout(timer);
    }
    projectSaveTimers.clear();
    pendingProjectsToSync.clear();
    pendingRemovedMediaKeys.clear();
    deletedProjectIds.clear();
    cloudDeletedProjectIds.clear();
    deletedAssetIds.clear();
    cloudDeletedAssetIds.clear();
    clearDeletedWorkbenchLogIds();
    clearAllSyncMeta();
}

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
const pendingRemovedMediaKeys = new Map<string, Set<string>>();
const deletedProjectIds = new Set<string>();

function collectStorageKeys(value: unknown, keys = new Set<string>()): Set<string> {
    if (!value || typeof value !== "object") return keys;
    if (Array.isArray(value)) {
        for (const item of value) collectStorageKeys(item, keys);
        return keys;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.storageKey === "string" && record.storageKey.includes(":")) {
        keys.add(record.storageKey);
    }
    for (const child of Object.values(record)) {
        if (child && typeof child === "object") collectStorageKeys(child, keys);
    }
    return keys;
}
const cloudDeletedProjectIds = new Set<string>();
const deletedAssetIds = new Set<string>();
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
    if (!isCloudAuthenticated() || deletedProjectIds.has(project.id) || hasTombstone("canvas", project.id)) return;
    if (!options?.keepalive) {
        const ok = await ensureCloudMediaUploaded(project);
        if (!ok || deletedProjectIds.has(project.id) || hasTombstone("canvas", project.id)) return;
    }
    if (!useCanvasStore.getState().projects.some((item) => item.id === project.id)) return;
    const currentKeys = collectStorageKeys([project.nodes, project.chatSessions]);
    const removedSet = pendingRemovedMediaKeys.get(project.id);
    const removedMediaKeys = removedSet ? Array.from(removedSet).filter((key) => !currentKeys.has(key)) : [];
    const payload = {
        ...(stripBlobUrls(project) as unknown as Record<string, unknown>),
        ...(removedMediaKeys.length ? { removedMediaKeys } : {}),
    };
    const res = await canvasApi.saveProject(project.id, payload, options);
    clearDirty("canvas", project.id);
    if (removedSet && removedMediaKeys.length) {
        for (const key of removedMediaKeys) removedSet.delete(key);
        if (!removedSet.size) pendingRemovedMediaKeys.delete(project.id);
    }
    if (res?.deletedMediaCount && res.deletedMediaCount > 0) {
        void refreshUserProfileDeduped();
        useAssetStore.getState().cleanupImages();
        notifyCloudWorkspaceChanged("media", { sync: false });
    }
}

async function pushAssetToCloud(asset: Asset) {
    if (!isCloudAuthenticated() || deletedAssetIds.has(asset.id) || hasTombstone("assets", asset.id)) return;
    const ok = await ensureCloudMediaUploaded(asset);
    if (!ok || deletedAssetIds.has(asset.id) || hasTombstone("assets", asset.id)) return;
    const res = await assetsApi.save(asset.id, stripBlobUrls(asset) as unknown as Record<string, unknown>);
    clearDirty("assets", asset.id);
    if (res?.deletedMediaCount && res.deletedMediaCount > 0) {
        void refreshUserProfileDeduped();
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

    // 服务端删除在增量同步中直接作为权威生效，避免因客户端时钟快于服务端导致已删画布复活
    for (const item of remoteDeleted) {
        if (mergedMap.has(item.id)) {
            mergedMap.delete(item.id);
            changed = true;
        }
        clearDirty("canvas", item.id);
    }

    for (const [id, remote] of remoteMap) {
        if (hasTombstone("canvas", id)) {
            if (mergedMap.delete(id)) changed = true;
            continue;
        }
        const local = mergedMap.get(id);
        if (local && isDirty("canvas", id) && local.updatedAt > remote.updatedAt) {
            toPush.push(local);
        } else if (!local || remote.updatedAt !== local.updatedAt) {
            mergedMap.set(id, remote);
            clearDirty("canvas", id);
            changed = true;
        }
    }

    // 增量同步仅补推本地明确标脏且未删除的项目，不再用浏览器本地时钟与服务端 since 游标比较
    for (const [id, local] of localMap) {
        if (remoteMap.has(id)) continue;
        if (hasTombstone("canvas", id) || deletedMap.has(id)) {
            if (mergedMap.delete(id)) changed = true;
            continue;
        }
        if (isDirty("canvas", id)) {
            toPush.push(local);
        }
    }

    const merged = Array.from(mergedMap.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const remoteDeletedSet = new Set(remoteDeleted.map((d) => d.id));
    const deletedToPush = Array.from(getTombstoneSet("canvas")).filter((id) => !remoteDeletedSet.has(id) && !cloudDeletedProjectIds.has(id));
    const mergedDeleted = [...deletedMap.entries()].map(([id, deletedAt]) => ({ id, deletedAt }));
    if (mergedDeleted.length !== localDeleted.length) changed = true;

    return { merged, mergedDeleted, toPush, deletedToPush, changed };
}

function mergeAssets(
    localAssets: Asset[],
    remoteAssets: Asset[],
    remoteDeleted: { id: string; deletedAt: string }[],
) {
    const remoteDeletedSet = new Set(remoteDeleted.map((item) => item.id));
    const localMap = new Map(localAssets.map((a) => [a.id, a]));
    const remoteMap = new Map(remoteAssets.map((a) => [a.id, a]));
    const allIds = new Set([...localMap.keys(), ...remoteMap.keys()]);

    const merged: Asset[] = [];
    const toPush: Asset[] = [];

    for (const id of allIds) {
        if (hasTombstone("assets", id) || deletedAssetIds.has(id)) continue;
        const local = localMap.get(id);
        const remote = remoteMap.get(id);

        if (remoteDeletedSet.has(id) && !isDirty("assets", id)) continue;

        if (local && (!remote || (isDirty("assets", id) && local.updatedAt > remote.updatedAt))) {
            merged.push(local);
            toPush.push(local);
        } else if (remote) {
            merged.push(remote);
            clearDirty("assets", id);
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
    checkReady: (config: AiConfig, model: string, capability?: ModelCapability) => boolean,
    capability?: ModelCapability,
): Promise<AiConfig | null> {
    if (checkReady(generationConfig, model, capability)) return generationConfig;
    if (!isCloudAuthenticated() || generationConfig.channels.length > 0) return null;

    const synced = await syncRuntimeSettings();
    if (!synced) return null;

    const storeCfg = useConfigStore.getState().config;
    const merged: AiConfig = {
        ...generationConfig,
        channels: storeCfg.channels,
        models: storeCfg.models,
        imageModel: storeCfg.imageModel,
        videoModel: storeCfg.videoModel,
        textModel: storeCfg.textModel,
        audioModel: storeCfg.audioModel,
        baseUrl: storeCfg.baseUrl,
        apiKey: storeCfg.apiKey,
        apiFormat: storeCfg.apiFormat,
        channelMode: "local" as const,
    };
    const resolvedModel = capability ? resolveModelForCapability(merged, model, capability) : model || merged.imageModel || merged.model;
    return checkReady(merged, resolvedModel, capability) ? { ...merged, model: resolvedModel } : null;
}

/** 双向同步当前登录账号的画布、资产与工作台记录（支持串行排队、切换账号清缓存与持久化墓碑防回流）。 */
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
                resetCloudSyncSessionState();
                clearAllSyncCursors();
                await runWithApplyingRemote(() => {
                    useCanvasStore.getState().replaceProjects([], []);
                    useAssetStore.getState().replaceAssets([]);
                });
                await Promise.all([clearLocalImageAndWorkbenchCaches(), clearLocalMediaFileCache()]);
                window.dispatchEvent(new CustomEvent("infinite-canvas:user-session-changed"));
            }
            localStorage.setItem(LAST_SYNC_USER_KEY, currentUser.id);

            await ensureSyncMetaHydrated();
            const preLocalCanvas = useCanvasStore.getState();
            const hasLocalCanvas = preLocalCanvas.projects.length > 0 || preLocalCanvas.deletedProjects.length > 0;
            const canvasSince = hasLocalCanvas ? localStorage.getItem(CANVAS_SYNC_CURSOR_KEY) || undefined : undefined;

            const [remoteCanvas, remoteAssetRes] = await Promise.all([
                canvasApi.listProjects(false, canvasSince),
                assetsApi.list(),
                syncWorkbenchLogsWithCloud("image", imageWorkbenchLogStore, sanitizeWorkbenchLogForStorage),
                syncWorkbenchLogsWithCloud("video", videoWorkbenchLogStore, sanitizeWorkbenchLogForStorage),
            ]);
            const remoteProjects = remoteCanvas.projects as unknown as CanvasProject[];
            const remoteAssets = remoteAssetRes.assets as unknown as Asset[];

            const localCanvas = useCanvasStore.getState();
            const localAssets = useAssetStore.getState().assets;

            const canvasPlan =
                remoteCanvas.incremental && canvasSince
                    ? mergeProjectsIncremental(localCanvas.projects, localCanvas.deletedProjects, remoteProjects, remoteCanvas.deletedProjects)
                    : mergeProjects(localCanvas.projects, localCanvas.deletedProjects, remoteProjects, remoteCanvas.deletedProjects);
            const assetPlan = mergeAssets(localAssets, remoteAssets, remoteAssetRes.deletedIds);
            const assetKeys = assetPlan.merged.flatMap((asset) => (asset.kind === "image" || asset.kind === "video") && asset.data.storageKey ? [asset.data.storageKey] : []);
            await Promise.all([prefetchUncachedImageUrls(assetKeys), prefetchUncachedMediaUrls(assetKeys)]);
            const hydratedAssets = await Promise.all(assetPlan.merged.map(hydrateAsset));

            const latestDeletedProjectSet = new Set([
                ...deletedProjectIds,
                ...useCanvasStore.getState().deletedProjects.map((item) => item.id),
            ]);
            const mergedProjects = canvasPlan.merged.filter((item) => !latestDeletedProjectSet.has(item.id));
            const mergedProjectIds = new Set(mergedProjects.map((item) => item.id));
            const mergedDeletedMap = new Map(canvasPlan.mergedDeleted.map((item) => [item.id, item]));
            for (const item of useCanvasStore.getState().deletedProjects) {
                if (!mergedProjectIds.has(item.id) && !mergedDeletedMap.has(item.id)) {
                    mergedDeletedMap.set(item.id, item);
                }
            }
            const safeHydratedAssets = hydratedAssets.filter((item) => !deletedAssetIds.has(item.id));
            const projectListChanged =
                canvasPlan.changed ||
                mergedProjects.length !== useCanvasStore.getState().projects.length ||
                mergedDeletedMap.size !== useCanvasStore.getState().deletedProjects.length;

            applyingRemote = true;
            try {
                if (projectListChanged) {
                    useCanvasStore.getState().replaceProjects(mergedProjects, Array.from(mergedDeletedMap.values()));
                }
                useAssetStore.getState().replaceAssets(safeHydratedAssets);
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
                if (!latestDeletedProjectSet.has(project.id)) {
                    await pushProjectToCloud(project).catch((err) => console.warn("[cloud-sync] 上传画布失败:", err));
                }
            }
            for (const asset of assetPlan.toPush) {
                if (!deletedAssetIds.has(asset.id)) {
                    await pushAssetToCloud(asset).catch((err) => console.warn("[cloud-sync] 上传素材失败:", err));
                }
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
    markDirty("canvas", project.id);
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

/** 初始化跨标签页广播、Store 变更订阅、用户登出清理与页面退出前同步冲刷监听。 */
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
                const prevKeys = collectStorageKeys([prev.nodes, prev.chatSessions]);
                const nextKeys = collectStorageKeys([project.nodes, project.chatSessions]);
                let removedSet = pendingRemovedMediaKeys.get(project.id);
                for (const key of prevKeys) {
                    if (!nextKeys.has(key)) {
                        if (!removedSet) {
                            removedSet = new Set<string>();
                            pendingRemovedMediaKeys.set(project.id, removedSet);
                        }
                        removedSet.add(key);
                    }
                }
                if (removedSet) {
                    for (const key of nextKeys) removedSet.delete(key);
                    if (!removedSet.size) pendingRemovedMediaKeys.delete(project.id);
                }
                scheduleProjectSync(project);
            }
        }

        const prevDeletedSet = new Set(prevState.deletedProjects.map((d) => d.id));
        const newlyDeleted = state.deletedProjects.filter((d) => !prevDeletedSet.has(d.id)).map((d) => d.id);
        const pendingCloudDeleted: string[] = [];
        for (const id of newlyDeleted) {
            deletedProjectIds.add(id);
            markTombstone("canvas", id);
            pendingProjectsToSync.delete(id);
            pendingRemovedMediaKeys.delete(id);
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
                    return refreshUserProfileDeduped();
                })
                .catch((err) => console.warn("[cloud-sync] 删除远端画布失败:", err));
        }
    });

    useAssetStore.subscribe((state, prevState) => {
        if (applyingRemote || !state.hydrated || !isCloudAuthenticated()) return;

        const prevMap = new Map(prevState.assets.map((a) => [a.id, a]));
        const nextIds = new Set(state.assets.map((a) => a.id));

        for (const asset of state.assets) {
            deletedAssetIds.delete(asset.id);
            const prev = prevMap.get(asset.id);
            if (!prev || prev !== asset) {
                markDirty("assets", asset.id);
                void pushAssetToCloud(asset).catch((err) => console.warn("[cloud-sync] 同步素材失败:", err));
            }
        }

        for (const prevAsset of prevState.assets) {
            if (!nextIds.has(prevAsset.id)) {
                deletedAssetIds.add(prevAsset.id);
                markTombstone("assets", prevAsset.id);
                if (cloudDeletedAssetIds.has(prevAsset.id)) {
                    cloudDeletedAssetIds.delete(prevAsset.id);
                    continue;
                }
                void assetsApi
                    .remove(prevAsset.id)
                    .then(() => {
                        notifyCloudWorkspaceChanged("assets", { sync: false });
                        return refreshUserProfileDeduped();
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
                resetCloudSyncSessionState();
                localStorage.removeItem(LAST_SYNC_USER_KEY);
                clearAllSyncCursors();
                void runWithApplyingRemote(() => {
                    useCanvasStore.getState().replaceProjects([], []);
                    useAssetStore.getState().replaceAssets([]);
                });
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
    markTombstone("canvas", ids);
    for (const id of ids) {
        deletedProjectIds.add(id);
        pendingProjectsToSync.delete(id);
        const timer = projectSaveTimers.get(id);
        if (timer) {
            clearTimeout(timer);
            projectSaveTimers.delete(id);
        }
    }
    const authenticated = isCloudAuthenticated();
    if (authenticated) {
        try {
            await canvasApi.deleteProjects(ids);
        } catch (error) {
            ids.forEach((id) => deletedProjectIds.delete(id));
            unmarkTombstone("canvas", ids);
            throw error;
        }
        ids.forEach((id) => cloudDeletedProjectIds.add(id));
    }
    useCanvasStore.getState().deleteProjects(ids);
    useAssetStore.getState().cleanupImages();
    if (authenticated) {
        notifyCloudWorkspaceChanged("canvas", { sync: false });
        void refreshUserProfileDeduped();
    }
}

/** 先确认云端删除资产成功，再移除本地资产与孤立媒体缓存（接口失败会抛出错误且保留本地数据）。 */
export async function deleteAssetsWithCloud(ids: string[]) {
    const uniqueIds = Array.from(new Set(ids)).filter(Boolean);
    if (!uniqueIds.length) return;
    markTombstone("assets", uniqueIds);
    uniqueIds.forEach((id) => deletedAssetIds.add(id));
    const authenticated = isCloudAuthenticated();
    if (authenticated) {
        try {
            await assetsApi.batchRemove(uniqueIds);
        } catch (error) {
            uniqueIds.forEach((id) => deletedAssetIds.delete(id));
            unmarkTombstone("assets", uniqueIds);
            throw error;
        }
        uniqueIds.forEach((id) => cloudDeletedAssetIds.add(id));
    }
    useAssetStore.getState().removeAssets(uniqueIds);
    if (authenticated) {
        notifyCloudWorkspaceChanged("assets", { sync: false });
        void refreshUserProfileDeduped();
    }
}

/** 先确认云端删除单个资产成功，再移除本地资产与孤立媒体缓存。 */
export async function deleteAssetWithCloud(id: string) {
    if (!id) return;
    await deleteAssetsWithCloud([id]);
}
