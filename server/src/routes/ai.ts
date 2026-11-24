/** 平台 AI 代理转发网关：隐藏上游渠道密钥、拦截计费预扣、流式首字/速率采样及异步视频任务状态跟踪。 */
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { parseBuffer } from "music-metadata";
import { nanoid } from "nanoid";

import { aiBillingTasks, db, mediaObjects, users } from "../db/index.ts";
import { persistCloudMediaBuffer, persistGeneratedImagesFromPayload } from "../lib/ai-media-persist.ts";
import {
  adjustWalletCredits,
  calculateAudioCredits,
  calculateImageCredits,
  calculateTextCredits,
  calculateVideoCredits,
  getWalletBalance,
  hasNonZeroPricing,
  patchLedgerMeta,
  patchLedgerMetaByTaskId,
  roundCredits,
} from "../lib/billing.ts";
import { verifyAccessToken } from "../lib/jwt.ts";
import {
  getPlatformChannels,
  type AudioModelPricing,
  type ImageModelPricing,
  type PlatformChannelModel,
  type TextModelPricing,
  type VideoModelPricing,
} from "../lib/settings.ts";

export const aiRoutes = new Hono();

type UsageTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

function buildUpstreamUrl(baseUrl: string, subPath: string, rawSearch: string, apiFormat: "openai" | "gemini", apiKey: string) {
  const cleanBase = baseUrl.trim().replace(/\/+$/, "");
  let cleanSub = subPath.startsWith("/") ? subPath : `/${subPath}`;
  const lowerBase = cleanBase.toLowerCase();
  if (lowerBase.endsWith("/v1") && (cleanSub === "/v1" || cleanSub.startsWith("/v1/"))) {
    cleanSub = cleanSub.slice(3) || "/";
  } else if (lowerBase.endsWith("/v1beta") && (cleanSub === "/v1beta" || cleanSub.startsWith("/v1beta/"))) {
    cleanSub = cleanSub.slice(7) || "/";
  }

  const target = new URL(`${cleanBase}${cleanSub}`);
  const incomingParams = new URLSearchParams(rawSearch);
  const hadKeyParam = incomingParams.has("key");
  incomingParams.delete("key");
  incomingParams.forEach((value, key) => target.searchParams.append(key, value));
  if (apiFormat === "gemini" && hadKeyParam) {
    target.searchParams.set("key", apiKey);
  }
  return target.toString();
}

function extractGeminiModelFromPath(subPath: string) {
  const match = subPath.match(/\/models\/([^/:]+):/);
  return match ? decodeURIComponent(match[1]) : "";
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
    const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
    const cachedInputTokens = Number(inputDetails?.cached_tokens ?? 0);
    const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
    if (inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0) {
      return { inputTokens, cachedInputTokens, outputTokens };
    }
  }

  // Gemini usageMetadata
  const meta = rec.usageMetadata as Record<string, unknown> | undefined;
  if (meta && typeof meta === "object") {
    const inputTokens = Number(meta.promptTokenCount ?? 0);
    const cachedInputTokens = Number(meta.cachedContentTokenCount ?? 0);
    const outputTokens = Number(meta.candidatesTokenCount ?? 0) + Number(meta.thoughtsTokenCount ?? 0);
    if (inputTokens > 0 || outputTokens > 0 || cachedInputTokens > 0) {
      return { inputTokens, cachedInputTokens, outputTokens };
    }
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

function isVideoPollingOrContentRequest(method: string, subPath: string) {
  if (method === "GET" || method === "HEAD") return true;
  if (subPath.includes("/operations/")) return true;
  return false;
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

    let videoRes: Response | null = null;
    if (directUrl) {
      const target =
        params.channelApiFormat === "gemini" && !directUrl.includes("key=")
          ? `${directUrl}${directUrl.includes("?") ? "&" : "?"}key=${encodeURIComponent(params.channelApiKey)}`
          : directUrl;
      videoRes = await fetch(target);
    } else if (params.channelApiFormat === "openai") {
      const contentUrl = buildUpstreamUrl(params.channelBaseUrl, `/v1/videos/${encodeURIComponent(params.taskId)}/content`, "", "openai", params.channelApiKey);
      videoRes = await fetch(contentUrl, {
        headers: { Authorization: `Bearer ${params.channelApiKey}` },
      });
    }

    if (!videoRes || !videoRes.ok) return null;
    const mimeType = videoRes.headers.get("content-type")?.split(";")[0]?.trim() || "video/mp4";
    if (mimeType.includes("application/json")) return null;

    const buffer = Buffer.from(await videoRes.arrayBuffer());
    const saved = await persistCloudMediaBuffer({
      userId: params.userId,
      kind: "video",
      buffer,
      mimeType: mimeType.startsWith("video/") ? mimeType : "video/mp4",
      sourceType: "ai_generated",
      meta: {
        model: params.model,
        videoTaskId: params.taskId,
        clientTaskId: params.taskId,
      },
    });
    return saved?.mediaId ?? null;
  } catch (error) {
    console.warn("[ai-media-persist] 服务端转存完成视频失败:", error);
    return null;
  }
}

