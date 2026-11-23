/** 访问令牌（JWT）签发与校验工具。 */
import { sign, verify } from "hono/jwt";

import type { UserRole } from "../db/schema.ts";
import { env } from "../env.ts";

export type AccessTokenPayload = {
  sub: string;
  role: UserRole;
  exp: number;
};

/** 签发带用户 ID 与角色声明的短期 HS256 访问令牌。 */
export async function signAccessToken(userId: string, role: UserRole) {
  const payload: AccessTokenPayload = {
    sub: userId,
    role,
    exp: Math.floor(Date.now() / 1000) + env.JWT_ACCESS_EXPIRES_SECONDS,
  };
  return sign(payload, env.JWT_SECRET, "HS256");
}

/** 校验访问令牌签名与载荷结构，失败时抛出异常。 */
export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  const payload = await verify(token, env.JWT_SECRET, "HS256");
  if (typeof payload.sub !== "string" || (payload.role !== "admin" && payload.role !== "user")) {
    throw new Error("无效的访问令牌");
  }
  return payload as AccessTokenPayload;
}
