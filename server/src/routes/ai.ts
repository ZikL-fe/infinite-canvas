/** 平台 AI 代理转发网关：隐藏上游渠道密钥、拦截计费预扣、流式首字/速率采样及异步视频任务状态跟踪。 */
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { parseBuffer } from "music-metadata";
import { nanoid } from "nanoid";

import { aiBillingTasks, creditLedger, db, mediaObjects, users } from "../db/index.ts";
import { env } from "../env.ts";
import {
  assertSafeExternalUrl,
  fetchMediaBufferWithLimits,
  persistCloudMediaBuffer,
  persistGeneratedImagesFromPayload,
  runMediaPersistTask,
} from "../lib/ai-media-persist.ts";
import { AiRequestError, parseAiProxyRoute, readAiGenerationRequest } from "../lib/ai-request.ts";
import { ConcurrencyLimitError, createConcurrencyLimiter } from "../lib/concurrency.ts";
import {
  calculateImageCredits,
  calculateVideoCredits,
  hasNonZeroPricing,
  patchLedgerMeta,
  patchLedgerMetaByTaskId,
  refundLedgerCharge,
  reserveProcessingLedger,
  roundCredits,
  settleProcessingLedger,
} from "../lib/billing.ts";
import { verifyAccessToken } from "../lib/jwt.ts";
import {
  getPlatformChannels,
  type AudioModelPricing,
  type ImageModelPricing,
  type TextModelPricing,
  type VideoModelPricing,
} from "../lib/settings.ts";

export const aiRoutes = new Hono();

const aiProxyLimiter = createConcurrencyLimiter({
  maxConcurrent: env.AI_PROXY_MAX_CONCURRENCY,
  maxQueue: env.AI_PROXY_MAX_QUEUE,
  queueTimeoutMs: env.AI_PROXY_QUEUE_WAIT_MS,
});
const videoPersistInFlight = new Map<string, Promise<string | null>>();

let shuttingDown = false;
const shutdownAbortController = new AbortController();
const inFlightSyncRequests = new Set<Promise<void>>();
const VIDEO_MONITOR_INTERVAL_MS = 30_000;
const VIDEO_MONITOR_INITIAL_DELAY_MS = 10_000;
let videoMonitorTimer: ReturnType<typeof setInterval> | null = null;
let videoMonitorInitialTimer: ReturnType<typeof setTimeout> | null = null;
let videoMonitorRunning = false;

function trackInFlightSyncRequest() {
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  inFlightSyncRequests.add(done);
  return () => {
    inFlightSyncRequests.delete(done);
    resolveDone();
  };
}

/** 优雅停机：拒绝新生成请求、立即中止在途同步上游请求，并等待释放/退费事务落盘。 */
export async function beginAiShutdown(maxWaitMs = 8000) {
  shuttingDown = true;
  if (!shutdownAbortController.signal.aborted) {
    shutdownAbortController.abort(new Error("服务正在更新重启，请求已中止并退回积分"));
  }
  if (!inFlightSyncRequests.size) return;
  await Promise.race([
    Promise.allSettled([...inFlightSyncRequests]),
    new Promise<void>((resolve) => setTimeout(resolve, maxWaitMs)),
  ]);
}

type UsageTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

function buildUpstreamUrl(baseUrl: string, subPath: string, stream = false) {
  const cleanBase = baseUrl.trim().replace(/\/+$/, "");
  let cleanSub = subPath.startsWith("/") ? subPath : `/${subPath}`;
  const decodedSub = decodeURIComponent(cleanSub);
  if (decodedSub.includes("..") || decodedSub.includes("\\") || /[\r\n\0]/.test(decodedSub)) {
    throw new Error("非法的代理请求路径");
  }
  const lowerBase = cleanBase.toLowerCase();
  if (lowerBase.endsWith("/v1") && (cleanSub === "/v1" || cleanSub.startsWith("/v1/"))) {
    cleanSub = cleanSub.slice(3) || "/";
  } else if (lowerBase.endsWith("/v1beta") && (cleanSub === "/v1beta" || cleanSub.startsWith("/v1beta/"))) {
    cleanSub = cleanSub.slice(7) || "/";
  }

  const target = new URL(cleanBase);
  if (!/^https?:$/.test(target.protocol) || target.username || target.password || target.hash || target.search) {
    throw new Error("非法的代理请求路径");
  }
  target.pathname = `${target.pathname.replace(/\/+$/, "")}${cleanSub}`;
  if (stream) target.searchParams.set("alt", "sse");
  return target.toString();
}

function upstreamHeaders(channel: { apiFormat: "openai" | "gemini"; apiKey: string }) {
  const headers = new Headers();
  if (channel.apiFormat === "gemini") headers.set("x-goog-api-key", channel.apiKey);
  else headers.set("Authorization", `Bearer ${channel.apiKey}`);
  return headers;
}

