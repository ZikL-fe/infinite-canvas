/** 后端服务 REST API 客户端：封装鉴权刷新、个人中心、账本日志、对象存储直传、WebDAV 归档及后台管理接口。 */
import { saveAs } from "file-saver";

import type { ModelPricing } from "@/stores/use-config-store";
import { useUserStore, type BootstrapStatus, type LocalUser, type UserRole, type UserStatus } from "@/stores/use-user-store";

export type S3Provider = "s3" | "r2" | "oss" | "cos";

export type S3StorageConfigForm = {
    provider: S3Provider;
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey?: string;
    publicBaseUrl: string;
    forcePathStyle: boolean;
};

export type S3StorageSettingsResponse = {
    configured: boolean;
    config: Omit<S3StorageConfigForm, "secretAccessKey"> & {
        hasSecretKey: boolean;
        secretAccessKeyPreview: string;
    };
};

export type MediaSourceModule = "canvas" | "image_workbench" | "video_workbench" | "assets";

export type WorkspaceDataItem = {
    id: string;
    kind: "canvas" | "image_workbench" | "video_workbench";
    userId: string;
    username: string;
    title: string;
    prompt?: string;
    model?: string;
    status?: string;
    nodeCount?: number;
    mediaCount: number;
    mediaBytes: number;
    dataBytes?: number;
    updatedAt: string;
    createdAt: string;
};

export type MediaItem = {
    id: string;
    userId: string;
    username?: string | null;
    bucket: string;
    objectKey: string;
    kind: "image" | "video" | "audio" | "file";
    mimeType: string;
    bytes: number;
    width?: number | null;
    height?: number | null;
    durationMs?: number | null;
    sourceType: string;
    modules?: MediaSourceModule[];
    meta?: Record<string, unknown>;
    createdAt: string;
    url: string;
    thumbnailUrl?: string;
};

export type AdminMediaByKind = {
    kind: string;
    count: number;
    bytes: number;
};

export type AdminTopStorageUser = {
    id: string;
    username: string;
    displayName: string;
    role: UserRole;
    storageUsedBytes: number;
    storageQuotaBytes?: number;
};

export type DailyTrendItem = {
    date: string;
    credits: number;
    calls: number;
};

export type TopModelUsageItem = {
    model: string;
    credits: number;
    calls: number;
};

export type AnnouncementItem = {
    id: string;
    title: string;
    content: string;
    level: "info" | "warning" | "success";
    isPinned: boolean;
    isPublished: boolean;
    createdAt: string;
    updatedAt: string;
};

export type AdminOverview = {
    totalUsers: number;
    adminCount: number;
    disabledUsers: number;
    activeMediaCount: number;
    totalStorageBytes: number;
    canvasProjectCount: number;
    assetCount: number;
    mediaByKind: AdminMediaByKind[];
    topStorageUsers: AdminTopStorageUser[];
    storageConfigured: boolean;
    storageBucket: string;
    storageProvider: string;
    days: number;
    totalConsumedCredits: number;
    todayConsumedCredits: number;
    rangeConsumedCredits: number;
    rangeCalls: number;
    dailyTrend: DailyTrendItem[];
    topModels: TopModelUsageItem[];
    announcements: AnnouncementItem[];
};

export type AccountOverviewResponse = {
    creditBalance: number;
    storageUsedBytes: number;
    storageQuotaBytes: number;
    storageQuotaExpiresAt?: string | null;
    canvasProjectCount: number;
    assetCount: number;
    days: number;
    totalConsumedCredits: number;
    todayConsumedCredits: number;
    rangeConsumedCredits: number;
    rangeCalls: number;
    dailyTrend: DailyTrendItem[];
    topModels: TopModelUsageItem[];
    announcements: AnnouncementItem[];
};

export type UserWebdavView = {
    enabled: boolean;
    url: string;
    username: string;
    directory: string;
    hasPassword: boolean;
    quotaBytes?: number | null;
    usedBytes?: number;
    expiresAt?: string | null;
};

export type StorageGrantItem = {
    id: string;
    quotaBytes: number;
    durationDays: number | null;
    expiresAt: string | null;
    source: "redeem_code" | "admin_grant" | "plan_grant";
    refId: string | null;
    note: string;
    status: "active" | "revoked";
    isExpired: boolean;
    isEffective: boolean;
    createdAt: string;
};

export type StorageQuotaDetail = {
    baseQuotaBytes: number;
    baseExpiresAt: string | null;
    grantsQuotaBytes: number;
    grants: StorageGrantItem[];
};

