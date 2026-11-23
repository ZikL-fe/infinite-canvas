/** 前端运行时配置下发接口：仅返回脱敏后的可用模型渠道（经代理访问）及当前用户的 WebDAV 配额状态。 */
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { db, users } from "../db/index.ts";
import { getPlatformChannels, getPlatformWebdavConfig, resolveEffectiveUserWebdav } from "../lib/settings.ts";
import { requireAuth, type AppEnv } from "../middleware/auth.ts";

export const runtimeRoutes = new Hono<AppEnv>();

runtimeRoutes.use("*", requireAuth);

runtimeRoutes.get("/config", async (c) => {
  const authUser = c.get("user");
  const [channels, platformWebdav, userRow] = await Promise.all([
    getPlatformChannels(),
    getPlatformWebdavConfig(),
    db.query.users.findFirst({
      where: eq(users.id, authUser.id),
      columns: { webdavConfig: true },
    }),
  ]);

  // 普通用户仅接收脱敏后的渠道列表与代理路径，真实 baseUrl 与 apiKey 留在服务端
  const safeChannels = channels
    .filter((channel) => channel.enabled && channel.baseUrl.trim() && channel.apiKey.trim())
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      apiFormat: channel.apiFormat,
      baseUrl: `/api/ai/proxy/${channel.id}`,
      models: channel.models,
    }));

  const assignedWebdav = resolveEffectiveUserWebdav(platformWebdav, userRow?.webdavConfig);

  return c.json({
    channels: safeChannels,
    webdav: assignedWebdav,
  });
});
