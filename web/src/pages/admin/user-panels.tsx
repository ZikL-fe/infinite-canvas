/** 个人后台与公共面板组件：概览趋势、平台公告卡片、账号安全维护、充值钱包、NewAPI 风格使用日志及云端媒体清理。 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Avatar, Button, Card, Col, DatePicker, Descriptions, Empty, Form, Input, Modal, Popconfirm, Progress, Row, Segmented, Select, Space, Statistic, Switch, Table, Tag, Tooltip, Typography, theme as antdTheme } from "antd";
import type { Dayjs } from "dayjs";
import { Eye, Gift, KeyRound, Laptop, Megaphone, Pin, RefreshCw, Search, Trash2, TrendingUp, User } from "lucide-react";

import {
    accountApi,
    adminApi,
    billingApi,
    storageApi,
    type AccountOverviewResponse,
    type AccountProfileResponse,
    type AccountSessionItem,
    type AnnouncementItem,
    type CreditLedgerItem,
    type CreditLedgerSummary,
    type DailyTrendItem,
    type MediaItem,
    type TopModelUsageItem,
} from "@/services/api/server";
import { useUserStore } from "@/stores/use-user-store";

export function formatBytes(bytes: number) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const val = bytes / Math.pow(1024, idx);
    return `${val >= 100 || idx === 0 ? val.toFixed(0) : val.toFixed(2)} ${units[idx]}`;
}

const kindLabels: Record<string, string> = {
    image: "图片",
    video: "视频",
    audio: "音频",
    file: "其他文件",
};

export const ledgerReasonMeta: Record<string, { label: string; color: string }> = {
    text_gen: { label: "对话调用", color: "blue" },
    image_gen: { label: "图片生成", color: "purple" },
    video_gen: { label: "视频生成", color: "geekblue" },
    audio_gen: { label: "语音生成", color: "cyan" },
    redeem_code: { label: "兑换码兑换", color: "green" },
    admin_adjust: { label: "后台调整", color: "gold" },
    refund: { label: "失败退回", color: "lime" },
    plan_grant: { label: "套餐赠送", color: "green" },
};

const taskStatusMeta: Record<string, { label: string; color: string }> = {
    not_started: { label: "未开始", color: "default" },
    processing: { label: "进行中", color: "processing" },
    completed: { label: "已完成", color: "success" },
    failed: { label: "已失败", color: "error" },
    refunded: { label: "已退回", color: "warning" },
};

function getLedgerTaskStatus(record: CreditLedgerItem) {
    const raw = typeof record.meta?.taskStatus === "string" ? record.meta.taskStatus : "";
    if (raw && taskStatusMeta[raw]) return taskStatusMeta[raw];
    if (record.reason === "refund") return taskStatusMeta.refunded;
    return taskStatusMeta.completed;
}

function formatDurationSec(ms: number) {
    return `${(ms / 1000).toFixed(2)}s`;
}

/** 根据流式状态与耗时计算 `tok/s` 输出速度及 `首字 / 总耗时` 展示文案。 */
function getLedgerTimingStats(meta?: Record<string, unknown>) {
    const isStream = typeof meta?.isStream === "boolean" ? meta.isStream : undefined;
    const durationMs = typeof meta?.durationMs === "number" && meta.durationMs > 0 ? meta.durationMs : undefined;
    const firstTokenMs = typeof meta?.firstTokenMs === "number" && meta.firstTokenMs > 0 ? meta.firstTokenMs : undefined;
    const outputTokens = typeof meta?.outputTokens === "number" ? meta.outputTokens : 0;
    let tokPerSec = typeof meta?.tokensPerSecond === "number" && meta.tokensPerSecond > 0 ? meta.tokensPerSecond : 0;
    if (!tokPerSec && outputTokens > 0 && durationMs) {
        const genMs = firstTokenMs && durationMs > firstTokenMs ? durationMs - firstTokenMs : durationMs;
        tokPerSec = Math.round((outputTokens / Math.max(0.001, genMs / 1000)) * 10) / 10;
    }

    let durationText = "";
    if (durationMs !== undefined) {
        durationText =
            isStream && firstTokenMs !== undefined
                ? `${formatDurationSec(firstTokenMs)} / ${formatDurationSec(durationMs)}`
                : formatDurationSec(durationMs);
    }

    return { isStream, durationMs, firstTokenMs, durationText, tokPerSec };
}

