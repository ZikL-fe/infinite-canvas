/** 云端媒体配额校验与服务端 AI 生成结果自动转存对象存储辅助模块。 */
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import { db, mediaObjects, users, type MediaKind } from "../db/index.ts";
import { env } from "../env.ts";
import { createConcurrencyLimiter } from "./concurrency.ts";
import { createMediaReadUrl, putS3Object } from "./s3.ts";
import { getS3StorageConfig } from "./settings.ts";
import { getUserStorageQuotaSummary } from "./storage-quota.ts";

const mediaPersistLimiter = createConcurrencyLimiter({
  maxConcurrent: env.MEDIA_PERSIST_CONCURRENCY,
});

/** 将大媒体下载/解码/上传任务排入全局信号量，防止高并发下内存峰值打爆。 */
export function runMediaPersistTask<T>(fn: () => Promise<T>): Promise<T> {
  return mediaPersistLimiter.run(fn);
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  const normalizedIpv4 = host.startsWith("::ffff:") ? host.slice(7) : host;
  const ipv4Match = normalizedIpv4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [a, b] = [Number(ipv4Match[1]), Number(ipv4Match[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (host === "::" || host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) {
    return true;
  }
  return false;
}

/** 校验远端拉取 URL 协议与目标主机，拦截内网/回环/元数据地址以防 SSRF。 */
export function assertSafeExternalUrl(rawUrl: string): URL {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("仅支持 http/https 资源链接");
  }
  if (isPrivateOrLocalHost(parsed.hostname)) {
    throw new Error("禁止拉取内网或本地地址资源");
  }
  return parsed;
}

/** 带超时与最大体积保护拉取远端媒体 Buffer（超限或超时返回 null，不影响上游原始响应返回前端）。 */
export async function fetchMediaBufferWithLimits(
  url: string,
  init?: RequestInit & { allowPrivateNetwork?: boolean },
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const { allowPrivateNetwork = false, ...fetchInit } = init || {};
  if (!allowPrivateNetwork) {
    assertSafeExternalUrl(url);
  }
  const res = await fetch(url, {
    ...fetchInit,
    signal: AbortSignal.timeout(env.MEDIA_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const contentLength = Number(res.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > env.MEDIA_PERSIST_MAX_BYTES) {
    console.warn(`[ai-media-persist] 跳过超大媒体自动转存: content-length=${contentLength}, limit=${env.MEDIA_PERSIST_MAX_BYTES}`);
    return null;
  }
  const mimeType = res.headers.get("content-type")?.split(";")[0]?.trim() || "";
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength <= 0 || buffer.byteLength > env.MEDIA_PERSIST_MAX_BYTES) {
    if (buffer.byteLength > env.MEDIA_PERSIST_MAX_BYTES) {
      console.warn(`[ai-media-persist] 跳过超大媒体自动转存: actual=${buffer.byteLength}, limit=${env.MEDIA_PERSIST_MAX_BYTES}`);
    }
    return null;
  }
  return { buffer, mimeType };
}

/** 校验用户云端存储配额是否已过期或超出上限（包含本次待写入的增量字节数）。 */
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

/** 优先从文件名后缀、其次从 MIME 类型推导对象存储文件扩展名（含点号）。 */
export function inferExtension(filename: string | undefined, mimeType: string) {
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

/** 按用户与年月分片生成对象存储原文件 Key。 */
export function buildObjectKey(userId: string, kind: MediaKind, ext: string) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `users/${userId}/${yyyy}/${mm}/${kind}/${nanoid()}${ext}`;
}

/** 生成云端媒体对应的 WebP 缩略图对象存储 Key。 */
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

/** 解析 PNG / JPEG / WebP 二进制头部读取图片原始宽高（失败返回 null）。 */
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
  if (params.buffer.byteLength > env.MEDIA_PERSIST_MAX_BYTES) {
    console.warn(`[ai-media-persist] 跳过超大媒体自动转存: bytes=${params.buffer.byteLength}, limit=${env.MEDIA_PERSIST_MAX_BYTES}`);
    return null;
  }

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

/** 从 AI 生图上游 JSON 响应提取全部图片并上传至用户云端对象存储，返回 mediaId 数组及拿图、云端存储分段耗时。 */
export async function persistGeneratedImagesFromPayload(params: {
  userId: string;
  payload: unknown;
  model: string;
  prompt?: string;
  clientTaskId?: string;
}): Promise<{ mediaIds: Array<string | null>; fetchImageMs: number; cloudSaveMs: number }> {
  const sources = extractImageSources(params.payload);
  if (!sources.length) return { mediaIds: [], fetchImageMs: 0, cloudSaveMs: 0 };

  const mediaIds: Array<string | null> = [];
  let fetchImageMs = 0;
  let cloudSaveMs = 0;
  for (let idx = 0; idx < sources.length; idx += 1) {
    const src = sources[idx];
    try {
      const saved = await runMediaPersistTask(async () => {
        let buffer: Buffer;
        let mimeType = "image/png";
        const fetchStartedAt = Date.now();
        if (src.kind === "b64") {
          buffer = Buffer.from(src.b64, "base64");
          mimeType = src.mimeType || "image/png";
        } else {
          const fetched = await fetchMediaBufferWithLimits(src.url);
          fetchImageMs += Date.now() - fetchStartedAt;
          if (!fetched || !fetched.mimeType.startsWith("image/")) {
            return null;
          }
          buffer = fetched.buffer;
          mimeType = fetched.mimeType || "image/png";
        }
        if (src.kind === "b64") {
          fetchImageMs += Date.now() - fetchStartedAt;
        }
        if (buffer.byteLength > env.MEDIA_PERSIST_MAX_BYTES) {
          console.warn(`[ai-media-persist] 跳过超大生图自动转存: bytes=${buffer.byteLength}, limit=${env.MEDIA_PERSIST_MAX_BYTES}`);
          return null;
        }

        const saveStartedAt = Date.now();
        const result = await persistCloudMediaBuffer({
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
        cloudSaveMs += Date.now() - saveStartedAt;
        return result;
      });
      mediaIds.push(saved?.mediaId ?? null);
    } catch (error) {
      console.warn("[ai-media-persist] 服务端转存生图结果失败:", error);
      mediaIds.push(null);
    }
  }
  return { mediaIds, fetchImageMs, cloudSaveMs };
}
