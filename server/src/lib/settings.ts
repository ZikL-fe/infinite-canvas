/** 平台级系统设置读写与加密持久化：认证策略、S3 对象存储、AI 渠道与 WebDAV 配置。 */
import { eq } from "drizzle-orm";

import { db, systemSettings, type UserWebdavConfig } from "../db/index.ts";
import { env } from "../env.ts";
import { decryptJson, decryptSecretValue, encryptJson } from "./crypto.ts";

export const AUTH_POLICY_KEY = "auth.policy";
export const STORAGE_S3_KEY = "storage.s3";
export const AI_CHANNELS_KEY = "ai.channels";
export const WEBDAV_CONFIG_KEY = "sync.webdav";
export const MAIL_CONFIG_KEY = "mail.smtp";
export const STORAGE_EXPIRY_POLICY_KEY = "storage.expiry";
export const PLATFORM_NOTICE_KEY = "announcement.notice";
export const ANALYTICS_POLICY_KEY = "analytics.policy";
export const INVITE_POLICY_KEY = "invite.policy";

const settingsCache = new Map<string, { value: unknown; expiresAt: number }>();
const settingsInFlight = new Map<string, Promise<unknown>>();

async function getCachedSetting<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const ttlMs = env.SETTINGS_CACHE_TTL_MS;
  if (ttlMs <= 0) return loader();
  const now = Date.now();
  const hit = settingsCache.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value as T;
  }
  const existing = settingsInFlight.get(key);
  if (existing) {
    return existing as Promise<T>;
  }
  const promise = loader()
    .then((value) => {
      settingsCache.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    })
    .finally(() => {
      settingsInFlight.delete(key);
    });
  settingsInFlight.set(key, promise);
  return promise;
}

function invalidateSettingCache(key: string) {
  settingsCache.delete(key);
  settingsInFlight.delete(key);
}

export type PlatformModelCapability = "image" | "video" | "text" | "audio";
export type PlatformApiFormat = "openai" | "gemini";

export type TextModelPricing = {
  mode: "token";
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
};

export type ImageModelPricing = {
  mode: "per_image" | "per_resolution";
  perImage?: number;
  resolutionPrices?: {
    "1k"?: number;
    "2k"?: number;
    "4k"?: number;
    default: number;
  };
};

export type VideoModelPricing = {
  mode: "per_second" | "per_request";
  perSecond?: number;
  perRequest?: number;
  chargeReferenceVideo?: boolean;
  referenceVideoMode?: "per_second" | "per_request";
  referenceVideoPrice?: number;
};

export type AudioModelPricing = {
  mode: "per_second";
  perSecond: number;
};

export type ModelPricing = TextModelPricing | ImageModelPricing | VideoModelPricing | AudioModelPricing;

export type PlatformChannelModel = {
  name: string;
  capability: PlatformModelCapability;
  script?: string;
  pricing?: ModelPricing;
};

export type PlatformChannel = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiFormat: PlatformApiFormat;
  enabled: boolean;
  models: PlatformChannelModel[];
};

export type PlatformWebdavConfig = {
  enabled: boolean;
  url: string;
  username: string;
  password: string;
  baseDirectory: string;
  autoAssignNewUsers: boolean;
};

export type AuthRateLimitPolicy = {
  enabled: boolean;
  loginPerMinute: number;
  registerPerMinute: number;
  emailCodePerMinute: number;
  redeemPerMinute: number;
};

export type AuthPolicy = {
  allowRegister: boolean;
  requireEmailOnRegister: boolean;
  rateLimit: AuthRateLimitPolicy;
};

export const DEFAULT_AUTH_RATE_LIMIT: AuthRateLimitPolicy = {
  enabled: true,
  loginPerMinute: 20,
  registerPerMinute: 10,
  emailCodePerMinute: 5,
  redeemPerMinute: 10,
};

function clampRateLimit(value: unknown, fallback: number) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1000, Math.floor(num)));
}

