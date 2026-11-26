/** 管理员后台路由入口：统一挂接管理员鉴权并按业务域组合子路由。 */
import { Hono } from "hono";

import { requireAdmin, requireAuth, type AppEnv } from "../middleware/auth.ts";
import { adminChannelsRoutes } from "./admin/channels.ts";
import { adminMediaLogsRoutes } from "./admin/media-logs.ts";
import { adminOverviewRoutes } from "./admin/overview-announcements.ts";
import { adminRedeemRoutes } from "./admin/redeem.ts";
import { adminSettingsRoutes } from "./admin/settings.ts";
import { adminUsersRoutes } from "./admin/users.ts";

export const adminRoutes = new Hono<AppEnv>();

adminRoutes.use("*", requireAuth, requireAdmin);

adminRoutes.route("/", adminOverviewRoutes);
adminRoutes.route("/", adminUsersRoutes);
adminRoutes.route("/", adminRedeemRoutes);
adminRoutes.route("/", adminChannelsRoutes);
adminRoutes.route("/", adminSettingsRoutes);
adminRoutes.route("/", adminMediaLogsRoutes);
