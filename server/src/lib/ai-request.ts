/** Validates what the managed AI gateway sends and what it uses for billing together. */
import { parseBuffer, TrackType } from "music-metadata";

import { hasNonZeroPricing, inferResolutionTier, roundCredits } from "./billing.ts";
import type { AudioModelPricing, ImageModelPricing, PlatformApiFormat, PlatformChannelModel, PlatformModelCapability, TextModelPricing, VideoModelPricing } from "./settings.ts";

const openAiEndpoints = {
  "chat/completions": "text",
  responses: "text",
  "images/generations": "image",
  "images/edits": "image",
  "audio/speech": "audio",
  videos: "video",
} as const;
type OpenAiEndpoint = keyof typeof openAiEndpoints;
type GeminiEndpoint = "generateContent" | "streamGenerateContent" | "predictLongRunning";
export type AiGenerationRoute = {
  kind: "generate";
  endpoint: OpenAiEndpoint | GeminiEndpoint;
  capability?: PlatformModelCapability;
  modelName?: string;
};
export type AiProxyRoute = AiGenerationRoute | { kind: "models" } | { kind: "task"; taskId: string; content: boolean };

export class AiRequestError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 415 = 400) {
    super(message);
  }
}

export function parseAiProxyRoute(apiFormat: PlatformApiFormat, method: string, subPath: string): AiProxyRoute | null {
  if (subPath.includes("..")) return null;
  if (apiFormat === "openai") {
    if (method === "POST" && subPath.startsWith("/v1/")) {
      const endpoint = subPath.slice(4) as OpenAiEndpoint;
      if (Object.hasOwn(openAiEndpoints, endpoint)) return { kind: "generate", endpoint, capability: openAiEndpoints[endpoint] };
    }
    if (method === "GET" && subPath === "/v1/models") return { kind: "models" };
    const task = method === "GET" && subPath.match(/^\/v1\/videos\/([\w.-]+)(\/content)?$/);
    return task ? { kind: "task", taskId: task[1], content: Boolean(task[2]) } : null;
  }

  if (method === "POST") {
    const match = subPath.match(/^\/v1beta\/models\/([\w.-]+):(generateContent|streamGenerateContent|predictLongRunning)$/);
    if (match) {
      const endpoint = match[2] as GeminiEndpoint;
      return {
        kind: "generate",
        endpoint,
        modelName: match[1],
        capability: endpoint === "predictLongRunning" ? "video" : endpoint === "streamGenerateContent" ? "text" : undefined,
      };
    }
  }
  if (method === "GET" && subPath === "/v1beta/models") return { kind: "models" };
  const task = method === "GET" && subPath.match(/^\/v1beta\/((?:models\/[\w.-]+\/)?operations\/[\w.-]+)(\/content)?$/);
  return task ? { kind: "task", taskId: task[1], content: Boolean(task[2]) } : null;
}

const imageFields = ["model", "prompt", "n", "size", "quality", "background", "response_format", "output_format", "output_compression", "moderation"];
const videoFields = ["model", "prompt", "seconds", "size", "ratio", "resolution_name", "generate_audio", "watermark", "mode",
  "input_reference", "first_frame", "last_frame", "image[]", "images", "video[]", "video", "audio[]"];
const openAiFields: Record<OpenAiEndpoint, string[]> = {
  "chat/completions": ["model", "messages", "stream", "stream_options", "tools", "tool_choice", "parallel_tool_calls", "temperature", "top_p",
    "max_tokens", "max_completion_tokens", "n", "reasoning_effort", "response_format", "stop", "seed", "presence_penalty", "frequency_penalty", "logprobs", "top_logprobs"],
  responses: ["model", "input", "instructions", "stream", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "text", "max_output_tokens", "temperature", "top_p", "truncation"],
  "images/generations": imageFields,
  "images/edits": [...imageFields, "image", "image[]", "images", "mask", "input_fidelity"],
  "audio/speech": ["model", "input", "voice", "response_format", "speed", "instructions"],
  videos: videoFields,
};
const geminiContentFields = ["contents", "systemInstruction", "safetySettings", "tools", "toolConfig", "generationConfig"];
const geminiGenerationFields = ["candidateCount", "stopSequences", "maxOutputTokens", "temperature", "topP", "topK",
  "responseMimeType", "responseSchema", "responseJsonSchema", "presencePenalty", "frequencyPenalty", "seed", "responseLogprobs",
  "logprobs", "responseModalities", "imageConfig", "speechConfig", "thinkingConfig", "mediaResolution"];
