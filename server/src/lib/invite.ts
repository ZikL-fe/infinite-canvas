/** 邀请关系绑定、邀请码生成、充值返利发放及管理员扣减/清零反向扣回逻辑。 */
import { randomInt } from "node:crypto";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import { creditLedger, creditWallets, db, inviteRebateRecords, users } from "../db/index.ts";
import { adjustWalletCreditsInTx, lockWalletBalance, roundCredits, type DbTransaction } from "./billing.ts";
import { getPlatformInvitePolicy } from "./settings.ts";

const INVITE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateInviteCode(length = 8) {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += INVITE_CODE_ALPHABET[randomInt(0, INVITE_CODE_ALPHABET.length)];
  }
  return out;
}

/** 规范化用户输入的邀请码（去空白并转大写）。 */
export function normalizeInviteCode(raw?: string | null) {
  return (raw || "").trim().toUpperCase();
}

/** 确保用户拥有唯一邀请码；若尚无邀请码则自动生成并落库。 */
export async function ensureUserInviteCode(userId: string): Promise<string> {
  const existing = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { inviteCode: true },
  });
  if (existing?.inviteCode) return existing.inviteCode;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = generateInviteCode(8);
    try {
      const [updated] = await db
        .update(users)
        .set({ inviteCode: candidate, updatedAt: new Date() })
        .where(and(eq(users.id, userId), sql`${users.inviteCode} IS NULL`))
        .returning({ inviteCode: users.inviteCode });
      if (updated?.inviteCode) return updated.inviteCode;

      const latest = await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { inviteCode: true },
      });
      if (latest?.inviteCode) return latest.inviteCode;
    } catch {
      // 唯一键冲突时重试生成
    }
  }
  throw new Error("生成邀请码失败，请稍后重试");
}

/** 在充值同一事务内按当前返利策略为邀请人入账并写入返利批次台账。 */
export async function applyInviteRebateInTx(
  tx: DbTransaction,
  params: {
    inviteeUserId: string;
    sourceLedgerId: string;
    sourceReason: "redeem_code" | "admin_adjust" | "plan_grant";
    sourceAmount: number;
  },
) {
  const sourceAmount = roundCredits(params.sourceAmount);
  if (sourceAmount <= 0) return null;

  const policy = await getPlatformInvitePolicy();
  if (!policy.enabled || policy.rebatePercent <= 0) return null;
  if (params.sourceReason === "admin_adjust" && !policy.includeAdminAdjust) return null;

  const invitee = await tx.query.users.findFirst({
    where: eq(users.id, params.inviteeUserId),
    columns: { id: true, username: true, displayName: true, invitedByUserId: true },
  });
  if (!invitee?.invitedByUserId || invitee.invitedByUserId === invitee.id) return null;

  const inviter = await tx.query.users.findFirst({
    where: eq(users.id, invitee.invitedByUserId),
    columns: { id: true, status: true },
  });
  if (!inviter || inviter.status !== "active") return null;

  const rebateCredits = roundCredits((sourceAmount * policy.rebatePercent) / 100);
  if (rebateCredits <= 0) return null;

  const walletRes = await adjustWalletCreditsInTx(tx, {
    userId: inviter.id,
    delta: rebateCredits,
    reason: "invite_rebate",
    refId: params.sourceLedgerId,
    meta: {
      direction: "earn",
      inviteeUserId: invitee.id,
      inviteeUsername: invitee.username,
      inviteeDisplayName: invitee.displayName,
      sourceLedgerId: params.sourceLedgerId,
      sourceReason: params.sourceReason,
      sourceAmount,
      rebatePercent: policy.rebatePercent,
    },
  });

  await tx
    .insert(inviteRebateRecords)
    .values({
      id: nanoid(),
      inviterUserId: inviter.id,
      inviteeUserId: invitee.id,
      sourceLedgerId: params.sourceLedgerId,
      sourceReason: params.sourceReason,
      sourceAmount,
      rebatePercent: policy.rebatePercent,
      rebateCredits,
      reclaimedSourceAmount: 0,
      reclaimedCredits: 0,
      inviterLedgerId: walletRes.ledgerId,
    })
    .onConflictDoNothing({ target: inviteRebateRecords.sourceLedgerId });

  return {
    inviterUserId: inviter.id,
    rebateCredits,
    balance: walletRes.balance,
  };
}

