/** 服务端环境变量解析与启动校验。 */
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1, "缺少 DATABASE_URL 环境变量"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET 长度至少需要 16 位"),
  SETTINGS_ENCRYPTION_KEY: z.string().optional().default(""),
  JWT_ACCESS_EXPIRES_SECONDS: z.coerce.number().int().positive().default(7200),
  JWT_REFRESH_EXPIRES_DAYS: z.coerce.number().int().positive().default(30),
  S3_PRESIGN_EXPIRES_SECONDS: z.coerce.number().int().positive().default(900),
  CORS_ORIGIN: z.string().optional().default(""),
  S3_PROVIDER: z.enum(["s3", "r2", "oss", "cos"]).optional().default("s3"),
  S3_ENDPOINT: z.string().optional().default(""),
  S3_REGION: z.string().optional().default("auto"),
  S3_BUCKET: z.string().optional().default(""),
  S3_ACCESS_KEY_ID: z.string().optional().default(""),
  S3_SECRET_ACCESS_KEY: z.string().optional().default(""),
  S3_PUBLIC_BASE_URL: z.string().optional().default(""),
  S3_FORCE_PATH_STYLE: z.string().optional().default("false"),
  DB_POOL_MAX: z.coerce.number().int().min(5).max(200).default(40),
  DB_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(600).default(20),
  DB_CONNECT_TIMEOUT_SECONDS: z.coerce.number().int().min(2).max(120).default(10),
  SETTINGS_CACHE_TTL_MS: z.coerce.number().int().min(0).max(300000).default(10000),
  MEDIA_PERSIST_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(12),
  MEDIA_FETCH_TIMEOUT_MS: z.coerce.number().int().min(5000).max(600000).default(60000),
  MEDIA_PERSIST_MAX_BYTES: z.coerce.number().int().min(1024 * 1024).default(100 * 1024 * 1024),
  AI_PROXY_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(2000).default(120),
  AI_PROXY_MAX_QUEUE: z.coerce.number().int().min(0).max(5000).default(300),
  AI_PROXY_QUEUE_WAIT_MS: z.coerce.number().int().min(1000).max(300000).default(30000),
  AI_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(10000).max(900000).default(300000),
  AI_POLL_TIMEOUT_MS: z.coerce.number().int().min(5000).max(120000).default(30000),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("环境变量校验失败:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
