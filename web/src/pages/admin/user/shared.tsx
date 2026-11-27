/** 个人后台面板共享的媒体标签、字节单元格与账本格式化组件。 */
import { useRef, useState } from "react";
import { Button, DatePicker, Popover, Space, Tag, Tooltip, Typography, theme as antdTheme } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import type { TFunction } from "i18next";
import { Calendar, X } from "lucide-react";
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

export type DateTimeRangeValue = [Dayjs | null, Dayjs | null] | null;

type DateTimePresetKey = "today" | "last7Days" | "thisWeek" | "last30Days" | "thisMonth";

export function buildDateTimePresetRange(key: DateTimePresetKey): [Dayjs, Dayjs] {
    const now = dayjs();
    if (key === "today") return [now.startOf("day"), now.endOf("day")];
    if (key === "last7Days") return [now.subtract(6, "day").startOf("day"), now.endOf("day")];
    if (key === "thisWeek") {
        const monday = now.subtract((now.day() + 6) % 7, "day").startOf("day");
        return [monday, monday.add(6, "day").endOf("day")];
    }
    if (key === "last30Days") return [now.subtract(29, "day").startOf("day"), now.endOf("day")];
    return [now.startOf("month"), now.endOf("month")];
}

const PRESET_KEYS: DateTimePresetKey[] = ["today", "last7Days", "thisWeek", "last30Days", "thisMonth"];

function matchDateTimePreset(start: Dayjs | null, end: Dayjs | null): DateTimePresetKey | null {
    if (!start || !end) return null;
    for (const key of PRESET_KEYS) {
        const [pStart, pEnd] = buildDateTimePresetRange(key);
        if (start.isSame(pStart, "second") && end.isSame(pEnd, "second")) return key;
    }
    return null;
}

