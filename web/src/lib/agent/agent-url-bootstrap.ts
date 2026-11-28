export function isLoopbackAgentUrl(rawUrl: string) {
    try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
        const host = parsed.hostname.toLowerCase();
        return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
    } catch {
        return false;
    }
}

export function hasAgentUrlBootstrap(hash: string) {
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    return params.has("agentUrl") || params.has("agentToken");
}

export function readAgentUrlBootstrap(hash: string) {
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    if (!params.has("agentUrl") && !params.has("agentToken")) return null;
    const url = params.get("agentUrl")?.trim() || "";
    const token = params.get("agentToken")?.trim() || "";
    params.delete("agentUrl");
    params.delete("agentToken");
    const remaining = params.toString();
    return { url, token, remainingHash: remaining ? `#${remaining}` : "" };
}
