/** 个人钱包充值/兑换面板与 NewAPI 风格使用日志面板。 */
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

import { LedgerDetailModal } from "./ledger-detail-modal";
import { emptyLedgerSummary, formatBytes, formatDurationSec, formatLedgerUsageDetail, getLedgerReasonMeta, getLedgerTaskStatus, getLedgerTimingStats, LedgerDeltaTag } from "./shared";

export function MyWalletPanel({ compact = false, onOpenLogs }: { compact?: boolean; onOpenLogs?: () => void }) {
    const { t, i18n } = useTranslation();
    const locale = i18n.resolvedLanguage || undefined;
    const { message } = App.useApp();
    const user = useUserStore((state) => state.user);
    const setUser = useUserStore((state) => state.setUser);

    const [balance, setBalance] = useState<number>(user?.creditBalance ?? 0);
    const [items, setItems] = useState<CreditLedgerItem[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(compact ? 10 : 20);
    const [summary, setSummary] = useState<CreditLedgerSummary>(emptyLedgerSummary);
    const [loading, setLoading] = useState(true);
    const [initialized, setInitialized] = useState(false);

    const [reasonFilter, setReasonFilter] = useState("");
    const [dateRange, setDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);

    const [redeemCode, setRedeemCode] = useState("");
    const [redeeming, setRedeeming] = useState(false);
    const [detailItem, setDetailItem] = useState<CreditLedgerItem | null>(null);

    const loadLedger = useCallback(
        async (targetPage = page, nextReason = reasonFilter, nextRange = dateRange, nextPageSize = pageSize, notifySuccess = false) => {
            setLoading(true);
            try {
                const startDate = nextRange?.[0] ? nextRange[0].startOf("day").toISOString() : undefined;
                const endDate = nextRange?.[1] ? nextRange[1].endOf("day").toISOString() : undefined;
                const res = await billingApi.getLedger({
                    category: "recharge",
                    reason: nextReason || undefined,
                    startDate,
                    endDate,
                    page: targetPage,
                    pageSize: nextPageSize,
                });
                setBalance(res.balance);
                setItems(res.items);
                setTotal(res.total);
                setSummary(res.summary);
                const latestUser = useUserStore.getState().user;
                if (latestUser) setUser({ ...latestUser, creditBalance: res.balance });
                if (notifySuccess) message.success(t("common.refreshed"));
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("userPanels.wallet.loadFailed"));
            } finally {
                setLoading(false);
                setInitialized(true);
            }
        },
        [dateRange, message, page, pageSize, reasonFilter, setUser, t],
    );

    useEffect(() => {
        void loadLedger(page, reasonFilter, dateRange);
    }, [dateRange, loadLedger, page, reasonFilter]);

    const handleRedeem = async () => {
        const code = redeemCode.trim();
        if (!code) {
            message.warning(t("userPanels.wallet.enterCodeWarning"));
            return;
        }
        setRedeeming(true);
        try {
            const res = await billingApi.redeem(code);
            message.success(t("userPanels.wallet.redeemSuccess", { credits: res.creditsAdded, balance: res.balance }));
            setRedeemCode("");
            setBalance(res.balance);
            const latestUser = useUserStore.getState().user;
            if (latestUser) setUser({ ...latestUser, creditBalance: res.balance });
            setPage(1);
            void loadLedger(1, reasonFilter, dateRange);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("userPanels.wallet.redeemFailed"));
        } finally {
            setRedeeming(false);
        }
    };

    const resetFilters = () => {
        setReasonFilter("");
        setDateRange(null);
        setPage(1);
    };

    const balanceReady = initialized || typeof user?.creditBalance === "number";
    const creditAlert = balanceReady ? resolveCreditAlert(balance, user?.lowBalanceThreshold) : null;
    const creditAlertCopy = creditAlert ? formatCreditAlertCopy(t, creditAlert) : null;

    return (
        <div className="admin-shell flex flex-col gap-4">
            {creditAlertCopy ? (
                <Alert
                    type={creditAlert?.level === "error" ? "error" : "warning"}
                    showIcon
                    title={creditAlertCopy.title}
                    description={creditAlertCopy.description}
                />
            ) : null}
            <Card size={compact ? "small" : "default"} loading={!initialized && loading}>
                <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex flex-wrap items-center gap-6">
                        <Tooltip title={t("userPanels.overview.exactBalance", { value: formatExactCredits(balance) })}>
                            <div>
                                <Statistic title={t("userPanels.wallet.currentCredits")} value={formatCompactCredits(balance)} />
                            </div>
                        </Tooltip>
                        <Tooltip title={t("userPanels.wallet.exactRecharged", { value: formatExactCredits(summary.totalRecharged) })}>
                            <div>
                                <Statistic title={t("userPanels.wallet.filteredRecharged")} value={formatCompactCredits(summary.totalRecharged)} />
                            </div>
                        </Tooltip>
                        {onOpenLogs ? (
                            <Button type="link" size="small" onClick={onOpenLogs}>
                                {t("userPanels.wallet.goUsageLogs")}
                            </Button>
                        ) : null}
                    </div>
                    <Space.Compact className={compact ? "w-full! sm:w-[310px]!" : "w-full! sm:w-[360px]!"}>
                        <Input
                            value={redeemCode}
                            placeholder={t("userPanels.wallet.codePlaceholder")}
                            onChange={(e) => setRedeemCode(e.target.value)}
                            onPressEnter={() => void handleRedeem()}
                        />
                        <Button type="primary" icon={<Gift className="size-4" />} loading={redeeming} onClick={() => void handleRedeem()}>
                            {t("userPanels.wallet.redeemNow")}
                        </Button>
                    </Space.Compact>
                </div>
            </Card>

            <Card
                size={compact ? "small" : "default"}
                title={t("userPanels.wallet.cardTitle", { count: summary.recordCount })}
                extra={
                    <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={() => void loadLedger(page, reasonFilter, dateRange, pageSize, true)}>
                        {t("common.refresh")}
                    </Button>
                }
            >
                <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Select
                        value={reasonFilter}
                        className="w-full! sm:w-[140px]!"
                        onChange={(val) => {
                            setPage(1);
                            setReasonFilter(val);
                        }}
                        options={[
                            { value: "", label: t("userPanels.wallet.allTypes") },
                            { value: "redeem_code", label: t("userPanels.ledgerReasons.redeem_code") },
                            { value: "admin_adjust", label: t("userPanels.ledgerReasons.admin_adjust") },
                            { value: "plan_grant", label: t("userPanels.ledgerReasons.plan_grant") },
                        ]}
                    />
                    <DatePicker.RangePicker
                        className="w-full! sm:w-auto!"
                        value={dateRange}
                        onChange={(dates) => {
                            setPage(1);
                            setDateRange(dates);
                        }}
                        placeholder={[t("userPanels.wallet.startDate"), t("userPanels.wallet.endDate")]}
                    />
                    {reasonFilter || dateRange ? (
                        <Button icon={<RotateCcw className="size-4" />} onClick={resetFilters}>
                            {t("userPanels.wallet.resetFilters")}
                        </Button>
                    ) : null}
                </div>

                <Table<CreditLedgerItem>
                    rowKey="id"
                    size="small"
                    className={ADMIN_TABLE_CLASS}
                    scroll={ADMIN_TABLE_SCROLL}
                    loading={loading}
                    dataSource={items}
                    onRow={(record) => ({
                        onClick: () => setDetailItem(record),
                        className: "cursor-pointer",
                    })}
                    pagination={{
                        current: page,
                        pageSize,
                        total,
                        showTotal: (count) => t("common.totalItems", { count }),
                        showSizeChanger: true,
                        pageSizeOptions: [10, 20, 30, 50, 100],
                        onChange: (p, size) => {
                            if (size !== pageSize) {
                                setPageSize(size);
                                setPage(1);
                            } else {
                                setPage(p);
                            }
                        },
                    }}
                    columns={[
                        {
                            title: t("userPanels.wallet.colTime"),
                            dataIndex: "createdAt",
                            width: 170,
                            render: (v: string) => new Date(v).toLocaleString(locale),
                        },
                        {
                            title: t("userPanels.wallet.colType"),
                            dataIndex: "reason",
                            width: 110,
                            render: (reason: string) => {
                                const info = getLedgerReasonMeta(reason, t);
                                return <Tag color={info?.color}>{info?.label || reason}</Tag>;
                            },
                        },
                        {
                            title: t("userPanels.wallet.colDetail"),
                            key: "detail",
                            width: 240,
                            render: (_, record) => {
                                const text = formatLedgerUsageDetail(record, t);
                                return (
                                    <Typography.Text type="secondary" ellipsis={{ tooltip: text }} className="block max-w-[220px]">
                                        {text}
                                    </Typography.Text>
                                );
                            },
                        },
                        {
                            title: t("userPanels.wallet.colDelta"),
                            dataIndex: "delta",
                            width: 110,
                            render: (_: unknown, record: CreditLedgerItem) => <LedgerDeltaTag record={record} t={t} />,
                        },
                        {
                            title: t("userPanels.wallet.colBalanceAfter"),
                            dataIndex: "balanceAfter",
                            width: 90,
                        },
                        {
                            title: t("userPanels.wallet.colActions"),
                            key: "actions",
                            width: 72,
                            fixed: "right",
                            render: (_, record) => (
                                <TableRowActions
                                    items={[
                                        {
                                            key: "detail",
                                            label: t("common.details"),
                                            onClick: () => setDetailItem(record),
                                        },
                                    ]}
                                />
                            ),
                        },
                    ]}
                />
            </Card>

            <LedgerDetailModal item={detailItem} onClose={() => setDetailItem(null)} />
        </div>
    );
}