/** 支持时分秒选择与常用时间段快捷按钮的日期时间范围筛选器。 */
export function DateTimeRangePicker({
    value,
    onChange,
    className,
}: {
    value: DateTimeRangeValue;
    onChange: (value: DateTimeRangeValue) => void;
    className?: string;
}) {
    const { t } = useTranslation();
    const { token } = antdTheme.useToken();
    const [open, setOpen] = useState(false);
    const [draftStart, setDraftStart] = useState<Dayjs | null>(value?.[0] ?? null);
    const [draftEnd, setDraftEnd] = useState<Dayjs | null>(value?.[1] ?? null);
    const [activePreset, setActivePreset] = useState<DateTimePresetKey | null>(() => matchDateTimePreset(value?.[0] ?? null, value?.[1] ?? null));
    const panelRef = useRef<HTMLDivElement>(null);

    const hasValue = Boolean(value?.[0] && value?.[1]);
    const displayText = hasValue
        ? `${value![0]!.format("YYYY-MM-DD HH:mm:ss")} ~ ${value![1]!.format("YYYY-MM-DD HH:mm:ss")}`
        : `${t("userPanels.wallet.startDate")} ~ ${t("userPanels.wallet.endDate")}`;

    const handleOpenChange = (nextOpen: boolean) => {
        if (nextOpen) {
            const nextStart = value?.[0] ?? null;
            const nextEnd = value?.[1] ?? null;
            setDraftStart(nextStart);
            setDraftEnd(nextEnd);
            setActivePreset(matchDateTimePreset(nextStart, nextEnd));
        }
        setOpen(nextOpen);
    };

    const applyPreset = (key: DateTimePresetKey) => {
        const [start, end] = buildDateTimePresetRange(key);
        setDraftStart(start);
        setDraftEnd(end);
        setActivePreset(key);
    };

    const handleConfirm = () => {
        if (!draftStart && !draftEnd) {
            onChange(null);
            setOpen(false);
            return;
        }
        let start = draftStart || draftEnd!.startOf("day");
        let end = draftEnd || draftStart!.endOf("day");
        if (start.isAfter(end)) [start, end] = [end, start];
        onChange([start, end]);
        setOpen(false);
    };

    const handleClear = () => {
        setDraftStart(null);
        setDraftEnd(null);
        setActivePreset(null);
        onChange(null);
        setOpen(false);
    };

    const presets: Array<{ key: DateTimePresetKey; label: string }> = [
        { key: "today", label: t("userPanels.usageLogs.presetToday") },
        { key: "last7Days", label: t("userPanels.usageLogs.preset7Days") },
        { key: "thisWeek", label: t("userPanels.usageLogs.presetThisWeek") },
        { key: "last30Days", label: t("userPanels.usageLogs.preset30Days") },
        { key: "thisMonth", label: t("userPanels.usageLogs.presetThisMonth") },
    ];

    const content = (
        <div ref={panelRef} className="w-[420px] max-w-[calc(100vw-32px)] p-1">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
                <div className="min-w-0">
                    <Typography.Text type="secondary" className="mb-1 block text-xs">
                        {t("userPanels.usageLogs.startTimeLabel")}
                    </Typography.Text>
                    <DatePicker
                        showTime={{ format: "HH:mm:ss" }}
                        format="YYYY/MM/DD HH:mm:ss"
                        needConfirm={false}
                        allowClear={false}
                        value={draftStart}
                        placeholder={t("userPanels.wallet.startDate")}
                        getPopupContainer={() => panelRef.current || document.body}
                        className="w-full"
                        onChange={(val) => {
                            setDraftStart(val);
                            setActivePreset(null);
                        }}
                    />
                </div>
                <span className="hidden pb-1.5 text-center text-xs opacity-50 sm:inline">~</span>
                <div className="min-w-0">
                    <Typography.Text type="secondary" className="mb-1 block text-xs">
                        {t("userPanels.usageLogs.endTimeLabel")}
                    </Typography.Text>
                    <DatePicker
                        showTime={{ format: "HH:mm:ss" }}
                        format="YYYY/MM/DD HH:mm:ss"
                        needConfirm={false}
                        allowClear={false}
                        value={draftEnd}
                        placeholder={t("userPanels.wallet.endDate")}
                        getPopupContainer={() => panelRef.current || document.body}
                        className="w-full"
                        onChange={(val) => {
                            setDraftEnd(val);
                            setActivePreset(null);
                        }}
                    />
                </div>
            </div>

            <div className="mt-3 grid grid-cols-5 gap-1.5">
                {presets.map((preset) => (
                    <Button
                        key={preset.key}
                        size="small"
                        type={activePreset === preset.key ? "primary" : "default"}
                        className="px-1!"
                        onClick={() => applyPreset(preset.key)}
                    >
                        {preset.label}
                    </Button>
                ))}
            </div>

            <div className="mt-3 flex items-center justify-end gap-2">
                {draftStart || draftEnd ? (
                    <Button size="small" onClick={handleClear}>
                        {t("common.clear")}
                    </Button>
                ) : null}
                <Button size="small" type="primary" onClick={handleConfirm}>
                    {t("userPanels.usageLogs.confirmRange")}
                </Button>
            </div>
        </div>
    );

    return (
        <Popover open={open} onOpenChange={handleOpenChange} trigger="click" placement="bottomLeft" content={content}>
            <div
                role="button"
                tabIndex={0}
                title={displayText}
                onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        handleOpenChange(!open);
                    }
                }}
                style={{
                    backgroundColor: token.colorBgContainer,
                    borderColor: open ? token.colorPrimary : token.colorBorder,
                    borderRadius: token.borderRadius,
                    color: hasValue ? token.colorText : token.colorTextPlaceholder,
                }}
                className={`inline-flex h-8 max-w-full cursor-pointer items-center gap-2 border px-2.5 text-sm transition-colors select-none ${className || "w-full sm:w-auto"}`}
            >
                <Calendar className="size-3.5 shrink-0 opacity-60" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{displayText}</span>
                {hasValue ? (
                    <span
                        role="button"
                        aria-label={t("common.clear")}
                        className="inline-flex size-4 shrink-0 items-center justify-center rounded-full opacity-55 transition-opacity hover:opacity-100"
                        onClick={(event) => {
                            event.stopPropagation();
                            handleClear();
                        }}
                    >
                        <X className="size-3" />
                    </span>
                ) : null}
            </div>
        </Popover>
    );
}