const geminiVideoFields = ["aspectRatio", "durationSeconds", "resolution", "generateAudio", "addWatermark", "sampleCount", "negativePrompt", "personGeneration", "seed"];
const repeatedFormFields = new Set(["image[]", "images", "video[]", "audio[]"]);
const fileFormFields = new Set([...repeatedFormFields, "image", "mask", "input_reference", "first_frame", "last_frame", "video"]);

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown, name: string): JsonObject {
  if (!isRecord(value)) throw new AiRequestError(`${name} 必须是对象`);
  return value;
}

function allowFields(fields: string[], allowed: string[]) {
  if (fields.some((field) => !allowed.includes(field))) throw new AiRequestError("托管渠道不支持此请求参数");
}

function positiveNumber(value: unknown, name: string, integer = false) {
  const number = typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number <= 0 || (integer && !Number.isSafeInteger(number))) {
    throw new AiRequestError(`${name} 必须是有效的正数`);
  }
  return number;
}

function assertFiniteCharge(amount: number) {
  // The wallet stores four decimal places; reject values that overflow before rounding.
  if (!Number.isFinite(amount) || amount < 0 || !Number.isFinite(amount * 10_000)) throw new AiRequestError("计费参数超出可计算范围");
}

function validatePricing(channelModel: PlatformChannelModel, count: number, tier?: string, size = "", seconds = 0, refSeconds = 0) {
  const pricing = channelModel.pricing;
  if (!pricing) return;
  const expected = {
    text: ["token"],
    image: ["per_image", "per_resolution"],
    video: ["per_second", "per_request"],
    audio: ["per_second"],
  }[channelModel.capability];
  if (!expected.includes(pricing.mode)) throw new AiRequestError("此模型的计费配置与模型类型不匹配", 403);
  if (channelModel.capability === "image") {
    const image = pricing as ImageModelPricing;
    const resolution = inferResolutionTier(tier, size);
    const unit = image.mode === "per_image"
      ? image.perImage ?? 0
      : (resolution ? image.resolutionPrices?.[resolution] : undefined) ?? image.resolutionPrices?.default ?? 0;
    assertFiniteCharge(unit * count);
  } else if (channelModel.capability === "video") {
    const video = pricing as VideoModelPricing;
    const base = video.mode === "per_second" ? (video.perSecond ?? 0) * seconds : video.perRequest ?? 0;
    const extra = video.chargeReferenceVideo
      ? video.referenceVideoMode === "per_second" ? (video.referenceVideoPrice ?? 0) * refSeconds : video.referenceVideoPrice ?? 0
      : 0;
    assertFiniteCharge(base + extra);
  } else if (channelModel.capability === "text") {
    const text = pricing as TextModelPricing;
    assertFiniteCharge(text.inputPerMillion);
    assertFiniteCharge(text.cachedInputPerMillion);
    assertFiniteCharge(text.outputPerMillion);
  } else if (channelModel.capability === "audio") {
    assertFiniteCharge((pricing as AudioModelPricing).perSecond);
  }
}

function validateTools(value: unknown, isGemini: boolean) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((tool) => {
    if (!isRecord(tool)) return true;
    if (!isGemini) return tool.type !== "function";
    return Object.keys(tool).length !== 1 || !Array.isArray(tool.functionDeclarations ?? tool.function_declarations);
  })) throw new AiRequestError("托管渠道仅支持客户端函数工具");
}

