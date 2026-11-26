/** 管理后台：全站媒体文件、工作区数据审计清理与全站消费日志路由。 */
import { and, count, desc, eq, ilike, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";

import { canvasProjects, db, mediaObjects, users, workbenchLogs } from "../../db/index.ts";
import { queryCreditLedger } from "../../lib/billing.ts";
import {
  cleanupOrphanedUserMedia,
  collectUserMediaReferences,
  deleteMediaRowsWithQuota,
  extractStorageKeys,
  getMediaTotalBytes,
  loadUserMediaByteMap,
  mediaTotalBytesSql,
  summarizeWorkspaceMedia,
  type MediaSourceModule,
} from "../../lib/media-cleanup.ts";
import { createMediaReadUrl } from "../../lib/s3.ts";
import { getS3StorageConfig } from "../../lib/settings.ts";
import type { AppEnv } from "../../middleware/auth.ts";

export const adminMediaLogsRoutes = new Hono<AppEnv>();

adminMediaLogsRoutes.get("/media", async (c) => {
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
        filteredBytes: sql<number>`COALESCE(SUM(${mediaTotalBytesSql}), 0)::double precision`,
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

adminMediaLogsRoutes.get("/workspace-data", async (c) => {
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

adminMediaLogsRoutes.delete("/workspace-data/:kind/:id", async (c) => {
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

adminMediaLogsRoutes.delete("/media/:id", async (c) => {
  const mediaId = c.req.param("id");
  const media = await db.query.mediaObjects.findFirst({ where: eq(mediaObjects.id, mediaId) });
  if (!media || media.status === "deleted") {
    return c.json({ error: "媒体文件不存在" }, 404);
  }

  const { failedCount, firstError } = await deleteMediaRowsWithQuota([media]);
  if (failedCount > 0) {
    return c.json({ error: `对象存储删除失败：${firstError}` }, 502);
  }

  return c.json({ ok: true });
});

adminMediaLogsRoutes.get("/logs", async (c) => {
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
