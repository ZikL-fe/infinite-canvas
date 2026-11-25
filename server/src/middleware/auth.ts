/** Hono 认证与管理员鉴权中间件。 */
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";

import { db, users, type UserRole, type UserStatus } from "../db/index.ts";
import { verifyAccessToken } from "../lib/jwt.ts";
import { getUserQuotaAlertMeta, getUserStorageQuotaSummary } from "../lib/storage-quota.ts";

export type AuthUser = {
  id: string;
  username: string;
  email: string | null;
  emailVerifiedAt: Date | null;
  displayName: string;
  avatarUrl: string;
  role: UserRole;
  status: UserStatus;
  storageUsedBytes: number;
  storageQuotaBytes: number;
  storageQuotaExpiresAt: Date | null;
  baseStorageQuotaBytes: number;
  baseStorageQuotaExpiresAt: Date | null;
  lowBalanceThreshold: number;
  storageWarningDays: number;
  storageExpiringAt: string | null;
  createdAt: Date;
};

export type AppEnv = {
  Variables: {
    user: AuthUser;
  };
};

/** 校验 Bearer 访问令牌并从数据库核实用户启用状态，通过后注入上下文 `user`。 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) {
    return c.json({ error: "请先登录" }, 401);
  }

  let userId = "";
  try {
    const payload = await verifyAccessToken(token);
    userId = payload.sub;
  } catch {
    return c.json({ error: "登录已过期，请重新登录" }, 401);
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: {
      id: true,
      username: true,
      email: true,
      emailVerifiedAt: true,
      displayName: true,
      avatarUrl: true,
      role: true,
      status: true,
      storageUsedBytes: true,
      storageQuotaBytes: true,
      storageQuotaExpiresAt: true,
      lowBalanceThreshold: true,
      createdAt: true,
    },
  });

  if (!user) {
    return c.json({ error: "账号不存在" }, 401);
  }
  if (user.status !== "active") {
    return c.json({ error: "当前账号已被禁用，请联系管理员" }, 403);
  }

  const quotaSummary = await getUserStorageQuotaSummary(user);
  const alertMeta = await getUserQuotaAlertMeta({
    lowBalanceThreshold: user.lowBalanceThreshold,
    storageUsedBytes: user.storageUsedBytes,
    baseStorageQuotaBytes: quotaSummary.baseStorageQuotaBytes,
    baseStorageQuotaExpiresAt: quotaSummary.baseStorageQuotaExpiresAt,
    grants: quotaSummary.grants,
  });
  c.set("user", {
    ...user,
    storageQuotaBytes: quotaSummary.storageQuotaBytes,
    storageQuotaExpiresAt: quotaSummary.storageQuotaExpiresAt,
    baseStorageQuotaBytes: quotaSummary.baseStorageQuotaBytes,
    baseStorageQuotaExpiresAt: quotaSummary.baseStorageQuotaExpiresAt,
    ...alertMeta,
  });
  await next();
};

/** 要求当前已认证用户具备管理员（admin）角色。 */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  if (!user || user.role !== "admin") {
    return c.json({ error: "需要管理员权限" }, 403);
  }
  await next();
};
