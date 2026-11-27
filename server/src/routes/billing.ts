/** 个人积分钱包接口：分页筛选流水与积分兑换码核销。 */
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/index.ts";
import { adjustWalletCreditsInTx, getWalletBalance, queryCreditLedger } from "../lib/billing.ts";
import { scheduleWalletBalanceAlertCheck } from "../lib/billing-alert.ts";
import { applyInviteRebateInTx } from "../lib/invite.ts";
import { rateLimitRedeem } from "../lib/rate-limit.ts";
import { claimRedeemCodeInTx } from "../lib/redeem.ts";
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

billingRoutes.post("/redeem", rateLimitRedeem, zValidator("json", redeemSchema), async (c) => {
  const user = c.get("user");
  const code = c.req.valid("json").code;

  const result = await db.transaction(async (tx) => {
    const claimed = await claimRedeemCodeInTx(tx, {
      code,
      userId: user.id,
      expectedKind: "credits",
    });
    if ("error" in claimed) return claimed;

    const { codeRow } = claimed;
    const walletRes = await adjustWalletCreditsInTx(tx, {
      userId: user.id,
      delta: codeRow.credits,
      reason: "redeem_code",
      refId: codeRow.code,
      meta: { codeId: codeRow.id, code: codeRow.code, note: codeRow.note },
    });

    await applyInviteRebateInTx(tx, {
      inviteeUserId: user.id,
      sourceLedgerId: walletRes.ledgerId,
      sourceReason: "redeem_code",
      sourceAmount: codeRow.credits,
    });

    return { ok: true as const, kind: "credits" as const, creditsAdded: codeRow.credits, balance: walletRes.balance };
  });

  if ("error" in result) {
    return c.json({ error: result.error }, result.status);
  }

  if ("creditsAdded" in result) {
    scheduleWalletBalanceAlertCheck(user.id, result.creditsAdded, result.balance);
  }
  return c.json(result);
});
