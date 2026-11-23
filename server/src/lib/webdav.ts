/** 服务端 WebDAV 客户端工具：用于把生成媒体直接归档到用户目录，避免浏览器直连产生 CORS 限制。 */
function normalizePath(path: string) {
  return path.trim().replace(/^\/+|\/+$/g, "");
}

function buildWebdavUrl(baseUrl: string, directory: string, relativePath: string) {
  const cleanBase = baseUrl.trim().replace(/\/+$/, "");
  const remotePath = [normalizePath(directory), normalizePath(relativePath)].filter(Boolean).join("/");
  if (!remotePath) return cleanBase;
  return `${cleanBase}/${remotePath.split("/").map(encodeURIComponent).join("/")}`;
}

function encodeBasicAuth(username: string, password: string) {
  return Buffer.from(`${username}:${password}`, "utf8").toString("base64");
}

async function webdavRequest(
  config: { url: string; username: string; password: string },
  fullUrl: string,
  init: RequestInit,
) {
  const headers = new Headers(init.headers);
  if (config.username || config.password) {
    headers.set("Authorization", `Basic ${encodeBasicAuth(config.username, config.password)}`);
  }
  return fetch(fullUrl, { ...init, headers });
}

/** 逐级确保 WebDAV 目标目录存在；遇到 405/423 时通过 PROPFIND 确认目录是否已建好。 */
async function ensureDirectoryPath(
  config: { url: string; username: string; password: string },
  directoryPath: string,
) {
  const parts = normalizePath(directoryPath).split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const dirUrl = buildWebdavUrl(config.url, "", current);
    const res = await webdavRequest(config, dirUrl, { method: "MKCOL" });
    if (res.ok || res.status === 201) continue;
    if (res.status === 405 || res.status === 423 || res.status === 301) {
      const check = await webdavRequest(config, dirUrl, { method: "PROPFIND", headers: { Depth: "0" } });
      if (check.ok || check.status === 207) continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error("WebDAV 认证失败，请管理员检查账号与密码");
    }
    throw new Error(`创建 WebDAV 目录失败（HTTP ${res.status}）`);
  }
}

/** 将二进制文件写入指定 WebDAV 相对路径，并返回完整远端路径。 */
export async function uploadFileToWebdav(params: {
  url: string;
  username: string;
  password: string;
  directory: string;
  relativePath: string;
  data: Uint8Array | ArrayBuffer;
  contentType?: string;
}) {
  const cleanRelative = normalizePath(params.relativePath);
  const subDir = cleanRelative.split("/").slice(0, -1).join("/");
  const fullDir = [normalizePath(params.directory), subDir].filter(Boolean).join("/");
  if (fullDir) {
    await ensureDirectoryPath(params, fullDir);
  }

  const targetUrl = buildWebdavUrl(params.url, params.directory, cleanRelative);
  const res = await webdavRequest(params, targetUrl, {
    method: "PUT",
    headers: { "Content-Type": params.contentType || "application/octet-stream" },
    body: params.data,
  });

  if (!res.ok && res.status !== 201 && res.status !== 204) {
    if (res.status === 401 || res.status === 403) {
      throw new Error("WebDAV 认证失败，请管理员检查账号与密码");
    }
    throw new Error(`上传至 WebDAV 失败（HTTP ${res.status}）`);
  }

  return {
    remotePath: [normalizePath(params.directory), cleanRelative].filter(Boolean).join("/"),
  };
}
