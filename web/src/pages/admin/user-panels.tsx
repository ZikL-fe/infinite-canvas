/** 个人后台与公共面板组件：概览趋势、平台公告卡片、账号安全维护、充值钱包、NewAPI 风格使用日志及云端媒体清理。 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Avatar, Button, Card, Col, DatePicker, Descriptions, Empty, Form, Image, Input, InputNumber, Modal, Popconfirm, Progress, Radio, Row, Segmented, Select, Space, Spin, Statistic, Switch, Table, Tabs, Tag, Tooltip, Typography, theme as antdTheme } from "antd";
import type { Dayjs } from "dayjs";
import localforage from "localforage";
import { AudioLines, Bell, Download, Eye, FileIcon, Gift, ImageIcon, KeyRound, Laptop, Megaphone, Pin, RefreshCw, Search, TrendingUp, User, Video } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { useBatchZipDownload } from "@/hooks/use-batch-zip-download";
import { useEmailCodeSender } from "@/hooks/use-email-code-sender";
import { createImageThumbnail, createVideoThumbnail } from "@/lib/image-thumbnail";
import { previewUrlFor } from "@/services/image-storage";
import { ADMIN_TABLE_CLASS, ADMIN_TABLE_SCROLL, TableRowActions } from "@/pages/admin/components/table-row-actions";
import { notifyCloudWorkspaceChanged, WORKSPACE_CHANGED_EVENT } from "@/services/cloud-media";
import { deleteCanvasProjectsWithCloud } from "@/services/cloud-sync";
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

export const MEDIA_MODULE_OPTIONS: Array<{ value: "" | MediaSourceModule; label: string }> = [
    { value: "", label: "全部模块" },
    { value: "canvas", label: "无限画布" },
    { value: "image_workbench", label: "生图工作台" },
    { value: "video_workbench", label: "视频工作台" },
    { value: "assets", label: "我的资产" },
];

const mediaModuleMeta: Record<MediaSourceModule, { label: string; color: string }> = {
    canvas: { label: "无限画布", color: "blue" },
    image_workbench: { label: "生图工作台", color: "purple" },
    video_workbench: { label: "视频工作台", color: "geekblue" },
    assets: { label: "我的资产", color: "cyan" },
};

export function MediaModuleTags({ modules }: { modules?: MediaSourceModule[] }) {
    if (!modules?.length) {
        return <Tag style={{ marginInlineEnd: 0 }}>独立文件</Tag>;
    }
    return (
        <Space size={4} wrap={false}>
            {modules.map((mod) => (
                <Tag key={mod} color={mediaModuleMeta[mod]?.color} style={{ marginInlineEnd: 0 }}>
                    {mediaModuleMeta[mod]?.label || mod}
                </Tag>
            ))}
        </Space>
    );
}

export function WorkspaceSizeCell({ mediaBytes = 0, dataBytes = 0 }: { mediaBytes?: number; dataBytes?: number }) {
    const tip = `云端媒体 ${formatBytes(mediaBytes)} · 记录元数据 ${formatBytes(dataBytes)}`;
    return (
        <Tooltip title={tip}>
            <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
                <span>{formatBytes(mediaBytes > 0 ? mediaBytes : dataBytes)}</span>
                {mediaBytes <= 0 && dataBytes > 0 ? (
                    <Typography.Text type="secondary" className="text-xs">
                        仅元数据
                    </Typography.Text>
                ) : null}
            </span>
        </Tooltip>
    );
}

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

/** 根据流式状态与分段耗时计算 `tok/s` 输出速度及 `首字 / 总耗时`、`上游/拿图/云存` 展示文案。 */
function getLedgerTimingStats(meta?: Record<string, unknown>) {
    const isStream = typeof meta?.isStream === "boolean" ? meta.isStream : undefined;
    const durationMs = typeof meta?.durationMs === "number" && meta.durationMs > 0 ? meta.durationMs : undefined;
    const firstTokenMs = typeof meta?.firstTokenMs === "number" && meta.firstTokenMs > 0 ? meta.firstTokenMs : undefined;
    const upstreamMs = typeof meta?.upstreamMs === "number" && meta.upstreamMs >= 0 ? meta.upstreamMs : undefined;
    const fetchImageMs = typeof meta?.fetchImageMs === "number" && meta.fetchImageMs >= 0 ? meta.fetchImageMs : undefined;
    const cloudSaveMs = typeof meta?.cloudSaveMs === "number" && meta.cloudSaveMs >= 0 ? meta.cloudSaveMs : undefined;
    const clientAborted = meta?.clientAborted === true;
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

    const stageParts: string[] = [];
    if (upstreamMs !== undefined) stageParts.push(`上游 ${formatDurationSec(upstreamMs)}`);
    if (fetchImageMs !== undefined) stageParts.push(`拿图 ${formatDurationSec(fetchImageMs)}`);
    if (cloudSaveMs !== undefined) stageParts.push(`云存 ${formatDurationSec(cloudSaveMs)}`);
    const stageText = stageParts.join(" · ");

    return {
        isStream,
        durationMs,
        firstTokenMs,
        upstreamMs,
        fetchImageMs,
        cloudSaveMs,
        clientAborted,
        durationText,
        stageText,
        tokPerSec,
    };
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
                            title="云端存储配额 / 画布"
                            value={`${formatBytes(data?.storageUsedBytes ?? 0)} / ${formatBytes(data?.storageQuotaBytes ?? 0)}`}
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
    const [savingAlert, setSavingAlert] = useState(false);
    const [passwordMode, setPasswordMode] = useState<"password" | "email">("password");
    const [sessions, setSessions] = useState<AccountSessionItem[]>([]);
    const [sessionsLoading, setSessionsLoading] = useState(false);

    const bindEmailCodeSender = useEmailCodeSender();
    const changePasswordCodeSender = useEmailCodeSender();

    const [profileForm] = Form.useForm<{ displayName: string; email: string; emailCode?: string; avatarUrl: string }>();
    const [alertForm] = Form.useForm<{ mode: "inherit" | "custom_on" | "off"; threshold: number }>();
    const [passwordForm] = Form.useForm<{
        currentPassword?: string;
        emailCode?: string;
        newPassword: string;
        confirmPassword: string;
        revokeOtherSessions: boolean;
    }>();

    const loadProfile = useCallback(async () => {
        setLoading(true);
        try {
            const res = await accountApi.getProfile();
            setProfileData(res);
            setUser(res.user);
            profileForm.setFieldsValue({
                displayName: res.user.displayName,
                email: res.user.email || "",
                emailCode: "",
                avatarUrl: res.user.avatarUrl || "",
            });
            const alertCfg = res.lowBalanceAlert;
            const alertMode: "inherit" | "custom_on" | "off" =
                alertCfg?.enabled === false ? "off" : alertCfg?.enabled === true ? "custom_on" : "inherit";
            alertForm.setFieldsValue({
                mode: alertMode,
                threshold: alertCfg?.threshold ?? alertCfg?.platformThreshold ?? 10,
            });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载个人信息失败");
        } finally {
            setLoading(false);
        }
    }, [alertForm, message, profileForm, setUser]);

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

    const handleSendBindEmailCode = async () => {
        try {
            const { email } = await profileForm.validateFields(["email"]);
            const clean = (email || "").trim();
            if (!clean) {
                message.warning("请先填写需要绑定的邮箱");
                return;
            }
            await bindEmailCodeSender.sendCode(() => accountApi.sendEmailBindCode(clean));
        } catch {
            // validation error shown on field
        }
    };

    const handleSaveProfile = async (values: { displayName: string; email: string; emailCode?: string; avatarUrl: string }) => {
        setSavingProfile(true);
        try {
            const res = await accountApi.updateProfile({
                displayName: values.displayName.trim(),
                email: values.email.trim(),
                ...(values.emailCode?.trim() ? { emailCode: values.emailCode.trim() } : {}),
                avatarUrl: values.avatarUrl.trim(),
            });
            setUser(res.user);
            bindEmailCodeSender.resetCooldown();
            message.success("个人信息已保存");
            void loadProfile();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        } finally {
            setSavingProfile(false);
        }
    };

    const handleSaveAlertSettings = async (values: { mode: "inherit" | "custom_on" | "off"; threshold: number }) => {
        setSavingAlert(true);
        try {
            const lowBalanceAlertEnabled = values.mode === "inherit" ? null : values.mode === "custom_on";
            const lowBalanceThreshold = values.mode === "custom_on" ? Number(values.threshold ?? 10) : null;
            await accountApi.updateProfile({
                lowBalanceAlertEnabled,
                lowBalanceThreshold,
            });
            message.success("余额不足提醒设置已保存");
            void loadProfile();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存提醒设置失败");
        } finally {
            setSavingAlert(false);
        }
    };

    const handleSendChangePasswordCode = async () => {
        await changePasswordCodeSender.sendCode(() => accountApi.sendChangePasswordCode());
    };

    const handleChangePassword = async (values: {
        currentPassword?: string;
        emailCode?: string;
        newPassword: string;
        revokeOtherSessions: boolean;
    }) => {
        setChangingPassword(true);
        try {
            await accountApi.changePassword({
                mode: passwordMode,
                currentPassword: values.currentPassword,
                emailCode: values.emailCode?.trim(),
                newPassword: values.newPassword,
                revokeOtherSessions: values.revokeOtherSessions,
            });
            passwordForm.resetFields();
            changePasswordCodeSender.resetCooldown();
            message.success("密码已修改");
            void loadSessions();
            void loadProfile();
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
    const emailWatch = Form.useWatch("email", profileForm);
    const alertModeWatch = Form.useWatch("mode", alertForm);

    const emailServiceEnabled = Boolean(profileData?.emailServiceEnabled);
    const normalizedSavedEmail = (profileData?.user.email || "").trim().toLowerCase();
    const normalizedInputEmail = (emailWatch || "").trim().toLowerCase();
    const needsEmailVerifyCode = Boolean(
        emailServiceEnabled &&
            normalizedInputEmail &&
            (normalizedInputEmail !== normalizedSavedEmail || !profileData?.user.emailVerifiedAt),
    );
    const canResetByEmail = Boolean(emailServiceEnabled && detail?.email);

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
                        <Statistic
                            title="云端存储配额"
                            value={`${formatBytes(detail?.storageUsedBytes ?? 0)} / ${formatBytes(detail?.storageQuotaBytes ?? 0)}`}
                        />
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
                    <Descriptions.Item label="云端对象存储配额">
                        <div className="flex flex-wrap items-center gap-2">
                            <span>
                                已用 {formatBytes(detail?.storageUsedBytes ?? 0)} / 配额 {formatBytes(detail?.storageQuotaBytes ?? 0)}
                                {detail?.storageQuotaExpiresAt
                                    ? ` · 有效期至 ${new Date(detail.storageQuotaExpiresAt).toLocaleString("zh-CN")}`
                                    : " · 不限期"}
                            </span>
                            {detail?.storageQuotaExpiresAt && new Date(detail.storageQuotaExpiresAt).getTime() <= Date.now() ? (
                                <Tag color="red">已过期</Tag>
                            ) : (detail?.storageQuotaBytes ?? 0) <= 0 || (detail?.storageUsedBytes ?? 0) >= (detail?.storageQuotaBytes ?? 0) ? (
                                <Tag color="red">配额已满 / 需扩容</Tag>
                            ) : (
                                <Tag color="green">正常</Tag>
                            )}
                        </div>
                    </Descriptions.Item>
                    {detail?.role === "admin" ? (
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
                    ) : null}
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
                            <Form.Item
                                name="email"
                                label={
                                    <span className="inline-flex items-center gap-2">
                                        <span>绑定邮箱</span>
                                        {detail?.email ? (
                                            detail.emailVerifiedAt ? (
                                                <Tag color="green" style={{ marginInlineEnd: 0 }}>
                                                    已验证
                                                </Tag>
                                            ) : (
                                                <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                                                    未验证
                                                </Tag>
                                            )
                                        ) : null}
                                    </span>
                                }
                                rules={[
                                    ...(profileData?.requireEmailOnRegister && detail?.role !== "admin"
                                        ? [{ required: true, message: "当前平台要求绑定邮箱" }]
                                        : []),
                                    { type: "email" as const, message: "邮箱格式不正确" },
                                ]}
                            >
                                <Input placeholder="example@domain.com" />
                            </Form.Item>
                            {needsEmailVerifyCode ? (
                                <Form.Item
                                    name="emailCode"
                                    label="邮箱验证码"
                                    rules={[{ required: true, message: "更改或验证邮箱时请输入验证码" }]}
                                >
                                    <Space.Compact className="w-full">
                                        <Input placeholder="输入 6 位验证码" maxLength={8} />
                                        <Button
                                            loading={bindEmailCodeSender.sending}
                                            disabled={bindEmailCodeSender.cooldown > 0}
                                            onClick={() => void handleSendBindEmailCode()}
                                        >
                                            {bindEmailCodeSender.cooldown > 0 ? `${bindEmailCodeSender.cooldown}s 后重试` : "获取验证码"}
                                        </Button>
                                    </Space.Compact>
                                </Form.Item>
                            ) : null}
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
                        extra={
                            <Segmented
                                size="small"
                                value={passwordMode}
                                onChange={(val) => {
                                    setPasswordMode(val as "password" | "email");
                                    passwordForm.resetFields(["currentPassword", "emailCode"]);
                                }}
                                options={[
                                    { label: "原密码验证", value: "password" },
                                    { label: "邮箱验证码", value: "email", disabled: !canResetByEmail },
                                ]}
                            />
                        }
                    >
                        {!canResetByEmail ? (
                            <Typography.Text type="secondary" className="mb-3 block text-xs">
                                {emailServiceEnabled ? "提示：绑定邮箱后即可使用邮箱验证码修改密码。" : "提示：管理员启用邮件服务且账号绑定邮箱后，可使用邮箱验证码改密。"}
                            </Typography.Text>
                        ) : null}
                        <Form form={passwordForm} layout="vertical" initialValues={{ revokeOtherSessions: true }} onFinish={handleChangePassword}>
                            {passwordMode === "password" ? (
                                <Form.Item name="currentPassword" label="当前密码" rules={[{ required: true, message: "请输入当前密码" }]}>
                                    <Input.Password placeholder="输入当前使用的密码" />
                                </Form.Item>
                            ) : (
                                <>
                                    <Form.Item label="接收验证码邮箱">
                                        <Input value={detail?.email || ""} disabled />
                                    </Form.Item>
                                    <Form.Item
                                        name="emailCode"
                                        label="邮箱验证码"
                                        rules={[{ required: true, message: "请输入邮箱验证码" }]}
                                    >
                                        <Space.Compact className="w-full">
                                            <Input placeholder="输入 6 位验证码" maxLength={8} />
                                            <Button
                                                loading={changePasswordCodeSender.sending}
                                                disabled={changePasswordCodeSender.cooldown > 0}
                                                onClick={() => void handleSendChangePasswordCode()}
                                            >
                                                {changePasswordCodeSender.cooldown > 0
                                                    ? `${changePasswordCodeSender.cooldown}s 后重试`
                                                    : "发送验证码"}
                                            </Button>
                                        </Space.Compact>
                                    </Form.Item>
                                </>
                            )}
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
                        <Bell className="size-4" />
                        积分余额不足邮件提醒
                    </span>
                }
            >
                {!emailServiceEnabled ? (
                    <Alert
                        type="info"
                        showIcon
                        className="mb-4"
                        message="平台邮件服务当前未启用"
                        description="你可以预先保存提醒偏好；待管理员启用邮件服务且当前账号绑定邮箱后将自动生效。"
                    />
                ) : !detail?.email ? (
                    <Alert
                        type="warning"
                        showIcon
                        className="mb-4"
                        message="当前账号尚未绑定邮箱"
                        description="请先在上方「基本资料维护」中绑定邮箱，才能接收余额不足提醒邮件。"
                    />
                ) : null}
                <Form
                    form={alertForm}
                    layout="vertical"
                    initialValues={{ mode: "inherit", threshold: 10 }}
                    onFinish={handleSaveAlertSettings}
                >
                    <Row gutter={16} align="bottom">
                        <Col xs={24} md={12}>
                            <Form.Item name="mode" label="提醒策略">
                                <Radio.Group>
                                    <Radio value="inherit">
                                        跟随平台默认（
                                        {profileData?.lowBalanceAlert?.platformEnabled
                                            ? `低于 ${profileData.lowBalanceAlert.platformThreshold} 积分`
                                            : "已关闭"}
                                        ）
                                    </Radio>
                                    <Radio value="custom_on">自定义阈值</Radio>
                                    <Radio value="off">关闭提醒</Radio>
                                </Radio.Group>
                            </Form.Item>
                        </Col>
                        {alertModeWatch === "custom_on" ? (
                            <Col xs={24} md={6}>
                                <Form.Item
                                    name="threshold"
                                    label="低于多少积分时发送邮件"
                                    rules={[{ required: true, message: "请填写积分阈值" }]}
                                >
                                    <InputNumber min={0} max={1000000} precision={2} className="w-full" />
                                </Form.Item>
                            </Col>
                        ) : null}
                        <Col xs={24} md={6}>
                            <Form.Item>
                                <Button type="primary" htmlType="submit" loading={savingAlert}>
                                    保存提醒设置
                                </Button>
                            </Form.Item>
                        </Col>
                    </Row>
                    <Typography.Text type="secondary" className="text-xs">
                        防骚扰规则：跌破阈值时发送一次提醒；余额回充到阈值以上后重置，或至少间隔{" "}
                        {profileData?.lowBalanceAlert?.cooldownHours ?? 24} 小时才会再次提醒。
                        {profileData?.lowBalanceAlert?.lastAlertedAt
                            ? ` 上次提醒：${new Date(profileData.lowBalanceAlert.lastAlertedAt).toLocaleString("zh-CN")}`
                            : ""}
                    </Typography.Text>
                </Form>
            </Card>

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
                        <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={sessionsLoading} onClick={() => void loadSessions()}>
                            刷新
                        </Button>
                    </Space>
                }
            >
                <Table<AccountSessionItem>
                    rowKey="id"
                    size="small"
                    className={ADMIN_TABLE_CLASS}
                    scroll={ADMIN_TABLE_SCROLL}
                    loading={sessionsLoading}
                    dataSource={sessions}
                    pagination={false}
                    columns={[
                        {
                            title: "设备 / 浏览器",
                            key: "ua",
                            width: 340,
                            render: (_, record) => (
                                <div className="flex max-w-[320px] items-center gap-2">
                                    <Typography.Text ellipsis={{ tooltip: record.userAgent }} className="min-w-0 flex-1">
                                        {record.userAgent || "未知设备"}
                                    </Typography.Text>
                                    {record.isCurrent ? (
                                        <Tag color="green" style={{ marginInlineEnd: 0 }}>
                                            当前设备
                                        </Tag>
                                    ) : null}
                                </div>
                            ),
                        },
                        { title: "IP", dataIndex: "ip", width: 130, render: (v: string) => v || "—" },
                        { title: "登录时间", dataIndex: "createdAt", width: 170, render: (v: string) => new Date(v).toLocaleString("zh-CN") },
                        { title: "过期时间", dataIndex: "expiresAt", width: 170, render: (v: string) => new Date(v).toLocaleString("zh-CN") },
                        {
                            title: "操作",
                            key: "actions",
                            fixed: "right",
                            width: 75,
                            render: (_, record) =>
                                record.isCurrent ? (
                                    <Typography.Text type="secondary" className="text-xs">
                                        当前
                                    </Typography.Text>
                                ) : (
                                    <TableRowActions
                                        items={[
                                            {
                                                key: "revoke",
                                                label: "下线",
                                                danger: true,
                                                confirm: "确定强制下线该设备吗？",
                                                onClick: () => void handleRevokeSession(record.id),
                                            },
                                        ]}
                                    />
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
    const { message } = App.useApp();
    const { token } = antdTheme.useToken();
    const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
    const [mediaLoading, setMediaLoading] = useState(false);
    const [downloadingId, setDownloadingId] = useState<string | null>(null);
    const [previewMedia, setPreviewMedia] = useState<MediaItem | null>(null);
    const [previewOriginalUrl, setPreviewOriginalUrl] = useState("");
    const [loadingPreviewId, setLoadingPreviewId] = useState<string | null>(null);

    const isMediaGeneration = item?.reason === "image_gen" || item?.reason === "video_gen";

    useEffect(() => {
        setPreviewMedia(null);
        setPreviewOriginalUrl("");
        setLoadingPreviewId(null);
        if (!item || !isMediaGeneration) {
            setMediaItems([]);
            setMediaLoading(false);
            return;
        }
        let cancelled = false;
        setMediaLoading(true);
        storageApi
            .getLedgerMedia(item.id)
            .then((res) => {
                if (!cancelled) setMediaItems(res.items || []);
            })
            .catch(() => {
                if (!cancelled) setMediaItems([]);
            })
            .finally(() => {
                if (!cancelled) setMediaLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [isMediaGeneration, item]);

    const handlePreviewGenerated = async (media: MediaItem) => {
        if (loadingPreviewId) return;
        setLoadingPreviewId(media.id);
        try {
            const url = media.url || (await storageApi.getUrl(media.id)).url;
            if (!url) {
                message.error("文件链接暂不可用");
                return;
            }
            setPreviewOriginalUrl(url);
            setPreviewMedia(media);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载原文件失败");
        } finally {
            setLoadingPreviewId(null);
        }
    };

    const handleDownloadGenerated = async (media: MediaItem) => {
        setDownloadingId(media.id);
        try {
            await storageApi.downloadFile(media);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "下载失败");
        } finally {
            setDownloadingId(null);
        }
    };

    const handleBatchDownloadMedia = async () => {
        const targets = items.filter((item) => selectedMediaIds.includes(item.id));
        await downloadZip({
            entries: targets.map((item) => ({
                filename: mediaDownloadFilename(item),
                loadBlob: () => storageApi.downloadBlob(item.id),
            })),
            zipFilename: `cloud-media-${Date.now()}.zip`,
        });
    };
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
    const errorMessage = typeof item?.meta?.errorMessage === "string" ? item.meta.errorMessage.trim() : "";
    const errorStatus = typeof item?.meta?.errorStatus === "number" ? item.meta.errorStatus : undefined;

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

                    {errorMessage || errorStatus !== undefined ? (
                        <Alert
                            type="error"
                            showIcon
                            title={errorStatus !== undefined ? `请求失败（HTTP ${errorStatus}）` : "生成失败原因"}
                            description={
                                <div className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-5">
                                    {errorMessage || `上游返回异常状态码 HTTP ${errorStatus}`}
                                </div>
                            }
                        />
                    ) : null}

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
                                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm font-medium">
                                    <span>{timing.durationText}</span>
                                    {timing.clientAborted ? (
                                        <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                                            前端提前断开
                                        </Tag>
                                    ) : null}
                                </div>
                                {timing.stageText ? (
                                    <Typography.Text type="secondary" className="mt-0.5 block text-xs">
                                        {timing.stageText}
                                    </Typography.Text>
                                ) : null}
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

                    {isMediaGeneration ? (
                        <div>
                            <Typography.Text type="secondary" className="mb-1.5 block text-xs">
                                生成结果（缩略图与原文件下载）
                            </Typography.Text>
                            {mediaLoading ? (
                                <div
                                    className="flex items-center gap-2 rounded-lg border p-3"
                                    style={{ borderColor: token.colorBorderSecondary }}
                                >
                                    <Spin size="small" />
                                    <Typography.Text type="secondary" className="text-xs">
                                        正在加载生成结果缩略图...
                                    </Typography.Text>
                                </div>
                            ) : mediaItems.length ? (
                                <div className={mediaItems.length === 1 ? "grid grid-cols-1 gap-2.5" : "grid grid-cols-1 gap-2.5 sm:grid-cols-2"}>
                                    {mediaItems.map((media) => {
                                        const thumb = media.thumbnailUrl || previewUrlFor(media.id) || "";
                                        const fileLabel = mediaDownloadFilename(media);
                                        const isLoadingPreview = loadingPreviewId === media.id;
                                        return (
                                            <div
                                                key={media.id}
                                                className="flex items-center gap-3 rounded-lg border p-2.5"
                                                style={{ borderColor: token.colorBorderSecondary }}
                                            >
                                                <button
                                                    type="button"
                                                    onClick={() => void handlePreviewGenerated(media)}
                                                    disabled={Boolean(loadingPreviewId)}
                                                    className="group relative size-16 shrink-0 cursor-pointer overflow-hidden rounded border-0 bg-transparent p-0"
                                                    title="点击预览原文件"
                                                >
                                                    {thumb ? (
                                                        <img src={thumb} alt={fileLabel} className="size-full object-cover transition group-hover:scale-105" />
                                                    ) : (
                                                        <div className="flex size-full items-center justify-center bg-black/5 text-stone-400 dark:bg-white/10">
                                                            {media.kind === "video" ? <Video className="size-5" /> : <ImageIcon className="size-5" />}
                                                        </div>
                                                    )}
                                                    <div
                                                        className={`absolute inset-0 flex items-center justify-center bg-black/45 text-white transition-opacity ${
                                                            isLoadingPreview ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                                                        }`}
                                                    >
                                                        {isLoadingPreview ? <Spin size="small" /> : <Eye className="size-4" />}
                                                    </div>
                                                </button>
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex flex-wrap items-center gap-1.5">
                                                        <Tag style={{ marginInlineEnd: 0 }}>{kindLabels[media.kind] || media.kind}</Tag>
                                                        {media.width && media.height ? (
                                                            <Typography.Text type="secondary" className="whitespace-nowrap text-xs">
                                                                {media.width}×{media.height}
                                                            </Typography.Text>
                                                        ) : null}
                                                    </div>
                                                    <div className="mt-1 truncate text-xs" title={fileLabel}>
                                                        {fileLabel}
                                                    </div>
                                                    <Typography.Text type="secondary" className="block text-xs">
                                                        {formatBytes(media.bytes)}
                                                    </Typography.Text>
                                                </div>
                                                <Space size={6} className="shrink-0">
                                                    <Button
                                                        size="small"
                                                        icon={<Eye className="size-3.5" />}
                                                        loading={isLoadingPreview}
                                                        onClick={() => void handlePreviewGenerated(media)}
                                                    >
                                                        预览
                                                    </Button>
                                                    <Popconfirm
                                                        title="确定下载该原文件到本地吗？"
                                                        okText="确认下载"
                                                        cancelText="取消"
                                                        onConfirm={() => void handleDownloadGenerated(media)}
                                                    >
                                                        <Button
                                                            size="small"
                                                            type="primary"
                                                            ghost
                                                            icon={<Download className="size-3.5" />}
                                                            loading={downloadingId === media.id}
                                                        >
                                                            下载
                                                        </Button>
                                                    </Popconfirm>
                                                </Space>
                                            </div>
                                        );
                                    })}
                                </div>
                            ) : (
                                <div
                                    className="rounded-lg border p-3"
                                    style={{ borderColor: token.colorBorderSecondary }}
                                >
                                    <Typography.Text type="secondary" className="text-xs">
                                        暂无关联云端媒体文件（可能因配额不足、任务未完成或文件已删除）
                                    </Typography.Text>
                                </div>
                            )}
                        </div>
                    ) : null}

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
            <Modal
                open={Boolean(previewMedia)}
                title="生成结果预览"
                onCancel={() => {
                    setPreviewMedia(null);
                    setPreviewOriginalUrl("");
                }}
                footer={
                    <Space>
                        {previewMedia && previewOriginalUrl ? (
                            <Button
                                icon={<Download className="size-4" />}
                                loading={downloadingId === previewMedia.id}
                                onClick={() => void handleDownloadGenerated(previewMedia)}
                            >
                                下载原文件
                            </Button>
                        ) : null}
                        <Button
                            type="primary"
                            onClick={() => {
                                setPreviewMedia(null);
                                setPreviewOriginalUrl("");
                            }}
                        >
                            关闭
                        </Button>
                    </Space>
                }
                width={780}
                destroyOnHidden
            >
                {previewMedia && previewOriginalUrl ? (
                    previewMedia.kind === "image" ? (
                        <div className="flex justify-center rounded-lg bg-black/5 p-2 dark:bg-white/5">
                            <Image src={previewOriginalUrl} alt={previewMedia.objectKey} className="max-h-[70vh] object-contain" />
                        </div>
                    ) : previewMedia.kind === "video" ? (
                        <video src={previewOriginalUrl} controls autoPlay className="max-h-[70vh] w-full rounded-lg bg-black" />
                    ) : (
                        <a href={previewOriginalUrl} target="_blank" rel="noreferrer">
                            打开文件链接
                        </a>
                    )
                ) : null}
            </Modal>
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
    const [pageSize, setPageSize] = useState(compact ? 10 : 20);
    const [summary, setSummary] = useState<CreditLedgerSummary>(emptyLedgerSummary);
    const [loading, setLoading] = useState(false);

    const [reasonFilter, setReasonFilter] = useState("");
    const [dateRange, setDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);

    const [redeemCode, setRedeemCode] = useState("");
    const [redeeming, setRedeeming] = useState(false);
    const [detailItem, setDetailItem] = useState<CreditLedgerItem | null>(null);

    const loadLedger = useCallback(
        async (targetPage = page, nextReason = reasonFilter, nextRange = dateRange, nextPageSize = pageSize) => {
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
            } catch (error) {
                message.error(error instanceof Error ? error.message : "加载充值日志失败");
            } finally {
                setLoading(false);
            }
        },
        [dateRange, message, page, pageSize, reasonFilter, setUser],
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
                    <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={() => void loadLedger()}>
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
                        showTotal: (count) => `共 ${count} 条`,
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
                            title: "时间",
                            dataIndex: "createdAt",
                            width: 170,
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
                            width: 240,
                            render: (_, record) => {
                                const text = formatLedgerUsageDetail(record);
                                return (
                                    <Typography.Text type="secondary" ellipsis={{ tooltip: text }} className="block max-w-[220px]">
                                        {text}
                                    </Typography.Text>
                                );
                            },
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
                            width: 72,
                            fixed: "right",
                            render: (_, record) => (
                                <TableRowActions
                                    items={[
                                        {
                                            key: "detail",
                                            label: "详情",
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
            nextPageSize = pageSize,
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
            } catch (error) {
                message.error(error instanceof Error ? error.message : "加载使用日志失败");
            } finally {
                setLoading(false);
            }
        },
        [dateRange, isAdmin, logIdFilter, message, modelFilter, page, pageSize, reasonFilter, scope, statusFilter, userQueryFilter],
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
                        <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={() => void loadLogs()}>
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
                        showTotal: (count) => `共 ${count} 条`,
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
                                      title: "用户",
                                      key: "user",
                                      width: 140,
                                      render: (_: unknown, record: CreditLedgerItem) => (
                                          <div className="max-w-[130px] min-w-0">
                                              <div className="truncate font-medium">{record.displayName || record.username || record.userId}</div>
                                              {record.username ? (
                                                  <Typography.Text type="secondary" ellipsis className="block text-xs">
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
                            width: 170,
                            render: (v: string) => new Date(v).toLocaleString("zh-CN"),
                        },
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
                            title: "状态",
                            key: "taskStatus",
                            width: 85,
                            render: (_, record) => {
                                const st = getLedgerTaskStatus(record);
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
                            width: 170,
                            render: (_, record) => {
                                const { isStream, durationText, firstTokenMs, upstreamMs, stageText, clientAborted, tokPerSec } = getLedgerTimingStats(record.meta);
                                if (!durationText && !tokPerSec) return <Typography.Text type="secondary">—</Typography.Text>;
                                const tooltipTitle =
                                    isStream && firstTokenMs !== undefined
                                        ? `首字耗时 ${formatDurationSec(firstTokenMs)} / 总耗时 ${formatDurationSec(Number(record.meta?.durationMs ?? 0))}`
                                        : stageText
                                          ? `总耗时 ${durationText}（${stageText}${clientAborted ? " · 前端提前断开" : ""}）`
                                          : `总耗时 ${durationText}${clientAborted ? "（前端提前断开）" : ""}`;
                                return (
                                    <div className="flex flex-col leading-tight">
                                        {durationText ? (
                                            <Tooltip title={tooltipTitle}>
                                                <span className="font-mono text-xs">
                                                    {durationText}
                                                    {clientAborted ? " · 断连" : ""}
                                                </span>
                                            </Tooltip>
                                        ) : null}
                                        {tokPerSec > 0 ? (
                                            <Typography.Text type="secondary" className="font-mono text-[11px]">
                                                {tokPerSec} tok/s
                                            </Typography.Text>
                                        ) : upstreamMs !== undefined ? (
                                            <Typography.Text type="secondary" className="font-mono text-[11px]">
                                                上游 {formatDurationSec(upstreamMs)}
                                            </Typography.Text>
                                        ) : null}
                                    </div>
                                );
                            },
                        },
                        {
                            title: "用量与详情",
                            key: "detail",
                            width: 240,
                            render: (_, record) => {
                                const text = formatLedgerUsageDetail(record);
                                return (
                                    <Typography.Text type="secondary" ellipsis={{ tooltip: text }} className="block max-w-[220px]">
                                        {text}
                                    </Typography.Text>
                                );
                            },
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
                            width: 72,
                            fixed: "right",
                            render: (_, record) => (
                                <TableRowActions
                                    items={[
                                        {
                                            key: "detail",
                                            label: "详情",
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

export function MyMediaPanel() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const user = useUserStore((state) => state.user);
    const setUser = useUserStore((state) => state.setUser);
    const cleanupImages = useAssetStore((state) => state.cleanupImages);

    const [activeSubTab, setActiveSubTab] = useState<"media" | "canvas" | "image_workbench" | "video_workbench">("media");
    const [items, setItems] = useState<MediaItem[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [q, setQ] = useState("");
    const [kind, setKind] = useState("");
    const [moduleFilter, setModuleFilter] = useState("");
    const [loading, setLoading] = useState(false);
    const [usedBytes, setUsedBytes] = useState(user?.storageUsedBytes ?? 0);
    const [quotaBytes, setQuotaBytes] = useState(user?.storageQuotaBytes ?? 0);
    const [quotaExpiresAt, setQuotaExpiresAt] = useState<string | null>(user?.storageQuotaExpiresAt ?? null);
    const [baseQuotaBytes, setBaseQuotaBytes] = useState(0);
    const [baseQuotaExpiresAt, setBaseQuotaExpiresAt] = useState<string | null>(null);
    const [storageGrants, setStorageGrants] = useState<StorageGrantItem[]>([]);
    const [storageRedeemCode, setStorageRedeemCode] = useState("");
    const [redeemingStorage, setRedeemingStorage] = useState(false);
    const [workspaceStats, setWorkspaceStats] = useState({ canvasProjects: 0, imageLogs: 0, videoLogs: 0, assets: 0 });
    const [cloudProjects, setCloudProjects] = useState<Array<{ id: string; title: string; nodes?: unknown[]; mediaCount?: number; mediaBytes?: number; dataBytes?: number; updatedAt: string }>>([]);
    const [cloudImageLogs, setCloudImageLogs] = useState<Array<{ id: string; title?: string; prompt?: string; model?: string; status?: string; mediaCount?: number; mediaBytes?: number; dataBytes?: number; createdAt?: number }>>([]);
    const [cloudVideoLogs, setCloudVideoLogs] = useState<Array<{ id: string; title?: string; prompt?: string; model?: string; status?: string; mediaCount?: number; mediaBytes?: number; dataBytes?: number; createdAt?: number }>>([]);
    const [workspaceLoading, setWorkspaceLoading] = useState(false);
    const [previewItem, setPreviewItem] = useState<MediaItem | null>(null);
    const [previewOriginalUrl, setPreviewOriginalUrl] = useState("");
    const [downloadingId, setDownloadingId] = useState<string | null>(null);
    const [selectedMediaIds, setSelectedMediaIds] = useState<string[]>([]);
    const { downloading: batchDownloading, downloadZip } = useBatchZipDownload();

    const loadData = useCallback(async () => {
        setLoading(true);
        try {
            const [listRes, profileRes] = await Promise.all([
                storageApi.list({ page, pageSize, q, kind, module: moduleFilter }),
                accountApi.getProfile(),
            ]);
            setItems(listRes.items);
            setTotal(listRes.total ?? listRes.items.length);
            const loadedIdSet = new Set(listRes.items.map((item) => item.id));
            setSelectedMediaIds((prev) => prev.filter((id) => loadedIdSet.has(id)));
            if (listRes.workspaceStats) setWorkspaceStats(listRes.workspaceStats);
            setUsedBytes(profileRes.user.storageUsedBytes);
            setQuotaBytes(profileRes.user.storageQuotaBytes ?? 0);
            setQuotaExpiresAt(profileRes.user.storageQuotaExpiresAt ?? null);
            setBaseQuotaBytes(profileRes.storageQuotaDetail?.baseQuotaBytes ?? 0);
            setBaseQuotaExpiresAt(profileRes.storageQuotaDetail?.baseExpiresAt ?? null);
            setStorageGrants(profileRes.storageQuotaDetail?.grants ?? []);
            setUser(profileRes.user);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载媒体列表失败");
        } finally {
            setLoading(false);
        }
    }, [kind, message, moduleFilter, page, pageSize, q, setUser]);

    const loadWorkspaceTab = useCallback(
        async (tab: "canvas" | "image_workbench" | "video_workbench") => {
            setWorkspaceLoading(true);
            try {
                if (tab === "canvas") {
                    const res = await canvasApi.listProjects(true);
                    setCloudProjects(res.projects as Array<{ id: string; title: string; nodes?: unknown[]; mediaCount?: number; mediaBytes?: number; dataBytes?: number; updatedAt: string }>);
                } else if (tab === "image_workbench") {
                    const res = await workbenchApi.listLogs("image", true);
                    setCloudImageLogs(res.logs as Array<{ id: string; title?: string; prompt?: string; model?: string; status?: string; mediaCount?: number; mediaBytes?: number; dataBytes?: number; createdAt?: number }>);
                } else {
                    const res = await workbenchApi.listLogs("video", true);
                    setCloudVideoLogs(res.logs as Array<{ id: string; title?: string; prompt?: string; model?: string; status?: string; mediaCount?: number; mediaBytes?: number; dataBytes?: number; createdAt?: number }>);
                }
            } catch (error) {
                message.error(error instanceof Error ? error.message : "加载云端数据失败");
            } finally {
                setWorkspaceLoading(false);
            }
        },
        [message],
    );

    useEffect(() => {
        void loadData();
    }, [loadData]);

    useEffect(() => {
        if (activeSubTab !== "media") {
            void loadWorkspaceTab(activeSubTab);
        }
    }, [activeSubTab, loadWorkspaceTab]);

    useEffect(() => {
        const handleChanged = () => {
            void loadData();
            if (activeSubTab !== "media") {
                void loadWorkspaceTab(activeSubTab);
            }
        };
        window.addEventListener(WORKSPACE_CHANGED_EVENT, handleChanged);
        window.addEventListener("infinite-canvas:cloud-workspace-synced", handleChanged);
        return () => {
            window.removeEventListener(WORKSPACE_CHANGED_EVENT, handleChanged);
            window.removeEventListener("infinite-canvas:cloud-workspace-synced", handleChanged);
        };
    }, [activeSubTab, loadData, loadWorkspaceTab]);

    const handleDelete = async (mediaId: string) => {
        try {
            await storageApi.remove(mediaId);
            notifyCloudWorkspaceChanged("media", { sync: false });
            message.success("已从云端删除并释放存储空间");
            if (items.length <= 1 && page > 1) {
                setPage((prev) => Math.max(1, prev - 1));
            } else {
                void loadData();
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除失败");
        }
    };

    const handleDeleteCloudCanvas = async (projectId: string) => {
        try {
            await deleteCanvasProjectsWithCloud([projectId]);
            message.success("已删除画布及孤立云端媒体");
            await Promise.all([loadData(), loadWorkspaceTab("canvas")]);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除画布失败");
        }
    };

    const handleDeleteCloudWorkbenchLog = async (kindType: "image" | "video", logId: string) => {
        try {
            const storeName = kindType === "video" ? "video_generation_logs" : "image_generation_logs";
            await deleteWorkbenchLogsWithCloud(
                localforage.createInstance({ name: "infinite-canvas", storeName }),
                [logId],
                () => cleanupImages(),
                kindType,
            );
            message.success("已删除记录及孤立云端媒体");
            await Promise.all([loadData(), loadWorkspaceTab(kindType === "video" ? "video_workbench" : "image_workbench")]);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除记录失败");
        }
    };

    const handleDownloadMedia = async (record: MediaItem) => {
        setDownloadingId(record.id);
        try {
            await storageApi.downloadFile(record);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "下载失败");
        } finally {
            setDownloadingId(null);
        }
    };

    const handleBatchDownloadMedia = async () => {
        const targets = items.filter((item) => selectedMediaIds.includes(item.id));
        await downloadZip({
            entries: targets.map((item) => ({
                filename: mediaDownloadFilename(item),
                loadBlob: () => storageApi.downloadBlob(item.id),
            })),
            zipFilename: `cloud-media-${Date.now()}.zip`,
        });
    };

    const handleViewMedia = async (record: MediaItem) => {
        try {
            const url = record.url || (await storageApi.getUrl(record.id)).url;
            if (!url) {
                message.error("文件链接暂不可用");
                return;
            }
            setPreviewOriginalUrl(url);
            setPreviewItem(record);
            if (!record.thumbnailUrl && (record.kind === "image" || record.kind === "video")) {
                void (async () => {
                    try {
                        let thumb: Blob | undefined;
                        if (record.kind === "image") {
                            const res = await fetch(url);
                            if (res.ok) {
                                const blob = await res.blob();
                                thumb = (await createImageThumbnail(blob, 480).catch(() => undefined)) || blob;
                            }
                        } else {
                            thumb = await createVideoThumbnail(url, 480).catch(() => undefined);
                        }
                        if (!thumb) return;
                        const uploaded = await storageApi.uploadThumbnail(record.id, thumb);
                        if (uploaded.thumbnailUrl) {
                            setItems((prev) => prev.map((it) => (it.id === record.id ? { ...it, thumbnailUrl: uploaded.thumbnailUrl } : it)));
                        }
                    } catch {
                        // ignore backfill error
                    }
                })();
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载原文件失败");
        }
    };

    const handleRedeemStorage = async () => {
        const code = storageRedeemCode.trim();
        if (!code) {
            message.warning("请输入云端存储兑换码");
            return;
        }
        setRedeemingStorage(true);
        try {
            const res = await storageApi.redeem(code);
            message.success(
                `兑换成功！新增 ${formatBytes(res.storageBytesAdded)}（${res.storageDurationDays ? `有效期 ${res.storageDurationDays} 天` : "永久有效"}），当前总配额 ${formatBytes(res.storageQuotaBytes)}`,
            );
            setStorageRedeemCode("");
            setQuotaBytes(res.storageQuotaBytes);
            setQuotaExpiresAt(res.storageQuotaExpiresAt);
            setBaseQuotaBytes(res.baseQuotaBytes);
            setBaseQuotaExpiresAt(res.baseExpiresAt);
            setStorageGrants(res.grants);
            const latestUser = useUserStore.getState().user;
            if (latestUser) {
                setUser({
                    ...latestUser,
                    storageQuotaBytes: res.storageQuotaBytes,
                    storageQuotaExpiresAt: res.storageQuotaExpiresAt,
                });
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "兑换失败");
        } finally {
            setRedeemingStorage(false);
        }
    };

    const quotaExpired = Boolean(quotaExpiresAt && new Date(quotaExpiresAt).getTime() <= Date.now());
    const quotaExceeded = quotaExpired || quotaBytes <= 0 || usedBytes >= quotaBytes;
    const quotaPercent = quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : 100;
    const baseQuotaExpired = Boolean(baseQuotaExpiresAt && new Date(baseQuotaExpiresAt).getTime() <= Date.now());

    return (
        <div className="flex flex-col gap-5">
            <Card
                title={`我的云端存储配额（已用 ${formatBytes(usedBytes)} / 总配额 ${formatBytes(quotaBytes)}${quotaExpiresAt ? ` · 有效期至 ${new Date(quotaExpiresAt).toLocaleString("zh-CN")}` : " · 不限期"}）`}
                extra={
                    quotaExpired ? (
                        <Tag color="red">配额已过期，请兑换扩容或联系管理员续期</Tag>
                    ) : quotaExceeded ? (
                        <Tag color="red">配额不足，请删除闲置媒体或兑换扩容</Tag>
                    ) : (
                        <Tag color="green">剩余可用 {formatBytes(Math.max(0, quotaBytes - usedBytes))}</Tag>
                    )
                }
            >
                <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-[220px] flex-1">
                            <Progress percent={quotaPercent} status={quotaExceeded ? "exception" : "active"} />
                        </div>
                        <Space.Compact style={{ width: 340 }}>
                            <Input
                                value={storageRedeemCode}
                                placeholder="输入云端存储兑换码，如 ST-XXXX-XXXX-XXXX"
                                onChange={(e) => setStorageRedeemCode(e.target.value)}
                                onPressEnter={() => void handleRedeemStorage()}
                            />
                            <Button type="primary" icon={<Gift className="size-4" />} loading={redeemingStorage} onClick={() => void handleRedeemStorage()}>
                                兑换扩容
                            </Button>
                        </Space.Compact>
                    </div>

                    {baseQuotaBytes > 0 || storageGrants.length > 0 ? (
                        <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
                            <Typography.Text type="secondary">配额明细（资源包各自独立计算到期时间，到期后自动回落）：</Typography.Text>
                            {baseQuotaBytes > 0 ? (
                                <Tag color={baseQuotaExpired ? "default" : "blue"} style={{ marginInlineEnd: 0 }}>
                                    基础配额 {formatBytes(baseQuotaBytes)} ·{" "}
                                    {baseQuotaExpiresAt
                                        ? baseQuotaExpired
                                            ? "已过期"
                                            : `至 ${new Date(baseQuotaExpiresAt).toLocaleDateString("zh-CN")}`
                                        : "永久"}
                                </Tag>
                            ) : null}
                            {storageGrants.map((grant) => (
                                <Tag
                                    key={grant.id}
                                    color={grant.isEffective ? "cyan" : "default"}
                                    style={{ marginInlineEnd: 0 }}
                                >
                                    +{formatBytes(grant.quotaBytes)}
                                    {grant.refId ? ` (${grant.refId})` : ""}
                                    {" · "}
                                    {grant.status === "revoked"
                                        ? "已停用"
                                        : grant.expiresAt
                                          ? grant.isExpired
                                              ? "已过期"
                                              : `至 ${new Date(grant.expiresAt).toLocaleDateString("zh-CN")}`
                                          : "永久"}
                                </Tag>
                            ))}
                        </div>
                    ) : null}
                </div>
            </Card>

            <Card>
                <Tabs
                    activeKey={activeSubTab}
                    onChange={(key) => setActiveSubTab(key as "media" | "canvas" | "image_workbench" | "video_workbench")}
                    items={[
                        {
                            key: "media",
                            label: `云端媒体文件 (${total})`,
                            children: (
                                <>
                                    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                                        <Space wrap>
                                            <Select
                                                value={moduleFilter}
                                                style={{ width: 130 }}
                                                onChange={(val) => {
                                                    setPage(1);
                                                    setModuleFilter(val);
                                                }}
                                                options={MEDIA_MODULE_OPTIONS}
                                            />
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
                                        </Space>
                                        <Space wrap>
                                            {selectedMediaIds.length > 0 ? (
                                                <Button
                                                    type="primary"
                                                    icon={<Download className="size-4" />}
                                                    loading={batchDownloading}
                                                    onClick={() => void handleBatchDownloadMedia()}
                                                >
                                                    打包下载 ({selectedMediaIds.length})
                                                </Button>
                                            ) : null}
                                            <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void loadData()}>
                                                刷新
                                            </Button>
                                        </Space>
                                    </div>
                                    <Table<MediaItem>
                                        rowKey="id"
                                        className={ADMIN_TABLE_CLASS}
                                        scroll={ADMIN_TABLE_SCROLL}
                                        loading={loading}
                                        dataSource={items}
                                        rowSelection={{
                                            selectedRowKeys: selectedMediaIds,
                                            onChange: (keys) => setSelectedMediaIds(keys.map(String)),
                                        }}
                                        pagination={{
                                            current: page,
                                            pageSize,
                                            total,
                                            showSizeChanger: true,
                                            pageSizeOptions: [10, 20, 30, 50, 100],
                                            showTotal: (count) => `共 ${count} 条`,
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
                                                title: "预览 / 对象路径",
                                                key: "preview",
                                                width: 300,
                                                render: (_, record) => {
                                                    const thumb = record.thumbnailUrl || previewUrlFor(record.id) || "";
                                                    return (
                                                        <div className="flex max-w-[280px] items-center gap-3">
                                                            {thumb ? (
                                                                <img src={thumb} alt={record.objectKey} className="size-10 shrink-0 rounded object-cover" />
                                                            ) : (
                                                                <div className="flex size-10 shrink-0 items-center justify-center rounded bg-black/5 text-stone-400 dark:bg-white/10">
                                                                    {record.kind === "video" ? <Video className="size-4" /> : record.kind === "audio" ? <AudioLines className="size-4" /> : record.kind === "image" ? <ImageIcon className="size-4" /> : <FileIcon className="size-4" />}
                                                                </div>
                                                            )}
                                                            <div className="min-w-0">
                                                                <div className="truncate font-mono text-xs">{record.objectKey}</div>
                                                                <Typography.Text type="secondary" className="block truncate text-xs">
                                                                    {record.mimeType}
                                                                </Typography.Text>
                                                            </div>
                                                        </div>
                                                    );
                                                },
                                            },
                                            {
                                                title: "所属模块",
                                                key: "modules",
                                                width: 170,
                                                render: (_, record) => <MediaModuleTags modules={record.modules} />,
                                            },
                                            { title: "类型", dataIndex: "kind", width: 85, render: (v: string) => <Tag>{kindLabels[v] || v}</Tag> },
                                            { title: "大小", dataIndex: "bytes", width: 100, render: (bytes: number) => formatBytes(bytes) },
                                            { title: "上传时间", dataIndex: "createdAt", width: 170, render: (v: string) => new Date(v).toLocaleString("zh-CN") },
                                            {
                                                title: "操作",
                                                key: "actions",
                                                fixed: "right",
                                                width: 100,
                                                render: (_, record) => (
                                                    <TableRowActions
                                                        items={[
                                                            {
                                                                key: "view",
                                                                label: "查看",
                                                                onClick: () => void handleViewMedia(record),
                                                            },
                                                            {
                                                                key: "delete",
                                                                label: "删除",
                                                                danger: true,
                                                                confirm: "确定从云端删除该文件并释放个人空间吗？",
                                                                onClick: () => void handleDelete(record.id),
                                                            },
                                                        ]}
                                                    />
                                                ),
                                            },
                                        ]}
                                    />
                                </>
                            ),
                        },
                        {
                            key: "canvas",
                            label: `无限画布 (${workspaceStats.canvasProjects})`,
                            children: (
                                <Table
                                    rowKey="id"
                                    className={ADMIN_TABLE_CLASS}
                                    scroll={ADMIN_TABLE_SCROLL}
                                    loading={workspaceLoading}
                                    dataSource={cloudProjects}
                                    pagination={{ defaultPageSize: 20, showSizeChanger: true, pageSizeOptions: [10, 20, 30, 50, 100], showTotal: (count) => `共 ${count} 条` }}
                                    columns={[
                                        { title: "画布名称", dataIndex: "title", width: 240, ellipsis: true },
                                        { title: "节点数", key: "nodes", width: 85, render: (_, rec) => (Array.isArray(rec.nodes) ? rec.nodes.length : 0) },
                                        { title: "关联媒体", dataIndex: "mediaCount", width: 95, render: (v?: number) => `${v ?? 0} 个` },
                                        { title: "数据大小", key: "size", width: 150, render: (_, rec) => <WorkspaceSizeCell mediaBytes={rec.mediaBytes} dataBytes={rec.dataBytes} /> },
                                        { title: "最近同步", dataIndex: "updatedAt", width: 170, render: (v: string) => new Date(v).toLocaleString("zh-CN") },
                                        {
                                            title: "操作",
                                            key: "actions",
                                            fixed: "right",
                                            width: 110,
                                            render: (_, rec) => (
                                                <TableRowActions
                                                    items={[
                                                        { key: "open", label: "打开", onClick: () => navigate(`/canvas/${rec.id}`) },
                                                        {
                                                            key: "delete",
                                                            label: "删除",
                                                            danger: true,
                                                            confirm: "删除画布后，仅被该画布引用的云端媒体也会一并删除，确定吗？",
                                                            onClick: () => void handleDeleteCloudCanvas(rec.id),
                                                        },
                                                    ]}
                                                />
                                            ),
                                        },
                                    ]}
                                />
                            ),
                        },
                        ...(
                            [
                                { key: "image_workbench", label: `生图工作台 (${workspaceStats.imageLogs})`, kindType: "image", data: cloudImageLogs },
                                { key: "video_workbench", label: `视频创作台 (${workspaceStats.videoLogs})`, kindType: "video", data: cloudVideoLogs },
                            ] as const
                        ).map((tabCfg) => ({
                            key: tabCfg.key,
                            label: tabCfg.label,
                            children: (
                                <Table
                                    rowKey="id"
                                    className={ADMIN_TABLE_CLASS}
                                    scroll={ADMIN_TABLE_SCROLL}
                                    loading={workspaceLoading}
                                    dataSource={tabCfg.data}
                                    pagination={{ defaultPageSize: 20, showSizeChanger: true, pageSizeOptions: [10, 20, 30, 50, 100], showTotal: (count) => `共 ${count} 条` }}
                                    columns={[
                                        {
                                            title: "标题 / 提示词",
                                            key: "prompt",
                                            width: 300,
                                            render: (_, rec) => (
                                                <div className="max-w-[280px] truncate" title={rec.prompt || rec.title}>
                                                    {rec.prompt || rec.title || "未命名记录"}
                                                </div>
                                            ),
                                        },
                                        { title: "模型", dataIndex: "model", width: 180, ellipsis: true },
                                        {
                                            title: "状态",
                                            dataIndex: "status",
                                            width: 85,
                                            render: (st: string) => <Tag color={st === "success" ? "green" : st === "failed" ? "red" : "processing"}>{st === "success" ? "成功" : st === "failed" ? "失败" : "进行中"}</Tag>,
                                        },
                                        { title: "关联媒体", dataIndex: "mediaCount", width: 95, render: (v?: number) => `${v ?? 0} 个` },
                                        { title: "数据大小", key: "size", width: 150, render: (_, rec) => <WorkspaceSizeCell mediaBytes={rec.mediaBytes} dataBytes={rec.dataBytes} /> },
                                        { title: "时间", dataIndex: "createdAt", width: 170, render: (v?: number) => (v ? new Date(v).toLocaleString("zh-CN") : "—") },
                                        {
                                            title: "操作",
                                            key: "actions",
                                            fixed: "right",
                                            width: 100,
                                            render: (_, rec) => (
                                                <TableRowActions
                                                    items={[
                                                        {
                                                            key: "open",
                                                            label: "前往",
                                                            onClick: () => navigate(tabCfg.kindType === "video" ? "/video" : "/image"),
                                                        },
                                                        {
                                                            key: "delete",
                                                            label: "删除",
                                                            danger: true,
                                                            confirm: "删除记录后，仅被该记录引用的云端媒体也会一并删除并释放空间，确定吗？",
                                                            onClick: () => void handleDeleteCloudWorkbenchLog(tabCfg.kindType, rec.id),
                                                        },
                                                    ]}
                                                />
                                            ),
                                        },
                                    ]}
                                />
                            ),
                        })),
                    ]}
                />
            </Card>

            <Modal
                open={Boolean(previewItem)}
                title="媒体原文件预览"
                onCancel={() => {
                    setPreviewItem(null);
                    setPreviewOriginalUrl("");
                }}
                footer={
                    <Space>
                        {previewItem && previewOriginalUrl ? (
                            <Button
                                icon={<Download className="size-4" />}
                                loading={downloadingId === previewItem.id}
                                onClick={() => void handleDownloadMedia(previewItem)}
                            >
                                下载原文件
                            </Button>
                        ) : null}
                        <Button
                            type="primary"
                            onClick={() => {
                                setPreviewItem(null);
                                setPreviewOriginalUrl("");
                            }}
                        >
                            关闭
                        </Button>
                    </Space>
                }
                width={780}
                destroyOnHidden
            >
                {previewItem && previewOriginalUrl ? (
                    previewItem.kind === "image" ? (
                        <div className="flex justify-center rounded-lg bg-black/5 p-2 dark:bg-white/5">
                            <Image src={previewOriginalUrl} alt={previewItem.objectKey} className="max-h-[70vh] object-contain" />
                        </div>
                    ) : previewItem.kind === "video" ? (
                        <video src={previewOriginalUrl} controls autoPlay className="max-h-[70vh] w-full rounded-lg bg-black" />
                    ) : previewItem.kind === "audio" ? (
                        <div className="flex justify-center py-6">
                            <audio src={previewOriginalUrl} controls autoPlay className="w-full max-w-md" />
                        </div>
                    ) : (
                        <a href={previewOriginalUrl} target="_blank" rel="noreferrer">
                            打开文件链接
                        </a>
                    )
                ) : null}
            </Modal>
        </div>
    );
}
