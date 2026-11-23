/** 个人积分钱包接口：分页筛选流水与兑换码兑换积分。 */
import { zValidator } from "@hono/zod-validator";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";

import { db, redeemCodes, redeemRecords } from "../db/index.ts";
import { adjustWalletCreditsInTx, getWalletBalance, queryCreditLedger } from "../lib/billing.ts";
import { requireAuth, type AppEnv } from "../middleware/auth.ts";

const redeemSchema = z.object({
  code: z.string().trim().min(1, "请输入兑换码").max(64),
});

export const billingRoutes = new Hono<AppEnv>();

billingRoutes.use("*", requireAuth);

billingRoutes.get("/ledger", async (c) => {
  const user = c.get("user");
  const categoryRaw = c.req.query("category")?.trim();
  const category = categoryRaw === "usage" || categoryRaw === "recharge" ? categoryRaw : undefined;

  const [balance, ledger] = await Promise.all([
    getWalletBalance(user.id),
    queryCreditLedger({
      userId: user.id,
      logId: c.req.query("logId"),
      taskStatus: c.req.query("taskStatus"),
      category,
      reason: c.req.query("reason"),
      model: c.req.query("model"),
      startDate: c.req.query("startDate"),
      endDate: c.req.query("endDate"),
      page: Number(c.req.query("page") || 1),
      pageSize: Number(c.req.query("pageSize") || 20),
    }),
  ]);

  return c.json({
    balance,
    ...ledger,
  });
});

billingRoutes.post("/redeem", zValidator("json", redeemSchema), async (c) => {
  const user = c.get("user");
  const code = c.req.valid("json").code.trim().toUpperCase();

  const result = await db.transaction(async (tx) => {
    const locked = await tx.execute(
      sql`SELECT id, code, credits, max_uses, used_count, note, status, expires_at FROM redeem_codes WHERE code = ${code} FOR UPDATE`,
    );
    const row = locked[0] as
      | {
          id: string;
          code: string;
          credits: number;
          max_uses: number;
          used_count: number;
          note: string;
          status: string;
          expires_at: Date | string | null;
        }
      | undefined;

    if (!row) {
      return { error: "兑换码不存在", status: 404 as const };
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
      where: and(eq(redeemRecords.codeId, row.id), eq(redeemRecords.userId, user.id)),
      columns: { id: true },
    });
    if (already) {
      return { error: "您已经兑换过该兑换码", status: 400 as const };
    }

    await tx
      .update(redeemCodes)
      .set({ usedCount: row.used_count + 1 })
      .where(eq(redeemCodes.id, row.id));

    await tx.insert(redeemRecords).values({
      id: nanoid(),
      codeId: row.id,
      userId: user.id,
      credits: row.credits,
    });

    const walletRes = await adjustWalletCreditsInTx(tx, {
      userId: user.id,
      delta: row.credits,
      reason: "redeem_code",
      refId: row.code,
      meta: { codeId: row.id, code: row.code, note: row.note },
    });

    return { ok: true as const, creditsAdded: row.credits, balance: walletRes.balance };
  });

  if ("error" in result) {
    return c.json({ error: result.error }, result.status);
  }

  return c.json(result);
});