function resolveGeminiMediaUrl(baseUrl: string, rawUrl: string) {
  const base = new URL(baseUrl);
  const target = new URL(rawUrl);
  const basePath = base.pathname.replace(/\/+$/, "").replace(/\/(?:v1|v1beta)$/i, "");
  if (
    target.origin !== base.origin ||
    !/^https?:$/.test(target.protocol) ||
    target.username || target.password || target.hash ||
    (basePath && target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`))
  ) {
    throw new Error("上游视频地址与渠道配置不匹配");
  }
  target.searchParams.delete("key");
  return target;
}

async function fetchWithSafeRedirect(url: string, init: RequestInit, trustedOrigin: string) {
  const res = await fetch(url, { ...init, redirect: "manual" });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (!location) return res;
    const next = new URL(location, url);
    if (next.origin !== trustedOrigin) {
      assertSafeExternalUrl(next.toString());
    }
    const headers = new Headers(init.headers);
    if (next.origin !== trustedOrigin) {
      headers.delete("x-goog-api-key");
      headers.delete("authorization");
    }
    return fetch(next.toString(), { ...init, headers, redirect: "error" });
  }
  return res;
}

function geminiProxyVideoUrl(channelId: string, taskId: string) {
  return `/api/ai/proxy/${encodeURIComponent(channelId)}/v1beta/${taskId}/content`;
}

function geminiVideoUri(payload: unknown) {
  const response = (payload as { response?: Record<string, unknown> } | null)?.response;
  const result = response?.generateVideoResponse as { generatedSamples?: Array<{ video?: { uri?: unknown } }> } | undefined;
  return result?.generatedSamples?.[0]?.video?.uri;
}

function rewriteGeminiVideoUris(payload: Record<string, unknown>, channelId: string, taskId: string) {
  const response = payload.response as Record<string, unknown> | undefined;
  const result = response?.generateVideoResponse as Record<string, unknown> | undefined;
  const samples = result?.generatedSamples;
  if (!Array.isArray(samples)) return;
  for (const sample of samples) {
    if (!sample || typeof sample !== "object") continue;
    const video = (sample as { video?: Record<string, unknown> }).video;
    if (video && typeof video.uri === "string") video.uri = geminiProxyVideoUrl(channelId, taskId);
  }
}

async function fetchGeminiVideoContent(params: {
  baseUrl: string;
  apiKey: string;
  taskId: string;
}) {
  const operationUrl = buildUpstreamUrl(params.baseUrl, `/v1beta/${params.taskId}`);
  const operation = await fetch(operationUrl, {
    headers: upstreamHeaders({ apiFormat: "gemini", apiKey: params.apiKey }),
    redirect: "error",
    signal: AbortSignal.timeout(env.AI_POLL_TIMEOUT_MS),
  });
  if (!operation.ok) return new Response("视频任务暂不可用", { status: operation.status });
  const payload = await operation.json().catch(() => null);
  const uri = geminiVideoUri(payload);
  if (typeof uri !== "string") return new Response("视频内容尚未就绪", { status: 409 });
  const target = resolveGeminiMediaUrl(params.baseUrl, uri);
  const media = await fetchWithSafeRedirect(
    target.toString(),
    {
      method: "GET",
      headers: { "x-goog-api-key": params.apiKey },
      signal: AbortSignal.timeout(env.AI_UPSTREAM_TIMEOUT_MS),
    },
    target.origin,
  );
  if (!media.ok) return new Response("无法获取上游视频内容", { status: media.status });
  const mimeType = media.headers.get("content-type")?.split(";")[0]?.trim() || "video/mp4";
  if (mimeType.includes("json")) return new Response("上游未返回视频内容", { status: 502 });
  return new Response(media.body, {
    status: 200,
    headers: { "Content-Type": mimeType.startsWith("video/") ? mimeType : "video/mp4", "Cache-Control": "private, no-store" },
  });
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function extractUsageFromObject(obj: unknown): UsageTotals | null {
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;

  // OpenAI Responses API / Chat Completions
  const usage =
    (rec.usage as Record<string, unknown> | undefined) ||
    ((rec.response as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined);
  if (usage && typeof usage === "object") {
    const inputDetails =
      (usage.input_tokens_details as Record<string, unknown> | undefined) ||
      (usage.prompt_tokens_details as Record<string, unknown> | undefined);
    const hasTotals = ["input_tokens", "prompt_tokens", "output_tokens", "completion_tokens"].some((key) => Object.hasOwn(usage, key));
    if (hasTotals) {
      const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
      const cachedInputTokens = inputDetails?.cached_tokens ?? 0;
      const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
      if (isTokenCount(inputTokens) && isTokenCount(cachedInputTokens) && isTokenCount(outputTokens)) {
        return { inputTokens, cachedInputTokens, outputTokens };
      }
      return null;
    }
  }

  // Gemini usageMetadata
  const meta = rec.usageMetadata as Record<string, unknown> | undefined;
  if (meta && typeof meta === "object") {
    const hasTotals = ["promptTokenCount", "cachedContentTokenCount", "candidatesTokenCount", "thoughtsTokenCount"].some((key) => Object.hasOwn(meta, key));
    if (hasTotals) {
      const inputTokens = meta.promptTokenCount ?? 0;
      const cachedInputTokens = meta.cachedContentTokenCount ?? 0;
      const candidates = meta.candidatesTokenCount ?? 0;
      const thoughts = meta.thoughtsTokenCount ?? 0;
      const outputTokens = typeof candidates === "number" && typeof thoughts === "number" ? candidates + thoughts : NaN;
      if (isTokenCount(inputTokens) && isTokenCount(cachedInputTokens) && isTokenCount(outputTokens)) {
        return { inputTokens, cachedInputTokens, outputTokens };
      }
      return null;
    }
  }

  return null;
}

function calculateTextCharge(pricing: TextModelPricing, usage: UsageTotals): number | null {
  const cached = Math.min(usage.inputTokens, usage.cachedInputTokens);
  const uncached = usage.inputTokens - cached;
  const raw = (uncached * pricing.inputPerMillion + cached * pricing.cachedInputPerMillion + usage.outputTokens * pricing.outputPerMillion) / 1_000_000;
  if (!Number.isFinite(raw) || raw < 0 || !Number.isFinite(raw * 10_000)) return null;
  return roundCredits(raw);
}

function calculateAudioCharge(pricing: AudioModelPricing, durationSeconds: number): number | null {
  const raw = pricing.perSecond * durationSeconds;
  if (!Number.isFinite(raw) || raw < 0 || !Number.isFinite(raw * 10_000)) return null;
  return roundCredits(raw);
}

async function readAudioOutput(buffer: Buffer, contentType: string, responseFormat?: string) {
  let audioBuffer = buffer;
  let mimeType = contentType.split(";")[0]?.trim() || "";
  let pcmMimeType = contentType;
  if (mimeType.includes("application/json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString("utf8"));
    } catch {
      return null;
    }
    const candidates = (parsed as { candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }> })?.candidates;
    const inline = candidates?.flatMap((candidate) => candidate.content?.parts ?? []).map((part) =>
      (part.inlineData ?? part.inline_data) as { data?: unknown; mimeType?: unknown; mime_type?: unknown } | undefined,
    ).find((item) => typeof item?.data === "string" && item.data);
    if (!inline || typeof inline.data !== "string") return null;
    const base64 = inline.data;
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) return null;
    audioBuffer = Buffer.from(base64, "base64");
    pcmMimeType = typeof inline.mimeType === "string" ? inline.mimeType : typeof inline.mime_type === "string" ? inline.mime_type : "";
    mimeType = pcmMimeType.split(";")[0]?.trim() || "";
    if (!mimeType.startsWith("audio/") || !audioBuffer.length) return null;
  }

  if (/^audio\/(?:pcm|l16)$/i.test(mimeType)) {
    const rate = Number(pcmMimeType.match(/(?:^|;)\s*rate=(\d+)/i)?.[1] || (responseFormat === "pcm" ? 24000 : 0));
    const channels = Number(pcmMimeType.match(/(?:^|;)\s*channels=(\d+)/i)?.[1] || 1);
    const bytesPerSecond = rate * channels * 2;
    if (!Number.isSafeInteger(rate) || rate <= 0 || !Number.isSafeInteger(channels) || channels <= 0 ||
      !Number.isSafeInteger(bytesPerSecond) || audioBuffer.length % (2 * channels) !== 0) {
      return null;
    }
    const durationSeconds = audioBuffer.length / bytesPerSecond;
    return Number.isFinite(durationSeconds) && durationSeconds > 0 ? { buffer: audioBuffer, mimeType: "audio/pcm", durationSeconds } : null;
  }

  try {
    const metadata = await parseBuffer(new Uint8Array(audioBuffer), undefined, { duration: true, skipCovers: true });
    const durationSeconds = metadata.format.duration ?? 0;
    if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
      return { buffer: audioBuffer, mimeType: mimeType || metadata.format.container || "audio/mpeg", durationSeconds };
    }
  } catch {
    // Unknown or malformed audio must not be delivered as a paid successful generation.
  }
  return null;
}

function hasStreamContentToken(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  const rec = obj as Record<string, unknown>;
  if (Array.isArray(rec.choices)) {
    for (const ch of rec.choices) {
      const delta = (ch as { delta?: Record<string, unknown> })?.delta;
      if (
        delta &&
        (typeof delta.content === "string"
          ? delta.content.length > 0
          : Boolean(delta.reasoning_content || delta.tool_calls))
      ) {
        return true;
      }
    }
  }
  if (typeof rec.delta === "string" && rec.delta.length > 0) return true;
  if (Array.isArray(rec.candidates)) {
    for (const cand of rec.candidates) {
      const parts = (cand as { content?: { parts?: Array<Record<string, unknown>> } })?.content?.parts;
      if (Array.isArray(parts) && parts.some((p) => typeof p.text === "string" && p.text.length > 0)) {
        return true;
      }
    }
  }
  return false;
}

function calcTokensPerSecond(outputTokens: number, durationMs: number, firstTokenMs?: number) {
  if (outputTokens <= 0 || durationMs <= 0) return 0;
  const genMs = firstTokenMs !== undefined && durationMs > firstTokenMs ? durationMs - firstTokenMs : durationMs;
  return Math.round((outputTokens / Math.max(0.001, genMs / 1000)) * 10) / 10;
}

const MAX_STORED_RESULT_TEXT = 200_000;

function appendCappedText(current: string, chunk: string) {
  if (!chunk || current.length >= MAX_STORED_RESULT_TEXT) return current;
  const remaining = MAX_STORED_RESULT_TEXT - current.length;
  return current + (chunk.length > remaining ? chunk.slice(0, remaining) : chunk);
}

function extractStreamTextDelta(obj: unknown): string {
  if (!obj || typeof obj !== "object") return "";
  const rec = obj as Record<string, unknown>;
  if (rec.type === "response.output_text.delta" && typeof rec.delta === "string") {
    return rec.delta;
  }
  if (Array.isArray(rec.choices)) {
    let out = "";
    for (const ch of rec.choices) {
      const delta = (ch as { delta?: Record<string, unknown> })?.delta;
      if (delta && typeof delta.content === "string") out += delta.content;
    }
    if (out) return out;
  }
  if (Array.isArray(rec.candidates)) {
    let out = "";
    for (const cand of rec.candidates) {
      const parts = (cand as { content?: { parts?: Array<Record<string, unknown>> } })?.content?.parts;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (typeof part.text === "string") out += part.text;
        }
      }
    }
    if (out) return out;
  }
  return "";
}

function extractFinalTextFromPayload(obj: unknown): string {
  if (!obj || typeof obj !== "object") return "";
  const rec = obj as Record<string, unknown>;
  if (rec.type === "response.output_text.done" && typeof rec.text === "string") return rec.text;
  const target = rec.type === "response.completed" && rec.response && typeof rec.response === "object"
    ? (rec.response as Record<string, unknown>)
    : rec;
  if (typeof target.output_text === "string" && target.output_text) return target.output_text;
  if (Array.isArray(target.output)) {
    let out = "";
    for (const item of target.output as Array<Record<string, unknown>>) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content as Array<Record<string, unknown>>) {
          if (typeof part.text === "string") out += part.text;
        }
      }
    }
    if (out) return out;
  }
  if (Array.isArray(target.choices)) {
    let out = "";
    for (const ch of target.choices as Array<{ message?: { content?: unknown } }>) {
      if (typeof ch.message?.content === "string") out += ch.message.content;
    }
    if (out) return out;
  }
  return extractStreamTextDelta(target);
}

function countReturnedImages(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const rec = payload as Record<string, unknown>;
  if (Array.isArray(rec.data)) {
    return rec.data.length;
  }
  if (Array.isArray(rec.candidates)) {
    let count = 0;
    for (const candidate of rec.candidates) {
      const parts = (candidate as { content?: { parts?: Array<Record<string, unknown>> } })?.content?.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (part.inlineData || part.inline_data || part.fileData) count += 1;
      }
    }
    return count;
  }
  return null;
}

function truncateErrorText(text: string, maxLength = 1000) {
  const clean = text.trim();
  if (!clean) return "";
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}…` : clean;
}

function extractErrorFromPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const rec = payload as Record<string, unknown>;
  const errObj = rec.error && typeof rec.error === "object" ? (rec.error as Record<string, unknown>) : null;
  const errMsg =
    (typeof errObj?.message === "string" && errObj.message) ||
    (typeof rec.error === "string" && rec.error) ||
    (typeof rec.message === "string" && rec.message) ||
    (typeof rec.msg === "string" && rec.msg) ||
    (typeof rec.detail === "string" && rec.detail) ||
    "";
  if (errMsg.trim()) return truncateErrorText(errMsg);

  const promptFeedback = rec.promptFeedback && typeof rec.promptFeedback === "object" ? (rec.promptFeedback as Record<string, unknown>) : null;
  if (typeof promptFeedback?.blockReason === "string" && promptFeedback.blockReason.trim()) {
    return truncateErrorText(`请求被上游内容安全策略拦截（${promptFeedback.blockReason.trim()}）`);
  }

  if (Array.isArray(rec.candidates) && rec.candidates.length > 0) {
    const first = rec.candidates[0] as Record<string, unknown> | undefined;
    const finishMessage = typeof first?.finishMessage === "string" ? first.finishMessage.trim() : "";
    if (finishMessage) return truncateErrorText(finishMessage);
    const finishReason = typeof first?.finishReason === "string" ? first.finishReason.trim() : "";
    if (finishReason && finishReason.toUpperCase() !== "STOP") {
      return truncateErrorText(`上游生成未返回图片（finishReason: ${finishReason}）`);
    }
  }
  return "";
}

function extractUpstreamErrorMessage(rawText: string, status?: number) {
  const trimmed = rawText.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed);
      const parsedMsg = extractErrorFromPayload(parsed);
      if (parsedMsg) return parsedMsg;
    } catch {
      // non-JSON response falls through to raw snippet
    }
    return truncateErrorText(trimmed);
  }
  return status ? `上游返回异常状态码 HTTP ${status}` : "上游请求失败";
}

