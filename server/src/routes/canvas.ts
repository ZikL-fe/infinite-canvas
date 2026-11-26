/** 画布项目云端保存、增量拉取与批量删除接口。 */
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { canvasProjects, db } from "../db/index.ts";
import { cleanupOrphanedUserMedia, extractStorageKeys, loadUserMediaByteMap, summarizeWorkspaceMedia } from "../lib/media-cleanup.ts";
import { parseSinceParam, resolveServerUpdatedAt } from "../lib/sync-cursor.ts";
import { requireAuth, type AppEnv } from "../middleware/auth.ts";

const upsertProjectSchema = z.object({
  title: z.string().min(1).max(200),
  nodes: z.array(z.unknown()).default([]),
  connections: z.array(z.unknown()).default([]),
  chatSessions: z.array(z.unknown()).default([]),
  activeChatId: z.string().nullable().optional().default(null),
  backgroundMode: z.string().default("lines"),
  showImageInfo: z.boolean().default(false),
  viewport: z
    .object({
      x: z.number(),
      y: z.number(),
      k: z.number(),
    })
    .default({ x: 0, y: 0, k: 1 }),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  removedMediaKeys: z.array(z.string().min(1)).max(500).optional().default([]),
});

const batchDeleteSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
});

export const canvasRoutes = new Hono<AppEnv>();

canvasRoutes.use("*", requireAuth);

canvasRoutes.get("/projects", async (c) => {
  const user = c.get("user");
  const withStats = c.req.query("withStats") === "1";
  const sinceDate = withStats ? null : parseSinceParam(c.req.query("updatedSince"));
  const syncedAt = new Date().toISOString();
  const rows = await db.query.canvasProjects.findMany({
    where: sinceDate
      ? and(eq(canvasProjects.userId, user.id), gte(canvasProjects.updatedAt, sinceDate))
      : eq(canvasProjects.userId, user.id),
    orderBy: [desc(canvasProjects.updatedAt)],
  });
  const byteMap = withStats ? await loadUserMediaByteMap([user.id]) : null;

  const projects = rows
    .filter((row) => !row.deletedAt)
    .map((row) => ({
      id: row.id,
      title: row.title,
      nodes: row.nodes,
      connections: row.connections,
      chatSessions: row.chatSessions,
      activeChatId: row.activeChatId,
      backgroundMode: row.backgroundMode,
      showImageInfo: row.showImageInfo,
      viewport: row.viewport,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      ...(byteMap
        ? summarizeWorkspaceMedia(user.id, byteMap, [row.nodes, row.chatSessions], {
            title: row.title,
            nodes: row.nodes,
            connections: row.connections,
            chatSessions: row.chatSessions,
          })
        : {}),
    }));

  const deletedProjects = rows
    .filter((row) => row.deletedAt)
    .map((row) => ({
      id: row.id,
      deletedAt: row.deletedAt!.toISOString(),
    }));

  return c.json({ projects, deletedProjects, incremental: Boolean(sinceDate), syncedAt });
});

