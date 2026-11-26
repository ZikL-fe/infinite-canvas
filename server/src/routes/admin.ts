/** 管理员后台接口：系统概览、公告发布、用户管控、兑换码、渠道模型、对象存储、WebDAV 与全站使用日志。 */
import { randomBytes } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import { and, asc, count, desc, eq, ilike, inArray, isNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";

import { announcements, canvasProjects, creditLedger, creditWallets, db, mediaObjects, redeemCodes, redeemRecords, userAssets, userSessions, userStorageGrants, users, workbenchLogs } from "../db/index.ts";
import { cleanupExpiredUsageLogs, invalidateAnalyticsCache, normalizeDashboardRange, queryAnalyticsDashboard } from "../lib/analytics.ts";
import { adjustWalletCredits, clearWalletCredits, getWalletBalance, queryConsumptionMetrics, queryCreditLedger, roundCredits } from "../lib/billing.ts";
import { hashPassword, maskSecret } from "../lib/crypto.ts";
import {
  cleanupOrphanedUserMedia,
  collectUserMediaReferences,
  extractStorageKeys,
  loadUserMediaByteMap,
  purgeMediaReferencesForUsers,
  summarizeWorkspaceMedia,
  type MediaSourceModule,
} from "../lib/media-cleanup.ts";
import { createMediaReadUrl, deleteS3ObjectStrict, testS3Connection } from "../lib/s3.ts";
import { isMailConfigReady, sendTestMail } from "../lib/mail.ts";
import {
  getAuthPolicy,
  getPlatformAnalyticsPolicy,
  getPlatformChannels,
  getPlatformGlobalNotice,
  getPlatformMailConfig,
  getPlatformStorageExpiryPolicy,
  getPlatformWebdavConfig,
  getS3StorageConfig,
  saveAuthPolicy,
  savePlatformAnalyticsPolicy,
  savePlatformChannels,
  savePlatformGlobalNotice,
  savePlatformMailConfig,
  savePlatformStorageExpiryPolicy,
  savePlatformWebdavConfig,
  saveS3StorageConfig,
  type PlatformChannel,
  type PlatformMailConfig,
  type S3StorageConfig,
} from "../lib/settings.ts";
import { runStorageExpirySweep } from "../lib/storage-expiry.ts";
import { getUserStorageQuotaSummary, getUsersStorageQuotaMap, serializeStorageGrant } from "../lib/storage-quota.ts";
import { requireAdmin, requireAuth, type AppEnv } from "../middleware/auth.ts";

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

const modelPricingSchema = z
  .union([
    z.object({
      mode: z.literal("token"),
      inputPerMillion: z.number().nonnegative(),
      cachedInputPerMillion: z.number().nonnegative().default(0),
      outputPerMillion: z.number().nonnegative(),
    }),
    z.object({
      mode: z.literal("per_image"),
      perImage: z.number().nonnegative(),
    }),
    z.object({
      mode: z.literal("per_resolution"),
      resolutionPrices: z.object({
        "1k": z.number().nonnegative().optional(),
        "2k": z.number().nonnegative().optional(),
        "4k": z.number().nonnegative().optional(),
        default: z.number().nonnegative(),
      }),
    }),
    z.object({
      mode: z.enum(["per_second", "per_request"]),
      perSecond: z.number().nonnegative().optional(),
      perRequest: z.number().nonnegative().optional(),
      chargeReferenceVideo: z.boolean().optional(),
      referenceVideoMode: z.enum(["per_second", "per_request"]).optional(),
      referenceVideoPrice: z.number().nonnegative().optional(),
    }),
  ])
  .optional();

const channelModelSchema = z.object({
  name: z.string().trim().min(1),
  capability: z.enum(["image", "video", "text", "audio"]),
  script: z.string().optional(),
  pricing: modelPricingSchema,
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

const createRedeemCodesSchema = z
  .object({
    kind: z.enum(["credits", "storage"]).default("credits"),
    count: z.number().int().min(1).max(100).default(1),
    credits: z.number().nonnegative().optional().default(0),
    storageQuotaBytes: z.number().int().nonnegative().optional().default(0),
    storageDurationDays: z.number().int().positive().max(36500).nullable().optional(),
    maxUses: z.number().int().min(1).default(1),
    prefix: z.string().trim().max(16).optional(),
    customCode: z.string().trim().max(64).optional(),
    expiresAt: z.string().nullable().optional(),
    note: z.string().trim().max(200).optional().default(""),
  })
  .superRefine((data, ctx) => {
    if (data.kind === "credits" && (!Number.isFinite(data.credits) || data.credits <= 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["credits"],
        message: "积分面值必须大于 0",
      });
    }
    if (data.kind === "storage" && (!Number.isFinite(data.storageQuotaBytes) || data.storageQuotaBytes <= 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["storageQuotaBytes"],
        message: "云端存储容量必须大于 0",
      });
    }
  });

const updateStorageGrantSchema = z.object({
  status: z.enum(["active", "revoked"]),
});

const updateRedeemCodeSchema = z.object({
  status: z.enum(["active", "disabled"]),
});

const batchDeleteRedeemCodesSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, "请选择要删除的兑换码").max(200),
});

function generateRedeemCodeString(prefix: string) {
  const cleanPrefix = prefix
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "");
  const raw = randomBytes(6).toString("hex").toUpperCase();
  const body = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  return cleanPrefix ? `${cleanPrefix}-${body}` : body;
}

const channelItemSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  baseUrl: z.string().trim(),
  apiKey: z.string().optional().default(""),
  apiFormat: z.enum(["openai", "gemini"]).default("openai"),
  enabled: z.boolean().default(true),
  models: z.array(channelModelSchema).default([]),
});

const saveChannelsSchema = z.object({
  channels: z.array(channelItemSchema),
});

const fetchChannelModelsSchema = z.object({
  id: z.string().optional(),
  baseUrl: z.string().trim().min(1, "请先填写 Base URL"),
  apiKey: z.string().optional().default(""),
  apiFormat: z.enum(["openai", "gemini"]).default("openai"),
});

const platformWebdavSchema = z.object({
  enabled: z.boolean(),
  url: z.string().trim().default(""),
  username: z.string().trim().default(""),
  password: z.string().optional().default(""),
  baseDirectory: z.string().trim().default("infinite-canvas"),
  autoAssignNewUsers: z.boolean().default(false),
});