function mapUpstreamTaskStatus(payload: unknown): "not_started" | "processing" | "completed" | "failed" {
  if (!payload || typeof payload !== "object") return "processing";
  const rec = payload as Record<string, unknown>;
  const data = (rec.data && typeof rec.data === "object" ? (rec.data as Record<string, unknown>) : rec) as Record<string, unknown>;
  const raw = typeof data.status === "string" ? data.status.trim().toLowerCase() : "";
  if (raw === "failed" || raw === "cancelled" || raw === "canceled" || raw === "error" || Boolean(data.error)) {
    return "failed";
  }
  if (data.done === true) {
    // Gemini 长轮询完成时若被安全策略拦截或无有效视频地址，应视作失败以便自动退费
    const responseObj = data.response && typeof data.response === "object" ? (data.response as Record<string, unknown>) : undefined;
    const genVideoResp =
      responseObj?.generateVideoResponse && typeof responseObj.generateVideoResponse === "object"
        ? (responseObj.generateVideoResponse as Record<string, unknown>)
        : undefined;
    const filteredCount = Number(genVideoResp?.raiMediaFilteredCount ?? responseObj?.raiMediaFilteredCount ?? 0);
    const filteredReasons = genVideoResp?.raiMediaFilteredReasons ?? responseObj?.raiMediaFilteredReasons;
    if (filteredCount > 0 || (Array.isArray(filteredReasons) && filteredReasons.length > 0)) {
      return "failed";
    }
    if (genVideoResp) {
      const samples = Array.isArray(genVideoResp.generatedSamples) ? genVideoResp.generatedSamples : [];
      const hasValidUri = samples.some(
        (sample) =>
          Boolean(sample && typeof sample === "object" && typeof (sample as { video?: { uri?: unknown } }).video?.uri === "string" && (sample as { video?: { uri?: string } }).video?.uri?.trim()),
      );
      if (!hasValidUri) return "failed";
    }
    return "completed";
  }
  if (raw === "completed" || raw === "succeeded" || raw === "success") {
    return "completed";
  }
  if (raw === "queued" || raw === "pending" || raw === "submitted" || raw === "not_started") {
    return "not_started";
  }
  return "processing";
}