function formatLedgerUsageDetail(record: CreditLedgerItem) {
    const meta = record.meta || {};
    const parts: string[] = [];
    if (typeof meta.inputTokens === "number" || typeof meta.outputTokens === "number") {
        const cached = typeof meta.cachedInputTokens === "number" && meta.cachedInputTokens > 0 ? ` · 缓存 ${meta.cachedInputTokens}` : "";
        parts.push(`输入 ${meta.inputTokens ?? 0}${cached} · 输出 ${meta.outputTokens ?? 0} tokens`);
    }
    if (typeof meta.count === "number") parts.push(`${meta.count} 张`);
    if (typeof meta.resolutionTier === "string" && meta.resolutionTier) parts.push(meta.resolutionTier.toUpperCase());
    else if (typeof meta.size === "string" && meta.size) parts.push(meta.size);
    if (typeof meta.seconds === "number") parts.push(`${meta.seconds} 秒`);
    if (meta.hasReferenceVideo === true) parts.push("含参考视频");
    if (typeof meta.durationSeconds === "number") parts.push(`时长 ${meta.durationSeconds} 秒`);
    if (typeof meta.code === "string" && meta.code) parts.push(`兑换码 ${meta.code}`);
    if (typeof meta.detail === "string" && meta.detail) parts.push(meta.detail);
    if (typeof meta.note === "string" && meta.note) parts.push(meta.note);
    return parts.join(" · ") || "—";
}

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
                        <Space>
                            <Typography.Text type="secondary" className="text-xs">
                                周期消耗 {rangeConsumedCredits} 积分 · {rangeCalls} 次
                            </Typography.Text>
                            <Segmented
                                size="small"
                                value={days}
                                onChange={(val) => onDaysChange(Number(val))}
                                options={[
                                    { label: "7 天", value: 7 },
                                    { label: "14 天", value: 14 },
                                    { label: "30 天", value: 30 },
                                ]}
                            />
                        </Space>
                    }
                >
                    {dailyTrend.length ? (
                        <div className="flex h-48 items-end gap-1.5 pt-4">
                            {dailyTrend.map((item) => {
                                const heightPct = item.credits > 0 ? Math.max(6, Math.round((item.credits / maxCredits) * 100)) : 2;
                                return (
                                    <Tooltip key={item.date} title={`${item.date}：消耗 ${item.credits} 积分（${item.calls} 次）`}>
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
                    ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无消耗趋势数据" />
                    )}
                </Card>
            </Col>
            <Col xs={24} lg={9}>
                <Card loading={loading} title={`近 ${days} 天模型消耗排行`} className="h-full">
                    {topModels.length ? (
                        <div className="flex flex-col gap-3">
                            {topModels.map((item) => {
                                const percent = totalTopCredits > 0 ? Math.round((item.credits / totalTopCredits) * 100) : 0;
                                return (
                                    <div key={item.model} className="flex flex-col gap-1">
                                        <div className="flex items-center justify-between gap-2 text-sm">
                                            <span className="truncate font-medium">{item.model}</span>
                                            <Typography.Text type="secondary" className="shrink-0 text-xs">
                                                {item.credits} 积分 · {item.calls} 次
                                            </Typography.Text>
                                        </div>
                                        <Progress percent={percent} size="small" showInfo={false} />
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无模型消耗记录" />
                    )}
                </Card>
            </Col>
        </Row>
    );
}

const announcementLevelTag: Record<AnnouncementItem["level"], { label: string; color: string }> = {
    info: { label: "通知", color: "blue" },
    warning: { label: "重要提醒", color: "orange" },
    success: { label: "更新喜报", color: "green" },
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
    const [detail, setDetail] = useState<AnnouncementItem | null>(null);

    return (
        <>
            <Card
                loading={loading}
                title={
                    <span className="inline-flex items-center gap-2">
                        <Megaphone className="size-4" />
                        平台公告
                    </span>
                }
                extra={extra}
            >
                {items.length ? (
                    <div className="flex flex-col gap-2.5">
                        {items.map((item) => {
                            const lvl = announcementLevelTag[item.level] || announcementLevelTag.info;
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
                                                    置顶
                                                </Tag>
                                            ) : null}
                                            <Tag color={lvl.color}>{lvl.label}</Tag>
                                            <span className="font-medium">{item.title}</span>
                                        </div>
                                        <Typography.Text type="secondary" className="text-xs">
                                            {new Date(item.createdAt).toLocaleString("zh-CN")}
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
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无平台公告" />
                )}
            </Card>

            <Modal open={Boolean(detail)} title={detail?.title} onCancel={() => setDetail(null)} footer={null}>
                {detail ? (
                    <div className="flex flex-col gap-3">
                        <Space>
                            {detail.isPinned ? <Tag color="red">置顶</Tag> : null}
                            <Tag color={(announcementLevelTag[detail.level] || announcementLevelTag.info).color}>
                                {(announcementLevelTag[detail.level] || announcementLevelTag.info).label}
                            </Tag>
                            <Typography.Text type="secondary" className="text-xs">
                                发布于 {new Date(detail.createdAt).toLocaleString("zh-CN")}
                            </Typography.Text>
                        </Space>
                        <div className="whitespace-pre-wrap text-sm leading-6">{detail.content}</div>
                    </div>
                ) : null}
            </Modal>
        </>
    );
}

export function UserOverviewPanel({ onOpenWallet }: { onOpenWallet?: () => void }) {
    const { message } = App.useApp();
    const [days, setDays] = useState(7);
    const [data, setData] = useState<AccountOverviewResponse | null>(null);
    const [loading, setLoading] = useState(false);

    const loadOverview = useCallback(
        async (targetDays = days) => {
            setLoading(true);
            try {
                setData(await accountApi.getOverview(targetDays));
            } catch (error) {
                message.error(error instanceof Error ? error.message : "加载个人概览失败");
            } finally {
                setLoading(false);
            }
        },
        [days, message],
    );

    useEffect(() => {
        void loadOverview(days);
    }, [days, loadOverview]);

    return (
        <div className="flex flex-col gap-5">
            <Row gutter={[16, 16]}>
                <Col xs={24} sm={12} md={6}>
                    <Card loading={loading}>
                        <Statistic
                            title="当前可用积分"
                            value={data?.creditBalance ?? 0}
                            suffix={
                                onOpenWallet ? (
                                    <Button type="link" size="small" onClick={onOpenWallet}>
                                        去兑换
                                    </Button>
                                ) : null
                            }
                        />
                    </Card>
                </Col>
                <Col xs={24} sm={12} md={6}>
                    <Card loading={loading}>
                        <Statistic title="今日消耗积分" value={data?.todayConsumedCredits ?? 0} />
                    </Card>
                </Col>
                <Col xs={24} sm={12} md={6}>
                    <Card loading={loading}>
                        <Statistic title="累计消耗积分" value={data?.totalConsumedCredits ?? 0} />
                    </Card>
                </Col>
                <Col xs={24} sm={12} md={6}>
                    <Card loading={loading}>
                        <Statistic
                            title="云端存储 / 画布"
                            value={formatBytes(data?.storageUsedBytes ?? 0)}
                            suffix={
                                <Typography.Text type="secondary" className="text-xs">
                                    {data?.canvasProjectCount ?? 0} 画布
                                </Typography.Text>
                            }
                        />
                    </Card>
                </Col>
            </Row>

            <ConsumptionTrendCard
                title="我的积分消耗趋势"
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

export function ProfileSecurityPanel() {
    const { message } = App.useApp();
    const user = useUserStore((state) => state.user);
    const setUser = useUserStore((state) => state.setUser);

    const [profileData, setProfileData] = useState<AccountProfileResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [savingProfile, setSavingProfile] = useState(false);
    const [changingPassword, setChangingPassword] = useState(false);
    const [sessions, setSessions] = useState<AccountSessionItem[]>([]);
    const [sessionsLoading, setSessionsLoading] = useState(false);

    const [profileForm] = Form.useForm<{ displayName: string; email: string; avatarUrl: string }>();
    const [passwordForm] = Form.useForm<{ currentPassword: string; newPassword: string; confirmPassword: string; revokeOtherSessions: boolean }>();

    const loadProfile = useCallback(async () => {
        setLoading(true);
        try {
            const res = await accountApi.getProfile();
            setProfileData(res);
            setUser(res.user);
            profileForm.setFieldsValue({
                displayName: res.user.displayName,
                email: res.user.email || "",
                avatarUrl: res.user.avatarUrl || "",
            });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载个人信息失败");
        } finally {
            setLoading(false);
        }
    }, [message, profileForm, setUser]);

    const loadSessions = useCallback(async () => {
        setSessionsLoading(true);
        try {
            const res = await accountApi.listSessions();
            setSessions(res.items);
        } catch {
            // ignore
        } finally {
            setSessionsLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadProfile();
        void loadSessions();
    }, [loadProfile, loadSessions]);

    const handleSaveProfile = async (values: { displayName: string; email: string; avatarUrl: string }) => {
        setSavingProfile(true);
        try {
            const res = await accountApi.updateProfile({
                displayName: values.displayName.trim(),
                email: values.email.trim(),
                avatarUrl: values.avatarUrl.trim(),
            });
            setUser(res.user);
            message.success("个人信息已保存");
            void loadProfile();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        } finally {
            setSavingProfile(false);
        }
    };

    const handleChangePassword = async (values: { currentPassword: string; newPassword: string; revokeOtherSessions: boolean }) => {
        setChangingPassword(true);
        try {
            await accountApi.changePassword({
                currentPassword: values.currentPassword,
                newPassword: values.newPassword,
                revokeOtherSessions: values.revokeOtherSessions,
            });
            passwordForm.resetFields();
            message.success("密码已修改");
            void loadSessions();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "修改密码失败");
        } finally {
            setChangingPassword(false);
        }
    };

    const handleRevokeSession = async (id: string) => {
        try {
            await accountApi.revokeSession(id);
            message.success("已下线该登录设备");
            void loadSessions();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "操作失败");
        }
    };

    const handleRevokeOtherSessions = async () => {
        try {
            await accountApi.revokeOtherSessions();
            message.success("已退出其他所有登录设备");
            void loadSessions();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "操作失败");
        }
    };

    const detail = profileData?.user || user;
    const avatarWatch = Form.useWatch("avatarUrl", profileForm);

    return (
        <div className="flex flex-col gap-5">
            <Row gutter={[16, 16]}>
                <Col xs={24} sm={12} md={6}>
                    <Card loading={loading}>
                        <Statistic title="当前积分余额" value={detail?.creditBalance ?? 0} />
                    </Card>
                </Col>
                <Col xs={24} sm={12} md={6}>
                    <Card loading={loading}>
                        <Statistic title="已用云端存储" value={formatBytes(detail?.storageUsedBytes ?? 0)} />
                    </Card>
                </Col>
                <Col xs={24} sm={12} md={6}>
                    <Card loading={loading}>
                        <Statistic title="云端画布数" value={profileData?.stats.canvasProjectCount ?? 0} />
                    </Card>
                </Col>
                <Col xs={24} sm={12} md={6}>
                    <Card loading={loading}>
                        <Statistic title="我的素材数" value={profileData?.stats.assetCount ?? 0} />
                    </Card>
                </Col>
            </Row>

            <Card title="账号详情">
                <Descriptions column={{ xs: 1, sm: 2 }} bordered size="small">
                    <Descriptions.Item label="用户名">@{detail?.username}</Descriptions.Item>
                    <Descriptions.Item label="账号角色">
                        <Tag color={detail?.role === "admin" ? "blue" : "default"}>{detail?.role === "admin" ? "系统管理员" : "普通用户"}</Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label="账号状态">
                        <Tag color={detail?.status === "active" ? "green" : "red"}>{detail?.status === "active" ? "正常" : "已禁用"}</Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label="WebDAV 分配" span={2}>
                        {profileData?.webdav?.enabled ? (
                            <div className="flex flex-wrap items-center gap-2">
                                <Tag color={profileData.webdav.isExpired ? "red" : "cyan"}>{profileData.webdav.directory}</Tag>
                                {profileData.webdav.isExpired ? <Tag color="red">已过期</Tag> : null}
                                {profileData.webdav.isQuotaExceeded ? <Tag color="volcano">空间已满</Tag> : null}
                                <Typography.Text type="secondary" className="text-xs">
                                    已用 {formatBytes(profileData.webdav.usedBytes ?? 0)}
                                    {profileData.webdav.quotaBytes ? ` / ${formatBytes(profileData.webdav.quotaBytes)}` : " / 不限空间"}
                                    {profileData.webdav.expiresAt
                                        ? ` · 有效期至 ${new Date(profileData.webdav.expiresAt).toLocaleString("zh-CN")}`
                                        : " · 永久有效"}
                                </Typography.Text>
                            </div>
                        ) : (
                            <Tag>未分配</Tag>
                        )}
                    </Descriptions.Item>
                    <Descriptions.Item label="注册时间">
                        {profileData?.user.createdAt ? new Date(profileData.user.createdAt).toLocaleString("zh-CN") : "—"}
                    </Descriptions.Item>
                    <Descriptions.Item label="最近登录">
                        {profileData?.user.lastLoginAt ? new Date(profileData.user.lastLoginAt).toLocaleString("zh-CN") : "—"}
                    </Descriptions.Item>
                </Descriptions>
            </Card>

            <Row gutter={[16, 16]}>
                <Col xs={24} lg={12}>
                    <Card
                        title={
                            <span className="inline-flex items-center gap-2">
                                <User className="size-4" />
                                基本资料维护
                            </span>
                        }
                    >
                        <div className="mb-4 flex items-center gap-3">
                            <Avatar size={48} src={avatarWatch || detail?.avatarUrl || undefined}>
                                {(detail?.displayName || detail?.username || "U").slice(0, 1).toUpperCase()}
                            </Avatar>
                            <div>
                                <div className="font-medium">{detail?.displayName || detail?.username}</div>
                                <Typography.Text type="secondary" className="text-xs">
                                    @{detail?.username}
                                </Typography.Text>
                            </div>
                        </div>
                        <Form form={profileForm} layout="vertical" onFinish={handleSaveProfile}>
                            <Form.Item name="displayName" label="显示名称" rules={[{ required: true, message: "请输入显示名称" }]}>
                                <Input maxLength={48} placeholder="请输入显示名称" />
                            </Form.Item>
                            <Form.Item name="email" label="绑定邮箱" rules={[{ type: "email", message: "邮箱格式不正确" }]}>
                                <Input placeholder="example@domain.com" />
                            </Form.Item>
                            <Form.Item name="avatarUrl" label="头像地址（可选）">
                                <Input placeholder="https://..." />
                            </Form.Item>
                            <Button type="primary" htmlType="submit" loading={savingProfile}>
                                保存资料
                            </Button>
                        </Form>
                    </Card>
                </Col>

                <Col xs={24} lg={12}>
                    <Card
                        title={
                            <span className="inline-flex items-center gap-2">
                                <KeyRound className="size-4" />
                                账号安全 · 修改密码
                            </span>
                        }
                    >
                        <Form form={passwordForm} layout="vertical" initialValues={{ revokeOtherSessions: true }} onFinish={handleChangePassword}>
                            <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true, message: "请输入当前密码" }]}>
                                <Input.Password placeholder="输入当前使用的密码" />
                            </Form.Item>
                            <Form.Item
                                name="newPassword"
                                label="新密码"
                                rules={[
                                    { required: true, message: "请输入新密码" },
                                    { min: 6, message: "新密码至少 6 位" },
                                ]}
                            >
                                <Input.Password placeholder="至少 6 位字符" />
                            </Form.Item>
                            <Form.Item
                                name="confirmPassword"
                                label="确认新密码"
                                dependencies={["newPassword"]}
                                rules={[
                                    { required: true, message: "请再次输入新密码" },
                                    ({ getFieldValue }) => ({
                                        validator(_, value) {
                                            if (!value || getFieldValue("newPassword") === value) return Promise.resolve();
                                            return Promise.reject(new Error("两次输入的新密码不一致"));
                                        },
                                    }),
                                ]}
                            >
                                <Input.Password placeholder="再次输入新密码" />
                            </Form.Item>
                            <Form.Item name="revokeOtherSessions" label="修改密码后退出其他所有登录设备" valuePropName="checked">
                                <Switch />
                            </Form.Item>
                            <Button type="primary" htmlType="submit" loading={changingPassword}>
                                更新密码
                            </Button>
                        </Form>
                    </Card>
                </Col>
            </Row>

            <Card
                title={
                    <span className="inline-flex items-center gap-2">
                        <Laptop className="size-4" />
                        登录设备与会话管理
                    </span>
                }
                extra={
                    <Space>
                        <Popconfirm title="确定下线除当前浏览器之外的所有登录设备吗？" onConfirm={() => void handleRevokeOtherSessions()}>
                            <Button size="small">退出其他所有设备</Button>
                        </Popconfirm>
                        <Button size="small" icon={<RefreshCw className="size-3.5" />} onClick={() => void loadSessions()}>
                            刷新
                        </Button>
                    </Space>
                }
            >
                <Table<AccountSessionItem>
                    rowKey="id"
                    size="small"
                    loading={sessionsLoading}
                    dataSource={sessions}
                    pagination={false}
                    columns={[
                        {
                            title: "设备 / 浏览器",
                            key: "ua",
                            render: (_, record) => (
                                <div className="flex items-center gap-2">
                                    <Typography.Text ellipsis={{ tooltip: record.userAgent }} style={{ maxWidth: 360 }}>
                                        {record.userAgent || "未知设备"}
                                    </Typography.Text>
                                    {record.isCurrent ? <Tag color="green">当前设备</Tag> : null}
                                </div>
                            ),
                        },
                        { title: "IP", dataIndex: "ip", width: 130, render: (v: string) => v || "—" },
                        { title: "登录时间", dataIndex: "createdAt", width: 165, render: (v: string) => new Date(v).toLocaleString("zh-CN") },
                        { title: "过期时间", dataIndex: "expiresAt", width: 165, render: (v: string) => new Date(v).toLocaleString("zh-CN") },
                        {
                            title: "操作",
                            key: "actions",
                            width: 90,
                            render: (_, record) =>
                                record.isCurrent ? (
                                    <Typography.Text type="secondary">使用中</Typography.Text>
                                ) : (
                                    <Popconfirm title="确定强制下线该设备吗？" onConfirm={() => void handleRevokeSession(record.id)}>
                                        <Button size="small" type="link" danger>
                                            下线
                                        </Button>
                                    </Popconfirm>
                                ),
                        },
                    ]}
                />
            </Card>
        </div>
    );
}

const emptyLedgerSummary: CreditLedgerSummary = {
    totalConsumed: 0,
    totalRecharged: 0,
    recordCount: 0,
    consumeCalls: 0,
    totalTokens: 0,
    totalInputTokens: 0,
    totalCachedTokens: 0,
    totalOutputTokens: 0,
    totalImages: 0,
    totalMediaSeconds: 0,
    avgRpm: 0,
    peakRpm: 0,
    recentRpm: 0,
};

function LedgerDetailModal({
    item,
    showUser = false,
    onClose,
}: {
    item: CreditLedgerItem | null;
    showUser?: boolean;
    onClose: () => void;
}) {
    const { token } = antdTheme.useToken();
    const reasonInfo = item ? ledgerReasonMeta[item.reason] : undefined;
    const modelName = typeof item?.meta?.model === "string" && item.meta.model ? item.meta.model : "";
    const hasTokens = typeof item?.meta?.inputTokens === "number" || typeof item?.meta?.outputTokens === "number";
    const imageSpec = [
        typeof item?.meta?.count === "number" ? `${item.meta.count} 张` : "",
        typeof item?.meta?.resolutionTier === "string" && item.meta.resolutionTier ? item.meta.resolutionTier.toUpperCase() : "",
        typeof item?.meta?.size === "string" && item.meta.size ? item.meta.size : "",
    ]
        .filter(Boolean)
        .join(" · ");
    const hasMediaDuration = typeof item?.meta?.seconds === "number" || typeof item?.meta?.durationSeconds === "number";
    const timing = getLedgerTimingStats(item?.meta);

    return (
        <Modal
            open={Boolean(item)}
            title="日志详情"
            onCancel={onClose}
            footer={
                <Button type="primary" onClick={onClose}>
                    关闭
                </Button>
            }
            width={620}
        >
            {item ? (
                <div className="flex flex-col gap-3.5">
                    <div
                        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3.5"
                        style={{
                            backgroundColor: token.colorFillAlter,
                            borderColor: token.colorBorderSecondary,
                        }}
                    >
                        <div className="flex flex-wrap items-center gap-2">
                            <Tag color={reasonInfo?.color} style={{ marginInlineEnd: 0 }}>
                                {reasonInfo?.label || item.reason}
                            </Tag>
                            <Tag color={getLedgerTaskStatus(item).color} style={{ marginInlineEnd: 0 }}>
                                {getLedgerTaskStatus(item).label}
                            </Tag>
                            {typeof timing.isStream === "boolean" ? (
                                <Tag color={timing.isStream ? "cyan" : undefined} style={{ marginInlineEnd: 0 }}>
                                    {timing.isStream ? "流" : "非流"}
                                </Tag>
                            ) : null}
                            {modelName ? <Tag style={{ marginInlineEnd: 0 }}>{modelName}</Tag> : null}
                            <Typography.Text type="secondary" className="text-xs">
                                {new Date(item.createdAt).toLocaleString("zh-CN")}
                            </Typography.Text>
                        </div>
                        <div className="flex items-baseline gap-2.5">
                            <Tag color={item.delta >= 0 ? "green" : "volcano"} style={{ marginInlineEnd: 0 }}>
                                {item.delta >= 0 ? `+${item.delta}` : item.delta} 积分
                            </Tag>
                            <Typography.Text type="secondary" className="text-xs">
                                结余 <span className="font-medium" style={{ color: token.colorText }}>{item.balanceAfter}</span>
                            </Typography.Text>
                        </div>
                    </div>

                    <div
                        className="grid grid-cols-1 gap-x-6 gap-y-3 rounded-lg border p-3.5 sm:grid-cols-2"
                        style={{ borderColor: token.colorBorderSecondary }}
                    >
                        <div className="min-w-0">
                            <Typography.Text type="secondary" className="block text-xs">
                                日志 ID
                            </Typography.Text>
                            <Typography.Text copyable className="mt-0.5 block break-all font-mono text-xs">
                                {item.id}
                            </Typography.Text>
                        </div>

                        {showUser && (item.username || item.displayName) ? (
                            <div className="min-w-0">
                                <Typography.Text type="secondary" className="block text-xs">
                                    所属用户
                                </Typography.Text>
                                <div className="mt-0.5 truncate text-sm font-medium">
                                    {item.displayName || item.username}
                                    {item.username ? (
                                        <Typography.Text type="secondary" className="ml-1.5 text-xs font-normal">
                                            @{item.username}
                                        </Typography.Text>
                                    ) : null}
                                </div>
                            </div>
                        ) : null}

                        {item.refId ? (
                            <div className="min-w-0">
                                <Typography.Text type="secondary" className="block text-xs">
                                    关联单号
                                </Typography.Text>
                                <Typography.Text copyable className="mt-0.5 block break-all font-mono text-xs">
                                    {item.refId}
                                </Typography.Text>
                            </div>
                        ) : null}

                        {timing.durationText ? (
                            <div className="min-w-0">
                                <Typography.Text type="secondary" className="block text-xs">
                                    {timing.isStream && timing.firstTokenMs !== undefined ? "耗时（首字 / 总耗时）" : "请求耗时"}
                                </Typography.Text>
                                <div className="mt-0.5 text-sm font-medium">{timing.durationText}</div>
                            </div>
                        ) : null}

                        {timing.tokPerSec > 0 ? (
                            <div className="min-w-0">
                                <Typography.Text type="secondary" className="block text-xs">
                                    生成速度
                                </Typography.Text>
                                <div className="mt-0.5 text-sm font-medium">{timing.tokPerSec} tok/s</div>
                            </div>
                        ) : null}

                        {hasTokens ? (
                            <div className="min-w-0 sm:col-span-2">
                                <Typography.Text type="secondary" className="block text-xs">
                                    Token 用量
                                </Typography.Text>
                                <div className="mt-0.5 text-sm">
                                    输入 {Number(item.meta?.inputTokens ?? 0).toLocaleString()} · 缓存{" "}
                                    {Number(item.meta?.cachedInputTokens ?? 0).toLocaleString()} · 输出{" "}
                                    {Number(item.meta?.outputTokens ?? 0).toLocaleString()}
                                </div>
                            </div>
                        ) : null}

                        {imageSpec ? (
                            <div className="min-w-0">
                                <Typography.Text type="secondary" className="block text-xs">
                                    图片规格
                                </Typography.Text>
                                <div className="mt-0.5 text-sm">{imageSpec}</div>
                            </div>
                        ) : null}

                        {hasMediaDuration ? (
                            <div className="min-w-0">
                                <Typography.Text type="secondary" className="block text-xs">
                                    音视频时长
                                </Typography.Text>
                                <div className="mt-0.5 text-sm">
                                    {typeof item.meta?.seconds === "number" ? `${item.meta.seconds} 秒` : `${item.meta?.durationSeconds} 秒`}
                                    {item.meta?.hasReferenceVideo === true ? "（含参考视频）" : ""}
                                </div>
                            </div>
                        ) : null}

                        {typeof item.meta?.code === "string" && item.meta.code ? (
                            <div className="min-w-0">
                                <Typography.Text type="secondary" className="block text-xs">
                                    兑换码
                                </Typography.Text>
                                <Typography.Text copyable className="mt-0.5 block font-mono text-xs">
                                    {item.meta.code}
                                </Typography.Text>
                            </div>
                        ) : null}

                        {typeof item.meta?.detail === "string" && item.meta.detail ? (
                            <div className="min-w-0 sm:col-span-2">
                                <Typography.Text type="secondary" className="block text-xs">
                                    详情说明
                                </Typography.Text>
                                <div className="mt-0.5 text-sm">{item.meta.detail}</div>
                            </div>
                        ) : null}

                        {typeof item.meta?.note === "string" && item.meta.note ? (
                            <div className="min-w-0 sm:col-span-2">
                                <Typography.Text type="secondary" className="block text-xs">
                                    备注信息
                                </Typography.Text>
                                <div className="mt-0.5 text-sm">{item.meta.note}</div>
                            </div>
                        ) : null}
                    </div>

                    {item.meta && Object.keys(item.meta).length > 0 ? (
                        <div>
                            <Typography.Text type="secondary" className="mb-1.5 block text-xs">
                                原始元数据（Meta JSON）
                            </Typography.Text>
                            <pre
                                className="max-h-56 overflow-auto rounded-lg border p-3 font-mono text-xs"
                                style={{
                                    backgroundColor: token.colorFillAlter,
                                    borderColor: token.colorBorderSecondary,
                                    margin: 0,
                                }}
                            >
                                {JSON.stringify(item.meta, null, 2)}
                            </pre>
                        </div>
                    ) : null}
                </div>
            ) : null}
        </Modal>
    );
}

export function MyWalletPanel({ compact = false, onOpenLogs }: { compact?: boolean; onOpenLogs?: () => void }) {
    const { message } = App.useApp();
    const user = useUserStore((state) => state.user);
    const setUser = useUserStore((state) => state.setUser);

    const [balance, setBalance] = useState<number>(user?.creditBalance ?? 0);
    const [items, setItems] = useState<CreditLedgerItem[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [summary, setSummary] = useState<CreditLedgerSummary>(emptyLedgerSummary);
    const [loading, setLoading] = useState(false);

    const [reasonFilter, setReasonFilter] = useState("");
    const [dateRange, setDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);

    const [redeemCode, setRedeemCode] = useState("");
    const [redeeming, setRedeeming] = useState(false);
    const [detailItem, setDetailItem] = useState<CreditLedgerItem | null>(null);

    const loadLedger = useCallback(
        async (targetPage = page, nextReason = reasonFilter, nextRange = dateRange) => {
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
                    pageSize: compact ? 8 : 15,
                });
                setBalance(res.balance);
                setItems(res.items);
                setTotal(res.total);
                setSummary(res.summary);
                const latestUser = useUserStore.getState().user;
                if (latestUser) setUser({ ...latestUser, creditBalance: res.balance });
            } catch (error) {
                message.error(error instanceof Error ? error.message : "加载充值日志失败");
            } finally {
                setLoading(false);
            }
        },
        [compact, dateRange, message, page, reasonFilter, setUser],
    );

    useEffect(() => {
        void loadLedger(page, reasonFilter, dateRange);
    }, [dateRange, loadLedger, page, reasonFilter]);

    const handleRedeem = async () => {
        const code = redeemCode.trim();
        if (!code) {
            message.warning("请输入积分兑换码");
            return;
        }
        setRedeeming(true);
        try {
            const res = await billingApi.redeem(code);
            message.success(`兑换成功！获得 ${res.creditsAdded} 积分，当前余额 ${res.balance}`);
            setRedeemCode("");
            setBalance(res.balance);
            const latestUser = useUserStore.getState().user;
            if (latestUser) setUser({ ...latestUser, creditBalance: res.balance });
            setPage(1);
            void loadLedger(1, reasonFilter, dateRange);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "兑换失败");
        } finally {
            setRedeeming(false);
        }
    };

    const resetFilters = () => {
        setReasonFilter("");
        setDateRange(null);
        setPage(1);
    };

    return (
        <div className="flex flex-col gap-4">
            <Card size={compact ? "small" : "default"}>
                <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex flex-wrap items-center gap-6">
                        <Statistic title="当前可用积分" value={balance} />
                        <Statistic title="筛选内入账总额" value={summary.totalRecharged} />
                        {onOpenLogs ? (
                            <Button type="link" size="small" onClick={onOpenLogs}>
                                前往查看使用日志
                            </Button>
                        ) : null}
                    </div>
                    <Space.Compact style={{ width: compact ? 310 : 360 }}>
                        <Input
                            value={redeemCode}
                            placeholder="输入积分兑换码，如 IC-XXXX-XXXX-XXXX"
                            onChange={(e) => setRedeemCode(e.target.value)}
                            onPressEnter={() => void handleRedeem()}
                        />
                        <Button type="primary" icon={<Gift className="size-4" />} loading={redeeming} onClick={() => void handleRedeem()}>
                            立即兑换
                        </Button>
                    </Space.Compact>
                </div>
            </Card>

            <Card
                size={compact ? "small" : "default"}
                title={`充值与额度变动日志（共 ${summary.recordCount} 条）`}
                extra={
                    <Button size="small" icon={<RefreshCw className="size-3.5" />} onClick={() => void loadLedger()}>
                        刷新
                    </Button>
                }
            >
                <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Select
                        value={reasonFilter}
                        style={{ width: 140 }}
                        onChange={(val) => {
                            setPage(1);
                            setReasonFilter(val);
                        }}
                        options={[
                            { value: "", label: "全部充值类型" },
                            { value: "redeem_code", label: "兑换码兑换" },
                            { value: "admin_adjust", label: "后台调整" },
                            { value: "plan_grant", label: "套餐赠送" },
                        ]}
                    />
                    <DatePicker.RangePicker
                        value={dateRange}
                        onChange={(dates) => {
                            setPage(1);
                            setDateRange(dates);
                        }}
                        placeholder={["开始日期", "结束日期"]}
                    />
                    {reasonFilter || dateRange ? <Button onClick={resetFilters}>重置筛选</Button> : null}
                </div>

                <Table<CreditLedgerItem>
                    rowKey="id"
                    size="small"
                    loading={loading}
                    dataSource={items}
                    scroll={{ x: 680 }}
                    onRow={(record) => ({
                        onClick: () => setDetailItem(record),
                        className: "cursor-pointer",
                    })}
                    pagination={{
                        current: page,
                        pageSize: compact ? 8 : 15,
                        total,
                        showSizeChanger: false,
                        onChange: (p) => setPage(p),
                    }}
                    columns={[
                        {
                            title: "时间",
                            dataIndex: "createdAt",
                            width: 165,
                            render: (v: string) => new Date(v).toLocaleString("zh-CN"),
                        },
                        {
                            title: "类型",
                            dataIndex: "reason",
                            width: 110,
                            render: (reason: string) => {
                                const info = ledgerReasonMeta[reason];
                                return <Tag color={info?.color}>{info?.label || reason}</Tag>;
                            },
                        },
                        {
                            title: "明细 / 备注",
                            key: "detail",
                            render: (_, record) => <Typography.Text type="secondary">{formatLedgerUsageDetail(record)}</Typography.Text>,
                        },
                        {
                            title: "积分变动",
                            dataIndex: "delta",
                            width: 110,
                            render: (delta: number) => <Tag color={delta >= 0 ? "green" : "volcano"}>{delta >= 0 ? `+${delta}` : delta}</Tag>,
                        },
                        {
                            title: "结余",
                            dataIndex: "balanceAfter",
                            width: 100,
                        },
                        {
                            title: "操作",
                            key: "actions",
                            width: 80,
                            fixed: "right",
                            render: (_, record) => (
                                <Button
                                    type="link"
                                    size="small"
                                    icon={<Eye className="size-3.5" />}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setDetailItem(record);
                                    }}
                                >
                                    详情
                                </Button>
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
    const { message } = App.useApp();
    const { token } = antdTheme.useToken();
    const user = useUserStore((state) => state.user);
    const isAdmin = user?.role === "admin";

    const [scope, setScope] = useState<"all" | "self">(isAdmin ? defaultScope : "self");
    const [items, setItems] = useState<CreditLedgerItem[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [summary, setSummary] = useState<CreditLedgerSummary>(emptyLedgerSummary);
    const [loading, setLoading] = useState(false);

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
                        pageSize: 15,
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
                        pageSize: 15,
                    });
                    setItems(res.items);
                    setTotal(res.total);
                    setSummary(res.summary);
                }
            } catch (error) {
                message.error(error instanceof Error ? error.message : "加载使用日志失败");
            } finally {
                setLoading(false);
            }
        },
        [dateRange, isAdmin, logIdFilter, message, modelFilter, page, reasonFilter, scope, statusFilter, userQueryFilter],
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
                title={`使用日志（共 ${summary.recordCount} 条）`}
                extra={
                    <Space>
                        {isAdmin ? (
                            <Segmented
                                size="small"
                                value={scope}
                                onChange={(val) => {
                                    setPage(1);
                                    setScope(val as "all" | "self");
                                }}
                                options={[
                                    { label: "所有用户", value: "all" },
                                    { label: "仅看自己", value: "self" },
                                ]}
                            />
                        ) : null}
                        <Button size="small" icon={<RefreshCw className="size-3.5" />} onClick={() => void loadLogs()}>
                            刷新
                        </Button>
                    </Space>
                }
            >
                <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Select
                        value={reasonFilter}
                        style={{ width: 130 }}
                        onChange={(val) => {
                            setPage(1);
                            setReasonFilter(val);
                        }}
                        options={[
                            { value: "", label: "全部使用类型" },
                            { value: "text_gen", label: "对话调用" },
                            { value: "image_gen", label: "图片生成" },
                            { value: "video_gen", label: "视频生成" },
                            { value: "audio_gen", label: "语音生成" },
                            { value: "refund", label: "失败退回" },
                        ]}
                    />
                    <Select
                        value={statusFilter}
                        style={{ width: 115 }}
                        onChange={(val) => {
                            setPage(1);
                            setStatusFilter(val);
                        }}
                        options={[
                            { value: "", label: "全部状态" },
                            { value: "not_started", label: "未开始" },
                            { value: "processing", label: "进行中" },
                            { value: "completed", label: "已完成" },
                            { value: "failed", label: "已失败" },
                            { value: "refunded", label: "已退回" },
                        ]}
                    />
                    <Input
                        allowClear
                        value={modelFilter}
                        prefix={<Search className="size-3.5 opacity-50" />}
                        placeholder="按模型名称筛选"
                        style={{ width: 180 }}
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
                            placeholder="按用户名 / 昵称搜索"
                            style={{ width: 180 }}
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
                        placeholder="按日志 ID 查询"
                        style={{ width: 190 }}
                        onChange={(e) => {
                            setPage(1);
                            setLogIdFilter(e.target.value);
                        }}
                    />
                    <DatePicker.RangePicker
                        value={dateRange}
                        onChange={(dates) => {
                            setPage(1);
                            setDateRange(dates);
                        }}
                        placeholder={["开始日期", "结束日期"]}
                    />
                    {reasonFilter || statusFilter || modelFilter || userQueryFilter || logIdFilter || dateRange ? (
                        <Button onClick={resetFilters}>重置筛选</Button>
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
                            调用次数
                        </Typography.Text>
                        <div className="mt-0.5 text-base font-semibold">{summary.consumeCalls} 次</div>
                    </div>
                    <div>
                        <Typography.Text type="secondary" className="text-xs">
                            消耗积分
                        </Typography.Text>
                        <div className="mt-0.5 text-base font-semibold">
                            {summary.totalConsumed}
                            {summary.totalRecharged > 0 ? (
                                <Typography.Text type="secondary" className="ml-1.5 text-xs font-normal">
                                    (退回 +{summary.totalRecharged})
                                </Typography.Text>
                            ) : null}
                        </div>
                    </div>
                    <div>
                        <Tooltip
                            title={`输入 ${summary.totalInputTokens.toLocaleString()} · 缓存 ${summary.totalCachedTokens.toLocaleString()} · 输出 ${summary.totalOutputTokens.toLocaleString()} Tokens；图片 ${summary.totalImages} 张；音视频 ${summary.totalMediaSeconds} 秒`}
                        >
                            <div className="cursor-help">
                                <Typography.Text type="secondary" className="text-xs">
                                    消耗量统计
                                </Typography.Text>
                                <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs font-medium leading-6">
                                    <span>{summary.totalImages} 张图</span>
                                    <span>·</span>
                                    <span>{summary.totalMediaSeconds} 秒</span>
                                    <span>·</span>
                                    <span>{summary.totalTokens.toLocaleString()} Tokens</span>
                                </div>
                            </div>
                        </Tooltip>
                    </div>
                    <div>
                        <Tooltip title="统计周期内平均每分钟请求数（无日期筛选时按首尾调用跨度计算，至少按 1 分钟计），另附单分钟峰值与近 1 分钟实时 RPM">
                            <div className="cursor-help">
                                <Typography.Text type="secondary" className="text-xs">
                                    RPM（每分钟请求）
                                </Typography.Text>
                                <div className="mt-0.5 flex flex-wrap items-baseline gap-1.5">
                                    <span className="text-base font-semibold">{summary.avgRpm}</span>
                                    <Typography.Text type="secondary" className="text-xs">
                                        峰值 {summary.peakRpm} · 近1分 {summary.recentRpm}
                                    </Typography.Text>
                                </div>
                            </div>
                        </Tooltip>
                    </div>
                </div>

                <Table<CreditLedgerItem>
                    rowKey="id"
                    size="small"
                    loading={loading}
                    dataSource={items}
                    scroll={{ x: showUserColumn ? 1120 : 980 }}
                    onRow={(record) => ({
                        onClick: () => setDetailItem(record),
                        className: "cursor-pointer",
                    })}
                    pagination={{
                        current: page,
                        pageSize: 15,
                        total,
                        showSizeChanger: false,
                        onChange: (p) => setPage(p),
                    }}
                    columns={[
                        ...(showUserColumn
                            ? [
                                  {
                                      title: "用户",
                                      key: "user",
                                      width: 140,
                                      render: (_: unknown, record: CreditLedgerItem) => (
                                          <div className="min-w-0">
                                              <div className="truncate font-medium">{record.displayName || record.username || record.userId}</div>
                                              {record.username ? (
                                                  <Typography.Text type="secondary" className="text-xs">
                                                      @{record.username}
                                                  </Typography.Text>
                                              ) : null}
                                          </div>
                                      ),
                                  },
                              ]
                            : []),
                        {
                            title: "时间",
                            dataIndex: "createdAt",
                            width: 165,
                            render: (v: string) => new Date(v).toLocaleString("zh-CN"),
                        },
                        {
                            title: "类型",
                            dataIndex: "reason",
                            width: 105,
                            render: (reason: string) => {
                                const info = ledgerReasonMeta[reason];
                                return <Tag color={info?.color}>{info?.label || reason}</Tag>;
                            },
                        },
                        {
                            title: "状态",
                            key: "taskStatus",
                            width: 90,
                            render: (_, record) => {
                                const st = getLedgerTaskStatus(record);
                                return <Tag color={st.color}>{st.label}</Tag>;
                            },
                        },
                        {
                            title: "模型",
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
                            title: "流",
                            key: "stream",
                            width: 72,
                            render: (_, record) => {
                                const { isStream } = getLedgerTimingStats(record.meta);
                                if (typeof isStream !== "boolean") return <Typography.Text type="secondary">—</Typography.Text>;
                                return <Tag color={isStream ? "cyan" : undefined}>{isStream ? "流" : "非流"}</Tag>;
                            },
                        },
                        {
                            title: "耗时 / 速度",
                            key: "timing",
                            width: 150,
                            render: (_, record) => {
                                const { isStream, durationText, firstTokenMs, tokPerSec } = getLedgerTimingStats(record.meta);
                                if (!durationText && !tokPerSec) return <Typography.Text type="secondary">—</Typography.Text>;
                                return (
                                    <div className="flex flex-col leading-tight">
                                        {durationText ? (
                                            <Tooltip
                                                title={
                                                    isStream && firstTokenMs !== undefined
                                                        ? `首字耗时 ${formatDurationSec(firstTokenMs)} / 总耗时 ${formatDurationSec(
                                                              Number(record.meta?.durationMs ?? 0),
                                                          )}`
                                                        : `总耗时 ${durationText}`
                                                }
                                            >
                                                <span className="font-mono text-xs">{durationText}</span>
                                            </Tooltip>
                                        ) : null}
                                        {tokPerSec > 0 ? (
                                            <Typography.Text type="secondary" className="font-mono text-[11px]">
                                                {tokPerSec} tok/s
                                            </Typography.Text>
                                        ) : null}
                                    </div>
                                );
                            },
                        },
                        {
                            title: "用量与详情",
                            key: "detail",
                            render: (_, record) => <Typography.Text type="secondary">{formatLedgerUsageDetail(record)}</Typography.Text>,
                        },
                        {
                            title: "积分变动",
                            dataIndex: "delta",
                            width: 100,
                            render: (delta: number) => <Tag color={delta >= 0 ? "green" : "volcano"}>{delta >= 0 ? `+${delta}` : delta}</Tag>,
                        },
                        {
                            title: "结余",
                            dataIndex: "balanceAfter",
                            width: 90,
                        },
                        {
                            title: "操作",
                            key: "actions",
                            width: 80,
                            fixed: "right",
                            render: (_, record) => (
                                <Button
                                    type="link"
                                    size="small"
                                    icon={<Eye className="size-3.5" />}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setDetailItem(record);
                                    }}
                                >
                                    详情
                                </Button>
                            ),
                        },
                    ]}
                />
            </Card>

            <LedgerDetailModal item={detailItem} showUser={showUserColumn} onClose={() => setDetailItem(null)} />
        </div>
    );
}

