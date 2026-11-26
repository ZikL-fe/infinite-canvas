/** 管理后台：用户列表、详情、配额/资源包、积分、改密、WebDAV 与角色状态路由。 */
import { zValidator } from "@hono/zod-validator";
import { and, asc, count, desc, eq, ilike, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { canvasProjects, creditLedger, creditWallets, db, mediaObjects, userAssets, userSessions, userStorageGrants, users, workbenchLogs } from "../../db/index.ts";
import { adjustWalletCredits, clearWalletCredits, getWalletBalance, queryConsumptionMetrics, queryCreditLedger, roundCredits } from "../../lib/billing.ts";
import { encryptSecretValue, hashPassword } from "../../lib/crypto.ts";
import { mediaTotalBytesSql } from "../../lib/media-cleanup.ts";
import { getUserStorageQuotaSummary, getUsersStorageQuotaMap, serializeStorageGrant } from "../../lib/storage-quota.ts";
import type { AppEnv } from "../../middleware/auth.ts";

const updateUserSchema = z.object({
  role: z.enum(["admin", "user"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

const userStorageQuotaSchema = z.object({
  storageQuotaBytes: z.number().int().nonnegative(),
  storageQuotaExpiresAt: z.string().nullable().optional(),
  recalculateUsedBytes: z.boolean().optional(),
});

const userWebdavSchema = z.object({
  enabled: z.boolean(),
  url: z.string().trim().optional(),
  username: z.string().trim().optional(),
  password: z.string().optional(),
  directory: z.string().trim().optional(),
  quotaBytes: z.number().nonnegative().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  resetUsedBytes: z.boolean().optional(),
});

const adjustCreditsSchema = z
  .object({
    delta: z.number().optional(),
    clear: z.boolean().optional(),
    note: z.string().trim().max(200).optional(),
  })
  .refine(
    (data) => data.clear === true || (typeof data.delta === "number" && Number.isFinite(data.delta) && data.delta !== 0),
    "调整积分不能为 0",
  );

const updateStorageGrantSchema = z.object({
  status: z.enum(["active", "revoked"]),
});

/** 查询系统初始化时注册的首位用户（即初始管理员）ID。 */
async function getInitialAdminUserId(): Promise<string | null> {
  const firstUser = await db.query.users.findFirst({
    orderBy: [asc(users.createdAt), asc(users.id)],
    columns: { id: true },
  });
  return firstUser?.id ?? null;
}

export const adminUsersRoutes = new Hono<AppEnv>();

adminUsersRoutes.get("/users", async (c) => {
  const q = c.req.query("q")?.trim() || "";
  const role = c.req.query("role")?.trim() || "";
  const status = c.req.query("status")?.trim() || "";
  const sort = c.req.query("sort")?.trim() || "created_desc";
  const page = Math.max(1, Number(c.req.query("page") || 1));
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query("pageSize") || 20)));
  const offset = (page - 1) * pageSize;

  const filters: SQL[] = [];
  if (q) {
    const searchCond = or(
      ilike(users.id, `%${q}%`),
      ilike(users.username, `%${q}%`),
      ilike(users.displayName, `%${q}%`),
      ilike(users.email, `%${q}%`),
    );
    if (searchCond) filters.push(searchCond);
  }
  if (role === "admin" || role === "user") filters.push(eq(users.role, role));
  if (status === "active" || status === "disabled") filters.push(eq(users.status, status));
  const condition = filters.length ? and(...filters) : undefined;

  const [rows, [{ total }], initialAdminId] = await Promise.all([
    db.query.users.findMany({
      where: condition,
      orderBy: sort === "storage_desc" ? [desc(users.storageUsedBytes), desc(users.createdAt)] : [desc(users.createdAt)],
      limit: pageSize,
      offset,
      columns: {
        id: true,
        username: true,
        email: true,
        displayName: true,
        avatarUrl: true,
        role: true,
        status: true,
        storageUsedBytes: true,
        storageQuotaBytes: true,
        storageQuotaExpiresAt: true,
        webdavConfig: true,
        lastLoginAt: true,
        createdAt: true,
      },
    }),
    db.select({ total: count() }).from(users).where(condition),
    getInitialAdminUserId(),
  ]);

  const userIds = rows.map((row) => row.id);
  const [mediaCounts, projectCounts, wallets, quotaMap] = userIds.length
    ? await Promise.all([
        db
          .select({ userId: mediaObjects.userId, count: count() })
          .from(mediaObjects)
          .where(and(inArray(mediaObjects.userId, userIds), eq(mediaObjects.status, "active")))
          .groupBy(mediaObjects.userId),
        db
          .select({ userId: canvasProjects.userId, count: count() })
          .from(canvasProjects)
          .where(and(inArray(canvasProjects.userId, userIds), isNull(canvasProjects.deletedAt)))
          .groupBy(canvasProjects.userId),
        db
          .select({ userId: creditWallets.userId, balance: creditWallets.balance })
          .from(creditWallets)
          .where(inArray(creditWallets.userId, userIds)),
        getUsersStorageQuotaMap(rows),
      ])
    : [[], [], [], new Map()];

  const mediaMap = new Map(mediaCounts.map((item) => [item.userId, Number(item.count)]));
  const projectMap = new Map(projectCounts.map((item) => [item.userId, Number(item.count)]));
  const walletMap = new Map(wallets.map((item) => [item.userId, roundCredits(item.balance)]));

  return c.json({
    items: rows.map((row) => {
      const quota = quotaMap.get(row.id);
      return {
        ...row,
        isInitialAdmin: row.id === initialAdminId,
        storageQuotaBytes: quota?.storageQuotaBytes ?? row.storageQuotaBytes,
        storageQuotaExpiresAt: quota?.storageQuotaExpiresAt
          ? quota.storageQuotaExpiresAt.toISOString()
          : null,
        baseStorageQuotaBytes: quota?.baseStorageQuotaBytes ?? row.storageQuotaBytes,
        baseStorageQuotaExpiresAt: quota?.baseStorageQuotaExpiresAt
          ? quota.baseStorageQuotaExpiresAt.toISOString()
          : null,
        storageGrantsQuotaBytes: quota?.storageGrantsQuotaBytes ?? 0,
        activeGrantCount: quota?.activeGrantCount ?? 0,
        webdavConfig: row.webdavConfig
          ? {
              enabled: row.webdavConfig.enabled,
              url: row.webdavConfig.url || "",
              username: row.webdavConfig.username || "",
              directory: row.webdavConfig.directory || "",
              hasPassword: Boolean(row.webdavConfig.password),
              quotaBytes: typeof row.webdavConfig.quotaBytes === "number" && row.webdavConfig.quotaBytes > 0 ? row.webdavConfig.quotaBytes : null,
              usedBytes: Math.max(0, Number(row.webdavConfig.usedBytes ?? 0)),
              expiresAt: row.webdavConfig.expiresAt || null,
            }
          : null,
        mediaCount: mediaMap.get(row.id) ?? 0,
        projectCount: projectMap.get(row.id) ?? 0,
        creditBalance: walletMap.get(row.id) ?? 0,
      };
    }),
    total: Number(total),
    page,
    pageSize,
  });
});

adminUsersRoutes.get("/users/:id/detail", async (c) => {
  const targetId = c.req.param("id");
  const days = Number(c.req.query("days") || 7);
  const target = await db.query.users.findFirst({
    where: eq(users.id, targetId),
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
      storagePreExpiryWarnedFor: true,
      storageExpiredWarnedFor: true,
      storageCleanedAt: true,
      lowBalanceAlertEnabled: true,
      lowBalanceThreshold: true,
      lastLoginAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!target) {
    return c.json({ error: "用户不存在" }, 404);
  }

  const [
    initialAdminId,
    creditBalance,
    consumption,
    quotaSummary,
    grantRows,
    [mediaRow],
    [canvasRow],
    [assetRow],
    [imageLogRow],
    [videoLogRow],
    [rechargeRow],
    recentLedger,
    sessionRows,
  ] = await Promise.all([
    getInitialAdminUserId(),
    getWalletBalance(targetId),
    queryConsumptionMetrics(days, targetId),
    getUserStorageQuotaSummary(target),
    db.query.userStorageGrants.findMany({
      where: eq(userStorageGrants.userId, targetId),
      orderBy: [desc(userStorageGrants.createdAt)],
    }),
    db
      .select({ count: count() })
      .from(mediaObjects)
      .where(and(eq(mediaObjects.userId, targetId), eq(mediaObjects.status, "active"))),
    db
      .select({ count: count() })
      .from(canvasProjects)
      .where(and(eq(canvasProjects.userId, targetId), isNull(canvasProjects.deletedAt))),
    db
      .select({ count: count() })
      .from(userAssets)
      .where(and(eq(userAssets.userId, targetId), isNull(userAssets.deletedAt))),
    db
      .select({ count: count() })
      .from(workbenchLogs)
      .where(and(eq(workbenchLogs.userId, targetId), eq(workbenchLogs.kind, "image"), isNull(workbenchLogs.deletedAt))),
    db
      .select({ count: count() })
      .from(workbenchLogs)
      .where(and(eq(workbenchLogs.userId, targetId), eq(workbenchLogs.kind, "video"), isNull(workbenchLogs.deletedAt))),
    db
      .select({
        total: sql<number>`COALESCE(SUM(CASE WHEN ${creditLedger.delta} > 0 THEN ${creditLedger.delta} ELSE 0 END), 0)::double precision`,
      })
      .from(creditLedger)
      .where(and(eq(creditLedger.userId, targetId), inArray(creditLedger.reason, ["redeem_code", "admin_adjust", "plan_grant"]))),
    queryCreditLedger({ userId: targetId, category: "recharge", page: 1, pageSize: 100 }),
    db.query.userSessions.findMany({
      where: eq(userSessions.userId, targetId),
      orderBy: [desc(userSessions.createdAt)],
      limit: 10,
      columns: {
        id: true,
        userAgent: true,
        ip: true,
        expiresAt: true,
        revokedAt: true,
        createdAt: true,
      },
    }),
  ]);

  const now = new Date();
  return c.json({
    user: {
      ...target,
      isInitialAdmin: target.id === initialAdminId,
      creditBalance,
      storageQuotaBytes: quotaSummary.storageQuotaBytes,
      storageQuotaExpiresAt: quotaSummary.storageQuotaExpiresAt ? quotaSummary.storageQuotaExpiresAt.toISOString() : null,
      baseStorageQuotaBytes: quotaSummary.baseStorageQuotaBytes,
      baseStorageQuotaExpiresAt: quotaSummary.baseStorageQuotaExpiresAt ? quotaSummary.baseStorageQuotaExpiresAt.toISOString() : null,
      storageGrantsQuotaBytes: quotaSummary.storageGrantsQuotaBytes,
      activeGrantCount: quotaSummary.activeGrantCount,
      emailVerifiedAt: target.emailVerifiedAt ? target.emailVerifiedAt.toISOString() : null,
      storagePreExpiryWarnedFor: target.storagePreExpiryWarnedFor ? target.storagePreExpiryWarnedFor.toISOString() : null,
      storageExpiredWarnedFor: target.storageExpiredWarnedFor ? target.storageExpiredWarnedFor.toISOString() : null,
      storageCleanedAt: target.storageCleanedAt ? target.storageCleanedAt.toISOString() : null,
      lastLoginAt: target.lastLoginAt ? target.lastLoginAt.toISOString() : null,
      createdAt: target.createdAt.toISOString(),
      updatedAt: target.updatedAt.toISOString(),
    },
    stats: {
      totalRechargedCredits: roundCredits(Number(rechargeRow?.total ?? 0)),
      activeMediaCount: Number(mediaRow?.count ?? 0),
      canvasProjectCount: Number(canvasRow?.count ?? 0),
      assetCount: Number(assetRow?.count ?? 0),
      imageLogCount: Number(imageLogRow?.count ?? 0),
      videoLogCount: Number(videoLogRow?.count ?? 0),
      activeSessionCount: sessionRows.filter((s) => !s.revokedAt && s.expiresAt.getTime() > now.getTime()).length,
    },
    consumption,
    grants: grantRows.map((grant) => serializeStorageGrant(grant, now.getTime())),
    recentLogs: recentLedger.items,
    sessions: sessionRows.map((s) => ({
      id: s.id,
      userAgent: s.userAgent,
      ipAddress: s.ip,
      expiresAt: s.expiresAt.toISOString(),
      revokedAt: s.revokedAt ? s.revokedAt.toISOString() : null,
      createdAt: s.createdAt.toISOString(),
      active: !s.revokedAt && s.expiresAt.getTime() > now.getTime(),
    })),
  });
});

adminUsersRoutes.post("/users/:id/credits", zValidator("json", adjustCreditsSchema), async (c) => {
  const targetId = c.req.param("id");
  const body = c.req.valid("json");
  const target = await db.query.users.findFirst({ where: eq(users.id, targetId), columns: { id: true } });
  if (!target) {
    return c.json({ error: "用户不存在" }, 404);
  }
  if (body.clear) {
    const result = await clearWalletCredits({
      userId: targetId,
      reason: "admin_adjust",
      meta: { adminId: c.get("user").id, note: body.note || "管理员清零积分", action: "clear" },
    });
    return c.json({ ok: true, balance: result.balance });
  }
  const result = await adjustWalletCredits({
    userId: targetId,
    delta: body.delta!,
    reason: "admin_adjust",
    allowNegative: true,
    meta: { adminId: c.get("user").id, note: body.note || "" },
  });
  return c.json({ ok: true, balance: result.balance });
});

const resetUserPasswordSchema = z.object({
  newPassword: z.string().min(6, "新密码至少 6 位").max(128, "密码过长"),
  revokeSessions: z.boolean().optional().default(true),
});

adminUsersRoutes.post("/users/:id/password", zValidator("json", resetUserPasswordSchema), async (c) => {
  const currentAdmin = c.get("user");
  const targetId = c.req.param("id");
  const body = c.req.valid("json");
  const target = await db.query.users.findFirst({ where: eq(users.id, targetId), columns: { id: true } });
  if (!target) {
    return c.json({ error: "用户不存在" }, 404);
  }
  const initialAdminId = await getInitialAdminUserId();
  if (targetId === initialAdminId && currentAdmin.id !== initialAdminId) {
    return c.json({ error: "仅系统初始管理员本人可修改该账号密码" }, 403);
  }
  const nextHash = await hashPassword(body.newPassword);
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash: nextHash, updatedAt: now }).where(eq(users.id, targetId));
    if (body.revokeSessions) {
      await tx
        .update(userSessions)
        .set({ revokedAt: now })
        .where(and(eq(userSessions.userId, targetId), isNull(userSessions.revokedAt)));
    }
  });
  return c.json({ ok: true });
});

