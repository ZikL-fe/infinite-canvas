/** 生图与视频工作台生成历史云端同步及级联删除接口。 */
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db, workbenchLogs } from "../db/index.ts";
import { cleanupOrphanedUserMedia, extractStorageKeys, loadUserMediaByteMap, summarizeWorkspaceMedia } from "../lib/media-cleanup.ts";
import { requireAuth, type AppEnv } from "../middleware/auth.ts";

const upsertLogSchema = z.object({
  kind: z.enum(["image", "video"]),
  title: z.string().max(200).default(""),
  prompt: z.string().max(20000).default(""),
  model: z.string().max(200).default(""),
  status: z.enum(["pending", "success", "failed"]).default("success"),
  durationMs: z.number().nonnegative().default(0),
  payload: z.record(z.unknown()).default({}),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

const batchDeleteSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(200),
  kind: z.enum(["image", "video"]).optional(),
});

export const workbenchRoutes = new Hono<AppEnv>();

workbenchRoutes.use("*", requireAuth);

workbenchRoutes.get("/logs", async (c) => {
  const user = c.get("user");
  const kindRaw = c.req.query("kind")?.trim();
  const kind = kindRaw === "image" || kindRaw === "video" ? kindRaw : undefined;
  const withStats = c.req.query("withStats") === "1";

  const rows = await db.query.workbenchLogs.findMany({
    where: kind ? and(eq(workbenchLogs.userId, user.id), eq(workbenchLogs.kind, kind)) : eq(workbenchLogs.userId, user.id),
    orderBy: [desc(workbenchLogs.createdAt)],
  });
  const byteMap = withStats ? await loadUserMediaByteMap([user.id]) : null;

  const logs = rows
    .filter((row) => !row.deletedAt)
    .map((row) => ({
      ...row.payload,
      id: row.id,
      kind: row.kind,
      title: row.title,
      prompt: row.prompt,
      model: row.model,
      status: row.status,
      durationMs: row.durationMs,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.toISOString(),
      ...(byteMap
        ? summarizeWorkspaceMedia(user.id, byteMap, row.payload, {
            title: row.title,
            prompt: row.prompt,
            payload: row.payload,
          })
        : {}),
    }));

  const deletedIds = rows
    .filter((row) => row.deletedAt)
    .map((row) => ({ id: row.id, deletedAt: row.deletedAt!.toISOString() }));

  return c.json({ logs, deletedIds });
});

workbenchRoutes.put("/logs/:id", zValidator("json", upsertLogSchema), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = c.req.valid("json");

  const existing = await db.query.workbenchLogs.findFirst({ where: eq(workbenchLogs.id, id) });
  if (existing && existing.userId !== user.id) {
    return c.json({ error: "无权修改该工作台记录" }, 403);
  }

  const createdAt = body.createdAt ? new Date(body.createdAt) : new Date();
  const updatedAt = body.updatedAt ? new Date(body.updatedAt) : new Date();
  const durationMs = Math.round(body.durationMs);

  if (!existing) {
    await db.insert(workbenchLogs).values({
      id,
      userId: user.id,
      kind: body.kind,
      title: body.title,
      prompt: body.prompt,
      model: body.model,
      status: body.status,
      durationMs,
      payload: body.payload,
      createdAt,
      updatedAt,
    });
    return c.json({ ok: true, deletedMediaCount: 0 });
  }

  // 已删除工作台记录不再允许被迟到的自动保存重新恢复
  if (existing.deletedAt) {
    return c.json({ ok: true, skippedDeleted: true, deletedMediaCount: 0 });
  }

  // 已完成/失败的记录不再允许被迟到的 pending 自动保存覆盖回退
  if (existing.status !== "pending" && body.status === "pending") {
    return c.json({ ok: true, skippedStale: true, deletedMediaCount: 0 });
  }

  const oldKeys = extractStorageKeys(existing.payload);
  const newKeys = extractStorageKeys(body.payload);
  const removedKeys = Array.from(oldKeys).filter((key) => !newKeys.has(key));

  await db
    .update(workbenchLogs)
    .set({
      kind: body.kind,
      title: body.title,
      prompt: body.prompt,
      model: body.model,
      status: body.status,
      durationMs,
      payload: body.payload,
      updatedAt,
    })
    .where(and(eq(workbenchLogs.id, id), eq(workbenchLogs.userId, user.id)));

  const deletedMediaCount = await cleanupOrphanedUserMedia(user.id, removedKeys);
  return c.json({ ok: true, deletedMediaCount });
});

workbenchRoutes.post("/logs/batch-delete", zValidator("json", batchDeleteSchema), async (c) => {
  const user = c.get("user");
  const { ids, kind } = c.req.valid("json");
  const now = new Date();

  const existing = await db.query.workbenchLogs.findMany({
    where: and(eq(workbenchLogs.userId, user.id), inArray(workbenchLogs.id, ids)),
  });
  const existingSet = new Set(existing.map((row) => row.id));
  const candidateKeys = new Set<string>();
  for (const row of existing) {
    extractStorageKeys(row.payload, candidateKeys);
  }

  if (existing.length) {
    await db
      .update(workbenchLogs)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(workbenchLogs.userId, user.id), inArray(workbenchLogs.id, [...existingSet])));
  }

  const missingIds = ids.filter((id) => !existingSet.has(id));
  if (missingIds.length) {
    await db
      .insert(workbenchLogs)
      .values(
        missingIds.map((id) => ({
          id,
          userId: user.id,
          kind: kind || "image",
          title: "已删除记录",
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

workbenchRoutes.delete("/logs/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const kindRaw = c.req.query("kind")?.trim();
  const fallbackKind = kindRaw === "video" ? "video" : "image";
  const existing = await db.query.workbenchLogs.findFirst({ where: eq(workbenchLogs.id, id) });
  if (existing && existing.userId !== user.id) {
    return c.json({ error: "无权删除该工作台记录" }, 403);
  }
  const now = new Date();
  const candidateKeys = new Set<string>();
  if (existing) {
    extractStorageKeys(existing.payload, candidateKeys);
    await db
      .update(workbenchLogs)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(workbenchLogs.id, id), eq(workbenchLogs.userId, user.id)));
  } else {
    await db
      .insert(workbenchLogs)
      .values({
        id,
        userId: user.id,
        kind: fallbackKind,
        title: "已删除记录",
        deletedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }
  const deletedMediaCount = await cleanupOrphanedUserMedia(user.id, candidateKeys);
  return c.json({ ok: true, deletedMediaCount });
});