function rejectStoredOpenAiData(value: unknown) {
  const queue = [value];
  while (queue.length) {
    const item = queue.pop();
    if (Array.isArray(item)) {
      for (const entry of item) queue.push(entry);
    } else if (isRecord(item)) {
      if (Object.hasOwn(item, "file_id") || item.type === "item_reference") {
        throw new AiRequestError("托管渠道不支持引用上游存储的文件或对话");
      }
      for (const entry of Object.values(item)) queue.push(entry);
    }
  }
}

function readOpenAiImageSize(value: unknown) {
  if (value === undefined || value === "auto" || value === "") return "";
  if (typeof value !== "string" || !/^\d+x\d+$/.test(value)) throw new AiRequestError("图片尺寸不合法");
  const [width, height] = value.split("x").map(Number);
  if (!Number.isSafeInteger(width * height) || width <= 0 || height <= 0) throw new AiRequestError("图片尺寸不合法");
  return value;
}

async function referenceDuration(source: File | JsonObject) {
  try {
    const bytes = source instanceof File
      ? new Uint8Array(await source.arrayBuffer())
      : typeof source.bytesBase64Encoded === "string" ? Buffer.from(source.bytesBase64Encoded, "base64") : null;
    if (bytes?.length) {
      const { format } = await parseBuffer(bytes, undefined, { duration: true, skipCovers: true });
      const tracks = format.trackInfo.filter((track) => track.type === TrackType.video);
      const seconds = Math.max(format.containerDuration ?? 0, ...tracks.map((track) => track.duration ?? 0));
      if (tracks.length && Number.isFinite(seconds) && seconds > 0) return seconds;
    }
  } catch {
    // Invalid or unsupported media must not make a paid reference free.
  }
  throw new AiRequestError("无法确认参考视频时长，请上传可解析的视频文件");
}