const storageConfigSchema = z.object({
  provider: z.enum(["s3", "r2", "oss", "cos"]),
  endpoint: z.string().trim().default(""),
  region: z.string().trim().default("auto"),
  bucket: z.string().trim().min(1, "请填写 Bucket 名称"),
  accessKeyId: z.string().trim().min(1, "请填写 AccessKey ID"),
  secretAccessKey: z.string().optional().default(""),
  publicBaseUrl: z.string().trim().default(""),
  forcePathStyle: z.boolean().default(false),
});

const authPolicySchema = z.object({
  allowRegister: z.boolean(),
  requireEmailOnRegister: z.boolean().optional().default(false),
});

const mailConfigSchema = z.object({
  enabled: z.boolean(),
  host: z.string().trim().default(""),
  port: z.number().int().min(1).max(65535).default(465),
  secure: z.boolean().default(true),
  username: z.string().trim().default(""),
  password: z.string().optional().default(""),
  fromName: z.string().trim().max(64).default("ZIKL画布"),
  fromAddress: z.string().trim().email("发件人邮箱格式不正确").optional().or(z.literal("")),
  lowBalanceAlertEnabled: z.boolean().default(true),
  lowBalanceThreshold: z.number().nonnegative("低余额阈值不能小于 0").max(1_000_000).default(10),
  lowBalanceCooldownHours: z.number().int().min(1).max(720).default(24),
});

const testMailSchema = mailConfigSchema.extend({
  testTo: z.string().trim().email("请填写有效的测试收件邮箱"),
});

const announcementSchema = z.object({
  title: z.string().trim().min(1, "请输入公告标题").max(120),
  content: z.string().trim().min(1, "请输入公告内容").max(5000),
  level: z.enum(["default", "ongoing", "success", "warning", "error"]).default("default"),
  isPinned: z.boolean().default(false),
  isPublished: z.boolean().default(true),
  createdAt: z.string().optional(),
});

/** 查询系统初始化时注册的首位用户（即初始管理员）ID。 */
async function getInitialAdminUserId(): Promise<string | null> {
  const firstUser = await db.query.users.findFirst({
    orderBy: [asc(users.createdAt), asc(users.id)],
    columns: { id: true },
  });
  return firstUser?.id ?? null;
}

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use("*", requireAuth, requireAdmin);

adminRoutes.get("/overview", async (c) => {
  const days = Number(c.req.query("days") || 7);
  const [[userStats], [adminStats], [disabledStats], [mediaStats], [projectStats], [assetStats], kindRows, topStorageUsers, storageConfig, consumption, latestAnnouncements] = await Promise.all([
    db.select({ totalUsers: count() }).from(users),
    db.select({ adminCount: count() }).from(users).where(and(eq(users.role, "admin"), eq(users.status, "active"))),
    db.select({ disabledUsers: count() }).from(users).where(eq(users.status, "disabled")),
    db
      .select({
        activeMediaCount: count(),
        totalStorageBytes: sql<number>`COALESCE(SUM(${mediaObjects.bytes}), 0)::bigint`,
      })
      .from(mediaObjects)
      .where(eq(mediaObjects.status, "active")),
    db.select({ canvasProjectCount: count() }).from(canvasProjects).where(isNull(canvasProjects.deletedAt)),
    db.select({ assetCount: count() }).from(userAssets).where(isNull(userAssets.deletedAt)),
    db
      .select({
        kind: mediaObjects.kind,
        count: count(),
        bytes: sql<number>`COALESCE(SUM(${mediaObjects.bytes}), 0)::bigint`,
      })
      .from(mediaObjects)
      .where(eq(mediaObjects.status, "active"))
      .groupBy(mediaObjects.kind),
    db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        role: users.role,
        storageUsedBytes: users.storageUsedBytes,
        storageQuotaBytes: users.storageQuotaBytes,
        storageQuotaExpiresAt: users.storageQuotaExpiresAt,
      })
      .from(users)
      .orderBy(desc(users.storageUsedBytes), desc(users.createdAt))
      .limit(5),
    getS3StorageConfig(),
    queryConsumptionMetrics(days),
    db.query.announcements.findMany({
      where: eq(announcements.isPublished, true),
      orderBy: [desc(announcements.isPinned), desc(announcements.createdAt)],
      limit: 5,
    }),
  ]);

  const topStorageQuotaMap = await getUsersStorageQuotaMap(topStorageUsers);

  return c.json({
    totalUsers: Number(userStats?.totalUsers ?? 0),
    adminCount: Number(adminStats?.adminCount ?? 0),
    disabledUsers: Number(disabledStats?.disabledUsers ?? 0),
    activeMediaCount: Number(mediaStats?.activeMediaCount ?? 0),
    totalStorageBytes: Number(mediaStats?.totalStorageBytes ?? 0),
    canvasProjectCount: Number(projectStats?.canvasProjectCount ?? 0),
    assetCount: Number(assetStats?.assetCount ?? 0),
    mediaByKind: kindRows.map((row) => ({
      kind: row.kind,
      count: Number(row.count),
      bytes: Number(row.bytes),
    })),
    topStorageUsers: topStorageUsers.map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      role: row.role,
      storageUsedBytes: row.storageUsedBytes,
      storageQuotaBytes: topStorageQuotaMap.get(row.id)?.storageQuotaBytes ?? row.storageQuotaBytes,
    })),
    storageConfigured: Boolean(storageConfig),
    storageBucket: storageConfig?.bucket || "",
    storageProvider: storageConfig?.provider || "",
    ...consumption,
    announcements: latestAnnouncements,
  });
});

const globalNoticeSchema = z.object({
  enabled: z.boolean(),
  title: z.string().trim().max(120).optional().default(""),
  content: z.string().max(10000).optional().default(""),
});

adminRoutes.get("/announcements", async (c) => {
  const [items, notice] = await Promise.all([
    db.query.announcements.findMany({
      orderBy: [desc(announcements.isPinned), desc(announcements.createdAt)],
    }),
    getPlatformGlobalNotice(),
  ]);
  return c.json({ items, notice });
});

adminRoutes.put("/announcements/notice", zValidator("json", globalNoticeSchema), async (c) => {
  const body = c.req.valid("json");
  const notice = await savePlatformGlobalNotice(body, c.get("user").id);
  return c.json({ notice });
});

