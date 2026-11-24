import type { CSSProperties } from "react";
import { useEffect } from "react";
import { Badge, Button, Empty, Modal, Tag, Timeline, Typography, theme as antdTheme } from "antd";
import { Bell, Megaphone } from "lucide-react";
import { Streamdown } from "streamdown";

import {
    getNotificationUnreadCounts,
    timelineNotificationKey,
    useNotificationStore,
} from "@/stores/use-notification-store";
import type { AnnouncementItem, AnnouncementLevel } from "@/services/api/server";

const levelMeta: Record<AnnouncementLevel, { label: string; color: string; dotColor: string; timelineColor: string }> = {
    default: { label: "默认", color: "default", dotColor: "#6b7280", timelineColor: "gray" },
    ongoing: { label: "进行中", color: "blue", dotColor: "#2563eb", timelineColor: "blue" },
    success: { label: "成功", color: "green", dotColor: "#16a34a", timelineColor: "green" },
    warning: { label: "警告", color: "orange", dotColor: "#f97316", timelineColor: "orange" },
    error: { label: "错误", color: "red", dotColor: "#ef4444", timelineColor: "red" },
};

type NotificationBellModalProps = {
    className?: string;
    style?: CSSProperties;
};

export function NotificationBellModal({ className, style }: NotificationBellModalProps) {
    const { token } = antdTheme.useToken();
    const notice = useNotificationStore((state) => state.notice);
    const timeline = useNotificationStore((state) => state.timeline);
    const modalOpen = useNotificationStore((state) => state.modalOpen);
    const activeTab = useNotificationStore((state) => state.activeTab);
    const readNoticeUpdatedAt = useNotificationStore((state) => state.readNoticeUpdatedAt);
    const readTimelineKeys = useNotificationStore((state) => state.readTimelineKeys);
    const fetchNotifications = useNotificationStore((state) => state.fetchNotifications);
    const openModal = useNotificationStore((state) => state.openModal);
    const closeModalAndMarkRead = useNotificationStore((state) => state.closeModalAndMarkRead);
    const setActiveTab = useNotificationStore((state) => state.setActiveTab);

    useEffect(() => {
        void fetchNotifications();
    }, [fetchNotifications]);

    const { hasUnreadNotice, unreadTimelineCount, totalUnread } = getNotificationUnreadCounts({
        notice,
        timeline,
        readNoticeUpdatedAt,
        readTimelineKeys,
    });
    const readTimelineSet = new Set(readTimelineKeys);
    const hasActiveNotice = Boolean(notice?.enabled && notice.content.trim());

    return (
        <>
            <Badge
                count={totalUnread}
                size="small"
                overflowCount={99}
                offset={[-3, 4]}
            >
                <button
                    type="button"
                    className={
                        className ||
                        "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-stone-600 transition-colors hover:bg-black/5 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white [&_svg]:size-4"
                    }
                    style={style}
                    onClick={() => openModal()}
                    aria-label={totalUnread > 0 ? `系统公告（${totalUnread} 条未读）` : "系统公告"}
                    title={totalUnread > 0 ? `系统公告（${totalUnread} 条未读）` : "系统公告"}
                >
                    <Bell className="size-4" />
                </button>
            </Badge>

            <Modal
                open={modalOpen}
                onCancel={closeModalAndMarkRead}
                centered
                width={660}
                destroyOnHidden={false}
                title={
                    <div className="pr-6">
                        <div className="text-lg font-semibold leading-tight" style={{ color: token.colorTextHeading }}>
                            系统公告
                        </div>
                        <div className="mt-0.5 text-xs font-normal" style={{ color: token.colorTextSecondary }}>
                            最新平台更新和通知
                        </div>
                    </div>
                }
                footer={
                    <div className="flex items-center justify-end gap-2">
                        <Button type="primary" onClick={closeModalAndMarkRead}>
                            我知道了
                        </Button>
                    </div>
                }
            >
                <div
                    className="mb-4 grid grid-cols-2 gap-1.5 rounded-full border p-1"
                    style={{
                        borderColor: token.colorBorderSecondary,
                        backgroundColor: token.colorFillAlter,
                    }}
                >
                    <button
                        type="button"
                        onClick={() => setActiveTab("notice")}
                        className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-all"
                        style={
                            activeTab === "notice"
                                ? {
                                      backgroundColor: token.colorBgElevated,
                                      color: token.colorText,
                                      boxShadow: token.boxShadowTertiary,
                                      border: `1px solid ${token.colorBorderSecondary}`,
                                  }
                                : {
                                      backgroundColor: "transparent",
                                      color: token.colorTextSecondary,
                                      border: "1px solid transparent",
                                  }
                        }
                    >
                        <Bell className="size-3.5" />
                        <span>通知</span>
                        {hasUnreadNotice ? (
                            <span
                                className="inline-block size-2 rounded-full"
                                style={{ backgroundColor: token.colorError }}
                            />
                        ) : null}
                    </button>

                    <button
                        type="button"
                        onClick={() => setActiveTab("timeline")}
                        className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-all"
                        style={
                            activeTab === "timeline"
                                ? {
                                      backgroundColor: token.colorBgElevated,
                                      color: token.colorText,
                                      boxShadow: token.boxShadowTertiary,
                                      border: `1px solid ${token.colorBorderSecondary}`,
                                  }
                                : {
                                      backgroundColor: "transparent",
                                      color: token.colorTextSecondary,
                                      border: "1px solid transparent",
                                  }
                        }
                    >
                        <Megaphone className="size-3.5" />
                        <span>时间线</span>
                        {unreadTimelineCount > 0 ? (
                            <Tag color="red" style={{ marginInlineEnd: 0, lineHeight: "16px", paddingInline: 6 }}>
                                {unreadTimelineCount}
                            </Tag>
                        ) : null}
                    </button>
                </div>

                <div className="max-h-[58vh] overflow-y-auto pr-1">
                    {activeTab === "notice" ? (
                        hasActiveNotice && notice ? (
                            <div
                                className="rounded-xl border p-4"
                                style={{
                                    borderColor: token.colorBorderSecondary,
                                    backgroundColor: token.colorFillAlter,
                                }}
                            >
                                {notice.title ? (
                                    <div className="mb-3 flex items-center justify-between gap-2 border-b pb-2.5" style={{ borderColor: token.colorBorderSecondary }}>
                                        <Typography.Title level={5} style={{ margin: 0 }}>
                                            {notice.title}
                                        </Typography.Title>
                                        {notice.updatedAt ? (
                                            <Typography.Text type="secondary" className="shrink-0 text-xs">
                                                {new Date(notice.updatedAt).toLocaleString("zh-CN")}
                                            </Typography.Text>
                                        ) : null}
                                    </div>
                                ) : null}
                                <div className="agent-streamdown text-sm leading-relaxed" style={{ color: token.colorText }}>
                                    <Streamdown
                                        controls={{ code: { copy: true, download: false }, table: { copy: true, download: false, fullscreen: false } }}
                                        linkSafety={{ enabled: false }}
                                    >
                                        {notice.content}
                                    </Streamdown>
                                </div>
                                {!notice.title && notice.updatedAt ? (
                                    <div className="mt-3 border-t pt-2 text-right text-xs" style={{ borderColor: token.colorBorderSecondary, color: token.colorTextSecondary }}>
                                        更新于 {new Date(notice.updatedAt).toLocaleString("zh-CN")}
                                    </div>
                                ) : null}
                            </div>
                        ) : (
                            <div className="py-10">
                                <Empty description="暂无全局公告" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                            </div>
                        )
                    ) : timeline.length ? (
                        <div className="pt-2">
                            <Timeline
                                items={timeline.map((item) => {
                                    const lv = levelMeta[item.level] || levelMeta.default;
                                    const isUnread = !readTimelineSet.has(timelineNotificationKey(item));
                                    return {
                                        color: lv.timelineColor,
                                        children: (
                                            <div
                                                className="rounded-xl border p-3.5"
                                                style={{
                                                    borderColor: isUnread ? token.colorPrimaryBorder : token.colorBorderSecondary,
                                                    backgroundColor: token.colorFillAlter,
                                                }}
                                            >
                                                <div className="flex flex-wrap items-center justify-between gap-2">
                                                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                                                        <Tag color={lv.color} style={{ marginInlineEnd: 0 }}>
                                                            <span className="inline-flex items-center gap-1.5">
                                                                <span className="inline-block size-2 rounded-full" style={{ backgroundColor: lv.dotColor }} />
                                                                <span>{lv.label}</span>
                                                            </span>
                                                        </Tag>
                                                        {item.isPinned ? (
                                                            <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                                                                置顶
                                                            </Tag>
                                                        ) : null}
                                                        {isUnread ? (
                                                            <Tag color="red" style={{ marginInlineEnd: 0 }}>
                                                                未读
                                                            </Tag>
                                                        ) : null}
                                                        <Typography.Text strong className="text-sm">
                                                            {item.title}
                                                        </Typography.Text>
                                                    </div>
                                                    <Typography.Text type="secondary" className="text-xs">
                                                        {new Date(item.createdAt).toLocaleString("zh-CN")}
                                                    </Typography.Text>
                                                </div>
                                                <Typography.Paragraph
                                                    type="secondary"
                                                    className="mt-2 mb-0 whitespace-pre-wrap text-sm leading-relaxed"
                                                    style={{ marginBottom: 0, color: token.colorTextSecondary }}
                                                >
                                                    {item.content}
                                                </Typography.Paragraph>
                                            </div>
                                        ),
                                    };
                                })}
                            />
                        </div>
                    ) : (
                        <div className="py-10">
                            <Empty description="暂无时间线通知" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                        </div>
                    )}
                </div>
            </Modal>
        </>
    );
}
