/** 「我的素材」云端增量同步与软删除接口。 */
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db, mediaObjects, userAssets } from "../db/index.ts";
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
  } else {
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
        deletedAt: null,
        updatedAt,
      })
      .where(and(eq(userAssets.id, id), eq(userAssets.userId, user.id)));
  }

  return c.json({ ok: true });
});

assetRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const existing = await db.query.userAssets.findFirst({ where: eq(userAssets.id, id) });
  if (existing && existing.userId !== user.id) {
    return c.json({ error: "无权删除该素材" }, 403);
  }
  const now = new Date();
  if (existing) {
    await db
      .update(userAssets)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(userAssets.id, id), eq(userAssets.userId, user.id)));
  } else {
    await db
      .insert(userAssets)
      .values({
        id,
        userId: user.id,
        kind: "text",
        title: "已删除素材",
        deletedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  }
  return c.json({ ok: true });
});