async function persistCompletedVideoIfNeeded(params: {
  userId: string;
  taskId: string;
  model: string;
  payload: Record<string, unknown>;
  channelBaseUrl: string;
  channelApiFormat: "openai" | "gemini";
  channelApiKey: string;
}): Promise<string | null> {
  const dedupeKey = `${params.userId}:${params.taskId}`;
  const inFlight = videoPersistInFlight.get(dedupeKey);
  if (inFlight) return inFlight;

  const job = runMediaPersistTask(async () => {
    try {
      const existing = await db.query.mediaObjects.findFirst({
        where: and(
          eq(mediaObjects.userId, params.userId),
          eq(mediaObjects.status, "active"),
          sql`${mediaObjects.meta}->>'videoTaskId' = ${params.taskId}`,
        ),
        columns: { id: true },
      });
      if (existing) return existing.id;

      const data = (params.payload.data && typeof params.payload.data === "object"
        ? (params.payload.data as Record<string, unknown>)
        : params.payload) as Record<string, unknown>;
      const contentObj = data.content && typeof data.content === "object" ? (data.content as Record<string, unknown>) : undefined;
      const geminiSamples = (
        (data.response as Record<string, unknown> | undefined)?.generateVideoResponse as Record<string, unknown> | undefined
      )?.generatedSamples as Array<{ video?: { uri?: string } }> | undefined;
      const geminiUri = geminiSamples?.[0]?.video?.uri;
      const directUrl = [data.video_url, data.result_url, data.url, contentObj?.video_url, contentObj?.url, geminiUri].find(
        (v): v is string => typeof v === "string" && /^https?:\/\//i.test(v),
      );

      let fetched: { buffer: Buffer; mimeType: string } | null = null;
      if (directUrl) {
        if (params.channelApiFormat === "gemini") {
          const target = resolveGeminiMediaUrl(params.channelBaseUrl, directUrl);
          fetched = await fetchMediaBufferWithLimits(target.toString(), {
            allowPrivateNetwork: true,
            redirect: "error",
            headers: { "x-goog-api-key": params.channelApiKey },
          });
        } else {
          fetched = await fetchMediaBufferWithLimits(directUrl, { redirect: "error" });
        }
      } else if (params.channelApiFormat === "openai") {
        const contentUrl = buildUpstreamUrl(params.channelBaseUrl, `/v1/videos/${encodeURIComponent(params.taskId)}/content`);
        fetched = await fetchMediaBufferWithLimits(contentUrl, {
          allowPrivateNetwork: true,
          redirect: "error",
          headers: { Authorization: `Bearer ${params.channelApiKey}` },
        });
      }

      if (!fetched) return null;
      const mimeType = fetched.mimeType || "video/mp4";
      if (mimeType.includes("application/json")) return null;

      const ledgerRow = await db.query.creditLedger.findFirst({
        where: and(eq(creditLedger.userId, params.userId), sql`${creditLedger.meta}->>'taskId' = ${params.taskId}`),
        columns: { meta: true },
      });
      const mappedClientTaskId =
        typeof ledgerRow?.meta?.clientTaskId === "string" && ledgerRow.meta.clientTaskId.trim()
          ? ledgerRow.meta.clientTaskId.trim()
          : params.taskId;

      const saved = await persistCloudMediaBuffer({
        userId: params.userId,
        kind: "video",
        buffer: fetched.buffer,
        mimeType: mimeType.startsWith("video/") ? mimeType : "video/mp4",
        sourceType: "ai_generated",
        meta: {
          model: params.model,
          videoTaskId: params.taskId,
          clientTaskId: mappedClientTaskId,
        },
      });
      return saved?.mediaId ?? null;
    } catch (error) {
      console.warn("[ai-media-persist] 服务端转存完成视频失败:", error);
      return null;
    }
  }).finally(() => {
    videoPersistInFlight.delete(dedupeKey);
  });

  videoPersistInFlight.set(dedupeKey, job);
  return job;
}

async function handleVideoPollTaskState(userId: string, taskId: string, payload: unknown) {
  if (!taskId || !payload || typeof payload !== "object") return;
  const nextStatus = mapUpstreamTaskStatus(payload);
  const task = await db.query.aiBillingTasks.findFirst({
    where: and(eq(aiBillingTasks.taskId, taskId), eq(aiBillingTasks.userId, userId)),
  });
  if (!task || task.status !== "pending") return;

  const durationMs =
    nextStatus === "completed" || nextStatus === "failed"
      ? Math.max(1, Date.now() - task.createdAt.getTime())
      : undefined;
  await patchLedgerMetaByTaskId(userId, taskId, {
    taskStatus: nextStatus,
    ...(durationMs ? { durationMs } : {}),
  }).catch(() => undefined);

  if (nextStatus === "failed") {
    const [updated] = await db
      .update(aiBillingTasks)
      .set({ status: "refunded", updatedAt: new Date() })
      .where(and(eq(aiBillingTasks.id, task.id), eq(aiBillingTasks.status, "pending")))
      .returning();
    if (updated && updated.chargedCredits > 0) {
      await refundLedgerCharge({
        userId,
        taskId: task.taskId,
        refId: task.taskId,
        refundAmount: updated.chargedCredits,
        markFailed: true,
        metaPatch: {
          refundDetail: "视频生成任务失败自动退回积分",
          ...(durationMs ? { durationMs } : {}),
        },
      });
    }
  } else if (nextStatus === "completed") {
    await db
      .update(aiBillingTasks)
      .set({ status: "completed", updatedAt: new Date() })
      .where(and(eq(aiBillingTasks.id, task.id), eq(aiBillingTasks.status, "pending")));
  }
}

async function pollPendingVideoTasksOnce() {
  if (shuttingDown || videoMonitorRunning) return;
  videoMonitorRunning = true;
  try {
    const pendingTasks = await db.query.aiBillingTasks.findMany({
      where: eq(aiBillingTasks.status, "pending"),
      limit: 100,
    });
    if (!pendingTasks.length) return;
    const channels = await getPlatformChannels();
    const channelMap = new Map(channels.filter((ch) => ch.enabled).map((ch) => [ch.id, ch]));

    for (const task of pendingTasks) {
      if (shuttingDown) break;
      const channel = channelMap.get(task.channelId);
      if (!channel || !channel.baseUrl.trim() || !channel.apiKey.trim()) continue;
      const subPath =
        channel.apiFormat === "gemini"
          ? `/v1beta/${task.taskId}`
          : `/v1/videos/${encodeURIComponent(task.taskId)}`;
      let pollUrl: string;
      try {
        pollUrl = buildUpstreamUrl(channel.baseUrl, subPath);
      } catch {
        continue;
      }
      try {
        const res = await fetch(pollUrl, {
          headers: upstreamHeaders(channel),
          redirect: "error",
          signal: AbortSignal.any([
            AbortSignal.timeout(env.AI_POLL_TIMEOUT_MS),
            shutdownAbortController.signal,
          ]),
        });
        if (res.status === 404 || res.status === 410) {
          const durationMs = Math.max(1, Date.now() - task.createdAt.getTime());
          const [updated] = await db
            .update(aiBillingTasks)
            .set({ status: "refunded", updatedAt: new Date() })
            .where(and(eq(aiBillingTasks.id, task.id), eq(aiBillingTasks.status, "pending")))
            .returning();
          if (updated && updated.chargedCredits > 0) {
            await refundLedgerCharge({
              userId: task.userId,
              taskId: task.taskId,
              refId: task.taskId,
              refundAmount: updated.chargedCredits,
              markFailed: true,
              metaPatch: {
                durationMs,
                errorMessage: "上游视频任务不存在或已过期",
                refundDetail: "上游视频任务不存在自动退回积分",
              },
            });
          } else {
            await patchLedgerMetaByTaskId(task.userId, task.taskId, {
              taskStatus: "failed",
              durationMs,
              errorMessage: "上游视频任务不存在或已过期",
            }).catch(() => undefined);
          }
          continue;
        }
        if (!res.ok) continue;
        const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        await handleVideoPollTaskState(task.userId, task.taskId, parsed);
        if (mapUpstreamTaskStatus(parsed) === "completed") {
          const savedVideoId = await persistCompletedVideoIfNeeded({
            userId: task.userId,
            taskId: task.taskId,
            model: task.model,
            payload: parsed,
            channelBaseUrl: channel.baseUrl,
            channelApiFormat: channel.apiFormat,
            channelApiKey: channel.apiKey,
          });
          if (savedVideoId) {
            await patchLedgerMetaByTaskId(task.userId, task.taskId, { mediaIds: [savedVideoId] }).catch(() => undefined);
          }
        }
      } catch {
        // 瞬时网络异常不判失败，等待下一轮巡检继续跟进
      }
    }
  } finally {
    videoMonitorRunning = false;
  }
}

