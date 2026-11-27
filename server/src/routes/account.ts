/** 当前登录用户的个人后台接口：概览统计、资料维护、修改密码与登录设备会话管理。 */
import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { announcements, canvasProjects, db, mediaObjects, userAssets, userSessions, users } from "../db/index.ts";
import { normalizeDashboardRange, queryAnalyticsDashboard } from "../lib/analytics.ts";
import { getWalletBalance, queryConsumptionMetrics } from "../lib/billing.ts";
import { hashPassword, sha256Hex, verifyPassword } from "../lib/crypto.ts";
import { issueEmailVerificationCode, verifyAndConsumeEmailCode } from "../lib/email-verification.ts";
import { queryUserInviteSummary } from "../lib/invite.ts";
import { isMailConfigReady } from "../lib/mail.ts";
import { mediaTotalBytesSql } from "../lib/media-cleanup.ts";
import { rateLimitByIp } from "../lib/rate-limit.ts";
import { getAuthPolicy, getPlatformMailConfig, getPlatformWebdavConfig, resolveEffectiveUserWebdav } from "../lib/settings.ts";
import { getUserQuotaAlertMeta, getUserStorageQuotaSummary, serializeStorageGrant } from "../lib/storage-quota.ts";
import { requireAuthWithQuota, type AppEnv } from "../middleware/auth.ts";

const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1, "显示名称不能为空").max(48, "显示名称最多 48 个字符").optional(),
  email: z.string().trim().email("邮箱格式不正确").optional().or(z.literal("")),
  emailCode: z.string().trim().optional().or(z.literal("")),
  avatarUrl: z.string().trim().max(500, "头像链接过长").optional(),
  lowBalanceAlertEnabled: z.boolean().nullable().optional(),
  lowBalanceThreshold: z.number().nonnegative("提醒阈值不能小于 0").max(1_000_000).nullable().optional(),
});

const sendBindEmailCodeSchema = z.object({
  email: z.string().trim().email("邮箱格式不正确"),
});

const changePasswordSchema = z
  .object({
    mode: z.enum(["password", "email"]).optional().default("password"),
    currentPassword: z.string().optional().default(""),
    emailCode: z.string().trim().optional().default(""),
    newPassword: z.string().min(6, "新密码至少 6 位").max(128, "密码过长"),
    revokeOtherSessions: z.boolean().optional().default(true),
    currentRefreshToken: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.mode === "password" && !data.currentPassword) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["currentPassword"], message: "请输入当前密码" });
    }
    if (data.mode === "email" && !data.emailCode) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["emailCode"], message: "请输入邮箱验证码" });
    }
  });

const revokeOthersSchema = z.object({
  currentRefreshToken: z.string().optional(),
});

export const accountRoutes = new Hono<AppEnv>();

accountRoutes.use("*", requireAuthWithQuota);

