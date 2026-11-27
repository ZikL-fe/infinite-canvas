/** 积分计费、钱包账本事务操作、消费趋势统计与多维度日志查询。 */
import { and, count, desc, eq, gte, gt, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";

import { creditLedger, creditWallets, db, users } from "../db/index.ts";
import { scheduleWalletBalanceAlertCheck } from "./billing-alert.ts";
import type {
  AudioModelPricing,
  ImageModelPricing,
  ModelPricing,
  TextModelPricing,
  VideoModelPricing,
} from "./settings.ts";

/** 按 4 位小数精度截断/四舍五入积分数值，避免浮点误差累积。 */
export function roundCredits(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10000) / 10000;
}

/** 判断模型计费配置是否存在任一非零单价（全为 0 视作免费模型，仍记调用日志但不扣费）。 */
export function hasNonZeroPricing(pricing?: ModelPricing) {
  if (!pricing) return false;
  if (pricing.mode === "token") {
    return pricing.inputPerMillion > 0 || pricing.cachedInputPerMillion > 0 || pricing.outputPerMillion > 0;
  }
  if (pricing.mode === "per_image") {
    return (pricing.perImage ?? 0) > 0;
  }
  if (pricing.mode === "per_resolution") {
    const res = pricing.resolutionPrices;
    return (res?.default ?? 0) > 0 || (res?.["1k"] ?? 0) > 0 || (res?.["2k"] ?? 0) > 0 || (res?.["4k"] ?? 0) > 0;
  }
  if (pricing.mode === "per_request") {
    return (pricing.perRequest ?? 0) > 0 || (Boolean(pricing.chargeReferenceVideo) && (pricing.referenceVideoPrice ?? 0) > 0);
  }
  if (pricing.mode === "per_second") {
    const videoPricing = pricing as VideoModelPricing;
    return (
      (videoPricing.perSecond ?? 0) > 0 ||
      (Boolean(videoPricing.chargeReferenceVideo) && (videoPricing.referenceVideoPrice ?? 0) > 0)
    );
  }
  return false;
}

/** 按未缓存输入、缓存命中输入与输出 Token 用量计算文本模型积分消耗。 */
export function calculateTextCredits(
  pricing: TextModelPricing,
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
) {
  const cached = Math.max(0, Math.min(usage.inputTokens, usage.cachedInputTokens));
  const uncached = Math.max(0, usage.inputTokens - cached);
  const output = Math.max(0, usage.outputTokens);
  return roundCredits(
    (uncached * (pricing.inputPerMillion || 0) +
      cached * (pricing.cachedInputPerMillion || 0) +
      output * (pricing.outputPerMillion || 0)) /
      1_000_000,
  );
}

/** 从显式分辨率档位或像素尺寸字符串推导生图计费档位（1k / 2k / 4k）。 */
export function inferResolutionTier(resolutionTier?: string, sizeStr?: string): "1k" | "2k" | "4k" | undefined {
  const tier = resolutionTier?.trim().toLowerCase();
  // Gemini 的 512 档位统一按 1k 档计费，避免落空回退 default
  if (tier === "512" || tier === "1k") return "1k";
  if (tier === "2k" || tier === "4k") return tier;
  if (sizeStr) {
    const match = sizeStr.trim().match(/^(\d+)\s*[xX×]\s*(\d+)$/);
    if (match) {
      const pixels = Number(match[1]) * Number(match[2]);
      if (pixels > 5_000_000) return "4k";
      if (pixels > 2_100_000) return "2k";
      return "1k";
    }
  }
  return undefined;
}

/** 按生成张数与分辨率档位计算生图模型预扣积分。 */
export function calculateImageCredits(
  pricing: ImageModelPricing,
  count: number,
  resolutionTier?: string,
  sizeStr?: string,
) {
  const qty = Math.max(1, Math.floor(count || 1));
  if (pricing.mode === "per_image") {
    return roundCredits((pricing.perImage ?? 0) * qty);
  }
  const tier = inferResolutionTier(resolutionTier, sizeStr);
  const unitPrice = (tier ? pricing.resolutionPrices?.[tier] : undefined) ?? pricing.resolutionPrices?.default ?? 0;
  return roundCredits(unitPrice * qty);
}

