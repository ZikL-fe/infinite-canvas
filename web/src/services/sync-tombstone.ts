/** 云同步持久化删除墓碑与本地未推送脏集合（基于 localforage 落盘，刷新/跨标签页不丢失且与客户端系统时钟无关）。 */
import localforage from "localforage";

export type SyncDomain = "canvas" | "assets" | "workbench_image" | "workbench_video";

type SyncMetaState = {
    deleted: Record<SyncDomain, string[]>;
    dirty: Record<SyncDomain, string[]>;
};

const STORE_KEY = "sync_meta_v1";
const syncMetaStore = localforage.createInstance({ name: "infinite-canvas", storeName: "cloud_sync_meta" });

const EMPTY_STATE = (): SyncMetaState => ({
    deleted: { canvas: [], assets: [], workbench_image: [], workbench_video: [] },
    dirty: { canvas: [], assets: [], workbench_image: [], workbench_video: [] },
});

const deletedSets: Record<SyncDomain, Set<string>> = {
    canvas: new Set(),
    assets: new Set(),
    workbench_image: new Set(),
    workbench_video: new Set(),
};

const dirtySets: Record<SyncDomain, Set<string>> = {
    canvas: new Set(),
    assets: new Set(),
    workbench_image: new Set(),
    workbench_video: new Set(),
};

let hydrated = false;
let hydratePromise: Promise<void> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
        persistTimer = null;
        const snapshot: SyncMetaState = {
            deleted: {
                canvas: Array.from(deletedSets.canvas),
                assets: Array.from(deletedSets.assets),
                workbench_image: Array.from(deletedSets.workbench_image),
                workbench_video: Array.from(deletedSets.workbench_video),
            },
            dirty: {
                canvas: Array.from(dirtySets.canvas),
                assets: Array.from(dirtySets.assets),
                workbench_image: Array.from(dirtySets.workbench_image),
                workbench_video: Array.from(dirtySets.workbench_video),
            },
        };
        void syncMetaStore.setItem(STORE_KEY, snapshot).catch(() => undefined);
    }, 50);
}

/** 启动或首次同步前从 IndexedDB 加载持久化墓碑与脏标记集合（幂等并发去重）。 */
export async function ensureSyncMetaHydrated(): Promise<void> {
    if (hydrated) return;
    if (hydratePromise) return hydratePromise;
    hydratePromise = syncMetaStore
        .getItem<SyncMetaState>(STORE_KEY)
        .then((saved) => {
            const data = saved || EMPTY_STATE();
            (["canvas", "assets", "workbench_image", "workbench_video"] as SyncDomain[]).forEach((domain) => {
                (data.deleted?.[domain] || []).forEach((id) => deletedSets[domain].add(id));
                (data.dirty?.[domain] || []).forEach((id) => {
                    if (!deletedSets[domain].has(id)) dirtySets[domain].add(id);
                });
            });
            hydrated = true;
        })
        .catch(() => {
            hydrated = true;
        })
        .finally(() => {
            hydratePromise = null;
        });
    return hydratePromise;
}

/** 将指定域下的记录 ID 写入持久化删除墓碑并清除其脏标记，防止刷新或并发同步时回流。 */
export function markTombstone(domain: SyncDomain, ids: string | string[]) {
    const list = Array.isArray(ids) ? ids : [ids];
    let changed = false;
    for (const id of list) {
        if (!id) continue;
        if (!deletedSets[domain].has(id)) {
            deletedSets[domain].add(id);
            changed = true;
        }
        if (dirtySets[domain].delete(id)) changed = true;
    }
    if (changed) schedulePersist();
}

/** 在云端删除接口失败回滚时撤销指定 ID 的删除墓碑。 */
export function unmarkTombstone(domain: SyncDomain, ids: string | string[]) {
    const list = Array.isArray(ids) ? ids : [ids];
    let changed = false;
    for (const id of list) {
        if (deletedSets[domain].delete(id)) changed = true;
    }
    if (changed) schedulePersist();
}

/** 判断指定记录是否已进入持久化删除墓碑。 */
export function hasTombstone(domain: SyncDomain, id: string): boolean {
    return deletedSets[domain].has(id);
}

/** 获取指定域当前的持久化删除墓碑集合（只读）。 */
export function getTombstoneSet(domain: SyncDomain): ReadonlySet<string> {
    return deletedSets[domain];
}

/** 标记本地记录已发生修改待推送云端（同时移除可能存在的旧墓碑）。 */
export function markDirty(domain: SyncDomain, id: string) {
    if (!id) return;
    let changed = false;
    if (deletedSets[domain].delete(id)) changed = true;
    if (!dirtySets[domain].has(id)) {
        dirtySets[domain].add(id);
        changed = true;
    }
    if (changed) schedulePersist();
}

/** 在云端推送成功或应用服务端权威快照后清除本地脏标记。 */
export function clearDirty(domain: SyncDomain, id: string) {
    if (dirtySets[domain].delete(id)) {
        schedulePersist();
    }
}

/** 判断本地记录是否存在尚未推送到云端的修改。 */
export function isDirty(domain: SyncDomain, id: string): boolean {
    return dirtySets[domain].has(id);
}

/** 退出登录或切换账号时清空全部持久化墓碑与脏标记。 */
export function clearAllSyncMeta() {
    (["canvas", "assets", "workbench_image", "workbench_video"] as SyncDomain[]).forEach((domain) => {
        deletedSets[domain].clear();
        dirtySets[domain].clear();
    });
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    void syncMetaStore.removeItem(STORE_KEY).catch(() => undefined);
}
