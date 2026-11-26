/** 管理员后台用户详情抽屉：展示资料、云端业务数据表格、存储资源包、充值/调账记录与管理员改密。 */
import { useCallback, useEffect, useState } from "react";
import { App, Avatar, Button, Descriptions, Drawer, Form, Input, Popconfirm, Progress, Space, Spin, Switch, Table, Tabs, Tag, Tooltip, Typography, theme as antdTheme } from "antd";
import type { TFunction } from "i18next";
import { Ban, CheckCircle2, Coins, HardDrive, KeyRound, RefreshCw, Shield, User } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatCompactCredits, formatExactCredits } from "@/lib/format-number";
import { ADMIN_TABLE_CLASS, ADMIN_TABLE_SCROLL } from "@/pages/admin/components/table-row-actions";
import { formatBytes } from "@/pages/admin/user-panels";
import { adminApi, type AdminUserDetailResponse, type AdminUserItem, type CreditLedgerItem } from "@/services/api/server";

type UnifiedStorageRow = {
    key: string;
    source: string;
    sourceLabel: string;
    sourceColor: string;
    quotaBytes: number;
    status: "active" | "expired" | "revoked";
    expiresAt: string | null;
    createdAt: string | null;
    noteText: string;
};

type WorkspaceCountRow = {
    key: string;
    label: string;
    value: number;
    unit: string;
    description: string;
};

type ResetPasswordForm = {
    newPassword: string;
    confirmPassword: string;
    revokeSessions: boolean;
};

function getRechargeRecordMeta(row: CreditLedgerItem, t: TFunction): { label: string; color: string } {
    if (row.reason === "redeem_code") return { label: t("userDetail.rechargeTypes.redeemCode"), color: "green" };
    if (row.reason === "plan_grant") return { label: t("userDetail.rechargeTypes.planGrant"), color: "purple" };
    if (row.reason === "admin_adjust") {
        if (row.meta?.action === "clear") return { label: t("userDetail.rechargeTypes.adminClear"), color: "red" };
        return row.delta >= 0
            ? { label: t("userDetail.rechargeTypes.adminAdd"), color: "blue" }
            : { label: t("userDetail.rechargeTypes.adminDeduct"), color: "orange" };
    }
    return { label: row.reason, color: "default" };
}

