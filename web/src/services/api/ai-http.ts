/** AI 代理请求客户端：自动注入最新登录令牌并在 401 时静默续签 accessToken 后重试。 */
import axios, { AxiosHeaders, type InternalAxiosRequestConfig } from "axios";

import { refreshAccessToken } from "@/services/api/server";
import { useUserStore } from "@/stores/use-user-store";

type RetriableAxiosConfig = InternalAxiosRequestConfig & { _aiRetried?: boolean };

export function isAiProxyUrl(url?: string) {
    if (!url) return false;
    try {
        const target = new URL(url, window.location.href);
        return target.origin === window.location.origin && target.pathname.startsWith("/api/ai/proxy/");
    } catch {
        return false;
    }
}

function isAiProxyRequest(config: InternalAxiosRequestConfig) {
    return isAiProxyUrl(aiAxios.getUri(config));
}

function applyFreshAuthHeaders(headers: AxiosHeaders, token: string) {
    headers.set("Authorization", `Bearer ${token}`);
    headers.delete("x-goog-api-key");
}

export const aiAxios = axios.create();

aiAxios.interceptors.request.use((config) => {
    if (isAiProxyRequest(config)) {
        const token = useUserStore.getState().accessToken;
        if (token) {
            const headers = AxiosHeaders.from(config.headers);
            applyFreshAuthHeaders(headers, token);
            config.headers = headers;
        }
    }
    return config;
});

aiAxios.interceptors.response.use(
    (response) => response,
    async (error) => {
        if (!axios.isAxiosError(error) || error.response?.status !== 401) {
            return Promise.reject(error);
        }
        const config = error.config as RetriableAxiosConfig | undefined;
        if (!config || config._aiRetried || !isAiProxyRequest(config)) {
            return Promise.reject(error);
        }
        config._aiRetried = true;
        const freshToken = await refreshAccessToken();
        if (!freshToken) {
            return Promise.reject(error);
        }
        const headers = AxiosHeaders.from(config.headers);
        applyFreshAuthHeaders(headers, freshToken);
        config.headers = headers;
        return aiAxios.request(config);
    },
);

function withFreshFetchAuth(input: RequestInfo | URL, init: RequestInit | undefined, token: string): RequestInit | undefined {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("Authorization", `Bearer ${token}`);
    headers.delete("x-goog-api-key");
    return { ...init, headers };
}

/** 面向流式 SSE fetch 请求的认证封装：请求前注入最新令牌，遇到 401 自动续签后重试一次。 */
export async function fetchAiWithRefresh(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const currentToken = isAiProxyUrl(url) ? useUserStore.getState().accessToken : "";
    const firstInit = currentToken ? withFreshFetchAuth(input, init, currentToken) : init;
    const response = await fetch(input, firstInit);
    if (response.status !== 401 || !isAiProxyUrl(url)) {
        return response;
    }
    const freshToken = await refreshAccessToken();
    if (!freshToken) return response;
    return fetch(input, withFreshFetchAuth(input, init, freshToken));
}

/** 解析服务端 AI 代理响应头中附带的云端转存媒体 ID 列表。 */
export function readCloudMediaIdsHeader(headers?: unknown): Array<string | null> {
    if (!headers || typeof headers !== "object") return [];
    const rec = headers as Record<string, unknown>;
    const raw = rec["x-cloud-media-ids"] ?? rec["X-Cloud-Media-Ids"];
    if (typeof raw !== "string" || !raw.trim()) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.map((id) => (typeof id === "string" && id ? id : null)) : [];
    } catch {
        return [];
    }
}
