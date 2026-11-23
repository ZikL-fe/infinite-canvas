/** 当前登录用户的个人后台接口：概览统计、资料维护、修改密码与登录设备会话管理。 */
import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { announcements, canvasProjects, db, mediaObjects, userAssets, userSessions, users } from "../db/index.ts";
import { getWalletBalance, queryConsumptionMetrics } from "../lib/billing.ts";
import { hashPassword, sha256Hex, verifyPassword } from "../lib/crypto.ts";
import { getPlatformWebdavConfig, resolveEffectiveUserWebdav } from "../lib/settings.ts";
import { requireAuth, type AppEnv } from "../middleware/auth.ts";

const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1, "显示名称不能为空").max(48, "显示名称最多 48 个字符").optional(),
  email: z.string().trim().email("邮箱格式不正确").optional().or(z.literal("")),
  avatarUrl: z.string().trim().max(500, "头像链接过长").optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "请输入当前密码"),
  newPassword: z.string().min(6, "新密码至少 6 位").max(128, "密码过长"),
  revokeOtherSessions: z.boolean().optional().default(true),
  currentRefreshToken: z.string().optional(),
});

const revokeOthersSchema = z.object({
  currentRefreshToken: z.string().optional(),
});

export const accountRoutes = new Hono<AppEnv>();

accountRoutes.use("*", requireAuth);

accountRoutes.get("/overview", async (c) => {
  const authUser = c.get("user");
  const days = Number(c.req.query("days") || 7);

  const [creditBalance, consumption, announcementList, userRow, [projectStats], [assetStats]] = await Promise.all([
    getWalletBalance(authUser.id),
    queryConsumptionMetrics(days, authUser.id),
    db.query.announcements.findMany({
      where: eq(announcements.isPublished, true),
      orderBy: [desc(announcements.isPinned), desc(announcements.createdAt)],
      limit: 10,
    }),
    db.query.users.findFirst({
      where: eq(users.id, authUser.id),
      columns: { storageUsedBytes: true },
    }),
    db
      .select({ count: count() })
      .from(canvasProjects)
      .where(and(eq(canvasProjects.userId, authUser.id), isNull(canvasProjects.deletedAt))),
    db
      .select({ count: count() })
      .from(userAssets)
      .where(and(eq(userAssets.userId, authUser.id), isNull(userAssets.deletedAt))),
  ]);

  return c.json({
    creditBalance,
    storageUsedBytes: userRow?.storageUsedBytes ?? 0,
    canvasProjectCount: Number(projectStats?.count ?? 0),
    assetCount: Number(assetStats?.count ?? 0),
    ...consumption,
    announcements: announcementList,
  });
});

accountRoutes.get("/profile", async (c) => {
  const authUser = c.get("user");
  const [userRow, creditBalance, [projectStats], [assetStats], mediaByKind, platformWebdav] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, authUser.id) }),
    getWalletBalance(authUser.id),
    db
      .select({ count: count() })
      .from(canvasProjects)
      .where(and(eq(canvasProjects.userId, authUser.id), isNull(canvasProjects.deletedAt))),
    db
      .select({ count: count() })
      .from(userAssets)
      .where(and(eq(userAssets.userId, authUser.id), isNull(userAssets.deletedAt))),
    db
      .select({
        kind: mediaObjects.kind,
        count: count(),
        bytes: sql<number>`COALESCE(SUM(${mediaObjects.bytes}), 0)::bigint`,
      })
      .from(mediaObjects)
      .where(and(eq(mediaObjects.userId, authUser.id), eq(mediaObjects.status, "active")))
      .groupBy(mediaObjects.kind),
    getPlatformWebdavConfig(),
  ]);

  if (!userRow) {
    return c.json({ error: "账号不存在" }, 404);
  }

  const effectiveWebdav = resolveEffectiveUserWebdav(platformWebdav, userRow.webdavConfig);

  return c.json({
    user: {
      id: userRow.id,
      username: userRow.username,
      email: userRow.email,
      displayName: userRow.displayName,
      avatarUrl: userRow.avatarUrl,
      role: userRow.role,
      status: userRow.status,
      storageUsedBytes: userRow.storageUsedBytes,
      creditBalance,
      lastLoginAt: userRow.lastLoginAt,
      createdAt: userRow.createdAt,
    },
    stats: {
      canvasProjectCount: Number(projectStats?.count ?? 0),
      assetCount: Number(assetStats?.count ?? 0),
      mediaByKind: mediaByKind.map((row) => ({
        kind: row.kind,
        count: Number(row.count),
        bytes: Number(row.bytes),
      })),
    },
    webdav: effectiveWebdav
      ? {
          enabled: true,
          url: effectiveWebdav.url,
          username: effectiveWebdav.username,
          directory: effectiveWebdav.directory,
          quotaBytes: effectiveWebdav.quotaBytes,
          usedBytes: effectiveWebdav.usedBytes,
          expiresAt: effectiveWebdav.expiresAt,
          isExpired: effectiveWebdav.isExpired,
          isQuotaExceeded: effectiveWebdav.isQuotaExceeded,
        }
      : null,
  });
});

