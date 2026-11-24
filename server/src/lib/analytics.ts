/** 数据看板聚合适配、采样快照缓存与使用日志定期清理。 */
import { sql } from "drizzle-orm";

import { db } from "../db/index.ts";
import { roundCredits } from "./billing.ts";
import { getPlatformAnalyticsPolicy } from "./settings.ts";

export type DashboardRange = "today" | "24h" | "7d" | "30d";

export type AnalyticsDashboardPayload = {
  range: DashboardRange;
  sampledAt: string;
  sampleIntervalMinutes: number;
  bucketUnit: "hour" | "day";
  summary: {
    totalCalls: number;
    totalConsumedCredits: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    avgRpm: number;
    avgTpm: number;
    successRate: number;
    avgLatencyMs: number;
    avgTokensPerSecond: number;
  };
  modelHealth: Array<{
    model: string;
    calls: number;
    successRate: number;
  }>;
  buckets: string[];
  models: string[];
  modelCreditSeries: Array<{ model: string; data: number[] }>;
  modelCallSeries: Array<{ model: string; data: number[] }>;
  modelRanking: Array<{ model: string; calls: number; credits: number; successRate: number }>;
  userRanking?: Array<{
    userId: string;
    username: string;
    displayName: string;
    email: string | null;
    credits: number;
    calls: number;
  }>;
  userTrendSeries?: Array<{
    userId: string;
    label: string;
    data: number[];
  }>;
};

type CachedDashboardEntry = {
  payload: AnalyticsDashboardPayload;
  expiresAt: number;
};

const dashboardCache = new Map<string, CachedDashboardEntry>();
const dashboardInFlight = new Map<string, Promise<AnalyticsDashboardPayload>>();

export function invalidateAnalyticsCache() {
  dashboardCache.clear();
  dashboardInFlight.clear();
}

export function normalizeDashboardRange(raw?: string): DashboardRange {
  if (raw === "today" || raw === "24h" || raw === "7d" || raw === "30d") return raw;
  return "24h";
}

function buildTimeBuckets(range: DashboardRange, now: Date) {
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const fmtHourKey = (d: Date) =>
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:00`;
  const fmtHourLabel = (d: Date) => `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:00`;
  const fmtDayKey = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const fmtDayLabel = (d: Date) => `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  const keys: string[] = [];
  const labels: string[] = [];

  if (range === "today") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const currentHour = now.getHours();
    for (let h = 0; h <= currentHour; h += 1) {
      const d = new Date(start.getTime() + h * 3_600_000);
      keys.push(fmtHourKey(d));
      labels.push(fmtHourLabel(d));
    }
    const spanMinutes = Math.max(1, Math.round((now.getTime() - start.getTime()) / 60_000));
    return {
      bucketUnit: "hour" as const,
      pgFormat: "YYYY-MM-DD HH24:00",
      rangeStart: start,
      spanMinutes,
      keys,
      labels,
    };
  }

  if (range === "24h") {
    const endHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0, 0);
    const start = new Date(endHour.getTime() - 23 * 3_600_000);
    for (let i = 0; i < 24; i += 1) {
      const d = new Date(start.getTime() + i * 3_600_000);
      keys.push(fmtHourKey(d));
      labels.push(fmtHourLabel(d));
    }
    return {
      bucketUnit: "hour" as const,
      pgFormat: "YYYY-MM-DD HH24:00",
      rangeStart: new Date(now.getTime() - 24 * 3_600_000),
      spanMinutes: 24 * 60,
      keys,
      labels,
    };
  }

  const days = range === "30d" ? 30 : 7;
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const start = new Date(todayStart.getTime() - (days - 1) * 86_400_000);
  for (let i = 0; i < days; i += 1) {
    const d = new Date(start.getTime() + i * 86_400_000);
    keys.push(fmtDayKey(d));
    labels.push(fmtDayLabel(d));
  }
  const spanMinutes = Math.max(1, Math.round((now.getTime() - start.getTime()) / 60_000));
  return {
    bucketUnit: "day" as const,
    pgFormat: "YYYY-MM-DD",
    rangeStart: start,
    spanMinutes,
    keys,
    labels,
  };
}

