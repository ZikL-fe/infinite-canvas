/** 服务端 API 统一 HTTP 客户端：负责携带访问令牌、401 并发去重静默刷新、错误建模与查询串构造。 */
import i18n from "@/i18n";
import { useUserStore, type LocalUser } from "@/stores/use-user-store";

export class ApiError extends Error {
    status: number;
    code?: string;

    constructor(message: string, status: number, code?: string) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.code = code;
    }
}

/** 构造 URL 查询字符串（自动忽略空值与 undefined）。 */
export function buildQuery(params?: Record<string, string | number | boolean | null | undefined>): string {
    if (!params) return "";
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === "") continue;
        query.set(key, String(value));
    }
    const qs = query.toString();
    return qs ? `?${qs}` : "";
}

let refreshingPromise: Promise<string | null> | null = null;

/** 使用 refreshToken 静默续签 accessToken（全局并发去重；仅在明确鉴权失败时清理会话，避免瞬时网络波动误登出）。 */
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
                if (response.status === 401 || response.status === 403) {
                    clearSession();
                }
                return null;
            }
            const data = (await response.json()) as { user: LocalUser; accessToken: string; refreshToken: string };
            setSession(data);
            return data.accessToken;
        } catch {
            // 网络抖动或离线时不主动登出，保留本地会话待网络恢复后重试
            return null;
        } finally {
            refreshingPromise = null;
        }
    })();
    return refreshingPromise;
}

async function parseErrorPayload(response: Response): Promise<{ message: string; code?: string }> {
    try {
        const payload = (await response.json()) as { error?: string; message?: string; code?: string };
        return {
            message: payload.error || payload.message || i18n.t("apiErrors.serverHttpFailed", { status: response.status }),
            code: payload.code,
        };
    } catch {
        return { message: i18n.t("apiErrors.serverHttpFailed", { status: response.status }) };
    }
}

/** 统一请求包装器：自动附带访问令牌，遇到 401 时静默刷新令牌并重放原请求。 */
export async function fetchServer(path: string, init: RequestInit = {}, auth = true): Promise<Response> {
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
        const { message, code } = await parseErrorPayload(response);
        throw new ApiError(message, response.status, code);
    }

    return response;
}

/** 发起 JSON 请求并解析响应（兼容 204 No Content 与空响应体）。 */
export async function requestServer<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
    const response = await fetchServer(path, init, auth);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
}