accountRoutes.patch("/profile", zValidator("json", updateProfileSchema), async (c) => {
  const authUser = c.get("user");
  const body = c.req.valid("json");
  const nextEmail = body.email !== undefined ? (body.email ? body.email.toLowerCase() : null) : undefined;

  if (nextEmail) {
    const conflict = await db.query.users.findFirst({
      where: and(eq(users.email, nextEmail), ne(users.id, authUser.id)),
      columns: { id: true },
    });
    if (conflict) {
      return c.json({ error: "该邮箱已被其他账号使用" }, 409);
    }
  }

  const [updated] = await db
    .update(users)
    .set({
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(nextEmail !== undefined ? { email: nextEmail } : {}),
      ...(body.avatarUrl !== undefined ? { avatarUrl: body.avatarUrl } : {}),
      updatedAt: new Date(),
    })
    .where(eq(users.id, authUser.id))
    .returning();

  const creditBalance = await getWalletBalance(authUser.id);

  return c.json({
    user: {
      id: updated.id,
      username: updated.username,
      email: updated.email,
      displayName: updated.displayName,
      avatarUrl: updated.avatarUrl,
      role: updated.role,
      status: updated.status,
      storageUsedBytes: updated.storageUsedBytes,
      creditBalance,
      lastLoginAt: updated.lastLoginAt,
      createdAt: updated.createdAt,
    },
  });
});

accountRoutes.post("/change-password", zValidator("json", changePasswordSchema), async (c) => {
  const authUser = c.get("user");
  const body = c.req.valid("json");
  const row = await db.query.users.findFirst({ where: eq(users.id, authUser.id) });
  if (!row) return c.json({ error: "账号不存在" }, 404);

  const valid = await verifyPassword(body.currentPassword, row.passwordHash);
  if (!valid) {
    return c.json({ error: "当前密码不正确" }, 400);
  }

  const nextHash = await hashPassword(body.newPassword);
  await db.update(users).set({ passwordHash: nextHash, updatedAt: new Date() }).where(eq(users.id, authUser.id));

  if (body.revokeOtherSessions) {
    const currentHash = body.currentRefreshToken ? sha256Hex(body.currentRefreshToken) : "";
    await db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(
        currentHash
          ? and(eq(userSessions.userId, authUser.id), isNull(userSessions.revokedAt), ne(userSessions.refreshTokenHash, currentHash))
          : and(eq(userSessions.userId, authUser.id), isNull(userSessions.revokedAt)),
      );
  }

  return c.json({ ok: true });
});

accountRoutes.get("/sessions", async (c) => {
  const authUser = c.get("user");
  const currentToken = c.req.header("X-Refresh-Token") || "";
  const currentHash = currentToken ? sha256Hex(currentToken) : "";

  const rows = await db.query.userSessions.findMany({
    where: and(eq(userSessions.userId, authUser.id), isNull(userSessions.revokedAt), gt(userSessions.expiresAt, new Date())),
    orderBy: [desc(userSessions.createdAt)],
    limit: 30,
  });

  return c.json({
    items: rows.map((row) => ({
      id: row.id,
      userAgent: row.userAgent,
      ip: row.ip,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      isCurrent: Boolean(currentHash && row.refreshTokenHash === currentHash),
    })),
  });
});

accountRoutes.delete("/sessions/:id", async (c) => {
  const authUser = c.get("user");
  const id = c.req.param("id");
  const [updated] = await db
    .update(userSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(userSessions.id, id), eq(userSessions.userId, authUser.id)))
    .returning({ id: true });
  if (!updated) return c.json({ error: "会话不存在" }, 404);
  return c.json({ ok: true });
});

accountRoutes.post("/sessions/revoke-others", zValidator("json", revokeOthersSchema), async (c) => {
  const authUser = c.get("user");
  const { currentRefreshToken } = c.req.valid("json");
  const currentHash = currentRefreshToken ? sha256Hex(currentRefreshToken) : "";

  await db
    .update(userSessions)
    .set({ revokedAt: new Date() })
    .where(
      currentHash
        ? and(eq(userSessions.userId, authUser.id), isNull(userSessions.revokedAt), ne(userSessions.refreshTokenHash, currentHash))
        : and(eq(userSessions.userId, authUser.id), isNull(userSessions.revokedAt)),
    );

  return c.json({ ok: true });
});
