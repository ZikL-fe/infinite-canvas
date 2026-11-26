/** 个人后台概览面板、消耗趋势卡片与平台公告卡片。 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Avatar, Button, Card, Col, DatePicker, Descriptions, Empty, Form, Image, Input, InputNumber, Modal, Popconfirm, Progress, Radio, Row, Segmented, Select, Space, Spin, Statistic, Switch, Table, Tabs, Tag, Tooltip, Typography, theme as antdTheme } from "antd";
import type { Dayjs } from "dayjs";
import type { TFunction } from "i18next";
import localforage from "localforage";
import { AudioLines, Bell, Download, Eye, FileIcon, Gift, ImageIcon, KeyRound, Laptop, LogOut, Megaphone, Pin, RefreshCw, RotateCcw, Save, Search, Trash2, TrendingUp, User, Video } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { useBatchZipDownload } from "@/hooks/use-batch-zip-download";
import { useEmailCodeSender } from "@/hooks/use-email-code-sender";
import { formatCompactCredits, formatExactCredits } from "@/lib/format-number";
import { createImageThumbnail, createVideoThumbnail } from "@/lib/image-thumbnail";
import { getMediaThumbBytes, getMediaTotalBytes } from "@/lib/image-utils";
import {
    formatCreditAlertCopy,
    formatStorageAlertCopy,
    formatStorageQuotaCaption,
    resolveCreditAlert,
    resolveStorageAlert,
} from "@/lib/quota-alerts";
import { previewUrlFor, purgeLocalStoredImages } from "@/services/image-storage";
import { ADMIN_TABLE_CLASS, ADMIN_TABLE_SCROLL, TableRowActions } from "@/pages/admin/components/table-row-actions";
import { notifyCloudWorkspaceChanged, WORKSPACE_CHANGED_EVENT } from "@/services/cloud-media";
import { deleteCanvasProjectsWithCloud, syncCloudWorkspace } from "@/services/cloud-sync";
import { purgeLocalStoredMedia } from "@/services/file-storage";
import { deleteWorkbenchLogsWithCloud } from "@/services/workbench-sync";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

import {
    accountApi,
    adminApi,
    billingApi,
    canvasApi,
    mediaDownloadFilename,
    storageApi,
    workbenchApi,
    type AccountOverviewResponse,
    type AccountProfileResponse,
    type AccountSessionItem,
    type AnnouncementItem,
    type CreditLedgerItem,
    type CreditLedgerSummary,
    type DailyTrendItem,
    type MediaItem,
    type MediaSourceModule,
    type StorageGrantItem,
    type TopModelUsageItem,
} from "@/services/api/server";
import { useUserStore } from "@/stores/use-user-store";

import { formatBytes } from "./shared";

export function ConsumptionTrendCard({
    title,
    days,
    onDaysChange,
    dailyTrend,
    topModels,
    rangeConsumedCredits,
    rangeCalls,
    loading,
}: {
    title: string;
    days: number;
    onDaysChange: (days: number) => void;
    dailyTrend: DailyTrendItem[];
    topModels: TopModelUsageItem[];
    rangeConsumedCredits: number;
    rangeCalls: number;
    loading?: boolean;
}) {
    const { t } = useTranslation();
    const { token } = antdTheme.useToken();
    const maxCredits = Math.max(0.0001, ...dailyTrend.map((d) => d.credits));
    const totalTopCredits = topModels.reduce((sum, item) => sum + item.credits, 0);

    return (
        <Row gutter={[16, 16]}>
            <Col xs={24} lg={15}>
                <Card
                    loading={loading}
                    title={
                        <span className="inline-flex items-center gap-2">
                            <TrendingUp className="size-4" />
                            {title}
                        </span>
                    }
                    extra={
                        <Space wrap>
                            <Typography.Text type="secondary" className="text-xs">
                                {t("userPanels.trendCard.rangeSummary", { credits: rangeConsumedCredits, calls: rangeCalls })}
                            </Typography.Text>
                            <Segmented
                                size="small"
                                value={days}
                                onChange={(val) => onDaysChange(Number(val))}
                                options={[
                                    { label: t("userPanels.trendCard.daysOption", { days: 7 }), value: 7 },
                                    { label: t("userPanels.trendCard.daysOption", { days: 14 }), value: 14 },
                                    { label: t("userPanels.trendCard.daysOption", { days: 30 }), value: 30 },
                                ]}
                            />
                        </Space>
                    }
                >
                    {dailyTrend.length ? (
                        <div className="overflow-x-auto pb-1">
                            <div className={`flex h-48 items-end gap-1.5 pt-4 ${dailyTrend.length > 14 ? "min-w-[380px]" : ""}`}>
                                {dailyTrend.map((item) => {
                                    const heightPct = item.credits > 0 ? Math.max(6, Math.round((item.credits / maxCredits) * 100)) : 2;
                                    return (
                                        <Tooltip
                                            key={item.date}
                                            title={t("userPanels.trendCard.tooltip", {
                                                date: item.date,
                                                credits: item.credits,
                                                calls: item.calls,
                                            })}
                                        >
                                            <div className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5">
                                                <div className="flex w-full flex-1 items-end justify-center">
                                                    <div
                                                        className="w-full max-w-7 rounded-t transition-all"
                                                        style={{
                                                            height: `${heightPct}%`,
                                                            backgroundColor: item.credits > 0 ? token.colorPrimary : token.colorBorderSecondary,
                                                            opacity: item.credits > 0 ? 0.85 : 0.45,
                                                        }}
                                                    />
                                                </div>
                                                <span className="truncate text-[10px]" style={{ color: token.colorTextSecondary }}>
                                                    {item.date.slice(5)}
                                                </span>
                                            </div>
                                        </Tooltip>
                                    );
                                })}
                            </div>
                        </div>
                    ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("userPanels.trendCard.noTrendData")} />
                    )}
                </Card>
            </Col>
            <Col xs={24} lg={9}>
                <Card loading={loading} title={t("userPanels.trendCard.topModelsTitle", { days })} className="h-full">
                    {topModels.length ? (
                        <div className="flex flex-col gap-3">
                            {topModels.map((item) => {
                                const percent = totalTopCredits > 0 ? Math.round((item.credits / totalTopCredits) * 100) : 0;
                                return (
                                    <div key={item.model} className="flex flex-col gap-1">
                                        <div className="flex items-center justify-between gap-2 text-sm">
                                            <span className="truncate font-medium">{item.model}</span>
                                            <Typography.Text type="secondary" className="shrink-0 text-xs">
                                                {t("userPanels.trendCard.itemSummary", { credits: item.credits, calls: item.calls })}
                                            </Typography.Text>
                                        </div>
                                        <Progress percent={percent} size="small" showInfo={false} />
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("userPanels.trendCard.noModelData")} />
                    )}
                </Card>
            </Col>
        </Row>
    );
}

const announcementLevelStyle: Record<AnnouncementItem["level"], { color: string; dotColor: string }> = {
    default: { color: "default", dotColor: "#6b7280" },
    ongoing: { color: "blue", dotColor: "#2563eb" },
    success: { color: "green", dotColor: "#16a34a" },
    warning: { color: "orange", dotColor: "#f97316" },
    error: { color: "red", dotColor: "#ef4444" },
};

export function AnnouncementsCard({
    items,
    loading,
    extra,
}: {
    items: AnnouncementItem[];
    loading?: boolean;
    extra?: React.ReactNode;
}) {
    const { t, i18n } = useTranslation();
    const locale = i18n.resolvedLanguage || undefined;
    const [detail, setDetail] = useState<AnnouncementItem | null>(null);

    const getLevelInfo = (level: AnnouncementItem["level"]) => {
        const key = level in announcementLevelStyle ? level : "default";
        return {
            ...announcementLevelStyle[key],
            label: t(`userPanels.announcementLevels.${key}`),
        };
    };

    return (
        <>
            <Card
                loading={loading}
                title={
                    <span className="inline-flex items-center gap-2">
                        <Megaphone className="size-4" />
                        {t("userPanels.announcementsCard.title")}
                    </span>
                }
                extra={extra}
            >
                {items.length ? (
                    <div className="flex flex-col gap-2.5">
                        {items.map((item) => {
                            const lvl = getLevelInfo(item.level);
                            return (
                                <div
                                    key={item.id}
                                    onClick={() => setDetail(item)}
                                    className="cursor-pointer rounded-lg border border-black/10 p-3 transition hover:border-black/25 dark:border-white/10 dark:hover:border-white/25"
                                >
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div className="flex items-center gap-2">
                                            {item.isPinned ? (
                                                <Tag color="red" icon={<Pin className="mr-0.5 inline size-3" />}>
                                                    {t("userPanels.announcementsCard.pinned")}
                                                </Tag>
                                            ) : null}
                                            <Tag color={lvl.color}>
                                                <span className="inline-flex items-center gap-1.5">
                                                    <span className="inline-block size-2 rounded-full" style={{ backgroundColor: lvl.dotColor }} />
                                                    <span>{lvl.label}</span>
                                                </span>
                                            </Tag>
                                            <span className="font-medium">{item.title}</span>
                                        </div>
                                        <Typography.Text type="secondary" className="text-xs">
                                            {new Date(item.createdAt).toLocaleString(locale)}
                                        </Typography.Text>
                                    </div>
                                    <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ margin: "6px 0 0" }}>
                                        {item.content}
                                    </Typography.Paragraph>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("userPanels.announcementsCard.empty")} />
                )}
            </Card>

            <Modal open={Boolean(detail)} title={detail?.title} onCancel={() => setDetail(null)} footer={null}>
                {detail ? (
                    <div className="flex flex-col gap-3">
                        <Space>
                            {detail.isPinned ? <Tag color="red">{t("userPanels.announcementsCard.pinned")}</Tag> : null}
                            <Tag color={getLevelInfo(detail.level).color}>{getLevelInfo(detail.level).label}</Tag>
                            <Typography.Text type="secondary" className="text-xs">
                                {t("userPanels.announcementsCard.publishedAt", { time: new Date(detail.createdAt).toLocaleString(locale) })}
                            </Typography.Text>
                        </Space>
                        <div className="whitespace-pre-wrap text-sm leading-6">{detail.content}</div>
                    </div>
                ) : null}
            </Modal>
        </>
    );
}

export function UserOverviewPanel({ onOpenWallet, onOpenMedia }: { onOpenWallet?: () => void; onOpenMedia?: () => void }) {
    const { t, i18n } = useTranslation();
    const locale = i18n.resolvedLanguage || undefined;
    const { message } = App.useApp();
    const user = useUserStore((state) => state.user);
    const [days, setDays] = useState(7);
    const [data, setData] = useState<AccountOverviewResponse | null>(null);
    const [loading, setLoading] = useState(true);

    const loadOverview = useCallback(
        async (targetDays = days) => {
            setLoading(true);
            try {
                setData(await accountApi.getOverview(targetDays));
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("userPanels.overview.loadFailed"));
            } finally {
                setLoading(false);
            }
        },
        [days, message, t],
    );

    useEffect(() => {
        void loadOverview(days);
    }, [days, loadOverview]);

    const creditAlert = data ? resolveCreditAlert(data.creditBalance, data.lowBalanceThreshold ?? user?.lowBalanceThreshold) : null;
    const storageAlert = data
        ? resolveStorageAlert({
              usedBytes: data.storageUsedBytes,
              quotaBytes: data.storageQuotaBytes,
              expiresAt: data.storageQuotaExpiresAt,
              expiringAt: data.storageExpiringAt ?? user?.storageExpiringAt,
              expiringBytes: data.storageExpiringBytes ?? user?.storageExpiringBytes,
              remainingAfterExpiryBytes: data.storageRemainingAfterExpiryBytes ?? user?.storageRemainingAfterExpiryBytes,
              expiringWillExceed: data.storageExpiringWillExceed ?? user?.storageExpiringWillExceed,
              warningDays: data.storageWarningDays ?? user?.storageWarningDays,
          })
        : null;
    const creditAlertCopy = creditAlert ? formatCreditAlertCopy(t, creditAlert) : null;
    const storageAlertCopy = storageAlert ? formatStorageAlertCopy(t, storageAlert, locale) : null;

    return (
        <div className="flex flex-col gap-5">
            {creditAlertCopy || storageAlertCopy ? (
                <div className="flex flex-col gap-3">
                    {creditAlertCopy && creditAlert ? (
                        <Alert
                            type={creditAlert.level === "error" ? "error" : "warning"}
                            showIcon
                            title={creditAlertCopy.title}
                            description={creditAlertCopy.description}
                            action={
                                onOpenWallet ? (
                                    <Button size="small" type="primary" onClick={onOpenWallet}>
                                        {t("userPanels.overview.goRedeem")}
                                    </Button>
                                ) : undefined
                            }
                        />
                    ) : null}
                    {storageAlertCopy && storageAlert ? (
                        <Alert
                            type={storageAlert.level === "error" ? "error" : "warning"}
                            showIcon
                            title={storageAlertCopy.title}
                            description={storageAlertCopy.description}
                            action={
                                onOpenMedia ? (
                                    <Button size="small" onClick={onOpenMedia}>
                                        {t("userPanels.overview.goManageStorage")}
                                    </Button>
                                ) : undefined
                            }
                        />
                    ) : null}
                </div>
            ) : null}

            <Row gutter={[16, 16]}>
                <Col xs={24} sm={12} xl={6}>
                    <Card loading={loading}>
                        <Tooltip title={t("userPanels.overview.exactBalance", { value: formatExactCredits(data?.creditBalance ?? 0) })}>
                            <div>
                                <Statistic
                                    title={t("userPanels.overview.currentCredits")}
                                    value={formatCompactCredits(data?.creditBalance ?? 0)}
                                    suffix={
                                        onOpenWallet ? (
                                            <Button type="link" size="small" onClick={onOpenWallet}>
                                                {t("userPanels.overview.goRedeem")}
                                            </Button>
                                        ) : null
                                    }
                                />
                            </div>
                        </Tooltip>
                    </Card>
                </Col>
                <Col xs={24} sm={12} xl={6}>
                    <Card loading={loading}>
                        <Tooltip title={t("userPanels.overview.exactValue", { value: formatExactCredits(data?.todayConsumedCredits ?? 0) })}>
                            <div>
                                <Statistic title={t("userPanels.overview.todayConsumed")} value={formatCompactCredits(data?.todayConsumedCredits ?? 0)} />
                            </div>
                        </Tooltip>
                    </Card>
                </Col>
                <Col xs={24} sm={12} xl={6}>
                    <Card loading={loading}>
                        <Tooltip title={t("userPanels.overview.exactValue", { value: formatExactCredits(data?.totalConsumedCredits ?? 0) })}>
                            <div>
                                <Statistic title={t("userPanels.overview.totalConsumed")} value={formatCompactCredits(data?.totalConsumedCredits ?? 0)} />
                            </div>
                        </Tooltip>
                    </Card>
                </Col>
                <Col xs={24} sm={12} xl={6}>
                    <Card loading={loading}>
                        <Statistic
                            title={t("userPanels.overview.storageAndCanvas")}
                            value={`${formatBytes(data?.storageUsedBytes ?? 0)} / ${formatBytes(data?.storageQuotaBytes ?? 0)}`}
                            suffix={
                                <Typography.Text type="secondary" className="text-xs">
                                    {t("userPanels.overview.canvasCount", { count: data?.canvasProjectCount ?? 0 })}
                                </Typography.Text>
                            }
                        />
                    </Card>
                </Col>
            </Row>

            <ConsumptionTrendCard
                title={t("userPanels.overview.trendTitle")}
                days={days}
                onDaysChange={setDays}
                dailyTrend={data?.dailyTrend ?? []}
                topModels={data?.topModels ?? []}
                rangeConsumedCredits={data?.rangeConsumedCredits ?? 0}
                rangeCalls={data?.rangeCalls ?? 0}
                loading={loading}
            />

            <AnnouncementsCard items={data?.announcements ?? []} loading={loading} />
        </div>
    );
}

