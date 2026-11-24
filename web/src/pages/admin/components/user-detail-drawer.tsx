/** 管理员后台用户详情抽屉（NewAPI 风格）：展示账号资料、积分/消耗趋势、存储资源包、近期流水与登录会话。 */
import { useCallback, useEffect, useState } from "react";
import { App, Avatar, Button, Card, Col, Descriptions, Drawer, Popconfirm, Progress, Row, Space, Spin, Statistic, Table, Tabs, Tag, Typography } from "antd";
import { Coins, HardDrive, RefreshCw, Shield, User } from "lucide-react";

import { ADMIN_TABLE_CLASS, ADMIN_TABLE_SCROLL } from "@/pages/admin/components/table-row-actions";
import { ConsumptionTrendCard, formatBytes, ledgerReasonMeta } from "@/pages/admin/user-panels";
import { adminApi, type AdminUserDetailResponse, type AdminUserItem, type CreditLedgerItem, type StorageGrantItem } from "@/services/api/server";

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
    const [days, setDays] = useState<7 | 14 | 30>(7);
    const [loading, setLoading] = useState(false);
    const [updating, setUpdating] = useState(false);
    const [detail, setDetail] = useState<AdminUserDetailResponse | null>(null);

    const loadDetail = useCallback(
        async (targetId = userId, targetDays = days) => {
            if (!targetId) return;
            setLoading(true);
            try {
                const res = await adminApi.getUserDetail(targetId, targetDays);
                setDetail(res);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "加载用户详情失败");
            } finally {
                setLoading(false);
            }
        },
        [days, message, userId],
    );

    useEffect(() => {
        if (!userId) {
            setDetail(null);
            return;
        }
        void loadDetail(userId, days);
    }, [days, loadDetail, refreshKey, userId]);

    const handleQuickUpdate = async (payload: { role?: "admin" | "user"; status?: "active" | "disabled" }) => {
        if (!detail || updating) return;
        setUpdating(true);
        try {
            await onUpdateUser(detail.user.id, payload);
            await loadDetail(detail.user.id, days);
        } finally {
            setUpdating(false);
        }
    };

    const u = detail?.user;
    const usedBytes = u?.storageUsedBytes ?? 0;
    const quotaBytes = u?.storageQuotaBytes ?? 0;
    const quotaExpired = Boolean(u?.storageQuotaExpiresAt && new Date(u.storageQuotaExpiresAt).getTime() <= Date.now());
    const quotaExceeded = quotaExpired || quotaBytes <= 0 || usedBytes >= quotaBytes;
    const quotaPercent = quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : 100;

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
                    <div className="flex flex-col gap-4">
                        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-black/10 p-4 dark:border-white/10">
                            <div className="flex min-w-0 items-center gap-3">
                                <Avatar size={46} src={u.avatarUrl || undefined} icon={<User className="size-5" />} />
                                <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="truncate text-base font-semibold">{u.displayName || u.username}</span>
                                        <Tag color={u.role === "admin" ? "blue" : "default"} style={{ marginInlineEnd: 0 }}>
                                            {u.role === "admin" ? "管理员" : "普通用户"}
                                        </Tag>
                                        <Tag color={u.status === "active" ? "green" : "red"} style={{ marginInlineEnd: 0 }}>
                                            {u.status === "active" ? "正常" : "已禁用"}
                                        </Tag>
                                        {u.id === currentUserId ? <Tag style={{ marginInlineEnd: 0 }}>当前登录</Tag> : null}
                                    </div>
                                    <Typography.Text type="secondary" className="mt-0.5 block text-xs">
                                        @{u.username}
                                        {u.email ? ` · ${u.email}` : " · 未绑定邮箱"}
                                    </Typography.Text>
                                </div>
                            </div>
                            <Space wrap>
                                <Button size="small" icon={<Coins className="size-3.5" />} onClick={() => onOpenCredits(u)}>
                                    调整积分
                                </Button>
                                <Button size="small" icon={<HardDrive className="size-3.5" />} onClick={() => onOpenQuota(u)}>
                                    配置配额
                                </Button>
                                <Popconfirm
                                    title={u.role === "admin" ? "确定将其降为普通用户吗？" : "确定将其设为系统管理员吗？"}
                                    onConfirm={() => void handleQuickUpdate({ role: u.role === "admin" ? "user" : "admin" })}
                                >
                                    <Button size="small" icon={<Shield className="size-3.5" />} loading={updating}>
                                        {u.role === "admin" ? "降级" : "提权"}
                                    </Button>
                                </Popconfirm>
                                {u.id !== currentUserId ? (
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

                        <Row gutter={[12, 12]}>
                            <Col xs={12} md={6}>
                                <Card size="small">
                                    <Statistic title="当前积分余额" value={u.creditBalance ?? 0} precision={4} />
                                </Card>
                            </Col>
                            <Col xs={12} md={6}>
                                <Card size="small">
                                    <Statistic
                                        title="累计消耗积分"
                                        value={detail.consumption.totalConsumedCredits}
                                        precision={4}
                                        suffix={<Typography.Text type="secondary" className="text-xs">今日 {detail.consumption.todayConsumedCredits}</Typography.Text>}
                                    />
                                </Card>
                            </Col>
                            <Col xs={12} md={6}>
                                <Card size="small">
                                    <Statistic
                                        title="累计充值积分"
                                        value={detail.stats.totalRechargedCredits}
                                        precision={2}
                                        suffix={<Typography.Text type="secondary" className="text-xs">近{days}天 {detail.consumption.rangeCalls}次</Typography.Text>}
                                    />
                                </Card>
                            </Col>
                            <Col xs={12} md={6}>
                                <Card size="small">
                                    <div className="text-xs text-stone-500">云端存储占用</div>
                                    <div className="mt-1 text-sm font-semibold">
                                        {formatBytes(usedBytes)} / {formatBytes(quotaBytes)}
                                    </div>
                                    <Progress percent={quotaPercent} size="small" showInfo={false} status={quotaExceeded ? "exception" : "normal"} />
                                    <div className="text-[11px] text-stone-500">
                                        {quotaExpired ? "已过期" : u.storageQuotaExpiresAt ? `至 ${new Date(u.storageQuotaExpiresAt).toLocaleDateString("zh-CN")}` : "永久有效"}
                                    </div>
                                </Card>
                            </Col>
                        </Row>

                        <Tabs
                            items={[
                                {
                                    key: "overview",
                                    label: "概览与消耗趋势",
                                    children: (
                                        <div className="flex flex-col gap-4">
                                            <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }} styles={{ label: { whiteSpace: "nowrap", width: 115 } }}>
                                                <Descriptions.Item label="用户 ID">
                                                    <Typography.Text copyable className="font-mono text-xs">
                                                        {u.id}
                                                    </Typography.Text>
                                                </Descriptions.Item>
                                                <Descriptions.Item label="用户名">@{u.username}</Descriptions.Item>
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
                                                <Descriptions.Item label="注册时间">{new Date(u.createdAt).toLocaleString("zh-CN")}</Descriptions.Item>
                                                <Descriptions.Item label="最近登录">
                                                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString("zh-CN") : "暂无记录"}
                                                </Descriptions.Item>
                                                <Descriptions.Item label="云端业务数据" span={2}>
                                                    画布 {detail.stats.canvasProjectCount} 个 · 资产 {detail.stats.assetCount} 项 · 云端媒体 {detail.stats.activeMediaCount} 个 · 生图记录 {detail.stats.imageLogCount} 条 · 视频记录 {detail.stats.videoLogCount} 条 · 在线会话 {detail.stats.activeSessionCount} 个
                                                </Descriptions.Item>
                                                {u.storageCleanedAt ? (
                                                    <Descriptions.Item label="最近逾期清理" span={2}>
                                                        {new Date(u.storageCleanedAt).toLocaleString("zh-CN")}
                                                    </Descriptions.Item>
                                                ) : null}
                                            </Descriptions>

                                            <ConsumptionTrendCard
                                                title="积分消耗趋势"
                                                days={days}
                                                onDaysChange={setDays}
                                                dailyTrend={detail.consumption.dailyTrend}
                                                topModels={detail.consumption.topModels}
                                                rangeConsumedCredits={detail.consumption.rangeConsumedCredits}
                                                rangeCalls={detail.consumption.rangeCalls}
                                                loading={loading}
                                            />
                                        </div>
                                    ),
                                },
                                {
                                    key: "grants",
                                    label: `存储资源包 (${detail.grants.length})`,
                                    children: (
                                        <div className="flex flex-col gap-3">
                                            <div className="text-xs text-stone-500">
                                                基础配额：{formatBytes(u.baseStorageQuotaBytes ?? 0)}
                                                {u.baseStorageQuotaExpiresAt ? `（至 ${new Date(u.baseStorageQuotaExpiresAt).toLocaleString("zh-CN")}）` : "（永久）"}
                                                {" · "}有效资源包合计：{formatBytes(u.storageGrantsQuotaBytes ?? 0)}
                                            </div>
                                            <Table<StorageGrantItem>
                                                rowKey="id"
                                                size="small"
                                                className={ADMIN_TABLE_CLASS}
                                                scroll={ADMIN_TABLE_SCROLL}
                                                dataSource={detail.grants}
                                                pagination={{ defaultPageSize: 10, showSizeChanger: true, pageSizeOptions: [10, 20, 30, 50, 100], showTotal: (c) => `共 ${c} 条` }}
                                                columns={[
                                                    { title: "容量", dataIndex: "quotaBytes", width: 100, render: (v: number) => formatBytes(v) },
                                                    { title: "来源", dataIndex: "source", width: 110, render: (v: string) => (v === "redeem_code" ? "存储兑换码" : v) },
                                                    {
                                                        title: "状态",
                                                        key: "status",
                                                        width: 90,
                                                        render: (_, g) =>
                                                            g.status === "revoked" ? (
                                                                <Tag>已停用</Tag>
                                                            ) : g.isExpired ? (
                                                                <Tag color="red">已过期</Tag>
                                                            ) : (
                                                                <Tag color="green">生效中</Tag>
                                                            ),
                                                    },
                                                    {
                                                        title: "到期时间",
                                                        dataIndex: "expiresAt",
                                                        width: 170,
                                                        render: (v?: string | null) => (v ? new Date(v).toLocaleString("zh-CN") : "永久有效"),
                                                    },
                                                    { title: "创建时间", dataIndex: "createdAt", width: 170, render: (v: string) => new Date(v).toLocaleString("zh-CN") },
                                                    { title: "备注 / 兑换码", key: "note", width: 180, render: (_, g) => g.refId || g.note || "—" },
                                                ]}
                                            />
                                        </div>
                                    ),
                                },
                                {
                                    key: "logs",
                                    label: `最近流水 (${detail.recentLogs.length})`,
                                    children: (
                                        <Table<CreditLedgerItem>
                                            rowKey="id"
                                            size="small"
                                            className={ADMIN_TABLE_CLASS}
                                            scroll={ADMIN_TABLE_SCROLL}
                                            dataSource={detail.recentLogs}
                                            pagination={false}
                                            columns={[
                                                { title: "时间", dataIndex: "createdAt", width: 165, render: (v: string) => new Date(v).toLocaleString("zh-CN") },
                                                {
                                                    title: "类型",
                                                    dataIndex: "reason",
                                                    width: 100,
                                                    render: (reason: string) => {
                                                        const info = ledgerReasonMeta[reason];
                                                        return <Tag color={info?.color}>{info?.label || reason}</Tag>;
                                                    },
                                                },
                                                {
                                                    title: "模型",
                                                    key: "model",
                                                    width: 160,
                                                    render: (_, row) => (typeof row.meta?.model === "string" && row.meta.model ? <Tag>{row.meta.model}</Tag> : "—"),
                                                },
                                                {
                                                    title: "积分变动",
                                                    dataIndex: "delta",
                                                    width: 100,
                                                    render: (delta: number) => <Tag color={delta >= 0 ? "green" : "volcano"}>{delta >= 0 ? `+${delta}` : delta}</Tag>,
                                                },
                                                { title: "结余", dataIndex: "balanceAfter", width: 90 },
                                            ]}
                                        />
                                    ),
                                },
                                {
                                    key: "sessions",
                                    label: `登录会话 (${detail.sessions.length})`,
                                    children: (
                                        <Table
                                            rowKey="id"
                                            size="small"
                                            className={ADMIN_TABLE_CLASS}
                                            scroll={ADMIN_TABLE_SCROLL}
                                            dataSource={detail.sessions}
                                            pagination={false}
                                            columns={[
                                                {
                                                    title: "状态",
                                                    key: "active",
                                                    width: 85,
                                                    render: (_, s) => <Tag color={s.active ? "green" : "default"}>{s.active ? "在线" : s.revokedAt ? "已注销" : "已过期"}</Tag>,
                                                },
                                                { title: "IP 地址", dataIndex: "ipAddress", width: 140, render: (v: string) => v || "—" },
                                                { title: "设备 / UA", dataIndex: "userAgent", width: 260, ellipsis: true, render: (v: string) => v || "—" },
                                                { title: "登录时间", dataIndex: "createdAt", width: 165, render: (v: string) => new Date(v).toLocaleString("zh-CN") },
                                                { title: "过期时间", dataIndex: "expiresAt", width: 165, render: (v: string) => new Date(v).toLocaleString("zh-CN") },
                                            ]}
                                        />
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
