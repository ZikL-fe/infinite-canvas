/** 平台 SMTP 邮件发送服务与常用邮件模板（验证码、余额不足提醒、测试邮件）。 */
import nodemailer from "nodemailer";

import type { EmailCodePurpose } from "../db/index.ts";
import { getPlatformMailConfig, type PlatformMailConfig } from "./settings.ts";

const SMTP_TIMEOUT_MS = 10_000;

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 判断平台邮件服务是否已启用且核心 SMTP 字段填写完整。 */
export function isMailConfigReady(config: PlatformMailConfig | null | undefined): config is PlatformMailConfig {
  if (!config?.enabled) return false;
  return Boolean(config.host.trim() && config.port > 0 && config.fromAddress.trim());
}

function formatFromHeader(config: PlatformMailConfig) {
  const address = config.fromAddress.trim();
  const name = config.fromName.trim();
  return name ? `"${name.replace(/"/g, "")}" <${address}>` : address;
}

/** 通过平台或临时覆盖的 SMTP 配置发送邮件（超时 10 秒）。 */
export async function sendMail(params: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  configOverride?: PlatformMailConfig;
}) {
  const config = params.configOverride ?? (await getPlatformMailConfig());
  if (!params.configOverride && !isMailConfigReady(config)) {
    throw new Error("邮件服务尚未启用或配置不完整");
  }
  if (!config.host.trim() || !config.port || !config.fromAddress.trim()) {
    throw new Error("请填写完整的 SMTP 服务器地址、端口与发件人邮箱");
  }

  const transporter = nodemailer.createTransport({
    host: config.host.trim(),
    port: config.port,
    secure: config.secure,
    auth: config.username.trim()
      ? {
          user: config.username.trim(),
          pass: config.password,
        }
      : undefined,
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });

  await transporter.sendMail({
    from: formatFromHeader(config),
    to: params.to.trim(),
    subject: params.subject,
    html: params.html,
    text: params.text,
  });
}

const PURPOSE_META: Record<EmailCodePurpose, { title: string; action: string }> = {
  register: { title: "注册邮箱验证", action: "完成账号注册与邮箱绑定" },
  bind_email: { title: "绑定邮箱验证", action: "绑定或更换账号邮箱" },
  reset_password: { title: "找回密码验证", action: "重置账号登录密码" },
  change_password: { title: "修改密码验证", action: "验证并修改当前账号密码" },
};

function renderEmailShell(title: string, bodyHtml: string) {
  return `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1f2937;background:#f9fafb;">
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;">
      <div style="font-size:18px;font-weight:600;color:#111827;margin-bottom:16px;">${escapeHtml(title)}</div>
      ${bodyHtml}
      <div style="margin-top:24px;padding-top:16px;border-top:1px solid #f3f4f6;font-size:12px;color:#6b7280;">
        此邮件由系统自动发送，请勿直接回复。如非本人操作，请忽略本邮件或及时修改密码。
      </div>
    </div>
  </div>`;
}

/** 发送 6 位邮箱验证码邮件。 */
export async function sendVerificationCodeEmail(params: {
  to: string;
  purpose: EmailCodePurpose;
  code: string;
  ttlMinutes: number;
  config?: PlatformMailConfig;
}) {
  const meta = PURPOSE_META[params.purpose];
  const subject = `${meta.title} - 无限画布`;
  const html = renderEmailShell(
    meta.title,
    `
      <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">您好，您正在通过邮箱验证码${escapeHtml(meta.action)}：</p>
      <div style="margin:18px 0;padding:14px 18px;border-radius:10px;background:#f3f4f6;text-align:center;letter-spacing:6px;font-size:28px;font-weight:700;color:#111827;">
        ${escapeHtml(params.code)}
      </div>
      <p style="margin:0;font-size:13px;color:#4b5563;">验证码有效期为 <strong>${params.ttlMinutes} 分钟</strong>，请勿泄露给他人。</p>
    `,
  );
  const text = `【无限画布】${meta.title}验证码：${params.code}，有效期 ${params.ttlMinutes} 分钟，用于${meta.action}。请勿泄露给他人。`;
  await sendMail({ to: params.to, subject, html, text, configOverride: params.config });
}

