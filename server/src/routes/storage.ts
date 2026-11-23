/** 云端媒体存储接口：S3 预签名直传、远端抓取转存、WebDAV 生成素材自动归档及配额统计。 */
import { zValidator } from "@hono/zod-validator";
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";

import { canvasProjects, creditLedger, db, mediaObjects, userAssets, users, workbenchLogs, type MediaKind } from "../db/index.ts";
import { env } from "../env.ts";
import { buildThumbnailObjectKey, checkStorageQuotaBlock } from "../lib/ai-media-persist.ts";
import { collectUserMediaReferences, type MediaSourceModule } from "../lib/media-cleanup.ts";
import {
  createMediaReadUrl,
  createPresignedUploadUrl,
  deleteS3Object,
  getS3Object,
  headS3Object,
  putS3Object,
} from "../lib/s3.ts";
import { getPlatformWebdavConfig, getS3StorageConfig, resolveEffectiveUserWebdav } from "../lib/settings.ts";
import { uploadFileToWebdav } from "../lib/webdav.ts";
import { requireAuth, type AppEnv } from "../middleware/auth.ts";

const presignUploadSchema = z.object({
  mediaId: z
    .string()
    .regex(/^[a-z0-9_-]+:[a-zA-Z0-9_-]+$/, "mediaId 格式不正确")
    .optional(),
  filename: z.string().max(255).optional(),
  kind: z.enum(["image", "video", "audio", "file"]).default("file"),
  mimeType: z.string().min(1).max(128).default("application/octet-stream"),
  bytes: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  sourceType: z.enum(["upload", "ai_generated", "canvas_import"]).optional().default("upload"),
});

const checkExistsSchema = z.object({
  mediaIds: z.array(z.string().min(1)).max(200),
});

const confirmUploadSchema = z.object({
  mediaId: z.string().min(1),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

const ingestUrlSchema = z.object({
  url: z.string().url("请输入有效的资源链接"),
  kind: z.enum(["image", "video", "audio", "file"]).optional(),
  sourceType: z.enum(["upload", "ai_generated", "canvas_import"]).optional().default("ai_generated"),
});

const batchUrlsSchema = z.object({
  mediaIds: z.array(z.string().min(1)).max(100),
});

function inferExtension(filename: string | undefined, mimeType: string) {
  const fromName = filename?.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (fromName && fromName.length <= 10) return `.${fromName}`;
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/ogg": ".ogg",
  };
  return map[mimeType.toLowerCase()] || "";
}

function buildObjectKey(userId: string, kind: MediaKind, ext: string) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `users/${userId}/${yyyy}/${mm}/${kind}/${nanoid()}${ext}`;
}

function inferKindFromMime(mimeType: string, fallback: MediaKind = "file"): MediaKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return fallback;
}

export const storageRoutes = new Hono<AppEnv>();

storageRoutes.use("*", requireAuth);

