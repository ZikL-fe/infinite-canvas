/** 服务端 API 入口：挂载多用户认证、AI 代理计费、云同步、对象存储与管理后台路由。 */
import { Hono } from "hono";
import { cors } from "hono/cors";

import { env } from "./env.ts";
import { accountRoutes } from "./routes/account.ts";
import { adminRoutes } from "./routes/admin.ts";
import { aiRoutes } from "./routes/ai.ts";
import { assetRoutes } from "./routes/assets.ts";
import { authRoutes } from "./routes/auth.ts";
import { billingRoutes } from "./routes/billing.ts";
import { canvasRoutes } from "./routes/canvas.ts";
import { runtimeRoutes } from "./routes/runtime.ts";
import { storageRoutes } from "./routes/storage.ts";
import { workbenchRoutes } from "./routes/workbench.ts";

const app = new Hono();

if (env.CORS_ORIGIN) {
  const origins = env.CORS_ORIGIN.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  app.use(
    "/api/*",
    cors({
      origin: origins.includes("*") ? "*" : origins,
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "X-Billing-Resolution",
        "X-Billing-Ref-Video",
        "X-Billing-Ref-Video-Seconds",
        "X-Billing-Video-Seconds",
        "X-Canvas-Model",
        "X-Client-Task-Id",
        "X-Refresh-Token",
        "x-goog-api-key",
      ],
      exposeHeaders: ["X-Cloud-Media-Ids"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  );
}

app.get("/api/health", (c) => c.json({ ok: true }));

app.route("/api/auth", authRoutes);
app.route("/api/account", accountRoutes);
app.route("/api/ai", aiRoutes);
app.route("/api/billing", billingRoutes);
app.route("/api/runtime", runtimeRoutes);
app.route("/api/storage", storageRoutes);
app.route("/api/canvas", canvasRoutes);
app.route("/api/assets", assetRoutes);
app.route("/api/workbench", workbenchRoutes);
app.route("/api/admin", adminRoutes);

app.onError((error, c) => {
  console.error("[server] unhandled error:", error);
  return c.json({ error: error.message || "服务器内部错误" }, 500);
});

export default {
  port: env.PORT,
  fetch: app.fetch,
};