/** 发送积分余额不足提醒邮件。 */
export async function sendLowBalanceAlertEmail(params: {
  to: string;
  displayName: string;
  balance: number;
  threshold: number;
  config?: PlatformMailConfig;
}) {
  const subject = "积分余额不足提醒 - 无限画布";
  const html = renderEmailShell(
    "积分余额不足提醒",
    `
      <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">您好，${escapeHtml(params.displayName)}：</p>
      <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">
        您的无限画布账号当前积分余额为 <strong style="color:#dc2626;">${params.balance}</strong>，已低于提醒阈值 <strong>${params.threshold}</strong> 积分。
      </p>
      <p style="margin:0;font-size:13px;color:#4b5563;">为避免影响 AI 生成任务，请及时前往「积分钱包」兑换积分码或联系管理员充值。</p>
    `,
  );
  const text = `【无限画布】您好 ${params.displayName}，您的账号当前积分余额为 ${params.balance}，已低于提醒阈值 ${params.threshold} 积分，请及时充值或兑换积分码。`;
  await sendMail({ to: params.to, subject, html, text, configOverride: params.config });
}

/** 发送管理员后台 SMTP 测试邮件。 */
export async function sendTestMail(params: { to: string; config: PlatformMailConfig }) {
  const subject = "邮件服务测试 - 无限画布";
  const html = renderEmailShell(
    "邮件服务测试成功",
    `<p style="margin:0;font-size:14px;line-height:1.6;">这是一封来自无限画布管理后台的测试邮件。如果您收到此邮件，说明当前 SMTP 发信配置工作正常。</p>`,
  );
  const text = "【无限画布】这是一封测试邮件，说明当前 SMTP 发信配置工作正常。";
  await sendMail({ to: params.to, subject, html, text, configOverride: params.config });
}

function formatEmailBytes(bytes: number) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, idx);
  return `${val >= 100 || idx === 0 ? val.toFixed(0) : val.toFixed(2)} ${units[idx]}`;
}

