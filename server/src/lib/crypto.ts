/** 密码哈希、令牌摘要、AES-256-GCM 配置加密与密钥脱敏工具。 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { env } from "../env.ts";

// 使用配置密钥派生定长 32 字节对称密钥，用于加密存储上游 API Key / S3 / WebDAV 密钥
const encryptionKey = createHash("sha256")
  .update(env.SETTINGS_ENCRYPTION_KEY || env.JWT_SECRET)
  .digest();

/** 使用 Argon2id 计算用户密码哈希。 */
export async function hashPassword(password: string) {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

/** 校验明文密码与哈希是否匹配。 */
export async function verifyPassword(password: string, hash: string) {
  return Bun.password.verify(password, hash);
}

/** 计算字符串的 SHA-256 十六进制摘要（用于存储 refreshToken 哈希）。 */
export function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

/** 生成 URL 安全的随机令牌。 */
export function generateRandomToken(byteLength = 32) {
  return randomBytes(byteLength).toString("base64url");
}

/** 将 JSON 配置对象加密为 `iv.tag.ciphertext` 字符串。 */
export function encryptJson(payload: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

/** 解密由 `encryptJson` 生成的密文并返回原 JSON 结构。 */
export function decryptJson<T>(ciphertext: string): T {
  const parts = ciphertext.split(".");
  if (parts.length !== 3) throw new Error("加密配置格式无效");
  const [ivPart, tagPart, dataPart] = parts;
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataPart, "base64url")), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8")) as T;
}

/** 对外展示密钥时保留首尾各 4 位字符并脱敏中间内容。 */
export function maskSecret(value: string) {
  if (!value) return "";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

const SECRET_PREFIX = "enc:v1:";

/** 加密单个敏感字符串（带版本前缀，便于平滑识别已加密与历史明文值）。 */
export function encryptSecretValue(value: string): string {
  if (!value) return "";
  if (value.startsWith(SECRET_PREFIX)) return value;
  return `${SECRET_PREFIX}${encryptJson({ v: value })}`;
}

/** 解密单个敏感字符串；若为未加密的历史明文则原样返回。 */
export function decryptSecretValue(value: string | null | undefined): string {
  if (!value) return "";
  if (!value.startsWith(SECRET_PREFIX)) return value;
  try {
    return decryptJson<{ v?: string }>(value.slice(SECRET_PREFIX.length)).v || "";
  } catch {
    return "";
  }
}