export function UsageLogsPanel({ defaultScope = "self" }: { defaultScope?: "all" | "self" }) {
    const { t, i18n } = useTranslation();
    const locale = i18n.resolvedLanguage || undefined;
    const { message } = App.useApp();
    const { token } = antdTheme.useToken();
    const user = useUserStore((state) => state.user);
    const isAdmin = user?.role === "admin";

    const [scope, setScope] = useState<"all" | "self">(isAdmin ? defaultScope : "self");
    const [items, setItems] = useState<CreditLedgerItem[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [summary, setSummary] = useState<CreditLedgerSummary>(emptyLedgerSummary);
    const [loading, setLoading] = useState(true);

    const [reasonFilter, setReasonFilter] = useState("");
    const [statusFilter, setStatusFilter] = useState("");
    const [modelFilter, setModelFilter] = useState("");
    const [userQueryFilter, setUserQueryFilter] = useState("");
    const [logIdFilter, setLogIdFilter] = useState("");
    const [dateRange, setDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
    const [detailItem, setDetailItem] = useState<CreditLedgerItem | null>(null);

    useEffect(() => {
        setScope(isAdmin ? defaultScope : "self");
        setPage(1);
    }, [defaultScope, isAdmin]);

    const loadLogs = useCallback(
        async (
            targetPage = page,
            nextScope = scope,
            nextReason = reasonFilter,
            nextStatus = statusFilter,
            nextModel = modelFilter,
            nextUser = userQueryFilter,
            nextLogId = logIdFilter,
            nextRange = dateRange,
            nextPageSize = pageSize,
            notifySuccess = false,
        ) => {
            setLoading(true);
            try {
                const startDate = nextRange?.[0] ? nextRange[0].startOf("day").toISOString() : undefined;
                const endDate = nextRange?.[1] ? nextRange[1].endOf("day").toISOString() : undefined;
                if (isAdmin) {
                    const res = await adminApi.listLogs({
                        scope: nextScope,
                        category: "usage",
                        q: nextScope === "all" ? nextUser.trim() || undefined : undefined,
                        logId: nextLogId.trim() || undefined,
                        taskStatus: nextStatus || undefined,
                        reason: nextReason || undefined,
                        model: nextModel.trim() || undefined,
                        startDate,
                        endDate,
                        page: targetPage,
                        pageSize: nextPageSize,
                    });
                    setItems(res.items);
                    setTotal(res.total);
                    setSummary(res.summary);
                } else {
                    const res = await billingApi.getLedger({
                        category: "usage",
                        logId: nextLogId.trim() || undefined,
                        taskStatus: nextStatus || undefined,
                        reason: nextReason || undefined,
                        model: nextModel.trim() || undefined,
                        startDate,
                        endDate,
                        page: targetPage,
                        pageSize: nextPageSize,
                    });
                    setItems(res.items);
                    setTotal(res.total);
                    setSummary(res.summary);
                }
                if (notifySuccess) message.success(t("common.refreshed"));
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("userPanels.usageLogs.loadFailed"));
            } finally {
                setLoading(false);
            }
        },
        [dateRange, isAdmin, logIdFilter, message, modelFilter, page, pageSize, reasonFilter, scope, statusFilter, t, userQueryFilter],
    );

    useEffect(() => {
        void loadLogs(page, scope, reasonFilter, statusFilter, modelFilter, userQueryFilter, logIdFilter, dateRange);
    }, [dateRange, loadLogs, logIdFilter, modelFilter, page, reasonFilter, scope, statusFilter, userQueryFilter]);

    const resetFilters = () => {
        setReasonFilter("");
        setStatusFilter("");
        setModelFilter("");
        setUserQueryFilter("");
        setLogIdFilter("");
        setDateRange(null);
        setPage(1);
    };

    const showUserColumn = isAdmin && scope === "all";

    return (
        <div className="flex flex-col gap-4">
            <Card
                title={t("userPanels.usageLogs.cardTitle", { count: summary.recordCount })}
                extra={
                    <Space wrap>
                        {isAdmin ? (
                            <Segmented
                                size="small"
                                value={scope}
                                onChange={(val) => {
                                    setPage(1);
                                    setScope(val as "all" | "self");
                                }}
                                options={[
                                    { label: t("userPanels.usageLogs.scopeAll"), value: "all" },
                                    { label: t("userPanels.usageLogs.scopeSelf"), value: "self" },
                                ]}
                            />
                        ) : null}
                        <Button
                            size="small"
                            icon={<RefreshCw className="size-3.5" />}
                            loading={loading}
                            onClick={() => void loadLogs(page, scope, reasonFilter, statusFilter, modelFilter, userQueryFilter, logIdFilter, dateRange, pageSize, true)}
                        >
                            {t("common.refresh")}
                        </Button>
                    </Space>
                }
            >
                <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Select
                        value={reasonFilter}
                        className="min-w-[125px] flex-1 sm:w-[130px]! sm:flex-none"
                        onChange={(val) => {
                            setPage(1);
                            setReasonFilter(val);
                        }}
                        options={[
                            { value: "", label: t("userPanels.usageLogs.allUsageTypes") },
                            { value: "text_gen", label: t("userPanels.ledgerReasons.text_gen") },
                            { value: "image_gen", label: t("userPanels.ledgerReasons.image_gen") },
                            { value: "video_gen", label: t("userPanels.ledgerReasons.video_gen") },
                            { value: "audio_gen", label: t("userPanels.ledgerReasons.audio_gen") },
                        ]}
                    />
                    <Select
                        value={statusFilter}
                        className="min-w-[115px] flex-1 sm:w-[115px]! sm:flex-none"
                        onChange={(val) => {
                            setPage(1);
                            setStatusFilter(val);
                        }}
                        options={[
                            { value: "", label: t("userPanels.usageLogs.allStatuses") },
                            { value: "not_started", label: t("userPanels.taskStatuses.not_started") },
                            { value: "processing", label: t("userPanels.taskStatuses.processing") },
                            { value: "completed", label: t("userPanels.taskStatuses.completed") },
                            { value: "failed", label: t("userPanels.taskStatuses.failed") },
                            { value: "failed_refunded", label: t("userPanels.taskStatuses.failed_refunded") },
                        ]}
                    />
                    <Input
                        allowClear
                        value={modelFilter}
                        prefix={<Search className="size-3.5 opacity-50" />}
                        placeholder={t("userPanels.usageLogs.filterModel")}
                        className="w-full! sm:w-[180px]!"
                        onChange={(e) => {
                            setPage(1);
                            setModelFilter(e.target.value);
                        }}
                    />
                    {showUserColumn ? (
                        <Input
                            allowClear
                            value={userQueryFilter}
                            prefix={<User className="size-3.5 opacity-50" />}
                            placeholder={t("userPanels.usageLogs.searchUser")}
                            className="w-full! sm:w-[180px]!"
                            onChange={(e) => {
                                setPage(1);
                                setUserQueryFilter(e.target.value);
                            }}
                        />
                    ) : null}
                    <Input
                        allowClear
                        value={logIdFilter}
                        prefix={<Search className="size-3.5 opacity-50" />}
                        placeholder={t("userPanels.usageLogs.searchLogId")}
                        className="w-full! sm:w-[190px]!"
                        onChange={(e) => {
                            setPage(1);
                            setLogIdFilter(e.target.value);
                        }}
                    />
                    <DatePicker.RangePicker
                        className="w-full! sm:w-auto!"
                        value={dateRange}
                        onChange={(dates) => {
                            setPage(1);
                            setDateRange(dates);
                        }}
                        placeholder={[t("userPanels.wallet.startDate"), t("userPanels.wallet.endDate")]}
                    />
                    {reasonFilter || statusFilter || modelFilter || userQueryFilter || logIdFilter || dateRange ? (
                        <Button icon={<RotateCcw className="size-4" />} onClick={resetFilters}>
                            {t("userPanels.wallet.resetFilters")}
                        </Button>
                    ) : null}
                </div>

                <div
                    className="mb-3 grid grid-cols-2 gap-3 rounded-lg border p-3 sm:grid-cols-4"
                    style={{
                        backgroundColor: token.colorFillAlter,
                        borderColor: token.colorBorderSecondary,
                    }}
                >
                    <div>
                        <Typography.Text type="secondary" className="text-xs">
                            {t("userPanels.usageLogs.callCount")}
                        </Typography.Text>
                        <div className="mt-0.5 text-base font-semibold">
                            {t("userPanels.usageLogs.callCountValue", { count: summary.consumeCalls })}
                        </div>
                    </div>
                    <div>
                        <Typography.Text type="secondary" className="text-xs">
                            {t("userPanels.usageLogs.consumedCredits")}
                        </Typography.Text>
                        <div className="mt-0.5 text-base font-semibold">
                            {summary.totalConsumed}
                            {summary.totalRecharged > 0 ? (
                                <Typography.Text type="secondary" className="ml-1.5 text-xs font-normal">
                                    {t("userPanels.usageLogs.refundedTag", { amount: summary.totalRecharged })}
                                </Typography.Text>
                            ) : null}
                        </div>
                    </div>
                    <div>
                        <Tooltip
                            title={t("userPanels.usageLogs.usageStatsTooltip", {
                                input: summary.totalInputTokens.toLocaleString(locale),
                                cached: summary.totalCachedTokens.toLocaleString(locale),
                                output: summary.totalOutputTokens.toLocaleString(locale),
                                images: summary.totalImages,
                                seconds: summary.totalMediaSeconds,
                            })}
                        >
                            <div className="cursor-help">
                                <Typography.Text type="secondary" className="text-xs">
                                    {t("userPanels.usageLogs.usageStatsTitle")}
                                </Typography.Text>
                                <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs font-medium leading-6">
                                    <span>{t("userPanels.usageLogs.imagesUnit", { count: summary.totalImages })}</span>
                                    <span>·</span>
                                    <span>{t("userPanels.usageLogs.secondsUnit", { count: summary.totalMediaSeconds })}</span>
                                    <span>·</span>
                                    <span>{summary.totalTokens.toLocaleString(locale)} Tokens</span>
                                </div>
                            </div>
                        </Tooltip>
                    </div>
                    <div>
                        <Tooltip title={t("userPanels.usageLogs.rpmTooltip")}>
                            <div className="cursor-help">
                                <Typography.Text type="secondary" className="text-xs">
                                    {t("userPanels.usageLogs.rpmTitle")}
                                </Typography.Text>
                                <div className="mt-0.5 flex flex-wrap items-baseline gap-1.5">
                                    <span className="text-base font-semibold">{summary.avgRpm}</span>
                                    <Typography.Text type="secondary" className="text-xs">
                                        {t("userPanels.usageLogs.rpmSub", { peak: summary.peakRpm, recent: summary.recentRpm })}
                                    </Typography.Text>
                                </div>
                            </div>
                        </Tooltip>
                    </div>
                </div>

                <Table<CreditLedgerItem>
                    rowKey="id"
                    size="small"
                    className={ADMIN_TABLE_CLASS}
                    scroll={ADMIN_TABLE_SCROLL}
                    loading={loading}
                    dataSource={items}
                    onRow={(record) => ({
                        onClick: () => setDetailItem(record),
                        className: "cursor-pointer",
                    })}
                    pagination={{
                        current: page,
                        pageSize,
                        total,
                        showTotal: (count) => t("common.totalItems", { count }),
                        showSizeChanger: true,
                        pageSizeOptions: [10, 20, 30, 50, 100],
                        onChange: (p, size) => {
                            if (size !== pageSize) {
                                setPageSize(size);
                                setPage(1);
                            } else {
                                setPage(p);
                            }
                        },
                    }}
                    columns={[
                        ...(showUserColumn
                            ? [
                                  {
                                      title: t("userPanels.usageLogs.colUser"),
                                      key: "user",
                                      width: 135,
                                      render: (_: unknown, record: CreditLedgerItem) => (
                                          <Typography.Text ellipsis={{ tooltip: record.username ? `@${record.username}` : record.userId }} className="block max-w-[120px] font-medium">
                                              {record.displayName || record.username || record.userId}
                                          </Typography.Text>
                                      ),
                                  },
                              ]
                            : []),
                        {
                            title: t("userPanels.wallet.colTime"),
                            dataIndex: "createdAt",
                            width: 170,
                            render: (v: string) => new Date(v).toLocaleString(locale),
                        },
                        {
                            title: t("userPanels.wallet.colType"),
                            dataIndex: "reason",
                            width: 100,
                            render: (reason: string) => {
                                const info = getLedgerReasonMeta(reason, t);
                                return <Tag color={info?.color}>{info?.label || reason}</Tag>;
                            },
                        },
                        {
                            title: t("userPanels.myMedia.colStatus"),
                            key: "taskStatus",
                            width: 85,
                            render: (_, record) => {
                                const st = getLedgerTaskStatus(record, t);
                                const err = typeof record.meta?.errorMessage === "string" ? record.meta.errorMessage.trim() : "";
                                return err ? (
                                    <Tooltip title={err}>
                                        <Tag color={st.color}>{st.label}</Tag>
                                    </Tooltip>
                                ) : (
                                    <Tag color={st.color}>{st.label}</Tag>
                                );
                            },
                        },
                        {
                            title: t("userPanels.usageLogs.colModel"),
                            key: "model",
                            width: 160,
                            render: (_, record) =>
                                typeof record.meta?.model === "string" && record.meta.model ? (
                                    <Tag>{record.meta.model}</Tag>
                                ) : (
                                    <Typography.Text type="secondary">—</Typography.Text>
                                ),
                        },
                        {
                            title: t("userPanels.usageLogs.colStream"),
                            key: "stream",
                            width: 72,
                            render: (_, record) => {
                                const { isStream } = getLedgerTimingStats(record.meta, t);
                                if (typeof isStream !== "boolean") return <Typography.Text type="secondary">—</Typography.Text>;
                                return (
                                    <Tag color={isStream ? "cyan" : undefined}>
                                        {isStream ? t("userPanels.ledgerDetail.stream") : t("userPanels.ledgerDetail.nonStream")}
                                    </Tag>
                                );
                            },
                        },
                        {
                            title: t("userPanels.usageLogs.colTiming"),
                            key: "timing",
                            width: 170,
                            render: (_, record) => {
                                const { isStream, durationText, firstTokenMs, upstreamMs, stageText, clientAborted, tokPerSec } = getLedgerTimingStats(
                                    record.meta,
                                    t,
                                );
                                if (!durationText && !tokPerSec) return <Typography.Text type="secondary">—</Typography.Text>;
                                const tooltipTitle =
                                    isStream && firstTokenMs !== undefined
                                        ? t("userPanels.usageLogs.streamTooltip", {
                                              first: formatDurationSec(firstTokenMs),
                                              total: formatDurationSec(Number(record.meta?.durationMs ?? 0)),
                                          })
                                        : stageText
                                          ? t("userPanels.usageLogs.stageTooltip", {
                                                total: durationText,
                                                stage: stageText,
                                                aborted: clientAborted ? t("userPanels.usageLogs.abortedInline") : "",
                                            })
                                          : t("userPanels.usageLogs.plainTooltip", {
                                                total: durationText,
                                                aborted: clientAborted ? t("userPanels.usageLogs.abortedParen") : "",
                                            });
                                return (
                                    <div className="flex flex-col leading-tight">
                                        {durationText ? (
                                            <Tooltip title={tooltipTitle}>
                                                <span className="font-mono text-xs">
                                                    {durationText}
                                                    {clientAborted ? t("userPanels.usageLogs.disconnectedShort") : ""}
                                                </span>
                                            </Tooltip>
                                        ) : null}
                                        {tokPerSec > 0 ? (
                                            <Typography.Text type="secondary" className="font-mono text-[11px]">
                                                {tokPerSec} tok/s
                                            </Typography.Text>
                                        ) : upstreamMs !== undefined ? (
                                            <Typography.Text type="secondary" className="font-mono text-[11px]">
                                                {t("userPanels.usageLogs.upstreamShort", { duration: formatDurationSec(upstreamMs) })}
                                            </Typography.Text>
                                        ) : null}
                                    </div>
                                );
                            },
                        },
                        {
                            title: t("userPanels.usageLogs.colDetail"),
                            key: "detail",
                            width: 240,
                            render: (_, record) => {
                                const text = formatLedgerUsageDetail(record, t);
                                return (
                                    <Typography.Text type="secondary" ellipsis={{ tooltip: text }} className="block max-w-[220px]">
                                        {text}
                                    </Typography.Text>
                                );
                            },
                        },
                        {
                            title: t("userPanels.wallet.colDelta"),
                            dataIndex: "delta",
                            width: 110,
                            render: (_: unknown, record: CreditLedgerItem) => <LedgerDeltaTag record={record} t={t} />,
                        },
                        {
                            title: t("userPanels.wallet.colBalanceAfter"),
                            dataIndex: "balanceAfter",
                            width: 90,
                        },
                        {
                            title: t("userPanels.wallet.colActions"),
                            key: "actions",
                            width: 72,
                            fixed: "right",
                            render: (_, record) => (
                                <TableRowActions
                                    items={[
                                        {
                                            key: "detail",
                                            label: t("common.details"),
                                            onClick: () => setDetailItem(record),
                                        },
                                    ]}
                                />
                            ),
                        },
                    ]}
                />
            </Card>

            <LedgerDetailModal item={detailItem} showUser={showUserColumn} onClose={() => setDetailItem(null)} />
        </div>
    );
}

