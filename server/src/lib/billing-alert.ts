/** 积分余额不足邮件提醒：原子防重冷却与余额回充自动重置逻辑。 */
import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm";

import { db, users } from "../db/index.ts";
import { isMailConfigReady, sendLowBalanceAlertEmail } from "./mail.ts";
import { getPlatformMailConfig } from "./settings.ts";

/** 在钱包余额变动后异步检查是否需要重置提醒状态或发送余额不足通知（失败仅记日志，不阻塞主流程）。 */
export async function handleWalletBalanceAlertCheck(userId: string, delta: number, balanceAfter: number) {
  if (!delta) return;
  try {
    const mailConfig = await getPlatformMailConfig();
    if (!isMailConfigReady(mailConfig)) return;

    const userRow = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true,
        username: true,
        displayName: true,
        email: true,
        status: true,
        lowBalanceAlertEnabled: true,
        lowBalanceThreshold: true,
        lowBalanceAlertedAt: true,
      },
    });
    if (!userRow || userRow.status !== "active" || !userRow.email) return;

    const effectiveEnabled = userRow.lowBalanceAlertEnabled ?? mailConfig.lowBalanceAlertEnabled;
    const effectiveThreshold = userRow.lowBalanceThreshold ?? mailConfig.lowBalanceThreshold;
    if (!effectiveEnabled || effectiveThreshold <= 0) return;

    // 余额回充到阈值及以上时重置提醒标记，便于下次再次跌破时及时通知
    if (balanceAfter >= effectiveThreshold) {
      if (userRow.lowBalanceAlertedAt) {
        await db
          .update(users)
          .set({ lowBalanceAlertedAt: null, updatedAt: new Date() })
          .where(and(eq(users.id, userId), isNotNull(users.lowBalanceAlertedAt)));
      }
      return;
    }

    if (delta >= 0) return;

    const cooldownCutoff = new Date(Date.now() - Math.max(1, mailConfig.lowBalanceCooldownHours) * 3_600_000);
    const claimed = await db
      .update(users)
      .set({ lowBalanceAlertedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(users.id, userId),
          or(isNull(users.lowBalanceAlertedAt), lt(users.lowBalanceAlertedAt, cooldownCutoff)),
        ),
      )
      .returning({ id: users.id });

    if (!claimed.length) return;

    await sendLowBalanceAlertEmail({
      to: userRow.email,
      displayName: userRow.displayName || userRow.username,
      balance: balanceAfter,
      threshold: effectiveThreshold,
      config: mailConfig,
    });
  } catch (error) {
    console.warn("[billing-alert] 发送余额不足邮件提醒失败:", error);
  }
}

export function scheduleWalletBalanceAlertCheck(userId: string, delta: number, balanceAfter: number) {
  if (!delta) return;
  void handleWalletBalanceAlertCheck(userId, delta, balanceAfter);
}
