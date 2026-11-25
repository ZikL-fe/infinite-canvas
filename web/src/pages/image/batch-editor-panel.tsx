/** 生图工作台批量编辑器面板：场景化引导（多图同词 / 一图多词 / 自由队列），所见即所得免多余同步点击。 */
import { useRef, useState } from "react";
import { Alert, App, Button, Input, InputNumber, Segmented, Tag, Tooltip } from "antd";
import { ArrowLeft, ArrowRight, BookOpen, ClipboardPaste, Copy, Eraser, FolderPlus, Plus, SlidersHorizontal, Trash2, Upload } from "lucide-react";
import { nanoid } from "nanoid";
import { Trans, useTranslation } from "react-i18next";

import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { previewUrlFor, uploadImage } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";
import {
    MAX_BATCH_CONCURRENCY,
    MAX_BATCH_IMAGES,
    MAX_SAME_PROMPT_SLOTS,
    appendSequentialSlotImages,
    createEmptyBatchItem,
    getDenseReferences,
    type BatchScenario,
    type BatchTaskItem,
    type PromptSplitMode,
    type SamePromptRefMode,
} from "./batch-utils";

type BatchEditorPanelProps = {
    scenario: BatchScenario;
    onScenarioChange: (value: BatchScenario) => void;
    concurrency: number;
    onConcurrencyChange: (value: number) => void;
    // 场景 1：多图同词
    sharedPrompt: string;
    onSharedPromptChange: (value: string) => void;
    samePromptRefMode: SamePromptRefMode;
    onSamePromptRefModeChange: (mode: SamePromptRefMode) => void;
    samePromptSlots: ReferenceImage[][];
    onSamePromptSlotsChange: (updater: (prev: ReferenceImage[][]) => ReferenceImage[][]) => void;
    samePromptMismatchError: string | null;
    // 场景 2：一图多词
    sharedRefs: ReferenceImage[];
    onSharedRefsChange: (updater: (prev: ReferenceImage[]) => ReferenceImage[]) => void;
    multiPromptRaw: string;
    onMultiPromptRawChange: (value: string) => void;
    splitMode: PromptSplitMode;
    onSplitModeChange: (mode: PromptSplitMode) => void;
    // 场景 3：自由队列
    customItems: BatchTaskItem[];
    onCustomItemsChange: (updater: (prev: BatchTaskItem[]) => BatchTaskItem[]) => void;
    onConvertToCustom: () => void;
    previewTaskCount: number;
    running: boolean;
    onOpenPromptDialog: (target: "same-prompt" | "multi-prompt") => void;
    onOpenAssetPicker: (target: { mode: "same-prompt-text" } | { mode: "same-sequential" } | { mode: "same-slot"; slotIndex: number } | { mode: "multi-ref" } | { mode: "custom-item"; itemId: string }) => void;
};

function moveItem<T>(items: T[], index: number, offset: number) {
    const target = index + offset;
    if (target < 0 || target >= items.length) return items;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
}

