/** 画布跨路由后台生成运行时：以模块级单例保存进行中的请求与轮询任务，切换后台再返回画布时不丢失状态。 */
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

export type CanvasGenerationRequest = {
    projectId: string;
    targetNodeId: string;
    originNodeId: string;
    runningNodeId: string;
    controller: AbortController;
};

type ProjectNodesUpdater = (prev: CanvasNodeData[]) => CanvasNodeData[];
type ProjectNodesListener = (updater: ProjectNodesUpdater) => void;
type ProjectConnectionsUpdater = (prev: CanvasConnection[]) => CanvasConnection[];
type ProjectConnectionsListener = (updater: ProjectConnectionsUpdater) => void;

// 仅在浏览器整页刷新时清空；SPA 路由切换期间保持进行中的请求和订阅回调
const activeRequests = new Map<string, CanvasGenerationRequest>();
const activeVideoPolls = new Set<string>();
const projectListeners = new Map<string, ProjectNodesListener>();
const projectConnectionListeners = new Map<string, ProjectConnectionsListener>();
let pageUnloading = false;

if (typeof window !== "undefined") {
    const markUnloading = () => {
        pageUnloading = true;
    };
    const clearUnloading = () => {
        pageUnloading = false;
    };
    window.addEventListener("beforeunload", markUnloading);
    window.addEventListener("pagehide", markUnloading);
    window.addEventListener("pageshow", clearUnloading);
}

/** 浏览器正在刷新或关闭标签页时返回 true，避免卸载瞬间浏览器中断网络将进行中的节点误写为失败。 */
export function isPageUnloading() {
    return pageUnloading;
}

function keyFor(projectId: string, nodeId: string) {
    return `${projectId}:${nodeId}`;
}

/** 注册当前挂载画布页面的节点更新回调，页面卸载时自动注销。 */
export function registerCanvasNodeListener(projectId: string, listener: ProjectNodesListener) {
    projectListeners.set(projectId, listener);
    return () => {
        if (projectListeners.get(projectId) === listener) {
            projectListeners.delete(projectId);
        }
    };
}

/** 注册当前挂载画布页面的连线更新回调，页面卸载时自动注销。 */
export function registerCanvasConnectionListener(projectId: string, listener: ProjectConnectionsListener) {
    projectConnectionListeners.set(projectId, listener);
    return () => {
        if (projectConnectionListeners.get(projectId) === listener) {
            projectConnectionListeners.delete(projectId);
        }
    };
}

/** 同时更新持久化画布 Store 与当前挂载画布状态，保证后台生成完成时数据不丢失。 */
export function applyCanvasNodeUpdate(projectId: string, updater: ProjectNodesUpdater) {
    useCanvasStore.getState().patchProjectNodes(projectId, updater);
    projectListeners.get(projectId)?.(updater);
}

/** 同时更新持久化画布 Store 与当前挂载画布连线，避免切走页面导致新建子连线丢失。 */
export function applyCanvasConnectionUpdate(projectId: string, updater: ProjectConnectionsUpdater) {
    useCanvasStore.getState().patchProjectConnections(projectId, updater);
    projectConnectionListeners.get(projectId)?.(updater);
}

/** 获取指定画布当前仍在后台运行的节点 ID 集合，用于恢复画布时跳过中断判定。 */
export function getActiveGenerationNodeIds(projectId: string) {
    const ids = new Set<string>();
    const prefix = `${projectId}:`;
    activeRequests.forEach((req) => {
        if (req.projectId !== projectId) return;
        ids.add(req.targetNodeId);
        ids.add(req.originNodeId);
        ids.add(req.runningNodeId);
    });
    activeVideoPolls.forEach((entry) => {
        if (entry.startsWith(prefix)) ids.add(entry.slice(prefix.length));
    });
    return ids;
}

export function getFirstActiveRunningNodeId(projectId: string): string | null {
    for (const req of activeRequests.values()) {
        if (req.projectId === projectId) return req.runningNodeId;
    }
    return null;
}

export function startProjectGenerationRequest(
    projectId: string,
    targetNodeId: string,
    originNodeId: string,
    runningId = originNodeId,
    controller = new AbortController(),
) {
    const key = keyFor(projectId, targetNodeId);
    const previous = activeRequests.get(key);
    if (previous?.controller !== controller) previous?.controller.abort();
    activeRequests.set(key, { projectId, targetNodeId, originNodeId, runningNodeId: runningId, controller });
    return controller;
}

export function finishProjectGenerationRequest(projectId: string, targetNodeId: string, controller: AbortController) {
    const key = keyFor(projectId, targetNodeId);
    const request = activeRequests.get(key);
    if (request?.controller === controller) activeRequests.delete(key);
}

export function hasProjectGenerationRequest(projectId: string, targetNodeId: string) {
    return activeRequests.has(keyFor(projectId, targetNodeId));
}

export function stopProjectGenerationsByRunningId(projectId: string, runningId: string) {
    const affectedNodeIds = new Set<string>();
    activeRequests.forEach((request, key) => {
        if (request.projectId !== projectId || request.runningNodeId !== runningId) return;
        request.controller.abort();
        activeRequests.delete(key);
        affectedNodeIds.add(request.targetNodeId);
        affectedNodeIds.add(request.originNodeId);
    });
    return affectedNodeIds;
}

export function isVideoPollActive(projectId: string, nodeId: string) {
    return activeVideoPolls.has(keyFor(projectId, nodeId));
}

export function markVideoPollActive(projectId: string, nodeId: string) {
    activeVideoPolls.add(keyFor(projectId, nodeId));
}

export function clearVideoPollActive(projectId: string, nodeId: string) {
    activeVideoPolls.delete(keyFor(projectId, nodeId));
}
