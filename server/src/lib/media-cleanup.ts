/** 云端媒体归属统计与孤立文件级联清理工具：统一服务于画布、生图工作台、视频工作台与资产库。 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { canvasProjects, db, mediaObjects, userAssets, users, workbenchLogs } from "../db/index.ts";
import { deleteS3ObjectStrict } from "./s3.ts";
import { getS3StorageConfig } from "./settings.ts";

export type MediaSourceModule = "canvas" | "image_workbench" | "video_workbench" | "assets";

/** 从媒体元数据中读取已记录的缩略图字节数。 */
export function getMediaThumbBytes(meta: Record<string, unknown> | null | undefined): number {
  const raw = Number(meta?.thumbBytes ?? 0);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
}

/** 计算媒体原文件与缩略图合计占用的云端存储字节数。 */
export function getMediaTotalBytes(bytes: number | null | undefined, meta: Record<string, unknown> | null | undefined): number {
  return Math.max(0, Number(bytes || 0)) + getMediaThumbBytes(meta);
}

/** SQL 表达式：单条媒体原文件与 `meta.thumbBytes` 合计占用的字节数。 */
export const mediaTotalBytesSql = sql<number>`(${mediaObjects.bytes} + (CASE WHEN COALESCE(${mediaObjects.meta}->>'thumbBytes', '') ~ '^[0-9]+$' THEN (${mediaObjects.meta}->>'thumbBytes')::bigint ELSE 0 END))`;

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

export type MediaDeletableRow = {
  id: string;
  userId: string;
  objectKey: string;
  bytes: number;
  status: string;
  meta: Record<string, unknown> | null;
};

/** 统一的媒体删除服务：先严格删除对象存储原文件与缩略图，再事务内原子标记 deleted 并扣减用户配额，可选级联清理业务引用。 */
export async function deleteMediaRowsWithQuota(
  rows: MediaDeletableRow[],
  options?: { purgeReferences?: boolean },
) {
  const activeRows = rows.filter((row) => row.status === "active");
  const pendingIds = rows.filter((row) => row.status === "pending").map((row) => row.id);
  if (pendingIds.length > 0) {
    await db
      .update(mediaObjects)
      .set({ status: "deleted" })
      .where(and(inArray(mediaObjects.id, pendingIds), eq(mediaObjects.status, "pending")));
  }
  if (!activeRows.length) {
    return { deletedCount: pendingIds.length, freedBytesTotal: 0, failedCount: 0, firstError: "" };
  }

  const config = await getS3StorageConfig();
  if (!config) {
    return {
      deletedCount: 0,
      freedBytesTotal: 0,
      failedCount: activeRows.length,
      firstError: "管理员尚未配置对象存储，无法从存储桶删除文件",
    };
  }

  const deletedRows: MediaDeletableRow[] = [];
  let failedCount = 0;
  let firstError = "";

  await Promise.all(
    activeRows.map(async (media) => {
      try {
        await deleteS3ObjectStrict(config, media.objectKey);
        const thumbKey = typeof media.meta?.thumbObjectKey === "string" ? media.meta.thumbObjectKey : "";
        if (thumbKey) {
          await deleteS3ObjectStrict(config, thumbKey).catch(() => undefined);
        }
        deletedRows.push(media);
      } catch (error) {
        failedCount += 1;
        if (!firstError) {
          firstError = error instanceof Error ? error.message : "对象存储删除失败";
        }
      }
    }),
  );

  if (!deletedRows.length) {
    return { deletedCount: 0, freedBytesTotal: 0, failedCount, firstError };
  }

  const dbResult = await db.transaction(async (tx) => {
    const updated = await tx
      .update(mediaObjects)
      .set({ status: "deleted" })
      .where(and(inArray(mediaObjects.id, deletedRows.map((row) => row.id)), eq(mediaObjects.status, "active")))
      .returning({ id: mediaObjects.id, userId: mediaObjects.userId, bytes: mediaObjects.bytes, meta: mediaObjects.meta });

    if (!updated.length) {
      return { deletedCount: 0, freedBytesTotal: 0, deletedIdsByUser: new Map<string, string[]>() };
    }

    const bytesByUser = new Map<string, number>();
    const deletedIdsByUser = new Map<string, string[]>();
    let freedBytesTotal = 0;
    for (const row of updated) {
      const bytes = getMediaTotalBytes(row.bytes, row.meta);
      freedBytesTotal += bytes;
      if (bytes > 0) bytesByUser.set(row.userId, (bytesByUser.get(row.userId) ?? 0) + bytes);
      const list = deletedIdsByUser.get(row.userId);
      if (list) list.push(row.id);
      else deletedIdsByUser.set(row.userId, [row.id]);
    }

    for (const [ownerId, freed] of bytesByUser) {
      await tx
        .update(users)
        .set({
          storageUsedBytes: sql`GREATEST(0, ${users.storageUsedBytes} - ${freed})`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, ownerId));
    }

    return { deletedCount: updated.length, freedBytesTotal, deletedIdsByUser };
  });

  if (options?.purgeReferences !== false && dbResult.deletedIdsByUser.size > 0) {
    await purgeMediaReferencesForUsers(dbResult.deletedIdsByUser).catch((err) => {
      console.warn("[media-cleanup] 级联清理媒体关联业务引用失败:", err);
    });
  }

  return { deletedCount: dbResult.deletedCount, freedBytesTotal: dbResult.freedBytesTotal, failedCount, firstError };
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

  const { deletedCount } = await deleteMediaRowsWithQuota(rows, { purgeReferences: false });
  return deletedCount;
}