function formatEmailDate(date: Date) {
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** 发送云存储即将到期预警邮件。 */
export async function sendStoragePreExpiryEmail(params: {
  to: string;
  displayName: string;
  usedBytes: number;
  quotaBytes: number;
  expiresAt: Date;
  gracePeriodDays: number;
}) {
  const subject = "云存储配额即将到期提醒 - 无限画布";
  const expiresLabel = formatEmailDate(params.expiresAt);
  const html = renderEmailShell(
    "云存储配额即将到期提醒",
    `
      <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">您好，${escapeHtml(params.displayName)}：</p>
      <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">
        您的无限画布云存储配额（当前已用 <strong>${escapeHtml(formatEmailBytes(params.usedBytes))}</strong> / 总配额 <strong>${escapeHtml(formatEmailBytes(params.quotaBytes))}</strong>）
        将于 <strong style="color:#d97706;">${escapeHtml(expiresLabel)}</strong> 到期。
      </p>
      <p style="margin:0 0 12px;font-size:13px;color:#4b5563;">
        到期后系统将提供 <strong>${params.gracePeriodDays} 天</strong> 宽限期；若宽限期结束后仍未续期且已用空间超出有效配额，系统将自动清理超出的云端文件及必要的云端项目记录。
      </p>
      <p style="margin:0;font-size:13px;color:#4b5563;">请及时前往「个人中心」兑换存储容量码、续期或提前下载备份重要资产。</p>
    `,
  );
  const text = `【无限画布】您好 ${params.displayName}，您的云存储配额（已用 ${formatEmailBytes(params.usedBytes)} / ${formatEmailBytes(params.quotaBytes)}）将于 ${expiresLabel} 到期，到期宽限期为 ${params.gracePeriodDays} 天，请及时续期或备份数据。`;
  await sendMail({ to: params.to, subject, html, text });
}

/** 发送云存储已到期进入宽限期通知邮件。 */
export async function sendStorageExpiredNoticeEmail(params: {
  to: string;
  displayName: string;
  usedBytes: number;
  remainingQuotaBytes: number;
  expiredAt: Date;
  graceEndsAt: Date;
  gracePeriodDays: number;
}) {
  const subject = "云存储已到期，请及时续期或备份数据 - 无限画布";
  const expiredLabel = formatEmailDate(params.expiredAt);
  const graceEndsLabel = formatEmailDate(params.graceEndsAt);
  const html = renderEmailShell(
    "云存储已到期（宽限期通知）",
    `
      <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">您好，${escapeHtml(params.displayName)}：</p>
      <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">
        您的云存储配额已于 <strong>${escapeHtml(expiredLabel)}</strong> 到期。当前已占用云端空间 <strong>${escapeHtml(formatEmailBytes(params.usedBytes))}</strong>，
        当前剩余有效配额为 <strong>${escapeHtml(formatEmailBytes(params.remainingQuotaBytes))}</strong>。
      </p>
      <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">
        您现有 <strong>${params.gracePeriodDays} 天</strong> 数据保留宽限期，截止时间为 <strong style="color:#dc2626;">${escapeHtml(graceEndsLabel)}</strong>。
      </p>
      <p style="margin:0;font-size:13px;color:#4b5563;">
        若在宽限期结束前仍未续期或手动清理超出文件，系统将在宽限期满后自动清理过期云端媒体文件；若仍超出配额，还将清理云端画布项目与生成记录。
      </p>
    `,
  );
  const text = `【无限画布】您好 ${params.displayName}，您的云存储配额已于 ${expiredLabel} 到期（当前已用 ${formatEmailBytes(params.usedBytes)}，剩余有效配额 ${formatEmailBytes(params.remainingQuotaBytes)}），请在宽限期截止（${graceEndsLabel}）前完成续期或数据备份。`;
  await sendMail({ to: params.to, subject, html, text });
}

/** 发送云存储逾期自动清理完成确认邮件。 */
export async function sendStorageCleanedEmail(params: {
  to: string;
  displayName: string;
  deletedMediaCount: number;
  freedBytes: number;
  deletedCanvasCount: number;
  deletedWorkbenchCount: number;
  deletedAssetCount: number;
  remainingQuotaBytes: number;
}) {
  const subject = "云存储逾期数据已自动清理通知 - 无限画布";
  const workspaceParts: string[] = [];
  if (params.deletedCanvasCount > 0) workspaceParts.push(`云端画布 ${params.deletedCanvasCount} 个`);
  if (params.deletedWorkbenchCount > 0) workspaceParts.push(`工作台记录 ${params.deletedWorkbenchCount} 条`);
  if (params.deletedAssetCount > 0) workspaceParts.push(`个人资产 ${params.deletedAssetCount} 项`);
  const workspaceSummary = workspaceParts.length > 0 ? workspaceParts.join("、") : "无额外项目记录";

  const html = renderEmailShell(
    "云存储逾期数据清理完成",
    `
      <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">您好，${escapeHtml(params.displayName)}：</p>
      <p style="margin:0 0 12px;font-size:14px;line-height:1.6;">
        由于您的云存储配额到期且已超过宽限期未续期，系统已按平台规则执行自动清理：
      </p>
      <ul style="margin:0 0 12px;padding-left:20px;font-size:13px;line-height:1.8;color:#374151;">
        <li>清理云端媒体文件：<strong>${params.deletedMediaCount} 个</strong>（释放空间 <strong>${escapeHtml(formatEmailBytes(params.freedBytes))}</strong>）</li>
        <li>清理云端关联数据：<strong>${escapeHtml(workspaceSummary)}</strong></li>
        <li>当前剩余有效配额：<strong>${escapeHtml(formatEmailBytes(params.remainingQuotaBytes))}</strong></li>
      </ul>
      <p style="margin:0;font-size:13px;color:#4b5563;">如需继续使用云存储服务，可在登录后前往「个人中心」兑换存储容量码或联系管理员开通新配额。</p>
    `,
  );
  const text = `【无限画布】您好 ${params.displayName}，您的云存储配额到期且超过宽限期未续期，系统已清理媒体文件 ${params.deletedMediaCount} 个（释放 ${formatEmailBytes(params.freedBytes)}），关联数据：${workspaceSummary}。`;
  await sendMail({ to: params.to, subject, html, text });
}