accountRoutes.get("/overview", async (c) => {
  const authUser = c.get("user");
  const days = Number(c.req.query("days") || 7);

  const [creditBalance, consumption, announcementList, [projectStats], [assetStats]] = await Promise.all([
    getWalletBalance(authUser.id),
    queryConsumptionMetrics(days, authUser.id),
    db.query.announcements.findMany({
      where: eq(announcements.isPublished, true),
      orderBy: [desc(announcements.isPinned), desc(announcements.createdAt)],
      limit: 10,
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
    lowBalanceThreshold: authUser.lowBalanceThreshold,
    storageUsedBytes: authUser.storageUsedBytes ?? 0,
    storageQuotaBytes: authUser.storageQuotaBytes ?? 0,
    storageQuotaExpiresAt: authUser.storageQuotaExpiresAt ? authUser.storageQuotaExpiresAt.toISOString() : null,
    storageWarningDays: authUser.storageWarningDays,
    storageExpiringAt: authUser.storageExpiringAt,
    storageExpiringBytes: authUser.storageExpiringBytes,
    storageRemainingAfterExpiryBytes: authUser.storageRemainingAfterExpiryBytes,
    storageExpiringWillExceed: authUser.storageExpiringWillExceed,
    storagePermanentBytes: authUser.storagePermanentBytes,
    storageTimedBytes: authUser.storageTimedBytes,
    storageTimedExpiresAt: authUser.storageTimedExpiresAt,
    canvasProjectCount: Number(projectStats?.count ?? 0),
    assetCount: Number(assetStats?.count ?? 0),
    ...consumption,
    announcements: announcementList,
  });
});

accountRoutes.get("/dashboard", async (c) => {
  const authUser = c.get("user");
  const range = normalizeDashboardRange(c.req.query("range"));
  const force = c.req.query("force") === "1" || c.req.query("force") === "true";
  const dashboard = await queryAnalyticsDashboard({ range, userId: authUser.id, force });
  return c.json(dashboard);
});

accountRoutes.get("/invites", async (c) => {
  const authUser = c.get("user");
  const page = Number(c.req.query("page") || 1);
  const pageSize = Number(c.req.query("pageSize") || 20);
  const summary = await queryUserInviteSummary(authUser.id, page, pageSize);
  return c.json(summary);
});

accountRoutes.get("/profile", async (c) => {
  const authUser = c.get("user");
  const [userRow, creditBalance, [projectStats], [assetStats], mediaByKind, platformWebdav, mailConfig, authPolicy] = await Promise.all([
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
        bytes: sql<number>`COALESCE(SUM(${mediaTotalBytesSql}), 0)::bigint`,
      })
      .from(mediaObjects)
      .where(and(eq(mediaObjects.userId, authUser.id), eq(mediaObjects.status, "active")))
      .groupBy(mediaObjects.kind),
    getPlatformWebdavConfig(),
    getPlatformMailConfig(),
    getAuthPolicy(),
  ]);

  if (!userRow) {
    return c.json({ error: "账号不存在" }, 404);
  }

  const quotaSummary = await getUserStorageQuotaSummary(userRow);
  const alertMeta = await getUserQuotaAlertMeta({
    lowBalanceThreshold: userRow.lowBalanceThreshold,
    storageUsedBytes: userRow.storageUsedBytes,
    baseStorageQuotaBytes: quotaSummary.baseStorageQuotaBytes,
    baseStorageQuotaExpiresAt: quotaSummary.baseStorageQuotaExpiresAt,
    grants: quotaSummary.grants,
  });
  const effectiveWebdav = authUser.role === "admin" ? resolveEffectiveUserWebdav(platformWebdav, userRow.webdavConfig) : null;
  const emailServiceEnabled = isMailConfigReady(mailConfig);

  return c.json({
    user: {
      id: userRow.id,
      username: userRow.username,
      email: userRow.email,
      emailVerifiedAt: userRow.emailVerifiedAt ? userRow.emailVerifiedAt.toISOString() : null,
      displayName: userRow.displayName,
      avatarUrl: userRow.avatarUrl,
      role: userRow.role,
      status: userRow.status,
      storageUsedBytes: userRow.storageUsedBytes,
      storageQuotaBytes: quotaSummary.storageQuotaBytes,
      storageQuotaExpiresAt: quotaSummary.storageQuotaExpiresAt ? quotaSummary.storageQuotaExpiresAt.toISOString() : null,
      ...alertMeta,
      creditBalance,
      lastLoginAt: userRow.lastLoginAt,
      createdAt: userRow.createdAt,
    },
    emailServiceEnabled,
    requireEmailOnRegister: emailServiceEnabled ? authPolicy.requireEmailOnRegister : false,
    lowBalanceAlert: {
      enabled: userRow.lowBalanceAlertEnabled ?? null,
      threshold: userRow.lowBalanceThreshold ?? null,
      effectiveEnabled: userRow.lowBalanceAlertEnabled ?? mailConfig.lowBalanceAlertEnabled,
      effectiveThreshold: userRow.lowBalanceThreshold ?? mailConfig.lowBalanceThreshold,
      platformEnabled: mailConfig.lowBalanceAlertEnabled,
      platformThreshold: mailConfig.lowBalanceThreshold,
      cooldownHours: mailConfig.lowBalanceCooldownHours,
      lastAlertedAt: userRow.lowBalanceAlertedAt ? userRow.lowBalanceAlertedAt.toISOString() : null,
    },
    storageQuotaDetail: {
      baseQuotaBytes: quotaSummary.baseStorageQuotaBytes,
      baseExpiresAt: quotaSummary.baseStorageQuotaExpiresAt ? quotaSummary.baseStorageQuotaExpiresAt.toISOString() : null,
      grantsQuotaBytes: quotaSummary.storageGrantsQuotaBytes,
      grants: quotaSummary.grants.map((grant) => serializeStorageGrant(grant)),
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

accountRoutes.post(
  "/email/send-code",
  rateLimitByIp("auth:email_code", (r) => r.emailCodePerMinute),
  zValidator("json", sendBindEmailCodeSchema),
  async (c) => {
  const authUser = c.get("user");
  const email = c.req.valid("json").email.toLowerCase();
  const conflict = await db.query.users.findFirst({
    where: and(eq(users.email, email), ne(users.id, authUser.id)),
    columns: { id: true },
  });
  if (conflict) {
    return c.json({ error: "该邮箱已被其他账号使用" }, 409);
  }
  const issued = await issueEmailVerificationCode({ email, purpose: "bind_email", userId: authUser.id });
  if (!issued.ok) {
    return c.json({ error: issued.error }, issued.status);
  }
  return c.json(issued);
});

accountRoutes.patch("/profile", zValidator("json", updateProfileSchema), async (c) => {
  const authUser = c.get("user");
  const body = c.req.valid("json");
  const nextEmail = body.email !== undefined ? (body.email ? body.email.toLowerCase() : null) : undefined;

  const [currentRow, mailConfig, authPolicy, currentBalance] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, authUser.id) }),
    getPlatformMailConfig(),
    getAuthPolicy(),
    getWalletBalance(authUser.id),
  ]);
  if (!currentRow) {
    return c.json({ error: "账号不存在" }, 404);
  }

  const mailReady = isMailConfigReady(mailConfig);
  let emailPatch: { email?: string | null; emailVerifiedAt?: Date | null } = {};

  if (nextEmail !== undefined) {
    if (nextEmail === null) {
      if (mailReady && authPolicy.requireEmailOnRegister && currentRow.role !== "admin") {
        return c.json({ error: "当前系统策略要求账号绑定邮箱，仅支持更换新邮箱" }, 400);
      }
      emailPatch = { email: null, emailVerifiedAt: null };
    } else {
      const conflict = await db.query.users.findFirst({
        where: and(eq(users.email, nextEmail), ne(users.id, authUser.id)),
        columns: { id: true },
      });
      if (conflict) {
        return c.json({ error: "该邮箱已被其他账号使用" }, 409);
      }

      const emailChanged = nextEmail !== (currentRow.email || "").toLowerCase();
      const needsVerify = mailReady && (emailChanged || !currentRow.emailVerifiedAt);
      if (needsVerify) {
        const verified = await verifyAndConsumeEmailCode({
          email: nextEmail,
          purpose: "bind_email",
          code: body.emailCode || "",
          userId: authUser.id,
        });
        if (!verified.ok) {
          return c.json({ error: verified.error }, verified.status);
        }
        emailPatch = { email: nextEmail, emailVerifiedAt: new Date() };
      } else if (emailChanged) {
        emailPatch = { email: nextEmail, emailVerifiedAt: null };
      }
    }
  }

  const nextAlertEnabled =
    body.lowBalanceAlertEnabled !== undefined ? body.lowBalanceAlertEnabled : currentRow.lowBalanceAlertEnabled;
  const nextAlertThreshold =
    body.lowBalanceThreshold !== undefined ? body.lowBalanceThreshold : currentRow.lowBalanceThreshold;
  const effectiveThreshold = nextAlertThreshold ?? mailConfig.lowBalanceThreshold;
  const shouldResetAlertedAt =
    (body.lowBalanceAlertEnabled !== undefined || body.lowBalanceThreshold !== undefined) &&
    currentBalance >= effectiveThreshold;

  const [updated] = await db
    .update(users)
    .set({
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...emailPatch,
      ...(body.avatarUrl !== undefined ? { avatarUrl: body.avatarUrl } : {}),
      ...(body.lowBalanceAlertEnabled !== undefined ? { lowBalanceAlertEnabled: nextAlertEnabled } : {}),
      ...(body.lowBalanceThreshold !== undefined ? { lowBalanceThreshold: nextAlertThreshold } : {}),
      ...(shouldResetAlertedAt ? { lowBalanceAlertedAt: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(users.id, authUser.id))
    .returning();

  const quotaSummary = await getUserStorageQuotaSummary(updated);
  const alertMeta = await getUserQuotaAlertMeta({
    lowBalanceThreshold: updated.lowBalanceThreshold,
    storageUsedBytes: updated.storageUsedBytes,
    baseStorageQuotaBytes: quotaSummary.baseStorageQuotaBytes,
    baseStorageQuotaExpiresAt: quotaSummary.baseStorageQuotaExpiresAt,
    grants: quotaSummary.grants,
  });

  return c.json({
    user: {
      id: updated.id,
      username: updated.username,
      email: updated.email,
      emailVerifiedAt: updated.emailVerifiedAt ? updated.emailVerifiedAt.toISOString() : null,
      displayName: updated.displayName,
      avatarUrl: updated.avatarUrl,
      role: updated.role,
      status: updated.status,
      storageUsedBytes: updated.storageUsedBytes,
      storageQuotaBytes: quotaSummary.storageQuotaBytes,
      storageQuotaExpiresAt: quotaSummary.storageQuotaExpiresAt ? quotaSummary.storageQuotaExpiresAt.toISOString() : null,
      ...alertMeta,
      creditBalance: currentBalance,
      lastLoginAt: updated.lastLoginAt,
      createdAt: updated.createdAt,
    },
  });
});

accountRoutes.post(
  "/change-password/send-code",
  rateLimitByIp("auth:email_code", (r) => r.emailCodePerMinute),
  async (c) => {
  const authUser = c.get("user");
  const row = await db.query.users.findFirst({
    where: eq(users.id, authUser.id),
    columns: { id: true, email: true },
  });
  if (!row) return c.json({ error: "账号不存在" }, 404);
  if (!row.email) {
    return c.json({ error: "当前账号尚未绑定邮箱，请先在基本资料中绑定邮箱" }, 400);
  }
  const issued = await issueEmailVerificationCode({ email: row.email, purpose: "change_password", userId: row.id });
  if (!issued.ok) {
    return c.json({ error: issued.error }, issued.status);
  }
  return c.json(issued);
});

accountRoutes.post("/change-password", zValidator("json", changePasswordSchema), async (c) => {
  const authUser = c.get("user");
  const body = c.req.valid("json");
  const row = await db.query.users.findFirst({ where: eq(users.id, authUser.id) });
  if (!row) return c.json({ error: "账号不存在" }, 404);

  if (body.mode === "email") {
    if (!row.email) {
      return c.json({ error: "当前账号尚未绑定邮箱，请先绑定邮箱" }, 400);
    }
    const verified = await verifyAndConsumeEmailCode({
      email: row.email,
      purpose: "change_password",
      code: body.emailCode,
      userId: row.id,
    });
    if (!verified.ok) {
      return c.json({ error: verified.error }, verified.status);
    }
  } else {
    const valid = await verifyPassword(body.currentPassword, row.passwordHash);
    if (!valid) {
      return c.json({ error: "当前密码不正确" }, 400);
    }
  }

  const nextHash = await hashPassword(body.newPassword);
  await db
    .update(users)
    .set({
      passwordHash: nextHash,
      ...(body.mode === "email" && !row.emailVerifiedAt ? { emailVerifiedAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(eq(users.id, authUser.id));

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
    .returning({ id: userSessions.id });
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
