/** 兑换码核销公共事务逻辑：加行锁校验类型、可用状态、次数与一人一码限制。 */
import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import { db, redeemCodes, redeemRecords, type RedeemCodeKind } from "../db/index.ts";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type LockedRedeemCodeRow = {
  id: string;
  code: string;
  kind: RedeemCodeKind;
  credits: number;
  storage_quota_bytes: number | string;
  storage_duration_days: number | null;
  max_uses: number;
  used_count: number;
  note: string;
  status: string;
  expires_at: Date | string | null;
};

export async function claimRedeemCodeInTx(
  tx: DbTransaction,
  params: {
    code: string;
    userId: string;
    expectedKind: RedeemCodeKind;
  },
) {
  const normalizedCode = params.code.trim().toUpperCase();
  const locked = await tx.execute(
    sql`SELECT id, code, kind, credits, storage_quota_bytes, storage_duration_days, max_uses, used_count, note, status, expires_at FROM redeem_codes WHERE code = ${normalizedCode} FOR UPDATE`,
  );
  const row = locked[0] as LockedRedeemCodeRow | undefined;

  if (!row) {
    return { error: "兑换码不存在", status: 404 as const };
  }
  const codeKind: RedeemCodeKind = row.kind === "storage" ? "storage" : "credits";
  if (codeKind !== params.expectedKind) {
    return {
      error:
        params.expectedKind === "credits"
          ? "该兑换码为云端存储兑换码，请在「我的云端媒体」页面兑换"
          : "该兑换码为积分兑换码，请在「积分钱包」页面兑换",
      status: 400 as const,
    };
  }
  if (row.status !== "active") {
    return { error: "该兑换码已被停用", status: 400 as const };
  }
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    return { error: "该兑换码已过期", status: 400 as const };
  }
  if (row.used_count >= row.max_uses) {
    return { error: "该兑换码已被兑完", status: 400 as const };
  }

  const already = await tx.query.redeemRecords.findFirst({
    where: and(eq(redeemRecords.codeId, row.id), eq(redeemRecords.userId, params.userId)),
    columns: { id: true },
  });
  if (already) {
    return { error: "您已经兑换过该兑换码", status: 400 as const };
  }

  const storageQuotaBytes = Math.max(0, Number(row.storage_quota_bytes || 0));
  const storageDurationDays =
    typeof row.storage_duration_days === "number" && row.storage_duration_days > 0
      ? Math.round(row.storage_duration_days)
      : null;
  const storageExpiresAt =
    codeKind === "storage" && storageDurationDays
      ? new Date(Date.now() + storageDurationDays * 86_400_000)
      : null;

  await tx
    .update(redeemCodes)
    .set({ usedCount: row.used_count + 1 })
    .where(eq(redeemCodes.id, row.id));

  await tx.insert(redeemRecords).values({
    id: nanoid(),
    codeId: row.id,
    userId: params.userId,
    kind: codeKind,
    credits: codeKind === "credits" ? Number(row.credits || 0) : 0,
    storageQuotaBytes: codeKind === "storage" ? storageQuotaBytes : 0,
    storageDurationDays: codeKind === "storage" ? storageDurationDays : null,
    storageExpiresAtAfter: codeKind === "storage" ? storageExpiresAt : null,
  });

  return {
    ok: true as const,
    codeRow: {
      id: row.id,
      code: row.code,
      kind: codeKind,
      credits: Number(row.credits || 0),
      storageQuotaBytes,
      storageDurationDays,
      storageExpiresAt,
      note: row.note,
    },
  };
}
