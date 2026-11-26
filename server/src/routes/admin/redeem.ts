/** 管理后台：积分与云存储兑换码管理路由。 */
import { randomInt } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, lt, lte, or, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";

import { db, redeemCodes, redeemRecords, users } from "../../db/index.ts";
import { roundCredits } from "../../lib/billing.ts";
import type { AppEnv } from "../../middleware/auth.ts";

const createRedeemCodesSchema = z
  .object({
    name: z.string().trim().min(1, "请输入兑换码名称").max(80),
    kind: z.enum(["credits", "storage"]).default("credits"),
    count: z.number().int().min(1).max(100).default(1),
    credits: z.number().nonnegative().optional().default(0),
    storageQuotaBytes: z.number().int().nonnegative().optional().default(0),
    storageDurationDays: z.number().int().positive().max(36500).nullable().optional(),
    maxUses: z.number().int().min(1).default(1),
    prefix: z.string().trim().max(16).optional(),
    customCode: z.string().trim().max(64).optional(),
    expiresAt: z.string().nullable().optional(),
    note: z.string().trim().max(200).optional().default(""),
  })
  .superRefine((data, ctx) => {
    if (data.kind === "credits" && (!Number.isFinite(data.credits) || data.credits <= 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["credits"],
        message: "积分面值必须大于 0",
      });
    }
    if (data.kind === "storage" && (!Number.isFinite(data.storageQuotaBytes) || data.storageQuotaBytes <= 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["storageQuotaBytes"],
        message: "云端存储容量必须大于 0",
      });
    }
  });

const updateRedeemCodeSchema = z.object({
  status: z.enum(["active", "disabled"]),
});

const batchDeleteRedeemCodesSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, "请选择要删除的兑换码").max(200),
});

const REDEEM_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const REDEEM_CODE_GROUPS = 4;
const REDEEM_CODE_GROUP_LENGTH = 5;

function generateRedeemCodeString(prefix: string) {
  const cleanPrefix = prefix
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "");
  const groups = Array.from({ length: REDEEM_CODE_GROUPS }, () =>
    Array.from({ length: REDEEM_CODE_GROUP_LENGTH }, () => REDEEM_CODE_ALPHABET[randomInt(REDEEM_CODE_ALPHABET.length)]).join(""),
  );
  const body = groups.join("-");
  return cleanPrefix ? `${cleanPrefix}-${body}` : body;
}

export const adminRedeemRoutes = new Hono<AppEnv>();

adminRedeemRoutes.get("/redeem-codes", async (c) => {
  const q = c.req.query("q")?.trim() || "";
  const status = c.req.query("status")?.trim() || "";
  const used = c.req.query("used")?.trim() || "";
  const kind = c.req.query("kind")?.trim() || "";
  const page = Math.max(1, Number(c.req.query("page") || 1));
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query("pageSize") || 20)));
  const offset = (page - 1) * pageSize;

  const filters: SQL[] = [];
  if (q) {
    const cond = or(ilike(redeemCodes.name, `%${q}%`), ilike(redeemCodes.code, `%${q}%`), ilike(redeemCodes.note, `%${q}%`));
    if (cond) filters.push(cond);
  }

  const isUsedExpr = or(gt(redeemCodes.usedCount, 0), gte(redeemCodes.usedCount, redeemCodes.maxUses))!;
  const isUnusedExpr = and(eq(redeemCodes.usedCount, 0), lt(redeemCodes.usedCount, redeemCodes.maxUses))!;
  const now = new Date();

  if (used === "used") {
    filters.push(isUsedExpr);
  } else if (used === "unused") {
    filters.push(isUnusedExpr);
  }

  // 与表格展示的状态标签优先级保持一致：已使用 > 已停用 > 已过期 > 可用
  if (status === "available" || status === "active") {
    const availableCond = and(
      isUnusedExpr,
      eq(redeemCodes.status, "active"),
      or(isNull(redeemCodes.expiresAt), gt(redeemCodes.expiresAt, now)),
    );
    if (availableCond) filters.push(availableCond);
  } else if (status === "disabled") {
    const disabledCond = and(isUnusedExpr, eq(redeemCodes.status, "disabled"));
    if (disabledCond) filters.push(disabledCond);
  } else if (status === "expired") {
    const expiredCond = and(
      isUnusedExpr,
      eq(redeemCodes.status, "active"),
      isNotNull(redeemCodes.expiresAt),
      lte(redeemCodes.expiresAt, now),
    );
    if (expiredCond) filters.push(expiredCond);
  } else if (status === "used") {
    filters.push(isUsedExpr);
  }

  if (kind === "credits" || kind === "storage") {
    filters.push(eq(redeemCodes.kind, kind));
  }
  const whereClause = filters.length ? and(...filters) : undefined;

  const [items, [{ total }]] = await Promise.all([
    db.query.redeemCodes.findMany({
      where: whereClause,
      orderBy: [desc(redeemCodes.createdAt)],
      limit: pageSize,
      offset,
    }),
    db.select({ total: count() }).from(redeemCodes).where(whereClause),
  ]);

  const codeIds = items.map((item) => item.id);
  const redemptionMap = new Map<string, { userId: string; username: string; displayName: string; redeemedAt: string }>();
  if (codeIds.length) {
    const recordRows = await db
      .select({
        codeId: redeemRecords.codeId,
        userId: redeemRecords.userId,
        username: users.username,
        displayName: users.displayName,
        createdAt: redeemRecords.createdAt,
      })
      .from(redeemRecords)
      .leftJoin(users, eq(redeemRecords.userId, users.id))
      .where(inArray(redeemRecords.codeId, codeIds))
      .orderBy(desc(redeemRecords.createdAt));

    for (const row of recordRows) {
      if (!redemptionMap.has(row.codeId)) {
        redemptionMap.set(row.codeId, {
          userId: row.userId,
          username: row.username || "",
          displayName: row.displayName || "",
          redeemedAt: row.createdAt.toISOString(),
        });
      }
    }
  }

  return c.json({
    items: items.map((item) => ({
      ...item,
      redemption: redemptionMap.get(item.id) ?? null,
    })),
    total: Number(total),
    page,
    pageSize,
  });
});

