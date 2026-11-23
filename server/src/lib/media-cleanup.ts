/** 云端媒体归属统计与孤立文件级联清理工具：统一服务于画布、生图工作台、视频工作台与资产库。 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { canvasProjects, db, mediaObjects, userAssets, users, workbenchLogs } from "../db/index.ts";
import { deleteS3Object } from "./s3.ts";
import { getS3StorageConfig } from "./settings.ts";

export type MediaSourceModule = "canvas" | "image_workbench" | "video_workbench" | "assets";

/** 递归提取 JSON 结构内全部 `storageKey`（格式为 `kind:id`）。 */
export function extractStorageKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return keys;
  if (Array.isArray(value)) {
    for (const item of value) extractStorageKeys(item, keys);
    return keys;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.storageKey === "string" && record.storageKey.includes(":")) {
    keys.add(record.storageKey);
  }
  for (const child of Object.values(record)) {
    if (child && typeof child === "object") extractStorageKeys(child, keys);
  }
  return keys;
}

/** 统计指定用户的全部活跃业务数据所引用的媒体 ID 集合及所属模块。 */
export async function collectUserMediaReferences(userIds: string[]) {
  const uniqueIds = Array.from(new Set(userIds.filter(Boolean)));
  const moduleMap = new Map<string, Set<MediaSourceModule>>();
  const activeKeySet = new Set<string>();
  if (!uniqueIds.length) return { moduleMap, activeKeySet };

  const [projects, logs, assets] = await Promise.all([
    db.query.canvasProjects.findMany({
      where: and(inArray(canvasProjects.userId, uniqueIds), isNull(canvasProjects.deletedAt)),
      columns: { id: true, userId: true, nodes: true, chatSessions: true },
    }),
    db.query.workbenchLogs.findMany({
      where: and(inArray(workbenchLogs.userId, uniqueIds), isNull(workbenchLogs.deletedAt)),
      columns: { id: true, userId: true, kind: true, payload: true },
    }),
    db.query.userAssets.findMany({
      where: and(inArray(userAssets.userId, uniqueIds), isNull(userAssets.deletedAt)),
      columns: { id: true, userId: true, mediaId: true, data: true },
    }),
  ]);

  const addRef = (mediaId: string, mod: MediaSourceModule) => {
    activeKeySet.add(mediaId);
    let set = moduleMap.get(mediaId);
    if (!set) {
      set = new Set<MediaSourceModule>();
      moduleMap.set(mediaId, set);
    }
    set.add(mod);
  };

  for (const project of projects) {
    const keys = extractStorageKeys([project.nodes, project.chatSessions]);
    for (const key of keys) addRef(key, "canvas");
  }
  for (const log of logs) {
    const mod: MediaSourceModule = log.kind === "video" ? "video_workbench" : "image_workbench";
    const keys = extractStorageKeys(log.payload);
    for (const key of keys) addRef(key, mod);
  }
  for (const asset of assets) {
    if (asset.mediaId) addRef(asset.mediaId, "assets");
    const keys = extractStorageKeys(asset.data);
    for (const key of keys) addRef(key, "assets");
  }

  return { moduleMap, activeKeySet };
}

/** 清理已不再被任何活跃画布、工作台记录或资产引用的云端媒体文件并释放用户配额。 */
export async function cleanupOrphanedUserMedia(userId: string, candidateIds: Iterable<string>) {
  const candidates = Array.from(new Set(candidateIds)).filter((id) => id.includes(":"));
  if (!candidates.length) return 0;

  const { activeKeySet } = await collectUserMediaReferences([userId]);
  const orphanedIds = candidates.filter((id) => !activeKeySet.has(id));
  if (!orphanedIds.length) return 0;

  const rows = await db.query.mediaObjects.findMany({
    where: and(eq(mediaObjects.userId, userId), eq(mediaObjects.status, "active"), inArray(mediaObjects.id, orphanedIds)),
  });
  if (!rows.length) return 0;

  const config = await getS3StorageConfig();
  if (config) {
    await Promise.all(
      rows.flatMap((row) => {
        const tasks = [deleteS3Object(config, row.objectKey).catch(() => undefined)];
        const thumbKey = typeof row.meta?.thumbObjectKey === "string" ? row.meta.thumbObjectKey : "";
        if (thumbKey) tasks.push(deleteS3Object(config, thumbKey).catch(() => undefined));
        return tasks;
      }),
    );
  }

  const totalBytes = rows.reduce((sum, row) => sum + Math.max(0, row.bytes || 0), 0);
  const rowIds = rows.map((row) => row.id);
  await db.transaction(async (tx) => {
    await tx.update(mediaObjects).set({ status: "deleted" }).where(and(eq(mediaObjects.userId, userId), inArray(mediaObjects.id, rowIds)));
    if (totalBytes > 0) {
      await tx
        .update(users)
        .set({
          storageUsedBytes: sql`GREATEST(0, ${users.storageUsedBytes} - ${totalBytes})`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));
    }
  });

  return rows.length;
}

/** 加载指定用户的活跃云端媒体字节映射（键为 `${userId}:${mediaId}`）。 */
export async function loadUserMediaByteMap(userIds: string[]) {
  const uniqueIds = Array.from(new Set(userIds.filter(Boolean)));
  const byteMap = new Map<string, number>();
  if (!uniqueIds.length) return byteMap;

  const rows = await db
    .select({ id: mediaObjects.id, userId: mediaObjects.userId, bytes: mediaObjects.bytes })
    .from(mediaObjects)
    .where(and(inArray(mediaObjects.userId, uniqueIds), eq(mediaObjects.status, "active")));

  for (const row of rows) {
    byteMap.set(`${row.userId}:${row.id}`, Math.max(0, row.bytes || 0));
  }
  return byteMap;
}

/** 汇总单条画布/工作台云端记录引用的媒体数量、云端媒体总大小及结构化元数据大小。 */
export function summarizeWorkspaceMedia(
  userId: string,
  byteMap: Map<string, number>,
  mediaSource: unknown,
  dataSource: unknown,
) {
  const keys = extractStorageKeys(mediaSource);
  let mediaBytes = 0;
  for (const key of keys) {
    mediaBytes += byteMap.get(`${userId}:${key}`) ?? 0;
  }
  const dataBytes = Buffer.byteLength(JSON.stringify(dataSource ?? {}), "utf8");
  return {
    mediaCount: keys.size,
    mediaBytes,
    dataBytes,
  };
}