storageRoutes.post("/presign-upload", zValidator("json", presignUploadSchema), async (c) => {
  const config = await getS3StorageConfig();
  if (!config) {
    return c.json({ error: "管理员尚未配置对象存储" }, 503);
  }

  const user = c.get("user");
  const body = c.req.valid("json");
  const mediaId = body.mediaId || `${body.kind}:${nanoid()}`;

  if (body.mediaId) {
    const existing = await db.query.mediaObjects.findFirst({ where: eq(mediaObjects.id, mediaId) });
    if (existing) {
      if (existing.userId !== user.id) {
        return c.json({ error: "媒体标识冲突" }, 409);
      }
      if (existing.status === "active") {
        return c.json({
          alreadyExists: true,
          mediaId,
          objectKey: existing.objectKey,
          uploadUrl: "",
          expiresIn: 0,
          headers: {},
        });
      }
      const block = checkStorageQuotaBlock(user.storageUsedBytes, user.storageQuotaBytes, user.storageQuotaExpiresAt, body.bytes ?? existing.bytes);
      if (block.blocked) {
        return c.json(
          {
            error: block.error,
            code: block.code,
            storageUsedBytes: user.storageUsedBytes,
            storageQuotaBytes: user.storageQuotaBytes,
          },
          403,
        );
      }
      const uploadUrl = await createPresignedUploadUrl(config, existing.objectKey, body.mimeType);
      return c.json({
        alreadyExists: false,
        mediaId,
        objectKey: existing.objectKey,
        uploadUrl,
        expiresIn: env.S3_PRESIGN_EXPIRES_SECONDS,
        headers: { "Content-Type": body.mimeType },
      });
    }
  }

  const block = checkStorageQuotaBlock(user.storageUsedBytes, user.storageQuotaBytes, user.storageQuotaExpiresAt, body.bytes ?? 0);
  if (block.blocked) {
    return c.json(
      {
        error: block.error,
        code: block.code,
        storageUsedBytes: user.storageUsedBytes,
        storageQuotaBytes: user.storageQuotaBytes,
      },
      403,
    );
  }

  const ext = inferExtension(body.filename, body.mimeType);
  const objectKey = buildObjectKey(user.id, body.kind, ext);

  await db.insert(mediaObjects).values({
    id: mediaId,
    userId: user.id,
    bucket: config.bucket,
    objectKey,
    kind: body.kind,
    mimeType: body.mimeType,
    bytes: body.bytes ?? 0,
    width: body.width ?? null,
    height: body.height ?? null,
    durationMs: body.durationMs ?? null,
    sourceType: body.sourceType,
    status: "pending",
  });

  const uploadUrl = await createPresignedUploadUrl(config, objectKey, body.mimeType);
  return c.json({
    alreadyExists: false,
    mediaId,
    objectKey,
    uploadUrl,
    expiresIn: env.S3_PRESIGN_EXPIRES_SECONDS,
    headers: { "Content-Type": body.mimeType },
  });
});

storageRoutes.post("/check-exists", zValidator("json", checkExistsSchema), async (c) => {
  const user = c.get("user");
  const { mediaIds } = c.req.valid("json");
  if (!mediaIds.length) return c.json({ existingIds: [] });

  const rows = await db
    .select({ id: mediaObjects.id })
    .from(mediaObjects)
    .where(and(eq(mediaObjects.userId, user.id), eq(mediaObjects.status, "active"), inArray(mediaObjects.id, mediaIds)));

  return c.json({ existingIds: rows.map((row) => row.id) });
});

storageRoutes.post("/confirm", zValidator("json", confirmUploadSchema), async (c) => {
  const config = await getS3StorageConfig();
  if (!config) {
    return c.json({ error: "管理员尚未配置对象存储" }, 503);
  }

  const user = c.get("user");
  const body = c.req.valid("json");
  const existing = await db.query.mediaObjects.findFirst({
    where: and(eq(mediaObjects.id, body.mediaId), eq(mediaObjects.userId, user.id)),
  });
  if (!existing || existing.status === "deleted") {
    return c.json({ error: "媒体记录不存在" }, 404);
  }

  let actualBytes = existing.bytes;
  let actualMime = existing.mimeType;
  try {
    const head = await headS3Object(config, existing.objectKey);
    if (typeof head.ContentLength === "number") actualBytes = head.ContentLength;
    if (head.ContentType) actualMime = head.ContentType;
  } catch {
    return c.json({ error: "对象存储中未找到已上传的文件，请确认是否已直传成功或检查桶 CORS 配置" }, 400);
  }

  if (existing.status === "pending") {
    const block = checkStorageQuotaBlock(user.storageUsedBytes, user.storageQuotaBytes, user.storageQuotaExpiresAt, actualBytes);
    if (block.blocked) {
      await deleteS3Object(config, existing.objectKey).catch(() => undefined);
      await db.update(mediaObjects).set({ status: "deleted" }).where(eq(mediaObjects.id, existing.id));
      return c.json(
        {
          error: block.error,
          code: block.code,
          storageUsedBytes: user.storageUsedBytes,
          storageQuotaBytes: user.storageQuotaBytes,
        },
        403,
      );
    }
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(mediaObjects)
      .set({
        status: "active",
        bytes: actualBytes,
        mimeType: actualMime,
        width: body.width ?? existing.width,
        height: body.height ?? existing.height,
        durationMs: body.durationMs ?? existing.durationMs,
      })
      .where(and(eq(mediaObjects.id, existing.id), eq(mediaObjects.userId, user.id)))
      .returning();

    let storageUsedBytes = user.storageUsedBytes;
    if (existing.status === "pending" && actualBytes > 0) {
      const [u] = await tx
        .update(users)
        .set({
          storageUsedBytes: sql`${users.storageUsedBytes} + ${actualBytes}`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id))
        .returning({ storageUsedBytes: users.storageUsedBytes });
      if (u) storageUsedBytes = u.storageUsedBytes;
    }

    return { row, storageUsedBytes };
  });

  const url = await createMediaReadUrl(config, updated.row.objectKey);
  return c.json({ media: updated.row, url, storageUsedBytes: updated.storageUsedBytes, storageQuotaBytes: user.storageQuotaBytes });
});