canvasRoutes.put("/projects/:id", zValidator("json", upsertProjectSchema), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = c.req.valid("json");

  const existing = await db.query.canvasProjects.findFirst({ where: eq(canvasProjects.id, id) });
  if (existing && existing.userId !== user.id) {
    return c.json({ error: "无权修改该画布项目" }, 403);
  }

  const createdAt = body.createdAt ? new Date(body.createdAt) : new Date();
  const updatedAt = resolveServerUpdatedAt();

  if (!existing) {
    const newKeys = extractStorageKeys([body.nodes, body.chatSessions]);
    const removedKeys = body.removedMediaKeys.filter((key) => !newKeys.has(key));
    const [created] = await db
      .insert(canvasProjects)
      .values({
        id,
        userId: user.id,
        title: body.title,
        nodes: body.nodes,
        connections: body.connections,
        chatSessions: body.chatSessions,
        activeChatId: body.activeChatId ?? null,
        backgroundMode: body.backgroundMode,
        showImageInfo: body.showImageInfo,
        viewport: body.viewport,
        version: 1,
        createdAt,
        updatedAt,
      })
      .returning();
    const deletedMediaCount = await cleanupOrphanedUserMedia(user.id, removedKeys);
    return c.json({
      project: {
        ...created,
        createdAt: created.createdAt.toISOString(),
        updatedAt: created.updatedAt.toISOString(),
      },
      deletedMediaCount,
    });
  }

  // 已删除画布不再允许被迟到的自动保存重新恢复
  if (existing.deletedAt) {
    return c.json({ project: null, skippedDeleted: true, deletedMediaCount: 0 });
  }

  const oldKeys = extractStorageKeys([existing.nodes, existing.chatSessions]);
  const newKeys = extractStorageKeys([body.nodes, body.chatSessions]);
  const removedKeys = Array.from(new Set([...oldKeys, ...body.removedMediaKeys])).filter((key) => !newKeys.has(key));

  const [updated] = await db
    .update(canvasProjects)
    .set({
      title: body.title,
      nodes: body.nodes,
      connections: body.connections,
      chatSessions: body.chatSessions,
      activeChatId: body.activeChatId ?? null,
      backgroundMode: body.backgroundMode,
      showImageInfo: body.showImageInfo,
      viewport: body.viewport,
      version: existing.version + 1,
      updatedAt,
    })
    .where(and(eq(canvasProjects.id, id), eq(canvasProjects.userId, user.id)))
    .returning();

  const deletedMediaCount = await cleanupOrphanedUserMedia(user.id, removedKeys);

  return c.json({
    project: {
      ...updated,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    },
    deletedMediaCount,
  });
});

canvasRoutes.post("/projects/batch-delete", zValidator("json", batchDeleteSchema), async (c) => {
  const user = c.get("user");
  const { ids } = c.req.valid("json");
  const now = new Date();

  const existing = await db.query.canvasProjects.findMany({
    where: and(eq(canvasProjects.userId, user.id), inArray(canvasProjects.id, ids)),
    columns: { id: true, nodes: true, chatSessions: true },
  });
  const existingSet = new Set(existing.map((item) => item.id));
  const candidateKeys = new Set<string>();
  for (const project of existing) {
    extractStorageKeys([project.nodes, project.chatSessions], candidateKeys);
  }

  if (existing.length) {
    await db
      .update(canvasProjects)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(canvasProjects.userId, user.id), inArray(canvasProjects.id, [...existingSet])));
  }

  // 为仅在本地存在过再被删除的 ID 也写入墓碑，避免多端再次同步恢复
  const missingIds = ids.filter((id) => !existingSet.has(id));
  if (missingIds.length) {
    await db
      .insert(canvasProjects)
      .values(
        missingIds.map((id) => ({
          id,
          userId: user.id,
          title: "已删除画布",
          deletedAt: now,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing();
  }

  const deletedMediaCount = await cleanupOrphanedUserMedia(user.id, candidateKeys);
  return c.json({ ok: true, deletedMediaCount });
});

canvasRoutes.delete("/projects/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const existing = await db.query.canvasProjects.findFirst({ where: eq(canvasProjects.id, id) });
  if (existing && existing.userId !== user.id) {
    return c.json({ error: "无权删除该画布项目" }, 403);
  }
  const now = new Date();
  const candidateKeys = new Set<string>();
  if (existing) {
    extractStorageKeys([existing.nodes, existing.chatSessions], candidateKeys);
    await db
      .update(canvasProjects)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(canvasProjects.id, id), eq(canvasProjects.userId, user.id)));
  } else {
    await db
      .insert(canvasProjects)
      .values({
        id,
        userId: user.id,
        title: "已删除画布",
        deletedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }
  const deletedMediaCount = await cleanupOrphanedUserMedia(user.id, candidateKeys);
  return c.json({ ok: true, deletedMediaCount });
});