async function handleVideoPollTaskState(userId: string, taskId: string, payload: unknown) {
  if (!taskId || !payload || typeof payload !== "object") return;
  const nextStatus = mapUpstreamTaskStatus(payload);
  const task = await db.query.aiBillingTasks.findFirst({
    where: and(eq(aiBillingTasks.taskId, taskId), eq(aiBillingTasks.userId, userId)),
  });
  if (!task || task.status !== "pending") return;

  await patchLedgerMetaByTaskId(userId, taskId, { taskStatus: nextStatus }).catch(() => undefined);

  if (nextStatus === "failed") {
    const [updated] = await db
      .update(aiBillingTasks)
      .set({ status: "refunded", updatedAt: new Date() })
      .where(and(eq(aiBillingTasks.id, task.id), eq(aiBillingTasks.status, "pending")))
      .returning();
    if (updated && updated.chargedCredits > 0) {
      await adjustWalletCredits({
        userId,
        delta: updated.chargedCredits,
        reason: "refund",
        refId: task.taskId,
        meta: { model: task.model, taskStatus: "refunded", detail: "视频生成任务失败自动退回积分" },
      });
    }
  } else if (nextStatus === "completed") {
    await db
      .update(aiBillingTasks)
      .set({ status: "completed", updatedAt: new Date() })
      .where(and(eq(aiBillingTasks.id, task.id), eq(aiBillingTasks.status, "pending")));
  }
}