storageRoutes.post("/ingest-url", zValidator("json", ingestUrlSchema), async (c) => {
  const config = await getS3StorageConfig();
  if (!config) {
    return c.json({ error: "管理员尚未配置对象存储" }, 503);
  }

  const user = c.get("user");
  const preBlock = checkStorageQuotaBlock(user.storageUsedBytes, user.storageQuotaBytes, user.storageQuotaExpiresAt, 0);
  if (preBlock.blocked) {
    return c.json(
      {
        error: preBlock.error,
        code: preBlock.code,
        storageUsedBytes: user.storageUsedBytes,
        storageQuotaBytes: user.storageQuotaBytes,
      },
      403,
    );
  }

  const body = c.req.valid("json");
  const parsedUrl = new URL(body.url);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return c.json({ error: "仅支持 http/https 资源链接转存" }, 400);
  }

  const remoteRes = await fetch(parsedUrl.toString());
  if (!remoteRes.ok) {
    return c.json({ error: `拉取远程资源失败（HTTP ${remoteRes.status}）` }, 400);
  }

  const mimeType = remoteRes.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
  const kind = body.kind || inferKindFromMime(mimeType, "file");
  const ext = inferExtension(parsedUrl.pathname, mimeType);
  const objectKey = buildObjectKey(user.id, kind, ext);
  const mediaId = `${kind}:${nanoid()}`;
  const buffer = Buffer.from(await remoteRes.arrayBuffer());

  const postBlock = checkStorageQuotaBlock(user.storageUsedBytes, user.storageQuotaBytes, user.storageQuotaExpiresAt, buffer.byteLength);
  if (postBlock.blocked) {
    return c.json(
      {
        error: postBlock.error,
        code: postBlock.code,
        storageUsedBytes: user.storageUsedBytes,
        storageQuotaBytes: user.storageQuotaBytes,
      },
      403,
    );
  }

  await putS3Object(config, objectKey, buffer, mimeType);

  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(mediaObjects)
      .values({
        id: mediaId,
        userId: user.id,
        bucket: config.bucket,
        objectKey,
        kind,
        mimeType,
        bytes: buffer.byteLength,
        sourceType: body.sourceType,
        status: "active",
      })
      .returning();

    await tx
      .update(users)
      .set({
        storageUsedBytes: sql`${users.storageUsedBytes} + ${buffer.byteLength}`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    return row;
  });

  const url = await createMediaReadUrl(config, created.objectKey);
  return c.json({ media: created, url }, 201);
});

