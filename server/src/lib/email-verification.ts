/** 邮箱验证码生命周期管理：生成发送、60 秒防刷冷却、10 分钟有效期及 5 次试错作废。 */
import { randomInt } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";

import { db, emailVerificationCodes, type EmailCodePurpose } from "../db/index.ts";
import { sha256Hex } from "./crypto.ts";
import { isMailConfigReady, sendVerificationCodeEmail } from "./mail.ts";
import { getPlatformMailConfig } from "./settings.ts";

export const EMAIL_CODE_TTL_MINUTES = 10;
export const EMAIL_CODE_TTL_MS = EMAIL_CODE_TTL_MINUTES * 60_000;
export const EMAIL_CODE_RESEND_COOLDOWN_SECONDS = 60;
export const EMAIL_CODE_RESEND_COOLDOWN_MS = EMAIL_CODE_RESEND_COOLDOWN_SECONDS * 1000;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;

function hashEmailCode(purpose: EmailCodePurpose, email: string, code: string) {
  return sha256Hex(`${purpose}:${email.trim().toLowerCase()}:${code.trim()}`);
}

/** 生成并发送 6 位邮箱验证码（含 60 秒防刷冷却，成功后作废同邮箱同用途旧验证码）。 */
export async function issueEmailVerificationCode(params: {
  email: string;
  purpose: EmailCodePurpose;
  userId?: string | null;
}) {
  const email = params.email.trim().toLowerCase();
  const mailConfig = await getPlatformMailConfig();
  if (!isMailConfigReady(mailConfig)) {
    return { ok: false as const, status: 400 as const, error: "管理员尚未启用或配置邮件服务" };
  }

  const latest = await db.query.emailVerificationCodes.findFirst({
    where: and(eq(emailVerificationCodes.email, email), eq(emailVerificationCodes.purpose, params.purpose)),
    orderBy: [desc(emailVerificationCodes.createdAt)],
  });
  if (latest) {
    const elapsed = Date.now() - latest.createdAt.getTime();
    if (elapsed < EMAIL_CODE_RESEND_COOLDOWN_MS) {
      const waitSeconds = Math.max(1, Math.ceil((EMAIL_CODE_RESEND_COOLDOWN_MS - elapsed) / 1000));
      return { ok: false as const, status: 429 as const, error: `发送过于频繁，请 ${waitSeconds} 秒后再试` };
    }
  }

  const code = randomInt(100_000, 1_000_000).toString();
  try {
    await sendVerificationCodeEmail({
      to: email,
      purpose: params.purpose,
      code,
      ttlMinutes: EMAIL_CODE_TTL_MINUTES,
      config: mailConfig,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "邮件发送失败";
    return { ok: false as const, status: 502 as const, error: `发送验证码邮件失败：${message}` };
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(emailVerificationCodes)
      .set({ consumedAt: now })
      .where(
        and(
          eq(emailVerificationCodes.email, email),
          eq(emailVerificationCodes.purpose, params.purpose),
          isNull(emailVerificationCodes.consumedAt),
        ),
      );
    await tx.insert(emailVerificationCodes).values({
      id: nanoid(),
      email,
      purpose: params.purpose,
      userId: params.userId ?? null,
      codeHash: hashEmailCode(params.purpose, email, code),
      attempts: 0,
      expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_MS),
      createdAt: now,
    });
  });

  return { ok: true as const, cooldownSeconds: EMAIL_CODE_RESEND_COOLDOWN_SECONDS, expiresInMinutes: EMAIL_CODE_TTL_MINUTES };
}

/** 校验并一次性消费邮箱验证码（超过最大试错次数或过期自动失效）。 */
export async function verifyAndConsumeEmailCode(params: {
  email: string;
  purpose: EmailCodePurpose;
  code: string;
  userId?: string | null;
}) {
  const email = params.email.trim().toLowerCase();
  const code = params.code.trim();
  if (!code) {
    return { ok: false as const, status: 400 as const, error: "请输入邮箱验证码" };
  }

  const record = await db.query.emailVerificationCodes.findFirst({
    where: and(
      eq(emailVerificationCodes.email, email),
      eq(emailVerificationCodes.purpose, params.purpose),
      isNull(emailVerificationCodes.consumedAt),
    ),
    orderBy: [desc(emailVerificationCodes.createdAt)],
  });
  if (!record) {
    return { ok: false as const, status: 400 as const, error: "请先获取邮箱验证码" };
  }
  if (params.userId && record.userId && record.userId !== params.userId) {
    return { ok: false as const, status: 400 as const, error: "验证码与当前账号不匹配，请重新获取" };
  }

  const now = new Date();
  if (record.expiresAt.getTime() <= now.getTime()) {
    await db.update(emailVerificationCodes).set({ consumedAt: now }).where(eq(emailVerificationCodes.id, record.id));
    return { ok: false as const, status: 400 as const, error: "验证码已过期，请重新获取" };
  }

  if (record.codeHash !== hashEmailCode(params.purpose, email, code)) {
    const nextAttempts = record.attempts + 1;
    const exhausted = nextAttempts >= EMAIL_CODE_MAX_ATTEMPTS;
    await db
      .update(emailVerificationCodes)
      .set({
        attempts: nextAttempts,
        ...(exhausted ? { consumedAt: now } : {}),
      })
      .where(eq(emailVerificationCodes.id, record.id));

    return {
      ok: false as const,
      status: 400 as const,
      error: exhausted
        ? "验证码错误次数过多，已失效，请重新获取"
        : `邮箱验证码不正确（还可重试 ${EMAIL_CODE_MAX_ATTEMPTS - nextAttempts} 次）`,
    };
  }

  const [consumed] = await db
    .update(emailVerificationCodes)
    .set({ consumedAt: now })
    .where(and(eq(emailVerificationCodes.id, record.id), isNull(emailVerificationCodes.consumedAt)))
    .returning({ id: emailVerificationCodes.id });

  if (!consumed) {
    return { ok: false as const, status: 400 as const, error: "验证码已被使用，请重新获取" };
  }

  return { ok: true as const };
}
