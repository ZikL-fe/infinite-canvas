/** 管理后台：对象存储、认证、邮件、WebDAV、存储到期清理与数据分析设置路由。 */
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { cleanupExpiredUsageLogs, invalidateAnalyticsCache, normalizeDashboardRange, queryAnalyticsDashboard } from "../../lib/analytics.ts";
import { maskSecret } from "../../lib/crypto.ts";
import { isMailConfigReady, sendTestMail } from "../../lib/mail.ts";
import { testS3Connection } from "../../lib/s3.ts";
import {
  getAuthPolicy,
  getPlatformAnalyticsPolicy,
  getPlatformMailConfig,
  getPlatformStorageExpiryPolicy,
  getPlatformWebdavConfig,
  getS3StorageConfig,
  saveAuthPolicy,
  savePlatformAnalyticsPolicy,
  savePlatformMailConfig,
  savePlatformStorageExpiryPolicy,
  savePlatformWebdavConfig,
  saveS3StorageConfig,
  type PlatformMailConfig,
  type S3StorageConfig,
} from "../../lib/settings.ts";
import { runStorageExpirySweep } from "../../lib/storage-expiry.ts";
import type { AppEnv } from "../../middleware/auth.ts";

const platformWebdavSchema = z.object({
  enabled: z.boolean(),
  url: z.string().trim().default(""),
  username: z.string().trim().default(""),
  password: z.string().optional().default(""),
  baseDirectory: z.string().trim().default("infinite-canvas"),
  autoAssignNewUsers: z.boolean().default(false),
});

const storageConfigSchema = z.object({
  provider: z.enum(["s3", "r2", "oss", "cos"]),
  endpoint: z.string().trim().default(""),
  region: z.string().trim().default("auto"),
  bucket: z.string().trim().min(1, "请填写 Bucket 名称"),
  accessKeyId: z.string().trim().min(1, "请填写 AccessKey ID"),
  secretAccessKey: z.string().optional().default(""),
  publicBaseUrl: z.string().trim().default(""),
  forcePathStyle: z.boolean().default(false),
});

const authPolicySchema = z.object({
  allowRegister: z.boolean(),
  requireEmailOnRegister: z.boolean().optional().default(false),
});

const mailConfigSchema = z.object({
  enabled: z.boolean(),
  host: z.string().trim().default(""),
  port: z.number().int().min(1).max(65535).default(465),
  secure: z.boolean().default(true),
  username: z.string().trim().default(""),
  password: z.string().optional().default(""),
  fromName: z.string().trim().max(64).default("ZIKL画布"),
  fromAddress: z.string().trim().email("发件人邮箱格式不正确").optional().or(z.literal("")),
  lowBalanceAlertEnabled: z.boolean().default(true),
  lowBalanceThreshold: z.number().nonnegative("低余额阈值不能小于 0").max(1_000_000).default(10),
  lowBalanceCooldownHours: z.number().int().min(1).max(720).default(24),
});

const testMailSchema = mailConfigSchema.extend({
  testTo: z.string().trim().email("请填写有效的测试收件邮箱"),
});

export const adminSettingsRoutes = new Hono<AppEnv>();

adminSettingsRoutes.get("/settings/storage", async (c) => {
  const config = await getS3StorageConfig();
  if (!config) {
    return c.json({
      configured: false,
      config: {
        provider: "r2",
        endpoint: "",
        region: "auto",
        bucket: "",
        accessKeyId: "",
        publicBaseUrl: "",
        forcePathStyle: false,
        hasSecretKey: false,
        secretAccessKeyPreview: "",
      },
    });
  }

  return c.json({
    configured: true,
    config: {
      provider: config.provider,
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      publicBaseUrl: config.publicBaseUrl,
      forcePathStyle: config.forcePathStyle,
      hasSecretKey: Boolean(config.secretAccessKey),
      secretAccessKeyPreview: maskSecret(config.secretAccessKey),
    },
  });
});

adminSettingsRoutes.put("/settings/storage", zValidator("json", storageConfigSchema), async (c) => {
  const body = c.req.valid("json");
  const existing = await getS3StorageConfig();
  const secretAccessKey = body.secretAccessKey.trim() || existing?.secretAccessKey || "";
  if (!secretAccessKey) {
    return c.json({ error: "请填写 SecretAccessKey" }, 400);
  }

  const nextConfig: S3StorageConfig = {
    provider: body.provider,
    endpoint: body.endpoint,
    region: body.region || "auto",
    bucket: body.bucket,
    accessKeyId: body.accessKeyId,
    secretAccessKey,
    publicBaseUrl: body.publicBaseUrl,
    forcePathStyle: body.forcePathStyle,
  };

  await saveS3StorageConfig(nextConfig, c.get("user").id);
  return c.json({ ok: true, secretAccessKeyPreview: maskSecret(secretAccessKey) });
});