storageRoutes.get("/list", async (c) => {
  const user = c.get("user");
  const q = c.req.query("q")?.trim() || "";
  const kind = c.req.query("kind")?.trim() || "";
  const sourceType = c.req.query("sourceType")?.trim() || "";
  const moduleFilter = c.req.query("module")?.trim() || "";
  const page = Math.max(1, Number(c.req.query("page") || 1));
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query("pageSize") || 20)));
  const offset = (page - 1) * pageSize;

  const [{ moduleMap }, [canvasCount], [imageLogCount], [videoLogCount], [assetCount]] = await Promise.all([
    collectUserMediaReferences([user.id]),
    db.select({ total: count() }).from(canvasProjects).where(and(eq(canvasProjects.userId, user.id), isNull(canvasProjects.deletedAt))),
    db.select({ total: count() }).from(workbenchLogs).where(and(eq(workbenchLogs.userId, user.id), eq(workbenchLogs.kind, "image"), isNull(workbenchLogs.deletedAt))),
    db.select({ total: count() }).from(workbenchLogs).where(and(eq(workbenchLogs.userId, user.id), eq(workbenchLogs.kind, "video"), isNull(workbenchLogs.deletedAt))),
    db.select({ total: count() }).from(userAssets).where(and(eq(userAssets.userId, user.id), isNull(userAssets.deletedAt))),
  ]);

  const workspaceStats = {
    canvasProjects: Number(canvasCount?.total ?? 0),
    imageLogs: Number(imageLogCount?.total ?? 0),
    videoLogs: Number(videoLogCount?.total ?? 0),
    assets: Number(assetCount?.total ?? 0),
  };

  const filters: SQL[] = [eq(mediaObjects.userId, user.id), eq(mediaObjects.status, "active")];
  if (kind === "image" || kind === "video" || kind === "audio" || kind === "file") {
    filters.push(eq(mediaObjects.kind, kind));
  }
  if (sourceType === "upload" || sourceType === "ai_generated" || sourceType === "canvas_import") {
    filters.push(eq(mediaObjects.sourceType, sourceType));
  }
  if (moduleFilter === "canvas" || moduleFilter === "image_workbench" || moduleFilter === "video_workbench" || moduleFilter === "assets") {
    const matchedIds = Array.from(moduleMap.entries())
      .filter(([, mods]) => mods.has(moduleFilter as MediaSourceModule))
      .map(([id]) => id);
    if (!matchedIds.length) {
      return c.json({ items: [], total: 0, page, pageSize, workspaceStats });
    }
    filters.push(inArray(mediaObjects.id, matchedIds));
  }
  if (q) {
    filters.push(
      sql`(${ilike(mediaObjects.objectKey, `%${q}%`)} OR COALESCE(${mediaObjects.meta}->>'model', '') ILIKE ${`%${q}%`} OR COALESCE(${mediaObjects.meta}->>'prompt', '') ILIKE ${`%${q}%`})`,
    );
  }
  const whereClause = and(...filters);

  const [config, rows, [{ total }]] = await Promise.all([
    getS3StorageConfig(),
    db.query.mediaObjects.findMany({
      where: whereClause,
      orderBy: [desc(mediaObjects.createdAt)],
      limit: pageSize,
      offset,
    }),
    db.select({ total: count() }).from(mediaObjects).where(whereClause),
  ]);

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
  return c.json({ items, total: Number(total), page, pageSize, workspaceStats });
});

storageRoutes.post("/thumbnail/:mediaId", async (c) => {
  const config = await getS3StorageConfig();
  if (!config) {
    return c.json({ error: "管理员尚未配置对象存储" }, 503);
  }
  const user = c.get("user");
  const mediaId = c.req.param("mediaId");
  const media = await db.query.mediaObjects.findFirst({ where: eq(mediaObjects.id, mediaId) });
  if (!media || media.status === "deleted") {
    return c.json({ error: "媒体文件不存在" }, 404);
  }
  if (media.userId !== user.id && user.role !== "admin") {
    return c.json({ error: "无权更新该文件缩略图" }, 403);
  }

  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size <= 0) {
    return c.json({ error: "请上传有效的缩略图文件" }, 400);
  }
  if (file.size > 2 * 1024 * 1024) {
    return c.json({ error: "缩略图体积过大" }, 400);
  }

  const thumbObjectKey =
    typeof media.meta?.thumbObjectKey === "string" && media.meta.thumbObjectKey
      ? media.meta.thumbObjectKey
      : buildThumbnailObjectKey(media.userId, media.id);
  const buffer = Buffer.from(await file.arrayBuffer());
  await putS3Object(config, thumbObjectKey, buffer, file.type || "image/webp");

  const nextMeta = { ...(media.meta || {}), thumbObjectKey };
  await db.update(mediaObjects).set({ meta: nextMeta }).where(eq(mediaObjects.id, media.id));
  const thumbnailUrl = await createMediaReadUrl(config, thumbObjectKey);
  return c.json({ ok: true, thumbnailUrl });
});

