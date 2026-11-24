/** 管理员后台用户详情抽屉：展示资料、云端业务数据表格、存储资源包、充值/调账记录与管理员改密。 */
import { useCallback, useEffect, useState } from "react";
import { App, Avatar, Button, Descriptions, Drawer, Form, Input, Popconfirm, Progress, Space, Spin, Switch, Table, Tabs, Tag, Tooltip, Typography, theme as antdTheme } from "antd";
import { Coins, HardDrive, KeyRound, RefreshCw, Shield, User } from "lucide-react";

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

function getRechargeRecordMeta(row: CreditLedgerItem): { label: string; color: string } {
    if (row.reason === "redeem_code") return { label: "兑换码充值", color: "green" };
    if (row.reason === "plan_grant") return { label: "套餐赠送", color: "purple" };
    if (row.reason === "admin_adjust") {
        if (row.meta?.action === "clear") return { label: "管理员清零", color: "red" };
        return row.delta >= 0 ? { label: "管理员充值", color: "blue" } : { label: "管理员扣减", color: "orange" };
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
    const { message } = App.useApp();
    const { token } = antdTheme.useToken();
    const [loading, setLoading] = useState(false);
    const [updating, setUpdating] = useState(false);
    const [savingPassword, setSavingPassword] = useState(false);
    const [detail, setDetail] = useState<AdminUserDetailResponse | null>(null);
    const [passwordForm] = Form.useForm<ResetPasswordForm>();

    const loadDetail = useCallback(
        async (targetId = userId) => {
            if (!targetId) return;
            setLoading(true);
            try {
                const res = await adminApi.getUserDetail(targetId, 7);
                setDetail(res);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "加载用户详情失败");
            } finally {
                setLoading(false);
            }
        },
        [message, userId],
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
            message.success("用户密码已修改");
            passwordForm.resetFields();
            passwordForm.setFieldsValue({ revokeSessions: true });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "修改密码失败");
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
        redeem_code: { label: "存储兑换码", color: "cyan" },
        admin_grant: { label: "管理员发放", color: "blue" },
        plan_grant: { label: "套餐赠送", color: "purple" },
    };

    const storageRows: UnifiedStorageRow[] = [];
    if (u && ((u.baseStorageQuotaBytes ?? 0) > 0 || u.baseStorageQuotaExpiresAt)) {
        const baseExpired = Boolean(u.baseStorageQuotaExpiresAt && new Date(u.baseStorageQuotaExpiresAt).getTime() <= Date.now());
        storageRows.push({
            key: "base-quota",
            source: "admin_base",
            sourceLabel: "管理员基础配额",
            sourceColor: "geekblue",
            quotaBytes: u.baseStorageQuotaBytes ?? 0,
            status: baseExpired ? "expired" : "active",
            expiresAt: u.baseStorageQuotaExpiresAt ?? null,
            createdAt: u.createdAt,
            noteText: "管理员在「配置配额」中分配的基础存储空间",
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
              { key: "canvas", label: "无限画布", value: detail.stats.canvasProjectCount, unit: "个", description: "用户同步至云端的画布项目数" },
              { key: "assets", label: "我的资产", value: detail.stats.assetCount, unit: "项", description: "收藏保存到云端的素材与提示词资产" },
              { key: "media", label: "云端媒体", value: detail.stats.activeMediaCount, unit: "个", description: "当前占用对象存储的有效图片/视频/音频文件" },
              { key: "imageLogs", label: "生图记录", value: detail.stats.imageLogCount, unit: "条", description: "生图工作台云端同步历史任务数" },
              { key: "videoLogs", label: "视频记录", value: detail.stats.videoLogCount, unit: "条", description: "视频创作台云端同步历史任务数" },
          ]
        : [];

    const rechargeLogs = detail?.recentLogs ?? [];

    return (
        <Drawer
            title="用户详情"
            open={Boolean(userId)}
            size={840}
            onClose={onClose}
            destroyOnHidden
            extra={
                <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={() => void loadDetail()}>
                    刷新
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
                                            {u.role === "admin" ? "管理员" : "普通用户"}
                                        </Tag>
                                        <Tag color={u.status === "active" ? "green" : "red"} style={{ marginInlineEnd: 0 }}>
                                            {u.status === "active" ? "正常" : "已禁用"}
                                        </Tag>
                                        {u.id === currentUserId ? <Tag style={{ marginInlineEnd: 0 }}>当前登录</Tag> : null}
                                    </div>
                                    <Typography.Text type="secondary" className="mt-1 block text-xs">
                                        @{u.username}
                                        {u.email ? ` · ${u.email}` : " · 未绑定邮箱"}
                                    </Typography.Text>
                                </div>
                            </div>
                            <Space wrap size={8}>
                                <Button size="small" icon={<Coins className="size-3.5" />} onClick={() => onOpenCredits(u)}>
                                    调整积分
                                </Button>
                                <Button size="small" icon={<HardDrive className="size-3.5" />} onClick={() => onOpenQuota(u)}>
                                    配置配额
                                </Button>
                                {u.isInitialAdmin && u.role === "admin" ? (
                                    <Tooltip title="系统初始管理员不可降级">
                                        <Button size="small" icon={<Shield className="size-3.5" />} disabled>
                                            降级
                                        </Button>
                                    </Tooltip>
                                ) : (
                                    <Popconfirm
                                        title={u.role === "admin" ? "确定将其降为普通用户吗？" : "确定将其设为系统管理员吗？"}
                                        onConfirm={() => void handleQuickUpdate({ role: u.role === "admin" ? "user" : "admin" })}
                                    >
                                        <Button size="small" icon={<Shield className="size-3.5" />} loading={updating}>
                                            {u.role === "admin" ? "降级" : "提权"}
                                        </Button>
                                    </Popconfirm>
                                )}
                                {u.id !== currentUserId && !u.isInitialAdmin ? (
                                    <Popconfirm
                                        title={u.status === "active" ? "确定禁用该账号吗？其登录会话将立即失效。" : "确定重新启用该账号吗？"}
                                        onConfirm={() => void handleQuickUpdate({ status: u.status === "active" ? "disabled" : "active" })}
                                    >
                                        <Button size="small" danger={u.status === "active"} loading={updating}>
                                            {u.status === "active" ? "禁用" : "启用"}
                                        </Button>
                                    </Popconfirm>
                                ) : null}
                            </Space>
                        </div>

                        {/* 等高 KPI 指标卡片 */}
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                            <Tooltip title={`精确余额：${formatExactCredits(u.creditBalance ?? 0)} 积分`}>
                                <div
                                    className="flex flex-col justify-between rounded-xl border p-3.5"
                                    style={{ borderColor: token.colorBorderSecondary, backgroundColor: token.colorBgContainer }}
                                >
                                    <div className="text-xs" style={{ color: token.colorTextSecondary }}>
                                        当前积分余额
                                    </div>
                                    <div className="mt-1.5 text-xl font-semibold tabular-nums" style={{ color: token.colorText }}>
                                        {formatCompactCredits(u.creditBalance ?? 0)}
                                    </div>
                                    <div className="mt-2 text-[11px]" style={{ color: token.colorTextTertiary }}>
                                        可用消费余额
                                    </div>
                                </div>
                            </Tooltip>

                            <Tooltip title={`累计精确消耗：${formatExactCredits(detail.consumption.totalConsumedCredits)} · 今日：${formatExactCredits(detail.consumption.todayConsumedCredits)}`}>
                                <div
                                    className="flex flex-col justify-between rounded-xl border p-3.5"
                                    style={{ borderColor: token.colorBorderSecondary, backgroundColor: token.colorBgContainer }}
                                >
                                    <div className="text-xs" style={{ color: token.colorTextSecondary }}>
                                        累计消耗积分
                                    </div>
                                    <div className="mt-1.5 text-xl font-semibold tabular-nums" style={{ color: token.colorText }}>
                                        {formatCompactCredits(detail.consumption.totalConsumedCredits)}
                                    </div>
                                    <div className="mt-2 text-[11px]" style={{ color: token.colorTextTertiary }}>
                                        今日净消耗 {formatCompactCredits(detail.consumption.todayConsumedCredits)}
                                    </div>
                                </div>
                            </Tooltip>

                            <Tooltip title={`累计精确充值：${formatExactCredits(detail.stats.totalRechargedCredits)} 积分`}>
                                <div
                                    className="flex flex-col justify-between rounded-xl border p-3.5"
                                    style={{ borderColor: token.colorBorderSecondary, backgroundColor: token.colorBgContainer }}
                                >
                                    <div className="text-xs" style={{ color: token.colorTextSecondary }}>
                                        累计充值积分
                                    </div>
                                    <div className="mt-1.5 text-xl font-semibold tabular-nums" style={{ color: token.colorText }}>
                                        {formatCompactCredits(detail.stats.totalRechargedCredits)}
                                    </div>
                                    <div className="mt-2 text-[11px]" style={{ color: token.colorTextTertiary }}>
                                        有效充值与调账 {rechargeLogs.length} 笔
                                    </div>
                                </div>
                            </Tooltip>

                            <div
                                className="flex flex-col justify-between rounded-xl border p-3.5"
                                style={{ borderColor: token.colorBorderSecondary, backgroundColor: token.colorBgContainer }}
                            >
                                <div className="text-xs" style={{ color: token.colorTextSecondary }}>
                                    云端存储占用
                                </div>
                                <div className="mt-1.5 truncate text-sm font-semibold tabular-nums" style={{ color: token.colorText }}>
                                    {formatBytes(usedBytes)} / {formatBytes(quotaBytes)}
                                </div>
                                <div className="mt-2 flex flex-col gap-1">
                                    <Progress percent={quotaPercent} size="small" showInfo={false} status={quotaExceeded ? "exception" : "normal"} />
                                    <div className="text-[11px]" style={{ color: quotaExpired ? token.colorError : token.colorTextTertiary }}>
                                        {quotaExpired ? "配额已过期" : u.storageQuotaExpiresAt ? `至 ${new Date(u.storageQuotaExpiresAt).toLocaleDateString("zh-CN")}` : "永久有效"}
                                    </div>
                                </div>
                            </div>
                        </div>

                        <Tabs
                            items={[
                                {
                                    key: "overview",
                                    label: "概览",
                                    children: (
                                        <div className="flex flex-col gap-4 pt-1">
                                            <Descriptions
                                                bordered
                                                size="small"
                                                column={2}
                                                styles={{ label: { whiteSpace: "nowrap", width: 112 } }}
                                            >
                                                <Descriptions.Item label="用户名">
                                                    <Typography.Text strong>@{u.username}</Typography.Text>
                                                </Descriptions.Item>
                                                <Descriptions.Item label="用户 ID">
                                                    <Typography.Text copyable className="font-mono text-xs">
                                                        {u.id}
                                                    </Typography.Text>
                                                </Descriptions.Item>
                                                <Descriptions.Item label="绑定邮箱">
                                                    {u.email ? (
                                                        <Space size={6}>
                                                            <span>{u.email}</span>
                                                            <Tag color={u.emailVerifiedAt ? "green" : "orange"} style={{ marginInlineEnd: 0 }}>
                                                                {u.emailVerifiedAt ? "已验证" : "未验证"}
                                                            </Tag>
                                                        </Space>
                                                    ) : (
                                                        <Typography.Text type="secondary">未绑定</Typography.Text>
                                                    )}
                                                </Descriptions.Item>
                                                <Descriptions.Item label="余额不足提醒">
                                                    {u.lowBalanceAlertEnabled === false
                                                        ? "已关闭"
                                                        : u.lowBalanceAlertEnabled === true
                                                          ? `自定义阈值 ${u.lowBalanceThreshold ?? 10}`
                                                          : "跟随平台默认"}
                                                </Descriptions.Item>
                                                <Descriptions.Item label="注册时间">
                                                    {new Date(u.createdAt).toLocaleString("zh-CN")}
                                                </Descriptions.Item>
                                                <Descriptions.Item label="最近登录">
                                                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString("zh-CN") : "暂无记录"}
                                                </Descriptions.Item>
                                            </Descriptions>

                                            <div>
                                                <div className="mb-2 text-xs font-medium" style={{ color: token.colorTextSecondary }}>
                                                    云端业务数据
                                                </div>
                                                <Table<WorkspaceCountRow>
                                                    rowKey="key"
                                                    size="small"
                                                    bordered
                                                    className={ADMIN_TABLE_CLASS}
                                                    dataSource={workspaceRows}
                                                    pagination={false}
                                                    columns={[
                                                        { title: "数据类型", dataIndex: "label", width: 140 },
                                                        {
                                                            title: "数量",
                                                            key: "value",
                                                            width: 110,
                                                            render: (_, row) => (
                                                                <span className="font-semibold tabular-nums">
                                                                    {row.value} {row.unit}
                                                                </span>
                                                            ),
                                                        },
                                                        {
                                                            title: "说明",
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
                                    label: `存储资源包 (${storageRows.length})`,
                                    children: (
                                        <div className="flex flex-col gap-3 pt-1">
                                            <div className="text-xs" style={{ color: token.colorTextSecondary }}>
                                                当前总有效配额：{formatBytes(quotaBytes)}（管理员基础配额：{formatBytes(u.baseStorageQuotaBytes ?? 0)}
                                                {u.baseStorageQuotaExpiresAt ? ` · 至 ${new Date(u.baseStorageQuotaExpiresAt).toLocaleDateString("zh-CN")}` : " · 永久"}
                                                ，有效资源包：{formatBytes(u.storageGrantsQuotaBytes ?? 0)}）
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
                                                    showTotal: (c) => `共 ${c} 条`,
                                                }}
                                                columns={[
                                                    {
                                                        title: "来源",
                                                        key: "source",
                                                        width: 130,
                                                        render: (_, row) => (
                                                            <Tag color={row.sourceColor} style={{ marginInlineEnd: 0 }}>
                                                                {row.sourceLabel}
                                                            </Tag>
                                                        ),
                                                    },
                                                    {
                                                        title: "容量",
                                                        dataIndex: "quotaBytes",
                                                        width: 100,
                                                        render: (v: number) => <span className="font-medium tabular-nums">{formatBytes(v)}</span>,
                                                    },
                                                    {
                                                        title: "状态",
                                                        key: "status",
                                                        width: 90,
                                                        render: (_, row) =>
                                                            row.status === "revoked" ? (
                                                                <Tag style={{ marginInlineEnd: 0 }}>已停用</Tag>
                                                            ) : row.status === "expired" ? (
                                                                <Tag color="red" style={{ marginInlineEnd: 0 }}>
                                                                    已过期
                                                                </Tag>
                                                            ) : (
                                                                <Tag color="green" style={{ marginInlineEnd: 0 }}>
                                                                    生效中
                                                                </Tag>
                                                            ),
                                                    },
                                                    {
                                                        title: "到期时间",
                                                        dataIndex: "expiresAt",
                                                        width: 170,
                                                        render: (v?: string | null) => (v ? new Date(v).toLocaleString("zh-CN") : "永久有效"),
                                                    },
                                                    {
                                                        title: "分配 / 兑换时间",
                                                        dataIndex: "createdAt",
                                                        width: 170,
                                                        render: (v?: string | null) => (v ? new Date(v).toLocaleString("zh-CN") : "—"),
                                                    },
                                                    {
                                                        title: "备注 / 兑换码",
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
                                    label: `充值记录 (${rechargeLogs.length})`,
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
                                                    showTotal: (c) => `共 ${c} 条`,
                                                }}
                                                columns={[
                                                    {
                                                        title: "时间",
                                                        dataIndex: "createdAt",
                                                        width: 170,
                                                        render: (v: string) => new Date(v).toLocaleString("zh-CN"),
                                                    },
                                                    {
                                                        title: "类型",
                                                        key: "reason",
                                                        width: 110,
                                                        render: (_, row) => {
                                                            const info = getRechargeRecordMeta(row);
                                                            return (
                                                                <Tag color={info.color} style={{ marginInlineEnd: 0 }}>
                                                                    {info.label}
                                                                </Tag>
                                                            );
                                                        },
                                                    },
                                                    {
                                                        title: "积分变动",
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
                                                        title: "变动后余额",
                                                        dataIndex: "balanceAfter",
                                                        width: 110,
                                                        render: (v: number) => (
                                                            <Tooltip title={formatExactCredits(v)}>
                                                                <span className="tabular-nums">{formatCompactCredits(v)}</span>
                                                            </Tooltip>
                                                        ),
                                                    },
                                                    {
                                                        title: "备注 / 兑换码",
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
                                    label: "修改密码",
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
                                                    label="新密码"
                                                    rules={[
                                                        { required: true, message: "请输入新密码" },
                                                        { min: 6, message: "新密码至少 6 位" },
                                                        { max: 128, message: "密码不能超过 128 个字符" },
                                                    ]}
                                                >
                                                    <Input.Password placeholder="输入新密码（至少 6 位）" autoComplete="new-password" />
                                                </Form.Item>
                                                <Form.Item
                                                    name="confirmPassword"
                                                    label="确认新密码"
                                                    dependencies={["newPassword"]}
                                                    rules={[
                                                        { required: true, message: "请再次输入新密码" },
                                                        ({ getFieldValue }) => ({
                                                            validator(_, value) {
                                                                if (!value || getFieldValue("newPassword") === value) {
                                                                    return Promise.resolve();
                                                                }
                                                                return Promise.reject(new Error("两次输入的新密码不一致"));
                                                            },
                                                        }),
                                                    ]}
                                                >
                                                    <Input.Password placeholder="再次输入新密码确认" autoComplete="new-password" />
                                                </Form.Item>
                                                <Form.Item name="revokeSessions" label="修改后强制该用户重新登录" valuePropName="checked">
                                                    <Switch />
                                                </Form.Item>
                                                <Button type="primary" htmlType="submit" icon={<KeyRound className="size-4" />} loading={savingPassword}>
                                                    确认修改密码
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