export type AdminUserItem = LocalUser & {
    baseStorageQuotaBytes?: number;
    baseStorageQuotaExpiresAt?: string | null;
    storageGrantsQuotaBytes?: number;
    activeGrantCount?: number;
    webdavConfig?: UserWebdavView | null;
    mediaCount?: number;
    projectCount?: number;
    creditBalance?: number;
    lastLoginAt?: string | null;
    createdAt: string;
};

export type CreditLedgerItem = {
    id: string;
    userId: string;
    username?: string | null;
    displayName?: string | null;
    delta: number;
    balanceAfter: number;
    reason: string;
    refId?: string | null;
    meta?: Record<string, unknown>;
    createdAt: string;
};

export type CreditLedgerSummary = {
    totalConsumed: number;
    totalRecharged: number;
    recordCount: number;
    consumeCalls: number;
    totalTokens: number;
    totalInputTokens: number;
    totalCachedTokens: number;
    totalOutputTokens: number;
    totalImages: number;
    totalMediaSeconds: number;
    avgRpm: number;
    peakRpm: number;
    recentRpm: number;
};

export type RedeemCodeKind = "credits" | "storage";

export type RedeemCodeRedemption = {
    userId: string;
    username: string;
    displayName: string;
    redeemedAt: string;
};

export type RedeemCodeItem = {
    id: string;
    code: string;
    kind: RedeemCodeKind;
    credits: number;
    storageQuotaBytes: number;
    storageDurationDays?: number | null;
    maxUses: number;
    usedCount: number;
    note: string;
    status: "active" | "disabled";
    expiresAt?: string | null;
    createdAt: string;
    redemption?: RedeemCodeRedemption | null;
};

export type AdminChannelModel = {
    name: string;
    capability: "image" | "video" | "text" | "audio";
    script?: string;
    pricing?: ModelPricing;
};

export type AdminChannelItem = {
    id: string;
    name: string;
    baseUrl: string;
    apiFormat: "openai" | "gemini";
    enabled: boolean;
    models: AdminChannelModel[];
    hasApiKey?: boolean;
    apiKeyPreview?: string;
    apiKey?: string;
};

export type AdminWebdavSettings = {
    enabled: boolean;
    url: string;
    username: string;
    baseDirectory: string;
    autoAssignNewUsers: boolean;
    hasPassword: boolean;
    passwordPreview: string;
};

export type RuntimeConfigResponse = {
    channels: Array<{
        id: string;
        name: string;
        apiFormat: "openai" | "gemini";
        baseUrl: string;
        models: AdminChannelModel[];
    }>;
    webdav: {
        enabled: boolean;
        isExpired?: boolean;
        isQuotaExceeded?: boolean;
    } | null;
};

let refreshingPromise: Promise<string | null> | null = null;

/** 使用 refreshToken 静默续签 accessToken（全局并发去重）。 */
export async function refreshAccessToken(): Promise<string | null> {
    if (refreshingPromise) return refreshingPromise;
    refreshingPromise = (async () => {
        const { refreshToken, setSession, clearSession } = useUserStore.getState();
        if (!refreshToken) return null;
        try {
            const response = await fetch("/api/auth/refresh", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ refreshToken }),
            });
            if (!response.ok) {
                clearSession();
                return null;
            }
            const data = (await response.json()) as { user: LocalUser; accessToken: string; refreshToken: string };
            setSession(data);
            return data.accessToken;
        } catch {
            clearSession();
            return null;
        } finally {
            refreshingPromise = null;
        }
    })();
    return refreshingPromise;
}

async function parseErrorMessage(response: Response) {
    try {
        const payload = (await response.json()) as { error?: string; message?: string };
        return payload.error || payload.message || `请求失败（HTTP ${response.status}）`;
    } catch {
        return `请求失败（HTTP ${response.status}）`;
    }
}

/** 统一请求包装器：自动附带访问令牌，遇到 401 时静默刷新令牌并重放原请求。 */
async function fetchServer(path: string, init: RequestInit = {}, auth = true): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
    }

    const { accessToken } = useUserStore.getState();
    if (auth && accessToken) {
        headers.set("Authorization", `Bearer ${accessToken}`);
    }

    let response = await fetch(`/api${path}`, { ...init, headers });

    if (response.status === 401 && auth && !path.startsWith("/auth/")) {
        const nextToken = await refreshAccessToken();
        if (nextToken) {
            headers.set("Authorization", `Bearer ${nextToken}`);
            response = await fetch(`/api${path}`, { ...init, headers });
        }
    }

    if (!response.ok) {
        throw new Error(await parseErrorMessage(response));
    }

    return response;
}

