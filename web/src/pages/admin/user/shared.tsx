/** 个人后台面板共享的媒体标签、字节单元格与账本格式化组件。 */
import { Space, Tag, Tooltip, Typography } from "antd";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { formatCompactCredits, formatExactCredits } from "@/lib/format-number";
import { getMediaThumbBytes, getMediaTotalBytes } from "@/lib/image-utils";
import type { CreditLedgerItem, CreditLedgerSummary, MediaSourceModule } from "@/services/api/server";
import { formatBytes } from "../admin-utils";

export { formatBytes };

export function getKindLabel(kind: string, t: TFunction) {
    if (kind === "image" || kind === "video" || kind === "audio" || kind === "file") {
        return t(`userPanels.mediaKinds.${kind}`);
    }
    return kind;
}

export function getMediaModuleOptions(t: TFunction): Array<{ value: "" | MediaSourceModule | "standalone"; label: string }> {
    return [
        { value: "", label: t("userPanels.mediaModules.all") },
        { value: "canvas", label: t("userPanels.mediaModules.canvas") },
        { value: "image_workbench", label: t("userPanels.mediaModules.image_workbench") },
        { value: "video_workbench", label: t("userPanels.mediaModules.video_workbench") },
        { value: "assets", label: t("userPanels.mediaModules.assets") },
        { value: "standalone", label: t("userPanels.mediaModules.standalone") },
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

/** 展示云端媒体占用大小（含原文件与缩略图体积明细）。 */
export function MediaSizeCell({ bytes, meta }: { bytes: number; meta?: Record<string, unknown> | null }) {
    const { t } = useTranslation();
    const thumbBytes = getMediaThumbBytes(meta);
    const totalBytes = getMediaTotalBytes(bytes, meta);
    if (thumbBytes <= 0) {
        return <span className="whitespace-nowrap">{formatBytes(bytes)}</span>;
    }
    return (
        <div className="leading-tight">
            <div className="whitespace-nowrap font-medium">{formatBytes(totalBytes)}</div>
            <Typography.Text type="secondary" className="block whitespace-nowrap text-[11px]">
                {t("common.withThumbSummary", { original: formatBytes(bytes), thumb: formatBytes(thumbBytes) })}
            </Typography.Text>
        </div>
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
    invite_rebate: "magenta",
};

export function getLedgerReasonMeta(reason: string, t: TFunction): { label: string; color: string } | undefined {
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

export function getLedgerTaskStatus(record: CreditLedgerItem, t: TFunction) {
    const raw = typeof record.meta?.taskStatus === "string" ? record.meta.taskStatus : "";
    if (raw && raw in taskStatusColors) {
        return { label: t(`userPanels.taskStatuses.${raw}`), color: taskStatusColors[raw] };
    }
    if (record.reason === "refund") {
        return { label: t("userPanels.taskStatuses.refunded"), color: taskStatusColors.refunded };
    }
    return { label: t("userPanels.taskStatuses.completed"), color: taskStatusColors.completed };
}

export function formatDurationSec(ms: number) {
    return `${(ms / 1000).toFixed(2)}s`;
}

/** 根据流式状态与分段耗时计算 `tok/s` 输出速度及 `首字 / 总耗时`、`上游/拿图/云存` 展示文案。 */
export function getLedgerTimingStats(meta: Record<string, unknown> | undefined, t: TFunction) {
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

export function formatLedgerUsageDetail(record: CreditLedgerItem, t: TFunction) {
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
    if (record.reason === "invite_rebate") {
        const inviteeName =
            (typeof meta.inviteeDisplayName === "string" && meta.inviteeDisplayName) ||
            (typeof meta.inviteeUsername === "string" && meta.inviteeUsername) ||
            "";
        if (meta.direction === "clawback") {
            parts.push(
                t("userPanels.usageDetail.inviteClawback", {
                    user: inviteeName ? `@${meta.inviteeUsername || inviteeName}` : "",
                    source: meta.deductedSourceCredits ?? 0,
                    capped: meta.cappedAtZero ? t("userPanels.usageDetail.inviteClawbackCapped") : "",
                }),
            );
        } else if (meta.direction === "earn") {
            parts.push(
                t("userPanels.usageDetail.inviteEarn", {
                    user: inviteeName ? `@${meta.inviteeUsername || inviteeName}` : "",
                    amount: meta.sourceAmount ?? 0,
                    percent: meta.rebatePercent ?? 0,
                }),
            );
        }
    }
    if (typeof meta.detail === "string" && meta.detail) parts.push(meta.detail);
    if (typeof meta.note === "string" && meta.note) parts.push(meta.note);
    return parts.join(" · ") || "—";
}


export const emptyLedgerSummary: CreditLedgerSummary = {
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


export function LedgerDeltaTag({ record, t }: { record: CreditLedgerItem; t: TFunction }) {
    const delta = record.delta;
    const isFailed = record.meta?.taskStatus === "failed" || record.meta?.taskStatus === "failed_refunded";
    const refundedCredits = typeof record.meta?.refundedCredits === "number" && record.meta.refundedCredits > 0 ? record.meta.refundedCredits : 0;
    if (isFailed) {
        const charged = typeof record.meta?.chargedCredits === "number" ? record.meta.chargedCredits : refundedCredits;
        const tip = refundedCredits > 0 ? t("userPanels.wallet.failedRefundTip", { charged, refunded: refundedCredits }) : t("userPanels.wallet.failedNoChargeTip");
        return (
            <Tooltip title={tip}>
                <Tag color="orange" style={{ marginInlineEnd: 0 }}>0</Tag>
            </Tooltip>
        );
    }
    if (refundedCredits > 0) {
        const charged =
            typeof record.meta?.chargedCredits === "number"
                ? record.meta.chargedCredits
                : Math.round((Math.abs(Math.min(0, delta)) + refundedCredits) * 10000) / 10000;
        return (
            <Tooltip title={t("userPanels.wallet.partialRefundTip", { charged, refunded: refundedCredits, net: Math.abs(delta) })}>
                <Tag color={delta === 0 ? "orange" : "volcano"} style={{ marginInlineEnd: 0 }}>
                    {delta === 0 ? "0" : delta}
                </Tag>
            </Tooltip>
        );
    }
    return (
        <Tag color={delta > 0 ? "green" : delta === 0 ? "orange" : "volcano"} style={{ marginInlineEnd: 0 }}>
            {delta > 0 ? `+${delta}` : delta}
        </Tag>
    );
}

