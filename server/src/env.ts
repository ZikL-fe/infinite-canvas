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
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("环境变量校验失败:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
