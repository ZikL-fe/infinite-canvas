/** 消费账本详情弹窗：展示请求参数、模型耗时、产物预览与原文件下载。 */
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

import { formatBytes, formatDurationSec, getKindLabel, getLedgerReasonMeta, getLedgerTaskStatus, getLedgerTimingStats, LedgerDeltaTag, MediaSizeCell } from "./shared";

export function LedgerDetailModal({
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
            message.success(t("common.downloaded"));
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
                        <div className="flex flex-wrap items-baseline gap-2.5">
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
                                <div className="grid grid-cols-1 gap-2.5">
                                    {mediaItems.map((media) => {
                                        const thumb = media.thumbnailUrl || previewUrlFor(media.id) || "";
                                        const fileLabel = mediaDownloadFilename(media);
                                        const isLoadingPreview = loadingPreviewId === media.id;
                                        return (
                                            <div
                                                key={media.id}
                                                className="flex flex-wrap items-center gap-3 rounded-lg border p-2.5"
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
                                                        <MediaSizeCell bytes={media.bytes} meta={media.meta} />
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

/** 展示积分变动标签（单列独立展示，保持行高紧凑）。 */