export function UserDetailDrawer({
    userId,
    refreshKey = 0,
    currentUserId,
    onClose,
    onOpenCredits,
    onOpenQuota,
    onUpdateUser,
}: {
    userId: string | null;
    refreshKey?: number;
    currentUserId?: string;
    onClose: () => void;
    onOpenCredits: (user: AdminUserItem) => void;
    onOpenQuota: (user: AdminUserItem) => void;
    onUpdateUser: (userId: string, payload: { role?: "admin" | "user"; status?: "active" | "disabled" }) => Promise<void>;
}) {
    const { t, i18n } = useTranslation();
    const locale = i18n.resolvedLanguage || undefined;
    const { message } = App.useApp();
    const { token } = antdTheme.useToken();
    const [loading, setLoading] = useState(false);
    const [updating, setUpdating] = useState(false);
    const [savingPassword, setSavingPassword] = useState(false);
    const [detail, setDetail] = useState<AdminUserDetailResponse | null>(null);
    const [passwordForm] = Form.useForm<ResetPasswordForm>();

    const loadDetail = useCallback(
        async (targetId = userId, notifySuccess = false) => {
            if (!targetId) return;
            setLoading(true);
            try {
                const res = await adminApi.getUserDetail(targetId, 7);
                setDetail(res);
                if (notifySuccess) message.success(t("common.refreshed"));
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("userDetail.loadFailed"));
            } finally {
                setLoading(false);
            }
        },
        [message, t, userId],
    );

    useEffect(() => {
        if (!userId) {
            setDetail(null);
            passwordForm.resetFields();
            return;
        }
        void loadDetail(userId);
    }, [loadDetail, passwordForm, refreshKey, userId]);

    const handleQuickUpdate = async (payload: { role?: "admin" | "user"; status?: "active" | "disabled" }) => {
        if (!detail || updating) return;
        setUpdating(true);
        try {
            await onUpdateUser(detail.user.id, payload);
            await loadDetail(detail.user.id);
        } finally {
            setUpdating(false);
        }
    };

    const handleResetPassword = async (values: ResetPasswordForm) => {
        if (!detail || savingPassword) return;
        setSavingPassword(true);
        try {
            await adminApi.resetUserPassword(detail.user.id, {
                newPassword: values.newPassword,
                revokeSessions: values.revokeSessions,
            });
            message.success(t("userDetail.passwordUpdated"));
            passwordForm.resetFields();
            passwordForm.setFieldsValue({ revokeSessions: true });
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("userDetail.passwordUpdateFailed"));
        } finally {
            setSavingPassword(false);
        }
    };

    const u = detail?.user;
    const usedBytes = u?.storageUsedBytes ?? 0;
    const quotaBytes = u?.storageQuotaBytes ?? 0;
    const quotaExpired = Boolean(u?.storageQuotaExpiresAt && new Date(u.storageQuotaExpiresAt).getTime() <= Date.now());
    const quotaExceeded = quotaExpired || quotaBytes <= 0 || usedBytes >= quotaBytes;
    const quotaPercent = quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : 100;

    const grantSourceMeta: Record<string, { label: string; color: string }> = {
        redeem_code: { label: t("userDetail.grantSources.redeemCode"), color: "cyan" },
        admin_grant: { label: t("userDetail.grantSources.adminGrant"), color: "blue" },
        plan_grant: { label: t("userDetail.grantSources.planGrant"), color: "purple" },
    };

    const storageRows: UnifiedStorageRow[] = [];
    if (u && ((u.baseStorageQuotaBytes ?? 0) > 0 || u.baseStorageQuotaExpiresAt)) {
        const baseExpired = Boolean(u.baseStorageQuotaExpiresAt && new Date(u.baseStorageQuotaExpiresAt).getTime() <= Date.now());
        storageRows.push({
            key: "base-quota",
            source: "admin_base",
            sourceLabel: t("userDetail.grantSources.adminBase"),
            sourceColor: "geekblue",
            quotaBytes: u.baseStorageQuotaBytes ?? 0,
            status: baseExpired ? "expired" : "active",
            expiresAt: u.baseStorageQuotaExpiresAt ?? null,
            createdAt: u.createdAt,
            noteText: t("userDetail.baseQuotaNote"),
        });
    }
    if (detail?.grants.length) {
        for (const g of detail.grants) {
            const meta = grantSourceMeta[g.source] || { label: g.source, color: "default" };
            storageRows.push({
                key: g.id,
                source: g.source,
                sourceLabel: meta.label,
                sourceColor: meta.color,
                quotaBytes: g.quotaBytes,
                status: g.status === "revoked" ? "revoked" : g.isExpired ? "expired" : "active",
                expiresAt: g.expiresAt,
                createdAt: g.createdAt,
                noteText: [g.refId, g.note].filter(Boolean).join(" · ") || "—",
            });
        }
    }

    const workspaceRows: WorkspaceCountRow[] = detail
        ? [
              { key: "canvas", label: t("userDetail.workspaceRows.canvas"), value: detail.stats.canvasProjectCount, unit: t("userDetail.workspaceRows.canvasUnit"), description: t("userDetail.workspaceRows.canvasDesc") },
              { key: "assets", label: t("userDetail.workspaceRows.assets"), value: detail.stats.assetCount, unit: t("userDetail.workspaceRows.assetsUnit"), description: t("userDetail.workspaceRows.assetsDesc") },
              { key: "media", label: t("userDetail.workspaceRows.media"), value: detail.stats.activeMediaCount, unit: t("userDetail.workspaceRows.mediaUnit"), description: t("userDetail.workspaceRows.mediaDesc") },
              { key: "imageLogs", label: t("userDetail.workspaceRows.imageLogs"), value: detail.stats.imageLogCount, unit: t("userDetail.workspaceRows.imageLogsUnit"), description: t("userDetail.workspaceRows.imageLogsDesc") },
              { key: "videoLogs", label: t("userDetail.workspaceRows.videoLogs"), value: detail.stats.videoLogCount, unit: t("userDetail.workspaceRows.videoLogsUnit"), description: t("userDetail.workspaceRows.videoLogsDesc") },
          ]
        : [];

    const rechargeLogs = detail?.recentLogs ?? [];

    return (
        <Drawer
            title={t("userDetail.title")}
            open={Boolean(userId)}
            size={840}
            onClose={onClose}
            destroyOnHidden
            extra={
                <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={() => void loadDetail(userId, true)}>
                    {t("common.refresh")}
                </Button>
            }
        >
            <Spin spinning={loading && !detail}>
                {detail && u ? (
                    <div className="flex flex-col gap-5">
                        {/* 顶部账号信息与快捷操作 */}
                        <div
                            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
                            style={{
                                borderColor: token.colorBorderSecondary,
                                backgroundColor: token.colorFillAlter,
                            }}
                        >
                            <div className="flex min-w-0 items-center gap-3.5">
                                <Avatar
                                    size={48}
                                    src={u.avatarUrl || undefined}
                                    icon={<User className="size-5" />}
                                    style={{ backgroundColor: token.colorPrimaryBg, color: token.colorPrimary, flexShrink: 0 }}
                                />
                                <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="truncate text-base font-semibold" style={{ color: token.colorText }}>
                                            {u.displayName || u.username}
                                        </span>
                                        <Tag color={u.role === "admin" ? "blue" : "default"} style={{ marginInlineEnd: 0 }}>
                                            {u.role === "admin" ? t("userDetail.roleAdmin") : t("userDetail.roleUser")}
                                        </Tag>
                                        <Tag color={u.status === "active" ? "green" : "red"} style={{ marginInlineEnd: 0 }}>
                                            {u.status === "active" ? t("userDetail.statusActive") : t("userDetail.statusDisabled")}
                                        </Tag>
                                        {u.id === currentUserId ? <Tag style={{ marginInlineEnd: 0 }}>{t("userDetail.currentLogin")}</Tag> : null}
                                    </div>
                                    <Typography.Text type="secondary" className="mt-1 block text-xs">
                                        @{u.username}
                                        {u.email ? ` · ${u.email}` : ` · ${t("userDetail.noEmail")}`}
                                    </Typography.Text>
                                </div>
                            </div>
                            <Space wrap size={8}>
                                <Button size="small" icon={<Coins className="size-3.5" />} onClick={() => onOpenCredits(u)}>
                                    {t("userDetail.adjustCredits")}
                                </Button>
                                <Button size="small" icon={<HardDrive className="size-3.5" />} onClick={() => onOpenQuota(u)}>
                                    {t("userDetail.configQuota")}
                                </Button>
                                {u.isInitialAdmin && u.role === "admin" ? (
                                    <Tooltip title={t("userDetail.initialAdminProtected")}>
                                        <Button size="small" icon={<Shield className="size-3.5" />} disabled>
                                            {t("userDetail.demote")}
                                        </Button>
                                    </Tooltip>
                                ) : (
                                    <Popconfirm
                                        title={u.role === "admin" ? t("userDetail.confirmDemote") : t("userDetail.confirmPromote")}
                                        onConfirm={() => void handleQuickUpdate({ role: u.role === "admin" ? "user" : "admin" })}
                                    >
                                        <Button size="small" icon={<Shield className="size-3.5" />} loading={updating}>
                                            {u.role === "admin" ? t("userDetail.demote") : t("userDetail.promote")}
                                        </Button>
                                    </Popconfirm>
                                )}
                                {u.id !== currentUserId && !u.isInitialAdmin ? (
                                    <Popconfirm
                                        title={u.status === "active" ? t("userDetail.confirmDisable") : t("userDetail.confirmEnable")}
                                        onConfirm={() => void handleQuickUpdate({ status: u.status === "active" ? "disabled" : "active" })}
                                    >
                                        <Button
                                            size="small"
                                            danger={u.status === "active"}
                                            icon={u.status === "active" ? <Ban className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}
                                            loading={updating}
                                        >
                                            {u.status === "active" ? t("userDetail.disable") : t("userDetail.enable")}
                                        </Button>
                                    </Popconfirm>
                                ) : null}
                            </Space>
                        </div>

                        {/* 等高 KPI 指标卡片 */}
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                            <Tooltip title={t("userDetail.kpi.exactBalance", { value: formatExactCredits(u.creditBalance ?? 0) })}>
                                <div
                                    className="flex flex-col justify-between rounded-xl border p-3.5"
                                    style={{ borderColor: token.colorBorderSecondary, backgroundColor: token.colorBgContainer }}
                                >
                                    <div className="text-xs" style={{ color: token.colorTextSecondary }}>
                                        {t("userDetail.kpi.currentCredits")}
                                    </div>
                                    <div className="mt-1.5 text-xl font-semibold tabular-nums" style={{ color: token.colorText }}>
                                        {formatCompactCredits(u.creditBalance ?? 0)}
                                    </div>
                                    <div className="mt-2 text-[11px]" style={{ color: token.colorTextTertiary }}>
                                        {t("userDetail.kpi.availableCredits")}
                                    </div>
                                </div>
                            </Tooltip>

                            <Tooltip
                                title={t("userDetail.kpi.exactConsumed", {
                                    total: formatExactCredits(detail.consumption.totalConsumedCredits),
                                    today: formatExactCredits(detail.consumption.todayConsumedCredits),
                                })}
                            >
                                <div
                                    className="flex flex-col justify-between rounded-xl border p-3.5"
                                    style={{ borderColor: token.colorBorderSecondary, backgroundColor: token.colorBgContainer }}
                                >
                                    <div className="text-xs" style={{ color: token.colorTextSecondary }}>
                                        {t("userDetail.kpi.totalConsumed")}
                                    </div>
                                    <div className="mt-1.5 text-xl font-semibold tabular-nums" style={{ color: token.colorText }}>
                                        {formatCompactCredits(detail.consumption.totalConsumedCredits)}
                                    </div>
                                    <div className="mt-2 text-[11px]" style={{ color: token.colorTextTertiary }}>
                                        {t("userDetail.kpi.todayNet", { value: formatCompactCredits(detail.consumption.todayConsumedCredits) })}
                                    </div>
                                </div>
                            </Tooltip>

                            <Tooltip title={t("userDetail.kpi.exactRecharged", { value: formatExactCredits(detail.stats.totalRechargedCredits) })}>
                                <div
                                    className="flex flex-col justify-between rounded-xl border p-3.5"
                                    style={{ borderColor: token.colorBorderSecondary, backgroundColor: token.colorBgContainer }}
                                >
                                    <div className="text-xs" style={{ color: token.colorTextSecondary }}>
                                        {t("userDetail.kpi.totalRecharged")}
                                    </div>
                                    <div className="mt-1.5 text-xl font-semibold tabular-nums" style={{ color: token.colorText }}>
                                        {formatCompactCredits(detail.stats.totalRechargedCredits)}
                                    </div>
                                    <div className="mt-2 text-[11px]" style={{ color: token.colorTextTertiary }}>
                                        {t("userDetail.kpi.rechargeCount", { count: rechargeLogs.length })}
                                    </div>
                                </div>
                            </Tooltip>

                            <div
                                className="flex flex-col justify-between rounded-xl border p-3.5"
                                style={{ borderColor: token.colorBorderSecondary, backgroundColor: token.colorBgContainer }}
                            >
                                <div className="text-xs" style={{ color: token.colorTextSecondary }}>
                                    {t("userDetail.kpi.cloudStorage")}
                                </div>
                                <div className="mt-1.5 truncate text-sm font-semibold tabular-nums" style={{ color: token.colorText }}>
                                    {formatBytes(usedBytes)} / {formatBytes(quotaBytes)}
                                </div>
                                <div className="mt-2 flex flex-col gap-1">
                                    <Progress percent={quotaPercent} size="small" showInfo={false} status={quotaExceeded ? "exception" : "normal"} />
                                    <div className="text-[11px]" style={{ color: quotaExpired ? token.colorError : token.colorTextTertiary }}>
                                        {quotaExpired
                                            ? t("userDetail.kpi.quotaExpired")
                                            : u.storageQuotaExpiresAt
                                              ? t("userDetail.kpi.untilDate", { date: new Date(u.storageQuotaExpiresAt).toLocaleDateString(locale) })
                                              : t("userDetail.kpi.permanent")}
                                    </div>
                                </div>
                            </div>
                        </div>

                        <Tabs
                            items={[
                                {
                                    key: "overview",
                                    label: t("userDetail.tabs.overview"),
                                    children: (
                                        <div className="flex flex-col gap-4 pt-1">
                                            <Descriptions
                                                bordered
                                                size="small"
                                                column={{ xs: 1, sm: 2 }}
                                                styles={{ label: { whiteSpace: "nowrap", width: 112 } }}
                                            >
                                                <Descriptions.Item label={t("userDetail.fields.username")}>
                                                    <Typography.Text strong>@{u.username}</Typography.Text>
                                                </Descriptions.Item>
                                                <Descriptions.Item label={t("userDetail.fields.userId")}>
                                                    <Typography.Text copyable className="font-mono text-xs">
                                                        {u.id}
                                                    </Typography.Text>
                                                </Descriptions.Item>
                                                <Descriptions.Item label={t("userDetail.fields.email")}>
                                                    {u.email ? (
                                                        <Space size={6}>
                                                            <span>{u.email}</span>
                                                            <Tag color={u.emailVerifiedAt ? "green" : "orange"} style={{ marginInlineEnd: 0 }}>
                                                                {u.emailVerifiedAt ? t("userDetail.fields.verified") : t("userDetail.fields.unverified")}
                                                            </Tag>
                                                        </Space>
                                                    ) : (
                                                        <Typography.Text type="secondary">{t("userDetail.fields.unbound")}</Typography.Text>
                                                    )}
                                                </Descriptions.Item>
                                                <Descriptions.Item label={t("userDetail.fields.lowBalanceAlert")}>
                                                    {u.lowBalanceAlertEnabled === false
                                                        ? t("userDetail.fields.alertOff")
                                                        : u.lowBalanceAlertEnabled === true
                                                          ? t("userDetail.fields.alertCustom", { value: u.lowBalanceThreshold ?? 10 })
                                                          : t("userDetail.fields.alertDefault")}
                                                </Descriptions.Item>
                                                <Descriptions.Item label={t("userDetail.fields.createdAt")}>
                                                    {new Date(u.createdAt).toLocaleString(locale)}
                                                </Descriptions.Item>
                                                <Descriptions.Item label={t("userDetail.fields.lastLoginAt")}>
                                                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString(locale) : t("userDetail.fields.noRecord")}
                                                </Descriptions.Item>
                                            </Descriptions>

                                            <div>
                                                <div className="mb-2 text-xs font-medium" style={{ color: token.colorTextSecondary }}>
                                                    {t("userDetail.cloudDataTitle")}
                                                </div>
                                                <Table<WorkspaceCountRow>
                                                    rowKey="key"
                                                    size="small"
                                                    bordered
                                                    className={ADMIN_TABLE_CLASS}
                                                    scroll={ADMIN_TABLE_SCROLL}
                                                    dataSource={workspaceRows}
                                                    pagination={false}
                                                    columns={[
                                                        { title: t("userDetail.workspaceCols.type"), dataIndex: "label", width: 140 },
                                                        {
                                                            title: t("userDetail.workspaceCols.count"),
                                                            key: "value",
                                                            width: 110,
                                                            render: (_, row) => (
                                                                <span className="font-semibold tabular-nums">
                                                                    {row.value} {row.unit}
                                                                </span>
                                                            ),
                                                        },
                                                        {
                                                            title: t("userDetail.workspaceCols.desc"),
                                                            dataIndex: "description",
                                                            render: (text: string) => (
                                                                <Typography.Text type="secondary" className="text-xs">
                                                                    {text}
                                                                </Typography.Text>
                                                            ),
                                                        },
                                                    ]}
                                                />
                                            </div>
                                        </div>
                                    ),
                                },
                                {
                                    key: "grants",
                                    label: t("userDetail.tabs.grants", { count: storageRows.length }),
                                    children: (
                                        <div className="flex flex-col gap-3 pt-1">
                                            <div className="text-xs" style={{ color: token.colorTextSecondary }}>
                                                {t("userDetail.grantsSummary", {
                                                    total: formatBytes(quotaBytes),
                                                    base: formatBytes(u.baseStorageQuotaBytes ?? 0),
                                                    baseExpiry: u.baseStorageQuotaExpiresAt
                                                        ? t("userDetail.baseExpiryDate", {
                                                              date: new Date(u.baseStorageQuotaExpiresAt).toLocaleDateString(locale),
                                                          })
                                                        : t("userDetail.baseExpiryPermanent"),
                                                    grants: formatBytes(u.storageGrantsQuotaBytes ?? 0),
                                                })}
                                            </div>
                                            <Table<UnifiedStorageRow>
                                                rowKey="key"
                                                size="small"
                                                className={ADMIN_TABLE_CLASS}
                                                scroll={ADMIN_TABLE_SCROLL}
                                                dataSource={storageRows}
                                                pagination={{
                                                    defaultPageSize: 10,
                                                    showSizeChanger: true,
                                                    pageSizeOptions: [10, 20, 30, 50, 100],
                                                    showTotal: (c) => t("common.totalItems", { count: c }),
                                                }}
                                                columns={[
                                                    {
                                                        title: t("userDetail.grantCols.source"),
                                                        key: "source",
                                                        width: 130,
                                                        render: (_, row) => (
                                                            <Tag color={row.sourceColor} style={{ marginInlineEnd: 0 }}>
                                                                {row.sourceLabel}
                                                            </Tag>
                                                        ),
                                                    },
                                                    {
                                                        title: t("userDetail.grantCols.capacity"),
                                                        dataIndex: "quotaBytes",
                                                        width: 100,
                                                        render: (v: number) => <span className="font-medium tabular-nums">{formatBytes(v)}</span>,
                                                    },
                                                    {
                                                        title: t("userDetail.grantCols.status"),
                                                        key: "status",
                                                        width: 90,
                                                        render: (_, row) =>
                                                            row.status === "revoked" ? (
                                                                <Tag style={{ marginInlineEnd: 0 }}>{t("userDetail.grantStatus.revoked")}</Tag>
                                                            ) : row.status === "expired" ? (
                                                                <Tag color="red" style={{ marginInlineEnd: 0 }}>
                                                                    {t("userDetail.grantStatus.expired")}
                                                                </Tag>
                                                            ) : (
                                                                <Tag color="green" style={{ marginInlineEnd: 0 }}>
                                                                    {t("userDetail.grantStatus.active")}
                                                                </Tag>
                                                            ),
                                                    },
                                                    {
                                                        title: t("userDetail.grantCols.expiresAt"),
                                                        dataIndex: "expiresAt",
                                                        width: 170,
                                                        render: (v?: string | null) => (v ? new Date(v).toLocaleString(locale) : t("userDetail.kpi.permanent")),
                                                    },
                                                    {
                                                        title: t("userDetail.grantCols.assignedAt"),
                                                        dataIndex: "createdAt",
                                                        width: 170,
                                                        render: (v?: string | null) => (v ? new Date(v).toLocaleString(locale) : "—"),
                                                    },
                                                    {
                                                        title: t("userDetail.grantCols.note"),
                                                        dataIndex: "noteText",
                                                        width: 200,
                                                        ellipsis: true,
                                                    },
                                                ]}
                                            />
                                        </div>
                                    ),
                                },
                                {
                                    key: "recharges",
                                    label: t("userDetail.tabs.recharges", { count: rechargeLogs.length }),
                                    children: (
                                        <div className="pt-1">
                                            <Table<CreditLedgerItem>
                                                rowKey="id"
                                                size="small"
                                                className={ADMIN_TABLE_CLASS}
                                                scroll={ADMIN_TABLE_SCROLL}
                                                dataSource={rechargeLogs}
                                                pagination={{
                                                    defaultPageSize: 10,
                                                    showSizeChanger: true,
                                                    pageSizeOptions: [10, 20, 30, 50, 100],
                                                    showTotal: (c) => t("common.totalItems", { count: c }),
                                                }}
                                                columns={[
                                                    {
                                                        title: t("userDetail.rechargeCols.time"),
                                                        dataIndex: "createdAt",
                                                        width: 170,
                                                        render: (v: string) => new Date(v).toLocaleString(locale),
                                                    },
                                                    {
                                                        title: t("userDetail.rechargeCols.type"),
                                                        key: "reason",
                                                        width: 110,
                                                        render: (_, row) => {
                                                            const info = getRechargeRecordMeta(row, t);
                                                            return (
                                                                <Tag color={info.color} style={{ marginInlineEnd: 0 }}>
                                                                    {info.label}
                                                                </Tag>
                                                            );
                                                        },
                                                    },
                                                    {
                                                        title: t("userDetail.rechargeCols.delta"),
                                                        dataIndex: "delta",
                                                        width: 110,
                                                        render: (delta: number) => (
                                                            <Tooltip title={formatExactCredits(delta)}>
                                                                <Tag color={delta >= 0 ? "green" : "volcano"} style={{ marginInlineEnd: 0 }}>
                                                                    {delta >= 0 ? `+${formatCompactCredits(delta)}` : formatCompactCredits(delta)}
                                                                </Tag>
                                                            </Tooltip>
                                                        ),
                                                    },
                                                    {
                                                        title: t("userDetail.rechargeCols.balanceAfter"),
                                                        dataIndex: "balanceAfter",
                                                        width: 110,
                                                        render: (v: number) => (
                                                            <Tooltip title={formatExactCredits(v)}>
                                                                <span className="tabular-nums">{formatCompactCredits(v)}</span>
                                                            </Tooltip>
                                                        ),
                                                    },
                                                    {
                                                        title: t("userDetail.rechargeCols.note"),
                                                        key: "note",
                                                        width: 220,
                                                        ellipsis: true,
                                                        render: (_, row) => {
                                                            const note = typeof row.meta?.note === "string" ? row.meta.note : "";
                                                            const refCode = row.reason === "redeem_code" ? row.refId || "" : "";
                                                            return [refCode, note].filter(Boolean).join(" · ") || "—";
                                                        },
                                                    },
                                                ]}
                                            />
                                        </div>
                                    ),
                                },
                                {
                                    key: "password",
                                    label: t("userDetail.tabs.password"),
                                    children: (
                                        <div className="max-w-md pt-2">
                                            <Form
                                                form={passwordForm}
                                                layout="vertical"
                                                initialValues={{ revokeSessions: true }}
                                                onFinish={(values) => void handleResetPassword(values)}
                                            >
                                                <Form.Item
                                                    name="newPassword"
                                                    label={t("userDetail.passwordForm.newPassword")}
                                                    rules={[
                                                        { required: true, message: t("userDetail.passwordForm.newPasswordReq") },
                                                        { min: 6, message: t("userDetail.passwordForm.newPasswordMin") },
                                                        { max: 128, message: t("userDetail.passwordForm.newPasswordMax") },
                                                    ]}
                                                >
                                                    <Input.Password placeholder={t("userDetail.passwordForm.newPasswordPlaceholder")} autoComplete="new-password" />
                                                </Form.Item>
                                                <Form.Item
                                                    name="confirmPassword"
                                                    label={t("userDetail.passwordForm.confirmPassword")}
                                                    dependencies={["newPassword"]}
                                                    rules={[
                                                        { required: true, message: t("userDetail.passwordForm.confirmPasswordReq") },
                                                        ({ getFieldValue }) => ({
                                                            validator(_, value) {
                                                                if (!value || getFieldValue("newPassword") === value) {
                                                                    return Promise.resolve();
                                                                }
                                                                return Promise.reject(new Error(t("userDetail.passwordForm.confirmMismatch")));
                                                            },
                                                        }),
                                                    ]}
                                                >
                                                    <Input.Password placeholder={t("userDetail.passwordForm.confirmPlaceholder")} autoComplete="new-password" />
                                                </Form.Item>
                                                <Form.Item name="revokeSessions" label={t("userDetail.passwordForm.revokeSessions")} valuePropName="checked">
                                                    <Switch />
                                                </Form.Item>
                                                <Button type="primary" htmlType="submit" icon={<KeyRound className="size-4" />} loading={savingPassword}>
                                                    {t("userDetail.passwordForm.submit")}
                                                </Button>
                                            </Form>
                                        </div>
                                    ),
                                },
                            ]}
                        />
                    </div>
                ) : null}
            </Spin>
        </Drawer>
    );
}
