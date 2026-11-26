/** 画布与工作台增量同步游标解析与服务端单调时间戳工具。 */

/** 解析 `updatedSince` 查询参数为合法 `Date`，无效时返回 `null`。 */
export function parseSinceParam(raw?: string): Date | null {
  if (!raw?.trim()) return null;
  const parsed = new Date(raw.trim());
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** 统一以服务端当前时间生成更新时间，避免客户端系统时钟偏快污染服务端增量同步游标。 */
export function resolveServerUpdatedAt(): Date {
  return new Date();
}