adminRedeemRoutes.post("/redeem-codes", zValidator("json", createRedeemCodesSchema), async (c) => {
  const body = c.req.valid("json");
  const adminId = c.get("user").id;
  const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    return c.json({ error: "过期时间格式无效" }, 400);
  }

  const custom = body.count === 1 && body.customCode?.trim() ? body.customCode.trim().toUpperCase() : "";
  if (custom) {
    const exists = await db.query.redeemCodes.findFirst({ where: eq(redeemCodes.code, custom), columns: { id: true } });
    if (exists) {
      return c.json({ error: "该兑换码已存在" }, 409);
    }
  }

  const defaultPrefix = body.kind === "storage" ? "ST" : "IC";
  const prefix = body.prefix?.trim() || defaultPrefix;
  const credits = body.kind === "credits" ? roundCredits(body.credits) : 0;
  const storageQuotaBytes = body.kind === "storage" ? Math.round(body.storageQuotaBytes) : 0;
  const storageDurationDays =
    body.kind === "storage" && typeof body.storageDurationDays === "number" && body.storageDurationDays > 0
      ? Math.round(body.storageDurationDays)
      : null;

  // 批量生成随机兑换码时如遇极小概率碰撞，自动跳过已存在码并补齐剩余数量
  const remainingTarget = body.count;
  const created: (typeof redeemCodes.$inferSelect)[] = [];
  for (let attempt = 0; attempt < 5 && created.length < remainingTarget; attempt += 1) {
    const needed = remainingTarget - created.length;
    const values = Array.from({ length: needed }, (_, idx) => ({
      id: nanoid(),
      code: attempt === 0 && idx === 0 && custom ? custom : generateRedeemCodeString(prefix),
      name: body.name,
      kind: body.kind,
      credits,
      storageQuotaBytes,
      storageDurationDays,
      // 一个兑换码仅限 1 人兑换
      maxUses: 1,
      usedCount: 0,
      note: body.note,
      status: "active" as const,
      expiresAt,
      createdBy: adminId,
    }));
    const batch = await db
      .insert(redeemCodes)
      .values(values)
      .onConflictDoNothing({ target: redeemCodes.code })
      .returning();
    created.push(...batch);
  }
  return c.json({ items: created }, 201);
});

adminRedeemRoutes.patch("/redeem-codes/:id", zValidator("json", updateRedeemCodeSchema), async (c) => {
  const id = c.req.param("id");
  const { status } = c.req.valid("json");
  const [updated] = await db.update(redeemCodes).set({ status }).where(eq(redeemCodes.id, id)).returning();
  if (!updated) return c.json({ error: "兑换码不存在" }, 404);
  return c.json({ item: updated });
});

adminRedeemRoutes.post("/redeem-codes/batch-delete", zValidator("json", batchDeleteRedeemCodesSchema), async (c) => {
  const uniqueIds = Array.from(new Set(c.req.valid("json").ids));
  const result = await db.transaction(async (tx) => {
    const existingRows = await tx.query.redeemCodes.findMany({
      where: inArray(redeemCodes.id, uniqueIds),
      columns: { id: true, usedCount: true },
    });
    if (!existingRows.length) {
      return { error: "未找到可删除的兑换码", status: 404 as const };
    }
    const usedCode = existingRows.find((row) => row.usedCount > 0);
    const hasRecord = await tx.query.redeemRecords.findFirst({
      where: inArray(redeemRecords.codeId, uniqueIds),
      columns: { id: true },
    });
    if (usedCode || hasRecord) {
      return { error: "已使用过的兑换码不能删除，请取消勾选后再试", status: 400 as const };
    }
    const deleted = await tx
      .delete(redeemCodes)
      .where(and(inArray(redeemCodes.id, uniqueIds), eq(redeemCodes.usedCount, 0)))
      .returning({ id: redeemCodes.id });
    return { ok: true as const, deletedCount: deleted.length };
  });

  if ("error" in result) {
    return c.json({ error: result.error }, result.status);
  }
  return c.json(result);
});

adminRedeemRoutes.delete("/redeem-codes/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await db.query.redeemCodes.findFirst({
    where: eq(redeemCodes.id, id),
    columns: { id: true, usedCount: true },
  });
  if (!existing) return c.json({ error: "兑换码不存在" }, 404);
  if (existing.usedCount > 0) {
    return c.json({ error: "已使用过的兑换码不能删除" }, 400);
  }
  const hasRecord = await db.query.redeemRecords.findFirst({
    where: eq(redeemRecords.codeId, id),
    columns: { id: true },
  });
  if (hasRecord) {
    return c.json({ error: "已使用过的兑换码不能删除" }, 400);
  }
  const [deleted] = await db
    .delete(redeemCodes)
    .where(and(eq(redeemCodes.id, id), eq(redeemCodes.usedCount, 0)))
    .returning({ id: redeemCodes.id });
  if (!deleted) return c.json({ error: "兑换码不存在或已被兑换" }, 400);
  return c.json({ ok: true });
});