export function MyMediaPanel() {
    const { message } = App.useApp();
    const user = useUserStore((state) => state.user);
    const setUser = useUserStore((state) => state.setUser);

    const [items, setItems] = useState<MediaItem[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [q, setQ] = useState("");
    const [kind, setKind] = useState("");
    const [loading, setLoading] = useState(false);
    const [mediaByKind, setMediaByKind] = useState<Array<{ kind: string; count: number; bytes: number }>>([]);
    const [usedBytes, setUsedBytes] = useState(user?.storageUsedBytes ?? 0);

    const loadData = useCallback(async () => {
        setLoading(true);
        try {
            const [listRes, profileRes] = await Promise.all([
                storageApi.list({ page, pageSize: 12, q, kind }),
                accountApi.getProfile(),
            ]);
            setItems(listRes.items);
            setTotal(listRes.total ?? listRes.items.length);
            setMediaByKind(profileRes.stats.mediaByKind);
            setUsedBytes(profileRes.user.storageUsedBytes);
            setUser(profileRes.user);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载媒体列表失败");
        } finally {
            setLoading(false);
        }
    }, [kind, message, page, q, setUser]);

    useEffect(() => {
        void loadData();
    }, [loadData]);

    const handleDelete = async (mediaId: string) => {
        try {
            await storageApi.remove(mediaId);
            message.success("已从云端删除并释放存储空间");
            void loadData();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除失败");
        }
    };

    return (
        <div className="flex flex-col gap-5">
            <Card title={`我的云端存储占用（总计：${formatBytes(usedBytes)}）`}>
                <div className="flex flex-col gap-3">
                    {mediaByKind.length ? (
                        mediaByKind.map((item) => {
                            const percent = usedBytes > 0 ? Math.round((item.bytes / usedBytes) * 100) : 0;
                            return (
                                <div key={item.kind} className="flex flex-col gap-1">
                                    <div className="flex items-center justify-between text-sm">
                                        <span>
                                            {kindLabels[item.kind] || item.kind}（{item.count} 个）
                                        </span>
                                        <Typography.Text type="secondary">{formatBytes(item.bytes)}</Typography.Text>
                                    </div>
                                    <Progress percent={percent} size="small" showInfo={false} />
                                </div>
                            );
                        })
                    ) : (
                        <Typography.Text type="secondary">暂无云端媒体文件</Typography.Text>
                    )}
                </div>
            </Card>

            <Card
                title={`我的媒体文件（共 ${total} 个）`}
                extra={
                    <Space wrap>
                        <Select
                            value={kind}
                            style={{ width: 120 }}
                            onChange={(val) => {
                                setPage(1);
                                setKind(val);
                            }}
                            options={[
                                { value: "", label: "全部类型" },
                                { value: "image", label: "图片" },
                                { value: "video", label: "视频" },
                                { value: "audio", label: "音频" },
                                { value: "file", label: "其他文件" },
                            ]}
                        />
                        <Input.Search
                            allowClear
                            placeholder="搜索文件路径"
                            style={{ width: 200 }}
                            onSearch={(val) => {
                                setPage(1);
                                setQ(val.trim());
                            }}
                        />
                        <Button icon={<RefreshCw className="size-4" />} onClick={() => void loadData()}>
                            刷新
                        </Button>
                    </Space>
                }
            >
                <Table<MediaItem>
                    rowKey="id"
                    loading={loading}
                    dataSource={items}
                    pagination={{
                        current: page,
                        pageSize: 12,
                        total,
                        onChange: (p) => setPage(p),
                    }}
                    columns={[
                        {
                            title: "预览 / 对象路径",
                            key: "preview",
                            render: (_, record) => (
                                <div className="flex items-center gap-3">
                                    {record.kind === "image" && record.url ? (
                                        <img src={record.url} alt={record.objectKey} className="size-10 rounded object-cover" />
                                    ) : null}
                                    <div className="min-w-0">
                                        <div className="truncate font-mono text-xs">{record.objectKey}</div>
                                        <Typography.Text type="secondary" className="text-xs">
                                            {record.mimeType}
                                        </Typography.Text>
                                    </div>
                                </div>
                            ),
                        },
                        { title: "类型", dataIndex: "kind", width: 90, render: (v: string) => <Tag>{kindLabels[v] || v}</Tag> },
                        { title: "大小", dataIndex: "bytes", width: 110, render: (bytes: number) => formatBytes(bytes) },
                        { title: "上传时间", dataIndex: "createdAt", width: 165, render: (v: string) => new Date(v).toLocaleString("zh-CN") },
                        {
                            title: "操作",
                            key: "actions",
                            width: 140,
                            render: (_, record) => (
                                <Space>
                                    {record.url ? (
                                        <a href={record.url} target="_blank" rel="noreferrer">
                                            查看
                                        </a>
                                    ) : null}
                                    <Popconfirm title="确定从云端删除该文件并释放个人空间吗？" onConfirm={() => void handleDelete(record.id)}>
                                        <Button type="link" danger size="small" icon={<Trash2 className="size-3.5" />}>
                                            删除
                                        </Button>
                                    </Popconfirm>
                                </Space>
                            ),
                        },
                    ]}
                />
            </Card>
        </div>
    );
}