/** 按按秒或按次模式（含可选参考视频附加费）计算视频模型预扣积分。 */
export function calculateVideoCredits(
  pricing: VideoModelPricing,
  params: { seconds: number; hasReferenceVideo: boolean; referenceVideoSeconds?: number },
) {
  const duration = Math.max(1, params.seconds || 1);
  const base =
    pricing.mode === "per_second" ? (pricing.perSecond ?? 0) * duration : (pricing.perRequest ?? 0);
  let extra = 0;
  if (pricing.chargeReferenceVideo && params.hasReferenceVideo) {
    extra =
      pricing.referenceVideoMode === "per_second"
        ? (pricing.referenceVideoPrice ?? 0) * Math.max(1, params.referenceVideoSeconds || duration)
        : (pricing.referenceVideoPrice ?? 0);
  }
  return roundCredits(base + extra);
}

/** 按实际音频时长（秒）计算语音模型积分消耗。 */
export function calculateAudioCredits(pricing: AudioModelPricing, durationSeconds: number) {
  return roundCredits((pricing.perSecond ?? 0) * Math.max(0, durationSeconds));
}

/** 查询用户当前积分余额；首次访问时自动幂等初始化 0 余额钱包。 */
export async function getWalletBalance(userId: string): Promise<number> {
  const existing = await db.query.creditWallets.findFirst({ where: eq(creditWallets.userId, userId) });
  if (existing) return roundCredits(existing.balance);
  await db.insert(creditWallets).values({ userId, balance: 0 }).onConflictDoNothing();
  return 0;
}

export type AdjustCreditsParams = {
  userId: string;
  delta: number;
  reason: string;
  refId?: string;
  meta?: Record<string, unknown>;
  allowNegative?: boolean;
  /** 为 true 时即使积分变动为 0（如免费模型或极低消耗）也写入使用日志。 */
  forceLedger?: boolean;
};

export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function lockWalletBalance(tx: DbTransaction, userId: string) {
  await tx.insert(creditWallets).values({ userId, balance: 0 }).onConflictDoNothing();
  const rows = await tx.execute(
    sql`SELECT balance FROM credit_wallets WHERE user_id = ${userId} FOR UPDATE`,
  );
  return roundCredits(Number((rows[0] as { balance?: number } | undefined)?.balance ?? 0));
}

async function getReservedCredits(tx: DbTransaction, userId: string, excludeLedgerId?: string) {
  const excludeLedger = excludeLedgerId ? sql`AND id <> ${excludeLedgerId}` : sql``;
  const [row] = await tx.execute(sql`
    SELECT COALESCE(SUM(reserved_credits), 0) AS reserved
    FROM credit_ledger
    WHERE user_id = ${userId} AND reserved_credits > 0 AND reservation_expires_at > clock_timestamp() ${excludeLedger}
  `);
  return roundCredits(Number(row?.reserved ?? 0));
}

async function expireWalletReservations(tx: DbTransaction, userId: string) {
  await tx
    .update(creditLedger)
    .set({
      reservedCredits: 0,
      reservationExpiresAt: null,
      meta: sql`${creditLedger.meta} || '{"billingStatus":"reservation_expired","taskStatus":"failed"}'::jsonb`,
    })
    .where(
      and(
        eq(creditLedger.userId, userId),
        gt(creditLedger.reservedCredits, 0),
        sql`${creditLedger.reservationExpiresAt} <= clock_timestamp()`,
      ),
    );
}

/** 在现有数据库事务内原子扣减/增加用户积分并写入账本记录（使用行级锁 FOR UPDATE 防并发透支）。 */
export async function adjustWalletCreditsInTx(tx: DbTransaction, params: AdjustCreditsParams) {
  const delta = roundCredits(params.delta);
  const current = await lockWalletBalance(tx, params.userId);
  const nextBalance = roundCredits(current + delta);

  if (delta < 0) {
    const reserved = await getReservedCredits(tx, params.userId);
    if ((!params.allowNegative || reserved > 0) && nextBalance < reserved) {
      return { ok: false as const, balance: params.allowNegative ? current : Math.max(0, roundCredits(current - reserved)) };
    }
  }

  if (delta !== 0) {
    await tx
      .update(creditWallets)
      .set({ balance: nextBalance, updatedAt: new Date() })
      .where(eq(creditWallets.userId, params.userId));
  }

  const ledgerId = nanoid();
  if (delta !== 0 || params.forceLedger) {
    await tx.insert(creditLedger).values({
      id: ledgerId,
      userId: params.userId,
      delta,
      balanceAfter: nextBalance,
      reason: params.reason,
      refId: params.refId ?? null,
      meta: params.meta ?? {},
    });
  }

  return { ok: true as const, balance: nextBalance, ledgerId };
}

/** 在独立事务内变更用户积分并写入账本，变动非 0 时异步触发低余额邮件预警检查。 */
export async function adjustWalletCredits(params: AdjustCreditsParams) {
  const result = await db.transaction((tx) => adjustWalletCreditsInTx(tx, params));
  if (result.ok && params.delta !== 0) {
    scheduleWalletBalanceAlertCheck(params.userId, roundCredits(params.delta), result.balance);
  }
  return result;
}

