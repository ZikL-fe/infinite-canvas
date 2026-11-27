/** 服务端 API 入口：挂载多用户认证、AI 代理计费、云同步、对象存储与管理后台路由。 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";

import { ensureSchemaReady } from "./db/index.ts";
import { env } from "./env.ts";
import { cleanupOrphanedProcessingTasks } from "./lib/billing.ts";
import { accountRoutes } from "./routes/account.ts";
import { adminRoutes } from "./routes/admin.ts";
import { aiRoutes, beginAiShutdown, startVideoTaskMonitor, stopVideoTaskMonitor } from "./routes/ai.ts";
import { assetRoutes } from "./routes/assets.ts";
import { authRoutes } from "./routes/auth.ts";
import { billingRoutes } from "./routes/billing.ts";
import { canvasRoutes } from "./routes/canvas.ts";
import { runtimeRoutes } from "./routes/runtime.ts";
import { storageRoutes } from "./routes/storage.ts";
import { workbenchRoutes } from "./routes/workbench.ts";

await ensureSchemaReady();
await cleanupOrphanedProcessingTasks().catch((error) => {
  console.error("[billing] startup orphan task cleanup failed:", error);
});

const app = new Hono();

const compressMiddleware = compress();
app.use("*", async (c, next) => {
  const path = c.req.path;
  // 跳过 AI 流式代理（SSE）与二进制媒体流，避免引入流缓冲或无效 CPU 压缩开销
  if (
    path.startsWith("/api/ai/") ||
    path.startsWith("/api/storage/download/") ||
    path.startsWith("/api/storage/thumbnail/")
  ) {
    return next();
  }
  return compressMiddleware(c, next);
});

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

void import("./lib/storage-expiry.ts")
  .then((mod) => mod.startStorageExpiryScheduler())
  .catch((error) => console.error("[storage-expiry] scheduler init failed:", error));

void import("./lib/analytics.ts")
  .then((mod) => mod.startLogRetentionScheduler())
  .catch((error) => console.error("[analytics] log retention scheduler init failed:", error));

startVideoTaskMonitor();

let shutdownPromise: Promise<void> | null = null;
const handleShutdownSignal = (signal: string) => {
  if (shutdownPromise) return;
  console.log(`[server] received ${signal}, aborting in-flight sync AI tasks and settling reservations...`);
  stopVideoTaskMonitor();
  shutdownPromise = beginAiShutdown(8000)
    .catch((error) => console.error("[server] graceful shutdown error:", error))
    .finally(() => {
      process.exit(0);
    });
};

process.on("SIGTERM", () => handleShutdownSignal("SIGTERM"));
process.on("SIGINT", () => handleShutdownSignal("SIGINT"));

app.onError((error, c) => {
  console.error("[server] unhandled error:", error);
  return c.json({ error: "服务器内部错误" }, 500);
});

const webDistDir = process.env.WEB_DIST_DIR?.trim() ? resolve(process.env.WEB_DIST_DIR.trim()) : "";
if (webDistDir && existsSync(webDistDir)) {
  const sanitizeAnalyticsId = (value?: string) => (value ?? "").replace(/[^A-Za-z0-9-]/g, "");
  app.get("/config.js", (c) => {
    const body = `window.__RUNTIME_CONFIG__ = {\n  ANALYTICS_GA4_ID: "${sanitizeAnalyticsId(process.env.ANALYTICS_GA4_ID)}",\n  ANALYTICS_BAIDU_ID: "${sanitizeAnalyticsId(process.env.ANALYTICS_BAIDU_ID)}"\n};\n`;
    return c.body(body, 200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    });
  });

  app.use("/assets/*", async (c, next) => {
    await next();
    if (c.res.ok) {
      c.res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
    }
  });

  const staticMiddleware = serveStatic({ root: webDistDir });
  app.use("*", async (c, next) => {
    if (c.req.path.startsWith("/api/")) return next();
    return staticMiddleware(c, next);
  });

  const indexHtmlPath = join(webDistDir, "index.html");
  app.use("*", async (c, next) => {
    if (c.req.path.startsWith("/api/") || (c.req.method !== "GET" && c.req.method !== "HEAD")) {
      return next();
    }
    const file = Bun.file(indexHtmlPath);
    if (!(await file.exists())) return next();
    return new Response(file, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  });
}

export default {
  port: env.PORT,
  idleTimeout: 255,
  maxRequestBodySize: 200 * 1024 * 1024,
  fetch: app.fetch,
};
