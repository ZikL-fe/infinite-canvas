import type { CSSProperties } from "react";
import { Suspense, lazy, useEffect } from "react";
import { Badge, Button, Empty, Modal, Spin, Tag, Timeline, Typography, theme as antdTheme } from "antd";
import { Bell, Megaphone } from "lucide-react";
import { useTranslation } from "react-i18next";

const Streamdown = lazy(() => import("@/components/markdown-streamdown"));

import {
    getNotificationUnreadCounts,
    timelineNotificationKey,
    useNotificationStore,
} from "@/stores/use-notification-store";
import type { AnnouncementLevel } from "@/services/api/server";

const levelMeta: Record<AnnouncementLevel, { color: string; dotColor: string; timelineColor: string }> = {
    default: { color: "default", dotColor: "#6b7280", timelineColor: "gray" },
    ongoing: { color: "blue", dotColor: "#2563eb", timelineColor: "blue" },
    success: { color: "green", dotColor: "#16a34a", timelineColor: "green" },
    warning: { color: "orange", dotColor: "#f97316", timelineColor: "orange" },
    error: { color: "red", dotColor: "#ef4444", timelineColor: "red" },
};

type NotificationBellModalProps = {
    className?: string;
    style?: CSSProperties;
};

export function NotificationBellModal({ className, style }: NotificationBellModalProps) {
    const { i18n, t } = useTranslation();
    const { token } = antdTheme.useToken();
    const notice = useNotificationStore((state) => state.notice);
    const timeline = useNotificationStore((state) => state.timeline);
    const loaded = useNotificationStore((state) => state.loaded);
    const loading = useNotificationStore((state) => state.loading);
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
                    aria-label={totalUnread > 0 ? t("notifications.titleUnread", { count: totalUnread }) : t("notifications.title")}
                    title={totalUnread > 0 ? t("notifications.titleUnread", { count: totalUnread }) : t("notifications.title")}
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
                            {t("notifications.title")}
                        </div>
                        <div className="mt-0.5 text-xs font-normal" style={{ color: token.colorTextSecondary }}>
                            {t("notifications.subtitle")}
                        </div>
                    </div>
                }
                footer={
                    <div className="flex items-center justify-end gap-2">
                        <Button type="primary" onClick={closeModalAndMarkRead}>
                            {t("notifications.acknowledge")}
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
                        <span>{t("notifications.tabNotice")}</span>
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
                        <span>{t("notifications.tabTimeline")}</span>
                        {unreadTimelineCount > 0 ? (
                            <Tag color="red" style={{ marginInlineEnd: 0, lineHeight: "16px", paddingInline: 6 }}>
                                {unreadTimelineCount}
                            </Tag>
                        ) : null}
                    </button>
                </div>

                <div className="max-h-[58vh] overflow-y-auto pr-1">
                    {!loaded && loading ? (
                        <div className="flex justify-center py-12">
                            <Spin />
                        </div>
                    ) : activeTab === "notice" ? (
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
                                                {new Date(notice.updatedAt).toLocaleString(i18n.resolvedLanguage)}
                                            </Typography.Text>
                                        ) : null}
                                    </div>
                                ) : null}
                                <div className="agent-streamdown text-sm leading-relaxed" style={{ color: token.colorText }}>
                                    <Suspense
                                        fallback={
                                            <div className="flex justify-center py-6">
                                                <Spin />
                                            </div>
                                        }
                                    >
                                        <Streamdown
                                            controls={{ code: { copy: true, download: false }, table: { copy: true, download: false, fullscreen: false } }}
                                            linkSafety={{ enabled: false }}
                                        >
                                            {notice.content}
                                        </Streamdown>
                                    </Suspense>
                                </div>
                                {!notice.title && notice.updatedAt ? (
                                    <div className="mt-3 border-t pt-2 text-right text-xs" style={{ borderColor: token.colorBorderSecondary, color: token.colorTextSecondary }}>
                                        {t("notifications.updatedAt", { time: new Date(notice.updatedAt).toLocaleString(i18n.resolvedLanguage) })}
                                    </div>
                                ) : null}
                            </div>
                        ) : (
                            <div className="py-10">
                                <Empty description={t("notifications.emptyNotice")} image={Empty.PRESENTED_IMAGE_SIMPLE} />
                            </div>
                        )
                    ) : timeline.length ? (
                        <div className="pt-2">
                            <Timeline
                                items={timeline.map((item) => {
                                    const lvKey = item.level in levelMeta ? item.level : "default";
                                    const lv = levelMeta[lvKey];
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
                                                                <span>{t(`notifications.levels.${lvKey}`)}</span>
                                                            </span>
                                                        </Tag>
                                                        {item.isPinned ? (
                                                            <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                                                                {t("notifications.pinned")}
                                                            </Tag>
                                                        ) : null}
                                                        {isUnread ? (
                                                            <Tag color="red" style={{ marginInlineEnd: 0 }}>
                                                                {t("notifications.unread")}
                                                            </Tag>
                                                        ) : null}
                                                        <Typography.Text strong className="text-sm">
                                                            {item.title}
                                                        </Typography.Text>
                                                    </div>
                                                    <Typography.Text type="secondary" className="text-xs">
                                                        {new Date(item.createdAt).toLocaleString(i18n.resolvedLanguage)}
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
                            <Empty description={t("notifications.emptyTimeline")} image={Empty.PRESENTED_IMAGE_SIMPLE} />
                        </div>
                    )}
                </div>
            </Modal>
        </>
    );
}
