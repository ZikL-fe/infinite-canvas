/** 「我的素材」云端增量同步与软删除接口。 */
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db, mediaObjects, userAssets } from "../db/index.ts";
import { cleanupOrphanedUserMedia, extractStorageKeys } from "../lib/media-cleanup.ts";
import { requireAuth, type AppEnv } from "../middleware/auth.ts";

const upsertAssetSchema = z.object({
  kind: z.enum(["text", "image", "video"]),
  title: z.string().max(200),
  coverUrl: z.string().default(""),
  tags: z.array(z.string()).default([]),
  source: z.string().optional(),
  note: z.string().optional(),
  data: z.record(z.unknown()).default({}),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const assetRoutes = new Hono<AppEnv>();

assetRoutes.use("*", requireAuth);

assetRoutes.get("/", async (c) => {
  const user = c.get("user");
  const rows = await db.query.userAssets.findMany({
    where: eq(userAssets.userId, user.id),
    orderBy: [desc(userAssets.updatedAt)],
  });

  const assets = rows
    .filter((row) => !row.deletedAt)
    .map((row) => {
      const storedData = row.data as Record<string, unknown> & { metadata?: Record<string, unknown> };
      const { metadata, ...restData } = storedData;
      return {
        id: row.id,
        kind: row.kind,
        title: row.title,
        coverUrl: row.coverUrl,
        tags: row.tags,
        source: row.source ?? undefined,
        note: row.note ?? undefined,
        data: restData,
        metadata,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });

  const deletedIds = rows.filter((row) => row.deletedAt).map((row) => ({ id: row.id, deletedAt: row.deletedAt!.toISOString() }));
  return c.json({ assets, deletedIds });
});

assetRoutes.put("/:id", zValidator("json", upsertAssetSchema), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = c.req.valid("json");

  const existing = await db.query.userAssets.findFirst({ where: eq(userAssets.id, id) });
  if (existing && existing.userId !== user.id) {
    return c.json({ error: "无权修改该素材" }, 403);
  }

  const oldKeys = new Set<string>();
  if (existing?.mediaId) oldKeys.add(existing.mediaId);
  if (existing?.data) extractStorageKeys(existing.data, oldKeys);

  const rawStorageKey = typeof body.data.storageKey === "string" ? body.data.storageKey : null;
  let validMediaId: string | null = null;
  if (rawStorageKey) {
    const media = await db.query.mediaObjects.findFirst({
      where: and(eq(mediaObjects.id, rawStorageKey), eq(mediaObjects.userId, user.id)),
      columns: { id: true },
    });
    if (media) validMediaId = media.id;
  }

  const mergedData: Record<string, unknown> = {
    ...body.data,
    ...(body.metadata ? { metadata: body.metadata } : {}),
  };

  const createdAt = body.createdAt ? new Date(body.createdAt) : new Date();
  const updatedAt = body.updatedAt ? new Date(body.updatedAt) : new Date();

  if (!existing) {
    await db.insert(userAssets).values({
      id,
      userId: user.id,
      kind: body.kind,
      title: body.title,
      mediaId: validMediaId,
      coverUrl: body.coverUrl,
      tags: body.tags,
      source: body.source ?? null,
      note: body.note ?? null,
      data: mergedData,
      createdAt,
      updatedAt,
    });
    return c.json({ ok: true, deletedMediaCount: 0 });
  } else if (existing.deletedAt) {
    return c.json({ ok: true, skippedDeleted: true, deletedMediaCount: 0 });
  }

  const newKeys = new Set<string>();
  if (validMediaId) newKeys.add(validMediaId);
  extractStorageKeys(mergedData, newKeys);
  const removedKeys = Array.from(oldKeys).filter((key) => !newKeys.has(key));

  await db
    .update(userAssets)
    .set({
      kind: body.kind,
      title: body.title,
      mediaId: validMediaId,
      coverUrl: body.coverUrl,
      tags: body.tags,
      source: body.source ?? null,
      note: body.note ?? null,
      data: mergedData,
      updatedAt,
    })
    .where(and(eq(userAssets.id, id), eq(userAssets.userId, user.id)));

  const deletedMediaCount = await cleanupOrphanedUserMedia(user.id, removedKeys);
  return c.json({ ok: true, deletedMediaCount });
});

const batchDeleteAssetsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});

async function softDeleteUserAssets(userId: string, rawIds: string[]) {
  const ids = Array.from(new Set(rawIds));
  const existingRows = await db.query.userAssets.findMany({
    where: inArray(userAssets.id, ids),
  });
  if (existingRows.some((row) => row.userId !== userId)) {
    return { forbidden: true as const, deletedCount: 0, deletedMediaCount: 0 };
  }

  const now = new Date();
  const candidateKeys = new Set<string>();
  const existingIds = new Set<string>();
  for (const row of existingRows) {
    existingIds.add(row.id);
    if (row.mediaId) candidateKeys.add(row.mediaId);
    extractStorageKeys(row.data, candidateKeys);
  }

  if (existingRows.length) {
    await db
      .update(userAssets)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(inArray(userAssets.id, existingRows.map((row) => row.id)), eq(userAssets.userId, userId)));
  }

  const missingIds = ids.filter((id) => !existingIds.has(id));
  if (missingIds.length) {
    await db
      .insert(userAssets)
      .values(
        missingIds.map((id) => ({
          id,
          userId,
          kind: "text" as const,
          title: "已删除素材",
          deletedAt: now,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing();
  }

  const deletedMediaCount = await cleanupOrphanedUserMedia(userId, candidateKeys);
  return { forbidden: false as const, deletedCount: ids.length, deletedMediaCount };
}

assetRoutes.post("/batch-delete", zValidator("json", batchDeleteAssetsSchema), async (c) => {
  const user = c.get("user");
  const { ids } = c.req.valid("json");
  const result = await softDeleteUserAssets(user.id, ids);
  if (result.forbidden) {
    return c.json({ error: "无权删除该素材" }, 403);
  }
  return c.json({ ok: true, deletedCount: result.deletedCount, deletedMediaCount: result.deletedMediaCount });
});

assetRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const result = await softDeleteUserAssets(user.id, [id]);
  if (result.forbidden) {
    return c.json({ error: "无权删除该素材" }, 403);
  }
  return c.json({ ok: true, deletedMediaCount: result.deletedMediaCount });
});
