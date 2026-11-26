/** 管理后台：系统概览与公告/全局通知路由。 */
import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";

import { announcements, canvasProjects, db, mediaObjects, userAssets, users } from "../../db/index.ts";
import { queryConsumptionMetrics } from "../../lib/billing.ts";
import { mediaTotalBytesSql } from "../../lib/media-cleanup.ts";
import { getPlatformGlobalNotice, getS3StorageConfig, savePlatformGlobalNotice } from "../../lib/settings.ts";
import { getUsersStorageQuotaMap } from "../../lib/storage-quota.ts";
import type { AppEnv } from "../../middleware/auth.ts";

const announcementSchema = z.object({
  title: z.string().trim().min(1, "请输入公告标题").max(120),
  content: z.string().trim().min(1, "请输入公告内容").max(5000),
  level: z.enum(["default", "ongoing", "success", "warning", "error"]).default("default"),
  isPinned: z.boolean().default(false),
  isPublished: z.boolean().default(true),
  createdAt: z.string().optional(),
});

export const adminOverviewRoutes = new Hono<AppEnv>();

adminOverviewRoutes.get("/overview", async (c) => {
  const days = Number(c.req.query("days") || 7);
  const [[userStats], [adminStats], [disabledStats], [mediaStats], [projectStats], [assetStats], kindRows, topStorageUsers, storageConfig, consumption, latestAnnouncements] = await Promise.all([
    db.select({ totalUsers: count() }).from(users),
    db.select({ adminCount: count() }).from(users).where(and(eq(users.role, "admin"), eq(users.status, "active"))),
    db.select({ disabledUsers: count() }).from(users).where(eq(users.status, "disabled")),
    db
      .select({
        activeMediaCount: count(),
        totalStorageBytes: sql<number>`COALESCE(SUM(${mediaTotalBytesSql}), 0)::bigint`,
      })
      .from(mediaObjects)
      .where(eq(mediaObjects.status, "active")),
    db.select({ canvasProjectCount: count() }).from(canvasProjects).where(isNull(canvasProjects.deletedAt)),
    db.select({ assetCount: count() }).from(userAssets).where(isNull(userAssets.deletedAt)),
    db
      .select({
        kind: mediaObjects.kind,
        count: count(),
        bytes: sql<number>`COALESCE(SUM(${mediaTotalBytesSql}), 0)::bigint`,
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

adminOverviewRoutes.get("/announcements", async (c) => {
  const [items, notice] = await Promise.all([
    db.query.announcements.findMany({
      orderBy: [desc(announcements.isPinned), desc(announcements.createdAt)],
    }),
    getPlatformGlobalNotice(),
  ]);
  return c.json({ items, notice });
});

adminOverviewRoutes.put("/announcements/notice", zValidator("json", globalNoticeSchema), async (c) => {
  const body = c.req.valid("json");
  const notice = await savePlatformGlobalNotice(body, c.get("user").id);
  return c.json({ notice });
});

adminOverviewRoutes.post("/announcements", zValidator("json", announcementSchema), async (c) => {
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

adminOverviewRoutes.patch("/announcements/:id", zValidator("json", announcementSchema.partial()), async (c) => {
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

adminOverviewRoutes.delete("/announcements/:id", async (c) => {
  const id = c.req.param("id");
  const [deleted] = await db.delete(announcements).where(eq(announcements.id, id)).returning({ id: announcements.id });
  if (!deleted) return c.json({ error: "公告不存在" }, 404);
  return c.json({ ok: true });
});