/** 在现有数据库事务内原子将用户积分清零为 0，并在余额非 0 时写入一条管理员调整流水。 */
export async function clearWalletCreditsInTx(
  tx: DbTransaction,
  params: {
    userId: string;
    reason: string;
    meta?: Record<string, unknown>;
  },
) {
  const current = await lockWalletBalance(tx, params.userId);
  if (await getReservedCredits(tx, params.userId)) {
    return { ok: false as const, balance: current, delta: 0, ledgerId: "" };
  }
  if (current === 0) {
    return { ok: true as const, balance: 0, delta: 0, ledgerId: "" };
  }
  const delta = roundCredits(-current);
  const ledgerId = nanoid();
  await tx
    .update(creditWallets)
    .set({ balance: 0, updatedAt: new Date() })
    .where(eq(creditWallets.userId, params.userId));
  await tx.insert(creditLedger).values({
    id: ledgerId,
    userId: params.userId,
    delta,
    balanceAfter: 0,
    reason: params.reason,
    refId: null,
    meta: params.meta ?? {},
  });
  return { ok: true as const, balance: 0, delta, ledgerId };
}

/** 原子将用户积分清零为 0，并在余额非 0 时写入一条管理员调整流水。 */
export async function clearWalletCredits(params: {
  userId: string;
  reason: string;
  meta?: Record<string, unknown>;
}) {
  return db.transaction((tx) => clearWalletCreditsInTx(tx, params));
}