adminUsersRoutes.put("/users/:id/storage-quota", zValidator("json", userStorageQuotaSchema), async (c) => {
  const targetId = c.req.param("id");
  const body = c.req.valid("json");
  const target = await db.query.users.findFirst({ where: eq(users.id, targetId) });
  if (!target) {
    return c.json({ error: "用户不存在" }, 404);
  }

  const parsedExpiresAt = body.storageQuotaExpiresAt ? new Date(body.storageQuotaExpiresAt) : null;
  if (parsedExpiresAt && Number.isNaN(parsedExpiresAt.getTime())) {
    return c.json({ error: "有效期限格式无效" }, 400);
  }

  let storageUsedBytes = target.storageUsedBytes;
  if (body.recalculateUsedBytes) {
    const [mediaSum] = await db
      .select({
        bytes: sql<number>`COALESCE(SUM(${mediaTotalBytesSql}), 0)::bigint`,
      })
      .from(mediaObjects)
      .where(and(eq(mediaObjects.userId, targetId), eq(mediaObjects.status, "active")));
    storageUsedBytes = Number(mediaSum?.bytes ?? 0);
  }

  const baseQuotaBytes = Math.max(0, Math.round(body.storageQuotaBytes));
  await db
    .update(users)
    .set({
      storageQuotaBytes: baseQuotaBytes,
      storageQuotaExpiresAt: parsedExpiresAt,
      storageUsedBytes,
      updatedAt: new Date(),
    })
    .where(eq(users.id, targetId));

  const summary = await getUserStorageQuotaSummary({
    id: targetId,
    storageQuotaBytes: baseQuotaBytes,
    storageQuotaExpiresAt: parsedExpiresAt,
  });

  return c.json({
    ok: true,
    storageQuotaBytes: summary.storageQuotaBytes,
    storageQuotaExpiresAt: summary.storageQuotaExpiresAt ? summary.storageQuotaExpiresAt.toISOString() : null,
    baseStorageQuotaBytes: summary.baseStorageQuotaBytes,
    baseStorageQuotaExpiresAt: summary.baseStorageQuotaExpiresAt ? summary.baseStorageQuotaExpiresAt.toISOString() : null,
    storageGrantsQuotaBytes: summary.storageGrantsQuotaBytes,
    storageUsedBytes,
  });
});

