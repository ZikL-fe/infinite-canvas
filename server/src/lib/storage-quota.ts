/** 云端存储配额聚合与独立存储资源包有效期解析模块。 */
import { desc, eq, inArray } from "drizzle-orm";

import { db, userStorageGrants, type StorageGrantSource, type StorageGrantStatus } from "../db/index.ts";
import { getPlatformMailConfig, getPlatformStorageExpiryPolicy } from "./settings.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

type DbExecutor = Pick<typeof db, "select" | "query">;

export type UserBaseQuotaInput = {
  id: string;
  storageQuotaBytes: number;
  storageQuotaExpiresAt: Date | null;
};

export type StorageGrantRow = {
  id: string;
  userId: string;
  quotaBytes: number;
  durationDays: number | null;
  expiresAt: Date | null;
  source: StorageGrantSource;
  refId: string | null;
  codeId: string | null;
  note: string;
  status: StorageGrantStatus;
  createdAt: Date;
};

export type StorageQuotaSummary = {
  storageQuotaBytes: number;
  storageQuotaExpiresAt: Date | null;
  baseStorageQuotaBytes: number;
  baseStorageQuotaExpiresAt: Date | null;
  storageGrantsQuotaBytes: number;
  activeGrantCount: number;
};

export function resolveEffectiveStorageQuota(
  baseQuotaBytesInput: number,
  baseExpiresAtInput: Date | null | undefined,
  grants: Array<Pick<StorageGrantRow, "quotaBytes" | "expiresAt" | "status">>,
  now = new Date(),
): StorageQuotaSummary {
  const nowMs = now.getTime();
  const baseQuotaBytes = Math.max(0, Number(baseQuotaBytesInput || 0));
  const baseExpiresAt = baseExpiresAtInput ? new Date(baseExpiresAtInput) : null;
  const baseExpired = Boolean(baseExpiresAt && baseExpiresAt.getTime() <= nowMs);
  const baseActiveBytes = baseQuotaBytes > 0 && !baseExpired ? baseQuotaBytes : 0;

  let grantsActiveBytes = 0;
  let activeGrantCount = 0;
  let hasPermanentActive = baseActiveBytes > 0 && !baseExpiresAt;
  let latestActiveExpiresAt: Date | null = baseActiveBytes > 0 && baseExpiresAt ? baseExpiresAt : null;
  let latestExpiredAt: Date | null = baseQuotaBytes > 0 && baseExpired && baseExpiresAt ? baseExpiresAt : null;

  for (const grant of grants) {
    const bytes = Math.max(0, Number(grant.quotaBytes || 0));
    if (grant.status !== "active" || bytes <= 0) continue;
    const exp = grant.expiresAt ? new Date(grant.expiresAt) : null;
    if (exp && exp.getTime() <= nowMs) {
      if (!latestExpiredAt || exp.getTime() > latestExpiredAt.getTime()) {
        latestExpiredAt = exp;
      }
      continue;
    }
    grantsActiveBytes += bytes;
    activeGrantCount += 1;
    if (!exp) {
      hasPermanentActive = true;
    } else if (!latestActiveExpiresAt || exp.getTime() > latestActiveExpiresAt.getTime()) {
      latestActiveExpiresAt = exp;
    }
  }

  const storageQuotaBytes = baseActiveBytes + grantsActiveBytes;
  const storageQuotaExpiresAt =
    storageQuotaBytes > 0 ? (hasPermanentActive ? null : latestActiveExpiresAt) : latestExpiredAt;

  return {
    storageQuotaBytes,
    storageQuotaExpiresAt,
    baseStorageQuotaBytes: baseQuotaBytes,
    baseStorageQuotaExpiresAt: baseExpiresAt,
    storageGrantsQuotaBytes: grantsActiveBytes,
    activeGrantCount,
  };
}

export function serializeStorageGrant(grant: StorageGrantRow, nowMs = Date.now()) {
  const expMs = grant.expiresAt ? new Date(grant.expiresAt).getTime() : null;
  const isExpired = Boolean(expMs !== null && expMs <= nowMs);
  const isEffective = grant.status === "active" && grant.quotaBytes > 0 && !isExpired;
  return {
    id: grant.id,
    quotaBytes: grant.quotaBytes,
    durationDays: grant.durationDays,
    expiresAt: grant.expiresAt ? new Date(grant.expiresAt).toISOString() : null,
    source: grant.source,
    refId: grant.refId,
    note: grant.note,
    status: grant.status,
    isExpired,
    isEffective,
    createdAt: new Date(grant.createdAt).toISOString(),
  };
}

