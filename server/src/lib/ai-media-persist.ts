/** 云端媒体配额校验与服务端 AI 生成结果自动转存对象存储辅助模块。 */
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import { db, mediaObjects, users, type MediaKind } from "../db/index.ts";
import { createMediaReadUrl, putS3Object } from "./s3.ts";
import { getS3StorageConfig } from "./settings.ts";
import { getUserStorageQuotaSummary } from "./storage-quota.ts";

export function checkStorageQuotaBlock(
  usedBytes: number,
  quotaBytes: number,
  expiresAt: Date | null | undefined,
  incomingBytes = 0,
): { blocked: true; error: string; code: "STORAGE_QUOTA_EXPIRED" | "STORAGE_QUOTA_EXCEEDED" } | { blocked: false } {
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    return {
      blocked: true,
      error: "您的云端存储配额已过期，请联系管理员续期或扩容",
      code: "STORAGE_QUOTA_EXPIRED",
    };
  }
  const quota = Math.max(0, Number(quotaBytes ?? 0));
  const used = Math.max(0, Number(usedBytes ?? 0));
  const incoming = Math.max(0, Number(incomingBytes ?? 0));
  if (quota <= 0 || used >= quota || (incoming > 0 && used + incoming > quota)) {
    return {
      blocked: true,
      error: "云端存储配额不足，请清理云端媒体或联系管理员扩容",
      code: "STORAGE_QUOTA_EXCEEDED",
    };
  }
  return { blocked: false };
}

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
    "audio/mp3": ".mp3",
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

export function buildThumbnailObjectKey(userId: string, mediaId: string) {
  const safeId = mediaId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `users/${userId}/thumbs/${safeId}.webp`;
}

function readPngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.byteLength < 24) return null;
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function readJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.byteLength < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < buffer.byteLength) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const len = buffer.readUInt16BE(offset + 2);
    if (len < 2 || offset + 2 + len > buffer.byteLength) break;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      if (offset + 9 <= buffer.byteLength) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      break;
    }
    offset += 2 + len;
  }
  return null;
}

function readWebpDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.byteLength < 30) return null;
  if (buffer.subarray(0, 4).toString("ascii") !== "RIFF" || buffer.subarray(8, 12).toString("ascii") !== "WEBP") return null;
  const chunk = buffer.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X" && buffer.byteLength >= 30) {
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (chunk === "VP8L" && buffer.byteLength >= 25) {
    const bits = buffer.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
}

export function inferImageDimensions(buffer: Buffer, mimeType: string) {
  if (mimeType.includes("png")) return readPngDimensions(buffer);
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return readJpegDimensions(buffer);
  if (mimeType.includes("webp")) return readWebpDimensions(buffer);
  return readPngDimensions(buffer) || readJpegDimensions(buffer) || readWebpDimensions(buffer);
}

/** 若平台已配置对象存储且用户配额充足，则把服务端拿到的媒体 Buffer 自动转存到 S3 并入库。 */
export async function persistCloudMediaBuffer(params: {
  userId: string;
  kind: MediaKind;
  buffer: Buffer;
  mimeType: string;
  sourceType?: "upload" | "ai_generated" | "canvas_import";
  filename?: string;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  meta?: Record<string, unknown>;
}): Promise<{ mediaId: string; objectKey: string; url: string } | null> {
  const config = await getS3StorageConfig();
  if (!config || params.buffer.byteLength <= 0) return null;

  const userRow = await db.query.users.findFirst({
    where: eq(users.id, params.userId),
    columns: { id: true, storageUsedBytes: true, storageQuotaBytes: true, storageQuotaExpiresAt: true },
  });
  if (!userRow) return null;

  const quotaSummary = await getUserStorageQuotaSummary(userRow);
  const block = checkStorageQuotaBlock(
    userRow.storageUsedBytes,
    quotaSummary.storageQuotaBytes,
    quotaSummary.storageQuotaExpiresAt,
    params.buffer.byteLength,
  );
  if (block.blocked) return null;

  const mimeType = params.mimeType || "application/octet-stream";
  const ext = inferExtension(params.filename, mimeType) || (params.kind === "image" ? ".png" : params.kind === "video" ? ".mp4" : params.kind === "audio" ? ".mp3" : "");
  const objectKey = buildObjectKey(params.userId, params.kind, ext);
  const mediaId = `${params.kind}:${nanoid()}`;
  const dims =
    params.width && params.height
      ? { width: params.width, height: params.height }
      : params.kind === "image"
        ? inferImageDimensions(params.buffer, mimeType)
        : null;

  await putS3Object(config, objectKey, params.buffer, mimeType);

  await db.transaction(async (tx) => {
    await tx.insert(mediaObjects).values({
      id: mediaId,
      userId: params.userId,
      bucket: config.bucket,
      objectKey,
      kind: params.kind,
      mimeType,
      bytes: params.buffer.byteLength,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      durationMs: params.durationMs ?? null,
      sourceType: params.sourceType || "ai_generated",
      status: "active",
      meta: params.meta ?? {},
    });

    await tx
      .update(users)
      .set({
        storageUsedBytes: sql`${users.storageUsedBytes} + ${params.buffer.byteLength}`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, params.userId));
  });

  const url = await createMediaReadUrl(config, objectKey).catch(() => "");
  return { mediaId, objectKey, url };
}