adminRoutes.post("/announcements", zValidator("json", announcementSchema), async (c) => {
  const body = c.req.valid("json");
  let parsedCreatedAt: Date | undefined;
  if (body.createdAt) {
    parsedCreatedAt = new Date(body.createdAt);
    if (Number.isNaN(parsedCreatedAt.getTime())) {
      return c.json({ error: "发布时间格式无效" }, 400);
    }
  }
  const [created] = await db
    .insert(announcements)
    .values({
      id: nanoid(),
      title: body.title,
      content: body.content,
      level: body.level,
      isPinned: body.isPinned,
      isPublished: body.isPublished,
      createdBy: c.get("user").id,
      ...(parsedCreatedAt ? { createdAt: parsedCreatedAt } : {}),
    })
    .returning();
  return c.json({ item: created }, 201);
});

adminRoutes.patch("/announcements/:id", zValidator("json", announcementSchema.partial()), async (c) => {
  const id = c.req.param("id");
  const { createdAt, ...rest } = c.req.valid("json");
  let parsedCreatedAt: Date | undefined;
  if (createdAt) {
    parsedCreatedAt = new Date(createdAt);
    if (Number.isNaN(parsedCreatedAt.getTime())) {
      return c.json({ error: "发布时间格式无效" }, 400);
    }
  }
  const [updated] = await db
    .update(announcements)
    .set({
      ...rest,
      ...(parsedCreatedAt ? { createdAt: parsedCreatedAt } : {}),
      updatedAt: new Date(),
    })
    .where(eq(announcements.id, id))
    .returning();
  if (!updated) return c.json({ error: "公告不存在" }, 404);
  return c.json({ item: updated });
});

adminRoutes.delete("/announcements/:id", async (c) => {
  const id = c.req.param("id");
  const [deleted] = await db.delete(announcements).where(eq(announcements.id, id)).returning({ id: announcements.id });
  if (!deleted) return c.json({ error: "公告不存在" }, 404);
  return c.json({ ok: true });
});