export async function getUserStorageQuotaSummary(userRow: UserBaseQuotaInput, executor: DbExecutor = db) {
  const grants = await executor.query.userStorageGrants.findMany({
    where: eq(userStorageGrants.userId, userRow.id),
    orderBy: [desc(userStorageGrants.createdAt)],
  });
  const summary = resolveEffectiveStorageQuota(userRow.storageQuotaBytes, userRow.storageQuotaExpiresAt, grants);
  return {
    ...summary,
    grants,
  };
}

/** 查找预警窗口内最早即将到期且到期后会导致超额的时间点（兼容永久配额+限时资源包组合）。 */
export function getEarliestPreExpiryWarningTimestamp(
  baseQuotaBytes: number,
  baseExpiresAt: Date | null | undefined,
  grants: Array<Pick<StorageGrantRow, "quotaBytes" | "expiresAt" | "status">>,
  usedBytes: number,
  nowMs: number,
  warnWindowMs: number,
): Date | null {
  if (warnWindowMs <= 0) return null;
  const windowEnd = nowMs + warnWindowMs;
  const candidates: Date[] = [];

  if ((baseQuotaBytes ?? 0) > 0 && baseExpiresAt) {
    const ms = baseExpiresAt.getTime();
    if (ms > nowMs && ms <= windowEnd) candidates.push(baseExpiresAt);
  }
  for (const grant of grants) {
    if (grant.status !== "active" || (grant.quotaBytes ?? 0) <= 0 || !grant.expiresAt) continue;
    const ms = grant.expiresAt.getTime();
    if (ms > nowMs && ms <= windowEnd) candidates.push(grant.expiresAt);
  }
  if (!candidates.length) return null;

  candidates.sort((a, b) => a.getTime() - b.getTime());
  for (const candidate of candidates) {
    const afterExpiry = resolveEffectiveStorageQuota(baseQuotaBytes, baseExpiresAt, grants, candidate);
    if (afterExpiry.storageQuotaBytes <= 0 || usedBytes > afterExpiry.storageQuotaBytes) {
      return candidate;
    }
  }
  return null;
}

/** 聚合当前用户的低积分阈值与云存储即将到期预警时间，供前端统一提示。 */
export async function getUserQuotaAlertMeta(input: {
  lowBalanceThreshold?: number | null;
  storageUsedBytes: number;
  baseStorageQuotaBytes: number;
  baseStorageQuotaExpiresAt: Date | null;
  grants: Array<Pick<StorageGrantRow, "quotaBytes" | "expiresAt" | "status">>;
}) {
  const [mailConfig, expiryPolicy] = await Promise.all([
    getPlatformMailConfig(),
    getPlatformStorageExpiryPolicy(),
  ]);
  const storageWarningDays = expiryPolicy.preExpiryWarnDays;
  const storageExpiringAt = getEarliestPreExpiryWarningTimestamp(
    input.baseStorageQuotaBytes,
    input.baseStorageQuotaExpiresAt,
    input.grants,
    input.storageUsedBytes,
    Date.now(),
    storageWarningDays * DAY_MS,
  );
  return {
    lowBalanceThreshold: input.lowBalanceThreshold ?? mailConfig.lowBalanceThreshold,
    storageWarningDays,
    storageExpiringAt: storageExpiringAt ? storageExpiringAt.toISOString() : null,
  };
}

export async function getUsersStorageQuotaMap(userRows: UserBaseQuotaInput[], executor: DbExecutor = db) {
  const result = new Map<string, StorageQuotaSummary>();
  if (!userRows.length) return result;

  const userIds = Array.from(new Set(userRows.map((row) => row.id)));
  const grantRows = await executor.query.userStorageGrants.findMany({
    where: inArray(userStorageGrants.userId, userIds),
  });

  const grantsByUser = new Map<string, StorageGrantRow[]>();
  for (const grant of grantRows) {
    const list = grantsByUser.get(grant.userId);
    if (list) list.push(grant);
    else grantsByUser.set(grant.userId, [grant]);
  }

  const now = new Date();
  for (const row of userRows) {
    const summary = resolveEffectiveStorageQuota(
      row.storageQuotaBytes,
      row.storageQuotaExpiresAt,
      grantsByUser.get(row.id) || [],
      now,
    );
    result.set(row.id, summary);
  }
  return result;
}