function ImageDropBox({
    title,
    hint,
    images,
    emptyText,
    disabled,
    canRemoveBox,
    onRemoveBox,
    onAddFiles,
    onPaste,
    onPickAsset,
    onMove,
    onRemoveImage,
    onClearImages,
    showOrdinal,
}: {
    title: React.ReactNode;
    hint?: React.ReactNode;
    images: ReferenceImage[];
    emptyText: string;
    disabled: boolean;
    canRemoveBox?: boolean;
    onRemoveBox?: () => void;
    onAddFiles: (files: FileList | null) => Promise<void>;
    onPaste: () => Promise<void>;
    onPickAsset: () => void;
    onMove: (index: number, offset: number) => void;
    onRemoveImage: (id: string) => void;
    onClearImages?: () => void;
    showOrdinal?: boolean;
}) {
    const { t } = useTranslation();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dragDepthRef = useRef(0);
    const [dragActive, setDragActive] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [pasting, setPasting] = useState(false);

    const handleFiles = async (files: FileList | null) => {
        if (!files?.length || disabled) return;
        setUploading(true);
        try {
            await onAddFiles(files);
        } finally {
            setUploading(false);
        }
    };

    const handlePasteClick = async () => {
        if (disabled) return;
        setPasting(true);
        try {
            await onPaste();
        } finally {
            setPasting(false);
        }
    };

    return (
        <div className="rounded-lg border border-stone-200 p-2.5 dark:border-stone-800">
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">{title}</div>
                <div className="flex flex-wrap items-center gap-1">
                    <Button size="small" icon={<Upload className="size-3.5" />} loading={uploading} disabled={disabled} onClick={() => fileInputRef.current?.click()}>
                        {t("common.upload")}
                    </Button>
                    <Button size="small" icon={<ClipboardPaste className="size-3.5" />} loading={pasting} disabled={disabled} onClick={() => void handlePasteClick()}>
                        {t("common.paste")}
                    </Button>
                    <Button size="small" icon={<FolderPlus className="size-3.5" />} disabled={disabled} onClick={onPickAsset}>
                        {t("imageBatch.assetsBtn")}
                    </Button>
                    {images.length && onClearImages ? (
                        <Button size="small" type="text" danger icon={<Eraser className="size-3.5" />} disabled={disabled} onClick={onClearImages}>
                            {t("common.clear")}
                        </Button>
                    ) : null}
                    {canRemoveBox && onRemoveBox ? (
                        <Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} disabled={disabled} onClick={onRemoveBox} />
                    ) : null}
                </div>
            </div>

            {hint ? <div className="mb-2 text-xs text-stone-500 dark:text-stone-400">{hint}</div> : null}

            <div
                className={`hover-scrollbar flex min-h-20 w-full gap-2 overflow-x-auto rounded-md border border-dashed p-2 transition-colors ${dragActive ? "border-stone-900 bg-stone-100/80 dark:border-stone-100 dark:bg-stone-900/80" : "border-stone-300 dark:border-stone-700"}`}
                onDragEnter={(event) => {
                    event.preventDefault();
                    dragDepthRef.current += 1;
                    if (event.dataTransfer.types.includes("Files")) setDragActive(true);
                }}
                onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                }}
                onDragLeave={(event) => {
                    event.preventDefault();
                    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
                    if (!dragDepthRef.current) setDragActive(false);
                }}
                onDrop={(event) => {
                    event.preventDefault();
                    dragDepthRef.current = 0;
                    setDragActive(false);
                    void handleFiles(event.dataTransfer.files);
                }}
            >
                {images.map((item, idx) => (
                    <div key={item.id} className="group relative size-16 shrink-0 overflow-hidden rounded border border-stone-200 dark:border-stone-700">
                        <img src={previewUrlFor(item.storageKey) || item.dataUrl} alt={item.name} className="size-full object-cover" />
                        <span className="absolute left-0.5 top-0.5 rounded bg-black/65 px-1 text-[10px] font-medium text-white">
                            {showOrdinal ? `#${idx + 1}` : imageReferenceLabel(idx)}
                        </span>
                        {images.length > 1 && !disabled ? (
                            <div className="absolute inset-x-0.5 bottom-0.5 hidden justify-between group-hover:flex">
                                <Button
                                    size="small"
                                    className="!h-5 !w-5 !min-w-5 !rounded-full !bg-white/85 !p-0 !text-stone-700 hover:!text-stone-950 disabled:!text-stone-400 dark:!bg-stone-900/85 dark:!text-stone-200 dark:hover:!text-white dark:disabled:!text-stone-600"
                                    icon={<ArrowLeft className="size-3" />}
                                    disabled={idx <= 0}
                                    onClick={() => onMove(idx, -1)}
                                />
                                <Button
                                    size="small"
                                    className="!h-5 !w-5 !min-w-5 !rounded-full !bg-white/85 !p-0 !text-stone-700 hover:!text-stone-950 disabled:!text-stone-400 dark:!bg-stone-900/85 dark:!text-stone-200 dark:hover:!text-white dark:disabled:!text-stone-600"
                                    icon={<ArrowRight className="size-3" />}
                                    disabled={idx >= images.length - 1}
                                    onClick={() => onMove(idx, 1)}
                                />
                            </div>
                        ) : null}
                        {!disabled ? (
                            <button
                                type="button"
                                className="absolute right-0.5 top-0.5 hidden size-5 items-center justify-center rounded bg-black/65 text-white group-hover:flex"
                                onClick={() => onRemoveImage(item.id)}
                                aria-label={t("imageWorkbench.removeReference")}
                            >
                                <Trash2 className="size-3" />
                            </button>
                        ) : null}
                    </div>
                ))}
                {!images.length ? (
                    <div className="flex min-w-full items-center justify-center text-center text-xs text-stone-500">
                        {dragActive ? t("imageBatch.dropToBatchAdd") : emptyText}
                    </div>
                ) : null}
            </div>

            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    void handleFiles(event.target.files);
                    event.target.value = "";
                }}
            />
        </div>
    );
}

