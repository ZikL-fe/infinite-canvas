/** 平台级系统设置读写与加密持久化：认证策略、S3 对象存储、AI 渠道与 WebDAV 配置。 */
import { eq } from "drizzle-orm";

import { db, systemSettings, type UserWebdavConfig } from "../db/index.ts";
import { env } from "../env.ts";
import { decryptJson, encryptJson } from "./crypto.ts";

export const AUTH_POLICY_KEY = "auth.policy";
export const STORAGE_S3_KEY = "storage.s3";
export const AI_CHANNELS_KEY = "ai.channels";
export const WEBDAV_CONFIG_KEY = "sync.webdav";
export const MAIL_CONFIG_KEY = "mail.smtp";
export const STORAGE_EXPIRY_POLICY_KEY = "storage.expiry";

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

export type AuthPolicy = {
  allowRegister: boolean;
  requireEmailOnRegister: boolean;
};

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

export async function getAuthPolicy(): Promise<AuthPolicy> {
  return getCachedSetting(AUTH_POLICY_KEY, async () => {
    const row = await db.query.systemSettings.findFirst({ where: eq(systemSettings.key, AUTH_POLICY_KEY) });
    const raw = row?.value as Partial<AuthPolicy> | undefined;
    return {
      allowRegister: raw?.allowRegister ?? true,
      requireEmailOnRegister: Boolean(raw?.requireEmailOnRegister),
    };
  });
}

export async function saveAuthPolicy(policy: AuthPolicy, updatedBy: string) {
  await db
    .insert(systemSettings)
    .values({ key: AUTH_POLICY_KEY, value: policy, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: policy, updatedBy, updatedAt: new Date() },
    });
  invalidateSettingCache(AUTH_POLICY_KEY);
  return policy;
}

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
      fromName: raw.fromName || "无限画布",
      fromAddress: raw.fromAddress || "",
      lowBalanceAlertEnabled: raw.lowBalanceAlertEnabled ?? true,
      lowBalanceThreshold: Number.isFinite(threshold) && threshold >= 0 ? threshold : 10,
      lowBalanceCooldownHours: Number.isFinite(cooldownHours) && cooldownHours >= 1 ? Math.floor(cooldownHours) : 24,
    };
  });
}

export async function savePlatformMailConfig(config: PlatformMailConfig, updatedBy: string) {
  const publicValue = {
    enabled: config.enabled,
    host: config.host.trim(),
    port: Math.max(1, Math.min(65535, Math.floor(config.port || 465))),
    secure: config.secure,
    username: config.username.trim(),
    fromName: config.fromName.trim() || "无限画布",
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
    };
  });
}

export async function savePlatformStorageExpiryPolicy(policy: PlatformStorageExpiryPolicy, updatedBy: string) {
  const normalized: PlatformStorageExpiryPolicy = {
    enabled: Boolean(policy.enabled),
    gracePeriodDays: Math.max(1, Math.min(365, Math.floor(policy.gracePeriodDays || 7))),
    preExpiryWarnDays: Math.max(0, Math.min(30, Math.floor(policy.preExpiryWarnDays ?? 3))),
    cleanupWorkspaceData: Boolean(policy.cleanupWorkspaceData),
    exemptAdmins: Boolean(policy.exemptAdmins),
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

/** 合并平台默认 WebDAV 配置与用户专属配额/期限，判断权限是否有效或超额。 */
export function resolveEffectiveUserWebdav(platform: PlatformWebdavConfig, userConfig: UserWebdavConfig | null | undefined) {
  if (!userConfig?.enabled) return null;
  const url = (userConfig.url || platform.url || "").trim();
  const username = (userConfig.username || platform.username || "").trim();
  const password = userConfig.password || platform.password || "";
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