function normalizeAuthRateLimit(raw?: Partial<AuthRateLimitPolicy>): AuthRateLimitPolicy {
  return {
    enabled: raw?.enabled ?? DEFAULT_AUTH_RATE_LIMIT.enabled,
    loginPerMinute: clampRateLimit(raw?.loginPerMinute, DEFAULT_AUTH_RATE_LIMIT.loginPerMinute),
    registerPerMinute: clampRateLimit(raw?.registerPerMinute, DEFAULT_AUTH_RATE_LIMIT.registerPerMinute),
    emailCodePerMinute: clampRateLimit(raw?.emailCodePerMinute, DEFAULT_AUTH_RATE_LIMIT.emailCodePerMinute),
    redeemPerMinute: clampRateLimit(raw?.redeemPerMinute, DEFAULT_AUTH_RATE_LIMIT.redeemPerMinute),
  };
}

export type PlatformMailConfig = {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromName: string;
  fromAddress: string;
  lowBalanceAlertEnabled: boolean;
  lowBalanceThreshold: number;
  lowBalanceCooldownHours: number;
};

export type PlatformStorageExpiryPolicy = {
  enabled: boolean;
  gracePeriodDays: number;
  preExpiryWarnDays: number;
  cleanupWorkspaceData: boolean;
  exemptAdmins: boolean;
  cleanupOverQuotaWithoutExpiry: boolean;
};

export type PlatformGlobalNotice = {
  enabled: boolean;
  title: string;
  content: string;
  updatedAt: string | null;
};

export type PlatformAnalyticsPolicy = {
  sampleIntervalMinutes: number;
  logRetentionDays: number;
};

export type PlatformInvitePolicy = {
  enabled: boolean;
  rebatePercent: number;
  includeAdminAdjust: boolean;
};

export type S3Provider = "s3" | "r2" | "oss" | "cos";

export type S3StorageConfig = {
  provider: S3Provider;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
  forcePathStyle: boolean;
};

type S3PublicSettings = Omit<S3StorageConfig, "secretAccessKey">;

/** 读取平台注册、邮箱验证与敏感接口限流策略配置。 */
export async function getAuthPolicy(): Promise<AuthPolicy> {
  return getCachedSetting(AUTH_POLICY_KEY, async () => {
    const row = await db.query.systemSettings.findFirst({ where: eq(systemSettings.key, AUTH_POLICY_KEY) });
    const raw = row?.value as Partial<AuthPolicy> | undefined;
    return {
      allowRegister: raw?.allowRegister ?? true,
      requireEmailOnRegister: Boolean(raw?.requireEmailOnRegister),
      rateLimit: normalizeAuthRateLimit(raw?.rateLimit),
    };
  });
}

/** 保存平台注册与限流策略配置并刷新本地设置缓存。 */
export async function saveAuthPolicy(
  policy: { allowRegister: boolean; requireEmailOnRegister: boolean; rateLimit?: Partial<AuthRateLimitPolicy> },
  updatedBy: string,
) {
  const prev = await getAuthPolicy();
  const normalized: AuthPolicy = {
    allowRegister: Boolean(policy.allowRegister),
    requireEmailOnRegister: Boolean(policy.requireEmailOnRegister),
    rateLimit: normalizeAuthRateLimit(policy.rateLimit ? { ...prev.rateLimit, ...policy.rateLimit } : prev.rateLimit),
  };
  await db
    .insert(systemSettings)
    .values({ key: AUTH_POLICY_KEY, value: normalized, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: normalized, updatedBy, updatedAt: new Date() },
    });
  invalidateSettingCache(AUTH_POLICY_KEY);
  return normalized;
}

/** 读取平台 SMTP 邮件与低余额提醒默认配置（含解密密码）。 */
export async function getPlatformMailConfig(): Promise<PlatformMailConfig> {
  return getCachedSetting(MAIL_CONFIG_KEY, async () => {
    const row = await db.query.systemSettings.findFirst({ where: eq(systemSettings.key, MAIL_CONFIG_KEY) });
    const raw = (row?.value || {}) as Partial<Omit<PlatformMailConfig, "password">>;
    const password = row?.encryptedSecret ? decryptJson<{ password?: string }>(row.encryptedSecret).password || "" : "";
    const port = Number(raw.port);
    const threshold = Number(raw.lowBalanceThreshold);
    const cooldownHours = Number(raw.lowBalanceCooldownHours);
    return {
      enabled: Boolean(raw.enabled),
      host: raw.host || "",
      port: Number.isFinite(port) && port > 0 ? Math.floor(port) : 465,
      secure: raw.secure ?? true,
      username: raw.username || "",
      password,
      fromName: raw.fromName || "ZIKL画布",
      fromAddress: raw.fromAddress || "",
      lowBalanceAlertEnabled: raw.lowBalanceAlertEnabled ?? true,
      lowBalanceThreshold: Number.isFinite(threshold) && threshold >= 0 ? threshold : 10,
      lowBalanceCooldownHours: Number.isFinite(cooldownHours) && cooldownHours >= 1 ? Math.floor(cooldownHours) : 24,
    };
  });
}