adminUsersRoutes.get("/users/:id/storage-grants", async (c) => {
  const targetId = c.req.param("id");
  const target = await db.query.users.findFirst({
    where: eq(users.id, targetId),
    columns: { id: true, storageUsedBytes: true, storageQuotaBytes: true, storageQuotaExpiresAt: true },
  });
  if (!target) {
    return c.json({ error: "用户不存在" }, 404);
  }
  const summary = await getUserStorageQuotaSummary(target);
  return c.json({
    storageUsedBytes: target.storageUsedBytes,
    storageQuotaBytes: summary.storageQuotaBytes,
    storageQuotaExpiresAt: summary.storageQuotaExpiresAt ? summary.storageQuotaExpiresAt.toISOString() : null,
    baseStorageQuotaBytes: summary.baseStorageQuotaBytes,
    baseStorageQuotaExpiresAt: summary.baseStorageQuotaExpiresAt ? summary.baseStorageQuotaExpiresAt.toISOString() : null,
    storageGrantsQuotaBytes: summary.storageGrantsQuotaBytes,
    grants: summary.grants.map((grant) => serializeStorageGrant(grant)),
  });
});

adminUsersRoutes.patch("/storage-grants/:grantId", zValidator("json", updateStorageGrantSchema), async (c) => {
  const grantId = c.req.param("grantId");
  const { status } = c.req.valid("json");
  const [updated] = await db
    .update(userStorageGrants)
    .set({ status })
    .where(eq(userStorageGrants.id, grantId))
    .returning();
  if (!updated) {
    return c.json({ error: "存储资源包记录不存在" }, 404);
  }
  return c.json({ ok: true, grant: serializeStorageGrant(updated) });
});


