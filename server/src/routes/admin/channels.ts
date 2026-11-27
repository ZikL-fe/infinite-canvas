/** 管理后台：AI 模型渠道与模型列表拉取路由。 */
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { maskSecret } from "../../lib/crypto.ts";
import { getPlatformChannels, savePlatformChannels, type PlatformChannel } from "../../lib/settings.ts";
import type { AppEnv } from "../../middleware/auth.ts";

const modelPricingSchema = z
  .union([
    z.object({
      mode: z.literal("token"),
      inputPerMillion: z.number().nonnegative(),
      cachedInputPerMillion: z.number().nonnegative().default(0),
      outputPerMillion: z.number().nonnegative(),
    }),
    z.object({
      mode: z.literal("per_image"),
      perImage: z.number().nonnegative(),
    }),
    z.object({
      mode: z.literal("per_resolution"),
      resolutionPrices: z.object({
        "1k": z.number().nonnegative().optional(),
        "2k": z.number().nonnegative().optional(),
        "4k": z.number().nonnegative().optional(),
        default: z.number().nonnegative(),
      }),
    }),
    z.object({
      mode: z.enum(["per_second", "per_request"]),
      perSecond: z.number().nonnegative().optional(),
      perRequest: z.number().nonnegative().optional(),
      chargeReferenceVideo: z.boolean().optional(),
      referenceVideoMode: z.enum(["per_second", "per_request"]).optional(),
      referenceVideoPrice: z.number().nonnegative().optional(),
    }),
  ])
  .optional();

const channelModelSchema = z.object({
  name: z.string().trim().min(1),
  capability: z.enum(["image", "video", "text", "audio"]),
  script: z.string().optional(),
  pricing: modelPricingSchema,
});

const channelItemSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  alias: z.string().trim().optional().default(""),
  baseUrl: z.string().trim(),
  apiKey: z.string().optional().default(""),
  apiFormat: z.enum(["openai", "gemini"]).default("openai"),
  enabled: z.boolean().default(true),
  models: z.array(channelModelSchema).default([]),
});

const saveChannelsSchema = z.object({
  channels: z.array(channelItemSchema),
});

const fetchChannelModelsSchema = z.object({
  id: z.string().optional(),
  baseUrl: z.string().trim().min(1, "请先填写 Base URL"),
  apiKey: z.string().optional().default(""),
  apiFormat: z.enum(["openai", "gemini"]).default("openai"),
});

export const adminChannelsRoutes = new Hono<AppEnv>();

adminChannelsRoutes.get("/settings/channels", async (c) => {
  const channels = await getPlatformChannels();
  return c.json({
    channels: channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      alias: channel.alias || "",
      baseUrl: channel.baseUrl,
      apiFormat: channel.apiFormat,
      enabled: channel.enabled,
      models: channel.models,
      hasApiKey: Boolean(channel.apiKey),
      apiKeyPreview: maskSecret(channel.apiKey),
    })),
  });
});

adminChannelsRoutes.put("/settings/channels", zValidator("json", saveChannelsSchema), async (c) => {
  const body = c.req.valid("json");
  const existing = await getPlatformChannels();
  const existingKeyMap = new Map(existing.map((ch) => [ch.id, ch.apiKey]));

  const nextChannels: PlatformChannel[] = body.channels.map((ch) => ({
    id: ch.id,
    name: ch.name,
    ...(ch.alias.trim() ? { alias: ch.alias.trim() } : {}),
    baseUrl: ch.baseUrl.replace(/\/+$/, ""),
    apiKey: ch.apiKey.trim() || existingKeyMap.get(ch.id) || "",
    apiFormat: ch.apiFormat,
    enabled: ch.enabled,
    models: ch.models,
  }));

  await savePlatformChannels(nextChannels, c.get("user").id);
  return c.json({ ok: true });
});

adminChannelsRoutes.post("/settings/channels/fetch-models", zValidator("json", fetchChannelModelsSchema), async (c) => {
  const body = c.req.valid("json");
  const existing = await getPlatformChannels();
  const savedKey = body.id ? existing.find((ch) => ch.id === body.id)?.apiKey || "" : "";
  const apiKey = body.apiKey.trim() || savedKey;
  if (!apiKey) {
    return c.json({ error: "请先填写 API Key" }, 400);
  }

  const base = body.baseUrl.replace(/\/+$/, "");
  const lower = base.toLowerCase();
  let url = "";
  const headers: Record<string, string> = {};

  if (body.apiFormat === "gemini") {
    const apiBase = lower.endsWith("/v1") || lower.endsWith("/v1beta") ? base : `${base}/v1beta`;
    url = `${apiBase}/models`;
    headers["x-goog-api-key"] = apiKey;
  } else {
    const apiBase = lower.endsWith("/v1") ? base : `${base}/v1`;
    url = `${apiBase}/models`;
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return c.json({ error: `拉取模型失败（HTTP ${res.status}）${text ? `: ${text.slice(0, 120)}` : ""}` }, 400);
  }

  const payload = (await res.json()) as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> };
  const models =
    body.apiFormat === "gemini"
      ? (payload.models || []).map((item) => (item.name || "").replace(/^models\//, "").trim()).filter(Boolean)
      : (payload.data || []).map((item) => (item.id || "").trim()).filter(Boolean);

  return c.json({ models: Array.from(new Set(models)) });
});