/** 保存平台 SMTP 邮件配置（密码经 AES-256-GCM 加密入库）并失效缓存。 */
export async function savePlatformMailConfig(config: PlatformMailConfig, updatedBy: string) {
  const publicValue = {
    enabled: config.enabled,
    host: config.host.trim(),
    port: Math.max(1, Math.min(65535, Math.floor(config.port || 465))),
    secure: config.secure,
    username: config.username.trim(),
    fromName: config.fromName.trim() || "ZIKL画布",
    fromAddress: config.fromAddress.trim(),
    lowBalanceAlertEnabled: config.lowBalanceAlertEnabled,
    lowBalanceThreshold: Math.max(0, Number(config.lowBalanceThreshold ?? 10)),
    lowBalanceCooldownHours: Math.max(1, Math.floor(config.lowBalanceCooldownHours || 24)),
  };
  const encryptedSecret = encryptJson({ password: config.password });

  await db
    .insert(systemSettings)
    .values({
      key: MAIL_CONFIG_KEY,
      value: publicValue,
      encryptedSecret,
      updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: {
        value: publicValue,
        encryptedSecret,
        updatedBy,
        updatedAt: new Date(),
      },
    });
  invalidateSettingCache(MAIL_CONFIG_KEY);
}

/** 读取对象存储（S3/R2/OSS/COS）配置（优先数据库加密配置，其次回退环境变量）。 */
export async function getS3StorageConfig(): Promise<S3StorageConfig | null> {
  return getCachedSetting(STORAGE_S3_KEY, async () => {
    const row = await db.query.systemSettings.findFirst({ where: eq(systemSettings.key, STORAGE_S3_KEY) });
    if (row) {
      const value = row.value as Partial<S3PublicSettings>;
      let secretAccessKey = "";
      if (row.encryptedSecret) {
        const secretPayload = decryptJson<{ secretAccessKey?: string }>(row.encryptedSecret);
        secretAccessKey = secretPayload.secretAccessKey || "";
      }
      if (value.bucket && value.accessKeyId && secretAccessKey) {
        return {
          provider: (value.provider as S3Provider) || "s3",
          endpoint: value.endpoint || "",
          region: value.region || "auto",
          bucket: value.bucket,
          accessKeyId: value.accessKeyId,
          secretAccessKey,
          publicBaseUrl: value.publicBaseUrl || "",
          forcePathStyle: Boolean(value.forcePathStyle),
        };
      }
    }

    if (env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY) {
      return {
        provider: env.S3_PROVIDER,
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION || "auto",
        bucket: env.S3_BUCKET,
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        publicBaseUrl: env.S3_PUBLIC_BASE_URL,
        forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
      };
    }

    return null;
  });
}

/** 保存平台对象存储配置（密钥经 AES-256-GCM 加密）并失效缓存。 */
export async function saveS3StorageConfig(config: S3StorageConfig, updatedBy: string) {
  const publicValue: S3PublicSettings = {
    provider: config.provider,
    endpoint: config.endpoint.trim(),
    region: config.region.trim() || "auto",
    bucket: config.bucket.trim(),
    accessKeyId: config.accessKeyId.trim(),
    publicBaseUrl: config.publicBaseUrl.trim().replace(/\/+$/, ""),
    forcePathStyle: config.forcePathStyle,
  };
  const encryptedSecret = encryptJson({ secretAccessKey: config.secretAccessKey });

  await db
    .insert(systemSettings)
    .values({
      key: STORAGE_S3_KEY,
      value: publicValue,
      encryptedSecret,
      updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: {
        value: publicValue,
        encryptedSecret,
        updatedBy,
        updatedAt: new Date(),
      },
    });
  invalidateSettingCache(STORAGE_S3_KEY);
}

