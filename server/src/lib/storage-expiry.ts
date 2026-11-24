/** 云存储配额到期预警、宽限期通知与逾期自动清理调度服务。 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { canvasProjects, db, mediaObjects, userAssets, userStorageGrants, users, workbenchLogs } from "../db/index.ts";
import { isMailConfigReady, sendStorageCleanedEmail, sendStorageExpiredNoticeEmail, sendStoragePreExpiryEmail } from "./mail.ts";
import { deleteS3Object } from "./s3.ts";
import { getPlatformMailConfig, getPlatformStorageExpiryPolicy, getS3StorageConfig, type PlatformStorageExpiryPolicy } from "./settings.ts";
import { resolveEffectiveStorageQuota } from "./storage-quota.ts";

export const STORAGE_EXPIRY_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
export const STORAGE_EXPIRY_BATCH_LIMIT = 50;
const INITIAL_SWEEP_DELAY_MS = 30 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type StorageExpiryActionKind = "pre_expiry_warn" | "expired_notice" | "cleaned";

export type StorageExpirySweepItem = {
  userId: string;
  username: string;
  displayName: string;
  email: string | null;
  action: StorageExpiryActionKind;
  expiresAt: string;
  graceEndsAt: string | null;
  quotaBytes: number;
  usedBytes: number;
  deletedMediaCount: number;
  freedBytes: number;
  deletedCanvasCount: number;
  deletedWorkbenchCount: number;
  deletedAssetCount: number;
  emailSent: boolean;
  error?: string;
};

export type StorageExpirySweepResult = {
  ok: true;
  dryRun: boolean;
  skippedDisabled?: boolean;
  executedAt: string;
  policy: PlatformStorageExpiryPolicy;
  scannedUsers: number;
  eligibleUsers: number;
  preExpiryWarned: number;
  expiredNoticed: number;
  cleanedUsers: number;
  freedBytesTotal: number;
  skippedNoEmail: number;
  failedCount: number;
  truncated: boolean;
  items: StorageExpirySweepItem[];
};

let sweepInFlight: Promise<StorageExpirySweepResult> | null = null;
let schedulerStarted = false;

function sameInstant(a: Date | null | undefined, b: Date) {
  if (!a) return false;
  return Math.abs(a.getTime() - b.getTime()) <= 1000;
}

function getLatestExpiredTimestamp(
  baseQuotaBytes: number,
  baseExpiresAt: Date | null | undefined,
  grants: Array<{ quotaBytes: number; expiresAt: Date | null; status: string }>,
  nowMs: number,
): Date | null {
  let latest: Date | null = null;
  const pick = (candidate: Date | null | undefined) => {
    if (!candidate) return;
    if (candidate.getTime() <= nowMs && (!latest || candidate.getTime() > latest.getTime())) {
      latest = candidate;
    }
  };

  if ((baseQuotaBytes ?? 0) > 0 && baseExpiresAt) {
    pick(baseExpiresAt);
  }
  for (const grant of grants) {
    if ((grant.quotaBytes ?? 0) > 0 && grant.expiresAt) {
      pick(grant.expiresAt);
    }
  }
  return latest;
}

function selectMediaForCleanup(
  rows: Array<{ id: string; objectKey: string; sizeBytes: number; meta: Record<string, unknown> | null }>,
  usedBytes: number,
  effectiveQuotaBytes: number,
) {
  if (effectiveQuotaBytes <= 0) {
    return {
      targets: rows,
      freedBytes: rows.reduce((sum, item) => sum + Math.max(0, Number(item.sizeBytes || 0)), 0),
      remainingBytes: 0,
    };
  }

  let remaining = usedBytes;
  let freedBytes = 0;
  const targets: typeof rows = [];
  for (const row of rows) {
    if (remaining <= effectiveQuotaBytes) break;
    const size = Math.max(0, Number(row.sizeBytes || 0));
    targets.push(row);
    remaining = Math.max(0, remaining - size);
    freedBytes += size;
  }
  return { targets, freedBytes, remainingBytes: remaining };
}

async function runSweepInternal(options?: {
  now?: Date;
  dryRun?: boolean;
  onlyWhenEnabled?: boolean;
}): Promise<StorageExpirySweepResult> {
  const now = options?.now ?? new Date();
  const nowMs = now.getTime();
  const dryRun = Boolean(options?.dryRun);
  const policy = await getPlatformStorageExpiryPolicy();

  if (options?.onlyWhenEnabled && !policy.enabled) {
    return {
      ok: true,
      dryRun,
      skippedDisabled: true,
      executedAt: now.toISOString(),
      policy,
      scannedUsers: 0,
      eligibleUsers: 0,
      preExpiryWarned: 0,
      expiredNoticed: 0,
      cleanedUsers: 0,
      freedBytesTotal: 0,
      skippedNoEmail: 0,
      failedCount: 0,
      truncated: false,
      items: [],
    };
  }

  const allUsers = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      email: users.email,
      role: users.role,
      status: users.status,
      storageQuotaBytes: users.storageQuotaBytes,
      storageQuotaExpiresAt: users.storageQuotaExpiresAt,
      storageUsedBytes: users.storageUsedBytes,
      storagePreExpiryWarnedFor: users.storagePreExpiryWarnedFor,
      storageExpiredWarnedFor: users.storageExpiredWarnedFor,
    })
    .from(users)
    .where(eq(users.status, "active"));

  const candidateUsers = allUsers.filter((user) => {
    if (policy.exemptAdmins && user.role === "admin") return false;
    return Number(user.storageUsedBytes || 0) > 0;
  });

  const userIds = candidateUsers.map((user) => user.id);
  const grantsByUser = new Map<string, Array<{ quotaBytes: number; expiresAt: Date | null; status: string }>>();
  if (userIds.length > 0) {
    const grants = await db
      .select({
        userId: userStorageGrants.userId,
        quotaBytes: userStorageGrants.quotaBytes,
        expiresAt: userStorageGrants.expiresAt,
        status: userStorageGrants.status,
      })
      .from(userStorageGrants)
      .where(inArray(userStorageGrants.userId, userIds));
    for (const grant of grants) {
      const bucket = grantsByUser.get(grant.userId) ?? [];
      bucket.push(grant);
      grantsByUser.set(grant.userId, bucket);
    }
  }

  const mailConfig = await getPlatformMailConfig();
  const mailReady = isMailConfigReady(mailConfig);
  const s3Config = dryRun ? null : await getS3StorageConfig();

  const items: StorageExpirySweepItem[] = [];
  let eligibleUsers = 0;
  let preExpiryWarned = 0;
  let expiredNoticed = 0;
  let cleanedUsers = 0;
  let freedBytesTotal = 0;
  let skippedNoEmail = 0;
  let failedCount = 0;
  let truncated = false;

  for (const user of candidateUsers) {
    const usedBytes = Math.max(0, Number(user.storageUsedBytes || 0));
    const userGrants = grantsByUser.get(user.id) ?? [];
    const summary = resolveEffectiveStorageQuota(user.storageQuotaBytes, user.storageQuotaExpiresAt, userGrants, now);
    const latestExpiredAt = getLatestExpiredTimestamp(user.storageQuotaBytes, user.storageQuotaExpiresAt, userGrants, nowMs);
    const isExpiredOverQuota = Boolean(latestExpiredAt && (summary.storageQuotaBytes <= 0 || usedBytes > summary.storageQuotaBytes));

    let pendingAction: StorageExpiryActionKind | null = null;
    let actionTargetDate: Date | null = null;
    let graceEndsAt: Date | null = null;

    if (isExpiredOverQuota && latestExpiredAt) {
      graceEndsAt = new Date(latestExpiredAt.getTime() + policy.gracePeriodDays * DAY_MS);
      if (nowMs >= graceEndsAt.getTime()) {
        pendingAction = "cleaned";
        actionTargetDate = latestExpiredAt;
      } else if (!sameInstant(user.storageExpiredWarnedFor, latestExpiredAt)) {
        pendingAction = "expired_notice";
        actionTargetDate = latestExpiredAt;
      }
    } else if (policy.preExpiryWarnDays > 0 && summary.storageQuotaBytes > 0 && summary.storageQuotaExpiresAt) {
      const expiresMs = summary.storageQuotaExpiresAt.getTime();
      if (expiresMs > nowMs && expiresMs - nowMs <= policy.preExpiryWarnDays * DAY_MS) {
        if (!sameInstant(user.storagePreExpiryWarnedFor, summary.storageQuotaExpiresAt)) {
          pendingAction = "pre_expiry_warn";
          actionTargetDate = summary.storageQuotaExpiresAt;
          graceEndsAt = new Date(expiresMs + policy.gracePeriodDays * DAY_MS);
        }
      }
    }

    if (!pendingAction || !actionTargetDate) {
      continue;
    }

    eligibleUsers += 1;
    if (items.length >= STORAGE_EXPIRY_BATCH_LIMIT) {
      truncated = true;
      continue;
    }

    const displayName = user.displayName || user.username;
    const item: StorageExpirySweepItem = {
      userId: user.id,
      username: user.username,
      displayName,
      email: user.email || null,
      action: pendingAction,
      expiresAt: actionTargetDate.toISOString(),
      graceEndsAt: graceEndsAt ? graceEndsAt.toISOString() : null,
      quotaBytes: summary.storageQuotaBytes,
      usedBytes,
      deletedMediaCount: 0,
      freedBytes: 0,
      deletedCanvasCount: 0,
      deletedWorkbenchCount: 0,
      deletedAssetCount: 0,
      emailSent: false,
    };

    if (pendingAction === "pre_expiry_warn") {
      if (!dryRun) {
        if (!user.email) {
          skippedNoEmail += 1;
          await db.update(users).set({ storagePreExpiryWarnedFor: actionTargetDate, updatedAt: now }).where(eq(users.id, user.id));
        } else if (!mailReady) {
          item.error = "邮件服务未配置完成";
          failedCount += 1;
        } else {
          try {
            await sendStoragePreExpiryEmail({
              to: user.email,
              displayName,
              usedBytes,
              quotaBytes: summary.storageQuotaBytes,
              expiresAt: actionTargetDate,
              gracePeriodDays: policy.gracePeriodDays,
            });
            item.emailSent = true;
            await db.update(users).set({ storagePreExpiryWarnedFor: actionTargetDate, updatedAt: now }).where(eq(users.id, user.id));
          } catch (error) {
            item.error = error instanceof Error ? error.message : "预警邮件发送失败";
            failedCount += 1;
          }
        }
      }
      if (!item.error) preExpiryWarned += 1;
      items.push(item);
      continue;
    }

    if (pendingAction === "expired_notice") {
      if (!dryRun) {
        if (!user.email) {
          skippedNoEmail += 1;
          await db.update(users).set({ storageExpiredWarnedFor: actionTargetDate, updatedAt: now }).where(eq(users.id, user.id));
        } else if (!mailReady) {
          item.error = "邮件服务未配置完成";
          failedCount += 1;
        } else {
          try {
            await sendStorageExpiredNoticeEmail({
              to: user.email,
              displayName,
              usedBytes,
              remainingQuotaBytes: summary.storageQuotaBytes,
              expiredAt: actionTargetDate,
              graceEndsAt: graceEndsAt!,
              gracePeriodDays: policy.gracePeriodDays,
            });
            item.emailSent = true;
            await db.update(users).set({ storageExpiredWarnedFor: actionTargetDate, updatedAt: now }).where(eq(users.id, user.id));
          } catch (error) {
            item.error = error instanceof Error ? error.message : "到期通知邮件发送失败";
            failedCount += 1;
          }
        }
      }
      if (!item.error) expiredNoticed += 1;
      items.push(item);
      continue;
    }

    const activeMedia = await db
      .select({
        id: mediaObjects.id,
        objectKey: mediaObjects.objectKey,
        sizeBytes: mediaObjects.bytes,
        meta: mediaObjects.meta,
      })
      .from(mediaObjects)
      .where(and(eq(mediaObjects.userId, user.id), eq(mediaObjects.status, "active")))
      .orderBy(asc(mediaObjects.createdAt));

    const plan = selectMediaForCleanup(activeMedia, usedBytes, summary.storageQuotaBytes);
    item.deletedMediaCount = plan.targets.length;
    item.freedBytes = plan.freedBytes;

    const shouldCleanWorkspace =
      policy.cleanupWorkspaceData && (summary.storageQuotaBytes <= 0 || plan.remainingBytes > summary.storageQuotaBytes);

    if (dryRun) {
      if (shouldCleanWorkspace) {
        const [canvasRows, workbenchRows, assetRows] = await Promise.all([
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(canvasProjects)
            .where(and(eq(canvasProjects.userId, user.id), isNull(canvasProjects.deletedAt))),
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(workbenchLogs)
            .where(and(eq(workbenchLogs.userId, user.id), isNull(workbenchLogs.deletedAt))),
          db
            .select({ count: sql<number>`count(*)::int` })
            .from(userAssets)
            .where(and(eq(userAssets.userId, user.id), isNull(userAssets.deletedAt))),
        ]);
        item.deletedCanvasCount = Number(canvasRows[0]?.count ?? 0);
        item.deletedWorkbenchCount = Number(workbenchRows[0]?.count ?? 0);
        item.deletedAssetCount = Number(assetRows[0]?.count ?? 0);
      }
      cleanedUsers += 1;
      freedBytesTotal += item.freedBytes;
      items.push(item);
      continue;
    }

    const s3Errors: string[] = [];
    const cleanedIds: string[] = [];
    for (const row of plan.targets) {
      if (s3Config) {
        try {
          await deleteS3Object(s3Config, row.objectKey);
        } catch (error) {
          s3Errors.push(`${row.objectKey}: ${error instanceof Error ? error.message : "S3删除失败"}`);
        }
        const thumbObjectKey = typeof row.meta?.thumbObjectKey === "string" ? row.meta.thumbObjectKey : "";
        if (thumbObjectKey) {
          await deleteS3Object(s3Config, thumbObjectKey).catch(() => undefined);
        }
      }
      cleanedIds.push(row.id);
    }

    if (cleanedIds.length > 0) {
      await db.update(mediaObjects).set({ status: "deleted" }).where(inArray(mediaObjects.id, cleanedIds));
    }

    const [remainingRow] = await db
      .select({ total: sql<number>`coalesce(sum(${mediaObjects.bytes}), 0)::bigint` })
      .from(mediaObjects)
      .where(and(eq(mediaObjects.userId, user.id), eq(mediaObjects.status, "active")));
    const nextUsedBytes = Math.max(0, Number(remainingRow?.total ?? 0));

    if (shouldCleanWorkspace) {
      const [deletedCanvases, deletedWorkbench, deletedAssets] = await Promise.all([
        db
          .update(canvasProjects)
          .set({ deletedAt: now, updatedAt: now })
          .where(and(eq(canvasProjects.userId, user.id), isNull(canvasProjects.deletedAt)))
          .returning({ id: canvasProjects.id }),
        db
          .update(workbenchLogs)
          .set({ deletedAt: now })
          .where(and(eq(workbenchLogs.userId, user.id), isNull(workbenchLogs.deletedAt)))
          .returning({ id: workbenchLogs.id }),
        db
          .update(userAssets)
          .set({ deletedAt: now })
          .where(and(eq(userAssets.userId, user.id), isNull(userAssets.deletedAt)))
          .returning({ id: userAssets.id }),
      ]);
      item.deletedCanvasCount = deletedCanvases.length;
      item.deletedWorkbenchCount = deletedWorkbench.length;
      item.deletedAssetCount = deletedAssets.length;
    }

    await db
      .update(users)
      .set({
        storageUsedBytes: nextUsedBytes,
        storageCleanedAt: now,
        updatedAt: now,
      })
      .where(eq(users.id, user.id));

    if (!user.email) {
      skippedNoEmail += 1;
    } else if (mailReady) {
      try {
        await sendStorageCleanedEmail({
          to: user.email,
          displayName,
          deletedMediaCount: item.deletedMediaCount,
          freedBytes: item.freedBytes,
          deletedCanvasCount: item.deletedCanvasCount,
          deletedWorkbenchCount: item.deletedWorkbenchCount,
          deletedAssetCount: item.deletedAssetCount,
          remainingQuotaBytes: summary.storageQuotaBytes,
        });
        item.emailSent = true;
      } catch (error) {
        s3Errors.push(`邮件通知失败: ${error instanceof Error ? error.message : "未知错误"}`);
      }
    }

    if (s3Errors.length > 0) {
      item.error = s3Errors.join("；");
      failedCount += 1;
    }
    cleanedUsers += 1;
    freedBytesTotal += item.freedBytes;
    items.push(item);
  }

  return {
    ok: true,
    dryRun,
    executedAt: now.toISOString(),
    policy,
    scannedUsers: candidateUsers.length,
    eligibleUsers,
    preExpiryWarned,
    expiredNoticed,
    cleanedUsers,
    freedBytesTotal,
    skippedNoEmail,
    failedCount,
    truncated,
    items,
  };
}

/** 执行一次云存储到期预警与逾期清理巡检（带并发互斥保护）。 */
export async function runStorageExpirySweep(options?: {
  now?: Date;
  dryRun?: boolean;
  onlyWhenEnabled?: boolean;
}): Promise<StorageExpirySweepResult> {
  if (sweepInFlight) {
    return sweepInFlight;
  }
  sweepInFlight = runSweepInternal(options).finally(() => {
    sweepInFlight = null;
  });
  return sweepInFlight;
}

/** 启动云存储到期定时巡检任务（默认每小时执行一次，仅在策略开启时生效）。 */
export function startStorageExpiryScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;

  const trigger = () => {
    void runStorageExpirySweep({ onlyWhenEnabled: true })
      .then((res) => {
        if (res.skippedDisabled) return;
        if (res.preExpiryWarned || res.expiredNoticed || res.cleanedUsers || res.failedCount) {
          console.info(
            `[storage-expiry] sweep done: warned=${res.preExpiryWarned}, expiredNotice=${res.expiredNoticed}, cleaned=${res.cleanedUsers}, freed=${res.freedBytesTotal}, failed=${res.failedCount}`,
          );
        }
      })
      .catch((error) => {
        console.error("[storage-expiry] sweep error:", error);
      });
  };

  setTimeout(trigger, INITIAL_SWEEP_DELAY_MS);
  setInterval(trigger, STORAGE_EXPIRY_SWEEP_INTERVAL_MS);
}