/** 启动后台异步视频任务巡检：容器重启或用户离线期间持续跟踪直到上游返回终态。 */
export function startVideoTaskMonitor() {
  if (videoMonitorTimer || videoMonitorInitialTimer) return;
  videoMonitorInitialTimer = setTimeout(() => {
    videoMonitorInitialTimer = null;
    void pollPendingVideoTasksOnce();
    videoMonitorTimer = setInterval(() => {
      void pollPendingVideoTasksOnce();
    }, VIDEO_MONITOR_INTERVAL_MS);
  }, VIDEO_MONITOR_INITIAL_DELAY_MS);
}

/** 停止后台视频任务巡检定时器。 */
export function stopVideoTaskMonitor() {
  if (videoMonitorInitialTimer) {
    clearTimeout(videoMonitorInitialTimer);
    videoMonitorInitialTimer = null;
  }
  if (videoMonitorTimer) {
    clearInterval(videoMonitorTimer);
    videoMonitorTimer = null;
  }
}

aiRoutes.all("/proxy/:channelId/*", async (c) => {
  const authHeader = c.req.header("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const googleKeyToken = c.req.header("x-goog-api-key")?.trim() || "";
  const token = bearerToken || googleKeyToken;

  if (!token) {
    return c.json({ error: "请先登录" }, 401);
  }

  let userId = "";
  try {
    const payload = await verifyAccessToken(token);
    userId = payload.sub;
  } catch {
    return c.json({ error: "登录已过期，请重新登录" }, 401);
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { id: true, status: true },
  });
  if (!user || user.status !== "active") {
    return c.json({ error: "当前账号不可用" }, 403);
  }

  const channelId = c.req.param("channelId");
  const channels = await getPlatformChannels();
  const channel = channels.find((item) => item.id === channelId && item.enabled);
  if (!channel || !channel.baseUrl.trim() || !channel.apiKey.trim()) {
    return c.json({ error: "所选模型渠道不可用或管理员尚未配置密钥" }, 400);
  }

  const prefix = `/api/ai/proxy/${channelId}`;
  const fullUrl = new URL(c.req.url);
  const subPath = fullUrl.pathname.startsWith(prefix) ? fullUrl.pathname.slice(prefix.length) || "/" : "/";
  const method = c.req.method.toUpperCase();
  const route = parseAiProxyRoute(channel.apiFormat, method, subPath);
  if (!route) return c.json({ error: "托管渠道不支持此 API 路径或请求方法" }, 404);

  if (route.kind === "models") {
    return channel.apiFormat === "openai"
      ? c.json({ object: "list", data: channel.models.map((model) => ({ id: model.name, object: "model", created: 0, owned_by: channel.name })) })
      : c.json({
          models: channel.models.map((model) => ({
            name: `models/${model.name}`,
            displayName: model.name,
            supportedGenerationMethods: model.capability === "video" ? ["predictLongRunning"] : model.capability === "text" ? ["generateContent", "streamGenerateContent"] : ["generateContent"],
          })),
        });
  }

  let task: typeof aiBillingTasks.$inferSelect | undefined;
  if (route.kind === "task") {
    task = await db.query.aiBillingTasks.findFirst({
      where: and(
        eq(aiBillingTasks.userId, user.id),
        eq(aiBillingTasks.channelId, channelId),
        eq(aiBillingTasks.taskId, route.taskId),
      ),
    });
    if (!task) return c.json({ error: "任务不存在或无权访问" }, 404);
  }

  if (route.kind === "task" && route.content && channel.apiFormat === "gemini") {
    try {
      return await fetchGeminiVideoContent({ baseUrl: channel.baseUrl, apiKey: channel.apiKey, taskId: route.taskId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法获取上游视频内容";
      return c.json({ error: message }, 502);
    }
  }

  let targetUrl: string;
  try {
    targetUrl = buildUpstreamUrl(channel.baseUrl, subPath, route.kind === "generate" && route.endpoint === "streamGenerateContent" && channel.apiFormat === "gemini");
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "非法的代理请求路径" }, 400);
  }

  const clientTaskId = c.req.header("X-Client-Task-Id")?.trim() || "";
  let generation: Awaited<ReturnType<typeof readAiGenerationRequest>> | undefined;
  if (route.kind === "generate") {
    try {
      generation = await readAiGenerationRequest(c.req.raw, route, channel.models);
    } catch (error) {
      if (error instanceof AiRequestError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  }
  const channelModel = generation?.channelModel;
  const modelName = generation?.modelName ?? task?.model ?? "";
  const promptText = generation?.promptText ?? "";
  const requestedImageCount = generation?.requestedImageCount ?? 1;
  const resolutionTier = generation?.resolutionTier;
  const sizeStr = generation?.sizeStr ?? "";
  const seconds = generation?.seconds ?? 0;
  const hasReferenceVideo = generation?.hasReferenceVideo ?? false;
  const referenceVideoSeconds = generation?.referenceVideoSeconds;
  const pricing = channelModel?.pricing;
  // 所有受管模型 POST 请求均记录使用日志（含免费模型与极小用量 0 积分调用）
  const shouldTrackUsage = route.kind === "generate" && method === "POST" && Boolean(channelModel);
  const shouldBill = shouldTrackUsage && hasNonZeroPricing(pricing);

  const forwardHeaders = upstreamHeaders(channel);
  if (generation?.contentType) forwardHeaders.set("Content-Type", generation.contentType);
  if (generation?.streaming) forwardHeaders.set("Accept", "text/event-stream");
  const rawBody = generation?.rawBody;
  const isPolling = route.kind === "task";
  if (shuttingDown && !isPolling) {
    return c.json({ error: "服务正在更新重启，请稍后重试", message: "服务正在更新重启，请稍后重试" }, 503);
  }

  // 非轮询生成请求先申请全局并发槽位，排队满或超时快速返回 429 且不预扣积分
  let releaseProxySlot: (() => void) | null = null;
  if (!isPolling) {
    try {
      const queueSignal = c.req.raw.signal
        ? AbortSignal.any([c.req.raw.signal, shutdownAbortController.signal])
        : shutdownAbortController.signal;
      releaseProxySlot = await aiProxyLimiter.acquire(queueSignal);
    } catch (error) {
      if (error instanceof ConcurrencyLimitError) {
        if (error.code === "ABORTED") {
          if (shuttingDown) {
            return c.json({ error: "服务正在更新重启，请稍后重试", message: "服务正在更新重启，请稍后重试" }, 503);
          }
          return c.json({ error: "请求已取消", message: "请求已取消" }, 499);
        }
        return c.json({ error: error.message, message: error.message }, 429);
      }
      throw error;
    }
  }

  const finishSyncTracking = isPolling ? undefined : trackInFlightSyncRequest();
  let clientAborted = Boolean(c.req.raw.signal?.aborted);
  const handleAbort = () => { clientAborted = true; };
  c.req.raw.signal?.addEventListener("abort", handleAbort, { once: true });
  let streamOwnsSlot = false;
  let proxyResourcesReleased = false;
  const releaseProxyResources = () => {
    if (proxyResourcesReleased) return;
    proxyResourcesReleased = true;
    c.req.raw.signal?.removeEventListener("abort", handleAbort);
    releaseProxySlot?.();
    finishSyncTracking?.();
  };

  try {
    let preCharged = 0;
    let preChargedLedgerId = "";

    if (shouldTrackUsage && channelModel) {
      let reserveCredits = 0;
      let ledgerReason: "text_gen" | "audio_gen" | "image_gen" | "video_gen" = "text_gen";
      let expiresAt: Date | null = new Date(Date.now() + env.AI_UPSTREAM_TIMEOUT_MS);
      let extraMeta: Record<string, unknown> = { isStream: Boolean(generation?.streaming), taskStatus: "processing" };

      if (channelModel.capability === "image") {
        preCharged = pricing ? calculateImageCredits(pricing as ImageModelPricing, requestedImageCount, resolutionTier, sizeStr) : 0;
        reserveCredits = preCharged;
        ledgerReason = "image_gen";
        expiresAt = null;
        extraMeta = { count: requestedImageCount, resolutionTier, size: sizeStr, isStream: false, taskStatus: "processing" };
      } else if (channelModel.capability === "video") {
        preCharged = pricing ? calculateVideoCredits(pricing as VideoModelPricing, { seconds, hasReferenceVideo, referenceVideoSeconds }) : 0;
        reserveCredits = preCharged;
        ledgerReason = "video_gen";
        expiresAt = null;
        extraMeta = {
          seconds,
          hasReferenceVideo,
          ...(referenceVideoSeconds !== undefined ? { referenceVideoSeconds } : {}),
          isStream: false,
          taskStatus: "not_started",
          provider: channel.apiFormat,
        };
      } else if (channelModel.capability === "audio") {
        reserveCredits = generation?.estimatedReserveCredits ?? 0;
        ledgerReason = "audio_gen";
      } else {
        reserveCredits = generation?.estimatedReserveCredits ?? 0;
        ledgerReason = "text_gen";
      }

      const channelAlias = channel.alias?.trim() || "";
      const reservation = await reserveProcessingLedger({
        userId: user.id,
        reason: ledgerReason,
        priced: shouldBill && (channelModel.capability === "text" || channelModel.capability === "audio" || reserveCredits > 0),
        reserveCredits,
        expiresAt,
        meta: {
          model: modelName,
          channelId: channel.id,
          channelGroup: channel.name,
          ...(channelAlias ? { channelAlias } : {}),
          ...extraMeta,
          ...(clientTaskId ? { clientTaskId } : {}),
        },
      });
      if (!reservation.ok) {
        const msg =
          reservation.required > 0 && reservation.balance > 0
            ? `积分余额不足（当前可用 ${reservation.balance}，本次至少需要预留 ${reservation.required}）`
            : "积分余额不足或已被其他请求占用，请先充值";
        return c.json({ error: msg, message: msg, balance: reservation.balance, required: reservation.required }, 402);
      }
      preChargedLedgerId = reservation.ledgerId;
    }

    const startedAt = Date.now();
    const finishFailedBilling = async (message: string, extra: Record<string, unknown> = {}) => {
      const metaPatch = { model: modelName, durationMs: Math.max(1, Date.now() - startedAt), taskStatus: "failed", errorMessage: message, ...extra };
      if (preChargedLedgerId) {
        await settleProcessingLedger({ ledgerId: preChargedLedgerId, userId: user.id, credits: 0, metaPatch }).catch(() => undefined);
      }
    };
    const settleReserved = async (credits: number, metaPatch: Record<string, unknown>) => {
      if (!preChargedLedgerId) return { ok: false, insufficient: false };
      try {
        const result = await settleProcessingLedger({ ledgerId: preChargedLedgerId, userId: user.id, credits, metaPatch });
        return { ok: result.applied && result.uncollectedCredits === 0, insufficient: result.uncollectedCredits > 0 };
      } catch {
        return { ok: false, insufficient: false };
      }
    };

    const disableUpstreamTimeout = !isPolling && (channelModel?.capability === "image" || channelModel?.capability === "video");
    const upstreamSignal = disableUpstreamTimeout
      ? shutdownAbortController.signal
      : AbortSignal.any([
          AbortSignal.timeout(isPolling ? env.AI_POLL_TIMEOUT_MS : env.AI_UPSTREAM_TIMEOUT_MS),
          shutdownAbortController.signal,
        ]);

    let upstream: Response;
    try {
      upstream = await fetch(targetUrl, {
        method, headers: forwardHeaders, body: rawBody, redirect: "error",
        signal: upstreamSignal,
      });
    } catch (error) {
      const restarted = shuttingDown || shutdownAbortController.signal.aborted;
      const timedOut = !restarted && error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      const message = restarted
        ? "服务正在更新重启，请求已中止并释放预占额度"
        : timedOut
          ? "上游请求超时"
          : truncateErrorText(error instanceof Error ? error.message : String(error)) || "上游连接失败";
      await finishFailedBilling(message, { upstreamMs: Math.max(1, Date.now() - startedAt) });
      return c.json({ error: message, message }, restarted ? 503 : timedOut ? 504 : 502);
    }

    const responseHeaders = new Headers();
    for (const name of ["content-type", "retry-after", "cache-control"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    const respType = (upstream.headers.get("content-type") || "").toLowerCase();

    if (!upstream.ok) {
      const errorText = await upstream.text().catch(() => "");
      const errorMessage = extractUpstreamErrorMessage(errorText, upstream.status);
      await finishFailedBilling(errorMessage, { errorStatus: upstream.status });
      return new Response(errorText || JSON.stringify({ error: errorMessage }), { status: upstream.status, headers: responseHeaders });
    }

    if (isPolling && respType.includes("application/json")) {
      const text = await upstream.text();
      let parsed: Record<string, unknown>;
      try {
        const value = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid response");
        parsed = value as Record<string, unknown>;
      } catch {
        return new Response(text, { status: upstream.status, headers: responseHeaders });
      }
      if (route.kind === "task") {
        await handleVideoPollTaskState(user.id, route.taskId, parsed);
        if (mapUpstreamTaskStatus(parsed) === "completed") {
          const savedVideoId = await persistCompletedVideoIfNeeded({
            userId: user.id, taskId: route.taskId, model: modelName, payload: parsed,
            channelBaseUrl: channel.baseUrl, channelApiFormat: channel.apiFormat, channelApiKey: channel.apiKey,
          });
          if (savedVideoId) {
            responseHeaders.set("X-Cloud-Media-Ids", JSON.stringify([savedVideoId]));
            await patchLedgerMetaByTaskId(user.id, route.taskId, { mediaIds: [savedVideoId] }).catch(() => undefined);
          }
        }
        if (channel.apiFormat === "gemini") rewriteGeminiVideoUris(parsed, channelId, route.taskId);
      }
      return new Response(JSON.stringify(parsed), { status: upstream.status, headers: responseHeaders });
    }

    if (!shouldTrackUsage || !channelModel) return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });

    if (channelModel.capability === "image") {
      const text = await upstream.text().catch(() => "");
      const durationMs = Math.max(1, Date.now() - startedAt);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        await finishFailedBilling("上游图片响应解析失败", { upstreamMs: durationMs });
        return c.json({ error: "上游图片响应解析失败" }, 502);
      }
      const actualCount = countReturnedImages(parsed);
      const errorMessage = extractErrorFromPayload(parsed);
      if (actualCount === null || actualCount <= 0) {
        await finishFailedBilling(errorMessage || "上游未返回有效图片", { upstreamMs: durationMs });
        return c.json({ error: errorMessage || "上游未返回有效图片" }, 502);
      }
      const actualCharge = actualCount < requestedImageCount && preCharged > 0
        ? roundCredits(preCharged * actualCount / requestedImageCount)
        : preCharged;
      const persisted = await persistGeneratedImagesFromPayload({
        userId: user.id, payload: parsed, model: modelName, prompt: promptText, clientTaskId: clientTaskId || undefined,
      }).catch(() => ({ mediaIds: [], fetchImageMs: 0, cloudSaveMs: 0 }));
      const savedMediaIds = persisted.mediaIds.filter((id): id is string => Boolean(id));
      if (savedMediaIds.length) responseHeaders.set("X-Cloud-Media-Ids", JSON.stringify(savedMediaIds));
      const imageMeta = {
        model: modelName, count: requestedImageCount, actual: actualCount, durationMs, upstreamMs: durationMs,
        fetchImageMs: persisted.fetchImageMs, cloudSaveMs: persisted.cloudSaveMs, taskStatus: "completed",
        ...(actualCount < requestedImageCount && preCharged > 0 ? { refundDetail: "按实际出图数量扣费" } : {}),
        ...(savedMediaIds.length ? { mediaIds: savedMediaIds } : {}),
        ...(clientAborted ? { clientAborted: true } : {}),
      };
      const settlement = await settleReserved(actualCharge, imageMeta);
      if (!settlement.ok) {
        return c.json({ error: settlement.insufficient ? "积分余额不足，未返回生成结果" : "生图计费未完成，未返回生成结果" }, settlement.insufficient ? 402 : 502);
      }
      return new Response(text, { status: upstream.status, headers: responseHeaders });
    }

    if (channelModel.capability === "video" && respType.includes("application/json")) {
      const text = await upstream.text().catch(() => "");
      let parsed: Record<string, unknown>;
      try {
        const value = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid response");
        parsed = value as Record<string, unknown>;
      } catch {
        await finishFailedBilling("上游视频任务响应解析失败");
        return c.json({ error: "上游视频任务响应解析失败" }, 502);
      }
      const taskId =
        (typeof parsed.id === "string" ? parsed.id : "") ||
        (parsed.data && typeof parsed.data === "object" && typeof (parsed.data as { id?: unknown }).id === "string" ? (parsed.data as { id: string }).id : "") ||
        (typeof parsed.name === "string" ? parsed.name : "");
      const taskStatus = mapUpstreamTaskStatus(parsed);
      if (!taskId || taskStatus === "failed") {
        const message = extractErrorFromPayload(parsed) || "上游未创建有效的视频任务";
        await finishFailedBilling(message);
        return c.json({ error: message }, 502);
      }
      const settlement = await settleReserved(preCharged, { taskId, taskStatus });
      if (preCharged > 0 && !settlement.ok) {
        return c.json({ error: settlement.insufficient ? "积分余额不足，未创建视频任务" : "视频计费未完成，未创建视频任务" }, settlement.insufficient ? 402 : 502);
      }
      const insertedTask = await db.insert(aiBillingTasks).values({
        id: nanoid(), userId: user.id, channelId, model: modelName, taskId, chargedCredits: preCharged,
        status: taskStatus === "completed" ? "completed" : "pending",
      }).onConflictDoNothing().returning({ id: aiBillingTasks.id }).then((rows) => rows[0]).catch(() => undefined);
      if (!insertedTask) {
        if (preCharged > 0) {
          await refundLedgerCharge({
            userId: user.id,
            ledgerId: preChargedLedgerId || undefined,
            taskId,
            refId: taskId,
            refundAmount: preCharged,
            markFailed: true,
            metaPatch: { errorMessage: "上游任务编号冲突，已拦截并退回积分", refundDetail: "上游任务编号冲突自动退回" },
          }).catch(() => undefined);
        } else {
          await patchLedgerMeta(preChargedLedgerId, { taskStatus: "failed", errorMessage: "上游任务编号冲突，已拦截结果" }).catch(() => undefined);
        }
        return c.json({ error: "上游任务编号冲突，已拦截结果" }, 502);
      }
      return new Response(text, { status: upstream.status, headers: responseHeaders });
    }

    if (channelModel.capability === "video") {
      await finishFailedBilling("上游视频任务响应格式无效");
      return c.json({ error: "上游视频任务响应格式无效" }, 502);
    }

    if (channelModel.capability === "audio") {
      let bytes: Buffer;
      try {
        bytes = Buffer.from(await upstream.arrayBuffer());
      } catch {
        await finishFailedBilling("上游音频响应读取失败");
        return c.json({ error: "上游音频响应读取失败" }, 502);
      }
      const audio = await readAudioOutput(bytes, respType, generation?.audioResponseFormat);
      if (!audio) {
        await finishFailedBilling("无法验证上游音频内容及真实时长");
        return c.json({ error: "无法验证上游音频内容及真实时长" }, 502);
      }
      const durationMs = Math.max(1, Date.now() - startedAt);
      const credits = pricing ? calculateAudioCharge(pricing as AudioModelPricing, audio.durationSeconds) : 0;
      if (credits === null) {
        await finishFailedBilling("语音计费数值超出可计算范围");
        return c.json({ error: "语音计费数值超出可计算范围，未返回生成结果" }, 502);
      }
      const settlement = await settleReserved(credits, {
        model: modelName, durationSeconds: Math.round(audio.durationSeconds * 100) / 100,
        isStream: false, durationMs, taskStatus: "completed",
      });
      if (!settlement.ok) {
        return c.json({ error: settlement.insufficient ? "积分余额不足，未返回生成结果" : "语音计费未完成，未返回生成结果" }, settlement.insufficient ? 402 : 502);
      }
      const savedAudio = await persistCloudMediaBuffer({
        userId: user.id, kind: "audio", buffer: audio.buffer, mimeType: audio.mimeType,
        durationMs: Math.round(audio.durationSeconds * 1000), sourceType: "ai_generated",
        meta: { model: modelName, ...(clientTaskId ? { clientTaskId } : {}) },
      }).catch(() => null);
      if (savedAudio?.mediaId) responseHeaders.set("X-Cloud-Media-Ids", JSON.stringify([savedAudio.mediaId]));
      if (respType.includes("application/json")) responseHeaders.set("content-type", respType);
      else responseHeaders.set("content-type", audio.mimeType);
      return new Response(new Uint8Array(bytes), { status: upstream.status, headers: responseHeaders });
    }

    if (channelModel.capability === "text") {
      const isSse = respType.includes("text/event-stream");
      let usage: UsageTotals | null = null;
      let resultText = "";
      let firstChunkMs: number | undefined;
      let firstContentMs: number | undefined;

      if (isSse) {
        if (!upstream.body) {
          await finishFailedBilling("上游未返回流式内容");
          return c.json({ error: "上游未返回流式内容，未返回生成结果" }, 502);
        }
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        const inspectLine = (line: string) => {
          if (!line.startsWith("data:")) return;
          const raw = line.slice(5).trim();
          if (!raw || raw === "[DONE]") return;
          try {
            const parsed = JSON.parse(raw);
            if (firstContentMs === undefined && hasStreamContentToken(parsed)) firstContentMs = Math.max(1, Date.now() - startedAt);
            const delta = extractStreamTextDelta(parsed);
            if (delta) resultText = appendCappedText(resultText, delta);
            else if (!resultText) resultText = appendCappedText(resultText, extractFinalTextFromPayload(parsed));
            usage = extractUsageFromObject(parsed) || usage;
          } catch {
            // 无效事件由缺少 usage 的付费结算门槛拦截。
          }
        };

        let settlePromise: Promise<void> | null = null;
        const settleStream = (abortedOrErrored: boolean, failReason?: string) => {
          if (settlePromise) return settlePromise;
          settlePromise = (async () => {
            const durationMs = Math.max(1, Date.now() - startedAt);
            const firstTokenMs = Math.min(durationMs, Math.max(1, firstContentMs ?? firstChunkMs ?? durationMs));
            if ((shouldBill && !usage) || (abortedOrErrored && !usage && failReason)) {
              await finishFailedBilling(failReason || "上游未返回可验证的 Token 用量", {
                isStream: true,
                firstTokenMs,
                ...(clientAborted || abortedOrErrored ? { clientAborted: true } : {}),
                ...(resultText ? { resultText } : {}),
              });
              return;
            }
            const credits = usage && pricing ? calculateTextCharge(pricing as TextModelPricing, usage) : 0;
            if (credits === null) {
              await finishFailedBilling("文本计费数值超出可计算范围", {
                isStream: true,
                firstTokenMs,
                ...(clientAborted || abortedOrErrored ? { clientAborted: true } : {}),
                ...(resultText ? { resultText } : {}),
              });
              return;
            }
            await settleReserved(credits, {
              model: modelName,
              ...(usage ?? {}),
              isStream: true,
              durationMs,
              firstTokenMs,
              ...(usage ? { tokensPerSecond: calcTokensPerSecond(usage.outputTokens, durationMs, firstTokenMs) } : {}),
              ...(clientAborted || abortedOrErrored ? { clientAborted: true } : {}),
              ...(resultText ? { resultText } : {}),
              taskStatus: "completed",
            });
          })();
          return settlePromise;
        };

        const onStreamAbort = () => {
          if (!shuttingDown) clientAborted = true;
          void reader.cancel().catch(() => undefined);
        };
        const cleanupStream = () => {
          c.req.raw.signal?.removeEventListener("abort", onStreamAbort);
          shutdownAbortController.signal.removeEventListener("abort", onStreamAbort);
          releaseProxyResources();
        };
        c.req.raw.signal?.addEventListener("abort", onStreamAbort, { once: true });
        shutdownAbortController.signal.addEventListener("abort", onStreamAbort, { once: true });

        streamOwnsSlot = true;
        let stream: ReadableStream<Uint8Array>;
        try {
          stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              try {
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  if (value.byteLength) {
                    if (firstChunkMs === undefined) firstChunkMs = Math.max(1, Date.now() - startedAt);
                    controller.enqueue(value);
                    pending += decoder.decode(value, { stream: true });
                    const lines = pending.split(/\r?\n/);
                    pending = lines.pop() || "";
                    for (const line of lines) inspectLine(line);
                  }
                }
                pending += decoder.decode();
                if (pending) inspectLine(pending);
                await settleStream(
                  clientAborted || shuttingDown,
                  shuttingDown
                    ? "服务正在更新重启，流式请求已中止"
                    : clientAborted
                      ? "客户端取消流式请求"
                      : undefined,
                );
                try {
                  controller.close();
                } catch {
                  // 客户端已断开
                }
              } catch (error) {
                const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
                const failMsg = shuttingDown
                  ? "服务正在更新重启，流式请求已中止"
                  : clientAborted
                    ? "客户端取消流式请求"
                    : timedOut
                      ? "上游流式响应超时"
                      : "上游流式响应读取失败";
                await settleStream(true, failMsg);
                try {
                  if (!clientAborted) controller.error(error);
                } catch {
                  // 流已关闭或已取消
                }
              } finally {
                cleanupStream();
              }
            },
            async cancel() {
              clientAborted = true;
              await reader.cancel().catch(() => undefined);
              await settleStream(true, "客户端取消流式请求");
              cleanupStream();
            },
          });
        } catch (error) {
          streamOwnsSlot = false;
          c.req.raw.signal?.removeEventListener("abort", onStreamAbort);
          shutdownAbortController.signal.removeEventListener("abort", onStreamAbort);
          throw error;
        }
        return new Response(stream, { status: upstream.status, headers: responseHeaders });
      }

      let bytes: Uint8Array<ArrayBuffer>;
      let responseText = "";
      try {
        bytes = new Uint8Array(await upstream.arrayBuffer());
      } catch {
        await finishFailedBilling("上游文本响应读取失败");
        return c.json({ error: "上游文本响应读取失败，未返回生成结果" }, 502);
      }
      responseText = new TextDecoder().decode(bytes);
      try {
        const parsed = JSON.parse(responseText);
        usage = extractUsageFromObject(parsed);
        resultText = appendCappedText("", extractFinalTextFromPayload(parsed));
      } catch {
        await finishFailedBilling("上游文本响应解析失败");
        return c.json({ error: "上游文本响应解析失败，未返回生成结果" }, 502);
      }
      const durationMs = Math.max(1, Date.now() - startedAt);

      if (shouldBill && !usage) {
        await finishFailedBilling("上游未返回可验证的 Token 用量");
        return c.json({ error: "上游未返回可验证的 Token 用量，未返回生成结果" }, 502);
      }
      const credits = usage && pricing ? calculateTextCharge(pricing as TextModelPricing, usage) : 0;
      if (credits === null) {
        await finishFailedBilling("文本计费数值超出可计算范围");
        return c.json({ error: "文本计费数值超出可计算范围，未返回生成结果" }, 502);
      }
      const settlement = await settleReserved(credits, {
        model: modelName, ...(usage ?? {}), isStream: false, durationMs,
        ...(usage ? { tokensPerSecond: calcTokensPerSecond(usage.outputTokens, durationMs, undefined) } : {}),
        ...(clientAborted ? { clientAborted: true } : {}),
        ...(resultText ? { resultText } : {}),
        taskStatus: "completed",
      });
      if (!settlement.ok) {
        return c.json({ error: settlement.insufficient ? "积分余额不足，未返回生成结果" : "文本计费未完成，未返回生成结果" }, settlement.insufficient ? 402 : 502);
      }
      return new Response(bytes, { status: upstream.status, headers: responseHeaders });
    }

    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } finally {
    if (!streamOwnsSlot) {
      releaseProxyResources();
    }
  }
});