type ExtractedImageSource =
  | { kind: "b64"; b64: string; mimeType: string }
  | { kind: "url"; url: string };

function extractImageSources(payload: unknown): ExtractedImageSource[] {
  if (!payload || typeof payload !== "object") return [];
  const rec = payload as Record<string, unknown>;
  const list =
    (Array.isArray(rec.data) ? rec.data : null) ||
    (Array.isArray(rec.images) ? rec.images : null) ||
    (Array.isArray(rec.results) ? rec.results : null);

  if (list) {
    const out: ExtractedImageSource[] = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      if (typeof obj.b64_json === "string" && obj.b64_json) {
        out.push({ kind: "b64", b64: obj.b64_json, mimeType: "image/png" });
      } else if (typeof obj.url === "string" && obj.url) {
        if (obj.url.startsWith("data:")) {
          const match = obj.url.match(/^data:([^;,]+);base64,(.+)$/);
          if (match) out.push({ kind: "b64", b64: match[2], mimeType: match[1] });
        } else if (/^https?:\/\//i.test(obj.url)) {
          out.push({ kind: "url", url: obj.url });
        }
      }
    }
    return out;
  }

  if (Array.isArray(rec.candidates)) {
    const out: ExtractedImageSource[] = [];
    for (const candidate of rec.candidates) {
      const parts = (candidate as { content?: { parts?: Array<Record<string, unknown>> } })?.content?.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        const inline =
          (part.inlineData as { mimeType?: string; data?: string } | undefined) ||
          (part.inline_data as { mimeType?: string; mime_type?: string; data?: string } | undefined);
        if (inline && typeof inline.data === "string" && inline.data) {
          out.push({
            kind: "b64",
            b64: inline.data,
            mimeType: inline.mimeType || (inline as { mime_type?: string }).mime_type || "image/png",
          });
          continue;
        }
        const fileUri = (part.fileData as { fileUri?: string } | undefined)?.fileUri;
        if (typeof fileUri === "string" && /^https?:\/\//i.test(fileUri)) {
          out.push({ kind: "url", url: fileUri });
        }
      }
    }
    return out;
  }

  return [];
}

/** 从 AI 生图上游 JSON 响应提取全部图片并上传至用户云端对象存储，返回按顺序对应的 mediaId 数组。 */
export async function persistGeneratedImagesFromPayload(params: {
  userId: string;
  payload: unknown;
  model: string;
  prompt?: string;
  clientTaskId?: string;
}): Promise<Array<string | null>> {
  const sources = extractImageSources(params.payload);
  if (!sources.length) return [];

  const mediaIds: Array<string | null> = [];
  for (let idx = 0; idx < sources.length; idx += 1) {
    const src = sources[idx];
    try {
      let buffer: Buffer;
      let mimeType = "image/png";
      if (src.kind === "b64") {
        buffer = Buffer.from(src.b64, "base64");
        mimeType = src.mimeType || "image/png";
      } else {
        const res = await fetch(src.url);
        if (!res.ok) {
          mediaIds.push(null);
          continue;
        }
        mimeType = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
        if (!mimeType.startsWith("image/")) {
          mediaIds.push(null);
          continue;
        }
        buffer = Buffer.from(await res.arrayBuffer());
      }

      const saved = await persistCloudMediaBuffer({
        userId: params.userId,
        kind: "image",
        buffer,
        mimeType,
        sourceType: "ai_generated",
        meta: {
          model: params.model,
          ...(params.prompt ? { prompt: params.prompt.slice(0, 500) } : {}),
          ...(params.clientTaskId ? { clientTaskId: params.clientTaskId } : {}),
          slotIndex: idx,
        },
      });
      mediaIds.push(saved?.mediaId ?? null);
    } catch (error) {
      console.warn("[ai-media-persist] 服务端转存生图结果失败:", error);
      mediaIds.push(null);
    }
  }
  return mediaIds;
}
