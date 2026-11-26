/** Hono 认证与管理员鉴权中间件。 */
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";

import { db, users, type UserRole, type UserStatus } from "../db/index.ts";
import { verifyAccessToken } from "../lib/jwt.ts";
import { getUserQuotaAlertMeta, getUserStorageQuotaSummary, type UserQuotaAlertMeta } from "../lib/storage-quota.ts";

export type AuthUser = UserQuotaAlertMeta & {
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
  createdAt: Date;
};

export type AppEnv = {
  Variables: {
    user: AuthUser;
  };
};

/** 校验 Bearer 访问令牌并从数据库核实用户启用状态，通过后注入轻量上下文 `user`（高频同步接口不查存储包表）。 */
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

  c.set("user", {
    ...user,
    baseStorageQuotaBytes: user.storageQuotaBytes,
    baseStorageQuotaExpiresAt: user.storageQuotaExpiresAt,
    lowBalanceThreshold: user.lowBalanceThreshold ?? 0,
    storageWarningDays: 0,
    storageExpiringAt: null,
    storageExpiringBytes: 0,
    storageRemainingAfterExpiryBytes: null,
    storageExpiringWillExceed: false,
    storagePermanentBytes: user.storageQuotaExpiresAt ? 0 : user.storageQuotaBytes,
    storageTimedBytes: user.storageQuotaExpiresAt ? user.storageQuotaBytes : 0,
    storageTimedExpiresAt: user.storageQuotaExpiresAt ? user.storageQuotaExpiresAt.toISOString() : null,
  });
  await next();
};

/** 在 `requireAuth` 基础上按需聚合用户存储资源包有效配额与余额/到期预警信息（仅挂载在存储与个人中心等需要的路由）。 */
export const requireAuthWithQuota: MiddlewareHandler<AppEnv> = async (c, next) => {
  let authed = false;
  const res = await requireAuth(c, async () => {
    authed = true;
    const baseUser = c.get("user");
    const quotaSummary = await getUserStorageQuotaSummary({
      id: baseUser.id,
      storageQuotaBytes: baseUser.baseStorageQuotaBytes,
      storageQuotaExpiresAt: baseUser.baseStorageQuotaExpiresAt,
    });
    const alertMeta = await getUserQuotaAlertMeta({
      lowBalanceThreshold: baseUser.lowBalanceThreshold || null,
      storageUsedBytes: baseUser.storageUsedBytes,
      baseStorageQuotaBytes: quotaSummary.baseStorageQuotaBytes,
      baseStorageQuotaExpiresAt: quotaSummary.baseStorageQuotaExpiresAt,
      grants: quotaSummary.grants,
    });
    c.set("user", {
      ...baseUser,
      storageQuotaBytes: quotaSummary.storageQuotaBytes,
      storageQuotaExpiresAt: quotaSummary.storageQuotaExpiresAt,
      baseStorageQuotaBytes: quotaSummary.baseStorageQuotaBytes,
      baseStorageQuotaExpiresAt: quotaSummary.baseStorageQuotaExpiresAt,
      ...alertMeta,
    });
    await next();
  });
  if (!authed) return res;
};

/** 要求当前已认证用户具备管理员（admin）角色。 */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  if (!user || user.role !== "admin") {
    return c.json({ error: "需要管理员权限" }, 403);
  }
  await next();
};