/** 管理员扣减或清零被邀请人积分时，按历史批次锁定的比例 LIFO 反向扣回邀请人已到账返利（余额最低扣至 0）。 */
export async function reclaimInviteRebateInTx(
  tx: DbTransaction,
  params: {
    inviteeUserId: string;
    deductedAmount: number;
    action: "deduct" | "clear";
    sourceLedgerId: string;
    adminId: string;
    note?: string;
  },
) {
  let remainingDeduct = roundCredits(params.deductedAmount);
  if (remainingDeduct <= 0) return [] as Array<{ userId: string; delta: number; balance: number }>;

  const lotRows = await tx.execute(sql`
    SELECT id, inviter_user_id, source_amount, rebate_percent, rebate_credits, reclaimed_source_amount, reclaimed_credits
    FROM invite_rebate_records
    WHERE invitee_user_id = ${params.inviteeUserId}
      AND reclaimed_credits < rebate_credits
    ORDER BY created_at DESC, id DESC
    FOR UPDATE
  `);
  if (!lotRows.length) return [] as Array<{ userId: string; delta: number; balance: number }>;

  const invitee = await tx.query.users.findFirst({
    where: eq(users.id, params.inviteeUserId),
    columns: { id: true, username: true, displayName: true },
  });

  const perInviter = new Map<
    string,
    {
      plannedClawback: number;
      consumedSource: number;
      breakdown: Array<{ recordId: string; sourceAmount: number; rebatePercent: number; clawbackCredits: number }>;
    }
  >();

  const now = new Date();
  for (const raw of lotRows as Array<Record<string, unknown>>) {
    if (remainingDeduct <= 0) break;
    const id = String(raw.id);
    const inviterUserId = String(raw.inviter_user_id);
    const sourceAmount = Number(raw.source_amount ?? 0);
    const rebatePercent = Number(raw.rebate_percent ?? 0);
    const rebateCredits = Number(raw.rebate_credits ?? 0);
    const prevReclaimedSource = Number(raw.reclaimed_source_amount ?? 0);
    const prevReclaimedCredits = Number(raw.reclaimed_credits ?? 0);

    const remSource = Math.max(0, roundCredits(sourceAmount - prevReclaimedSource));
    const remRebate = Math.max(0, roundCredits(rebateCredits - prevReclaimedCredits));
    if (remSource <= 0 || remRebate <= 0) continue;

    const takeSource = Math.min(remainingDeduct, remSource);
    const lotClawback =
      takeSource >= remSource - 1e-9
        ? remRebate
        : Math.min(remRebate, roundCredits((takeSource * rebatePercent) / 100));

    await tx
      .update(inviteRebateRecords)
      .set({
        reclaimedSourceAmount: roundCredits(prevReclaimedSource + takeSource),
        reclaimedCredits: roundCredits(prevReclaimedCredits + lotClawback),
        updatedAt: now,
      })
      .where(eq(inviteRebateRecords.id, id));

    remainingDeduct = roundCredits(Math.max(0, remainingDeduct - takeSource));
    if (lotClawback > 0) {
      const group = perInviter.get(inviterUserId) ?? { plannedClawback: 0, consumedSource: 0, breakdown: [] };
      group.plannedClawback = roundCredits(group.plannedClawback + lotClawback);
      group.consumedSource = roundCredits(group.consumedSource + takeSource);
      group.breakdown.push({ recordId: id, sourceAmount: takeSource, rebatePercent, clawbackCredits: lotClawback });
      perInviter.set(inviterUserId, group);
    }
  }

  const updates: Array<{ userId: string; delta: number; balance: number }> = [];
  for (const [inviterId, entry] of perInviter) {
    if (entry.plannedClawback <= 0) continue;
    const current = await lockWalletBalance(tx, inviterId);
    const actualDeduct = Math.min(Math.max(0, current), roundCredits(entry.plannedClawback));
    const nextBalance = roundCredits(Math.max(0, current - actualDeduct));

    if (actualDeduct > 0) {
      await tx
        .update(creditWallets)
        .set({ balance: nextBalance, updatedAt: now })
        .where(eq(creditWallets.userId, inviterId));
    }

    await tx.insert(creditLedger).values({
      id: nanoid(),
      userId: inviterId,
      delta: actualDeduct > 0 ? roundCredits(-actualDeduct) : 0,
      balanceAfter: nextBalance,
      reason: "invite_rebate",
      refId: params.sourceLedgerId,
      meta: {
        direction: "clawback",
        action: params.action,
        inviteeUserId: params.inviteeUserId,
        inviteeUsername: invitee?.username || "",
        inviteeDisplayName: invitee?.displayName || "",
        deductedSourceCredits: entry.consumedSource,
        plannedClawbackCredits: entry.plannedClawback,
        actualClawbackCredits: actualDeduct,
        cappedAtZero: actualDeduct < entry.plannedClawback,
        adminId: params.adminId,
        ...(params.note ? { note: params.note } : {}),
        breakdown: entry.breakdown,
      },
    });

    updates.push({ userId: inviterId, delta: actualDeduct > 0 ? -actualDeduct : 0, balance: nextBalance });
  }

  return updates;
}