adminUsersRoutes.put("/users/:id/webdav", zValidator("json", userWebdavSchema), async (c) => {
  const targetId = c.req.param("id");
  const body = c.req.valid("json");
  const target = await db.query.users.findFirst({ where: eq(users.id, targetId) });
  if (!target) {
    return c.json({ error: "用户不存在" }, 404);
  }

  const prev = target.webdavConfig;
  const parsedExpiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  const expiresAt = parsedExpiresAt && !Number.isNaN(parsedExpiresAt.getTime()) ? parsedExpiresAt.toISOString() : null;
  const quotaBytes = typeof body.quotaBytes === "number" && body.quotaBytes > 0 ? Math.round(body.quotaBytes) : null;
  const usedBytes = body.resetUsedBytes ? 0 : Math.max(0, Number(prev?.usedBytes ?? 0));
  const nextConfig = {
    enabled: body.enabled,
    ...(body.url ? { url: body.url.replace(/\/+$/, "") } : {}),
    ...(body.username ? { username: body.username } : {}),
    ...(body.password?.trim()
      ? { password: encryptSecretValue(body.password.trim()) }
      : prev?.password && body.password === undefined
        ? { password: prev.password }
        : {}),
    ...(body.directory ? { directory: body.directory.replace(/^\/+|\/+$/g, "") } : {}),
    quotaBytes,
    usedBytes,
    expiresAt,
  };

  await db.update(users).set({ webdavConfig: nextConfig, updatedAt: new Date() }).where(eq(users.id, targetId));
  return c.json({
    ok: true,
    webdavConfig: {
      enabled: nextConfig.enabled,
      url: nextConfig.url || "",
      username: nextConfig.username || "",
      directory: nextConfig.directory || "",
      hasPassword: Boolean(nextConfig.password),
      quotaBytes: nextConfig.quotaBytes,
      usedBytes: nextConfig.usedBytes,
      expiresAt: nextConfig.expiresAt,
    },
  });
});