/** 读取平台启用的 AI 模型渠道与加密密钥配置。 */
export async function getPlatformChannels(): Promise<PlatformChannel[]> {
  return getCachedSetting(AI_CHANNELS_KEY, async () => {
    const row = await db.query.systemSettings.findFirst({ where: eq(systemSettings.key, AI_CHANNELS_KEY) });
    if (!row) return [];
    const raw = row.value as { channels?: Array<Omit<PlatformChannel, "apiKey">> };
    const keys = row.encryptedSecret ? decryptJson<{ keys?: Record<string, string> }>(row.encryptedSecret).keys || {} : {};
    return (raw.channels || []).map((channel) => ({
      id: channel.id,
      name: channel.name,
      baseUrl: channel.baseUrl || "",
      apiFormat: channel.apiFormat === "gemini" ? "gemini" : "openai",
      enabled: channel.enabled ?? true,
      models: Array.isArray(channel.models) ? channel.models : [],
      apiKey: keys[channel.id] || "",
    }));
  });
}

/** 保存平台 AI 模型渠道列表（各渠道 API Key 加密后存储）并失效缓存。 */
export async function savePlatformChannels(channels: PlatformChannel[], updatedBy: string) {
  const publicChannels = channels.map(({ apiKey: _key, ...rest }) => rest);
  const keys = Object.fromEntries(channels.map((channel) => [channel.id, channel.apiKey]));
  const encryptedSecret = encryptJson({ keys });

  await db
    .insert(systemSettings)
    .values({
      key: AI_CHANNELS_KEY,
      value: { channels: publicChannels },
      encryptedSecret,
      updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: {
        value: { channels: publicChannels },
        encryptedSecret,
        updatedBy,
        updatedAt: new Date(),
      },
    });
  invalidateSettingCache(AI_CHANNELS_KEY);
}

/** 读取平台默认 WebDAV 归档配置（含解密密码）。 */
export async function getPlatformWebdavConfig(): Promise<PlatformWebdavConfig> {
  return getCachedSetting(WEBDAV_CONFIG_KEY, async () => {
    const row = await db.query.systemSettings.findFirst({ where: eq(systemSettings.key, WEBDAV_CONFIG_KEY) });
    const raw = (row?.value || {}) as Partial<Omit<PlatformWebdavConfig, "password">>;
    const password = row?.encryptedSecret ? decryptJson<{ password?: string }>(row.encryptedSecret).password || "" : "";
    return {
      enabled: Boolean(raw.enabled),
      url: raw.url || "",
      username: raw.username || "",
      password,
      baseDirectory: raw.baseDirectory || "infinite-canvas",
      autoAssignNewUsers: Boolean(raw.autoAssignNewUsers),
    };
  });
}

/** 保存平台默认 WebDAV 配置（密码加密存储）并失效缓存。 */
export async function savePlatformWebdavConfig(config: PlatformWebdavConfig, updatedBy: string) {
  const publicValue = {
    enabled: config.enabled,
    url: config.url.trim().replace(/\/+$/, ""),
    username: config.username.trim(),
    baseDirectory: config.baseDirectory.trim().replace(/^\/+|\/+$/g, "") || "infinite-canvas",
    autoAssignNewUsers: config.autoAssignNewUsers,
  };
  const encryptedSecret = encryptJson({ password: config.password });

  await db
    .insert(systemSettings)
    .values({
      key: WEBDAV_CONFIG_KEY,
      value: publicValue,
      encryptedSecret,
      updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: {
        value: publicValue,
        encryptedSecret,
        updatedBy,
        updatedAt: new Date(),
      },
    });
  invalidateSettingCache(WEBDAV_CONFIG_KEY);
}