function filterPayloadRefs(list: unknown, deletedSet: Set<string>) {
  if (!Array.isArray(list)) return { next: list, changed: false };
  const next = list.filter((item) => {
    if (!item || typeof item !== "object") return true;
    const key = (item as { storageKey?: unknown }).storageKey;
    return !(typeof key === "string" && deletedSet.has(key));
  });
  return { next, changed: next.length !== list.length };
}

/** 在物理删除媒体文件后，同步清理引用了这些 mediaId 的资产、工作台记录与画布节点引用，避免产生死链与 404 轮询。 */
export async function purgeMediaReferencesForUsers(deletedIdsByUser: Map<string, string[]>) {
  const now = new Date();
  for (const [userId, rawIds] of deletedIdsByUser) {
    const deletedSet = new Set(rawIds.filter((id) => id.includes(":")));
    if (!deletedSet.size) continue;

    const [assets, logs, projects] = await Promise.all([
      db.query.userAssets.findMany({
        where: and(eq(userAssets.userId, userId), isNull(userAssets.deletedAt)),
        columns: { id: true, mediaId: true, data: true },
      }),
      db.query.workbenchLogs.findMany({
        where: and(eq(workbenchLogs.userId, userId), isNull(workbenchLogs.deletedAt)),
        columns: { id: true, kind: true, payload: true },
      }),
      db.query.canvasProjects.findMany({
        where: and(eq(canvasProjects.userId, userId), isNull(canvasProjects.deletedAt)),
        columns: { id: true, version: true, nodes: true, connections: true, chatSessions: true },
      }),
    ]);

    const assetIdsToDelete: string[] = [];
    for (const asset of assets) {
      if (asset.mediaId && deletedSet.has(asset.mediaId)) {
        assetIdsToDelete.push(asset.id);
        continue;
      }
      const keys = extractStorageKeys(asset.data);
      if (Array.from(keys).some((k) => deletedSet.has(k))) {
        assetIdsToDelete.push(asset.id);
      }
    }
    if (assetIdsToDelete.length) {
      await db
        .update(userAssets)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(userAssets.userId, userId), inArray(userAssets.id, assetIdsToDelete)));
    }

    const logIdsToDelete: string[] = [];
    for (const log of logs) {
      const keys = extractStorageKeys(log.payload);
      if (!Array.from(keys).some((k) => deletedSet.has(k))) continue;

      const payload = { ...(log.payload || {}) } as Record<string, unknown>;
      const prevImages = Array.isArray(payload.images) ? payload.images : [];
      const { next: nextImages, changed: imagesChanged } = filterPayloadRefs(payload.images, deletedSet);
      const { next: nextRefs, changed: refsChanged } = filterPayloadRefs(payload.references, deletedSet);

      const prevVideo = payload.video && typeof payload.video === "object" ? (payload.video as { storageKey?: unknown }) : null;
      const videoDeleted = Boolean(prevVideo && typeof prevVideo.storageKey === "string" && deletedSet.has(prevVideo.storageKey));

      if (log.kind === "image" && prevImages.length > 0 && Array.isArray(nextImages) && nextImages.length === 0) {
        logIdsToDelete.push(log.id);
        continue;
      }
      if (log.kind === "video" && prevVideo && videoDeleted) {
        logIdsToDelete.push(log.id);
        continue;
      }
      if (!imagesChanged && !refsChanged && !videoDeleted) continue;

      if (imagesChanged && Array.isArray(nextImages)) {
        payload.images = nextImages;
        payload.successCount = nextImages.length;
      }
      if (refsChanged) payload.references = nextRefs;
      if (videoDeleted) delete payload.video;

      await db
        .update(workbenchLogs)
        .set({ payload, updatedAt: now })
        .where(and(eq(workbenchLogs.id, log.id), eq(workbenchLogs.userId, userId)));
    }
    if (logIdsToDelete.length) {
      await db
        .update(workbenchLogs)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(workbenchLogs.userId, userId), inArray(workbenchLogs.id, logIdsToDelete)));
    }

    for (const project of projects) {
      const keys = extractStorageKeys([project.nodes, project.chatSessions]);
      if (!Array.from(keys).some((k) => deletedSet.has(k))) continue;

      let projectChanged = false;
      const removedNodeIds = new Set<string>();
      const nextNodes: unknown[] = [];

      for (const rawNode of project.nodes) {
        if (!rawNode || typeof rawNode !== "object") {
          nextNodes.push(rawNode);
          continue;
        }
        const node = rawNode as Record<string, unknown>;
        const nodeId = typeof node.id === "string" ? node.id : "";
        const metadata = node.metadata && typeof node.metadata === "object" ? ({ ...(node.metadata as Record<string, unknown>) }) : null;
        if (!metadata) {
          nextNodes.push(rawNode);
          continue;
        }

        if (Array.isArray(metadata.images) && metadata.images.length > 0) {
          const remaining = metadata.images.filter((img) => {
            if (!img || typeof img !== "object") return true;
            const key = (img as { storageKey?: unknown }).storageKey;
            return !(typeof key === "string" && deletedSet.has(key));
          });
          if (remaining.length === 0) {
            if (nodeId) removedNodeIds.add(nodeId);
            projectChanged = true;
            continue;
          }
          if (remaining.length !== metadata.images.length) {
            projectChanged = true;
            const primary =
              (remaining.find((img) => (img as { id?: unknown }).id === metadata.primaryImageId) as Record<string, unknown> | undefined) ||
              (remaining[0] as Record<string, unknown>);
            metadata.images = remaining;
            metadata.count = remaining.length;
            metadata.primaryImageId = primary?.id;
            metadata.storageKey = primary?.storageKey;
            metadata.content = primary?.content || "";
            metadata.naturalWidth = primary?.naturalWidth;
            metadata.naturalHeight = primary?.naturalHeight;
            metadata.bytes = primary?.bytes;
            metadata.mimeType = primary?.mimeType;
            nextNodes.push({ ...node, metadata });
            continue;
          }
        }

        if (typeof metadata.storageKey === "string" && deletedSet.has(metadata.storageKey)) {
          if (nodeId) removedNodeIds.add(nodeId);
          projectChanged = true;
          continue;
        }

        if (Array.isArray(metadata.references)) {
          const nextNodeRefs = metadata.references.filter((ref) => !(typeof ref === "string" && deletedSet.has(ref)));
          if (nextNodeRefs.length !== metadata.references.length) {
            metadata.references = nextNodeRefs;
            projectChanged = true;
          }
        }

        nextNodes.push({ ...node, metadata });
      }

      const nextConnections = removedNodeIds.size
        ? project.connections.filter((rawConn) => {
            if (!rawConn || typeof rawConn !== "object") return true;
            const conn = rawConn as { fromNodeId?: unknown; toNodeId?: unknown };
            return !(
              (typeof conn.fromNodeId === "string" && removedNodeIds.has(conn.fromNodeId)) ||
              (typeof conn.toNodeId === "string" && removedNodeIds.has(conn.toNodeId))
            );
          })
        : project.connections;

      let sessionsChanged = false;
      const nextSessions = project.chatSessions.map((rawSession) => {
        if (!rawSession || typeof rawSession !== "object") return rawSession;
        const session = rawSession as { messages?: unknown[] };
        if (!Array.isArray(session.messages)) return rawSession;
        const nextMessages = session.messages.map((rawMsg) => {
          if (!rawMsg || typeof rawMsg !== "object") return rawMsg;
          const msg = rawMsg as { references?: unknown };
          const { next, changed } = filterPayloadRefs(msg.references, deletedSet);
          if (!changed) return rawMsg;
          sessionsChanged = true;
          return { ...msg, references: next };
        });
        return sessionsChanged ? { ...session, messages: nextMessages } : rawSession;
      });

      if (projectChanged || sessionsChanged) {
        await db
          .update(canvasProjects)
          .set({
            nodes: nextNodes,
            connections: nextConnections,
            chatSessions: nextSessions,
            version: project.version + 1,
            updatedAt: now,
          })
          .where(and(eq(canvasProjects.id, project.id), eq(canvasProjects.userId, userId)));
      }
    }
  }
}

/** 加载指定用户的活跃云端媒体字节映射（键为 `${userId}:${mediaId}`）。 */
export async function loadUserMediaByteMap(userIds: string[]) {
  const uniqueIds = Array.from(new Set(userIds.filter(Boolean)));
  const byteMap = new Map<string, number>();
  if (!uniqueIds.length) return byteMap;

  const rows = await db
    .select({ id: mediaObjects.id, userId: mediaObjects.userId, bytes: mediaObjects.bytes, meta: mediaObjects.meta })
    .from(mediaObjects)
    .where(and(inArray(mediaObjects.userId, uniqueIds), eq(mediaObjects.status, "active")));

  for (const row of rows) {
    byteMap.set(`${row.userId}:${row.id}`, getMediaTotalBytes(row.bytes, row.meta));
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