adminUsersRoutes.patch("/users/:id", zValidator("json", updateUserSchema), async (c) => {
  const currentAdmin = c.get("user");
  const targetId = c.req.param("id");
  const body = c.req.valid("json");

  const target = await db.query.users.findFirst({ where: eq(users.id, targetId) });
  if (!target) {
    return c.json({ error: "用户不存在" }, 404);
  }

  if (targetId === currentAdmin.id && body.status === "disabled") {
    return c.json({ error: "不能禁用当前登录的管理员账号" }, 400);
  }

  const nextRole = body.role ?? target.role;
  const nextStatus = body.status ?? target.status;

  const initialAdminId = await getInitialAdminUserId();
  if (targetId === initialAdminId) {
    if (nextRole !== "admin") {
      return c.json({ error: "系统初始管理员不可降级" }, 400);
    }
    if (nextStatus === "disabled") {
      return c.json({ error: "系统初始管理员不可禁用" }, 400);
    }
  }

  const txResult = await db.transaction(async (tx) => {
    if (target.role === "admin" && target.status === "active" && (nextRole !== "admin" || nextStatus !== "active")) {
      const lockedAdmins = await tx.execute(
        sql`SELECT id FROM users WHERE role = 'admin' AND status = 'active' FOR UPDATE`,
      );
      const otherAdmins = lockedAdmins.filter((row) => (row as { id?: string }).id !== targetId).length;
      if (otherAdmins === 0) {
        return { error: "系统至少需要保留一名可用管理员" as const };
      }
    }

    const [updated] = await tx
      .update(users)
      .set({ role: nextRole, status: nextStatus, updatedAt: new Date() })
      .where(eq(users.id, targetId))
      .returning({
        id: users.id,
        username: users.username,
        email: users.email,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        role: users.role,
        status: users.status,
        storageUsedBytes: users.storageUsedBytes,
        storageQuotaBytes: users.storageQuotaBytes,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      });

    if (nextStatus === "disabled") {
      await tx.update(userSessions).set({ revokedAt: new Date() }).where(eq(userSessions.userId, targetId));
    }

    return { updated };
  });

  if ("error" in txResult) {
    return c.json({ error: txResult.error }, 400);
  }

  return c.json({ user: txResult.updated });
});