storageRoutes.get("/thumbnail/:mediaId", async (c) => {
  const config = await getS3StorageConfig();
  if (!config) {
    return c.json({ error: "管理员尚未配置对象存储" }, 503);
  }
  const user = c.get("user");
  const mediaId = c.req.param("mediaId");
  const media = await db.query.mediaObjects.findFirst({ where: eq(mediaObjects.id, mediaId) });
  if (!media || media.status !== "active") {
    return c.json({ error: "媒体文件不存在" }, 404);
  }
  if (media.userId !== user.id && user.role !== "admin") {
    return c.json({ error: "无权访问该文件" }, 403);
  }
  const thumbKey = typeof media.meta?.thumbObjectKey === "string" ? media.meta.thumbObjectKey : "";
  const thumbnailUrl = thumbKey ? await createMediaReadUrl(config, thumbKey) : "";
  return c.json({ mediaId: media.id, thumbnailUrl });
});

storageRoutes.get("/by-tasks", async (c) => {
  const user = c.get("user");
  const raw = c.req.query("taskIds") || "";
  const taskIds = Array.from(
    new Set(
      raw
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ).slice(0, 50);

  if (!taskIds.length) {
    return c.json({ itemsByTask: {}, processingTaskIds: [] });
  }

  const [config, rows, ledgerRows] = await Promise.all([
    getS3StorageConfig(),
    db.query.mediaObjects.findMany({
      where: and(
        eq(mediaObjects.userId, user.id),
        eq(mediaObjects.status, "active"),
        sql`${mediaObjects.meta}->>'clientTaskId' IN (${sql.join(
          taskIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      ),
      orderBy: [desc(mediaObjects.createdAt)],
    }),
    db.execute<{ client_task_id: string; task_status: string }>(
      sql`SELECT meta->>'clientTaskId' AS client_task_id, meta->>'taskStatus' AS task_status FROM credit_ledger WHERE user_id = ${user.id} AND meta->>'clientTaskId' IN (${sql.join(
        taskIds.map((id) => sql`${id}`),
        sql`, `,
      )}) ORDER BY created_at DESC`,
    ),
  ]);

  const itemsByTask: Record<string, Array<Record<string, unknown>>> = {};
  await Promise.all(
    rows.map(async (row) => {
      const taskId = typeof row.meta?.clientTaskId === "string" ? row.meta.clientTaskId : "";
      if (!taskId) return;
      const thumbKey = typeof row.meta?.thumbObjectKey === "string" ? row.meta.thumbObjectKey : "";
      const [url, thumbnailUrl] = await Promise.all([
        config ? createMediaReadUrl(config, row.objectKey) : Promise.resolve(""),
        config && thumbKey ? createMediaReadUrl(config, thumbKey) : Promise.resolve(""),
      ]);
      if (!itemsByTask[taskId]) itemsByTask[taskId] = [];
      itemsByTask[taskId].push({ ...row, url, thumbnailUrl });
    }),
  );

  const processingSet = new Set<string>();
  for (const row of ledgerRows) {
    if (row.client_task_id && row.task_status === "processing" && !itemsByTask[row.client_task_id]?.length) {
      processingSet.add(row.client_task_id);
    }
  }

  return c.json({
    itemsByTask,
    processingTaskIds: [...processingSet],
  });
});

storageRoutes.get("/ledger-media/:ledgerId", async (c) => {
  const user = c.get("user");
  const ledgerId = c.req.param("ledgerId");
  const ledger = await db.query.creditLedger.findFirst({ where: eq(creditLedger.id, ledgerId) });
  if (!ledger) {
    return c.json({ items: [] });
  }
  if (ledger.userId !== user.id && user.role !== "admin") {
    return c.json({ error: "无权查看该日志关联媒体" }, 403);
  }

  const meta = ledger.meta || {};
  const mediaIds = Array.isArray(meta.mediaIds)
    ? meta.mediaIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  const clientTaskId = typeof meta.clientTaskId === "string" ? meta.clientTaskId.trim() : "";
  const taskId = typeof meta.taskId === "string" ? meta.taskId.trim() : "";

  const matchConds: SQL[] = [];
  if (mediaIds.length) {
    matchConds.push(inArray(mediaObjects.id, mediaIds));
  }
  if (clientTaskId) {
    matchConds.push(sql`${mediaObjects.meta}->>'clientTaskId' = ${clientTaskId}`);
  }
  if (taskId) {
    matchConds.push(sql`(${mediaObjects.meta}->>'videoTaskId' = ${taskId} OR ${mediaObjects.meta}->>'clientTaskId' = ${taskId})`);
  }
  if (!matchConds.length) {
    return c.json({ items: [] });
  }

  const [config, rows] = await Promise.all([
    getS3StorageConfig(),
    db.query.mediaObjects.findMany({
      where: and(
        eq(mediaObjects.userId, ledger.userId),
        eq(mediaObjects.status, "active"),
        matchConds.length === 1 ? matchConds[0] : or(...matchConds),
      ),
      orderBy: [asc(mediaObjects.createdAt)],
    }),
  ]);

  const items = await Promise.all(
    rows.map(async (row) => {
      const thumbKey = typeof row.meta?.thumbObjectKey === "string" ? row.meta.thumbObjectKey : "";
      const thumbTarget = thumbKey || (row.kind === "image" ? row.objectKey : "");
      const thumbnailUrl = config && thumbTarget ? await createMediaReadUrl(config, thumbTarget) : "";
      return {
        ...row,
        url: "",
        thumbnailUrl,
      };
    }),
  );

  return c.json({ items });
});

storageRoutes.get("/url/:mediaId", async (c) => {
  const config = await getS3StorageConfig();
  if (!config) {
    return c.json({ error: "管理员尚未配置对象存储" }, 503);
  }

  const user = c.get("user");
  const mediaId = c.req.param("mediaId");
  const media = await db.query.mediaObjects.findFirst({ where: eq(mediaObjects.id, mediaId) });
  if (!media || media.status !== "active") {
    return c.json({ error: "媒体文件不存在" }, 404);
  }
  if (media.userId !== user.id && user.role !== "admin") {
    return c.json({ error: "无权访问该文件" }, 403);
  }

  const url = await createMediaReadUrl(config, media.objectKey);
  return c.json({ mediaId: media.id, url, expiresIn: env.S3_PRESIGN_EXPIRES_SECONDS });
});

/** 经服务端鉴权代理下载原文件：隐藏底层对象存储地址与签名凭据，并强制下发 attachment 响应头。 */
storageRoutes.get("/download/:mediaId", async (c) => {
  const config = await getS3StorageConfig();
  if (!config) {
    return c.json({ error: "管理员尚未配置对象存储" }, 503);
  }

  const user = c.get("user");
  const mediaId = c.req.param("mediaId");
  const media = await db.query.mediaObjects.findFirst({ where: eq(mediaObjects.id, mediaId) });
  if (!media || media.status !== "active") {
    return c.json({ error: "媒体文件不存在" }, 404);
  }
  if (media.userId !== user.id && user.role !== "admin") {
    return c.json({ error: "无权访问该文件" }, 403);
  }

  const obj = await getS3Object(config, media.objectKey);
  const stream = obj.Body?.transformToWebStream();
  if (!stream) {
    return c.json({ error: "媒体文件流不可用" }, 502);
  }

  const ext = media.mimeType?.split("/")[1]?.split("+")[0] || (media.kind === "video" ? "mp4" : media.kind === "audio" ? "mp3" : "png");
  const filename = media.objectKey.split("/").pop() || `media-${media.id.replace(/:/g, "_")}.${ext}`;
  const asciiName = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const headers = new Headers({
    "Content-Type": obj.ContentType || media.mimeType || "application/octet-stream",
    "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Cache-Control": "private, no-store",
  });
  if (typeof obj.ContentLength === "number" && obj.ContentLength > 0) {
    headers.set("Content-Length", String(obj.ContentLength));
  }

  return new Response(stream, { status: 200, headers });
});

storageRoutes.post("/urls", zValidator("json", batchUrlsSchema), async (c) => {
  const config = await getS3StorageConfig();
  if (!config) {
    return c.json({ error: "管理员尚未配置对象存储" }, 503);
  }

  const user = c.get("user");
  const { mediaIds } = c.req.valid("json");
  if (!mediaIds.length) return c.json({ urls: {} });

  const rows = await db.query.mediaObjects.findMany({
    where: and(inArray(mediaObjects.id, mediaIds), eq(mediaObjects.status, "active")),
  });

  const urls: Record<string, string> = {};
  await Promise.all(
    rows
      .filter((row) => row.userId === user.id || user.role === "admin")
      .map(async (row) => {
        urls[row.id] = await createMediaReadUrl(config, row.objectKey);
      }),
  );

  return c.json({ urls });
});

storageRoutes.delete("/:mediaId", async (c) => {
  const user = c.get("user");
  const mediaId = c.req.param("mediaId");
  const media = await db.query.mediaObjects.findFirst({ where: eq(mediaObjects.id, mediaId) });
  if (!media || media.status === "deleted") {
    return c.json({ error: "媒体文件不存在" }, 404);
  }
  if (media.userId !== user.id && user.role !== "admin") {
    return c.json({ error: "无权删除该文件" }, 403);
  }

  const config = await getS3StorageConfig();
  if (config) {
    await deleteS3Object(config, media.objectKey).catch(() => undefined);
    const thumbKey = typeof media.meta?.thumbObjectKey === "string" ? media.meta.thumbObjectKey : "";
    if (thumbKey) {
      await deleteS3Object(config, thumbKey).catch(() => undefined);
    }
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

  return c.json({ ok: true });
});

storageRoutes.post("/webdav/upload", async (c) => {
  const authUser = c.get("user");
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size <= 0) {
    return c.json({ error: "请上传有效的媒体文件" }, 400);
  }

  const kindRaw = String(form?.get("kind") || "file").trim();
  const kind = kindRaw === "image" || kindRaw === "video" || kindRaw === "audio" ? kindRaw : "file";
  const storageKey = String(form?.get("storageKey") || "").trim();
  const rawName = String(form?.get("filename") || file.name || "").trim();

  const [platformWebdav, userRow] = await Promise.all([
    getPlatformWebdavConfig(),
    db.query.users.findFirst({
      where: eq(users.id, authUser.id),
      columns: { id: true, webdavConfig: true },
    }),
  ]);

  const effective = resolveEffectiveUserWebdav(platformWebdav, userRow?.webdavConfig);
  if (!effective || !effective.enabled) {
    return c.json({ error: "当前账号尚未开通 WebDAV" }, 400);
  }
  if (effective.isExpired) {
    return c.json({ error: "您的 WebDAV 权限已过期，请联系管理员续期" }, 403);
  }
  if (effective.quotaBytes !== null && effective.usedBytes + file.size > effective.quotaBytes) {
    return c.json({ error: "WebDAV 可用空间不足，无法继续存放生成素材" }, 403);
  }

  const ext =
    file.type.split("/")[1]?.split(";")[0]?.replace(/[^a-zA-Z0-9]/g, "") ||
    (kind === "image" ? "png" : kind === "video" ? "mp4" : kind === "audio" ? "mp3" : "bin");
  const safeBase = (rawName || storageKey || nanoid()).replace(/[^a-zA-Z0-9._-]/g, "_");
  const finalName = safeBase.includes(".") ? safeBase : `${safeBase}.${ext}`;
  const day = new Date().toISOString().slice(0, 10);
  const relativePath = `generated/${kind}s/${day}/${finalName}`;

  const buffer = new Uint8Array(await file.arrayBuffer());
  const uploaded = await uploadFileToWebdav({
    url: effective.url,
    username: effective.username,
    password: effective.password,
    directory: effective.directory,
    relativePath,
    data: buffer,
    contentType: file.type || "application/octet-stream",
  });

  const nextUsedBytes = await db.transaction(async (tx) => {
    const fresh = await tx.query.users.findFirst({
      where: eq(users.id, authUser.id),
      columns: { webdavConfig: true },
    });
    const prevCfg = fresh?.webdavConfig;
    const nextUsed = Math.max(0, Number(prevCfg?.usedBytes ?? 0)) + file.size;
    if (prevCfg) {
      await tx
        .update(users)
        .set({ webdavConfig: { ...prevCfg, usedBytes: nextUsed }, updatedAt: new Date() })
        .where(eq(users.id, authUser.id));
    }
    return nextUsed;
  });

  return c.json({
    ok: true,
    path: uploaded.remotePath,
    bytes: file.size,
    usedBytes: nextUsedBytes,
    quotaBytes: effective.quotaBytes,
  });
});