/** 读取云端存储到期预警与宽限期清理策略配置。 */
export async function getPlatformStorageExpiryPolicy(): Promise<PlatformStorageExpiryPolicy> {
  return getCachedSetting(STORAGE_EXPIRY_POLICY_KEY, async () => {
    const row = await db.query.systemSettings.findFirst({ where: eq(systemSettings.key, STORAGE_EXPIRY_POLICY_KEY) });
    const raw = (row?.value || {}) as Partial<PlatformStorageExpiryPolicy>;
    const graceDays = Number(raw.gracePeriodDays);
    const preDays = Number(raw.preExpiryWarnDays);
    return {
      enabled: Boolean(raw.enabled),
      gracePeriodDays: Number.isFinite(graceDays) && graceDays >= 1 ? Math.min(365, Math.floor(graceDays)) : 7,
      preExpiryWarnDays: Number.isFinite(preDays) && preDays >= 0 ? Math.min(30, Math.floor(preDays)) : 3,
      cleanupWorkspaceData: raw.cleanupWorkspaceData ?? true,
      exemptAdmins: raw.exemptAdmins ?? true,
      cleanupOverQuotaWithoutExpiry: raw.cleanupOverQuotaWithoutExpiry ?? true,
    };
  });
}

/** 规范化并保存云端存储到期清理策略并失效缓存。 */
export async function savePlatformStorageExpiryPolicy(policy: PlatformStorageExpiryPolicy, updatedBy: string) {
  const normalized: PlatformStorageExpiryPolicy = {
    enabled: Boolean(policy.enabled),
    gracePeriodDays: Math.max(1, Math.min(365, Math.floor(policy.gracePeriodDays || 7))),
    preExpiryWarnDays: Math.max(0, Math.min(30, Math.floor(policy.preExpiryWarnDays ?? 3))),
    cleanupWorkspaceData: Boolean(policy.cleanupWorkspaceData),
    exemptAdmins: Boolean(policy.exemptAdmins),
    cleanupOverQuotaWithoutExpiry: Boolean(policy.cleanupOverQuotaWithoutExpiry),
  };
  await db
    .insert(systemSettings)
    .values({ key: STORAGE_EXPIRY_POLICY_KEY, value: normalized, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: normalized, updatedBy, updatedAt: new Date() },
    });
  invalidateSettingCache(STORAGE_EXPIRY_POLICY_KEY);
  return normalized;
}

/** 读取全站顶部全局滚动/横幅公告配置。 */
export async function getPlatformGlobalNotice(): Promise<PlatformGlobalNotice> {
  return getCachedSetting(PLATFORM_NOTICE_KEY, async () => {
    const row = await db.query.systemSettings.findFirst({ where: eq(systemSettings.key, PLATFORM_NOTICE_KEY) });
    const raw = (row?.value || {}) as Partial<PlatformGlobalNotice>;
    return {
      enabled: Boolean(raw.enabled),
      title: typeof raw.title === "string" ? raw.title : "",
      content: typeof raw.content === "string" ? raw.content : "",
      updatedAt: typeof raw.updatedAt === "string" && raw.updatedAt ? raw.updatedAt : null,
    };
  });
}

/** 保存全站全局公告配置，内容变更时自动刷新 `updatedAt` 以便前端重新展示未读。 */
export async function savePlatformGlobalNotice(
  input: { enabled: boolean; title?: string; content?: string },
  updatedBy: string,
): Promise<PlatformGlobalNotice> {
  const prev = await getPlatformGlobalNotice();
  const enabled = Boolean(input.enabled);
  const title = (input.title ?? "").trim();
  const content = (input.content ?? "").trim();
  const changed = enabled !== prev.enabled || title !== prev.title || content !== prev.content;
  const updatedAt = enabled && content ? (changed || !prev.updatedAt ? new Date().toISOString() : prev.updatedAt) : prev.updatedAt;
  const normalized: PlatformGlobalNotice = { enabled, title, content, updatedAt };
  await db
    .insert(systemSettings)
    .values({ key: PLATFORM_NOTICE_KEY, value: normalized, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: normalized, updatedBy, updatedAt: new Date() },
    });
  invalidateSettingCache(PLATFORM_NOTICE_KEY);
  return normalized;
}

/** 读取数据看板采样缓存周期与使用日志保留天数策略。 */
export async function getPlatformAnalyticsPolicy(): Promise<PlatformAnalyticsPolicy> {
  return getCachedSetting(ANALYTICS_POLICY_KEY, async () => {
    const row = await db.query.systemSettings.findFirst({ where: eq(systemSettings.key, ANALYTICS_POLICY_KEY) });
    const raw = (row?.value || {}) as Partial<PlatformAnalyticsPolicy>;
    const sample = Number(raw.sampleIntervalMinutes);
    const retention = Number(raw.logRetentionDays);
    return {
      sampleIntervalMinutes: Number.isFinite(sample) && sample >= 1 ? Math.min(1440, Math.floor(sample)) : 5,
      logRetentionDays: Number.isFinite(retention) && retention >= 0 ? Math.min(3650, Math.floor(retention)) : 0,
    };
  });
}

