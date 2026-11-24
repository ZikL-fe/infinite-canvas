/** 积分计费、钱包账本事务操作、消费趋势统计与多维度日志查询。 */
import { and, count, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
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

export function calculateAudioCredits(pricing: AudioModelPricing, durationSeconds: number) {
  return roundCredits((pricing.perSecond ?? 0) * Math.max(0, durationSeconds));
}

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

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 在现有数据库事务内原子扣减/增加用户积分并写入账本记录（使用行级锁 FOR UPDATE 防并发透支）。 */
export async function adjustWalletCreditsInTx(tx: DbTransaction, params: AdjustCreditsParams) {
  const delta = roundCredits(params.delta);
  await tx.insert(creditWallets).values({ userId: params.userId, balance: 0 }).onConflictDoNothing();
  const rows = await tx.execute(
    sql`SELECT balance FROM credit_wallets WHERE user_id = ${params.userId} FOR UPDATE`,
  );
  const current = roundCredits(Number((rows[0] as { balance?: number } | undefined)?.balance ?? 0));
  const nextBalance = roundCredits(current + delta);

  if (delta < 0 && !params.allowNegative && nextBalance < 0) {
    return { ok: false as const, balance: current };
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

export async function adjustWalletCredits(params: AdjustCreditsParams) {
  const result = await db.transaction((tx) => adjustWalletCreditsInTx(tx, params));
  if (result.ok && params.delta !== 0) {
    scheduleWalletBalanceAlertCheck(params.userId, roundCredits(params.delta), result.balance);
  }
  return result;
}

/** 回写指定账本记录的元数据字段（用于预扣后补充请求耗时与任务最终状态）。 */
export async function patchLedgerMeta(ledgerId: string, patch: Record<string, unknown>) {
  if (!ledgerId) return;
  await db
    .update(creditLedger)
    .set({ meta: sql`COALESCE(${creditLedger.meta}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(creditLedger.id, ledgerId));
}

export async function patchLedgerMetaByTaskId(userId: string, taskId: string, patch: Record<string, unknown>) {
  if (!userId || !taskId) return;
  await db
    .update(creditLedger)
    .set({ meta: sql`COALESCE(${creditLedger.meta}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
    .where(and(eq(creditLedger.userId, userId), sql`${creditLedger.meta}->>'taskId' = ${taskId}`));
}

/** 聚合指定周期（7/14/30 天）内的积分消耗总量、每日趋势与热门消耗模型排行。 */
export async function queryConsumptionMetrics(daysInput: number, userId?: string) {
  const days = [7, 14, 30].includes(daysInput) ? daysInput : 7;
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const rangeStart = new Date(todayStart.getTime() - (days - 1) * 86_400_000);
  const todayStartIso = todayStart.toISOString();
  const rangeStartIso = rangeStart.toISOString();
  const localOffsetMinutes = -now.getTimezoneOffset();
  const userFilter = userId ? sql`AND user_id = ${userId}` : sql``;

  const [totalsRows, dailyRows, modelRows] = await Promise.all([
    db.execute(sql`
      SELECT
        GREATEST(0, COALESCE(SUM(CASE WHEN delta < 0 THEN -delta WHEN reason = 'refund' THEN -delta ELSE 0 END), 0))::double precision AS total_consumed,
        GREATEST(0, COALESCE(SUM(CASE WHEN created_at >= ${todayStartIso}::timestamptz THEN (CASE WHEN delta < 0 THEN -delta WHEN reason = 'refund' THEN -delta ELSE 0 END) ELSE 0 END), 0))::double precision AS today_consumed,
        GREATEST(0, COALESCE(SUM(CASE WHEN created_at >= ${rangeStartIso}::timestamptz THEN (CASE WHEN delta < 0 THEN -delta WHEN reason = 'refund' THEN -delta ELSE 0 END) ELSE 0 END), 0))::double precision AS range_consumed,
        COUNT(*) FILTER (WHERE reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen') AND created_at >= ${rangeStartIso}::timestamptz)::int AS range_calls
      FROM credit_ledger
      WHERE 1 = 1 ${userFilter}
    `),
    db.execute(sql`
      SELECT
        TO_CHAR((created_at AT TIME ZONE 'UTC') + (${localOffsetMinutes} * INTERVAL '1 minute'), 'YYYY-MM-DD') AS day,
        GREATEST(0, COALESCE(SUM(-delta), 0))::double precision AS credits,
        COUNT(*) FILTER (WHERE reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen'))::int AS calls
      FROM credit_ledger
      WHERE reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen', 'refund') AND created_at >= ${rangeStartIso}::timestamptz ${userFilter}
      GROUP BY 1
      ORDER BY 1 ASC
    `),
    db.execute(sql`
      SELECT
        COALESCE(NULLIF(meta->>'model', ''), reason) AS model,
        GREATEST(0, COALESCE(SUM(-delta), 0))::double precision AS credits,
        COUNT(*) FILTER (WHERE reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen'))::int AS calls
      FROM credit_ledger
      WHERE reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen', 'refund') AND created_at >= ${rangeStartIso}::timestamptz ${userFilter}
      GROUP BY 1
      HAVING COUNT(*) FILTER (WHERE reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen')) > 0
      ORDER BY credits DESC, calls DESC
      LIMIT 8
    `),
  ]);

  const dailyMap = new Map<string, { credits: number; calls: number }>();
  for (const row of dailyRows as Array<{ day: string; credits: number; calls: number }>) {
    dailyMap.set(row.day, { credits: roundCredits(Number(row.credits)), calls: Number(row.calls) });
  }

  const formatLocalDayKey = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  const dailyTrend: Array<{ date: string; credits: number; calls: number }> = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(rangeStart.getTime() + i * 86_400_000);
    const key = formatLocalDayKey(d);
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

export const USAGE_LOG_REASONS = ["text_gen", "image_gen", "video_gen", "audio_gen", "refund"] as const;
export const WALLET_RECHARGE_REASONS = ["redeem_code", "admin_adjust", "plan_grant"] as const;

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
  if (taskStatus === "not_started" || taskStatus === "processing" || taskStatus === "failed") {
    filters.push(sql`${creditLedger.meta}->>'taskStatus' = ${taskStatus}`);
  } else if (taskStatus === "refunded") {
    filters.push(
      sql`(${creditLedger.meta}->>'taskStatus' = 'refunded' OR (${creditLedger.meta}->>'taskStatus' IS NULL AND ${creditLedger.reason} = 'refund'))`,
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
  const excludesRefundRows = Boolean((reason && reason !== "refund") || (taskStatus && taskStatus !== "refunded"));
  const totalConsumedExpr = excludesRefundRows
    ? sql<number>`COALESCE(SUM(CASE WHEN ${creditLedger.delta} < 0 AND COALESCE(${creditLedger.meta}->>'taskStatus', '') != 'failed' THEN -${creditLedger.delta} ELSE 0 END), 0)::double precision`
    : sql<number>`GREATEST(0, COALESCE(SUM(CASE WHEN ${creditLedger.delta} < 0 THEN -${creditLedger.delta} WHEN ${creditLedger.reason} = 'refund' THEN -${creditLedger.delta} ELSE 0 END), 0))::double precision`;

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
        totalRecharged: sql<number>`COALESCE(SUM(CASE WHEN ${creditLedger.delta} > 0 THEN ${creditLedger.delta} ELSE 0 END), 0)::double precision`,
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