/** 查询当前用户的邀请概况、返利统计及被邀请人列表。 */
export async function queryUserInviteSummary(userId: string, pageInput = 1, pageSizeInput = 20) {
  const page = Math.max(1, Number(pageInput || 1));
  const pageSize = Math.min(100, Math.max(1, Number(pageSizeInput || 20)));
  const offset = (page - 1) * pageSize;

  const [inviteCode, policy, [countRow], [rebateTotals], inviteeRows] = await Promise.all([
    ensureUserInviteCode(userId),
    getPlatformInvitePolicy(),
    db.select({ total: count() }).from(users).where(eq(users.invitedByUserId, userId)),
    db
      .select({
        grossRebate: sql<number>`COALESCE(SUM(${inviteRebateRecords.rebateCredits}), 0)::double precision`,
        reclaimedRebate: sql<number>`COALESCE(SUM(${inviteRebateRecords.reclaimedCredits}), 0)::double precision`,
      })
      .from(inviteRebateRecords)
      .where(eq(inviteRebateRecords.inviterUserId, userId)),
    db.query.users.findMany({
      where: eq(users.invitedByUserId, userId),
      orderBy: [desc(users.createdAt)],
      limit: pageSize,
      offset,
      columns: {
        id: true,
        username: true,
        displayName: true,
        status: true,
        createdAt: true,
      },
    }),
  ]);

  const inviteeIds = inviteeRows.map((u) => u.id);
  const perInviteeRows = inviteeIds.length
    ? await db
        .select({
          inviteeUserId: inviteRebateRecords.inviteeUserId,
          rechargedCredits: sql<number>`COALESCE(SUM(${inviteRebateRecords.sourceAmount}), 0)::double precision`,
          rebateCredits: sql<number>`COALESCE(SUM(${inviteRebateRecords.rebateCredits}), 0)::double precision`,
          reclaimedCredits: sql<number>`COALESCE(SUM(${inviteRebateRecords.reclaimedCredits}), 0)::double precision`,
        })
        .from(inviteRebateRecords)
        .where(and(eq(inviteRebateRecords.inviterUserId, userId), inArray(inviteRebateRecords.inviteeUserId, inviteeIds)))
        .groupBy(inviteRebateRecords.inviteeUserId)
    : [];

  const statsMap = new Map(perInviteeRows.map((r) => [r.inviteeUserId, r]));
  const grossRebateCredits = roundCredits(Number(rebateTotals?.grossRebate ?? 0));
  const reclaimedRebateCredits = roundCredits(Number(rebateTotals?.reclaimedRebate ?? 0));

  return {
    enabled: policy.enabled,
    rebatePercent: policy.rebatePercent,
    includeAdminAdjust: policy.includeAdminAdjust,
    inviteCode,
    invitedCount: Number(countRow?.total ?? 0),
    grossRebateCredits,
    reclaimedRebateCredits,
    netRebateCredits: roundCredits(Math.max(0, grossRebateCredits - reclaimedRebateCredits)),
    page,
    pageSize,
    items: inviteeRows.map((u) => {
      const stat = statsMap.get(u.id);
      const rebateCredits = roundCredits(Number(stat?.rebateCredits ?? 0));
      const reclaimedCredits = roundCredits(Number(stat?.reclaimedCredits ?? 0));
      return {
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        status: u.status,
        createdAt: u.createdAt.toISOString(),
        rechargedCredits: roundCredits(Number(stat?.rechargedCredits ?? 0)),
        rebateCredits,
        reclaimedCredits,
        netRebateCredits: roundCredits(Math.max(0, rebateCredits - reclaimedCredits)),
      };
    }),
  };
}
