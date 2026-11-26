/** 管理后台与个人中心共享的轻量格式化、公告配色与统一表格分页配置工具。 */
import type { TablePaginationConfig } from "antd";

import i18n from "@/i18n";

export const ADMIN_PAGE_SIZE_OPTIONS = [10, 20, 30, 50, 100];

/** 将字节数格式化为人类可读的 B / KB / MB / GB 字符串。 */
export function formatBytes(bytes: number) {
    if (!bytes || bytes <= 0) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 获取媒体类型（image / video / audio / file）对应的国际化中文展示标签。 */
export function getKindLabel(kind: string) {
    if (kind === "image" || kind === "video" || kind === "audio" || kind === "file") {
        return i18n.t(`userPanels.mediaKinds.${kind}`);
    }
    return kind;
}

export const ANNOUNCEMENT_LEVEL_STYLE: Record<string, { color: string; bg: string; labelKey: string }> = {
    gray: { color: "#6b7280", bg: "rgba(107,114,128,0.12)", labelKey: "admin.announcements.levels.gray" },
    blue: { color: "#2563eb", bg: "rgba(37,99,235,0.12)", labelKey: "admin.announcements.levels.blue" },
    green: { color: "#16a34a", bg: "rgba(22,163,74,0.12)", labelKey: "admin.announcements.levels.green" },
    orange: { color: "#f97316", bg: "rgba(249,115,22,0.12)", labelKey: "admin.announcements.levels.orange" },
    red: { color: "#ef4444", bg: "rgba(239,68,68,0.12)", labelKey: "admin.announcements.levels.red" },
};

/** 生成后台与个人中心统一的表格分页配置（10/20/30/50/100 切换 + 总数展示）。 */
export function createAdminPagination(params: {
    current: number;
    pageSize: number;
    total: number;
    onChange: (page: number, pageSize: number) => void;
    size?: TablePaginationConfig["size"];
}): TablePaginationConfig {
    return {
        current: params.current,
        pageSize: params.pageSize,
        total: params.total,
        size: params.size,
        showSizeChanger: true,
        pageSizeOptions: ADMIN_PAGE_SIZE_OPTIONS,
        showTotal: (count) => i18n.t("common.totalItems", { count }),
        onChange: (nextPage, nextSize) => {
            if (nextSize !== params.pageSize) {
                params.onChange(1, nextSize);
            } else {
                params.onChange(nextPage, nextSize);
            }
        },
    };
}