export function BatchEditorPanel({
    scenario,
    onScenarioChange,
    concurrency,
    onConcurrencyChange,
    sharedPrompt,
    onSharedPromptChange,
    samePromptRefMode,
    onSamePromptRefModeChange,
    samePromptSlots,
    onSamePromptSlotsChange,
    samePromptMismatchError,
    sharedRefs,
    onSharedRefsChange,
    multiPromptRaw,
    onMultiPromptRawChange,
    splitMode,
    onSplitModeChange,
    customItems,
    onCustomItemsChange,
    onConvertToCustom,
    previewTaskCount,
    running,
    onOpenPromptDialog,
    onOpenAssetPicker,
}: BatchEditorPanelProps) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const itemFileInputRef = useRef<HTMLInputElement>(null);
    const uploadTargetItemIdRef = useRef<string | null>(null);
    const [uploadingItemId, setUploadingItemId] = useState<string | null>(null);

    const readUploadedFiles = async (files?: FileList | null): Promise<ReferenceImage[]> => {
        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        if (!imageFiles.length) return [];
        try {
            return await Promise.all(
                imageFiles.map(async (file) => {
                    const image = await uploadImage(file);
                    return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("common.imageReadFailed"));
            return [];
        }
    };

    const readClipboardImages = async (): Promise<ReferenceImage[]> => {
        try {
            const clipItems = await navigator.clipboard.read();
            const blobs = await Promise.all(
                clipItems.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))),
            );
            if (!blobs.length) {
                message.error(t("imageBatch.clipboardEmpty"));
                return [];
            }
            const uploaded = await Promise.all(
                blobs.map(async (blob, index) => {
                    const image = await uploadImage(blob);
                    return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            message.success(t("imageBatch.clipboardAdded", { count: uploaded.length }));
            return uploaded;
        } catch {
            message.error(t("imageBatch.clipboardUnavailable"));
            return [];
        }
    };

    const appendSamePromptSequential = (incoming: ReferenceImage[]) => {
        if (!incoming.length) return;
        const { nextSlots, overflowCount } = appendSequentialSlotImages(samePromptSlots, incoming, MAX_SAME_PROMPT_SLOTS);
        if (overflowCount > 0) {
            message.warning(t("imageBatch.slotLimitWarning", { max: MAX_SAME_PROMPT_SLOTS }));
        }
        onSamePromptSlotsChange(() => nextSlots);
    };

    const handleUploadToCustomItem = async (itemId: string, files?: FileList | null) => {
        setUploadingItemId(itemId);
        try {
            const uploaded = await readUploadedFiles(files);
            if (!uploaded.length) return;
            onCustomItemsChange((prev) =>
                prev.map((item) => (item.id === itemId ? { ...item, references: [...item.references, ...uploaded] } : item)),
            );
        } finally {
            setUploadingItemId(null);
        }
    };

    return (
        <div className="space-y-4">
            <div className="space-y-2 rounded-lg border border-stone-200 bg-stone-50/80 p-3 dark:border-stone-800 dark:bg-stone-900/60">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-stone-700 dark:text-stone-300">{t("imageBatch.chooseMode")}</span>
                    <div className="flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                        <span>{t("imageBatch.concurrency")}</span>
                        <InputNumber
                            size="small"
                            min={1}
                            max={MAX_BATCH_CONCURRENCY}
                            value={concurrency}
                            disabled={running}
                            onChange={(val) => onConcurrencyChange(Math.max(1, Math.min(MAX_BATCH_CONCURRENCY, Number(val) || 3)))}
                            style={{ width: 58 }}
                        />
                        <span>{t("imageBatch.maxImagesLimit", { max: MAX_BATCH_IMAGES })}</span>
                    </div>
                </div>
                <Segmented
                    block
                    disabled={running}
                    value={scenario}
                    onChange={(val) => onScenarioChange(val as BatchScenario)}
                    options={[
                        { label: t("imageBatch.scenarios.samePrompt"), value: "same-prompt" },
                        { label: t("imageBatch.scenarios.multiPrompt"), value: "multi-prompt" },
                        { label: t("imageBatch.scenarios.custom"), value: "custom" },
                    ]}
                />
                <div className="text-xs leading-5 text-stone-500 dark:text-stone-400">{t(`imageBatch.scenarioDescriptions.${scenario}`)}</div>
            </div>

            {scenario === "same-prompt" ? (
                <div className="space-y-4">
                    <div>
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                            <span className="text-sm font-semibold">{t("imageBatch.step1SharedPrompt")}</span>
                            <div className="flex gap-1.5">
                                <Button size="small" icon={<BookOpen className="size-3.5" />} disabled={running} onClick={() => onOpenPromptDialog("same-prompt")}>
                                    {t("imageBatch.promptLibrary")}
                                </Button>
                                <Button size="small" icon={<FolderPlus className="size-3.5" />} disabled={running} onClick={() => onOpenAssetPicker({ mode: "same-prompt-text" })}>
                                    {t("imageBatch.assetsBtn")}
                                </Button>
                            </div>
                        </div>
                        <Input.TextArea
                            value={sharedPrompt}
                            onChange={(e) => onSharedPromptChange(e.target.value)}
                            rows={4}
                            disabled={running}
                            placeholder={t("imageBatch.sharedPromptPlaceholder")}
                        />
                    </div>

                    <div className="space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-sm font-semibold">{t("imageBatch.step2BatchRefs")}</span>
                            <div className="flex flex-wrap items-center gap-1.5">
                                <Segmented
                                    size="small"
                                    disabled={running}
                                    value={samePromptRefMode}
                                    onChange={(val) => onSamePromptRefModeChange(val as SamePromptRefMode)}
                                    options={[
                                        { label: t("imageBatch.samePromptRefModes.sequential"), value: "sequential" },
                                        { label: t("imageBatch.samePromptRefModes.paired"), value: "paired" },
                                    ]}
                                />
                                {samePromptRefMode === "paired" ? (
                                    <Button
                                        size="small"
                                        type="dashed"
                                        icon={<Plus className="size-3.5" />}
                                        disabled={running || samePromptSlots.length >= MAX_SAME_PROMPT_SLOTS}
                                        onClick={() => onSamePromptSlotsChange((prev) => [...prev, []])}
                                    >
                                        {t("imageBatch.addImageSlot", { index: samePromptSlots.length + 1 })}
                                    </Button>
                                ) : null}
                            </div>
                        </div>

                        {samePromptRefMode === "sequential" && samePromptSlots.every((list) => list.length <= 1) ? (
                            (() => {
                                const sequentialImages = samePromptSlots
                                    .map((list) => list[0])
                                    .filter((img): img is ReferenceImage => Boolean(img));
                                return (
                                    <ImageDropBox
                                        title={
                                            <>
                                                <span className="text-xs font-semibold">{t("imageBatch.sequentialRefsTitle")}</span>
                                                <Tag color="blue" className="m-0">
                                                    {t("imageBatch.sequentialSlotsCount", {
                                                        count: sequentialImages.length,
                                                        max: MAX_SAME_PROMPT_SLOTS,
                                                    })}
                                                </Tag>
                                            </>
                                        }
                                        hint={t("imageBatch.sequentialHint")}
                                        images={sequentialImages}
                                        emptyText={t("imageBatch.sequentialEmptyText")}
                                        disabled={running}
                                        onAddFiles={async (files) => appendSamePromptSequential(await readUploadedFiles(files))}
                                        onPaste={async () => appendSamePromptSequential(await readClipboardImages())}
                                        onPickAsset={() => onOpenAssetPicker({ mode: "same-sequential" })}
                                        onMove={(imgIdx, offset) =>
                                            onSamePromptSlotsChange((prev) => {
                                                const compacted = prev
                                                    .map((list) => list[0])
                                                    .filter((img): img is ReferenceImage => Boolean(img));
                                                const moved = moveItem(compacted, imgIdx, offset);
                                                return moved.length > 0 ? moved.map((img) => [img]) : [[]];
                                            })
                                        }
                                        onRemoveImage={(id) =>
                                            onSamePromptSlotsChange((prev) => {
                                                const remaining = prev
                                                    .map((list) => list[0])
                                                    .filter((img): img is ReferenceImage => Boolean(img) && img.id !== id);
                                                return remaining.length > 0 ? remaining.map((img) => [img]) : [[]];
                                            })
                                        }
                                        onClearImages={() => onSamePromptSlotsChange(() => [[]])}
                                    />
                                );
                            })()
                        ) : (
                            samePromptSlots.map((slotImages, slotIndex) => (
                                <ImageDropBox
                                    key={slotIndex}
                                    title={
                                        <>
                                            <Tag color="blue" className="m-0">
                                                {imageReferenceLabel(slotIndex)}
                                            </Tag>
                                            <span className="text-xs font-semibold">{t("imageBatch.refSlotTitle", { index: slotIndex + 1 })}</span>
                                            <Tag className="m-0">
                                                {slotImages.length === 1 && previewTaskCount > 1 ? t("imageBatch.slotCountFixed") : t("imageBatch.slotCount", { count: slotImages.length })}
                                            </Tag>
                                        </>
                                    }
                                    hint={
                                        slotIndex === 0
                                            ? t("imageBatch.slot1Hint")
                                            : t("imageBatch.slotOtherHint")
                                    }
                                    images={slotImages}
                                    showOrdinal
                                    emptyText={t("imageBatch.slotEmptyText", { label: imageReferenceLabel(slotIndex) })}
                                    disabled={running}
                                    canRemoveBox={samePromptSlots.length > 1}
                                    onRemoveBox={() => onSamePromptSlotsChange((prev) => prev.filter((_, idx) => idx !== slotIndex))}
                                    onAddFiles={async (files) => {
                                        const uploaded = await readUploadedFiles(files);
                                        if (!uploaded.length) return;
                                        onSamePromptSlotsChange((prev) =>
                                            prev.map((list, idx) => (idx === slotIndex ? [...list, ...uploaded] : list)),
                                        );
                                    }}
                                    onPaste={async () => {
                                        const uploaded = await readClipboardImages();
                                        if (!uploaded.length) return;
                                        onSamePromptSlotsChange((prev) =>
                                            prev.map((list, idx) => (idx === slotIndex ? [...list, ...uploaded] : list)),
                                        );
                                    }}
                                    onPickAsset={() => onOpenAssetPicker({ mode: "same-slot", slotIndex })}
                                    onMove={(imgIdx, offset) =>
                                        onSamePromptSlotsChange((prev) =>
                                            prev.map((list, idx) => (idx === slotIndex ? moveItem(list, imgIdx, offset) : list)),
                                        )
                                    }
                                    onRemoveImage={(id) =>
                                        onSamePromptSlotsChange((prev) =>
                                            prev.map((list, idx) => (idx === slotIndex ? list.filter((img) => img.id !== id) : list)),
                                        )
                                    }
                                    onClearImages={() =>
                                        onSamePromptSlotsChange((prev) => prev.map((list, idx) => (idx === slotIndex ? [] : list)))
                                    }
                                />
                            ))
                        )}

                        {samePromptMismatchError ? <Alert type="warning" showIcon message={samePromptMismatchError} /> : null}
                    </div>

                    {previewTaskCount > 0 ? (
                        <div className="flex items-center justify-between gap-2 rounded-lg border border-stone-200 px-3 py-2 text-xs dark:border-stone-800">
                            <span className="text-stone-600 dark:text-stone-300">
                                <Trans i18nKey="imageBatch.matchedGroups" values={{ count: previewTaskCount }} components={{ strong: <strong /> }} />
                            </span>
                            <Button size="small" icon={<SlidersHorizontal className="size-3.5" />} disabled={running} onClick={onConvertToCustom}>
                                {t("imageBatch.convertToCustom")}
                            </Button>
                        </div>
                    ) : null}
                </div>
            ) : null}

            {scenario === "multi-prompt" ? (
                <div className="space-y-4">
                    <div>
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                            <span className="text-sm font-semibold">{t("imageBatch.step1SharedRefsOptional")}</span>
                        </div>
                        <ImageDropBox
                            title={<span className="text-xs font-medium text-stone-600 dark:text-stone-300">{t("imageBatch.sharedRefsHint")}</span>}
                            images={sharedRefs}
                            emptyText={t("imageBatch.sharedRefsEmpty")}
                            disabled={running}
                            onAddFiles={async (files) => {
                                const uploaded = await readUploadedFiles(files);
                                if (!uploaded.length) return;
                                onSharedRefsChange((prev) => [...prev, ...uploaded]);
                            }}
                            onPaste={async () => {
                                const uploaded = await readClipboardImages();
                                if (!uploaded.length) return;
                                onSharedRefsChange((prev) => [...prev, ...uploaded]);
                            }}
                            onPickAsset={() => onOpenAssetPicker({ mode: "multi-ref" })}
                            onMove={(imgIdx, offset) => onSharedRefsChange((prev) => moveItem(prev, imgIdx, offset))}
                            onRemoveImage={(id) => onSharedRefsChange((prev) => prev.filter((img) => img.id !== id))}
                            onClearImages={() => onSharedRefsChange(() => [])}
                        />
                    </div>

                    <div>
                        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                            <span className="text-sm font-semibold">{t("imageBatch.step2MultiPrompts")}</span>
                            <div className="flex flex-wrap gap-1.5">
                                <Segmented
                                    size="small"
                                    disabled={running}
                                    value={splitMode}
                                    onChange={(val) => onSplitModeChange(val as PromptSplitMode)}
                                    options={[
                                        { label: t("imageBatch.splitLine"), value: "line" },
                                        { label: t("imageBatch.splitBlank"), value: "blank" },
                                    ]}
                                />
                                <Button size="small" icon={<BookOpen className="size-3.5" />} disabled={running} onClick={() => onOpenPromptDialog("multi-prompt")}>
                                    {t("imageBatch.appendPrompts")}
                                </Button>
                            </div>
                        </div>
                        <Input.TextArea
                            value={multiPromptRaw}
                            onChange={(e) => onMultiPromptRawChange(e.target.value)}
                            rows={7}
                            disabled={running}
                            placeholder={
                                splitMode === "line"
                                    ? t("imageBatch.multiPromptLinePlaceholder")
                                    : t("imageBatch.multiPromptBlankPlaceholder")
                            }
                        />
                        {previewTaskCount > 0 ? (
                            <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-stone-200 px-3 py-2 text-xs dark:border-stone-800">
                                <span className="text-stone-600 dark:text-stone-300">
                                    <Trans i18nKey="imageBatch.parsedPromptsCount" values={{ count: previewTaskCount }} components={{ strong: <strong /> }} />
                                </span>
                                <Button size="small" icon={<SlidersHorizontal className="size-3.5" />} disabled={running} onClick={onConvertToCustom}>
                                    {t("imageBatch.convertToCustom")}
                                </Button>
                            </div>
                        ) : null}
                    </div>
                </div>
            ) : null}

            {scenario === "custom" ? (
                <div className="space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold">{t("imageBatch.customQueueTitle", { count: customItems.length })}</span>
                        <Button
                            size="small"
                            type="dashed"
                            icon={<Plus className="size-3.5" />}
                            disabled={running}
                            onClick={() => onCustomItemsChange((prev) => [...prev, createEmptyBatchItem()])}
                        >
                            {t("imageBatch.addItem")}
                        </Button>
                    </div>

                    <div className="space-y-2.5">
                        {customItems.map((item, itemIdx) => {
                            const denseRefs = getDenseReferences(item.references);
                            return (
                                <div key={item.id} className="rounded-lg border border-stone-200 bg-stone-50/60 p-2.5 dark:border-stone-800 dark:bg-stone-900/50">
                                    <div className="mb-1.5 flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-1.5">
                                            <Tag className="m-0" color="blue">
                                                #{itemIdx + 1}
                                            </Tag>
                                            <span className="text-xs text-stone-500 dark:text-stone-400">
                                                {denseRefs.length ? t("imageBatch.itemRefCount", { count: denseRefs.length }) : t("imageBatch.textToImageTag")}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <Tooltip title={t("imageBatch.uploadToItemTooltip")}>
                                                <Button
                                                    size="small"
                                                    type="text"
                                                    icon={<Upload className="size-3.5" />}
                                                    loading={uploadingItemId === item.id}
                                                    disabled={running}
                                                    onClick={() => {
                                                        uploadTargetItemIdRef.current = item.id;
                                                        itemFileInputRef.current?.click();
                                                    }}
                                                />
                                            </Tooltip>
                                            <Tooltip title={t("imageBatch.addAssetToItemTooltip")}>
                                                <Button
                                                    size="small"
                                                    type="text"
                                                    icon={<FolderPlus className="size-3.5" />}
                                                    disabled={running}
                                                    onClick={() => onOpenAssetPicker({ mode: "custom-item", itemId: item.id })}
                                                />
                                            </Tooltip>
                                            <Tooltip title={t("imageBatch.copyItemTooltip")}>
                                                <Button
                                                    size="small"
                                                    type="text"
                                                    icon={<Copy className="size-3.5" />}
                                                    disabled={running}
                                                    onClick={() =>
                                                        onCustomItemsChange((prev) => {
                                                            const copy = createEmptyBatchItem(item.prompt, item.references);
                                                            const next = [...prev];
                                                            next.splice(itemIdx + 1, 0, copy);
                                                            return next;
                                                        })
                                                    }
                                                />
                                            </Tooltip>
                                            <Tooltip title={t("imageBatch.deleteItemTooltip")}>
                                                <Button
                                                    size="small"
                                                    type="text"
                                                    danger
                                                    icon={<Trash2 className="size-3.5" />}
                                                    disabled={running || customItems.length <= 1}
                                                    onClick={() => onCustomItemsChange((prev) => prev.filter((entry) => entry.id !== item.id))}
                                                />
                                            </Tooltip>
                                        </div>
                                    </div>

                                    <Input.TextArea
                                        value={item.prompt}
                                        onChange={(e) =>
                                            onCustomItemsChange((prev) =>
                                                prev.map((entry) => (entry.id === item.id ? { ...entry, prompt: e.target.value } : entry)),
                                            )
                                        }
                                        disabled={running}
                                        autoSize={{ minRows: 1, maxRows: 4 }}
                                        placeholder={t("imageBatch.customItemPlaceholder", { index: itemIdx + 1 })}
                                    />

                                    {denseRefs.length ? (
                                        <div className="hover-scrollbar mt-2 flex gap-1.5 overflow-x-auto pb-1">
                                            {denseRefs.map((ref, refIdx) => (
                                                <div
                                                    key={ref.id}
                                                    className="group relative size-14 shrink-0 overflow-hidden rounded border border-stone-200 dark:border-stone-700"
                                                >
                                                    <img
                                                        src={previewUrlFor(ref.storageKey) || ref.dataUrl}
                                                        alt={ref.name}
                                                        className="size-full object-cover"
                                                    />
                                                    <span className="absolute left-0.5 top-0.5 rounded bg-black/65 px-1 text-[10px] text-white">
                                                        {imageReferenceLabel(refIdx)}
                                                    </span>
                                                    {!running ? (
                                                        <button
                                                            type="button"
                                                            className="absolute right-0.5 top-0.5 hidden size-5 items-center justify-center rounded bg-black/65 text-white group-hover:flex"
                                                            onClick={() =>
                                                                onCustomItemsChange((prev) =>
                                                                    prev.map((entry) =>
                                                                        entry.id === item.id
                                                                            ? { ...entry, references: getDenseReferences(entry.references).filter((r) => r.id !== ref.id) }
                                                                            : entry,
                                                                    ),
                                                                )
                                                            }
                                                            aria-label={t("imageBatch.deleteRefAria")}
                                                        >
                                                            <Trash2 className="size-3" />
                                                        </button>
                                                    ) : null}
                                                </div>
                                            ))}
                                        </div>
                                    ) : null}
                                </div>
                            );
                        })}
                    </div>
                </div>
            ) : null}

            <input
                ref={itemFileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    const targetId = uploadTargetItemIdRef.current;
                    uploadTargetItemIdRef.current = null;
                    if (targetId) void handleUploadToCustomItem(targetId, event.target.files);
                    event.target.value = "";
                }}
            />
        </div>
    );
}
