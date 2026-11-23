/** AI 代理请求客户端：自动注入最新登录令牌并在 401 时静默续签 accessToken 后重试。 */
import axios, { AxiosHeaders, type InternalAxiosRequestConfig } from "axios";

import { refreshAccessToken } from "@/services/api/server";
import { useUserStore } from "@/stores/use-user-store";

type RetriableAxiosConfig = InternalAxiosRequestConfig & { _aiRetried?: boolean };

function isAiProxyUrl(url?: string) {
    if (!url) return false;
    return url.includes("/api/ai/proxy/");
}

function applyFreshAuthHeaders(headers: AxiosHeaders, token: string) {
    if (headers.has("Authorization") || headers.has("authorization")) {
        headers.set("Authorization", `Bearer ${token}`);
    }
    if (headers.has("x-goog-api-key") || headers.has("X-Goog-Api-Key")) {
        headers.set("x-goog-api-key", token);
    }
}

export const aiAxios = axios.create();

aiAxios.interceptors.request.use((config) => {
    if (isAiProxyUrl(config.url)) {
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
        if (!config || config._aiRetried || !isAiProxyUrl(config.url)) {
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
    if (!init?.headers) return init;
    const headers = new Headers(init.headers);
    if (headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
    if (headers.has("x-goog-api-key")) headers.set("x-goog-api-key", token);
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