export async function requestServer<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
    const response = await fetchServer(path, init, auth);
    return (await response.json()) as T;
}

export type AccountProfileResponse = {
    user: LocalUser & { lastLoginAt?: string | null; createdAt: string };
    storageQuotaDetail?: StorageQuotaDetail;
    stats: {
        canvasProjectCount: number;
        assetCount: number;
        mediaByKind: AdminMediaByKind[];
    };
    webdav: {
        enabled: boolean;
        url: string;
        username: string;
        directory: string;
        quotaBytes?: number | null;
        usedBytes?: number;
        expiresAt?: string | null;
        isExpired?: boolean;
        isQuotaExceeded?: boolean;
    } | null;
};

export type AccountSessionItem = {
    id: string;
    userAgent: string;
    ip: string;
    createdAt: string;
    expiresAt: string;
    isCurrent: boolean;
};

export const accountApi = {
    getOverview: (days = 7) => requestServer<AccountOverviewResponse>(`/account/overview?days=${days}`),
    getProfile: () => requestServer<AccountProfileResponse>("/account/profile"),
    updateProfile: (payload: { displayName?: string; email?: string; avatarUrl?: string }) =>
        requestServer<{ user: LocalUser }>("/account/profile", { method: "PATCH", body: JSON.stringify(payload) }),
    changePassword: (payload: { currentPassword: string; newPassword: string; revokeOtherSessions?: boolean }) =>
        requestServer<{ ok: boolean }>("/account/change-password", {
            method: "POST",
            body: JSON.stringify({ ...payload, currentRefreshToken: useUserStore.getState().refreshToken }),
        }),
    listSessions: () =>
        requestServer<{ items: AccountSessionItem[] }>("/account/sessions", {
            headers: useUserStore.getState().refreshToken ? { "X-Refresh-Token": useUserStore.getState().refreshToken } : {},
        }),
    revokeSession: (id: string) => requestServer<{ ok: boolean }>(`/account/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
    revokeOtherSessions: () =>
        requestServer<{ ok: boolean }>("/account/sessions/revoke-others", {
            method: "POST",
            body: JSON.stringify({ currentRefreshToken: useUserStore.getState().refreshToken }),
        }),
};

export const authApi = {
    getBootstrapStatus: () => requestServer<BootstrapStatus>("/auth/bootstrap-status", {}, false),
    register: (payload: { username: string; password: string; email?: string; displayName?: string }) =>
        requestServer<{ user: LocalUser; accessToken: string; refreshToken: string }>("/auth/register", { method: "POST", body: JSON.stringify(payload) }, false),
    login: (payload: { account: string; password: string }) =>
        requestServer<{ user: LocalUser; accessToken: string; refreshToken: string }>("/auth/login", { method: "POST", body: JSON.stringify(payload) }, false),
    logout: async () => {
        const { refreshToken } = useUserStore.getState();
        if (!refreshToken) return;
        await requestServer<{ ok: boolean }>("/auth/logout", { method: "POST", body: JSON.stringify({ refreshToken }) }, false).catch(() => undefined);
    },
    me: () => requestServer<{ user: LocalUser }>("/auth/me"),
};

/** 根据云端媒体记录推导下载文件名。 */
export function mediaDownloadFilename(record: Pick<MediaItem, "id" | "objectKey" | "mimeType" | "kind">) {
    const ext = record.mimeType?.split("/")[1]?.split("+")[0] || (record.kind === "video" ? "mp4" : record.kind === "audio" ? "mp3" : "png");
    return record.objectKey.split("/").pop() || `media-${record.id.replace(/:/g, "_")}.${ext}`;
}

export const storageApi = {
    presignUpload: (payload: { mediaId?: string; filename?: string; kind: "image" | "video" | "audio" | "file"; mimeType: string; bytes?: number; width?: number; height?: number; durationMs?: number; sourceType?: "upload" | "ai_generated" | "canvas_import" }) =>
        requestServer<{ alreadyExists?: boolean; mediaId: string; objectKey: string; uploadUrl: string; expiresIn: number; headers: Record<string, string> }>("/storage/presign-upload", { method: "POST", body: JSON.stringify(payload) }),
    confirmUpload: (payload: { mediaId: string; width?: number; height?: number; durationMs?: number }) =>
        requestServer<{ media: MediaItem; url: string; storageUsedBytes?: number; storageQuotaBytes?: number }>("/storage/confirm", { method: "POST", body: JSON.stringify(payload) }),
    checkExists: (mediaIds: string[]) =>
        requestServer<{ existingIds: string[] }>("/storage/check-exists", { method: "POST", body: JSON.stringify({ mediaIds }) }),
    ingestUrl: (payload: { url: string; kind?: "image" | "video" | "audio" | "file"; sourceType?: "upload" | "ai_generated" | "canvas_import" }) =>
        requestServer<{ media: MediaItem; url: string }>("/storage/ingest-url", { method: "POST", body: JSON.stringify(payload) }),
    list: (params?: { q?: string; kind?: string; sourceType?: string; module?: string; page?: number; pageSize?: number }) => {
        const query = new URLSearchParams();
        if (params?.q) query.set("q", params.q);
        if (params?.kind) query.set("kind", params.kind);
        if (params?.sourceType) query.set("sourceType", params.sourceType);
        if (params?.module) query.set("module", params.module);
        if (params?.page) query.set("page", String(params.page));
        if (params?.pageSize) query.set("pageSize", String(params.pageSize));
        const suffix = query.size ? `?${query.toString()}` : "";
        return requestServer<{
            items: MediaItem[];
            total?: number;
            page?: number;
            pageSize?: number;
            workspaceStats?: { canvasProjects: number; imageLogs: number; videoLogs: number; assets: number };
        }>(`/storage/list${suffix}`);
    },
    getByTasks: (taskIds: string[]) => {
        const clean = Array.from(new Set(taskIds.map((id) => id.trim()).filter(Boolean)));
        if (!clean.length) return Promise.resolve({ itemsByTask: {} as Record<string, MediaItem[]>, processingTaskIds: [] as string[] });
        return requestServer<{ itemsByTask: Record<string, MediaItem[]>; processingTaskIds: string[] }>(
            `/storage/by-tasks?taskIds=${encodeURIComponent(clean.join(","))}`,
        );
    },
    getUrl: (mediaId: string) => requestServer<{ mediaId: string; url: string; expiresIn: number }>(`/storage/url/${encodeURIComponent(mediaId)}`),
    downloadBlob: async (mediaId: string) => {
        const response = await fetchServer(`/storage/download/${encodeURIComponent(mediaId)}`);
        return response.blob();
    },
    getLedgerMedia: (ledgerId: string) => requestServer<{ items: MediaItem[] }>(`/storage/ledger-media/${encodeURIComponent(ledgerId)}`),
    getThumbnailUrl: (mediaId: string) => requestServer<{ mediaId: string; thumbnailUrl: string }>(`/storage/thumbnail/${encodeURIComponent(mediaId)}`),
    uploadThumbnail: (mediaId: string, blob: Blob) => {
        const form = new FormData();
        form.append("file", blob, "thumb.webp");
        return requestServer<{ ok: boolean; thumbnailUrl: string }>(`/storage/thumbnail/${encodeURIComponent(mediaId)}`, {
            method: "POST",
            body: form,
        });
    },
    getUrls: (mediaIds: string[]) => requestServer<{ urls: Record<string, string> }>("/storage/urls", { method: "POST", body: JSON.stringify({ mediaIds }) }),
    remove: (mediaId: string) => requestServer<{ ok: boolean }>(`/storage/${encodeURIComponent(mediaId)}`, { method: "DELETE" }),
    getGrants: () =>
        requestServer<{
            storageUsedBytes: number;
            storageQuotaBytes: number;
            storageQuotaExpiresAt: string | null;
            baseQuotaBytes: number;
            baseExpiresAt: string | null;
            grantsQuotaBytes: number;
            grants: StorageGrantItem[];
        }>("/storage/grants"),
    redeem: (code: string) =>
        requestServer<{
            ok: boolean;
            kind: "storage";
            storageBytesAdded: number;
            storageDurationDays: number | null;
            expiresAt: string | null;
            storageQuotaBytes: number;
            storageQuotaExpiresAt: string | null;
            baseQuotaBytes: number;
            baseExpiresAt: string | null;
            grantsQuotaBytes: number;
            grants: StorageGrantItem[];
        }>("/storage/redeem", { method: "POST", body: JSON.stringify({ code }) }),
    /** 通过鉴权下载接口拉取文件 Blob 并触发本地保存，避免直接打开跨域 S3 预签名链接。 */
    async downloadFile(record: Pick<MediaItem, "id" | "objectKey" | "mimeType" | "kind">, filename?: string) {
        const blob = await storageApi.downloadBlob(record.id);
        saveAs(blob, filename || mediaDownloadFilename(record));
    },
    async uploadBlobWithKey(
        mediaId: string,
        blob: Blob,
        kind: "image" | "video" | "audio" | "file",
        meta?: { width?: number; height?: number; durationMs?: number; filename?: string; sourceType?: "upload" | "ai_generated" | "canvas_import" },
    ) {
        const mimeType = blob.type || "application/octet-stream";
        const presign = await storageApi.presignUpload({
            mediaId,
            filename: meta?.filename,
            kind,
            mimeType,
            bytes: blob.size,
            width: meta?.width,
            height: meta?.height,
            durationMs: meta?.durationMs,
            sourceType: meta?.sourceType,
        });
        if (presign.alreadyExists) {
            return { mediaId, url: "" };
        }
        const uploadRes = await fetch(presign.uploadUrl, {
            method: "PUT",
            headers: presign.headers,
            body: blob,
        });
        if (!uploadRes.ok) {
            throw new Error(`直传对象存储失败（HTTP ${uploadRes.status}），请检查桶 CORS 配置`);
        }
        const confirmed = await storageApi.confirmUpload({
            mediaId: presign.mediaId,
            width: meta?.width,
            height: meta?.height,
            durationMs: meta?.durationMs,
        });
        const currentUser = useUserStore.getState().user;
        if (currentUser && typeof confirmed.storageUsedBytes === "number") {
            useUserStore.getState().setUser({
                ...currentUser,
                storageUsedBytes: confirmed.storageUsedBytes,
                ...(typeof confirmed.storageQuotaBytes === "number" ? { storageQuotaBytes: confirmed.storageQuotaBytes } : {}),
            });
        }
        return { mediaId: confirmed.media.id, url: confirmed.url };
    },
    async uploadFile(file: File, kind?: "image" | "video" | "audio" | "file") {
        const detectedKind = kind || (file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : "file");
        const mimeType = file.type || "application/octet-stream";
        const presign = await storageApi.presignUpload({ filename: file.name, kind: detectedKind, mimeType, bytes: file.size });
        const uploadRes = await fetch(presign.uploadUrl, {
            method: "PUT",
            headers: presign.headers,
            body: file,
        });
        if (!uploadRes.ok) {
            throw new Error(`直传对象存储失败（HTTP ${uploadRes.status}），请检查桶 CORS 配置`);
        }
        return storageApi.confirmUpload({ mediaId: presign.mediaId });
    },
    uploadToWebdav: (storageKey: string, blob: Blob, kind: "image" | "video" | "audio" | "file", filename?: string) => {
        const form = new FormData();
        form.append("file", blob, filename || `${storageKey.replace(/:/g, "_")}`);
        form.append("kind", kind);
        form.append("storageKey", storageKey);
        if (filename) form.append("filename", filename);
        return requestServer<{ ok: boolean; path: string; bytes: number; usedBytes: number; quotaBytes: number | null }>("/storage/webdav/upload", {
            method: "POST",
            body: form,
        });
    },
};

export const canvasApi = {
    listProjects: (withStats = false) =>
        requestServer<{ projects: Record<string, unknown>[]; deletedProjects: { id: string; deletedAt: string }[] }>(
            `/canvas/projects${withStats ? "?withStats=1" : ""}`,
        ),
    saveProject: (id: string, payload: Record<string, unknown>) =>
        requestServer<{ project: Record<string, unknown> | null; skippedDeleted?: boolean; deletedMediaCount?: number }>(
            `/canvas/projects/${encodeURIComponent(id)}`,
            { method: "PUT", body: JSON.stringify(payload) },
        ),
    deleteProjects: (ids: string[]) =>
        requestServer<{ ok: boolean; deletedMediaCount?: number }>("/canvas/projects/batch-delete", { method: "POST", body: JSON.stringify({ ids }) }),
};

export const workbenchApi = {
    listLogs: (kind: "image" | "video", withStats = false) =>
        requestServer<{ logs: Record<string, unknown>[]; deletedIds: { id: string; deletedAt: string }[] }>(
            `/workbench/logs?kind=${kind}${withStats ? "&withStats=1" : ""}`,
        ),
    saveLog: (id: string, payload: Record<string, unknown>) =>
        requestServer<{ ok: boolean; skippedDeleted?: boolean; deletedMediaCount?: number }>(
            `/workbench/logs/${encodeURIComponent(id)}`,
            { method: "PUT", body: JSON.stringify(payload) },
        ),
    deleteLogs: (ids: string[], kind?: "image" | "video") =>
        requestServer<{ ok: boolean; deletedMediaCount?: number }>("/workbench/logs/batch-delete", {
            method: "POST",
            body: JSON.stringify({ ids, ...(kind ? { kind } : {}) }),
        }),
};

export const assetsApi = {
    list: () => requestServer<{ assets: Record<string, unknown>[]; deletedIds: { id: string; deletedAt: string }[] }>("/assets"),
    save: (id: string, payload: Record<string, unknown>) =>
        requestServer<{ ok: boolean }>(`/assets/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(payload) }),
    remove: (id: string) => requestServer<{ ok: boolean }>(`/assets/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

export const runtimeApi = {
    getConfig: () => requestServer<RuntimeConfigResponse>("/runtime/config"),
};

export const billingApi = {
    getLedger: (params?: { logId?: string; taskStatus?: string; category?: "usage" | "recharge"; reason?: string; model?: string; startDate?: string; endDate?: string; page?: number; pageSize?: number }) => {
        const query = new URLSearchParams();
        if (params?.logId) query.set("logId", params.logId);
        if (params?.taskStatus) query.set("taskStatus", params.taskStatus);
        if (params?.category) query.set("category", params.category);
        if (params?.reason) query.set("reason", params.reason);
        if (params?.model) query.set("model", params.model);
        if (params?.startDate) query.set("startDate", params.startDate);
        if (params?.endDate) query.set("endDate", params.endDate);
        if (params?.page) query.set("page", String(params.page));
        if (params?.pageSize) query.set("pageSize", String(params.pageSize));
        const suffix = query.size ? `?${query.toString()}` : "";
        return requestServer<{
            balance: number;
            items: CreditLedgerItem[];
            total: number;
            page: number;
            pageSize: number;
            summary: CreditLedgerSummary;
        }>(`/billing/ledger${suffix}`);
    },
    redeem: (code: string) =>
        requestServer<{ ok: boolean; creditsAdded: number; balance: number }>("/billing/redeem", {
            method: "POST",
            body: JSON.stringify({ code }),
        }),
};

let balanceRefreshTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleRefreshUserBalance() {
    if (!useUserStore.getState().accessToken) return;
    if (balanceRefreshTimer) clearTimeout(balanceRefreshTimer);
    balanceRefreshTimer = setTimeout(() => {
        balanceRefreshTimer = null;
        void authApi
            .me()
            .then((res) => useUserStore.getState().setUser(res.user))
            .catch(() => undefined);
    }, 350);
}

export const adminApi = {
    getOverview: (days = 7) => requestServer<AdminOverview>(`/admin/overview?days=${days}`),
    listAnnouncements: () => requestServer<{ items: AnnouncementItem[] }>("/admin/announcements"),
    createAnnouncement: (payload: { title: string; content: string; level: "info" | "warning" | "success"; isPinned: boolean; isPublished: boolean }) =>
        requestServer<{ item: AnnouncementItem }>("/admin/announcements", { method: "POST", body: JSON.stringify(payload) }),
    updateAnnouncement: (id: string, payload: Partial<{ title: string; content: string; level: "info" | "warning" | "success"; isPinned: boolean; isPublished: boolean }>) =>
        requestServer<{ item: AnnouncementItem }>(`/admin/announcements/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) }),
    deleteAnnouncement: (id: string) => requestServer<{ ok: boolean }>(`/admin/announcements/${encodeURIComponent(id)}`, { method: "DELETE" }),
    listUsers: (params?: { q?: string; role?: string; status?: string; sort?: string; page?: number; pageSize?: number }) => {
        const query = new URLSearchParams();
        if (params?.q) query.set("q", params.q);
        if (params?.role) query.set("role", params.role);
        if (params?.status) query.set("status", params.status);
        if (params?.sort) query.set("sort", params.sort);
        if (params?.page) query.set("page", String(params.page));
        if (params?.pageSize) query.set("pageSize", String(params.pageSize));
        const suffix = query.size ? `?${query.toString()}` : "";
        return requestServer<{ items: AdminUserItem[]; total: number; page: number; pageSize: number }>(`/admin/users${suffix}`);
    },
    updateUser: (id: string, payload: { role?: UserRole; status?: UserStatus }) =>
        requestServer<{ user: AdminUserItem }>(`/admin/users/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) }),
    adjustUserCredits: (id: string, payload: { delta: number; note?: string }) =>
        requestServer<{ ok: boolean; balance: number }>(`/admin/users/${encodeURIComponent(id)}/credits`, { method: "POST", body: JSON.stringify(payload) }),
    updateUserStorageQuota: (id: string, payload: { storageQuotaBytes: number; storageQuotaExpiresAt?: string | null; recalculateUsedBytes?: boolean }) =>
        requestServer<{
            ok: boolean;
            storageQuotaBytes: number;
            storageQuotaExpiresAt: string | null;
            baseStorageQuotaBytes: number;
            baseStorageQuotaExpiresAt: string | null;
            storageGrantsQuotaBytes: number;
            storageUsedBytes: number;
        }>(`/admin/users/${encodeURIComponent(id)}/storage-quota`, { method: "PUT", body: JSON.stringify(payload) }),
    getUserStorageGrants: (id: string) =>
        requestServer<{
            storageUsedBytes: number;
            storageQuotaBytes: number;
            storageQuotaExpiresAt: string | null;
            baseStorageQuotaBytes: number;
            baseStorageQuotaExpiresAt: string | null;
            storageGrantsQuotaBytes: number;
            grants: StorageGrantItem[];
        }>(`/admin/users/${encodeURIComponent(id)}/storage-grants`),
    updateStorageGrantStatus: (grantId: string, status: "active" | "revoked") =>
        requestServer<{ ok: boolean; grant: StorageGrantItem }>(`/admin/storage-grants/${encodeURIComponent(grantId)}`, {
            method: "PATCH",
            body: JSON.stringify({ status }),
        }),
    getStorageSettings: () => requestServer<S3StorageSettingsResponse>("/admin/settings/storage"),
    saveStorageSettings: (payload: S3StorageConfigForm) =>
        requestServer<{ ok: boolean; secretAccessKeyPreview: string }>("/admin/settings/storage", { method: "PUT", body: JSON.stringify(payload) }),
    testStorageSettings: (payload: S3StorageConfigForm) =>
        requestServer<{ ok: boolean; message: string }>("/admin/settings/storage/test", { method: "POST", body: JSON.stringify(payload) }),
    getAuthSettings: () => requestServer<{ allowRegister: boolean }>("/admin/settings/auth"),
    saveAuthSettings: (payload: { allowRegister: boolean }) =>
        requestServer<{ allowRegister: boolean }>("/admin/settings/auth", { method: "PUT", body: JSON.stringify(payload) }),
    getChannelSettings: () => requestServer<{ channels: AdminChannelItem[] }>("/admin/settings/channels"),
    saveChannelSettings: (channels: AdminChannelItem[]) =>
        requestServer<{ ok: boolean }>("/admin/settings/channels", { method: "PUT", body: JSON.stringify({ channels }) }),
    fetchChannelModels: (payload: { id?: string; baseUrl: string; apiKey?: string; apiFormat: "openai" | "gemini" }) =>
        requestServer<{ models: string[] }>("/admin/settings/channels/fetch-models", { method: "POST", body: JSON.stringify(payload) }),
    getWebdavSettings: () => requestServer<AdminWebdavSettings>("/admin/settings/webdav"),
    saveWebdavSettings: (payload: { enabled: boolean; url: string; username: string; password?: string; baseDirectory: string; autoAssignNewUsers: boolean }) =>
        requestServer<{ ok: boolean }>("/admin/settings/webdav", { method: "PUT", body: JSON.stringify(payload) }),
    testWebdavSettings: (payload: { enabled: boolean; url: string; username: string; password?: string; baseDirectory: string; autoAssignNewUsers: boolean }) =>
        requestServer<{ ok: boolean; message: string }>("/admin/settings/webdav/test", { method: "POST", body: JSON.stringify(payload) }),
    assignUserWebdav: (
        userId: string,
        payload: {
            enabled: boolean;
            url?: string;
            username?: string;
            password?: string;
            directory?: string;
            quotaBytes?: number | null;
            expiresAt?: string | null;
            resetUsedBytes?: boolean;
        },
    ) => requestServer<{ ok: boolean; webdavConfig: UserWebdavView }>(`/admin/users/${encodeURIComponent(userId)}/webdav`, { method: "PUT", body: JSON.stringify(payload) }),
    listMedia: (params?: { q?: string; kind?: string; module?: string; page?: number; pageSize?: number }) => {
        const query = new URLSearchParams();
        if (params?.q) query.set("q", params.q);
        if (params?.kind) query.set("kind", params.kind);
        if (params?.module) query.set("module", params.module);
        if (params?.page) query.set("page", String(params.page));
        if (params?.pageSize) query.set("pageSize", String(params.pageSize));
        const suffix = query.size ? `?${query.toString()}` : "";
        return requestServer<{
            items: MediaItem[];
            total: number;
            filteredBytes?: number;
            page: number;
            pageSize: number;
            workspaceStats?: { canvasProjects: number; imageLogs: number; videoLogs: number };
        }>(`/admin/media${suffix}`);
    },
    deleteMedia: (mediaId: string) => requestServer<{ ok: boolean }>(`/admin/media/${encodeURIComponent(mediaId)}`, { method: "DELETE" }),
    listWorkspaceData: (params: { kind: "canvas" | "image_workbench" | "video_workbench"; q?: string; page?: number; pageSize?: number }) => {
        const query = new URLSearchParams({ kind: params.kind });
        if (params.q) query.set("q", params.q);
        if (params.page) query.set("page", String(params.page));
        if (params.pageSize) query.set("pageSize", String(params.pageSize));
        return requestServer<{ items: WorkspaceDataItem[]; total: number; page: number; pageSize: number }>(`/admin/workspace-data?${query.toString()}`);
    },
    deleteWorkspaceData: (kind: "canvas" | "image_workbench" | "video_workbench", id: string) =>
        requestServer<{ ok: boolean; deletedMediaCount?: number }>(`/admin/workspace-data/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, { method: "DELETE" }),
    listRedeemCodes: (params?: { q?: string; status?: string; kind?: RedeemCodeKind | ""; page?: number; pageSize?: number }) => {
        const query = new URLSearchParams();
        if (params?.q) query.set("q", params.q);
        if (params?.status) query.set("status", params.status);
        if (params?.kind) query.set("kind", params.kind);
        if (params?.page) query.set("page", String(params.page));
        if (params?.pageSize) query.set("pageSize", String(params.pageSize));
        const suffix = query.size ? `?${query.toString()}` : "";
        return requestServer<{ items: RedeemCodeItem[]; total: number; page: number; pageSize: number }>(`/admin/redeem-codes${suffix}`);
    },
    createRedeemCodes: (payload: {
        kind: RedeemCodeKind;
        count: number;
        credits?: number;
        storageQuotaBytes?: number;
        storageDurationDays?: number | null;
        maxUses?: number;
        prefix?: string;
        customCode?: string;
        expiresAt?: string | null;
        note?: string;
    }) =>
        requestServer<{ items: RedeemCodeItem[] }>("/admin/redeem-codes", { method: "POST", body: JSON.stringify(payload) }),
    updateRedeemCode: (id: string, payload: { status: "active" | "disabled" }) =>
        requestServer<{ item: RedeemCodeItem }>(`/admin/redeem-codes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(payload) }),
    deleteRedeemCode: (id: string) => requestServer<{ ok: boolean }>(`/admin/redeem-codes/${encodeURIComponent(id)}`, { method: "DELETE" }),
    batchDeleteRedeemCodes: (ids: string[]) =>
        requestServer<{ ok: boolean; deletedCount: number }>("/admin/redeem-codes/batch-delete", {
            method: "POST",
            body: JSON.stringify({ ids }),
        }),
    listLogs: (params?: { scope?: "all" | "self"; q?: string; logId?: string; taskStatus?: string; category?: "usage" | "recharge"; reason?: string; model?: string; startDate?: string; endDate?: string; page?: number; pageSize?: number }) => {
        const query = new URLSearchParams();
        if (params?.scope) query.set("scope", params.scope);
        if (params?.q) query.set("q", params.q);
        if (params?.logId) query.set("logId", params.logId);
        if (params?.taskStatus) query.set("taskStatus", params.taskStatus);
        if (params?.category) query.set("category", params.category);
        if (params?.reason) query.set("reason", params.reason);
        if (params?.model) query.set("model", params.model);
        if (params?.startDate) query.set("startDate", params.startDate);
        if (params?.endDate) query.set("endDate", params.endDate);
        if (params?.page) query.set("page", String(params.page));
        if (params?.pageSize) query.set("pageSize", String(params.pageSize));
        const suffix = query.size ? `?${query.toString()}` : "";
        return requestServer<{
            scope: "all" | "self";
            items: CreditLedgerItem[];
            total: number;
            page: number;
            pageSize: number;
            summary: CreditLedgerSummary;
        }>(`/admin/logs${suffix}`);
    },
};