export async function readAiGenerationRequest(request: Request, route: AiGenerationRoute, channelModels: PlatformChannelModel[]) {
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  let form: FormData | undefined;
  let json: JsonObject = {};
  if (type === "application/json") {
    json = object(await request.json().catch(() => null), "请求正文");
  } else if (type === "multipart/form-data" && (route.endpoint === "images/edits" || route.endpoint === "videos")) {
    form = await request.formData().catch(() => undefined);
    if (!form) throw new AiRequestError("上传表单无法解析");
    const keys = [...new Set(form.keys())];
    allowFields(keys, openAiFields[route.endpoint]);
    for (const key of keys) {
      const values = form.getAll(key);
      if ((!repeatedFormFields.has(key) && values.length > 1) || values.some((value) => fileFormFields.has(key) === (typeof value === "string"))) {
        throw new AiRequestError("上传表单包含重复或无效的字段");
      }
    }
    if (form.has("video") && form.has("video[]")) throw new AiRequestError("上传表单重复指定了参考视频");
    if (route.endpoint === "images/edits" && ["image", "image[]", "images"].filter((key) => form!.has(key)).length > 1) {
      throw new AiRequestError("上传表单重复指定了参考图片");
    }
  } else {
    throw new AiRequestError("不支持此请求内容类型", 415);
  }

  const read = (name: string) => form ? form.get(name) ?? undefined : json[name];
  const model = route.modelName ?? read("model");
  const channelModel = channelModels.find((item) => item.name === model);
  if (!channelModel || (route.capability && channelModel.capability !== route.capability) ||
    (route.endpoint === "generateContent" && channelModel.capability === "video")) {
    throw new AiRequestError("所选模型未在此渠道配置，或不支持该操作", 403);
  }
  const modelName = channelModel.name;

  let promptText = typeof read("prompt") === "string" ? String(read("prompt")) : "";
  let requestedImageCount = 1;
  let resolutionTier: string | undefined;
  let sizeStr = "";
  let seconds = 0;
  let references: Array<File | JsonObject> = [];
  let streaming = false;
  let audioResponseFormat: string | undefined;

  if (route.endpoint === "predictLongRunning") {
    allowFields(Object.keys(json), ["instances", "parameters"]);
    if (!Array.isArray(json.instances) || json.instances.length !== 1) throw new AiRequestError("每次视频请求只能创建一个任务");
    const instance = object(json.instances[0], "视频输入");
    allowFields(Object.keys(instance), ["prompt", "image", "lastFrame", "referenceImages", "video", "audio"]);
    const parameters = json.parameters === undefined ? {} : object(json.parameters, "视频参数");
    allowFields(Object.keys(parameters), geminiVideoFields);
    if (parameters.sampleCount !== undefined && parameters.sampleCount !== 1) throw new AiRequestError("每次视频请求只能生成一个视频");
    if (instance.video !== undefined) {
      const reference = object(instance.video, "参考视频");
      allowFields(Object.keys(reference), ["bytesBase64Encoded", "mimeType"]);
      references = [reference];
    }
    if (typeof instance.prompt === "string") promptText = instance.prompt;
    const value = parameters.durationSeconds;
    seconds = value === undefined ? 8 : positiveNumber(value, "视频时长", true);
    // Send the same duration that was priced even when the client omitted it.
    json.parameters = { ...parameters, durationSeconds: seconds };
  } else if (route.endpoint === "generateContent" || route.endpoint === "streamGenerateContent") {
    allowFields(Object.keys(json), geminiContentFields);
    validateTools(json.tools, true);
    const settings = json.generationConfig === undefined ? {} : object(json.generationConfig, "生成配置");
    allowFields(Object.keys(settings), geminiGenerationFields);
    const allowedModalities = channelModel.capability === "audio" ? ["AUDIO"] : channelModel.capability === "image" ? ["TEXT", "IMAGE"] : ["TEXT"];
    const modalities = settings.responseModalities;
    if ((modalities !== undefined && (!Array.isArray(modalities) || modalities.some((value) => !allowedModalities.includes(value)))) ||
      (channelModel.capability === "audio" && (!Array.isArray(modalities) || !modalities.includes("AUDIO")))) {
      throw new AiRequestError("输出类型与模型不匹配");
    }
    if ((settings.imageConfig !== undefined && channelModel.capability !== "image") ||
      (settings.speechConfig !== undefined && channelModel.capability !== "audio")) throw new AiRequestError("输出设置与模型不匹配");
    streaming = route.endpoint === "streamGenerateContent";
    const first = Array.isArray(json.contents) ? json.contents[0] : json.contents;
    if (isRecord(first) && Array.isArray(first.parts)) {
      promptText = first.parts.flatMap((part) => isRecord(part) && typeof part.text === "string" ? [part.text] : []).join("\n");
    }
    if (channelModel.capability === "image") {
      if (settings.candidateCount !== undefined) requestedImageCount = positiveNumber(settings.candidateCount, "候选图片数量", true);
      const image = settings.imageConfig === undefined ? {} : object(settings.imageConfig, "图片配置");
      allowFields(Object.keys(image), ["aspectRatio", "imageSize"]);
      if (image.imageSize !== undefined) {
        if (typeof image.imageSize !== "string" || !/^(512|1K|2K|4K)$/i.test(image.imageSize)) throw new AiRequestError("不支持此图片分辨率");
        resolutionTier = image.imageSize;
      }
    }
  } else {
    if (!form) allowFields(Object.keys(json), openAiFields[route.endpoint]);
    if (route.endpoint === "responses" || route.endpoint === "chat/completions") {
      validateTools(json.tools, false);
      rejectStoredOpenAiData(json.input ?? json.messages);
      if (json.stream !== undefined && typeof json.stream !== "boolean") throw new AiRequestError("流式设置无效");
      streaming = json.stream === true;
      if (route.endpoint === "responses") json.store = false;
      if (route.endpoint === "chat/completions") {
        if (streaming) json.stream_options = { include_usage: true };
        else delete json.stream_options;
      }
    } else if (route.endpoint === "videos") {
      if (!form && videoFields.some((field) => fileFormFields.has(field) && Object.hasOwn(json, field))) {
        throw new AiRequestError("视频参考素材需通过上传表单提交");
      }
      const value = read("seconds");
      seconds = value === undefined ? 8 : positiveNumber(value, "视频时长", true);
      if (form) {
        references = [...form.getAll("video[]"), ...form.getAll("video")].filter((file): file is File => file instanceof File);
        form.set("seconds", String(seconds));
      } else {
        json.seconds = typeof value === "number" ? seconds : String(seconds);
      }
    } else if (route.endpoint === "audio/speech") {
      if (typeof json.response_format === "string") audioResponseFormat = json.response_format;
    } else {
      if (read("n") !== undefined) requestedImageCount = positiveNumber(read("n"), "图片数量", true);
      sizeStr = readOpenAiImageSize(read("size"));
    }
  }

  const pricing = channelModel.pricing as VideoModelPricing | undefined;
  let referenceVideoSeconds: number | undefined;
  if (references.length && pricing?.chargeReferenceVideo && pricing.referenceVideoMode === "per_second" && (pricing.referenceVideoPrice ?? 0) > 0) {
    referenceVideoSeconds = 0;
    for (const reference of references) referenceVideoSeconds += await referenceDuration(reference);
    if (!Number.isFinite(referenceVideoSeconds)) throw new AiRequestError("参考视频时长无效");
    referenceVideoSeconds = Math.ceil(referenceVideoSeconds);
  }
  validatePricing(channelModel, requestedImageCount, resolutionTier, sizeStr, seconds, referenceVideoSeconds ?? 0);

  let estimatedInputTokens = 0;
  let estimatedReserveCredits = 0;
  if (channelModel.capability === "text") {
    const inputPayload = json.input ?? json.messages ?? json.contents ?? "";
    estimatedInputTokens = Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(inputPayload)) / 4));
  }
  if (channelModel.pricing && hasNonZeroPricing(channelModel.pricing)) {
    if (channelModel.capability === "text") {
      const textPricing = channelModel.pricing as TextModelPricing;
      const rawMaxOutput = json.max_completion_tokens ?? json.max_tokens ?? json.max_output_tokens ??
        (isRecord(json.generationConfig) ? json.generationConfig.maxOutputTokens : undefined);
      const estOutput = typeof rawMaxOutput === "number" && Number.isFinite(rawMaxOutput) && rawMaxOutput > 0
        ? Math.min(65536, Math.ceil(rawMaxOutput))
        : 4096;
      const est = roundCredits((estimatedInputTokens * textPricing.inputPerMillion + estOutput * textPricing.outputPerMillion) / 1_000_000);
      estimatedReserveCredits = Math.max(0.0001, est);
    } else if (channelModel.capability === "audio") {
      const audioPricing = channelModel.pricing as AudioModelPricing;
      const textLen = typeof json.input === "string" ? json.input.length : promptText.length;
      const estSeconds = Math.min(600, Math.max(10, Math.ceil(textLen / 4)));
      estimatedReserveCredits = Math.max(0.0001, roundCredits(audioPricing.perSecond * estSeconds));
    }
  }

  return {
    modelName, channelModel, rawBody: form ?? JSON.stringify(json), contentType: form ? "" : "application/json", promptText,
    requestedImageCount, resolutionTier, sizeStr, seconds, hasReferenceVideo: Boolean(references.length), referenceVideoSeconds,
    streaming, audioResponseFormat, estimatedInputTokens, estimatedReserveCredits,
  };
}
