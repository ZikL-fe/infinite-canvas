/** 管理后台系统概览面板：展示全站用户、积分消耗趋势、公告、存储分布与运行状态。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { App, Button, Card, Col, Descriptions, Progress, Row, Statistic, Tag, Tooltip, Typography } from "antd";
import type { TFunction } from "i18next";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatCompactCredits, formatExactCredits } from "@/lib/format-number";
import { formatBytes } from "@/pages/admin/admin-utils";
import { AnnouncementsCard, ConsumptionTrendCard } from "@/pages/admin/user-panels";
import { adminApi, type AdminChannelItem, type AdminOverview, type S3Provider } from "@/services/api/server";
import { useUserStore } from "@/stores/use-user-store";

function getProviderLabel(provider: S3Provider, t: TFunction) {
    return t(`admin.providers.${provider}`);
}

function getKindLabel(kind: string, t: TFunction) {
    if (kind === "image" || kind === "video" || kind === "audio" || kind === "file") {
        return t(`userPanels.mediaKinds.${kind}`);
    }
    return kind;
}

export function AdminOverviewPanel({ onManageAnnouncements }: { onManageAnnouncements: () => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const user = useUserStore((state) => state.user);

    const [overview, setOverview] = useState<AdminOverview | null>(null);
    const [channels, setChannels] = useState<AdminChannelItem[]>([]);
    const [allowRegister, setAllowRegister] = useState(true);
    const [loading, setLoading] = useState(true);
    const [trendLoading, setTrendLoading] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [days, setDays] = useState<7 | 14 | 30>(7);
    const daysRef = useRef(days);
    daysRef.current = days;

    const loadOverview = useCallback(
        async (targetDays = daysRef.current, options?: { trendOnly?: boolean; notifySuccess?: boolean }) => {
            const trendOnly = Boolean(options?.trendOnly);
            if (trendOnly) {
                setTrendLoading(true);
            } else if (options?.notifySuccess) {
                setRefreshing(true);
            } else {
                setLoading(true);
            }
            try {
                if (trendOnly) {
                    setOverview(await adminApi.getOverview(targetDays));
                } else {
                    const [overviewRes, channelsRes, authRes] = await Promise.all([
                        adminApi.getOverview(targetDays),
                        adminApi.getChannelSettings().catch(() => null),
                        adminApi.getAuthSettings().catch(() => null),
                    ]);
                    setOverview(overviewRes);
                    if (channelsRes) setChannels(channelsRes.channels);
                    if (authRes) setAllowRegister(authRes.allowRegister);
                }
                if (options?.notifySuccess) message.success(t("common.refreshed"));
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("admin.messages.loadOverviewFailed"));
            } finally {
                if (trendOnly) {
                    setTrendLoading(false);
                } else {
                    setLoading(false);
                    setRefreshing(false);
                }
            }
        },
        [message, t],
    );

    useEffect(() => {
        void loadOverview(daysRef.current);
    }, [loadOverview]);

    const totalStorageBytes = overview?.totalStorageBytes ?? 0;

    return (
        <div className="flex flex-col gap-5">
            <div className="flex justify-end">
                <Button
                    icon={<RefreshCw className="size-4" />}
                    loading={refreshing}
                    onClick={() => void loadOverview(days, { notifySuccess: true })}
                >
                    {t("common.refresh")}
                </Button>
            </div>
            <Row gutter={[16, 16]}>
                <Col xs={24} sm={12} xl={6}>
                    <Card loading={loading}>
                        <Statistic
                            title={t("admin.overviewTab.totalUsers")}
                            value={overview?.totalUsers ?? 0}
                            suffix={
                                <Typography.Text type="secondary" className="text-xs">
                                    {t("admin.overviewTab.usersSuffix", {
                                        admins: overview?.adminCount ?? 0,
                                        disabled: overview?.disabledUsers ?? 0,
                                    })}
                                </Typography.Text>
                            }
                        />
                    </Card>
                </Col>
                <Col xs={24} sm={12} xl={6}>
                    <Card loading={loading}>
                        <Tooltip title={t("admin.overviewTab.exactCreditsTooltip", { value: formatExactCredits(overview?.totalConsumedCredits ?? 0) })}>
                            <div>
                                <Statistic title={t("admin.overviewTab.totalConsumed")} value={formatCompactCredits(overview?.totalConsumedCredits ?? 0)} />
                            </div>
                        </Tooltip>
                    </Card>
                </Col>
                <Col xs={24} sm={12} xl={6}>
                    <Card loading={loading}>
                        <Tooltip title={t("admin.overviewTab.exactCreditsTooltip", { value: formatExactCredits(overview?.todayConsumedCredits ?? 0) })}>
                            <div>
                                <Statistic title={t("admin.overviewTab.todayConsumed")} value={formatCompactCredits(overview?.todayConsumedCredits ?? 0)} />
                            </div>
                        </Tooltip>
                    </Card>
                </Col>
                <Col xs={24} sm={12} xl={6}>
                    <Card loading={loading}>
                        <Statistic title={t("admin.overviewTab.usedStorage")} value={formatBytes(totalStorageBytes)} />
                    </Card>
                </Col>
            </Row>

            <Row gutter={[16, 16]}>
                <Col xs={24} lg={15}>
                    <ConsumptionTrendCard
                        title={t("admin.overviewTab.trendTitle")}
                        days={days}
                        onDaysChange={(nextDays) => {
                            const next = nextDays as 7 | 14 | 30;
                            setDays(next);
                            void loadOverview(next, { trendOnly: true });
                        }}
                        dailyTrend={overview?.dailyTrend ?? []}
                        topModels={overview?.topModels ?? []}
                        rangeConsumedCredits={overview?.rangeConsumedCredits ?? 0}
                        rangeCalls={overview?.rangeCalls ?? 0}
                        loading={loading || trendLoading}
                    />
                </Col>
                <Col xs={24} lg={9}>
                    <AnnouncementsCard
                        items={overview?.announcements ?? []}
                        loading={loading}
                        extra={
                            <Button type="link" size="small" onClick={onManageAnnouncements}>
                                {t("admin.overviewTab.manageAnnouncements")}
                            </Button>
                        }
                    />
                </Col>
            </Row>

            <Row gutter={[16, 16]}>
                <Col xs={24} sm={12}>
                    <Card loading={loading}>
                        <Statistic title={t("admin.overviewTab.cloudCanvasAssets")} value={`${overview?.canvasProjectCount ?? 0} / ${overview?.assetCount ?? 0}`} />
                    </Card>
                </Col>
                <Col xs={24} sm={12}>
                    <Card loading={loading}>
                        <Statistic title={t("admin.overviewTab.objectMediaCount")} value={overview?.activeMediaCount ?? 0} />
                    </Card>
                </Col>
            </Row>

            <Row gutter={[16, 16]}>
                <Col xs={24} md={12}>
                    <Card title={t("admin.overviewTab.mediaByKindTitle")} loading={loading}>
                        <div className="flex flex-col gap-3">
                            {(overview?.mediaByKind ?? []).length ? (
                                overview!.mediaByKind.map((item) => {
                                    const percent = totalStorageBytes > 0 ? Math.round((item.bytes / totalStorageBytes) * 100) : 0;
                                    return (
                                        <div key={item.kind} className="flex flex-col gap-1">
                                            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                                                <span className="min-w-0">
                                                    {t("admin.overviewTab.kindItemCount", {
                                                        kind: getKindLabel(item.kind, t),
                                                        count: item.count,
                                                    })}
                                                </span>
                                                <Typography.Text type="secondary" className="shrink-0">
                                                    {formatBytes(item.bytes)}
                                                </Typography.Text>
                                            </div>
                                            <Progress percent={percent} size="small" showInfo={false} />
                                        </div>
                                    );
                                })
                            ) : (
                                <Typography.Text type="secondary">{t("admin.overviewTab.noCloudMedia")}</Typography.Text>
                            )}
                        </div>
                    </Card>
                </Col>
                <Col xs={24} md={12}>
                    <Card title={t("admin.overviewTab.topStorageUsersTitle")} loading={loading}>
                        <div className="flex flex-col gap-3">
                            {(overview?.topStorageUsers ?? []).length ? (
                                overview!.topStorageUsers.map((item) => {
                                    const percent = totalStorageBytes > 0 ? Math.round((item.storageUsedBytes / totalStorageBytes) * 100) : 0;
                                    return (
                                        <div key={item.id} className="flex flex-col gap-1">
                                            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                                                <span className="min-w-0 truncate">
                                                    {item.displayName || item.username}{" "}
                                                    <Tag color={item.role === "admin" ? "blue" : "default"}>
                                                        {item.role === "admin" ? t("admin.overviewTab.roleAdminTag") : t("admin.overviewTab.roleUserTag")}
                                                    </Tag>
                                                </span>
                                                <Typography.Text type="secondary" className="shrink-0">
                                                    {formatBytes(item.storageUsedBytes)}
                                                </Typography.Text>
                                            </div>
                                            <Progress percent={percent} size="small" showInfo={false} />
                                        </div>
                                    );
                                })
                            ) : (
                                <Typography.Text type="secondary">{t("admin.overviewTab.noUsersData")}</Typography.Text>
                            )}
                        </div>
                    </Card>
                </Col>
            </Row>

            <Card title={t("admin.overviewTab.runtimeStatusTitle")}>
                <Descriptions column={{ xs: 1, sm: 2 }} bordered size="small">
                    <Descriptions.Item label={t("admin.overviewTab.currentAdminLabel")}>{user?.displayName || user?.username}</Descriptions.Item>
                    <Descriptions.Item label={t("admin.overviewTab.platformChannelsLabel")}>
                        <Tag color={channels.some((ch) => ch.enabled) ? "green" : "orange"}>
                            {t("admin.overviewTab.channelsSummaryTag", {
                                total: channels.length,
                                enabled: channels.filter((ch) => ch.enabled).length,
                            })}
                        </Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label={t("admin.overviewTab.objectStorageStatusLabel")}>
                        {overview?.storageConfigured ? (
                            <Tag color="green">
                                {t("admin.overviewTab.storageConfiguredTag", {
                                    provider: getProviderLabel((overview.storageProvider as S3Provider) || "s3", t),
                                    bucket: overview.storageBucket,
                                })}
                            </Tag>
                        ) : (
                            <Tag color="orange">{t("admin.overviewTab.storageNotConfiguredTag")}</Tag>
                        )}
                    </Descriptions.Item>
                    <Descriptions.Item label={t("admin.overviewTab.registerPolicyLabel")}>
                        <Tag color={allowRegister ? "blue" : "default"}>
                            {allowRegister ? t("admin.overviewTab.registerOpenTag") : t("admin.overviewTab.registerClosedTag")}
                        </Tag>
                    </Descriptions.Item>
                </Descriptions>
            </Card>
        </div>
    );
}
