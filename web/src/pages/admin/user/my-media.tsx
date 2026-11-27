/** 个人云端媒体与工作区数据管理面板（支持缩略图补齐、批量删除与 ZIP 打包下载）。 */
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

import { formatBytes, getKindLabel, getMediaModuleOptions, MediaModuleTags, MediaSizeCell, WorkspaceSizeCell } from "./shared";

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
    const [loading, setLoading] = useState(true);
    const [initialized, setInitialized] = useState(false);
    const [usedBytes, setUsedBytes] = useState(user?.storageUsedBytes ?? 0);
    const [quotaBytes, setQuotaBytes] = useState(user?.storageQuotaBytes ?? 0);
    const [quotaExpiresAt, setQuotaExpiresAt] = useState<string | null>(user?.storageQuotaExpiresAt ?? null);
    const [storageWarningDays, setStorageWarningDays] = useState(user?.storageWarningDays ?? 0);
    const [storageExpiringAt, setStorageExpiringAt] = useState<string | null>(user?.storageExpiringAt ?? null);
    const [storageExpiringBytes, setStorageExpiringBytes] = useState(user?.storageExpiringBytes ?? 0);
    const [storageRemainingAfterExpiryBytes, setStorageRemainingAfterExpiryBytes] = useState<number | null>(
        user?.storageRemainingAfterExpiryBytes ?? null,
    );
    const [storageExpiringWillExceed, setStorageExpiringWillExceed] = useState(Boolean(user?.storageExpiringWillExceed));
    const [storagePermanentBytes, setStoragePermanentBytes] = useState(user?.storagePermanentBytes ?? 0);
    const [storageTimedBytes, setStorageTimedBytes] = useState(user?.storageTimedBytes ?? 0);
    const [storageTimedExpiresAt, setStorageTimedExpiresAt] = useState<string | null>(user?.storageTimedExpiresAt ?? null);
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
    const [deletingMediaId, setDeletingMediaId] = useState<string | null>(null);
    const [selectedMediaIds, setSelectedMediaIds] = useState<string[]>([]);
    const [batchDeleting, setBatchDeleting] = useState(false);
    const { downloading: batchDownloading, downloadZip } = useBatchZipDownload();

    const loadData = useCallback(
        async (notifySuccess = false) => {
            setLoading(true);
            try {
                const [listRes, profileRes] = await Promise.all([
                    storageApi.list({ page, pageSize, q, kind, module: moduleFilter, includeStats: true }),
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
                setStorageWarningDays(profileRes.user.storageWarningDays ?? 0);
                setStorageExpiringAt(profileRes.user.storageExpiringAt ?? null);
                setStorageExpiringBytes(profileRes.user.storageExpiringBytes ?? 0);
                setStorageRemainingAfterExpiryBytes(profileRes.user.storageRemainingAfterExpiryBytes ?? null);
                setStorageExpiringWillExceed(Boolean(profileRes.user.storageExpiringWillExceed));
                setStoragePermanentBytes(profileRes.user.storagePermanentBytes ?? 0);
                setStorageTimedBytes(profileRes.user.storageTimedBytes ?? 0);
                setStorageTimedExpiresAt(profileRes.user.storageTimedExpiresAt ?? null);
                setBaseQuotaBytes(profileRes.storageQuotaDetail?.baseQuotaBytes ?? 0);
                setBaseQuotaExpiresAt(profileRes.storageQuotaDetail?.baseExpiresAt ?? null);
                setStorageGrants(profileRes.storageQuotaDetail?.grants ?? []);
                setUser(profileRes.user);
                if (notifySuccess) message.success(t("common.refreshed"));
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("userPanels.myMedia.loadFailed"));
            } finally {
                setLoading(false);
                setInitialized(true);
            }
        },
        [kind, message, moduleFilter, page, pageSize, q, setUser, t],
    );

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
        if (deletingMediaId) return;
        setDeletingMediaId(mediaId);
        try {
            await storageApi.remove(mediaId);
            await Promise.all([purgeLocalStoredImages([mediaId]), purgeLocalStoredMedia([mediaId])]);
            notifyCloudWorkspaceChanged("all");
            void syncCloudWorkspace();
            message.success(t("userPanels.myMedia.deletedMedia"));
            if (items.length <= 1 && page > 1) {
                setPage((prev) => Math.max(1, prev - 1));
            } else {
                void loadData();
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("common.deleteFailed"));
        } finally {
            setDeletingMediaId(null);
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

    const handleBatchDeleteMedia = async () => {
        if (!selectedMediaIds.length) return;
        setBatchDeleting(true);
        try {
            const res = await storageApi.batchRemove(selectedMediaIds);
            if (res.deletedCount > 0) {
                await Promise.all([purgeLocalStoredImages(selectedMediaIds), purgeLocalStoredMedia(selectedMediaIds)]);
                notifyCloudWorkspaceChanged("all");
                void syncCloudWorkspace();
            }
            if (res.failedCount && res.failedCount > 0) {
                message.warning(
                    `${t("userPanels.myMedia.batchDeletedMedia", { count: res.deletedCount })}（另有 ${res.failedCount} 个文件对象存储删除失败${res.firstError ? `：${res.firstError}` : ""}）`,
                );
            } else {
                message.success(t("userPanels.myMedia.batchDeletedMedia", { count: res.deletedCount }));
            }
            setSelectedMediaIds([]);
            if (res.deletedCount >= items.length && page > 1) {
                setPage((prev) => Math.max(1, prev - 1));
            } else {
                void loadData();
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("common.deleteFailed"));
        } finally {
            setBatchDeleting(false);
        }
    };

    const handleDownloadMedia = async (record: MediaItem) => {
        setDownloadingId(record.id);
        try {
            await storageApi.downloadFile(record);
            message.success(t("common.downloaded"));
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
                            setItems((prev) =>
                                prev.map((it) =>
                                    it.id === record.id
                                        ? {
                                              ...it,
                                              thumbnailUrl: uploaded.thumbnailUrl,
                                              meta: {
                                                  ...(it.meta || {}),
                                                  ...(typeof uploaded.thumbBytes === "number" ? { thumbBytes: uploaded.thumbBytes } : {}),
                                              },
                                          }
                                        : it,
                                ),
                            );
                        }
                        if (typeof uploaded.storageUsedBytes === "number") {
                            setUsedBytes(uploaded.storageUsedBytes);
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
            if (typeof res.storageWarningDays === "number") setStorageWarningDays(res.storageWarningDays);
            setStorageExpiringAt(res.storageExpiringAt ?? null);
            setStorageExpiringBytes(res.storageExpiringBytes ?? 0);
            setStorageRemainingAfterExpiryBytes(res.storageRemainingAfterExpiryBytes ?? null);
            setStorageExpiringWillExceed(Boolean(res.storageExpiringWillExceed));
            setStoragePermanentBytes(res.storagePermanentBytes ?? 0);
            setStorageTimedBytes(res.storageTimedBytes ?? 0);
            setStorageTimedExpiresAt(res.storageTimedExpiresAt ?? null);
            setBaseQuotaBytes(res.baseQuotaBytes);
            setBaseQuotaExpiresAt(res.baseExpiresAt);
            setStorageGrants(res.grants);
            const latestUser = useUserStore.getState().user;
            if (latestUser) {
                setUser({
                    ...latestUser,
                    storageQuotaBytes: res.storageQuotaBytes,
                    storageQuotaExpiresAt: res.storageQuotaExpiresAt,
                    ...(typeof res.storageWarningDays === "number" ? { storageWarningDays: res.storageWarningDays } : {}),
                    ...(res.storageExpiringAt !== undefined ? { storageExpiringAt: res.storageExpiringAt } : {}),
                    ...(typeof res.storageExpiringBytes === "number" ? { storageExpiringBytes: res.storageExpiringBytes } : {}),
                    ...(res.storageRemainingAfterExpiryBytes !== undefined
                        ? { storageRemainingAfterExpiryBytes: res.storageRemainingAfterExpiryBytes }
                        : {}),
                    ...(typeof res.storageExpiringWillExceed === "boolean"
                        ? { storageExpiringWillExceed: res.storageExpiringWillExceed }
                        : {}),
                    ...(typeof res.storagePermanentBytes === "number" ? { storagePermanentBytes: res.storagePermanentBytes } : {}),
                    ...(typeof res.storageTimedBytes === "number" ? { storageTimedBytes: res.storageTimedBytes } : {}),
                    ...(res.storageTimedExpiresAt !== undefined ? { storageTimedExpiresAt: res.storageTimedExpiresAt } : {}),
                });
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("userPanels.wallet.redeemFailed"));
        } finally {
            setRedeemingStorage(false);
        }
    };

    const storageAlert = initialized
        ? resolveStorageAlert({
              usedBytes,
              quotaBytes,
              expiresAt: quotaExpiresAt,
              expiringAt: storageExpiringAt,
              expiringBytes: storageExpiringBytes,
              remainingAfterExpiryBytes: storageRemainingAfterExpiryBytes,
              expiringWillExceed: storageExpiringWillExceed,
              warningDays: storageWarningDays,
          })
        : null;
    const storageAlertCopy = storageAlert ? formatStorageAlertCopy(t, storageAlert, locale) : null;
    const quotaExpired = Boolean(storageAlert?.expired);
    const quotaExceeded = Boolean(storageAlert && (storageAlert.expired || storageAlert.overQuota || quotaBytes <= 0));
    const quotaPercent = quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : 100;
    const baseQuotaExpired = Boolean(baseQuotaExpiresAt && new Date(baseQuotaExpiresAt).getTime() <= Date.now());
    const warnHorizonMs = storageWarningDays > 0 ? Date.now() + storageWarningDays * 86_400_000 : 0;
    const isSoonTimestamp = (ts: string | null | undefined) => {
        if (!ts || warnHorizonMs <= 0) return false;
        const ms = new Date(ts).getTime();
        return ms > Date.now() && ms <= warnHorizonMs;
    };

    return (
        <div className="flex flex-col gap-5">
            {storageAlertCopy && storageAlert ? (
                <Alert
                    type={storageAlert.level === "error" ? "error" : "warning"}
                    showIcon
                    title={storageAlertCopy.title}
                    description={storageAlertCopy.description}
                />
            ) : null}

            <Card
                loading={!initialized && loading}
                title={
                    !initialized && loading
                        ? t("topNav.cloudStorage")
                        : t("userPanels.myMedia.cardTitle", {
                              used: formatBytes(usedBytes),
                              quota: formatBytes(quotaBytes),
                              expiry:
                                  storagePermanentBytes > 0 && storageTimedBytes > 0 && storageTimedExpiresAt
                                      ? ` · ${formatStorageQuotaCaption(
                                            t,
                                            {
                                                permanentBytes: storagePermanentBytes,
                                                timedBytes: storageTimedBytes,
                                                timedExpiresAt: storageTimedExpiresAt,
                                            },
                                            locale,
                                        )}`
                                      : quotaExpiresAt
                                        ? t("userPanels.profile.expiryUntil", { time: new Date(quotaExpiresAt).toLocaleString(locale) })
                                        : t("userPanels.profile.expiryNone"),
                          })
                }
                extra={
                    !initialized && loading ? null : quotaExpired ? (
                        <Tag color="red">{t("userPanels.myMedia.quotaExpiredTag")}</Tag>
                    ) : quotaExceeded ? (
                        <Tag color="red">{t("userPanels.myMedia.quotaFullTag")}</Tag>
                    ) : storageAlert?.expiringSoon ? (
                        <Tag color="orange">
                            {t("userPanels.myMedia.quotaExpiringSoonTag", {
                                days: storageAlert.daysLeft ?? 1,
                                remaining: formatBytes(Math.max(0, quotaBytes - usedBytes)),
                            })}
                        </Tag>
                    ) : (
                        <Tag color="green">{t("userPanels.myMedia.remainingQuotaTag", { remaining: formatBytes(Math.max(0, quotaBytes - usedBytes)) })}</Tag>
                    )
                }
            >
                <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="w-full min-w-0 sm:min-w-[220px] sm:flex-1">
                            <Progress percent={quotaPercent} status={quotaExceeded ? "exception" : "active"} />
                        </div>
                        <Space.Compact className="w-full! sm:w-[340px]!">
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
                                <Tag color={baseQuotaExpired ? "default" : isSoonTimestamp(baseQuotaExpiresAt) ? "orange" : "blue"} style={{ marginInlineEnd: 0 }}>
                                    {t("userPanels.myMedia.baseQuotaTag", { size: formatBytes(baseQuotaBytes) })} ·{" "}
                                    {baseQuotaExpiresAt
                                        ? baseQuotaExpired
                                            ? t("userPanels.myMedia.quotaExpiredShort")
                                            : isSoonTimestamp(baseQuotaExpiresAt)
                                              ? `${t("userPanels.myMedia.untilDate", { date: new Date(baseQuotaExpiresAt).toLocaleDateString(locale) })} (${t("userPanels.myMedia.expiringSoonShort")})`
                                              : t("userPanels.myMedia.untilDate", { date: new Date(baseQuotaExpiresAt).toLocaleDateString(locale) })
                                        : t("userPanels.myMedia.permanentShort")}
                                </Tag>
                            ) : null}
                            {storageGrants.map((grant) => {
                                const grantSoon = grant.isEffective && isSoonTimestamp(grant.expiresAt);
                                return (
                                    <Tag
                                        key={grant.id}
                                        color={grant.isEffective ? (grantSoon ? "orange" : "cyan") : "default"}
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
                                                  : grantSoon
                                                    ? `${t("userPanels.myMedia.untilDate", { date: new Date(grant.expiresAt).toLocaleDateString(locale) })} (${t("userPanels.myMedia.expiringSoonShort")})`
                                                    : t("userPanels.myMedia.untilDate", { date: new Date(grant.expiresAt).toLocaleDateString(locale) })
                                              : t("userPanels.myMedia.permanentShort")}
                                    </Tag>
                                );
                            })}
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
                                        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                                            <Select
                                                value={moduleFilter}
                                                className="min-w-[125px] flex-1 sm:w-[130px]! sm:flex-none"
                                                onChange={(val) => {
                                                    setPage(1);
                                                    setModuleFilter(val);
                                                }}
                                                options={getMediaModuleOptions(t)}
                                            />
                                            <Select
                                                value={kind}
                                                className="min-w-[115px] flex-1 sm:w-[120px]! sm:flex-none"
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
                                                className="w-full! sm:w-[200px]!"
                                                onSearch={(val) => {
                                                    setPage(1);
                                                    setQ(val.trim());
                                                }}
                                            />
                                        </div>
                                        <Space wrap>
                                            {selectedMediaIds.length > 0 ? (
                                                <>
                                                    <Button
                                                        type="primary"
                                                        icon={<Download className="size-4" />}
                                                        loading={batchDownloading}
                                                        disabled={batchDeleting}
                                                        onClick={() => void handleBatchDownloadMedia()}
                                                    >
                                                        {t("common.batchDownloadCount", { count: selectedMediaIds.length })}
                                                    </Button>
                                                    <Popconfirm
                                                        title={t("userPanels.myMedia.confirmBatchDeleteMedia", { count: selectedMediaIds.length })}
                                                        onConfirm={() => void handleBatchDeleteMedia()}
                                                        okText={t("common.delete")}
                                                        okButtonProps={{ danger: true }}
                                                    >
                                                        <Button
                                                            danger
                                                            icon={<Trash2 className="size-4" />}
                                                            loading={batchDeleting}
                                                            disabled={batchDownloading}
                                                        >
                                                            {t("common.batchDeleteCount", { count: selectedMediaIds.length })}
                                                        </Button>
                                                    </Popconfirm>
                                                </>
                                            ) : null}
                                            <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void loadData(true)}>
                                                {t("common.refresh")}
                                            </Button>
                                        </Space>
                                    </div>
                                    <Table<MediaItem>
                                        rowKey="id"
                                        size="small"
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
                                                title: t("userPanels.myMedia.colPreview"),
                                                key: "preview",
                                                width: 72,
                                                render: (_, record) => {
                                                    const thumb = record.thumbnailUrl || previewUrlFor(record.id) || "";
                                                    return thumb ? (
                                                        <img src={thumb} alt={record.mimeType} className="size-8 shrink-0 rounded object-cover" />
                                                    ) : (
                                                        <div className="flex size-8 shrink-0 items-center justify-center rounded bg-black/5 text-stone-400 dark:bg-white/10">
                                                            {record.kind === "video" ? <Video className="size-4" /> : record.kind === "audio" ? <AudioLines className="size-4" /> : record.kind === "image" ? <ImageIcon className="size-4" /> : <FileIcon className="size-4" />}
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
                                                dataIndex: "mimeType",
                                                width: 130,
                                                render: (mimeType: string, record: MediaItem) => (
                                                    <Tag style={{ marginInlineEnd: 0 }}>{mimeType || getKindLabel(record.kind, t)}</Tag>
                                                ),
                                            },
                                            {
                                                title: t("userPanels.myMedia.colSize"),
                                                dataIndex: "bytes",
                                                width: 105,
                                                render: (bytes: number) => <span className="whitespace-nowrap">{formatBytes(bytes)}</span>,
                                            },
                                            {
                                                title: t("userPanels.myMedia.colThumbSize"),
                                                key: "thumbBytes",
                                                width: 115,
                                                render: (_, record: MediaItem) => {
                                                    const thumbBytes = getMediaThumbBytes(record.meta);
                                                    return <span className="whitespace-nowrap">{thumbBytes > 0 ? formatBytes(thumbBytes) : "—"}</span>;
                                                },
                                            },
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
                                                                loading: deletingMediaId === record.id,
                                                                disabled: Boolean(deletingMediaId && deletingMediaId !== record.id),
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
                                    size="small"
                                    className={ADMIN_TABLE_CLASS}
                                    scroll={ADMIN_TABLE_SCROLL}
                                    loading={workspaceLoading}
                                    dataSource={cloudProjects}
                                    pagination={{ defaultPageSize: 20, showSizeChanger: true, pageSizeOptions: [10, 20, 30, 50, 100], showTotal: (count) => t("common.totalItems", { count }) }}
                                    columns={[
                                        { title: t("userPanels.myMedia.colCanvasTitle"), dataIndex: "title", width: 240, ellipsis: true },
                                        { title: t("userPanels.myMedia.colNodes"), key: "nodes", width: 85, render: (_, rec) => (Array.isArray(rec.nodes) ? rec.nodes.length : 0) },
                                        { title: t("userPanels.myMedia.colMediaCount"), dataIndex: "mediaCount", width: 95, render: (v?: number) => t("userPanels.myMedia.mediaCountVal", { count: v ?? 0 }) },
                                        { title: t("userPanels.myMedia.colDataSize"), key: "size", width: 145, render: (_, rec) => <WorkspaceSizeCell mediaBytes={rec.mediaBytes} dataBytes={rec.dataBytes} /> },
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
                                    size="small"
                                    className={ADMIN_TABLE_CLASS}
                                    scroll={ADMIN_TABLE_SCROLL}
                                    loading={workspaceLoading}
                                    dataSource={tabCfg.data}
                                    pagination={{ defaultPageSize: 20, showSizeChanger: true, pageSizeOptions: [10, 20, 30, 50, 100], showTotal: (count) => t("common.totalItems", { count }) }}
                                    columns={[
                                        {
                                            title: t("userPanels.myMedia.colPromptTitle"),
                                            key: "prompt",
                                            width: 280,
                                            render: (_, rec) => (
                                                <div className="max-w-[265px] truncate" title={rec.prompt || rec.title}>
                                                    {rec.prompt || rec.title || t("userPanels.myMedia.untitledRecord")}
                                                </div>
                                            ),
                                        },
                                        { title: t("userPanels.usageLogs.colModel"), dataIndex: "model", width: 170, ellipsis: true },
                                        {
                                            title: t("userPanels.myMedia.colStatus"),
                                            dataIndex: "status",
                                            width: 85,
                                            render: (st: string) => (
                                                <Tag color={st === "success" ? "green" : st === "failed" ? "red" : "processing"} style={{ marginInlineEnd: 0 }}>
                                                    {st === "success"
                                                        ? t("userPanels.myMedia.statusSuccess")
                                                        : st === "failed"
                                                          ? t("userPanels.myMedia.statusFailed")
                                                          : t("userPanels.myMedia.statusProcessing")}
                                                </Tag>
                                            ),
                                        },
                                        { title: t("userPanels.myMedia.colMediaCount"), dataIndex: "mediaCount", width: 95, render: (v?: number) => t("userPanels.myMedia.mediaCountVal", { count: v ?? 0 }) },
                                        { title: t("userPanels.myMedia.colDataSize"), key: "size", width: 145, render: (_, rec) => <WorkspaceSizeCell mediaBytes={rec.mediaBytes} dataBytes={rec.dataBytes} /> },
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