aiRoutes.all("/proxy/:channelId/*", async (c) => {
  const authHeader = c.req.header("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const googleKeyToken = c.req.header("x-goog-api-key")?.trim() || "";
  const queryToken = c.req.query("key")?.trim() || "";
  const token = bearerToken || googleKeyToken || queryToken;

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
  const targetUrl = buildUpstreamUrl(channel.baseUrl, subPath, fullUrl.search, channel.apiFormat, channel.apiKey);

  const method = c.req.method.toUpperCase();
  const contentType = c.req.header("Content-Type") || "";
  const isPolling = isVideoPollingOrContentRequest(method, subPath);

  let rawBody: ArrayBuffer | undefined;
  let jsonBody: Record<string, unknown> | null = null;
  let formModel = "";
  let formPrompt = "";
  let formCount = 1;
  let formSize = "";
  let formSeconds = 0;
  let formHasRefVideo = false;
  const clientTaskId = c.req.header("X-Client-Task-Id")?.trim() || "";

  if (method !== "GET" && method !== "HEAD") {
    if (contentType.includes("application/json")) {
      rawBody = await c.req.arrayBuffer();
      try {
        jsonBody = JSON.parse(new TextDecoder().decode(rawBody)) as Record<string, unknown>;
      } catch {
        jsonBody = null;
      }
    } else if (contentType.includes("multipart/form-data")) {
      const cloned = c.req.raw.clone();
      rawBody = await c.req.arrayBuffer();
      try {
        const form = await cloned.formData();
        formModel = String(form.get("model") || "");
        formPrompt = String(form.get("prompt") || "");
        formCount = Math.max(1, Number(form.get("n") || 1));
        formSize = String(form.get("size") || "");
        formSeconds = Number(form.get("seconds") || 0);
        formHasRefVideo = form.has("video[]") || form.has("video");
      } catch {
        // ignore multipart parse failure
      }
    } else {
      rawBody = await c.req.arrayBuffer();
    }
  }

  const promptText =
    (typeof jsonBody?.prompt === "string" ? jsonBody.prompt : "") ||
    formPrompt ||
    (Array.isArray(jsonBody?.contents)
      ? ((jsonBody.contents[0] as { parts?: Array<{ text?: string }> } | undefined)?.parts || [])
          .map((p) => (typeof p.text === "string" ? p.text : ""))
          .filter(Boolean)
          .join("\n")
      : "");

  const modelName =
    extractGeminiModelFromPath(subPath) ||
    (typeof jsonBody?.model === "string" ? jsonBody.model : "") ||
    formModel ||
    c.req.header("X-Canvas-Model")?.trim() ||
    "";

  const channelModel: PlatformChannelModel | undefined = channel.models.find((m) => m.name === modelName);
  const pricing = channelModel?.pricing;
  // 所有受管模型 POST 请求均记录使用日志（含免费模型与极小用量 0 积分调用）
  const shouldTrackUsage = !isPolling && method === "POST" && Boolean(channelModel);
  const shouldBill = shouldTrackUsage && hasNonZeroPricing(pricing);

  // 为 OpenAI chat/completions 流式请求补充 include_usage 以便结算 Token
  if (
    shouldTrackUsage &&
    channelModel?.capability === "text" &&
    jsonBody &&
    jsonBody.stream === true &&
    subPath.includes("/chat/completions") &&
    !jsonBody.stream_options
  ) {
    jsonBody = { ...jsonBody, stream_options: { include_usage: true } };
    rawBody = new TextEncoder().encode(JSON.stringify(jsonBody)).buffer as ArrayBuffer;
  }

  const forwardHeaders = new Headers(c.req.raw.headers);
  [
    "host",
    "content-length",
    "connection",
    "origin",
    "referer",
    "authorization",
    "x-goog-api-key",
    "x-canvas-model",
    "x-client-task-id",
    "x-billing-resolution",
    "x-billing-ref-video-seconds",
  ].forEach((key) => forwardHeaders.delete(key));

  if (channel.apiFormat === "gemini") {
    forwardHeaders.set("x-goog-api-key", channel.apiKey);
  } else {
    forwardHeaders.set("Authorization", `Bearer ${channel.apiKey}`);
  }

  // 预检查与预扣费
  let preCharged = 0;
  let preChargedLedgerId = "";
  let requestedImageCount = 1;

  if (shouldTrackUsage && channelModel) {
    if (channelModel.capability === "image") {
      const genConfig = jsonBody?.generationConfig as Record<string, unknown> | undefined;
      const imageConfig = genConfig?.imageConfig as Record<string, unknown> | undefined;
      requestedImageCount = Math.max(
        1,
        Math.floor(Number(jsonBody?.n ?? genConfig?.candidateCount ?? formCount ?? 1)),
      );
      const resolutionTier =
        (typeof imageConfig?.imageSize === "string" ? imageConfig.imageSize : undefined) ||
        c.req.header("X-Billing-Resolution") ||
        undefined;
      const sizeStr = (typeof jsonBody?.size === "string" ? jsonBody.size : "") || formSize;
      preCharged = pricing ? calculateImageCredits(pricing as ImageModelPricing, requestedImageCount, resolutionTier, sizeStr) : 0;

      const deduct = await adjustWalletCredits({
        userId: user.id,
        delta: -preCharged,
        reason: "image_gen",
        forceLedger: true,
        meta: {
          model: modelName,
          count: requestedImageCount,
          resolutionTier,
          size: sizeStr,
          isStream: false,
          taskStatus: "processing",
          ...(clientTaskId ? { clientTaskId } : {}),
        },
      });
      if (!deduct.ok) {
        const msg = `积分不足（当前余额 ${deduct.balance}，本次预计需要 ${preCharged}）`;
        return c.json({ error: msg, message: msg }, 402);
      }
      preChargedLedgerId = deduct.ledgerId;
    } else if (channelModel.capability === "video") {
      const geminiParams = jsonBody?.parameters as Record<string, unknown> | undefined;
      const geminiInstances = Array.isArray(jsonBody?.instances) ? (jsonBody?.instances as Array<Record<string, unknown>>) : [];
      const seconds =
        formSeconds ||
        Number(jsonBody?.seconds ?? geminiParams?.durationSeconds ?? c.req.header("X-Billing-Video-Seconds") ?? 8);
      const hasReferenceVideo =
        formHasRefVideo || Boolean(geminiInstances[0]?.video) || c.req.header("X-Billing-Ref-Video") === "1";
      const refSecondsRaw = Number(c.req.header("X-Billing-Ref-Video-Seconds") || 0);
      preCharged = pricing
        ? calculateVideoCredits(pricing as VideoModelPricing, {
            seconds,
            hasReferenceVideo,
            referenceVideoSeconds: refSecondsRaw > 0 ? refSecondsRaw : undefined,
          })
        : 0;

      const deduct = await adjustWalletCredits({
        userId: user.id,
        delta: -preCharged,
        reason: "video_gen",
        forceLedger: true,
        meta: { model: modelName, seconds, hasReferenceVideo, isStream: false, taskStatus: "not_started" },
      });
      if (!deduct.ok) {
        const msg = `积分不足（当前余额 ${deduct.balance}，本次需要 ${preCharged}）`;
        return c.json({ error: msg, message: msg }, 402);
      }
      preChargedLedgerId = deduct.ledgerId;
    } else if (shouldBill) {
      const balance = await getWalletBalance(user.id);
      if (balance <= 0) {
        const msg = "积分余额不足，请先充值或联系管理员";
        return c.json({ error: msg, message: msg }, 402);
      }
    }
  }

  const startedAt = Date.now();
  let clientAborted = Boolean(c.req.raw.signal?.aborted);
  const handleAbort = () => {
    clientAborted = true;
  };
  c.req.raw.signal?.addEventListener("abort", handleAbort, { once: true });

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method,
      headers: forwardHeaders,
      body: rawBody,
    });
  } catch (error) {
    c.req.raw.signal?.removeEventListener("abort", handleAbort);
    const elapsedMs = Math.max(1, Date.now() - startedAt);
    if (preChargedLedgerId) {
      await patchLedgerMeta(preChargedLedgerId, {
        taskStatus: "failed",
        durationMs: elapsedMs,
        upstreamMs: elapsedMs,
        ...(clientAborted ? { clientAborted: true } : {}),
      }).catch(() => undefined);
    }
    if (preCharged > 0) {
      await adjustWalletCredits({
        userId: user.id,
        delta: preCharged,
        reason: "refund",
        meta: { model: modelName, taskStatus: "refunded", detail: "上游连接失败自动退回" },
      });
    }
    throw error;
  }

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  const respType = (upstream.headers.get("content-type") || "").toLowerCase();

  // 轮询视频状态时检查任务是否失败并自动退回预扣积分；若视频完成则尝试服务端自动归档对象存储
  if (method === "GET" && upstream.ok && respType.includes("application/json") && !subPath.endsWith("/content")) {
    const text = await upstream.text();
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const videoMatch = subPath.match(/\/videos\/([^/]+)$/);
      const geminiMatch = subPath.match(/\/v1beta\/(.+)$/);
      const taskId = videoMatch?.[1] || (typeof parsed.name === "string" ? parsed.name : geminiMatch?.[1] || "");
      if (taskId) {
        await handleVideoPollTaskState(user.id, taskId, parsed);
        if (mapUpstreamTaskStatus(parsed) === "completed") {
          const savedVideoId = await persistCompletedVideoIfNeeded({
            userId: user.id,
            taskId,
            model: modelName,
            payload: parsed,
            channelBaseUrl: channel.baseUrl,
            channelApiFormat: channel.apiFormat,
            channelApiKey: channel.apiKey,
          });
          if (savedVideoId) {
            responseHeaders.set("X-Cloud-Media-Ids", JSON.stringify([savedVideoId]));
            await patchLedgerMetaByTaskId(user.id, taskId, { mediaIds: [savedVideoId] }).catch(() => undefined);
          }
        }
      }
    } catch {
      // ignore poll inspect error
    }
    return new Response(text, { status: upstream.status, headers: responseHeaders });
  }

  if (!upstream.ok) {
    c.req.raw.signal?.removeEventListener("abort", handleAbort);
    const elapsedMs = Math.max(1, Date.now() - startedAt);
    if (preChargedLedgerId) {
      await patchLedgerMeta(preChargedLedgerId, {
        taskStatus: "failed",
        durationMs: elapsedMs,
        upstreamMs: elapsedMs,
        ...(clientAborted ? { clientAborted: true } : {}),
      }).catch(() => undefined);
    }
    if (preCharged > 0) {
      await adjustWalletCredits({
        userId: user.id,
        delta: preCharged,
        reason: "refund",
        meta: { model: modelName, status: upstream.status, taskStatus: "refunded", detail: "请求失败自动退回" },
      });
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  }

  if (!shouldTrackUsage || !channelModel) {
    c.req.raw.signal?.removeEventListener("abort", handleAbort);
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  }

  // 图片生成成功校验实际出图张数并自动转存至云端对象存储（分段记录上游生成、拿图与云端存储耗时）
  if (channelModel.capability === "image") {
    if (respType.includes("application/json")) {
      const text = await upstream.text();
      const upstreamMs = Math.max(1, Date.now() - startedAt);
      let imageTaskStatus: "completed" | "failed" = "completed";
      let savedMediaIds: string[] = [];
      let fetchImageMs = 0;
      let cloudSaveMs = 0;
      try {
        const parsed = JSON.parse(text);
        const actualCount = countReturnedImages(parsed);
        if (actualCount !== null && actualCount < requestedImageCount) {
          if (actualCount <= 0) imageTaskStatus = "failed";
          const refundAmount =
            actualCount <= 0
              ? preCharged
              : roundCredits((preCharged * (requestedImageCount - actualCount)) / requestedImageCount);
          if (refundAmount > 0) {
            await adjustWalletCredits({
              userId: user.id,
              delta: refundAmount,
              reason: "refund",
              meta: { model: modelName, requested: requestedImageCount, actual: actualCount, taskStatus: "refunded", detail: "按实际出图数量退回差额" },
            });
          }
        }
        const persisted = await persistGeneratedImagesFromPayload({
          userId: user.id,
          payload: parsed,
          model: modelName,
          prompt: promptText,
          clientTaskId: clientTaskId || undefined,
        });
        fetchImageMs = persisted.fetchImageMs;
        cloudSaveMs = persisted.cloudSaveMs;
        savedMediaIds = persisted.mediaIds.filter((id): id is string => Boolean(id));
        if (savedMediaIds.length) {
          responseHeaders.set("X-Cloud-Media-Ids", JSON.stringify(persisted.mediaIds));
        }
      } catch {
        // ignore parse failure
      }
      c.req.raw.signal?.removeEventListener("abort", handleAbort);
      if (preChargedLedgerId) {
        await patchLedgerMeta(preChargedLedgerId, {
          durationMs: Math.max(1, Date.now() - startedAt),
          upstreamMs,
          fetchImageMs,
          cloudSaveMs,
          isStream: false,
          taskStatus: imageTaskStatus,
          ...(clientAborted ? { clientAborted: true } : {}),
          ...(savedMediaIds.length ? { mediaIds: savedMediaIds } : {}),
        }).catch(() => undefined);
      }
      return new Response(text, { status: upstream.status, headers: responseHeaders });
    }
    c.req.raw.signal?.removeEventListener("abort", handleAbort);
    const upstreamMs = Math.max(1, Date.now() - startedAt);
    if (preChargedLedgerId) {
      await patchLedgerMeta(preChargedLedgerId, {
        durationMs: upstreamMs,
        upstreamMs,
        isStream: false,
        taskStatus: "completed",
        ...(clientAborted ? { clientAborted: true } : {}),
      }).catch(() => undefined);
    }
  }

  // 视频创建成功记录 taskId 以便轮询更新状态及失败退费，并回写耗时与任务状态
  if (channelModel.capability === "video" && respType.includes("application/json")) {
    const text = await upstream.text();
    let taskId = "";
    let initialTaskStatus: "not_started" | "processing" | "completed" | "failed" = "processing";
    try {
      const parsed = JSON.parse(text) as { id?: string; name?: string; data?: { id?: string } };
      taskId = parsed.id || parsed.data?.id || parsed.name || "";
      initialTaskStatus = mapUpstreamTaskStatus(parsed);
      if (taskId) {
        await db
          .insert(aiBillingTasks)
          .values({
            id: nanoid(),
            userId: user.id,
            channelId,
            model: modelName,
            taskId,
            chargedCredits: preCharged,
            status: initialTaskStatus === "completed" ? "completed" : "pending",
          })
          .onConflictDoNothing();
      }
    } catch {
      // ignore parse failure
    }
    if (preChargedLedgerId) {
      await patchLedgerMeta(preChargedLedgerId, {
        durationMs: Math.max(1, Date.now() - startedAt),
        isStream: false,
        taskStatus: initialTaskStatus,
        ...(taskId ? { taskId } : {}),
      }).catch(() => undefined);
    }
    return new Response(text, { status: upstream.status, headers: responseHeaders });
  }

  // 语音模型：使用 music-metadata 读取真实音频秒数并记录日志/扣费，同时自动转存云端
  if (channelModel.capability === "audio") {
    const buffer = await upstream.arrayBuffer();
    const durationMs = Math.max(1, Date.now() - startedAt);
    let duration = 0;
    try {
      const metadata = await parseBuffer(new Uint8Array(buffer), { mimeType: respType || undefined });
      duration = metadata.format.duration || 0;
    } catch (error) {
      console.warn("[billing] 解析音频时长失败:", error);
    }
    const credits = pricing ? calculateAudioCredits(pricing as AudioModelPricing, duration) : 0;
    await adjustWalletCredits({
      userId: user.id,
      delta: -credits,
      reason: "audio_gen",
      allowNegative: true,
      forceLedger: true,
      meta: { model: modelName, durationSeconds: Math.round(duration * 100) / 100, isStream: false, durationMs, taskStatus: "completed" },
    }).catch(() => undefined);
    const savedAudio = await persistCloudMediaBuffer({
      userId: user.id,
      kind: "audio",
      buffer: Buffer.from(buffer),
      mimeType: respType || "audio/mpeg",
      durationMs: Math.round(duration * 1000) || null,
      sourceType: "ai_generated",
      meta: {
        model: modelName,
        ...(clientTaskId ? { clientTaskId } : {}),
      },
    }).catch(() => null);
    if (savedAudio?.mediaId) {
      responseHeaders.set("X-Cloud-Media-Ids", JSON.stringify([savedAudio.mediaId]));
    }
    return new Response(buffer, { status: upstream.status, headers: responseHeaders });
  }

  // 文本对话模型：按 Token (M) 与缓存输入/输出结算，即使为 0 积分或无 usage 亦留存使用日志
  if (channelModel.capability === "text") {
    if (respType.includes("text/event-stream") && upstream.body) {
      const decoder = new TextDecoder();
      let sseBuffer = "";
      let latestUsage: UsageTotals | null = null;
      let firstChunkMs: number | undefined;
      let firstContentMs: number | undefined;
      const textPricing = pricing as TextModelPricing | undefined;

      const inspectSseLine = (line: string) => {
        if (!line.startsWith("data:")) return;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") return;
        try {
          const parsed = JSON.parse(raw);
          if (firstChunkMs === undefined) firstChunkMs = Math.max(1, Date.now() - startedAt);
          if (firstContentMs === undefined && hasStreamContentToken(parsed)) {
            firstContentMs = Math.max(1, Date.now() - startedAt);
          }
          const u = extractUsageFromObject(parsed);
          if (u) latestUsage = u;
        } catch {
          // ignore non-json sse event
        }
      };

      const tapStream = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          sseBuffer += decoder.decode(chunk, { stream: true });
          const lines = sseBuffer.split(/\r?\n/);
          sseBuffer = lines.pop() || "";
          for (const line of lines) {
            inspectSseLine(line);
          }
        },
        async flush() {
          if (sseBuffer.trim().startsWith("data:")) {
            inspectSseLine(sseBuffer.trim());
          }
          const durationMs = Math.max(1, Date.now() - startedAt);
          const firstTokenMs = Math.min(durationMs, Math.max(1, firstContentMs ?? firstChunkMs ?? durationMs));
          const usageMeta = latestUsage ?? {};
          const tokensPerSecond = latestUsage ? calcTokensPerSecond(latestUsage.outputTokens, durationMs, firstTokenMs) : undefined;
          const credits = latestUsage && textPricing ? calculateTextCredits(textPricing, latestUsage) : 0;
          await adjustWalletCredits({
            userId: user.id,
            delta: -credits,
            reason: "text_gen",
            allowNegative: true,
            forceLedger: true,
            meta: {
              model: modelName,
              ...usageMeta,
              isStream: true,
              durationMs,
              firstTokenMs,
              ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
              taskStatus: "completed",
            },
          });
        },
      });

      return new Response(upstream.body.pipeThrough(tapStream), {
        status: upstream.status,
        headers: responseHeaders,
      });
    }

    if (respType.includes("application/json")) {
      const text = await upstream.text();
      const durationMs = Math.max(1, Date.now() - startedAt);
      let usage: UsageTotals | null = null;
      try {
        usage = extractUsageFromObject(JSON.parse(text));
      } catch {
        // ignore parse failure
      }
      const tokensPerSecond = usage ? calcTokensPerSecond(usage.outputTokens, durationMs) : undefined;
      const credits = usage && pricing ? calculateTextCredits(pricing as TextModelPricing, usage) : 0;
      await adjustWalletCredits({
        userId: user.id,
        delta: -credits,
        reason: "text_gen",
        allowNegative: true,
        forceLedger: true,
        meta: {
          model: modelName,
          ...(usage ?? {}),
          isStream: false,
          durationMs,
          ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
          taskStatus: "completed",
        },
      });
      return new Response(text, { status: upstream.status, headers: responseHeaders });
    }
  }

  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
});