async function computeDashboardSnapshot(range: DashboardRange, sampleIntervalMinutes: number, userId?: string): Promise<AnalyticsDashboardPayload> {
  const now = new Date();
  const { bucketUnit, pgFormat, rangeStart, spanMinutes, keys, labels } = buildTimeBuckets(range, now);
  const rangeStartIso = rangeStart.toISOString();
  const localOffsetMinutes = -now.getTimezoneOffset();
  const userFilter = userId ? sql`AND cl.user_id = ${userId}` : sql``;

  const [summaryRows, modelSummaryRows, modelBucketRows, userRankRows] = await Promise.all([
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE cl.reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen'))::int AS total_calls,
        COUNT(*) FILTER (WHERE cl.reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen') AND COALESCE(cl.meta->>'taskStatus', '') IN ('failed', 'failed_refunded'))::int AS failed_calls,
        COALESCE(SUM(CASE WHEN cl.delta < 0 AND COALESCE(cl.meta->>'taskStatus', '') NOT IN ('failed', 'failed_refunded') THEN -cl.delta ELSE 0 END), 0)::double precision AS net_credits,
        COALESCE(SUM(CASE WHEN cl.reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen') THEN COALESCE((cl.meta->>'inputTokens')::double precision, 0) ELSE 0 END), 0)::double precision AS input_tokens,
        COALESCE(SUM(CASE WHEN cl.reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen') THEN COALESCE((cl.meta->>'outputTokens')::double precision, 0) ELSE 0 END), 0)::double precision AS output_tokens,
        COALESCE(SUM(CASE WHEN cl.reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen') THEN COALESCE((cl.meta->>'cachedInputTokens')::double precision, 0) ELSE 0 END), 0)::double precision AS cached_tokens,
        COALESCE(AVG(CASE WHEN cl.reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen') AND COALESCE((cl.meta->>'durationMs')::double precision, 0) > 0 THEN (cl.meta->>'durationMs')::double precision END), 0)::double precision AS avg_latency_ms,
        COALESCE(AVG(CASE WHEN cl.reason = 'text_gen' AND COALESCE((cl.meta->>'tokensPerSecond')::double precision, 0) > 0 THEN (cl.meta->>'tokensPerSecond')::double precision END), 0)::double precision AS avg_tps
      FROM credit_ledger cl
      WHERE cl.reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen')
        AND cl.created_at >= ${rangeStartIso}::timestamptz
        ${userFilter}
    `),
    db.execute(sql`
      SELECT
        COALESCE(NULLIF(cl.meta->>'model', ''), cl.reason) AS model,
        COUNT(*) FILTER (WHERE cl.reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen'))::int AS calls,
        COUNT(*) FILTER (WHERE cl.reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen') AND COALESCE(cl.meta->>'taskStatus', '') IN ('failed', 'failed_refunded'))::int AS failed_calls,
        COALESCE(SUM(CASE WHEN cl.delta < 0 AND COALESCE(cl.meta->>'taskStatus', '') NOT IN ('failed', 'failed_refunded') THEN -cl.delta ELSE 0 END), 0)::double precision AS credits
      FROM credit_ledger cl
      WHERE cl.reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen')
        AND cl.created_at >= ${rangeStartIso}::timestamptz
        ${userFilter}
      GROUP BY 1
      HAVING COUNT(*) FILTER (WHERE cl.reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen')) > 0
      ORDER BY credits DESC, calls DESC
      LIMIT 15
    `),
    db.execute(sql`
      SELECT
        TO_CHAR((cl.created_at AT TIME ZONE 'UTC') + (${localOffsetMinutes} * INTERVAL '1 minute'), ${pgFormat}) AS bucket,
        COALESCE(NULLIF(cl.meta->>'model', ''), cl.reason) AS model,
        COALESCE(SUM(CASE WHEN cl.delta < 0 AND COALESCE(cl.meta->>'taskStatus', '') NOT IN ('failed', 'failed_refunded') THEN -cl.delta ELSE 0 END), 0)::double precision AS credits,
        COUNT(*) FILTER (WHERE cl.reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen'))::int AS calls
      FROM credit_ledger cl
      WHERE cl.reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen')
        AND cl.created_at >= ${rangeStartIso}::timestamptz
        ${userFilter}
      GROUP BY 1, 2
    `),
    userId
      ? Promise.resolve([])
      : db.execute(sql`
          SELECT
            cl.user_id,
            u.username,
            u.display_name,
            u.email,
            COALESCE(SUM(CASE WHEN cl.delta < 0 AND COALESCE(cl.meta->>'taskStatus', '') NOT IN ('failed', 'failed_refunded') THEN -cl.delta ELSE 0 END), 0)::double precision AS credits,
            COUNT(*) FILTER (WHERE cl.reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen'))::int AS calls
          FROM credit_ledger cl
          INNER JOIN users u ON u.id = cl.user_id
          WHERE cl.reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen')
            AND cl.created_at >= ${rangeStartIso}::timestamptz
          GROUP BY cl.user_id, u.username, u.display_name, u.email
          HAVING COUNT(*) FILTER (WHERE cl.reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen')) > 0
          ORDER BY credits DESC, calls DESC
          LIMIT 10
        `),
  ]);

  const sRow = (summaryRows[0] || {}) as Record<string, unknown>;
  const totalCalls = Number(sRow.total_calls ?? 0);
  const failedCalls = Number(sRow.failed_calls ?? 0);
  const successRate = totalCalls > 0 ? Math.round(((totalCalls - failedCalls) / totalCalls) * 10000) / 100 : 100;
  const inputTokens = Math.round(Number(sRow.input_tokens ?? 0));
  const outputTokens = Math.round(Number(sRow.output_tokens ?? 0));
  const cachedInputTokens = Math.round(Number(sRow.cached_tokens ?? 0));
  const totalTokens = inputTokens + outputTokens;

  const modelRanking = (modelSummaryRows as Array<Record<string, unknown>>).map((row) => {
    const calls = Number(row.calls ?? 0);
    const failed = Number(row.failed_calls ?? 0);
    return {
      model: String(row.model || "unknown"),
      calls,
      credits: roundCredits(Number(row.credits ?? 0)),
      successRate: calls > 0 ? Math.round(((calls - failed) / calls) * 10000) / 100 : 100,
    };
  });

  const selectedModels = modelRanking.slice(0, 12).map((item) => item.model);
  const bucketIndexMap = new Map(keys.map((k, idx) => [k, idx]));

  const creditMatrix = new Map<string, number[]>(selectedModels.map((m) => [m, new Array(keys.length).fill(0)]));
  const callMatrix = new Map<string, number[]>(selectedModels.map((m) => [m, new Array(keys.length).fill(0)]));
  for (const row of modelBucketRows as Array<Record<string, unknown>>) {
    const bucketIdx = bucketIndexMap.get(String(row.bucket || ""));
    const model = String(row.model || "");
    if (bucketIdx === undefined || !creditMatrix.has(model)) continue;
    creditMatrix.get(model)![bucketIdx] = roundCredits(Number(row.credits ?? 0));
    callMatrix.get(model)![bucketIdx] = Number(row.calls ?? 0);
  }

  let userRanking: AnalyticsDashboardPayload["userRanking"];
  let userTrendSeries: AnalyticsDashboardPayload["userTrendSeries"];

  if (!userId) {
    const rankedUsers = (userRankRows as Array<Record<string, unknown>>).map((row) => ({
      userId: String(row.user_id),
      username: String(row.username || ""),
      displayName: String(row.display_name || ""),
      email: typeof row.email === "string" && row.email ? row.email : null,
      credits: roundCredits(Number(row.credits ?? 0)),
      calls: Number(row.calls ?? 0),
    }));
    userRanking = rankedUsers;

    if (rankedUsers.length > 0) {
      const topIds = rankedUsers.map((item) => item.userId);
      const userBucketRows = await db.execute(sql`
        SELECT
          cl.user_id,
          TO_CHAR((cl.created_at AT TIME ZONE 'UTC') + (${localOffsetMinutes} * INTERVAL '1 minute'), ${pgFormat}) AS bucket,
          COALESCE(SUM(CASE WHEN cl.delta < 0 AND COALESCE(cl.meta->>'taskStatus', '') NOT IN ('failed', 'failed_refunded') THEN -cl.delta ELSE 0 END), 0)::double precision AS credits
        FROM credit_ledger cl
        WHERE cl.reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen')
          AND cl.created_at >= ${rangeStartIso}::timestamptz
          AND cl.user_id IN (${sql.join(
            topIds.map((id) => sql`${id}`),
            sql`, `,
          )})
        GROUP BY 1, 2
      `);

      const userMatrix = new Map<string, number[]>(topIds.map((id) => [id, new Array(keys.length).fill(0)]));
      for (const row of userBucketRows as Array<Record<string, unknown>>) {
        const uid = String(row.user_id || "");
        const bucketIdx = bucketIndexMap.get(String(row.bucket || ""));
        if (bucketIdx === undefined || !userMatrix.has(uid)) continue;
        userMatrix.get(uid)![bucketIdx] = roundCredits(Number(row.credits ?? 0));
      }

      userTrendSeries = rankedUsers.map((u) => ({
        userId: u.userId,
        label: u.displayName && u.displayName !== u.username ? `${u.displayName} (@${u.username})` : u.username,
        data: userMatrix.get(u.userId) ?? new Array(keys.length).fill(0),
      }));
    } else {
      userTrendSeries = [];
    }
  }

  return {
    range,
    sampledAt: now.toISOString(),
    sampleIntervalMinutes,
    bucketUnit,
    summary: {
      totalCalls,
      totalConsumedCredits: roundCredits(Number(sRow.net_credits ?? 0)),
      totalTokens,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      avgRpm: Math.round((totalCalls / spanMinutes) * 100) / 100,
      avgTpm: Math.round((totalTokens / spanMinutes) * 10) / 10,
      successRate,
      avgLatencyMs: Math.round(Number(sRow.avg_latency_ms ?? 0)),
      avgTokensPerSecond: Math.round(Number(sRow.avg_tps ?? 0) * 10) / 10,
    },
    modelHealth: modelRanking.slice(0, 8).map((item) => ({
      model: item.model,
      calls: item.calls,
      successRate: item.successRate,
    })),
    buckets: labels,
    models: selectedModels,
    modelCreditSeries: selectedModels.map((model) => ({ model, data: creditMatrix.get(model)! })),
    modelCallSeries: selectedModels.map((model) => ({ model, data: callMatrix.get(model)! })),
    modelRanking,
    ...(userRanking !== undefined ? { userRanking } : {}),
    ...(userTrendSeries !== undefined ? { userTrendSeries } : {}),
  };
}

export async function queryAnalyticsDashboard(params: {
  range: DashboardRange;
  userId?: string;
  force?: boolean;
}): Promise<AnalyticsDashboardPayload> {
  const policy = await getPlatformAnalyticsPolicy();
  const ttlMs = policy.sampleIntervalMinutes * 60_000;
  const cacheKey = `${params.userId || "all"}:${params.range}`;
  const nowMs = Date.now();
  const cached = dashboardCache.get(cacheKey);
  if (!params.force && cached && cached.expiresAt > nowMs) {
    return cached.payload;
  }

  const inFlight = dashboardInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const task = computeDashboardSnapshot(params.range, policy.sampleIntervalMinutes, params.userId)
    .then((payload) => {
      dashboardCache.set(cacheKey, {
        payload,
        expiresAt: Date.now() + ttlMs,
      });
      return payload;
    })
    .catch((error) => {
      if (cached) {
        console.warn("[analytics] 采样查询失败，回退旧快照:", error);
        return cached.payload;
      }
      throw error;
    })
    .finally(() => {
      dashboardInFlight.delete(cacheKey);
    });

  dashboardInFlight.set(cacheKey, task);
  return task;
}

/** 清理超过保留天数的 AI 调用日志（严格保留充值与管理员调账记录）。 */
export async function cleanupExpiredUsageLogs(retentionDaysOverride?: number) {
  const policy = await getPlatformAnalyticsPolicy();
  const retentionDays = retentionDaysOverride ?? policy.logRetentionDays;
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    return { retentionDays: 0, deletedCount: 0 };
  }
  const cutoffIso = new Date(Date.now() - Math.floor(retentionDays) * 86_400_000).toISOString();
  const deletedRows = await db.execute(sql`
    DELETE FROM credit_ledger
    WHERE created_at < ${cutoffIso}::timestamptz
      AND reason IN ('text_gen', 'image_gen', 'video_gen', 'audio_gen', 'refund')
    RETURNING id
  `);
  invalidateAnalyticsCache();
  return { retentionDays: Math.floor(retentionDays), deletedCount: deletedRows.length };
}

let retentionTimer: ReturnType<typeof setInterval> | null = null;
const RETENTION_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function startLogRetentionScheduler() {
  if (retentionTimer) return;
  const run = async () => {
    try {
      const result = await cleanupExpiredUsageLogs();
      if (result.deletedCount > 0) {
        console.info(`[analytics] 自动清理过期使用日志：保留 ${result.retentionDays} 天，共删除 ${result.deletedCount} 条`);
      }
    } catch (error) {
      console.warn("[analytics] 自动清理过期使用日志失败:", error);
    }
  };
  setTimeout(() => void run(), 45_000);
  retentionTimer = setInterval(() => void run(), RETENTION_CHECK_INTERVAL_MS);
}
