/** 敏感认证与核销接口的进程内滑动窗口限流器，仅挂载于高风险入口，不影响常规业务并发。 */
import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";

import { env } from "../env.ts";
import { getAuthPolicy, type AuthRateLimitPolicy } from "./settings.ts";

type WindowBucket = {
  timestamps: number[];
};

const WINDOW_MS = 60_000;
const MAX_STORED_KEYS = 10_000;
const store = new Map<string, WindowBucket>();

function normalizeIp(ip: string): string {
  const trimmed = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
}

const TRUSTED_PROXIES = new Set(
  [
    "127.0.0.1",
    "::1",
    ...env.TRUSTED_PROXY_IPS.split(",")
      .map((item) => normalizeIp(item))
      .filter(Boolean),
  ],
);

function isTrustedProxy(remoteIp: string): boolean {
  if (!remoteIp) return false;
  return TRUSTED_PROXIES.has(normalizeIp(remoteIp));
}

function pruneExpired(now: number) {
  const cutoff = now - WINDOW_MS;
  for (const [key, bucket] of store) {
    while (bucket.timestamps.length && bucket.timestamps[0] <= cutoff) {
      bucket.timestamps.shift();
    }
    if (!bucket.timestamps.length) {
      store.delete(key);
    }
  }
}

const cleanupTimer = setInterval(() => {
  pruneExpired(Date.now());
}, WINDOW_MS);
cleanupTimer.unref?.();

/** 优先取底层 socket IP；仅当直连来源为可信反代时解析代理转发头中的最右侧非可信客户端 IP。 */
export function getClientIp(c: Context): string {
  let remoteIp = "";
  try {
    const conn = getConnInfo(c);
    remoteIp = conn.remote.address?.trim() || "";
  } catch {
    // 非 Bun 运行环境（如单测）忽略 connInfo 异常
  }
  if (!remoteIp) return "unknown";
  if (!isTrustedProxy(remoteIp)) return remoteIp;

  const forwarded = c.req.header("X-Forwarded-For");
  if (forwarded) {
    const parts = forwarded.split(",").map((item) => item.trim()).filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      if (!isTrustedProxy(parts[i])) return parts[i];
    }
    if (parts[0]) return parts[0];
  }
  const realIp = c.req.header("X-Real-IP")?.trim();
  if (realIp) return realIp;
  return remoteIp;
}

/** 对指定限流桶和键执行 1 分钟滑动窗口检查，超限时返回 429 响应。 */
export function checkSlidingWindowLimit(bucketName: string, key: string, limitPerMinute: number, c: Context) {
  if (limitPerMinute <= 0) return null;
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const fullKey = `${bucketName}:${key}`;

  if (store.size >= MAX_STORED_KEYS && !store.has(fullKey)) {
    pruneExpired(now);
    while (store.size >= MAX_STORED_KEYS) {
      const oldestKey = store.keys().next().value;
      if (oldestKey === undefined) break;
      store.delete(oldestKey);
    }
  }

  let bucket = store.get(fullKey);
  if (!bucket) {
    bucket = { timestamps: [] };
    store.set(fullKey, bucket);
  }
  while (bucket.timestamps.length && bucket.timestamps[0] <= cutoff) {
    bucket.timestamps.shift();
  }

  if (bucket.timestamps.length >= limitPerMinute) {
    const oldest = bucket.timestamps[0] ?? now;
    const retryAfter = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
    c.header("Retry-After", String(retryAfter));
    return c.json({ error: `操作过于频繁，请 ${retryAfter} 秒后再试` }, 429);
  }

  bucket.timestamps.push(now);
  return null;
}

/** 按 IP 限流中间件：动态读取管理员配置的速率阈值。 */
export function rateLimitByIp(
  bucketName: string,
  pickLimit: (rateLimit: AuthRateLimitPolicy) => number,
): MiddlewareHandler {
  return async (c, next) => {
    const policy = await getAuthPolicy();
    if (!policy.rateLimit.enabled) return next();
    const limit = pickLimit(policy.rateLimit);
    if (limit <= 0) return next();
    const blocked = checkSlidingWindowLimit(bucketName, getClientIp(c), limit, c);
    if (blocked) return blocked;
    return next();
  };
}

/** 按当前已认证用户 ID 与 IP 双重限流（用于兑换码核销等登录态敏感操作）。 */
export function rateLimitRedeem(): MiddlewareHandler {
  return async (c, next) => {
    const policy = await getAuthPolicy();
    if (!policy.rateLimit.enabled || policy.rateLimit.redeemPerMinute <= 0) return next();
    const limit = policy.rateLimit.redeemPerMinute;
    const user = c.get("user") as { id?: string } | undefined;
    if (user?.id) {
      const blockedByUser = checkSlidingWindowLimit("redeem:user", user.id, limit, c);
      if (blockedByUser) return blockedByUser;
    }
    const blockedByIp = checkSlidingWindowLimit("redeem:ip", getClientIp(c), limit * 2, c);
    if (blockedByIp) return blockedByIp;
    return next();
  };
}
