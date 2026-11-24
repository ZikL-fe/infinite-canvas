/** 前端运行时配置与公告通知下发接口：通知接口公开，配置接口鉴权返回脱敏渠道及 WebDAV 状态。 */
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";

import { announcements, db, users } from "../db/index.ts";
import {
  getPlatformChannels,
  getPlatformGlobalNotice,
  getPlatformWebdavConfig,
  resolveEffectiveUserWebdav,
} from "../lib/settings.ts";
import { requireAuth, type AppEnv } from "../middleware/auth.ts";

export const runtimeRoutes = new Hono<AppEnv>();

runtimeRoutes.get("/notifications", async (c) => {
  const [notice, timeline] = await Promise.all([
    getPlatformGlobalNotice(),
    db.query.announcements.findMany({
      where: eq(announcements.isPublished, true),
      orderBy: [desc(announcements.isPinned), desc(announcements.createdAt)],
      limit: 30,
    }),
  ]);
  return c.json({
    notice: notice.enabled && notice.content.trim() ? notice : { ...notice, enabled: false },
    timeline,
  });
});

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
    // 仅向前端下发脱敏的启用与配额状态，不暴露 WebDAV 服务地址、目录、账号或密码
    webdav: assignedWebdav
      ? {
          enabled: true,
          isExpired: assignedWebdav.isExpired,
          isQuotaExceeded: assignedWebdav.isQuotaExceeded,
        }
      : null,
  });
});