adminRoutes.get("/users", async (c) => {
  const q = c.req.query("q")?.trim() || "";
  const role = c.req.query("role")?.trim() || "";
  const status = c.req.query("status")?.trim() || "";
  const sort = c.req.query("sort")?.trim() || "created_desc";
  const page = Math.max(1, Number(c.req.query("page") || 1));
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query("pageSize") || 20)));
  const offset = (page - 1) * pageSize;

  const filters: SQL[] = [];
  if (q) {
    const searchCond = or(ilike(users.username, `%${q}%`), ilike(users.displayName, `%${q}%`), ilike(users.email, `%${q}%`));
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

adminRoutes.get("/users/:id/detail", async (c) => {
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

adminRoutes.post("/users/:id/credits", zValidator("json", adjustCreditsSchema), async (c) => {
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

adminRoutes.post("/users/:id/password", zValidator("json", resetUserPasswordSchema), async (c) => {
  const targetId = c.req.param("id");
  const body = c.req.valid("json");
  const target = await db.query.users.findFirst({ where: eq(users.id, targetId), columns: { id: true } });
  if (!target) {
    return c.json({ error: "用户不存在" }, 404);
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

adminRoutes.put("/users/:id/storage-quota", zValidator("json", userStorageQuotaSchema), async (c) => {
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
        bytes: sql<number>`COALESCE(SUM(${mediaObjects.bytes}), 0)::bigint`,
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

adminRoutes.get("/users/:id/storage-grants", async (c) => {
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

adminRoutes.patch("/storage-grants/:grantId", zValidator("json", updateStorageGrantSchema), async (c) => {
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

adminRoutes.get("/redeem-codes", async (c) => {
  const q = c.req.query("q")?.trim() || "";
  const status = c.req.query("status")?.trim() || "";
  const kind = c.req.query("kind")?.trim() || "";
  const page = Math.max(1, Number(c.req.query("page") || 1));
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query("pageSize") || 20)));
  const offset = (page - 1) * pageSize;

  const filters: SQL[] = [];
  if (q) {
    const cond = or(ilike(redeemCodes.code, `%${q}%`), ilike(redeemCodes.note, `%${q}%`));
    if (cond) filters.push(cond);
  }
  if (status === "active" || status === "disabled") {
    filters.push(eq(redeemCodes.status, status));
  }
  if (kind === "credits" || kind === "storage") {
    filters.push(eq(redeemCodes.kind, kind));
  }
  const whereClause = filters.length ? and(...filters) : undefined;

  const [items, [{ total }]] = await Promise.all([
    db.query.redeemCodes.findMany({
      where: whereClause,
      orderBy: [desc(redeemCodes.createdAt)],
      limit: pageSize,
      offset,
    }),
    db.select({ total: count() }).from(redeemCodes).where(whereClause),
  ]);

  const codeIds = items.map((item) => item.id);
  const redemptionMap = new Map<string, { userId: string; username: string; displayName: string; redeemedAt: string }>();
  if (codeIds.length) {
    const recordRows = await db
      .select({
        codeId: redeemRecords.codeId,
        userId: redeemRecords.userId,
        username: users.username,
        displayName: users.displayName,
        createdAt: redeemRecords.createdAt,
      })
      .from(redeemRecords)
      .leftJoin(users, eq(redeemRecords.userId, users.id))
      .where(inArray(redeemRecords.codeId, codeIds))
      .orderBy(desc(redeemRecords.createdAt));

    for (const row of recordRows) {
      if (!redemptionMap.has(row.codeId)) {
        redemptionMap.set(row.codeId, {
          userId: row.userId,
          username: row.username || "",
          displayName: row.displayName || "",
          redeemedAt: row.createdAt.toISOString(),
        });
      }
    }
  }

  return c.json({
    items: items.map((item) => ({
      ...item,
      redemption: redemptionMap.get(item.id) ?? null,
    })),
    total: Number(total),
    page,
    pageSize,
  });
});

adminRoutes.post("/redeem-codes", zValidator("json", createRedeemCodesSchema), async (c) => {
  const body = c.req.valid("json");
  const adminId = c.get("user").id;
  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    return c.json({ error: "过期时间格式无效" }, 400);
  }

  const custom = body.count === 1 && body.customCode?.trim() ? body.customCode.trim().toUpperCase() : "";
  if (custom) {
    const exists = await db.query.redeemCodes.findFirst({ where: eq(redeemCodes.code, custom), columns: { id: true } });
    if (exists) {
      return c.json({ error: "该兑换码已存在" }, 409);
    }
  }

  const defaultPrefix = body.kind === "storage" ? "ST" : "IC";
  const prefix = body.prefix?.trim() || defaultPrefix;
  const credits = body.kind === "credits" ? roundCredits(body.credits) : 0;
  const storageQuotaBytes = body.kind === "storage" ? Math.round(body.storageQuotaBytes) : 0;
  const storageDurationDays =
    body.kind === "storage" && typeof body.storageDurationDays === "number" && body.storageDurationDays > 0
      ? Math.round(body.storageDurationDays)
      : null;

  // 批量生成随机兑换码时如遇极小概率碰撞，自动跳过已存在码并补齐剩余数量
  const remainingTarget = body.count;
  const created: (typeof redeemCodes.$inferSelect)[] = [];
  for (let attempt = 0; attempt < 5 && created.length < remainingTarget; attempt += 1) {
    const needed = remainingTarget - created.length;
    const values = Array.from({ length: needed }, (_, idx) => ({
      id: nanoid(),
      code: attempt === 0 && idx === 0 && custom ? custom : generateRedeemCodeString(prefix),
      kind: body.kind,
      credits,
      storageQuotaBytes,
      storageDurationDays,
      // 一个兑换码仅限 1 人兑换
      maxUses: 1,
      usedCount: 0,
      note: body.note,
      status: "active" as const,
      expiresAt,
      createdBy: adminId,
    }));
    const batch = await db
      .insert(redeemCodes)
      .values(values)
      .onConflictDoNothing({ target: redeemCodes.code })
      .returning();
    created.push(...batch);
  }
  return c.json({ items: created }, 201);
});

adminRoutes.patch("/redeem-codes/:id", zValidator("json", updateRedeemCodeSchema), async (c) => {
  const id = c.req.param("id");
  const { status } = c.req.valid("json");
  const [updated] = await db.update(redeemCodes).set({ status }).where(eq(redeemCodes.id, id)).returning();
  if (!updated) return c.json({ error: "兑换码不存在" }, 404);
  return c.json({ item: updated });
});

adminRoutes.post("/redeem-codes/batch-delete", zValidator("json", batchDeleteRedeemCodesSchema), async (c) => {
  const uniqueIds = Array.from(new Set(c.req.valid("json").ids));
  const result = await db.transaction(async (tx) => {
    const existingRows = await tx.query.redeemCodes.findMany({
      where: inArray(redeemCodes.id, uniqueIds),
      columns: { id: true, usedCount: true },
    });
    if (!existingRows.length) {
      return { error: "未找到可删除的兑换码", status: 404 as const };
    }
    const usedCode = existingRows.find((row) => row.usedCount > 0);
    const hasRecord = await tx.query.redeemRecords.findFirst({
      where: inArray(redeemRecords.codeId, uniqueIds),
      columns: { id: true },
    });
    if (usedCode || hasRecord) {
      return { error: "已使用过的兑换码不能删除，请取消勾选后再试", status: 400 as const };
    }
    const deleted = await tx
      .delete(redeemCodes)
      .where(and(inArray(redeemCodes.id, uniqueIds), eq(redeemCodes.usedCount, 0)))
      .returning({ id: redeemCodes.id });
    return { ok: true as const, deletedCount: deleted.length };
  });

  if ("error" in result) {
    return c.json({ error: result.error }, result.status);
  }
  return c.json(result);
});

adminRoutes.delete("/redeem-codes/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await db.query.redeemCodes.findFirst({
    where: eq(redeemCodes.id, id),
    columns: { id: true, usedCount: true },
  });
  if (!existing) return c.json({ error: "兑换码不存在" }, 404);
  if (existing.usedCount > 0) {
    return c.json({ error: "已使用过的兑换码不能删除" }, 400);
  }
  const hasRecord = await db.query.redeemRecords.findFirst({
    where: eq(redeemRecords.codeId, id),
    columns: { id: true },
  });
  if (hasRecord) {
    return c.json({ error: "已使用过的兑换码不能删除" }, 400);
  }
  const [deleted] = await db
    .delete(redeemCodes)
    .where(and(eq(redeemCodes.id, id), eq(redeemCodes.usedCount, 0)))
    .returning({ id: redeemCodes.id });
  if (!deleted) return c.json({ error: "兑换码不存在或已被兑换" }, 400);
  return c.json({ ok: true });
});

adminRoutes.put("/users/:id/webdav", zValidator("json", userWebdavSchema), async (c) => {
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
    ...(body.password?.trim() ? { password: body.password.trim() } : prev?.password && body.password === undefined ? { password: prev.password } : {}),
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

adminRoutes.patch("/users/:id", zValidator("json", updateUserSchema), async (c) => {
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

  if (target.role === "admin" && target.status === "active" && (nextRole !== "admin" || nextStatus !== "active")) {
    const [{ otherAdmins }] = await db
      .select({ otherAdmins: count() })
      .from(users)
      .where(and(eq(users.role, "admin"), eq(users.status, "active"), ne(users.id, targetId)));
    if (Number(otherAdmins) === 0) {
      return c.json({ error: "系统至少需要保留一名可用管理员" }, 400);
    }
  }

  const [updated] = await db
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
    await db.update(userSessions).set({ revokedAt: new Date() }).where(eq(userSessions.userId, targetId));
  }

  return c.json({ user: updated });
});

adminRoutes.get("/settings/storage", async (c) => {
  const config = await getS3StorageConfig();
  if (!config) {
    return c.json({
      configured: false,
      config: {
        provider: "r2",
        endpoint: "",
        region: "auto",
        bucket: "",
        accessKeyId: "",
        publicBaseUrl: "",
        forcePathStyle: false,
        hasSecretKey: false,
        secretAccessKeyPreview: "",
      },
    });
  }

  return c.json({
    configured: true,
    config: {
      provider: config.provider,
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      publicBaseUrl: config.publicBaseUrl,
      forcePathStyle: config.forcePathStyle,
      hasSecretKey: Boolean(config.secretAccessKey),
      secretAccessKeyPreview: maskSecret(config.secretAccessKey),
    },
  });
});

adminRoutes.put("/settings/storage", zValidator("json", storageConfigSchema), async (c) => {
  const body = c.req.valid("json");
  const existing = await getS3StorageConfig();
  const secretAccessKey = body.secretAccessKey.trim() || existing?.secretAccessKey || "";
  if (!secretAccessKey) {
    return c.json({ error: "请填写 SecretAccessKey" }, 400);
  }

  const nextConfig: S3StorageConfig = {
    provider: body.provider,
    endpoint: body.endpoint,
    region: body.region || "auto",
    bucket: body.bucket,
    accessKeyId: body.accessKeyId,
    secretAccessKey,
    publicBaseUrl: body.publicBaseUrl,
    forcePathStyle: body.forcePathStyle,
  };

  await saveS3StorageConfig(nextConfig, c.get("user").id);
  return c.json({ ok: true, secretAccessKeyPreview: maskSecret(secretAccessKey) });
});

adminRoutes.post("/settings/storage/test", zValidator("json", storageConfigSchema), async (c) => {
  const body = c.req.valid("json");
  const existing = await getS3StorageConfig();
  const secretAccessKey = body.secretAccessKey.trim() || existing?.secretAccessKey || "";
  if (!secretAccessKey) {
    return c.json({ error: "请先填写 SecretAccessKey" }, 400);
  }

  try {
    await testS3Connection({
      provider: body.provider,
      endpoint: body.endpoint,
      region: body.region || "auto",
      bucket: body.bucket,
      accessKeyId: body.accessKeyId,
      secretAccessKey,
      publicBaseUrl: body.publicBaseUrl,
      forcePathStyle: body.forcePathStyle,
    });
    return c.json({ ok: true, message: "连接成功，测试文件写入、读取、删除均正常" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "对象存储连接测试失败";
    return c.json({ error: message }, 400);
  }
});

adminRoutes.get("/settings/auth", async (c) => {
  const [policy, mailConfig] = await Promise.all([getAuthPolicy(), getPlatformMailConfig()]);
  return c.json({
    ...policy,
    emailEnabled: isMailConfigReady(mailConfig),
  });
});

adminRoutes.put("/settings/auth", zValidator("json", authPolicySchema), async (c) => {
  const body = c.req.valid("json");
  if (body.requireEmailOnRegister) {
    const mailConfig = await getPlatformMailConfig();
    if (!isMailConfigReady(mailConfig)) {
      return c.json({ error: "请先在「邮件服务配置」中启用并配置完整的 SMTP 参数后再开启强制邮箱验证" }, 400);
    }
  }
  const policy = await saveAuthPolicy(body, c.get("user").id);
  return c.json(policy);
});

adminRoutes.get("/settings/mail", async (c) => {
  const config = await getPlatformMailConfig();
  return c.json({
    enabled: config.enabled,
    host: config.host,
    port: config.port,
    secure: config.secure,
    username: config.username,
    hasPassword: Boolean(config.password),
    passwordPreview: maskSecret(config.password),
    fromName: config.fromName,
    fromAddress: config.fromAddress,
    lowBalanceAlertEnabled: config.lowBalanceAlertEnabled,
    lowBalanceThreshold: config.lowBalanceThreshold,
    lowBalanceCooldownHours: config.lowBalanceCooldownHours,
    ready: isMailConfigReady(config),
  });
});

adminRoutes.put("/settings/mail", zValidator("json", mailConfigSchema), async (c) => {
  const body = c.req.valid("json");
  const existing = await getPlatformMailConfig();
  const nextConfig: PlatformMailConfig = {
    enabled: body.enabled,
    host: body.host,
    port: body.port,
    secure: body.secure,
    username: body.username,
    password: body.password.trim() || existing.password,
    fromName: body.fromName || "ZIKL画布",
    fromAddress: body.fromAddress || "",
    lowBalanceAlertEnabled: body.lowBalanceAlertEnabled,
    lowBalanceThreshold: body.lowBalanceThreshold,
    lowBalanceCooldownHours: body.lowBalanceCooldownHours,
  };
  if (nextConfig.enabled && !isMailConfigReady(nextConfig)) {
    return c.json({ error: "启用邮件服务时，请填写完整的 SMTP 主机、端口与发件人邮箱" }, 400);
  }
  await savePlatformMailConfig(nextConfig, c.get("user").id);
  if (!nextConfig.enabled) {
    const authPolicy = await getAuthPolicy();
    if (authPolicy.requireEmailOnRegister) {
      await saveAuthPolicy({ ...authPolicy, requireEmailOnRegister: false }, c.get("user").id);
    }
  }
  return c.json({ ok: true, ready: isMailConfigReady(nextConfig), passwordPreview: maskSecret(nextConfig.password) });
});

adminRoutes.post("/settings/mail/test", zValidator("json", testMailSchema), async (c) => {
  const body = c.req.valid("json");
  const existing = await getPlatformMailConfig();
  const config: PlatformMailConfig = {
    enabled: true,
    host: body.host,
    port: body.port,
    secure: body.secure,
    username: body.username,
    password: body.password.trim() || existing.password,
    fromName: body.fromName || "ZIKL画布",
    fromAddress: body.fromAddress || "",
    lowBalanceAlertEnabled: body.lowBalanceAlertEnabled,
    lowBalanceThreshold: body.lowBalanceThreshold,
    lowBalanceCooldownHours: body.lowBalanceCooldownHours,
  };
  try {
    await sendTestMail({ to: body.testTo, config });
    return c.json({ ok: true, message: `测试邮件已发送至 ${body.testTo}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : "测试邮件发送失败";
    return c.json({ error: `测试邮件发送失败：${message}` }, 400);
  }
});

const saveStorageExpiryPolicySchema = z.object({
  enabled: z.boolean().optional(),
  gracePeriodDays: z.number().int().min(1).max(365).optional(),
  preExpiryWarnDays: z.number().int().min(0).max(30).optional(),
  cleanupWorkspaceData: z.boolean().optional(),
  exemptAdmins: z.boolean().optional(),
  cleanupOverQuotaWithoutExpiry: z.boolean().optional(),
});

const runStorageExpirySweepSchema = z.object({
  dryRun: z.boolean().optional(),
  userId: z.string().trim().min(1).optional(),
});

adminRoutes.get("/settings/storage-expiry", async (c) => {
  const [policy, mailConfig] = await Promise.all([getPlatformStorageExpiryPolicy(), getPlatformMailConfig()]);
  return c.json({
    ...policy,
    mailReady: isMailConfigReady(mailConfig),
  });
});

adminRoutes.put("/settings/storage-expiry", zValidator("json", saveStorageExpiryPolicySchema), async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const prev = await getPlatformStorageExpiryPolicy();
  const saved = await savePlatformStorageExpiryPolicy(
    {
      enabled: body.enabled ?? prev.enabled,
      gracePeriodDays: body.gracePeriodDays ?? prev.gracePeriodDays,
      preExpiryWarnDays: body.preExpiryWarnDays ?? prev.preExpiryWarnDays,
      cleanupWorkspaceData: body.cleanupWorkspaceData ?? prev.cleanupWorkspaceData,
      exemptAdmins: body.exemptAdmins ?? prev.exemptAdmins,
      cleanupOverQuotaWithoutExpiry: body.cleanupOverQuotaWithoutExpiry ?? prev.cleanupOverQuotaWithoutExpiry,
    },
    user.id,
  );
  const mailConfig = await getPlatformMailConfig();
  return c.json({
    ok: true,
    ...saved,
    mailReady: isMailConfigReady(mailConfig),
  });
});

adminRoutes.post("/settings/storage-expiry/run", zValidator("json", runStorageExpirySweepSchema), async (c) => {
  const body = c.req.valid("json");
  const result = await runStorageExpirySweep({ dryRun: Boolean(body.dryRun), userId: body.userId });
  return c.json(result);
});

const saveAnalyticsPolicySchema = z.object({
  sampleIntervalMinutes: z.number().int().min(1).max(1440),
  logRetentionDays: z.number().int().min(0).max(3650),
});

const cleanupLogsSchema = z.object({
  retentionDays: z.number().int().min(1).max(3650).optional(),
});

adminRoutes.get("/dashboard", async (c) => {
  const range = normalizeDashboardRange(c.req.query("range"));
  const force = c.req.query("force") === "1" || c.req.query("force") === "true";
  const dashboard = await queryAnalyticsDashboard({ range, force });
  return c.json(dashboard);
});

adminRoutes.get("/settings/analytics", async (c) => {
  const policy = await getPlatformAnalyticsPolicy();
  return c.json(policy);
});

adminRoutes.put("/settings/analytics", zValidator("json", saveAnalyticsPolicySchema), async (c) => {
  const body = c.req.valid("json");
  const saved = await savePlatformAnalyticsPolicy(body, c.get("user").id);
  invalidateAnalyticsCache();
  return c.json({ ok: true, ...saved });
});

adminRoutes.post("/settings/analytics/cleanup-logs", zValidator("json", cleanupLogsSchema), async (c) => {
  const body = c.req.valid("json");
  const result = await cleanupExpiredUsageLogs(body.retentionDays);
  return c.json({ ok: true, ...result });
});

adminRoutes.get("/settings/channels", async (c) => {
  const channels = await getPlatformChannels();
  return c.json({
    channels: channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      baseUrl: channel.baseUrl,
      apiFormat: channel.apiFormat,
      enabled: channel.enabled,
      models: channel.models,
      hasApiKey: Boolean(channel.apiKey),
      apiKeyPreview: maskSecret(channel.apiKey),
    })),
  });
});

adminRoutes.put("/settings/channels", zValidator("json", saveChannelsSchema), async (c) => {
  const body = c.req.valid("json");
  const existing = await getPlatformChannels();
  const existingKeyMap = new Map(existing.map((ch) => [ch.id, ch.apiKey]));

  const nextChannels: PlatformChannel[] = body.channels.map((ch) => ({
    id: ch.id,
    name: ch.name,
    baseUrl: ch.baseUrl.replace(/\/+$/, ""),
    apiKey: ch.apiKey.trim() || existingKeyMap.get(ch.id) || "",
    apiFormat: ch.apiFormat,
    enabled: ch.enabled,
    models: ch.models,
  }));

  await savePlatformChannels(nextChannels, c.get("user").id);
  return c.json({ ok: true });
});

adminRoutes.post("/settings/channels/fetch-models", zValidator("json", fetchChannelModelsSchema), async (c) => {
  const body = c.req.valid("json");
  const existing = await getPlatformChannels();
  const savedKey = body.id ? existing.find((ch) => ch.id === body.id)?.apiKey || "" : "";
  const apiKey = body.apiKey.trim() || savedKey;
  if (!apiKey) {
    return c.json({ error: "请先填写 API Key" }, 400);
  }

  const base = body.baseUrl.replace(/\/+$/, "");
  const lower = base.toLowerCase();
  let url = "";
  const headers: Record<string, string> = {};

  if (body.apiFormat === "gemini") {
    const apiBase = lower.endsWith("/v1") || lower.endsWith("/v1beta") ? base : `${base}/v1beta`;
    url = `${apiBase}/models`;
    headers["x-goog-api-key"] = apiKey;
  } else {
    const apiBase = lower.endsWith("/v1") ? base : `${base}/v1`;
    url = `${apiBase}/models`;
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return c.json({ error: `拉取模型失败（HTTP ${res.status}）${text ? `: ${text.slice(0, 120)}` : ""}` }, 400);
  }

  const payload = (await res.json()) as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> };
  const models =
    body.apiFormat === "gemini"
      ? (payload.models || []).map((item) => (item.name || "").replace(/^models\//, "").trim()).filter(Boolean)
      : (payload.data || []).map((item) => (item.id || "").trim()).filter(Boolean);

  return c.json({ models: Array.from(new Set(models)) });
});

adminRoutes.get("/settings/webdav", async (c) => {
  const config = await getPlatformWebdavConfig();
  return c.json({
    enabled: config.enabled,
    url: config.url,
    username: config.username,
    baseDirectory: config.baseDirectory,
    autoAssignNewUsers: config.autoAssignNewUsers,
    hasPassword: Boolean(config.password),
    passwordPreview: maskSecret(config.password),
  });
});

adminRoutes.put("/settings/webdav", zValidator("json", platformWebdavSchema), async (c) => {
  const body = c.req.valid("json");
  const existing = await getPlatformWebdavConfig();
  await savePlatformWebdavConfig(
    {
      enabled: body.enabled,
      url: body.url,
      username: body.username,
      password: body.password.trim() || existing.password,
      baseDirectory: body.baseDirectory,
      autoAssignNewUsers: body.autoAssignNewUsers,
    },
    c.get("user").id,
  );
  return c.json({ ok: true });
});

adminRoutes.post("/settings/webdav/test", zValidator("json", platformWebdavSchema), async (c) => {
  const body = c.req.valid("json");
  const existing = await getPlatformWebdavConfig();
  const password = body.password.trim() || existing.password;
  const url = body.url.trim().replace(/\/+$/, "");
  if (!url) {
    return c.json({ error: "请先填写 WebDAV 地址" }, 400);
  }
  const auth = Buffer.from(`${body.username}:${password}`).toString("base64");
  const res = await fetch(`${url}/`, {
    method: "PROPFIND",
    headers: {
      Depth: "0",
      ...(body.username ? { Authorization: `Basic ${auth}` } : {}),
    },
  });
  if (!res.ok && res.status !== 207) {
    return c.json({ error: `WebDAV 连接测试失败（HTTP ${res.status}）` }, 400);
  }
  return c.json({ ok: true, message: "WebDAV 连接测试成功" });
});

adminRoutes.get("/media", async (c) => {
  const q = c.req.query("q")?.trim() || "";
  const kind = c.req.query("kind")?.trim() || "";
  const moduleFilter = c.req.query("module")?.trim() || "";
  const page = Math.max(1, Number(c.req.query("page") || 1));
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query("pageSize") || 20)));
  const offset = (page - 1) * pageSize;

  const [[canvasCount], [imageLogCount], [videoLogCount]] = await Promise.all([
    db.select({ total: count() }).from(canvasProjects).where(isNull(canvasProjects.deletedAt)),
    db.select({ total: count() }).from(workbenchLogs).where(and(eq(workbenchLogs.kind, "image"), isNull(workbenchLogs.deletedAt))),
    db.select({ total: count() }).from(workbenchLogs).where(and(eq(workbenchLogs.kind, "video"), isNull(workbenchLogs.deletedAt))),
  ]);
  const workspaceStats = {
    canvasProjects: Number(canvasCount?.total ?? 0),
    imageLogs: Number(imageLogCount?.total ?? 0),
    videoLogs: Number(videoLogCount?.total ?? 0),
  };

  const filters: SQL[] = [eq(mediaObjects.status, "active")];
  if (kind === "image" || kind === "video" || kind === "audio" || kind === "file") {
    filters.push(eq(mediaObjects.kind, kind));
  }
  if (
    moduleFilter === "standalone" ||
    moduleFilter === "canvas" ||
    moduleFilter === "image_workbench" ||
    moduleFilter === "video_workbench" ||
    moduleFilter === "assets"
  ) {
    const allUserRows = await db.select({ id: users.id }).from(users);
    const { moduleMap: allMap, activeKeySet } = await collectUserMediaReferences(allUserRows.map((u) => u.id));
    if (moduleFilter === "standalone") {
      const referencedIds = Array.from(activeKeySet);
      if (referencedIds.length) {
        filters.push(notInArray(mediaObjects.id, referencedIds));
      }
    } else {
      const matchedIds = Array.from(allMap.entries())
        .filter(([, mods]) => mods.has(moduleFilter as MediaSourceModule))
        .map(([id]) => id);
      if (!matchedIds.length) {
        return c.json({ items: [], total: 0, filteredBytes: 0, page, pageSize, workspaceStats });
      }
      filters.push(inArray(mediaObjects.id, matchedIds));
    }
  }
  if (q) {
    const searchCond = or(ilike(mediaObjects.objectKey, `%${q}%`), ilike(users.username, `%${q}%`));
    if (searchCond) filters.push(searchCond);
  }
  const whereClause = and(...filters);

  const [rows, [totalRow], config] = await Promise.all([
    db
      .select({
        id: mediaObjects.id,
        userId: mediaObjects.userId,
        username: users.username,
        bucket: mediaObjects.bucket,
        objectKey: mediaObjects.objectKey,
        kind: mediaObjects.kind,
        mimeType: mediaObjects.mimeType,
        bytes: mediaObjects.bytes,
        sourceType: mediaObjects.sourceType,
        meta: mediaObjects.meta,
        createdAt: mediaObjects.createdAt,
      })
      .from(mediaObjects)
      .leftJoin(users, eq(mediaObjects.userId, users.id))
      .where(whereClause)
      .orderBy(desc(mediaObjects.createdAt))
      .limit(pageSize)
      .offset(offset),
    db
      .select({
        total: count(),
        filteredBytes: sql<number>`COALESCE(SUM(${mediaObjects.bytes}), 0)::double precision`,
      })
      .from(mediaObjects)
      .leftJoin(users, eq(mediaObjects.userId, users.id))
      .where(whereClause),
    getS3StorageConfig(),
  ]);

  const { moduleMap } = await collectUserMediaReferences(rows.map((r) => r.userId));
  const items = await Promise.all(
    rows.map(async (row) => {
      const thumbKey = typeof row.meta?.thumbObjectKey === "string" ? row.meta.thumbObjectKey : "";
      const [url, thumbnailUrl] = await Promise.all([
        config ? createMediaReadUrl(config, row.objectKey) : Promise.resolve(""),
        config && thumbKey ? createMediaReadUrl(config, thumbKey) : Promise.resolve(""),
      ]);
      return {
        ...row,
        modules: Array.from(moduleMap.get(row.id) || []),
        url,
        thumbnailUrl,
      };
    }),
  );

  return c.json({
    items,
    total: Number(totalRow?.total ?? 0),
    filteredBytes: Number(totalRow?.filteredBytes ?? 0),
    page,
    pageSize,
    workspaceStats,
  });
});

adminRoutes.get("/workspace-data", async (c) => {
  const kind = c.req.query("kind")?.trim() || "canvas";
  const q = c.req.query("q")?.trim() || "";
  const page = Math.max(1, Number(c.req.query("page") || 1));
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query("pageSize") || 12)));
  const offset = (page - 1) * pageSize;

  if (kind === "canvas") {
    const filters: SQL[] = [isNull(canvasProjects.deletedAt)];
    if (q) {
      const cond = or(ilike(canvasProjects.title, `%${q}%`), ilike(users.username, `%${q}%`));
      if (cond) filters.push(cond);
    }
    const whereClause = and(...filters);
    const [rows, [totalRow]] = await Promise.all([
      db
        .select({
          id: canvasProjects.id,
          userId: canvasProjects.userId,
          username: users.username,
          title: canvasProjects.title,
          nodes: canvasProjects.nodes,
          connections: canvasProjects.connections,
          chatSessions: canvasProjects.chatSessions,
          updatedAt: canvasProjects.updatedAt,
          createdAt: canvasProjects.createdAt,
        })
        .from(canvasProjects)
        .leftJoin(users, eq(canvasProjects.userId, users.id))
        .where(whereClause)
        .orderBy(desc(canvasProjects.updatedAt))
        .limit(pageSize)
        .offset(offset),
      db
        .select({ total: count() })
        .from(canvasProjects)
        .leftJoin(users, eq(canvasProjects.userId, users.id))
        .where(whereClause),
    ]);
    const byteMap = await loadUserMediaByteMap(rows.map((r) => r.userId));
    return c.json({
      items: rows.map((row) => ({
        id: row.id,
        kind: "canvas" as const,
        userId: row.userId,
        username: row.username || "",
        title: row.title,
        nodeCount: Array.isArray(row.nodes) ? row.nodes.length : 0,
        ...summarizeWorkspaceMedia(row.userId, byteMap, [row.nodes, row.chatSessions], {
          title: row.title,
          nodes: row.nodes,
          connections: row.connections,
          chatSessions: row.chatSessions,
        }),
        updatedAt: row.updatedAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      })),
      total: Number(totalRow?.total ?? 0),
      page,
      pageSize,
    });
  }

  const logKind = kind === "video_workbench" ? "video" : "image";
  const filters: SQL[] = [eq(workbenchLogs.kind, logKind), isNull(workbenchLogs.deletedAt)];
  if (q) {
    const cond = or(ilike(workbenchLogs.prompt, `%${q}%`), ilike(workbenchLogs.title, `%${q}%`), ilike(users.username, `%${q}%`));
    if (cond) filters.push(cond);
  }
  const whereClause = and(...filters);
  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        id: workbenchLogs.id,
        userId: workbenchLogs.userId,
        username: users.username,
        kind: workbenchLogs.kind,
        title: workbenchLogs.title,
        prompt: workbenchLogs.prompt,
        model: workbenchLogs.model,
        status: workbenchLogs.status,
        payload: workbenchLogs.payload,
        updatedAt: workbenchLogs.updatedAt,
        createdAt: workbenchLogs.createdAt,
      })
      .from(workbenchLogs)
      .leftJoin(users, eq(workbenchLogs.userId, users.id))
      .where(whereClause)
      .orderBy(desc(workbenchLogs.createdAt))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ total: count() })
      .from(workbenchLogs)
      .leftJoin(users, eq(workbenchLogs.userId, users.id))
      .where(whereClause),
  ]);

  const byteMap = await loadUserMediaByteMap(rows.map((r) => r.userId));
  return c.json({
    items: rows.map((row) => ({
      id: row.id,
      kind: row.kind === "video" ? ("video_workbench" as const) : ("image_workbench" as const),
      userId: row.userId,
      username: row.username || "",
      title: row.title || row.prompt.slice(0, 24) || "未命名记录",
      prompt: row.prompt,
      model: row.model,
      status: row.status,
      ...summarizeWorkspaceMedia(row.userId, byteMap, row.payload, {
        title: row.title,
        prompt: row.prompt,
        payload: row.payload,
      }),
      updatedAt: row.updatedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    })),
    total: Number(totalRow?.total ?? 0),
    page,
    pageSize,
  });
});

adminRoutes.delete("/workspace-data/:kind/:id", async (c) => {
  const kind = c.req.param("kind");
  const id = c.req.param("id");
  const now = new Date();

  if (kind === "canvas") {
    const existing = await db.query.canvasProjects.findFirst({ where: eq(canvasProjects.id, id) });
    if (!existing || existing.deletedAt) return c.json({ error: "画布记录不存在" }, 404);
    const candidateKeys = extractStorageKeys([existing.nodes, existing.chatSessions]);
    await db.update(canvasProjects).set({ deletedAt: now, updatedAt: now }).where(eq(canvasProjects.id, id));
    const deletedMediaCount = await cleanupOrphanedUserMedia(existing.userId, candidateKeys);
    return c.json({ ok: true, deletedMediaCount });
  }

  const existing = await db.query.workbenchLogs.findFirst({ where: eq(workbenchLogs.id, id) });
  if (!existing || existing.deletedAt) return c.json({ error: "工作台记录不存在" }, 404);
  const candidateKeys = extractStorageKeys(existing.payload);
  await db.update(workbenchLogs).set({ deletedAt: now, updatedAt: now }).where(eq(workbenchLogs.id, id));
  const deletedMediaCount = await cleanupOrphanedUserMedia(existing.userId, candidateKeys);
  return c.json({ ok: true, deletedMediaCount });
});

adminRoutes.delete("/media/:id", async (c) => {
  const mediaId = c.req.param("id");
  const media = await db.query.mediaObjects.findFirst({ where: eq(mediaObjects.id, mediaId) });
  if (!media || media.status === "deleted") {
    return c.json({ error: "媒体文件不存在" }, 404);
  }

  const config = await getS3StorageConfig();
  if (!config) {
    return c.json({ error: "管理员尚未配置对象存储，无法从存储桶删除文件" }, 503);
  }
  try {
    await deleteS3ObjectStrict(config, media.objectKey);
  } catch (error) {
    return c.json(
      { error: `对象存储删除失败：${error instanceof Error ? error.message : "未知错误"}` },
      502,
    );
  }
  const thumbKey = typeof media.meta?.thumbObjectKey === "string" ? media.meta.thumbObjectKey : "";
  if (thumbKey) {
    await deleteS3ObjectStrict(config, thumbKey).catch(() => undefined);
  }

  await db.transaction(async (tx) => {
    await tx.update(mediaObjects).set({ status: "deleted" }).where(eq(mediaObjects.id, media.id));
    if (media.status === "active" && media.bytes > 0) {
      await tx
        .update(users)
        .set({
          storageUsedBytes: sql`GREATEST(0, ${users.storageUsedBytes} - ${media.bytes})`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, media.userId));
    }
  });

  await purgeMediaReferencesForUsers(new Map([[media.userId, [media.id]]]));

  return c.json({ ok: true });
});

adminRoutes.get("/logs", async (c) => {
  const adminUser = c.get("user");
  const scope = c.req.query("scope") === "self" ? "self" : "all";
  const categoryRaw = c.req.query("category")?.trim();
  const category = categoryRaw === "usage" || categoryRaw === "recharge" ? categoryRaw : "usage";

  const ledger = await queryCreditLedger({
    userId: scope === "self" ? adminUser.id : undefined,
    userQuery: scope === "all" ? c.req.query("q") : undefined,
    logId: c.req.query("logId"),
    taskStatus: c.req.query("taskStatus"),
    category,
    reason: c.req.query("reason"),
    model: c.req.query("model"),
    startDate: c.req.query("startDate"),
    endDate: c.req.query("endDate"),
    page: Number(c.req.query("page") || 1),
    pageSize: Number(c.req.query("pageSize") || 20),
  });

  return c.json({
    scope,
    ...ledger,
  });
});
