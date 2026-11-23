/** 多用户认证接口：引导状态检查、首注管理员注册（事务级锁）、登录、刷新令牌及当前会话查询。 */
import { zValidator } from "@hono/zod-validator";
import { and, count, eq, gt, isNull, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { z } from "zod";

import { creditWallets, db, userSessions, users, type UserRole } from "../db/index.ts";
import { env } from "../env.ts";
import { getWalletBalance } from "../lib/billing.ts";
import { generateRandomToken, hashPassword, sha256Hex, verifyPassword } from "../lib/crypto.ts";
import { signAccessToken } from "../lib/jwt.ts";
import { getAuthPolicy, getPlatformWebdavConfig } from "../lib/settings.ts";
import { requireAuth, type AppEnv } from "../middleware/auth.ts";

const registerSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, "用户名至少 3 个字符")
    .max(32, "用户名最多 32 个字符")
    .regex(/^[a-zA-Z0-9_-]+$/, "用户名仅支持字母、数字、下划线和连字符"),
  password: z.string().min(6, "密码至少 6 个字符").max(128, "密码过长"),
  email: z.string().trim().email("邮箱格式不正确").optional().or(z.literal("")),
  displayName: z.string().trim().max(48, "昵称最多 48 个字符").optional().or(z.literal("")),
});

const loginSchema = z.object({
  account: z.string().trim().min(1, "请输入用户名或邮箱"),
  password: z.string().min(1, "请输入密码"),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1, "缺少 refreshToken"),
});

function sanitizeUser(user: {
  id: string;
  username: string;
  email: string | null;
  displayName: string;
  avatarUrl: string;
  role: UserRole;
  status: string;
  storageUsedBytes: number;
  createdAt: Date;
}) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    role: user.role,
    status: user.status,
    storageUsedBytes: user.storageUsedBytes,
    createdAt: user.createdAt,
  };
}

async function createSessionTokens(userId: string, role: UserRole, c: { req: { header: (name: string) => string | undefined } }) {
  const accessToken = await signAccessToken(userId, role);
  const refreshToken = generateRandomToken(36);
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_EXPIRES_DAYS * 86_400_000);
  await db.insert(userSessions).values({
    id: nanoid(),
    userId,
    refreshTokenHash: sha256Hex(refreshToken),
    userAgent: c.req.header("User-Agent") || "",
    ip: c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() || "",
    expiresAt,
  });
  return { accessToken, refreshToken };
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.get("/bootstrap-status", async (c) => {
  const [{ value: userCount }] = await db.select({ value: count() }).from(users);
  const policy = await getAuthPolicy();
  return c.json({
    initialized: Number(userCount) > 0,
    allowRegister: Number(userCount) === 0 ? true : policy.allowRegister,
  });
});

authRoutes.post("/register", zValidator("json", registerSchema), async (c) => {
  const body = c.req.valid("json");
  const normalizedEmail = body.email ? body.email.toLowerCase() : null;
  const passwordHash = await hashPassword(body.password);

  const [policy, platformWebdav] = await Promise.all([getAuthPolicy(), getPlatformWebdavConfig()]);
  const result = await db.transaction(async (tx) => {
    // 事务级锁防止并发注册导致产生多个初始管理员
    await tx.execute(sql`SELECT pg_advisory_xact_lock(20261123)`);

    const [{ value: totalUsers }] = await tx.select({ value: count() }).from(users);
    const isFirstUser = Number(totalUsers) === 0;
    if (!isFirstUser && !policy.allowRegister) {
      return { error: "管理员已关闭新用户注册", status: 403 as const };
    }

    const existing = await tx.query.users.findFirst({
      where: normalizedEmail
        ? or(eq(users.username, body.username), eq(users.email, normalizedEmail))
        : eq(users.username, body.username),
      columns: { id: true, username: true, email: true },
    });
    if (existing) {
      return {
        error: existing.username === body.username ? "用户名已被占用" : "邮箱已被注册",
        status: 409 as const,
      };
    }

    const id = nanoid();
    const role: UserRole = isFirstUser ? "admin" : "user";
    const defaultWebdav =
      platformWebdav.enabled && platformWebdav.autoAssignNewUsers
        ? {
            enabled: true,
            directory: `${platformWebdav.baseDirectory}/${body.username}`,
          }
        : null;

    const [created] = await tx
      .insert(users)
      .values({
        id,
        username: body.username,
        email: normalizedEmail,
        passwordHash,
        displayName: body.displayName || body.username,
        role,
        status: "active",
        webdavConfig: defaultWebdav,
        lastLoginAt: new Date(),
      })
      .returning();

    await tx.insert(creditWallets).values({ userId: id, balance: 0 });
    return { user: created };
  });

  if ("error" in result) {
    return c.json({ error: result.error }, result.status);
  }

  const tokens = await createSessionTokens(result.user.id, result.user.role, c);
  return c.json({ user: { ...sanitizeUser(result.user), creditBalance: 0 }, ...tokens }, 201);
});

authRoutes.post("/login", zValidator("json", loginSchema), async (c) => {
  const { account, password } = c.req.valid("json");
  const normalizedAccount = account.toLowerCase();

  const user = await db.query.users.findFirst({
    where: or(eq(users.username, account), eq(users.email, normalizedAccount)),
  });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return c.json({ error: "账号或密码错误" }, 401);
  }
  if (user.status !== "active") {
    return c.json({ error: "当前账号已被禁用，请联系管理员" }, 403);
  }

  await db.update(users).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(users.id, user.id));
  const [tokens, creditBalance] = await Promise.all([createSessionTokens(user.id, user.role, c), getWalletBalance(user.id)]);
  return c.json({ user: { ...sanitizeUser(user), creditBalance }, ...tokens });
});

authRoutes.post("/refresh", zValidator("json", refreshSchema), async (c) => {
  const { refreshToken } = c.req.valid("json");
  const tokenHash = sha256Hex(refreshToken);

  const session = await db.query.userSessions.findFirst({
    where: and(
      eq(userSessions.refreshTokenHash, tokenHash),
      isNull(userSessions.revokedAt),
      gt(userSessions.expiresAt, new Date()),
    ),
  });
  if (!session) {
    return c.json({ error: "登录会话已失效，请重新登录" }, 401);
  }

  const user = await db.query.users.findFirst({ where: eq(users.id, session.userId) });
  if (!user || user.status !== "active") {
    return c.json({ error: "账号不可用，请重新登录" }, 401);
  }

  const nextRefreshToken = generateRandomToken(36);
  const nextExpiresAt = new Date(Date.now() + env.JWT_REFRESH_EXPIRES_DAYS * 86_400_000);
  await db
    .update(userSessions)
    .set({ refreshTokenHash: sha256Hex(nextRefreshToken), expiresAt: nextExpiresAt })
    .where(eq(userSessions.id, session.id));

  const accessToken = await signAccessToken(user.id, user.role);
  return c.json({
    user: sanitizeUser(user),
    accessToken,
    refreshToken: nextRefreshToken,
  });
});

authRoutes.post("/logout", zValidator("json", refreshSchema), async (c) => {
  const { refreshToken } = c.req.valid("json");
  await db
    .update(userSessions)
    .set({ revokedAt: new Date() })
    .where(eq(userSessions.refreshTokenHash, sha256Hex(refreshToken)));
  return c.json({ ok: true });
});

authRoutes.get("/me", requireAuth, async (c) => {
  const user = c.get("user");
  const creditBalance = await getWalletBalance(user.id);
  return c.json({ user: { ...sanitizeUser(user), creditBalance } });
});
