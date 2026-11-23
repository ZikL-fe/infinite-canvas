/** 画布项目云端保存、增量拉取与批量删除接口。 */
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { canvasProjects, db } from "../db/index.ts";
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
});

const batchDeleteSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
});

export const canvasRoutes = new Hono<AppEnv>();

canvasRoutes.use("*", requireAuth);

canvasRoutes.get("/projects", async (c) => {
  const user = c.get("user");
  const rows = await db.query.canvasProjects.findMany({
    where: eq(canvasProjects.userId, user.id),
    orderBy: [desc(canvasProjects.updatedAt)],
  });

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
    }));

  const deletedProjects = rows
    .filter((row) => row.deletedAt)
    .map((row) => ({
      id: row.id,
      deletedAt: row.deletedAt!.toISOString(),
    }));

  return c.json({ projects, deletedProjects });
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
  const updatedAt = body.updatedAt ? new Date(body.updatedAt) : new Date();

  if (!existing) {
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
    return c.json({
      project: {
        ...created,
        createdAt: created.createdAt.toISOString(),
        updatedAt: created.updatedAt.toISOString(),
      },
    });
  }

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
      deletedAt: null,
      updatedAt,
    })
    .where(and(eq(canvasProjects.id, id), eq(canvasProjects.userId, user.id)))
    .returning();

  return c.json({
    project: {
      ...updated,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    },
  });
});

canvasRoutes.post("/projects/batch-delete", zValidator("json", batchDeleteSchema), async (c) => {
  const user = c.get("user");
  const { ids } = c.req.valid("json");
  const now = new Date();

  const existing = await db.query.canvasProjects.findMany({
    where: and(eq(canvasProjects.userId, user.id), inArray(canvasProjects.id, ids)),
    columns: { id: true },
  });
  const existingSet = new Set(existing.map((item) => item.id));

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

  return c.json({ ok: true });
});

canvasRoutes.delete("/projects/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const existing = await db.query.canvasProjects.findFirst({ where: eq(canvasProjects.id, id) });
  if (existing && existing.userId !== user.id) {
    return c.json({ error: "无权删除该画布项目" }, 403);
  }
  const now = new Date();
  if (existing) {
    await db
      .update(canvasProjects)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(canvasProjects.id, id), eq(canvasProjects.userId, user.id)));
  }
  return c.json({ ok: true });
});