adminSettingsRoutes.post("/settings/storage/test", zValidator("json", storageConfigSchema), async (c) => {
  const body = c.req.valid("json");
  const existing = await getS3StorageConfig();
  const secretAccessKey = body.secretAccessKey.trim() || existing?.secretAccessKey || "";
  if (!secretAccessKey) {
    return c.json({ error: "请先填写 SecretAccessKey" }, 400);
  }

  try {
    await testS3Connection({
      provider: body.provider,
      endpoint: body.endpoint,
      region: body.region || "auto",
      bucket: body.bucket,
      accessKeyId: body.accessKeyId,
      secretAccessKey,
      publicBaseUrl: body.publicBaseUrl,
      forcePathStyle: body.forcePathStyle,
    });
    return c.json({ ok: true, message: "连接成功，测试文件写入、读取、删除均正常" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "对象存储连接测试失败";
    return c.json({ error: message }, 400);
  }
});

adminSettingsRoutes.get("/settings/auth", async (c) => {
  const [policy, mailConfig] = await Promise.all([getAuthPolicy(), getPlatformMailConfig()]);
  return c.json({
    ...policy,
    emailEnabled: isMailConfigReady(mailConfig),
  });
});

adminSettingsRoutes.put("/settings/auth", zValidator("json", authPolicySchema), async (c) => {
  const body = c.req.valid("json");
  if (body.requireEmailOnRegister) {
    const mailConfig = await getPlatformMailConfig();
    if (!isMailConfigReady(mailConfig)) {
      return c.json({ error: "请先在「邮件服务配置」中启用并配置完整的 SMTP 参数后再开启强制邮箱验证" }, 400);
    }
  }
  const policy = await saveAuthPolicy(body, c.get("user").id);
  return c.json(policy);
});

adminSettingsRoutes.get("/settings/mail", async (c) => {
  const config = await getPlatformMailConfig();
  return c.json({
    enabled: config.enabled,
    host: config.host,
    port: config.port,
    secure: config.secure,
    username: config.username,
    hasPassword: Boolean(config.password),
    passwordPreview: maskSecret(config.password),
    fromName: config.fromName,
    fromAddress: config.fromAddress,
    lowBalanceAlertEnabled: config.lowBalanceAlertEnabled,
    lowBalanceThreshold: config.lowBalanceThreshold,
    lowBalanceCooldownHours: config.lowBalanceCooldownHours,
    ready: isMailConfigReady(config),
  });
});

adminSettingsRoutes.put("/settings/mail", zValidator("json", mailConfigSchema), async (c) => {
  const body = c.req.valid("json");
  const existing = await getPlatformMailConfig();
  const nextConfig: PlatformMailConfig = {
    enabled: body.enabled,
    host: body.host,
    port: body.port,
    secure: body.secure,
    username: body.username,
    password: body.password.trim() || existing.password,
    fromName: body.fromName || "ZIKL画布",
    fromAddress: body.fromAddress || "",
    lowBalanceAlertEnabled: body.lowBalanceAlertEnabled,
    lowBalanceThreshold: body.lowBalanceThreshold,
    lowBalanceCooldownHours: body.lowBalanceCooldownHours,
  };
  if (nextConfig.enabled && !isMailConfigReady(nextConfig)) {
    return c.json({ error: "启用邮件服务时，请填写完整的 SMTP 主机、端口与发件人邮箱" }, 400);
  }
  await savePlatformMailConfig(nextConfig, c.get("user").id);
  if (!nextConfig.enabled) {
    const authPolicy = await getAuthPolicy();
    if (authPolicy.requireEmailOnRegister) {
      await saveAuthPolicy({ ...authPolicy, requireEmailOnRegister: false }, c.get("user").id);
    }
  }
  return c.json({ ok: true, ready: isMailConfigReady(nextConfig), passwordPreview: maskSecret(nextConfig.password) });
});

adminSettingsRoutes.post("/settings/mail/test", zValidator("json", testMailSchema), async (c) => {
  const body = c.req.valid("json");
  const existing = await getPlatformMailConfig();
  const config: PlatformMailConfig = {
    enabled: true,
    host: body.host,
    port: body.port,
    secure: body.secure,
    username: body.username,
    password: body.password.trim() || existing.password,
    fromName: body.fromName || "ZIKL画布",
    fromAddress: body.fromAddress || "",
    lowBalanceAlertEnabled: body.lowBalanceAlertEnabled,
    lowBalanceThreshold: body.lowBalanceThreshold,
    lowBalanceCooldownHours: body.lowBalanceCooldownHours,
  };
  try {
    await sendTestMail({ to: body.testTo, config });
    return c.json({ ok: true, message: `测试邮件已发送至 ${body.testTo}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : "测试邮件发送失败";
    return c.json({ error: `测试邮件发送失败：${message}` }, 400);
  }
});

const saveStorageExpiryPolicySchema = z.object({
  enabled: z.boolean().optional(),
  gracePeriodDays: z.number().int().min(1).max(365).optional(),
  preExpiryWarnDays: z.number().int().min(0).max(30).optional(),
  cleanupWorkspaceData: z.boolean().optional(),
  exemptAdmins: z.boolean().optional(),
  cleanupOverQuotaWithoutExpiry: z.boolean().optional(),
});

const runStorageExpirySweepSchema = z.object({
  dryRun: z.boolean().optional(),
  userId: z.string().trim().min(1).optional(),
});

adminSettingsRoutes.get("/settings/storage-expiry", async (c) => {
  const [policy, mailConfig] = await Promise.all([getPlatformStorageExpiryPolicy(), getPlatformMailConfig()]);
  return c.json({
    ...policy,
    mailReady: isMailConfigReady(mailConfig),
  });
});

adminSettingsRoutes.put("/settings/storage-expiry", zValidator("json", saveStorageExpiryPolicySchema), async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const prev = await getPlatformStorageExpiryPolicy();
  const saved = await savePlatformStorageExpiryPolicy(
    {
      enabled: body.enabled ?? prev.enabled,
      gracePeriodDays: body.gracePeriodDays ?? prev.gracePeriodDays,
      preExpiryWarnDays: body.preExpiryWarnDays ?? prev.preExpiryWarnDays,
      cleanupWorkspaceData: body.cleanupWorkspaceData ?? prev.cleanupWorkspaceData,
      exemptAdmins: body.exemptAdmins ?? prev.exemptAdmins,
      cleanupOverQuotaWithoutExpiry: body.cleanupOverQuotaWithoutExpiry ?? prev.cleanupOverQuotaWithoutExpiry,
    },
    user.id,
  );
  const mailConfig = await getPlatformMailConfig();
  return c.json({
    ok: true,
    ...saved,
    mailReady: isMailConfigReady(mailConfig),
  });
});

adminSettingsRoutes.post("/settings/storage-expiry/run", zValidator("json", runStorageExpirySweepSchema), async (c) => {
  const body = c.req.valid("json");
  const result = await runStorageExpirySweep({ dryRun: Boolean(body.dryRun), userId: body.userId });
  return c.json(result);
});

const saveAnalyticsPolicySchema = z.object({
  sampleIntervalMinutes: z.number().int().min(1).max(1440),
  logRetentionDays: z.number().int().min(0).max(3650),
});

const cleanupLogsSchema = z.object({
  retentionDays: z.number().int().min(1).max(3650).optional(),
});

adminSettingsRoutes.get("/dashboard", async (c) => {
  const range = normalizeDashboardRange(c.req.query("range"));
  const force = c.req.query("force") === "1" || c.req.query("force") === "true";
  const dashboard = await queryAnalyticsDashboard({ range, force });
  return c.json(dashboard);
});

adminSettingsRoutes.get("/settings/analytics", async (c) => {
  const policy = await getPlatformAnalyticsPolicy();
  return c.json(policy);
});

adminSettingsRoutes.put("/settings/analytics", zValidator("json", saveAnalyticsPolicySchema), async (c) => {
  const body = c.req.valid("json");
  const saved = await savePlatformAnalyticsPolicy(body, c.get("user").id);
  invalidateAnalyticsCache();
  return c.json({ ok: true, ...saved });
});

adminSettingsRoutes.post("/settings/analytics/cleanup-logs", zValidator("json", cleanupLogsSchema), async (c) => {
  const body = c.req.valid("json");
  const result = await cleanupExpiredUsageLogs(body.retentionDays);
  return c.json({ ok: true, ...result });
});


adminSettingsRoutes.get("/settings/webdav", async (c) => {
  const config = await getPlatformWebdavConfig();
  return c.json({
    enabled: config.enabled,
    url: config.url,
    username: config.username,
    baseDirectory: config.baseDirectory,
    autoAssignNewUsers: config.autoAssignNewUsers,
    hasPassword: Boolean(config.password),
    passwordPreview: maskSecret(config.password),
  });
});

adminSettingsRoutes.put("/settings/webdav", zValidator("json", platformWebdavSchema), async (c) => {
  const body = c.req.valid("json");
  const existing = await getPlatformWebdavConfig();
  await savePlatformWebdavConfig(
    {
      enabled: body.enabled,
      url: body.url,
      username: body.username,
      password: body.password.trim() || existing.password,
      baseDirectory: body.baseDirectory,
      autoAssignNewUsers: body.autoAssignNewUsers,
    },
    c.get("user").id,
  );
  return c.json({ ok: true });
});

adminSettingsRoutes.post("/settings/webdav/test", zValidator("json", platformWebdavSchema), async (c) => {
  const body = c.req.valid("json");
  const existing = await getPlatformWebdavConfig();
  const password = body.password.trim() || existing.password;
  const url = body.url.trim().replace(/\/+$/, "");
  if (!url) {
    return c.json({ error: "请先填写 WebDAV 地址" }, 400);
  }
  const auth = Buffer.from(`${body.username}:${password}`).toString("base64");
  const res = await fetch(`${url}/`, {
    method: "PROPFIND",
    headers: {
      Depth: "0",
      ...(body.username ? { Authorization: `Basic ${auth}` } : {}),
    },
  });
  if (!res.ok && res.status !== 207) {
    return c.json({ error: `WebDAV 连接测试失败（HTTP ${res.status}）` }, 400);
  }
  return c.json({ ok: true, message: "WebDAV 连接测试成功" });
});