/** 回写指定账本记录的元数据字段（用于预扣后补充请求耗时与任务最终状态）。 */
export async function patchLedgerMeta(ledgerId: string, patch: Record<string, unknown>) {
  if (!ledgerId) return;
  await db
    .update(creditLedger)
    .set({ meta: sql`COALESCE(${creditLedger.meta}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(creditLedger.id, ledgerId));
}

/** 按上游视频任务 ID（meta.taskId）原子合并更新对应账本条目的元数据。 */
export async function patchLedgerMetaByTaskId(userId: string, taskId: string, patch: Record<string, unknown>) {
  if (!userId || !taskId) return;
  await db
    .update(creditLedger)
    .set({ meta: sql`COALESCE(${creditLedger.meta}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
    .where(and(eq(creditLedger.userId, userId), sql`${creditLedger.meta}->>'taskId' = ${taskId}`));
}

/** 付费文本、语音请求按预估金额全额锁定可用余额，不足时直接拒绝以防真流式阶段透支；免费请求只留下待结算记录。 */
export async function reserveProcessingLedger(params: {
  userId: string;
  reason: "text_gen" | "audio_gen";
  priced: boolean;
  reserveCredits?: number;
  expiresAt: Date;
  meta: Record<string, unknown>;
}) {
  return db.transaction(async (tx) => {
    const balance = await lockWalletBalance(tx, params.userId);
    await expireWalletReservations(tx, params.userId);
    const available = params.priced ? roundCredits(balance - (await getReservedCredits(tx, params.userId))) : 0;
    const requiredReserve = params.priced
      ? Math.max(0.0001, roundCredits(params.reserveCredits ?? available))
      : 0;
    if (params.priced && (available <= 0 || available < requiredReserve)) {
      return { ok: false as const, balance: Math.max(0, available), required: requiredReserve };
    }
    const reserved = params.priced ? requiredReserve : 0;
    const ledgerId = nanoid();
    await tx.insert(creditLedger).values({
      id: ledgerId,
      userId: params.userId,
      delta: 0,
      balanceAfter: balance,
      reservedCredits: reserved,
      reservationExpiresAt: params.expiresAt,
      reason: params.reason,
      meta: {
        ...params.meta,
        reservedCredits: reserved,
        billingStatus: reserved > 0 ? "reserved" : "pending",
      },
    });
    return { ok: true as const, balance, ledgerId };
  });
}

/** 钱包与预约账本在同一事务结算；超时预约自动释放，已结算或超时请求均不可再次扣款。 */
export async function settleProcessingLedger(params: {
  ledgerId: string;
  userId: string;
  credits: number;
  metaPatch: Record<string, unknown>;
}) {
  const charge = Math.max(0, roundCredits(params.credits));
  const settled = await db.transaction(async (tx) => {
    const current = await lockWalletBalance(tx, params.userId);
    const where = and(eq(creditLedger.id, params.ledgerId), eq(creditLedger.userId, params.userId));
    const [entry] = await tx.select({
      reservedCredits: creditLedger.reservedCredits,
      reservationExpiresAt: creditLedger.reservationExpiresAt,
      expired: sql<boolean>`${creditLedger.reservationExpiresAt} <= clock_timestamp()`,
      delta: creditLedger.delta,
      balanceAfter: creditLedger.balanceAfter,
      meta: creditLedger.meta,
    }).from(creditLedger).where(where).for("update");

    if (!entry) return { balance: current, chargedCredits: 0, uncollectedCredits: charge, applied: false };
    const previousMeta = entry.meta && typeof entry.meta === "object" ? entry.meta : {};
    const previousStatus = previousMeta.billingStatus;
    if (!entry.reservationExpiresAt) {
      if (!["settled", "released", "insufficient_balance", "reservation_expired"].includes(String(previousStatus))) {
        return { balance: current, chargedCredits: 0, uncollectedCredits: charge, applied: false };
      }
      return {
        balance: current,
        chargedCredits: roundCredits(Number(previousMeta.chargedCredits ?? Math.abs(Math.min(0, entry.delta)))),
        uncollectedCredits: roundCredits(Number(previousMeta.uncollectedCredits ?? 0)),
        applied: previousStatus !== "reservation_expired",
      };
    }
    const expired = Boolean(entry.expired);
    const available = Math.max(0, roundCredits(current - (await getReservedCredits(tx, params.userId, params.ledgerId))));
    const chargeable = available;
    const chargedCredits = Math.min(charge, chargeable);
    const uncollectedCredits = roundCredits(charge - chargedCredits);
    const nextBalance = chargedCredits > 0 ? roundCredits(current - chargedCredits) : current;
    if (chargedCredits > 0) {
      await tx
        .update(creditWallets)
        .set({ balance: nextBalance, updatedAt: new Date() })
        .where(eq(creditWallets.userId, params.userId));
    }
    const meta = {
      ...params.metaPatch,
      chargedCredits,
      ...(uncollectedCredits > 0 ? { uncollectedCredits } : {}),
      billingStatus: uncollectedCredits > 0
        ? "insufficient_balance"
        : chargedCredits > 0
          ? "settled"
          : "released",
      ...(expired ? { reservationExpired: true } : {}),
      ...(uncollectedCredits > 0 ? { taskStatus: "failed" } : {}),
    };
    await tx
      .update(creditLedger)
      .set({
        delta: -chargedCredits,
        balanceAfter: nextBalance,
        reservedCredits: 0,
        reservationExpiresAt: null,
        meta: sql`${creditLedger.meta} || ${JSON.stringify(meta)}::jsonb`,
      })
      .where(where);
    return { balance: nextBalance, chargedCredits, uncollectedCredits, applied: true };
  });
  if (settled.chargedCredits > 0) {
    scheduleWalletBalanceAlertCheck(params.userId, -settled.chargedCredits, settled.balance);
  }
  return settled;
}

/** 退回指定消费账本的预扣积分：将退回金额、状态与说明原地合并到原请求账本中（找不到原账本时兜底写入 refund）。 */
export async function refundLedgerCharge(params: {
  userId: string;
  ledgerId?: string;
  taskId?: string;
  refId?: string;
  refundAmount: number;
  markFailed?: boolean;
  metaPatch?: Record<string, unknown>;
}) {
  const amount = Math.max(0, roundCredits(params.refundAmount));
  if (amount <= 0) {
    const balance = await getWalletBalance(params.userId);
    return { balance, ledgerId: params.ledgerId ?? null };
  }

  return db.transaction(async (tx) => {
    await tx.insert(creditWallets).values({ userId: params.userId, balance: 0 }).onConflictDoNothing();
    const rows = await tx.execute(
      sql`SELECT balance FROM credit_wallets WHERE user_id = ${params.userId} FOR UPDATE`,
    );
    const current = roundCredits(Number((rows[0] as { balance?: number } | undefined)?.balance ?? 0));
    const lookupKey = params.taskId?.trim() || params.refId?.trim() || "";
    const existing = params.ledgerId
      ? await tx.query.creditLedger.findFirst({ where: eq(creditLedger.id, params.ledgerId) })
      : lookupKey
        ? await tx.query.creditLedger.findFirst({
            where: and(
              eq(creditLedger.userId, params.userId),
              inArray(creditLedger.reason, ["text_gen", "image_gen", "video_gen", "audio_gen"]),
              or(eq(creditLedger.refId, lookupKey), sql`${creditLedger.meta}->>'taskId' = ${lookupKey}`),
            ),
            orderBy: [desc(creditLedger.createdAt)],
          })
        : undefined;

    if (existing) {
      const prevMeta = (existing.meta && typeof existing.meta === "object" ? existing.meta : {}) as Record<string, unknown>;
      const prevCharged =
        typeof prevMeta.chargedCredits === "number" && Number.isFinite(prevMeta.chargedCredits)
          ? roundCredits(prevMeta.chargedCredits)
          : roundCredits(Math.abs(Math.min(0, existing.delta)));
      const prevRefunded =
        typeof prevMeta.refundedCredits === "number" && Number.isFinite(prevMeta.refundedCredits)
          ? roundCredits(prevMeta.refundedCredits)
          : 0;
      const remainingRefundable = Math.max(0, roundCredits(prevCharged - prevRefunded));
      const actualRefund = Math.min(amount, remainingRefundable);
      if (actualRefund <= 0) {
        return { balance: current, ledgerId: existing.id };
      }

      const nextBalance = roundCredits(current + actualRefund);
      await tx
        .update(creditWallets)
        .set({ balance: nextBalance, updatedAt: new Date() })
        .where(eq(creditWallets.userId, params.userId));

      const nextRefunded = roundCredits(prevRefunded + actualRefund);
      const nextDelta = params.markFailed ? 0 : roundCredits(existing.delta + actualRefund);
      const mergedMeta: Record<string, unknown> = {
        ...prevMeta,
        ...(params.metaPatch ?? {}),
        chargedCredits: prevCharged,
        refundedCredits: nextRefunded,
        refundedAt: new Date().toISOString(),
        ...(params.markFailed ? { taskStatus: "failed_refunded" } : {}),
      };

      await tx
        .update(creditLedger)
        .set({
          delta: nextDelta,
          balanceAfter: nextBalance,
          refId: existing.refId || params.refId || null,
          meta: mergedMeta,
        })
        .where(eq(creditLedger.id, existing.id));

      return { balance: nextBalance, ledgerId: existing.id };
    }

    const nextBalance = roundCredits(current + amount);
    await tx
      .update(creditWallets)
      .set({ balance: nextBalance, updatedAt: new Date() })
      .where(eq(creditWallets.userId, params.userId));

    const fallbackId = nanoid();
    await tx.insert(creditLedger).values({
      id: fallbackId,
      userId: params.userId,
      delta: amount,
      balanceAfter: nextBalance,
      reason: "refund",
      refId: params.refId ?? null,
      meta: {
        ...(params.metaPatch ?? {}),
        refundedCredits: amount,
        refundedAt: new Date().toISOString(),
        taskStatus: params.markFailed ? "failed_refunded" : "refunded",
      },
    });
    return { balance: nextBalance, ledgerId: fallbackId };
  });
}

/** 北京时间（UTC+8）固定偏移分钟数，统计与看板统一按北京时间划分，不依赖服务器时区。 */
export const BEIJING_OFFSET_MINUTES = 8 * 60;
const BEIJING_OFFSET_MS = BEIJING_OFFSET_MINUTES * 60_000;

/** 提取指定时刻在北京时间（UTC+8）下的年月日时与当日零点对应的 UTC Date。 */
export function getBeijingDateParts(date: Date) {
  const shifted = new Date(date.getTime() + BEIJING_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const day = shifted.getUTCDate();
  const hour = shifted.getUTCHours();
  const dayStart = new Date(Date.UTC(year, month, day, 0, 0, 0, 0) - BEIJING_OFFSET_MS);
  return { year, month, day, hour, dayStart };
}

/** 将 Date 格式化为北京时间 `YYYY-MM-DD` 日期键。 */
export function formatBeijingDayKey(date: Date) {
  const { year, month, day } = getBeijingDateParts(date);
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** 聚合指定周期（7/14/30 天）内的积分消耗总量、每日趋势与热门消耗模型排行（按北京时间统计）。 */
export async function queryConsumptionMetrics(daysInput: number, userId?: string) {
  const days = [7, 14, 30].includes(daysInput) ? daysInput : 7;
  const now = new Date();
  const { dayStart: todayStart } = getBeijingDateParts(now);
  const rangeStart = new Date(todayStart.getTime() - (days - 1) * 86_400_000);
  const todayStartIso = todayStart.toISOString();
  const rangeStartIso = rangeStart.toISOString();
  const userFilter = userId ? sql`AND user_id = ${userId}` : sql``;

  const [totalsRows, dailyRows, modelRows] = await Promise.all([
    db.execute(sql`
      SELECT
        COALESCE(SUM(CASE WHEN delta < 0 AND COALESCE(meta->>'taskStatus', '') NOT IN ('failed', 'failed_refunded') THEN -delta ELSE 0 END), 0)::double precision AS total_consumed,
        COALESCE(SUM(CASE WHEN created_at >= ${todayStartIso}::timestamptz AND delta < 0 AND COALESCE(meta->>'taskStatus', '') NOT IN ('failed', 'failed_refunded') THEN -delta ELSE 0 END), 0)::double precision AS today_consumed,
        COALESCE(SUM(CASE WHEN created_at >= ${rangeStartIso}::timestamptz AND delta < 0 AND COALESCE(meta->>'taskStatus', '') NOT IN ('failed', 'failed_refunded') THEN -delta ELSE 0 END), 0)::double precision AS range_consumed,
        COUNT(*) FILTER (WHERE created_at >= ${rangeStartIso}::timestamptz)::int AS range_calls
      FROM credit_ledger
      WHERE reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen') ${userFilter}
    `),
    db.execute(sql`
      SELECT
        TO_CHAR((created_at AT TIME ZONE 'UTC') + (${BEIJING_OFFSET_MINUTES} * INTERVAL '1 minute'), 'YYYY-MM-DD') AS day,
        COALESCE(SUM(CASE WHEN delta < 0 AND COALESCE(meta->>'taskStatus', '') NOT IN ('failed', 'failed_refunded') THEN -delta ELSE 0 END), 0)::double precision AS credits,
        COUNT(*)::int AS calls
      FROM credit_ledger
      WHERE reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen') AND created_at >= ${rangeStartIso}::timestamptz ${userFilter}
      GROUP BY 1
      ORDER BY 1 ASC
    `),
    db.execute(sql`
      SELECT
        COALESCE(NULLIF(meta->>'model', ''), reason) AS model,
        COALESCE(SUM(CASE WHEN delta < 0 AND COALESCE(meta->>'taskStatus', '') NOT IN ('failed', 'failed_refunded') THEN -delta ELSE 0 END), 0)::double precision AS credits,
        COUNT(*)::int AS calls
      FROM credit_ledger
      WHERE reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen') AND created_at >= ${rangeStartIso}::timestamptz ${userFilter}
      GROUP BY 1
      HAVING COUNT(*) > 0
      ORDER BY credits DESC, calls DESC
      LIMIT 8
    `),
  ]);

  const dailyMap = new Map<string, { credits: number; calls: number }>();
  for (const row of dailyRows as Array<{ day: string; credits: number; calls: number }>) {
    dailyMap.set(row.day, { credits: roundCredits(Number(row.credits)), calls: Number(row.calls) });
  }

  const dailyTrend: Array<{ date: string; credits: number; calls: number }> = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(rangeStart.getTime() + i * 86_400_000);
    const key = formatBeijingDayKey(d);
    const hit = dailyMap.get(key);
    dailyTrend.push({ date: key, credits: hit?.credits ?? 0, calls: hit?.calls ?? 0 });
  }

  const totalRow = (totalsRows[0] || {}) as {
    total_consumed?: number;
    today_consumed?: number;
    range_consumed?: number;
    range_calls?: number;
  };

  return {
    days,
    totalConsumedCredits: roundCredits(Number(totalRow.total_consumed ?? 0)),
    todayConsumedCredits: roundCredits(Number(totalRow.today_consumed ?? 0)),
    rangeConsumedCredits: roundCredits(Number(totalRow.range_consumed ?? 0)),
    rangeCalls: Number(totalRow.range_calls ?? 0),
    dailyTrend,
    topModels: (modelRows as Array<{ model: string; credits: number; calls: number }>).map((row) => ({
      model: row.model,
      credits: roundCredits(Number(row.credits)),
      calls: Number(row.calls),
    })),
  };
}

export const USAGE_LOG_REASONS = ["text_gen", "image_gen", "video_gen", "audio_gen"] as const;
export const WALLET_RECHARGE_REASONS = ["redeem_code", "admin_adjust", "plan_grant", "invite_rebate"] as const;

export type QueryCreditLedgerParams = {
  userId?: string;
  userQuery?: string;
  logId?: string;
  taskStatus?: string;
  category?: "usage" | "recharge";
  reason?: string;
  model?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  pageSize?: number;
};

/** 按用户、类型、状态、模型、日志 ID 与日期范围分页查询账本，并计算消耗量与 RPM 统计。 */
export async function queryCreditLedger(params: QueryCreditLedgerParams) {
  const page = Math.max(1, Number(params.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(params.pageSize || 20)));
  const offset = (page - 1) * pageSize;

  const filters: SQL[] = [];
  if (params.userId) {
    filters.push(eq(creditLedger.userId, params.userId));
  } else if (params.userQuery?.trim()) {
    const q = `%${params.userQuery.trim()}%`;
    const cond = or(ilike(users.username, q), ilike(users.displayName, q));
    if (cond) filters.push(cond);
  }

  const logId = params.logId?.trim() || "";
  if (logId) {
    filters.push(ilike(creditLedger.id, `%${logId}%`));
  }

  const reason = params.reason?.trim() || "";
  if (reason) {
    filters.push(eq(creditLedger.reason, reason));
  } else if (params.category === "usage") {
    filters.push(inArray(creditLedger.reason, [...USAGE_LOG_REASONS]));
  } else if (params.category === "recharge") {
    filters.push(inArray(creditLedger.reason, [...WALLET_RECHARGE_REASONS]));
  }

  const model = params.model?.trim() || "";
  if (model) {
    filters.push(sql`${creditLedger.meta}->>'model' ILIKE ${`%${model}%`}`);
  }

  const taskStatus = params.taskStatus?.trim() || "";
  if (taskStatus === "not_started" || taskStatus === "processing" || taskStatus === "failed" || taskStatus === "failed_refunded") {
    filters.push(sql`${creditLedger.meta}->>'taskStatus' = ${taskStatus}`);
  } else if (taskStatus === "refunded") {
    filters.push(
      sql`(${creditLedger.meta}->>'taskStatus' IN ('refunded', 'failed_refunded') OR COALESCE((${creditLedger.meta}->>'refundedCredits')::double precision, 0) > 0 OR (${creditLedger.meta}->>'taskStatus' IS NULL AND ${creditLedger.reason} = 'refund'))`,
    );
  } else if (taskStatus === "completed") {
    filters.push(
      sql`(${creditLedger.meta}->>'taskStatus' = 'completed' OR (${creditLedger.meta}->>'taskStatus' IS NULL AND ${creditLedger.reason} != 'refund'))`,
    );
  }

  const startDateRaw = params.startDate?.trim() || "";
  if (startDateRaw) {
    const start = new Date(startDateRaw);
    if (!Number.isNaN(start.getTime())) filters.push(gte(creditLedger.createdAt, start));
  }

  const endDateRaw = params.endDate?.trim() || "";
  if (endDateRaw) {
    const end = new Date(endDateRaw);
    if (!Number.isNaN(end.getTime())) filters.push(lte(creditLedger.createdAt, end));
  }

  const whereClause = filters.length ? and(...filters) : undefined;
  const totalConsumedExpr = sql<number>`COALESCE(SUM(CASE WHEN ${creditLedger.reason} IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen') AND ${creditLedger.delta} < 0 AND COALESCE(${creditLedger.meta}->>'taskStatus', '') NOT IN ('failed', 'failed_refunded') THEN -${creditLedger.delta} ELSE 0 END), 0)::double precision`;

  const [items, [{ total }], [summaryRow], peakRows] = await Promise.all([
    db
      .select({
        id: creditLedger.id,
        userId: creditLedger.userId,
        username: users.username,
        displayName: users.displayName,
        delta: creditLedger.delta,
        balanceAfter: creditLedger.balanceAfter,
        reason: creditLedger.reason,
        refId: creditLedger.refId,
        meta: creditLedger.meta,
        createdAt: creditLedger.createdAt,
      })
      .from(creditLedger)
      .leftJoin(users, eq(creditLedger.userId, users.id))
      .where(whereClause)
      .orderBy(desc(creditLedger.createdAt))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ total: count() })
      .from(creditLedger)
      .leftJoin(users, eq(creditLedger.userId, users.id))
      .where(whereClause),
    db
      .select({
        totalConsumed: totalConsumedExpr,
        totalRecharged: sql<number>`COALESCE(SUM(CASE WHEN ${creditLedger.reason} = 'invite_rebate' AND ${creditLedger.delta} < 0 THEN ${creditLedger.delta} WHEN ${creditLedger.delta} > 0 THEN ${creditLedger.delta} ELSE COALESCE((${creditLedger.meta}->>'refundedCredits')::double precision, 0) END), 0)::double precision`,
        // 统计调用次数与用量时同时包含 0 积分调用（免费模型或极低消耗四舍五入为 0 的请求）
        consumeCalls: sql<number>`COUNT(*) FILTER (WHERE ${creditLedger.reason} IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen'))::int`,
        totalInputTokens: sql<number>`COALESCE(SUM(CASE WHEN ${creditLedger.reason} IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen') THEN COALESCE((${creditLedger.meta}->>'inputTokens')::bigint, 0) ELSE 0 END), 0)::bigint`,
        totalCachedTokens: sql<number>`COALESCE(SUM(CASE WHEN ${creditLedger.reason} IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen') THEN COALESCE((${creditLedger.meta}->>'cachedInputTokens')::bigint, 0) ELSE 0 END), 0)::bigint`,
        totalOutputTokens: sql<number>`COALESCE(SUM(CASE WHEN ${creditLedger.reason} IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen') THEN COALESCE((${creditLedger.meta}->>'outputTokens')::bigint, 0) ELSE 0 END), 0)::bigint`,
        totalImages: sql<number>`COALESCE(SUM(CASE WHEN ${creditLedger.reason} = 'image_gen' THEN COALESCE((${creditLedger.meta}->>'count')::bigint, 1) ELSE 0 END), 0)::bigint`,
        totalMediaSeconds: sql<number>`COALESCE(SUM(CASE WHEN ${creditLedger.reason} IN ('video_gen', 'audio_gen') THEN COALESCE((${creditLedger.meta}->>'seconds')::double precision, (${creditLedger.meta}->>'durationSeconds')::double precision, 0) ELSE 0 END), 0)::double precision`,
        firstConsumeAt: sql<Date | string | null>`MIN(${creditLedger.createdAt}) FILTER (WHERE ${creditLedger.reason} IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen'))`,
        lastConsumeAt: sql<Date | string | null>`MAX(${creditLedger.createdAt}) FILTER (WHERE ${creditLedger.reason} IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen'))`,
        recentMinuteCalls: sql<number>`COUNT(*) FILTER (WHERE ${creditLedger.reason} IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen') AND ${creditLedger.createdAt} >= NOW() - INTERVAL '1 minute')::int`,
      })
      .from(creditLedger)
      .leftJoin(users, eq(creditLedger.userId, users.id))
      .where(whereClause),
    db
      .select({ cnt: count() })
      .from(creditLedger)
      .leftJoin(users, eq(creditLedger.userId, users.id))
      .where(
        whereClause
          ? and(whereClause, sql`${creditLedger.reason} IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen')`)
          : sql`${creditLedger.reason} IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen')`,
      )
      .groupBy(sql`DATE_TRUNC('minute', ${creditLedger.createdAt})`)
      .orderBy(desc(count()))
      .limit(1),
  ]);

  const consumeCalls = Number(summaryRow?.consumeCalls ?? 0);
  const totalInputTokens = Number(summaryRow?.totalInputTokens ?? 0);
  const totalCachedTokens = Number(summaryRow?.totalCachedTokens ?? 0);
  const totalOutputTokens = Number(summaryRow?.totalOutputTokens ?? 0);
  const totalTokens = totalInputTokens + totalOutputTokens;
  const totalImages = Number(summaryRow?.totalImages ?? 0);
  const totalMediaSeconds = Math.round(Number(summaryRow?.totalMediaSeconds ?? 0) * 100) / 100;
  const recentRpm = Number(summaryRow?.recentMinuteCalls ?? 0);
  const peakRpm = Number(peakRows[0]?.cnt ?? 0);

  let avgRpm = 0;
  if (consumeCalls > 0) {
    const parsedStart = startDateRaw ? new Date(startDateRaw).getTime() : Number.NaN;
    const parsedEnd = endDateRaw ? new Date(endDateRaw).getTime() : Number.NaN;
    const firstMs = summaryRow?.firstConsumeAt ? new Date(summaryRow.firstConsumeAt).getTime() : Date.now();
    const lastMs = summaryRow?.lastConsumeAt ? new Date(summaryRow.lastConsumeAt).getTime() : Date.now();
    const startMs = !Number.isNaN(parsedStart) ? parsedStart : firstMs;
    const endMs = !Number.isNaN(parsedEnd) ? Math.min(Date.now(), parsedEnd) : lastMs;
    const spanMinutes = Math.max(1, (endMs - startMs) / 60_000);
    avgRpm = Math.round((consumeCalls / spanMinutes) * 100) / 100;
  }

  return {
    items,
    total: Number(total),
    page,
    pageSize,
    summary: {
      totalConsumed: roundCredits(Number(summaryRow?.totalConsumed ?? 0)),
      totalRecharged: roundCredits(Number(summaryRow?.totalRecharged ?? 0)),
      recordCount: Number(total),
      consumeCalls,
      totalTokens,
      totalInputTokens,
      totalCachedTokens,
      totalOutputTokens,
      totalImages,
      totalMediaSeconds,
      avgRpm,
      peakRpm,
      recentRpm,
    },
  };
}