/** 保存数据看板采样与日志保留策略并失效缓存。 */
export async function savePlatformAnalyticsPolicy(policy: PlatformAnalyticsPolicy, updatedBy: string): Promise<PlatformAnalyticsPolicy> {
  const normalized: PlatformAnalyticsPolicy = {
    sampleIntervalMinutes: Math.max(1, Math.min(1440, Math.floor(Number(policy.sampleIntervalMinutes) || 5))),
    logRetentionDays: Math.max(0, Math.min(3650, Math.floor(Number(policy.logRetentionDays) || 0))),
  };
  await db
    .insert(systemSettings)
    .values({ key: ANALYTICS_POLICY_KEY, value: normalized, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: normalized, updatedBy, updatedAt: new Date() },
    });
  invalidateSettingCache(ANALYTICS_POLICY_KEY);
  return normalized;
}

/** 读取平台邀请返利策略（是否开启、返利百分比、管理员调账是否计入返利）。 */
export async function getPlatformInvitePolicy(): Promise<PlatformInvitePolicy> {
  return getCachedSetting(INVITE_POLICY_KEY, async () => {
    const row = await db.query.systemSettings.findFirst({ where: eq(systemSettings.key, INVITE_POLICY_KEY) });
    const raw = (row?.value || {}) as Partial<PlatformInvitePolicy>;
    const rawPercent = Number(raw.rebatePercent);
    const rebatePercent = Number.isFinite(rawPercent) ? Math.max(0, Math.min(100, Math.round(rawPercent * 100) / 100)) : 10;
    return {
      enabled: Boolean(raw.enabled),
      rebatePercent,
      includeAdminAdjust: Boolean(raw.includeAdminAdjust),
    };
  });
}

/** 保存平台邀请返利策略并失效缓存。 */
export async function savePlatformInvitePolicy(policy: PlatformInvitePolicy, updatedBy: string): Promise<PlatformInvitePolicy> {
  const rawPercent = Number(policy.rebatePercent);
  const normalized: PlatformInvitePolicy = {
    enabled: Boolean(policy.enabled),
    rebatePercent: Number.isFinite(rawPercent) ? Math.max(0, Math.min(100, Math.round(rawPercent * 100) / 100)) : 0,
    includeAdminAdjust: Boolean(policy.includeAdminAdjust),
  };
  await db
    .insert(systemSettings)
    .values({ key: INVITE_POLICY_KEY, value: normalized, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: normalized, updatedBy, updatedAt: new Date() },
    });
  invalidateSettingCache(INVITE_POLICY_KEY);
  return normalized;
}

/** 合并平台默认 WebDAV 配置与用户专属配额/期限，判断权限是否有效或超额。 */
export function resolveEffectiveUserWebdav(platform: PlatformWebdavConfig, userConfig: UserWebdavConfig | null | undefined) {
  if (!userConfig?.enabled) return null;
  const url = (userConfig.url || platform.url || "").trim();
  const username = (userConfig.username || platform.username || "").trim();
  const password = decryptSecretValue(userConfig.password) || platform.password || "";
  const directory = (userConfig.directory || platform.baseDirectory || "infinite-canvas").trim();
  if (!url) return null;
  const quotaBytes = typeof userConfig.quotaBytes === "number" && userConfig.quotaBytes > 0 ? userConfig.quotaBytes : null;
  const usedBytes = Math.max(0, Number(userConfig.usedBytes ?? 0));
  const expiresAt = userConfig.expiresAt || null;
  const isExpired = Boolean(expiresAt && new Date(expiresAt).getTime() <= Date.now());
  const isQuotaExceeded = Boolean(quotaBytes !== null && usedBytes >= quotaBytes);
  return {
    enabled: true,
    url,
    username,
    password,
    directory,
    quotaBytes,
    usedBytes,
    expiresAt,
    isExpired,
    isQuotaExceeded,
  };
}
