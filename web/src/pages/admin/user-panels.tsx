/** 个人后台与公共面板组件：概览趋势、平台公告卡片、账号安全维护、充值钱包、NewAPI 风格使用日志及云端媒体清理。 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Avatar, Button, Card, Col, DatePicker, Descriptions, Empty, Form, Image, Input, InputNumber, Modal, Popconfirm, Progress, Radio, Row, Segmented, Select, Space, Spin, Statistic, Switch, Table, Tabs, Tag, Tooltip, Typography, theme as antdTheme } from "antd";
import type { Dayjs } from "dayjs";
import type { TFunction } from "i18next";
import localforage from "localforage";
import { AudioLines, Bell, Download, Eye, FileIcon, Gift, ImageIcon, KeyRound, Laptop, Megaphone, Pin, RefreshCw, Search, TrendingUp, User, Video } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { useBatchZipDownload } from "@/hooks/use-batch-zip-download";
import { useEmailCodeSender } from "@/hooks/use-email-code-sender";
import { formatCompactCredits, formatExactCredits } from "@/lib/format-number";
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

function getKindLabel(kind: string, t: TFunction) {
    if (kind === "image" || kind === "video" || kind === "audio" || kind === "file") {
        return t(`userPanels.mediaKinds.${kind}`);
    }
    return kind;
}

export function getMediaModuleOptions(t: TFunction): Array<{ value: "" | MediaSourceModule; label: string }> {
    return [
        { value: "", label: t("userPanels.mediaModules.all") },
        { value: "canvas", label: t("userPanels.mediaModules.canvas") },
        { value: "image_workbench", label: t("userPanels.mediaModules.image_workbench") },
        { value: "video_workbench", label: t("userPanels.mediaModules.video_workbench") },
        { value: "assets", label: t("userPanels.mediaModules.assets") },
    ];
}

const mediaModuleColors: Record<MediaSourceModule, string> = {
    canvas: "blue",
    image_workbench: "purple",
    video_workbench: "geekblue",
    assets: "cyan",
};

export function MediaModuleTags({ modules }: { modules?: MediaSourceModule[] }) {
    const { t } = useTranslation();
    if (!modules?.length) {
        return <Tag style={{ marginInlineEnd: 0 }}>{t("userPanels.mediaModules.standalone")}</Tag>;
    }
    return (
        <Space size={4} wrap={false}>
            {modules.map((mod) => (
                <Tag key={mod} color={mediaModuleColors[mod]} style={{ marginInlineEnd: 0 }}>
                    {mod in mediaModuleColors ? t(`userPanels.mediaModules.${mod}`) : mod}
                </Tag>
            ))}
        </Space>
    );
}

export function WorkspaceSizeCell({ mediaBytes = 0, dataBytes = 0 }: { mediaBytes?: number; dataBytes?: number }) {
    const { t } = useTranslation();
    const tip = t("userPanels.workspaceSizeTip", {
        media: formatBytes(mediaBytes),
        data: formatBytes(dataBytes),
    });
    return (
        <Tooltip title={tip}>
            <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
                <span>{formatBytes(mediaBytes > 0 ? mediaBytes : dataBytes)}</span>
                {mediaBytes <= 0 && dataBytes > 0 ? (
                    <Typography.Text type="secondary" className="text-xs">
                        {t("userPanels.metadataOnly")}
                    </Typography.Text>
                ) : null}
            </span>
        </Tooltip>
    );
}

const ledgerReasonColors: Record<string, string> = {
    text_gen: "blue",
    image_gen: "purple",
    video_gen: "geekblue",
    audio_gen: "cyan",
    redeem_code: "green",
    admin_adjust: "gold",
    refund: "lime",
    plan_grant: "green",
};

function getLedgerReasonMeta(reason: string, t: TFunction): { label: string; color: string } | undefined {
    if (!(reason in ledgerReasonColors)) return undefined;
    return { label: t(`userPanels.ledgerReasons.${reason}`), color: ledgerReasonColors[reason] };
}

const taskStatusColors: Record<string, string> = {
    not_started: "default",
    processing: "processing",
    completed: "success",
    failed: "error",
    failed_refunded: "orange",
    refunded: "orange",
};

function getLedgerTaskStatus(record: CreditLedgerItem, t: TFunction) {
    const raw = typeof record.meta?.taskStatus === "string" ? record.meta.taskStatus : "";
    if (raw && raw in taskStatusColors) {
        return { label: t(`userPanels.taskStatuses.${raw}`), color: taskStatusColors[raw] };
    }
    if (record.reason === "refund") {
        return { label: t("userPanels.taskStatuses.refunded"), color: taskStatusColors.refunded };
    }
    return { label: t("userPanels.taskStatuses.completed"), color: taskStatusColors.completed };
}

function formatDurationSec(ms: number) {
    return `${(ms / 1000).toFixed(2)}s`;
}

/** 根据流式状态与分段耗时计算 `tok/s` 输出速度及 `首字 / 总耗时`、`上游/拿图/云存` 展示文案。 */
function getLedgerTimingStats(meta: Record<string, unknown> | undefined, t: TFunction) {
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
    if (upstreamMs !== undefined) stageParts.push(t("userPanels.timing.stageUpstream", { duration: formatDurationSec(upstreamMs) }));
    if (fetchImageMs !== undefined) stageParts.push(t("userPanels.timing.stageFetch", { duration: formatDurationSec(fetchImageMs) }));
    if (cloudSaveMs !== undefined) stageParts.push(t("userPanels.timing.stageCloud", { duration: formatDurationSec(cloudSaveMs) }));
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

function formatLedgerUsageDetail(record: CreditLedgerItem, t: TFunction) {
    const meta = record.meta || {};
    const parts: string[] = [];
    if (typeof meta.inputTokens === "number" || typeof meta.outputTokens === "number") {
        const cached =
            typeof meta.cachedInputTokens === "number" && meta.cachedInputTokens > 0
                ? t("userPanels.usageDetail.cachedPart", { count: meta.cachedInputTokens })
                : "";
        parts.push(
            t("userPanels.usageDetail.tokens", {
                input: meta.inputTokens ?? 0,
                cached,
                output: meta.outputTokens ?? 0,
            }),
        );
    }
    if (typeof meta.count === "number") parts.push(t("userPanels.usageDetail.countImages", { count: meta.count }));
    if (typeof meta.resolutionTier === "string" && meta.resolutionTier) parts.push(meta.resolutionTier.toUpperCase());
    else if (typeof meta.size === "string" && meta.size) parts.push(meta.size);
    if (typeof meta.seconds === "number") parts.push(t("userPanels.usageDetail.seconds", { seconds: meta.seconds }));
    if (meta.hasReferenceVideo === true) parts.push(t("userPanels.usageDetail.hasRefVideo"));
    if (typeof meta.durationSeconds === "number") parts.push(t("userPanels.usageDetail.durationSeconds", { seconds: meta.durationSeconds }));
    if (typeof meta.code === "string" && meta.code) parts.push(t("userPanels.usageDetail.redeemCode", { code: meta.code }));
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
                        <Space>
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
                        <div className="flex h-48 items-end gap-1.5 pt-4">
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

export function UserOverviewPanel({ onOpenWallet }: { onOpenWallet?: () => void }) {
    const { t } = useTranslation();
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

    return (
        <div className="flex flex-col gap-5">
            <Row gutter={[16, 16]}>
                <Col xs={24} sm={12} md={6}>
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
                <Col xs={24} sm={12} md={6}>
                    <Card loading={loading}>
                        <Tooltip title={t("userPanels.overview.exactValue", { value: formatExactCredits(data?.todayConsumedCredits ?? 0) })}>
                            <div>
                                <Statistic title={t("userPanels.overview.todayConsumed")} value={formatCompactCredits(data?.todayConsumedCredits ?? 0)} />
                            </div>
                        </Tooltip>
                    </Card>
                </Col>
                <Col xs={24} sm={12} md={6}>
                    <Card loading={loading}>
                        <Tooltip title={t("userPanels.overview.exactValue", { value: formatExactCredits(data?.totalConsumedCredits ?? 0) })}>
                            <div>
                                <Statistic title={t("userPanels.overview.totalConsumed")} value={formatCompactCredits(data?.totalConsumedCredits ?? 0)} />
                            </div>
                        </Tooltip>
                    </Card>
                </Col>
                <Col xs={24} sm={12} md={6}>
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

export function ProfileSecurityPanel() {
    const { t, i18n } = useTranslation();
    const locale = i18n.resolvedLanguage || undefined;
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
            message.error(error instanceof Error ? error.message : t("userPanels.profile.loadFailed"));
        } finally {
            setLoading(false);
        }
    }, [alertForm, message, profileForm, setUser, t]);

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
                message.warning(t("userPanels.profile.enterEmailFirst"));
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
            message.success(t("userPanels.profile.saved"));
            void loadProfile();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("userPanels.profile.saveFailed"));
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
            message.success(t("userPanels.profile.alertSaved"));
            void loadProfile();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("userPanels.profile.alertSaveFailed"));
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
            message.success(t("userPanels.profile.passwordChanged"));
            void loadSessions();
            void loadProfile();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("userPanels.profile.passwordChangeFailed"));
        } finally {
            setChangingPassword(false);
        }
    };

    const handleRevokeSession = async (id: string) => {
        try {
            await accountApi.revokeSession(id);
            message.success(t("userPanels.profile.sessionRevoked"));
            void loadSessions();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("userPanels.profile.opFailed"));
        }
    };

    const handleRevokeOtherSessions = async () => {
        try {
            await accountApi.revokeOtherSessions();
            message.success(t("userPanels.profile.otherSessionsRevoked"));
            void loadSessions();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("userPanels.profile.opFailed"));
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
                        <Tooltip title={t("userPanels.overview.exactBalance", { value: formatExactCredits(detail?.creditBalance ?? 0) })}>
                            <div>
                                <Statistic title={t("userPanels.profile.currentCredits")} value={formatCompactCredits(detail?.creditBalance ?? 0)} />
                            </div>
                        </Tooltip>
                    </Card>
                </Col>
                <Col xs={24} sm={12} md={6}>
                    <Card loading={loading}>
                        <Statistic
                            title={t("userPanels.profile.storageQuota")}
                            value={`${formatBytes(detail?.storageUsedBytes ?? 0)} / ${formatBytes(detail?.storageQuotaBytes ?? 0)}`}
                        />
                    </Card>
                </Col>
                <Col xs={24} sm={12} md={6}>
                    <Card loading={loading}>
                        <Statistic title={t("userPanels.profile.canvasCount")} value={profileData?.stats.canvasProjectCount ?? 0} />
                    </Card>
                </Col>
                <Col xs={24} sm={12} md={6}>
                    <Card loading={loading}>
                        <Statistic title={t("userPanels.profile.assetCount")} value={profileData?.stats.assetCount ?? 0} />
                    </Card>
                </Col>
            </Row>

            <Card title={t("userPanels.profile.accountDetails")}>
                <Descriptions column={{ xs: 1, sm: 2 }} bordered size="small">
                    <Descriptions.Item label={t("userPanels.profile.username")}>@{detail?.username}</Descriptions.Item>
                    <Descriptions.Item label={t("userPanels.profile.role")}>
                        <Tag color={detail?.role === "admin" ? "blue" : "default"}>
                            {detail?.role === "admin" ? t("userPanels.profile.roleAdmin") : t("userPanels.profile.roleUser")}
                        </Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label={t("userPanels.profile.status")}>
                        <Tag color={detail?.status === "active" ? "green" : "red"}>
                            {detail?.status === "active" ? t("userPanels.profile.statusActive") : t("userPanels.profile.statusDisabled")}
                        </Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label={t("userPanels.profile.cloudStorageQuota")}>
                        <div className="flex flex-wrap items-center gap-2">
                            <span>
                                {t("userPanels.profile.usedAndQuota", {
                                    used: formatBytes(detail?.storageUsedBytes ?? 0),
                                    quota: formatBytes(detail?.storageQuotaBytes ?? 0),
                                    expiry: detail?.storageQuotaExpiresAt
                                        ? t("userPanels.profile.expiryUntil", { time: new Date(detail.storageQuotaExpiresAt).toLocaleString(locale) })
                                        : t("userPanels.profile.expiryNone"),
                                })}
                            </span>
                            {detail?.storageQuotaExpiresAt && new Date(detail.storageQuotaExpiresAt).getTime() <= Date.now() ? (
                                <Tag color="red">{t("userPanels.profile.expired")}</Tag>
                            ) : (detail?.storageQuotaBytes ?? 0) <= 0 || (detail?.storageUsedBytes ?? 0) >= (detail?.storageQuotaBytes ?? 0) ? (
                                <Tag color="red">{t("userPanels.profile.quotaFullExpand")}</Tag>
                            ) : (
                                <Tag color="green">{t("userPanels.profile.statusActive")}</Tag>
                            )}
                        </div>
                    </Descriptions.Item>
                    {detail?.role === "admin" ? (
                        <Descriptions.Item label={t("userPanels.profile.webdavAssign")} span={2}>
                            {profileData?.webdav?.enabled ? (
                                <div className="flex flex-wrap items-center gap-2">
                                    <Tag color={profileData.webdav.isExpired ? "red" : "cyan"}>{profileData.webdav.directory}</Tag>
                                    {profileData.webdav.isExpired ? <Tag color="red">{t("userPanels.profile.expired")}</Tag> : null}
                                    {profileData.webdav.isQuotaExceeded ? <Tag color="volcano">{t("userPanels.profile.quotaExceededTag")}</Tag> : null}
                                    <Typography.Text type="secondary" className="text-xs">
                                        {t("userPanels.profile.webdavUsed", { used: formatBytes(profileData.webdav.usedBytes ?? 0) })}
                                        {profileData.webdav.quotaBytes
                                            ? ` / ${formatBytes(profileData.webdav.quotaBytes)}`
                                            : t("userPanels.profile.webdavUnlimited")}
                                        {profileData.webdav.expiresAt
                                            ? t("userPanels.profile.expiryUntil", { time: new Date(profileData.webdav.expiresAt).toLocaleString(locale) })
                                            : t("userPanels.profile.webdavPermanent")}
                                    </Typography.Text>
                                </div>
                            ) : (
                                <Tag>{t("userPanels.profile.unassigned")}</Tag>
                            )}
                        </Descriptions.Item>
                    ) : null}
                    <Descriptions.Item label={t("userPanels.profile.createdAt")}>
                        {profileData?.user.createdAt ? new Date(profileData.user.createdAt).toLocaleString(locale) : "—"}
                    </Descriptions.Item>
                    <Descriptions.Item label={t("userPanels.profile.lastLoginAt")}>
                        {profileData?.user.lastLoginAt ? new Date(profileData.user.lastLoginAt).toLocaleString(locale) : "—"}
                    </Descriptions.Item>
                </Descriptions>
            </Card>

            <Row gutter={[16, 16]}>
                <Col xs={24} lg={12}>
                    <Card
                        title={
                            <span className="inline-flex items-center gap-2">
                                <User className="size-4" />
                                {t("userPanels.profile.profileCardTitle")}
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
                            <Form.Item
                                name="displayName"
                                label={t("userPanels.profile.displayName")}
                                rules={[{ required: true, message: t("userPanels.profile.displayNameReq") }]}
                            >
                                <Input maxLength={48} placeholder={t("userPanels.profile.displayNameReq")} />
                            </Form.Item>
                            <Form.Item
                                name="email"
                                label={
                                    <span className="inline-flex items-center gap-2">
                                        <span>{t("userPanels.profile.email")}</span>
                                        {detail?.email ? (
                                            detail.emailVerifiedAt ? (
                                                <Tag color="green" style={{ marginInlineEnd: 0 }}>
                                                    {t("userPanels.profile.emailVerified")}
                                                </Tag>
                                            ) : (
                                                <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                                                    {t("userPanels.profile.emailUnverified")}
                                                </Tag>
                                            )
                                        ) : null}
                                    </span>
                                }
                                rules={[
                                    ...(profileData?.requireEmailOnRegister && detail?.role !== "admin"
                                        ? [{ required: true, message: t("userPanels.profile.emailReq") }]
                                        : []),
                                    { type: "email" as const, message: t("userPanels.profile.emailInvalid") },
                                ]}
                            >
                                <Input placeholder="example@domain.com" />
                            </Form.Item>
                            {needsEmailVerifyCode ? (
                                <Form.Item
                                    name="emailCode"
                                    label={t("userPanels.profile.emailCode")}
                                    rules={[{ required: true, message: t("userPanels.profile.emailCodeReq") }]}
                                >
                                    <Space.Compact className="w-full">
                                        <Input placeholder={t("userPanels.profile.codePlaceholder")} maxLength={8} />
                                        <Button
                                            loading={bindEmailCodeSender.sending}
                                            disabled={bindEmailCodeSender.cooldown > 0}
                                            onClick={() => void handleSendBindEmailCode()}
                                        >
                                            {bindEmailCodeSender.cooldown > 0
                                                ? t("userPanels.profile.retryAfter", { seconds: bindEmailCodeSender.cooldown })
                                                : t("userPanels.profile.getCode")}
                                        </Button>
                                    </Space.Compact>
                                </Form.Item>
                            ) : null}
                            <Form.Item name="avatarUrl" label={t("userPanels.profile.avatarUrl")}>
                                <Input placeholder="https://..." />
                            </Form.Item>
                            <Button type="primary" htmlType="submit" loading={savingProfile}>
                                {t("userPanels.profile.saveProfile")}
                            </Button>
                        </Form>
                    </Card>
                </Col>

                <Col xs={24} lg={12}>
                    <Card
                        title={
                            <span className="inline-flex items-center gap-2">
                                <KeyRound className="size-4" />
                                {t("userPanels.profile.securityTitle")}
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
                                    { label: t("userPanels.profile.modePassword"), value: "password" },
                                    { label: t("userPanels.profile.modeEmail"), value: "email", disabled: !canResetByEmail },
                                ]}
                            />
                        }
                    >
                        {!canResetByEmail ? (
                            <Typography.Text type="secondary" className="mb-3 block text-xs">
                                {emailServiceEnabled ? t("userPanels.profile.emailResetHintEnabled") : t("userPanels.profile.emailResetHintDisabled")}
                            </Typography.Text>
                        ) : null}
                        <Form form={passwordForm} layout="vertical" initialValues={{ revokeOtherSessions: true }} onFinish={handleChangePassword}>
                            {passwordMode === "password" ? (
                                <Form.Item
                                    name="currentPassword"
                                    label={t("userPanels.profile.currentPassword")}
                                    rules={[{ required: true, message: t("userPanels.profile.currentPasswordReq") }]}
                                >
                                    <Input.Password placeholder={t("userPanels.profile.currentPasswordPlaceholder")} />
                                </Form.Item>
                            ) : (
                                <>
                                    <Form.Item label={t("userPanels.profile.receiveCodeEmail")}>
                                        <Input value={detail?.email || ""} disabled />
                                    </Form.Item>
                                    <Form.Item
                                        name="emailCode"
                                        label={t("userPanels.profile.emailCode")}
                                        rules={[{ required: true, message: t("userPanels.profile.emailCodeInputReq") }]}
                                    >
                                        <Space.Compact className="w-full">
                                            <Input placeholder={t("userPanels.profile.codePlaceholder")} maxLength={8} />
                                            <Button
                                                loading={changePasswordCodeSender.sending}
                                                disabled={changePasswordCodeSender.cooldown > 0}
                                                onClick={() => void handleSendChangePasswordCode()}
                                            >
                                                {changePasswordCodeSender.cooldown > 0
                                                    ? t("userPanels.profile.retryAfter", { seconds: changePasswordCodeSender.cooldown })
                                                    : t("userPanels.profile.sendCode")}
                                            </Button>
                                        </Space.Compact>
                                    </Form.Item>
                                </>
                            )}
                            <Form.Item
                                name="newPassword"
                                label={t("userPanels.profile.newPassword")}
                                rules={[
                                    { required: true, message: t("userPanels.profile.newPasswordReq") },
                                    { min: 6, message: t("userPanels.profile.newPasswordMin") },
                                ]}
                            >
                                <Input.Password placeholder={t("userPanels.profile.newPasswordPlaceholder")} />
                            </Form.Item>
                            <Form.Item
                                name="confirmPassword"
                                label={t("userPanels.profile.confirmPassword")}
                                dependencies={["newPassword"]}
                                rules={[
                                    { required: true, message: t("userPanels.profile.confirmPasswordReq") },
                                    ({ getFieldValue }) => ({
                                        validator(_, value) {
                                            if (!value || getFieldValue("newPassword") === value) return Promise.resolve();
                                            return Promise.reject(new Error(t("userPanels.profile.confirmMismatch")));
                                        },
                                    }),
                                ]}
                            >
                                <Input.Password placeholder={t("userPanels.profile.confirmPlaceholder")} />
                            </Form.Item>
                            <Form.Item name="revokeOtherSessions" label={t("userPanels.profile.revokeOtherSessions")} valuePropName="checked">
                                <Switch />
                            </Form.Item>
                            <Button type="primary" htmlType="submit" loading={changingPassword}>
                                {t("userPanels.profile.updatePassword")}
                            </Button>
                        </Form>
                    </Card>
                </Col>
            </Row>

            <Card
                title={
                    <span className="inline-flex items-center gap-2">
                        <Bell className="size-4" />
                        {t("userPanels.profile.lowBalanceTitle")}
                    </span>
                }
            >
                {!emailServiceEnabled ? (
                    <Alert
                        type="info"
                        showIcon
                        className="mb-4"
                        message={t("userPanels.profile.mailDisabledTitle")}
                        description={t("userPanels.profile.mailDisabledDesc")}
                    />
                ) : !detail?.email ? (
                    <Alert
                        type="warning"
                        showIcon
                        className="mb-4"
                        message={t("userPanels.profile.noEmailTitle")}
                        description={t("userPanels.profile.noEmailDesc")}
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
                            <Form.Item name="mode" label={t("userPanels.profile.alertPolicyLabel")}>
                                <Radio.Group>
                                    <Radio value="inherit">
                                        {t("userPanels.profile.alertInheritPrefix")}
                                        {profileData?.lowBalanceAlert?.platformEnabled
                                            ? t("userPanels.profile.alertBelowThreshold", { threshold: profileData.lowBalanceAlert.platformThreshold })
                                            : t("userPanels.profile.alertClosed")}
                                        )
                                    </Radio>
                                    <Radio value="custom_on">{t("userPanels.profile.alertCustom")}</Radio>
                                    <Radio value="off">{t("userPanels.profile.alertOff")}</Radio>
                                </Radio.Group>
                            </Form.Item>
                        </Col>
                        {alertModeWatch === "custom_on" ? (
                            <Col xs={24} md={6}>
                                <Form.Item
                                    name="threshold"
                                    label={t("userPanels.profile.thresholdLabel")}
                                    rules={[{ required: true, message: t("userPanels.profile.thresholdReq") }]}
                                >
                                    <InputNumber min={0} max={1000000} precision={2} className="w-full" />
                                </Form.Item>
                            </Col>
                        ) : null}
                        <Col xs={24} md={6}>
                            <Form.Item>
                                <Button type="primary" htmlType="submit" loading={savingAlert}>
                                    {t("userPanels.profile.saveAlertSettings")}
                                </Button>
                            </Form.Item>
                        </Col>
                    </Row>
                    <Typography.Text type="secondary" className="text-xs">
                        {t("userPanels.profile.alertRateLimitNote", { hours: profileData?.lowBalanceAlert?.cooldownHours ?? 24 })}
                        {profileData?.lowBalanceAlert?.lastAlertedAt
                            ? t("userPanels.profile.lastAlertedAt", {
                                  time: new Date(profileData.lowBalanceAlert.lastAlertedAt).toLocaleString(locale),
                              })
                            : ""}
                    </Typography.Text>
                </Form>
            </Card>

            <Card
                title={
                    <span className="inline-flex items-center gap-2">
                        <Laptop className="size-4" />
                        {t("userPanels.profile.sessionsTitle")}
                    </span>
                }
                extra={
                    <Space>
                        <Popconfirm title={t("userPanels.profile.confirmRevokeOthers")} onConfirm={() => void handleRevokeOtherSessions()}>
                            <Button size="small">{t("userPanels.profile.revokeOthers")}</Button>
                        </Popconfirm>
                        <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={sessionsLoading} onClick={() => void loadSessions()}>
                            {t("common.refresh")}
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
                            title: t("userPanels.profile.colDevice"),
                            key: "ua",
                            width: 340,
                            render: (_, record) => (
                                <div className="flex max-w-[320px] items-center gap-2">
                                    <Typography.Text ellipsis={{ tooltip: record.userAgent }} className="min-w-0 flex-1">
                                        {record.userAgent || t("userPanels.profile.unknownDevice")}
                                    </Typography.Text>
                                    {record.isCurrent ? (
                                        <Tag color="green" style={{ marginInlineEnd: 0 }}>
                                            {t("userPanels.profile.currentDevice")}
                                        </Tag>
                                    ) : null}
                                </div>
                            ),
                        },
                        { title: t("userPanels.profile.colIp"), dataIndex: "ip", width: 130, render: (v: string) => v || "—" },
                        { title: t("userPanels.profile.colLoginTime"), dataIndex: "createdAt", width: 170, render: (v: string) => new Date(v).toLocaleString(locale) },
                        { title: t("userPanels.profile.colExpiresAt"), dataIndex: "expiresAt", width: 170, render: (v: string) => new Date(v).toLocaleString(locale) },
                        {
                            title: t("userPanels.profile.colActions"),
                            key: "actions",
                            fixed: "right",
                            width: 75,
                            render: (_, record) =>
                                record.isCurrent ? (
                                    <Typography.Text type="secondary" className="text-xs">
                                        {t("userPanels.profile.currentShort")}
                                    </Typography.Text>
                                ) : (
                                    <TableRowActions
                                        items={[
                                            {
                                                key: "revoke",
                                                label: t("userPanels.profile.revokeAction"),
                                                danger: true,
                                                confirm: t("userPanels.profile.confirmRevoke"),
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
    const { t, i18n } = useTranslation();
    const locale = i18n.resolvedLanguage || undefined;
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
                message.error(t("userPanels.ledgerDetail.fileUrlUnavailable"));
                return;
            }
            setPreviewOriginalUrl(url);
            setPreviewMedia(media);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("userPanels.ledgerDetail.loadOriginalFailed"));
        } finally {
            setLoadingPreviewId(null);
        }
    };

    const handleDownloadGenerated = async (media: MediaItem) => {
        setDownloadingId(media.id);
        try {
            await storageApi.downloadFile(media);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("userPanels.ledgerDetail.downloadFailed"));
        } finally {
            setDownloadingId(null);
        }
    };
    const reasonInfo = item ? getLedgerReasonMeta(item.reason, t) : undefined;
    const modelName = typeof item?.meta?.model === "string" && item.meta.model ? item.meta.model : "";
    const hasTokens = typeof item?.meta?.inputTokens === "number" || typeof item?.meta?.outputTokens === "number";
    const imageSpec = [
        typeof item?.meta?.count === "number" ? t("userPanels.usageDetail.countImages", { count: item.meta.count }) : "",
        typeof item?.meta?.resolutionTier === "string" && item.meta.resolutionTier ? item.meta.resolutionTier.toUpperCase() : "",
        typeof item?.meta?.size === "string" && item.meta.size ? item.meta.size : "",
    ]
        .filter(Boolean)
        .join(" · ");
    const hasMediaDuration = typeof item?.meta?.seconds === "number" || typeof item?.meta?.durationSeconds === "number";
    const timing = getLedgerTimingStats(item?.meta, t);
    const errorMessage = typeof item?.meta?.errorMessage === "string" ? item.meta.errorMessage.trim() : "";
    const errorStatus = typeof item?.meta?.errorStatus === "number" ? item.meta.errorStatus : undefined;
    const refundedCredits =
        typeof item?.meta?.refundedCredits === "number" && item.meta.refundedCredits > 0 ? item.meta.refundedCredits : 0;
    const chargedCredits =
        typeof item?.meta?.chargedCredits === "number"
            ? item.meta.chargedCredits
            : refundedCredits > 0 && item
              ? Math.round((Math.abs(Math.min(0, item.delta)) + refundedCredits) * 10000) / 10000
              : 0;
    const refundDetail = typeof item?.meta?.refundDetail === "string" ? item.meta.refundDetail.trim() : "";
    const refundedAt = typeof item?.meta?.refundedAt === "string" ? item.meta.refundedAt : "";
    const isFailedTask = item?.meta?.taskStatus === "failed" || item?.meta?.taskStatus === "failed_refunded";
    const displayDelta = isFailedTask ? 0 : item?.delta ?? 0;

    return (
        <Modal
            open={Boolean(item)}
            title={t("userPanels.ledgerDetail.title")}
            onCancel={onClose}
            footer={
                <Button type="primary" onClick={onClose}>
                    {t("common.close")}
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
                            <Tag color={getLedgerTaskStatus(item, t).color} style={{ marginInlineEnd: 0 }}>
                                {getLedgerTaskStatus(item, t).label}
                            </Tag>
                            {typeof timing.isStream === "boolean" ? (
                                <Tag color={timing.isStream ? "cyan" : undefined} style={{ marginInlineEnd: 0 }}>
                                    {timing.isStream ? t("userPanels.ledgerDetail.stream") : t("userPanels.ledgerDetail.nonStream")}
                                </Tag>
                            ) : null}
                            {modelName ? <Tag style={{ marginInlineEnd: 0 }}>{modelName}</Tag> : null}
                            <Typography.Text type="secondary" className="text-xs">
                                {new Date(item.createdAt).toLocaleString(locale)}
                            </Typography.Text>
                        </div>
                        <div className="flex items-baseline gap-2.5">
                            {isFailedTask ? (
                                <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                                    {t("userPanels.ledgerDetail.zeroCredits")}
                                </Tag>
                            ) : refundedCredits > 0 ? (
                                <Tag color={displayDelta === 0 ? "orange" : "volcano"} style={{ marginInlineEnd: 0 }}>
                                    {t("userPanels.ledgerDetail.netDeltaRefund", { delta: displayDelta, refunded: refundedCredits })}
                                </Tag>
                            ) : (
                                <Tag color={displayDelta >= 0 ? "green" : "volcano"} style={{ marginInlineEnd: 0 }}>
                                    {t("userPanels.ledgerDetail.deltaCredits", { delta: displayDelta >= 0 ? `+${displayDelta}` : displayDelta })}
                                </Tag>
                            )}
                            <Typography.Text type="secondary" className="text-xs">
                                {t("userPanels.ledgerDetail.balanceAfterPrefix")}{" "}
                                <span className="font-medium" style={{ color: token.colorText }}>
                                    {item.balanceAfter}
                                </span>
                            </Typography.Text>
                        </div>
                    </div>

                    {refundedCredits > 0 ? (
                        <div
                            className="grid grid-cols-2 gap-3 rounded-lg border p-3.5 sm:grid-cols-4"
                            style={{ borderColor: token.colorBorderSecondary, backgroundColor: token.colorFillAlter }}
                        >
                            <div>
                                <Typography.Text type="secondary" className="block text-xs">
                                    {t("userPanels.ledgerDetail.chargedCredits")}
                                </Typography.Text>
                                <div className="mt-0.5 text-sm font-medium">{chargedCredits > 0 ? `-${chargedCredits}` : "—"}</div>
                            </div>
                            <div>
                                <Typography.Text type="secondary" className="block text-xs">
                                    {t("userPanels.ledgerDetail.refundedCredits")}
                                </Typography.Text>
                                <div className="mt-0.5 text-sm font-medium text-emerald-500">+{refundedCredits}</div>
                            </div>
                            <div>
                                <Typography.Text type="secondary" className="block text-xs">
                                    {t("userPanels.ledgerDetail.netDeducted")}
                                </Typography.Text>
                                <div className="mt-0.5 text-sm font-medium">{isFailedTask ? 0 : Math.abs(item.delta)}</div>
                            </div>
                            <div>
                                <Typography.Text type="secondary" className="block text-xs">
                                    {t("userPanels.ledgerDetail.refundedAt")}
                                </Typography.Text>
                                <div className="mt-0.5 text-xs">{refundedAt ? new Date(refundedAt).toLocaleString(locale) : "—"}</div>
                            </div>
                            {refundDetail ? (
                                <div className="col-span-2 sm:col-span-4">
                                    <Typography.Text type="secondary" className="text-xs">
                                        {t("userPanels.ledgerDetail.refundReason", { reason: refundDetail })}
                                    </Typography.Text>
                                </div>
                            ) : null}
                        </div>
                    ) : null}

                    {errorMessage || errorStatus !== undefined ? (
                        <Alert
                            type="error"
                            showIcon
                            title={
                                errorStatus !== undefined
                                    ? t("userPanels.ledgerDetail.httpErrorTitle", { status: errorStatus })
                                    : t("userPanels.ledgerDetail.failedReasonTitle")
                            }
                            description={
                                <div className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-5">
                                    {errorMessage || t("userPanels.ledgerDetail.httpErrorFallback", { status: errorStatus })}
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
                                {t("userPanels.ledgerDetail.logId")}
                            </Typography.Text>
                            <Typography.Text copyable className="mt-0.5 block break-all font-mono text-xs">
                                {item.id}
                            </Typography.Text>
                        </div>

                        {showUser && (item.username || item.displayName) ? (
                            <div className="min-w-0">
                                <Typography.Text type="secondary" className="block text-xs">
                                    {t("userPanels.ledgerDetail.ownerUser")}
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
                                    {t("userPanels.ledgerDetail.refId")}
                                </Typography.Text>
                                <Typography.Text copyable className="mt-0.5 block break-all font-mono text-xs">
                                    {item.refId}
                                </Typography.Text>
                            </div>
                        ) : null}

                        {timing.durationText ? (
                            <div className="min-w-0">
                                <Typography.Text type="secondary" className="block text-xs">
                                    {timing.isStream && timing.firstTokenMs !== undefined
                                        ? t("userPanels.ledgerDetail.timingStreamLabel")
                                        : t("userPanels.ledgerDetail.timingRequestLabel")}
                                </Typography.Text>
                                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm font-medium">
                                    <span>{timing.durationText}</span>
                                    {timing.clientAborted ? (
                                        <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                                            {t("userPanels.ledgerDetail.clientAborted")}
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
                                    {t("userPanels.ledgerDetail.genSpeed")}
                                </Typography.Text>
                                <div className="mt-0.5 text-sm font-medium">{timing.tokPerSec} tok/s</div>
                            </div>
                        ) : null}

                        {hasTokens ? (
                            <div className="min-w-0 sm:col-span-2">
                                <Typography.Text type="secondary" className="block text-xs">
                                    {t("userPanels.ledgerDetail.tokenUsage")}
                                </Typography.Text>
                                <div className="mt-0.5 text-sm">
                                    {t("userPanels.ledgerDetail.tokenUsageDetail", {
                                        input: Number(item.meta?.inputTokens ?? 0).toLocaleString(locale),
                                        cached: Number(item.meta?.cachedInputTokens ?? 0).toLocaleString(locale),
                                        output: Number(item.meta?.outputTokens ?? 0).toLocaleString(locale),
                                    })}
                                </div>
                            </div>
                        ) : null}

                        {imageSpec ? (
                            <div className="min-w-0">
                                <Typography.Text type="secondary" className="block text-xs">
                                    {t("userPanels.ledgerDetail.imageSpec")}
                                </Typography.Text>
                                <div className="mt-0.5 text-sm">{imageSpec}</div>
                            </div>
                        ) : null}

                        {hasMediaDuration ? (
                            <div className="min-w-0">
                                <Typography.Text type="secondary" className="block text-xs">
                                    {t("userPanels.ledgerDetail.mediaDuration")}
                                </Typography.Text>
                                <div className="mt-0.5 text-sm">
                                    {typeof item.meta?.seconds === "number"
                                        ? t("userPanels.usageDetail.seconds", { seconds: item.meta.seconds })
                                        : t("userPanels.usageDetail.seconds", { seconds: item.meta?.durationSeconds })}
                                    {item.meta?.hasReferenceVideo === true ? t("userPanels.ledgerDetail.hasRefVideoSuffix") : ""}
                                </div>
                            </div>
                        ) : null}

                        {typeof item.meta?.code === "string" && item.meta.code ? (
                            <div className="min-w-0">
                                <Typography.Text type="secondary" className="block text-xs">
                                    {t("userPanels.ledgerDetail.redeemCode")}
                                </Typography.Text>
                                <Typography.Text copyable className="mt-0.5 block font-mono text-xs">
                                    {item.meta.code}
                                </Typography.Text>
                            </div>
                        ) : null}

                        {typeof item.meta?.detail === "string" && item.meta.detail ? (
                            <div className="min-w-0 sm:col-span-2">
                                <Typography.Text type="secondary" className="block text-xs">
                                    {t("userPanels.ledgerDetail.detailInfo")}
                                </Typography.Text>
                                <div className="mt-0.5 text-sm">{item.meta.detail}</div>
                            </div>
                        ) : null}

                        {typeof item.meta?.note === "string" && item.meta.note ? (
                            <div className="min-w-0 sm:col-span-2">
                                <Typography.Text type="secondary" className="block text-xs">
                                    {t("userPanels.ledgerDetail.noteInfo")}
                                </Typography.Text>
                                <div className="mt-0.5 text-sm">{item.meta.note}</div>
                            </div>
                        ) : null}
                    </div>

                    {isMediaGeneration ? (
                        <div>
                            <Typography.Text type="secondary" className="mb-1.5 block text-xs">
                                {t("userPanels.ledgerDetail.generatedResults")}
                            </Typography.Text>
                            {mediaLoading ? (
                                <div
                                    className="flex items-center gap-2 rounded-lg border p-3"
                                    style={{ borderColor: token.colorBorderSecondary }}
                                >
                                    <Spin size="small" />
                                    <Typography.Text type="secondary" className="text-xs">
                                        {t("userPanels.ledgerDetail.loadingThumbs")}
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
                                                    title={t("userPanels.ledgerDetail.previewOriginalTitle")}
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
                                                        <Tag style={{ marginInlineEnd: 0 }}>{getKindLabel(media.kind, t)}</Tag>
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
                                                        {t("userPanels.ledgerDetail.previewBtn")}
                                                    </Button>
                                                    <Popconfirm
                                                        title={t("userPanels.ledgerDetail.confirmDownloadTitle")}
                                                        okText={t("userPanels.ledgerDetail.confirmDownloadOk")}
                                                        cancelText={t("common.cancel")}
                                                        onConfirm={() => void handleDownloadGenerated(media)}
                                                    >
                                                        <Button
                                                            size="small"
                                                            type="primary"
                                                            ghost
                                                            icon={<Download className="size-3.5" />}
                                                            loading={downloadingId === media.id}
                                                        >
                                                            {t("common.download")}
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
                                        {t("userPanels.ledgerDetail.noLinkedMedia")}
                                    </Typography.Text>
                                </div>
                            )}
                        </div>
                    ) : null}

                    {item.meta && Object.keys(item.meta).length > 0 ? (
                        <div>
                            <Typography.Text type="secondary" className="mb-1.5 block text-xs">
                                {t("userPanels.ledgerDetail.rawMeta")}
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
                title={t("userPanels.ledgerDetail.previewModalTitle")}
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
                                {t("common.downloadOriginal")}
                            </Button>
                        ) : null}
                        <Button
                            type="primary"
                            onClick={() => {
                                setPreviewMedia(null);
                                setPreviewOriginalUrl("");
                            }}
                        >
                            {t("common.close")}
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
                            {t("common.openFileLink")}
                        </a>
                    )
                ) : null}
            </Modal>
        </Modal>
    );
}

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
                message.error(error instanceof Error ? error.message : t("userPanels.wallet.loadFailed"));
            } finally {
                setLoading(false);
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

    return (
        <div className="flex flex-col gap-4">
            <Card size={compact ? "small" : "default"}>
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
                    <Space.Compact style={{ width: compact ? 310 : 360 }}>
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
                    <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={() => void loadLedger()}>
                        {t("common.refresh")}
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
                            { value: "", label: t("userPanels.wallet.allTypes") },
                            { value: "redeem_code", label: t("userPanels.ledgerReasons.redeem_code") },
                            { value: "admin_adjust", label: t("userPanels.ledgerReasons.admin_adjust") },
                            { value: "plan_grant", label: t("userPanels.ledgerReasons.plan_grant") },
                        ]}
                    />
                    <DatePicker.RangePicker
                        value={dateRange}
                        onChange={(dates) => {
                            setPage(1);
                            setDateRange(dates);
                        }}
                        placeholder={[t("userPanels.wallet.startDate"), t("userPanels.wallet.endDate")]}
                    />
                    {reasonFilter || dateRange ? <Button onClick={resetFilters}>{t("userPanels.wallet.resetFilters")}</Button> : null}
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
                            width: 115,
                            render: (delta: number, record: CreditLedgerItem) => {
                                const isFailed =
                                    record.meta?.taskStatus === "failed" || record.meta?.taskStatus === "failed_refunded";
                                const refundedCredits =
                                    typeof record.meta?.refundedCredits === "number" && record.meta.refundedCredits > 0
                                        ? record.meta.refundedCredits
                                        : 0;
                                if (isFailed) {
                                    const charged =
                                        typeof record.meta?.chargedCredits === "number"
                                            ? record.meta.chargedCredits
                                            : refundedCredits;
                                    const tip =
                                        refundedCredits > 0
                                            ? t("userPanels.wallet.failedRefundTip", { charged, refunded: refundedCredits })
                                            : t("userPanels.wallet.failedNoChargeTip");
                                    return (
                                        <Tooltip title={tip}>
                                            <Tag color="orange">0</Tag>
                                        </Tooltip>
                                    );
                                }
                                if (refundedCredits > 0) {
                                    const charged =
                                        typeof record.meta?.chargedCredits === "number"
                                            ? record.meta.chargedCredits
                                            : Math.round((Math.abs(Math.min(0, delta)) + refundedCredits) * 10000) / 10000;
                                    return (
                                        <Tooltip
                                            title={t("userPanels.wallet.partialRefundTip", {
                                                charged,
                                                refunded: refundedCredits,
                                                net: Math.abs(delta),
                                            })}
                                        >
                                            <Tag color={delta === 0 ? "orange" : "volcano"}>{delta === 0 ? "0" : delta}</Tag>
                                        </Tooltip>
                                    );
                                }
                                return <Tag color={delta >= 0 ? "green" : "volcano"}>{delta >= 0 ? `+${delta}` : delta}</Tag>;
                            },
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
                                    { label: t("userPanels.usageLogs.scopeAll"), value: "all" },
                                    { label: t("userPanels.usageLogs.scopeSelf"), value: "self" },
                                ]}
                            />
                        ) : null}
                        <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={() => void loadLogs()}>
                            {t("common.refresh")}
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
                            { value: "", label: t("userPanels.usageLogs.allUsageTypes") },
                            { value: "text_gen", label: t("userPanels.ledgerReasons.text_gen") },
                            { value: "image_gen", label: t("userPanels.ledgerReasons.image_gen") },
                            { value: "video_gen", label: t("userPanels.ledgerReasons.video_gen") },
                            { value: "audio_gen", label: t("userPanels.ledgerReasons.audio_gen") },
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
                            placeholder={t("userPanels.usageLogs.searchUser")}
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
                        placeholder={t("userPanels.usageLogs.searchLogId")}
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
                        placeholder={[t("userPanels.wallet.startDate"), t("userPanels.wallet.endDate")]}
                    />
                    {reasonFilter || statusFilter || modelFilter || userQueryFilter || logIdFilter || dateRange ? (
                        <Button onClick={resetFilters}>{t("userPanels.wallet.resetFilters")}</Button>
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
                            width: 115,
                            render: (delta: number, record: CreditLedgerItem) => {
                                const isFailed =
                                    record.meta?.taskStatus === "failed" || record.meta?.taskStatus === "failed_refunded";
                                const refundedCredits =
                                    typeof record.meta?.refundedCredits === "number" && record.meta.refundedCredits > 0
                                        ? record.meta.refundedCredits
                                        : 0;
                                if (isFailed) {
                                    const charged =
                                        typeof record.meta?.chargedCredits === "number"
                                            ? record.meta.chargedCredits
                                            : refundedCredits;
                                    const tip =
                                        refundedCredits > 0
                                            ? t("userPanels.wallet.failedRefundTip", { charged, refunded: refundedCredits })
                                            : t("userPanels.wallet.failedNoChargeTip");
                                    return (
                                        <Tooltip title={tip}>
                                            <Tag color="orange">0</Tag>
                                        </Tooltip>
                                    );
                                }
                                if (refundedCredits > 0) {
                                    const charged =
                                        typeof record.meta?.chargedCredits === "number"
                                            ? record.meta.chargedCredits
                                            : Math.round((Math.abs(Math.min(0, delta)) + refundedCredits) * 10000) / 10000;
                                    return (
                                        <Tooltip
                                            title={t("userPanels.wallet.partialRefundTip", {
                                                charged,
                                                refunded: refundedCredits,
                                                net: Math.abs(delta),
                                            })}
                                        >
                                            <Tag color={delta === 0 ? "orange" : "volcano"}>{delta === 0 ? "0" : delta}</Tag>
                                        </Tooltip>
                                    );
                                }
                                return <Tag color={delta >= 0 ? "green" : "volcano"}>{delta >= 0 ? `+${delta}` : delta}</Tag>;
                            },
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

export function MyMediaPanel() {
    const { t, i18n } = useTranslation();
    const locale = i18n.resolvedLanguage || undefined;
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
            message.error(error instanceof Error ? error.message : t("userPanels.myMedia.loadFailed"));
        } finally {
            setLoading(false);
        }
    }, [kind, message, moduleFilter, page, pageSize, q, setUser, t]);

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
                message.error(error instanceof Error ? error.message : t("userPanels.myMedia.loadCloudFailed"));
            } finally {
                setWorkspaceLoading(false);
            }
        },
        [message, t],
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
            message.success(t("userPanels.myMedia.deletedMedia"));
            if (items.length <= 1 && page > 1) {
                setPage((prev) => Math.max(1, prev - 1));
            } else {
                void loadData();
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("common.deleteFailed"));
        }
    };

    const handleDeleteCloudCanvas = async (projectId: string) => {
        try {
            await deleteCanvasProjectsWithCloud([projectId]);
            message.success(t("userPanels.myMedia.deletedCanvas"));
            await Promise.all([loadData(), loadWorkspaceTab("canvas")]);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("userPanels.myMedia.deleteCanvasFailed"));
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
            message.success(t("userPanels.myMedia.deletedRecord"));
            await Promise.all([loadData(), loadWorkspaceTab(kindType === "video" ? "video_workbench" : "image_workbench")]);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("userPanels.myMedia.deleteRecordFailed"));
        }
    };

    const handleDownloadMedia = async (record: MediaItem) => {
        setDownloadingId(record.id);
        try {
            await storageApi.downloadFile(record);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("userPanels.ledgerDetail.downloadFailed"));
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
                message.error(t("userPanels.ledgerDetail.fileUrlUnavailable"));
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
            message.error(error instanceof Error ? error.message : t("userPanels.ledgerDetail.loadOriginalFailed"));
        }
    };

    const handleRedeemStorage = async () => {
        const code = storageRedeemCode.trim();
        if (!code) {
            message.warning(t("userPanels.myMedia.enterCodeWarning"));
            return;
        }
        setRedeemingStorage(true);
        try {
            const res = await storageApi.redeem(code);
            message.success(
                t("userPanels.myMedia.redeemSuccess", {
                    added: formatBytes(res.storageBytesAdded),
                    duration: res.storageDurationDays
                        ? t("userPanels.myMedia.durationDays", { days: res.storageDurationDays })
                        : t("userPanels.myMedia.durationPermanent"),
                    quota: formatBytes(res.storageQuotaBytes),
                }),
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
            message.error(error instanceof Error ? error.message : t("userPanels.wallet.redeemFailed"));
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
                title={t("userPanels.myMedia.cardTitle", {
                    used: formatBytes(usedBytes),
                    quota: formatBytes(quotaBytes),
                    expiry: quotaExpiresAt
                        ? t("userPanels.profile.expiryUntil", { time: new Date(quotaExpiresAt).toLocaleString(locale) })
                        : t("userPanels.profile.expiryNone"),
                })}
                extra={
                    quotaExpired ? (
                        <Tag color="red">{t("userPanels.myMedia.quotaExpiredTag")}</Tag>
                    ) : quotaExceeded ? (
                        <Tag color="red">{t("userPanels.myMedia.quotaFullTag")}</Tag>
                    ) : (
                        <Tag color="green">{t("userPanels.myMedia.remainingQuotaTag", { remaining: formatBytes(Math.max(0, quotaBytes - usedBytes)) })}</Tag>
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
                                placeholder={t("userPanels.myMedia.codePlaceholder")}
                                onChange={(e) => setStorageRedeemCode(e.target.value)}
                                onPressEnter={() => void handleRedeemStorage()}
                            />
                            <Button type="primary" icon={<Gift className="size-4" />} loading={redeemingStorage} onClick={() => void handleRedeemStorage()}>
                                {t("userPanels.myMedia.redeemExpand")}
                            </Button>
                        </Space.Compact>
                    </div>

                    {baseQuotaBytes > 0 || storageGrants.length > 0 ? (
                        <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
                            <Typography.Text type="secondary">{t("userPanels.myMedia.quotaBreakdownLabel")}</Typography.Text>
                            {baseQuotaBytes > 0 ? (
                                <Tag color={baseQuotaExpired ? "default" : "blue"} style={{ marginInlineEnd: 0 }}>
                                    {t("userPanels.myMedia.baseQuotaTag", { size: formatBytes(baseQuotaBytes) })} ·{" "}
                                    {baseQuotaExpiresAt
                                        ? baseQuotaExpired
                                            ? t("userPanels.myMedia.quotaExpiredShort")
                                            : t("userPanels.myMedia.untilDate", { date: new Date(baseQuotaExpiresAt).toLocaleDateString(locale) })
                                        : t("userPanels.myMedia.permanentShort")}
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
                                        ? t("userPanels.myMedia.revokedShort")
                                        : grant.expiresAt
                                          ? grant.isExpired
                                              ? t("userPanels.myMedia.quotaExpiredShort")
                                              : t("userPanels.myMedia.untilDate", { date: new Date(grant.expiresAt).toLocaleDateString(locale) })
                                          : t("userPanels.myMedia.permanentShort")}
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
                            label: t("userPanels.myMedia.tabMedia", { count: total }),
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
                                                options={getMediaModuleOptions(t)}
                                            />
                                            <Select
                                                value={kind}
                                                style={{ width: 120 }}
                                                onChange={(val) => {
                                                    setPage(1);
                                                    setKind(val);
                                                }}
                                                options={[
                                                    { value: "", label: t("userPanels.myMedia.allKinds") },
                                                    { value: "image", label: t("userPanels.mediaKinds.image") },
                                                    { value: "video", label: t("userPanels.mediaKinds.video") },
                                                    { value: "audio", label: t("userPanels.mediaKinds.audio") },
                                                    { value: "file", label: t("userPanels.mediaKinds.file") },
                                                ]}
                                            />
                                            <Input.Search
                                                allowClear
                                                placeholder={t("userPanels.myMedia.searchPath")}
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
                                                    {t("common.batchDownloadCount", { count: selectedMediaIds.length })}
                                                </Button>
                                            ) : null}
                                            <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void loadData()}>
                                                {t("common.refresh")}
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
                                            showTotal: (count) => t("common.totalItems", { count }),
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
                                                title: t("userPanels.myMedia.colPreviewPath"),
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
                                                title: t("userPanels.myMedia.colModule"),
                                                key: "modules",
                                                width: 170,
                                                render: (_, record) => <MediaModuleTags modules={record.modules} />,
                                            },
                                            {
                                                title: t("userPanels.myMedia.colKind"),
                                                dataIndex: "kind",
                                                width: 85,
                                                render: (v: string) => <Tag>{getKindLabel(v, t)}</Tag>,
                                            },
                                            { title: t("userPanels.myMedia.colSize"), dataIndex: "bytes", width: 100, render: (bytes: number) => formatBytes(bytes) },
                                            { title: t("userPanels.myMedia.colUploadedAt"), dataIndex: "createdAt", width: 170, render: (v: string) => new Date(v).toLocaleString(locale) },
                                            {
                                                title: t("userPanels.wallet.colActions"),
                                                key: "actions",
                                                fixed: "right",
                                                width: 100,
                                                render: (_, record) => (
                                                    <TableRowActions
                                                        items={[
                                                            {
                                                                key: "view",
                                                                label: t("common.view"),
                                                                onClick: () => void handleViewMedia(record),
                                                            },
                                                            {
                                                                key: "delete",
                                                                label: t("common.delete"),
                                                                danger: true,
                                                                confirm: t("userPanels.myMedia.confirmDeleteMedia"),
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
                            label: t("userPanels.myMedia.tabCanvas", { count: workspaceStats.canvasProjects }),
                            children: (
                                <Table
                                    rowKey="id"
                                    className={ADMIN_TABLE_CLASS}
                                    scroll={ADMIN_TABLE_SCROLL}
                                    loading={workspaceLoading}
                                    dataSource={cloudProjects}
                                    pagination={{ defaultPageSize: 20, showSizeChanger: true, pageSizeOptions: [10, 20, 30, 50, 100], showTotal: (count) => t("common.totalItems", { count }) }}
                                    columns={[
                                        { title: t("userPanels.myMedia.colCanvasTitle"), dataIndex: "title", width: 240, ellipsis: true },
                                        { title: t("userPanels.myMedia.colNodes"), key: "nodes", width: 85, render: (_, rec) => (Array.isArray(rec.nodes) ? rec.nodes.length : 0) },
                                        { title: t("userPanels.myMedia.colMediaCount"), dataIndex: "mediaCount", width: 95, render: (v?: number) => t("userPanels.myMedia.mediaCountVal", { count: v ?? 0 }) },
                                        { title: t("userPanels.myMedia.colDataSize"), key: "size", width: 150, render: (_, rec) => <WorkspaceSizeCell mediaBytes={rec.mediaBytes} dataBytes={rec.dataBytes} /> },
                                        { title: t("userPanels.myMedia.colLastSync"), dataIndex: "updatedAt", width: 170, render: (v: string) => new Date(v).toLocaleString(locale) },
                                        {
                                            title: t("userPanels.wallet.colActions"),
                                            key: "actions",
                                            fixed: "right",
                                            width: 110,
                                            render: (_, rec) => (
                                                <TableRowActions
                                                    items={[
                                                        { key: "open", label: t("userPanels.myMedia.actionOpen"), onClick: () => navigate(`/canvas/${rec.id}`) },
                                                        {
                                                            key: "delete",
                                                            label: t("common.delete"),
                                                            danger: true,
                                                            confirm: t("userPanels.myMedia.confirmDeleteCanvas"),
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
                                { key: "image_workbench", label: t("userPanels.myMedia.tabImageWorkbench", { count: workspaceStats.imageLogs }), kindType: "image", data: cloudImageLogs },
                                { key: "video_workbench", label: t("userPanels.myMedia.tabVideoWorkbench", { count: workspaceStats.videoLogs }), kindType: "video", data: cloudVideoLogs },
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
                                    pagination={{ defaultPageSize: 20, showSizeChanger: true, pageSizeOptions: [10, 20, 30, 50, 100], showTotal: (count) => t("common.totalItems", { count }) }}
                                    columns={[
                                        {
                                            title: t("userPanels.myMedia.colPromptTitle"),
                                            key: "prompt",
                                            width: 300,
                                            render: (_, rec) => (
                                                <div className="max-w-[280px] truncate" title={rec.prompt || rec.title}>
                                                    {rec.prompt || rec.title || t("userPanels.myMedia.untitledRecord")}
                                                </div>
                                            ),
                                        },
                                        { title: t("userPanels.usageLogs.colModel"), dataIndex: "model", width: 180, ellipsis: true },
                                        {
                                            title: t("userPanels.myMedia.colStatus"),
                                            dataIndex: "status",
                                            width: 85,
                                            render: (st: string) => (
                                                <Tag color={st === "success" ? "green" : st === "failed" ? "red" : "processing"}>
                                                    {st === "success"
                                                        ? t("userPanels.myMedia.statusSuccess")
                                                        : st === "failed"
                                                          ? t("userPanels.myMedia.statusFailed")
                                                          : t("userPanels.myMedia.statusProcessing")}
                                                </Tag>
                                            ),
                                        },
                                        { title: t("userPanels.myMedia.colMediaCount"), dataIndex: "mediaCount", width: 95, render: (v?: number) => t("userPanels.myMedia.mediaCountVal", { count: v ?? 0 }) },
                                        { title: t("userPanels.myMedia.colDataSize"), key: "size", width: 150, render: (_, rec) => <WorkspaceSizeCell mediaBytes={rec.mediaBytes} dataBytes={rec.dataBytes} /> },
                                        { title: t("userPanels.wallet.colTime"), dataIndex: "createdAt", width: 170, render: (v?: number) => (v ? new Date(v).toLocaleString(locale) : "—") },
                                        {
                                            title: t("userPanels.wallet.colActions"),
                                            key: "actions",
                                            fixed: "right",
                                            width: 100,
                                            render: (_, rec) => (
                                                <TableRowActions
                                                    items={[
                                                        {
                                                            key: "open",
                                                            label: t("userPanels.myMedia.actionGo"),
                                                            onClick: () => navigate(tabCfg.kindType === "video" ? "/video" : "/image"),
                                                        },
                                                        {
                                                            key: "delete",
                                                            label: t("common.delete"),
                                                            danger: true,
                                                            confirm: t("userPanels.myMedia.confirmDeleteRecord"),
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
                title={t("userPanels.myMedia.previewModalTitle")}
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
                                {t("common.downloadOriginal")}
                            </Button>
                        ) : null}
                        <Button
                            type="primary"
                            onClick={() => {
                                setPreviewItem(null);
                                setPreviewOriginalUrl("");
                            }}
                        >
                            {t("common.close")}
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
                            {t("common.openFileLink")}
                        </a>
                    )
                ) : null}
            </Modal>
        </div>
    );
}
