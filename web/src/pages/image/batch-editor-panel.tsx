/** 生图工作台批量编辑器面板：场景化引导（多图同词 / 一图多词 / 自由队列），所见即所得免多余同步点击。 */
import { useRef, useState } from "react";
import { Alert, App, Button, Input, InputNumber, Segmented, Tag, Tooltip } from "antd";
import { ArrowLeft, ArrowRight, BookOpen, ClipboardPaste, Copy, FolderPlus, Plus, SlidersHorizontal, Trash2, Upload } from "lucide-react";
import { nanoid } from "nanoid";

import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { previewUrlFor, uploadImage } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";
import {
    MAX_BATCH_CONCURRENCY,
    MAX_BATCH_IMAGES,
    createEmptyBatchItem,
    getDenseReferences,
    type BatchScenario,
    type BatchTaskItem,
    type PromptSplitMode,
} from "./batch-utils";

type BatchEditorPanelProps = {
    scenario: BatchScenario;
    onScenarioChange: (value: BatchScenario) => void;
    concurrency: number;
    onConcurrencyChange: (value: number) => void;
    // 场景 1：多图同词
    sharedPrompt: string;
    onSharedPromptChange: (value: string) => void;
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
    onOpenAssetPicker: (target: { mode: "same-prompt-text" } | { mode: "same-slot"; slotIndex: number } | { mode: "multi-ref" } | { mode: "custom-item"; itemId: string }) => void;
};

const SCENARIO_DESCRIPTIONS: Record<BatchScenario, string> = {
    "same-prompt": "适合多张图片（或图1/图2/图3组合）共用同一句提示词，传 1 张图则自动固定搭配所有任务。",
    "multi-prompt": "适合用同一张参考图（或不放图纯文字）配合多条不同提示词批量出图。",
    custom: "每条任务可独立设置自己的提示词和参考图，也支持从前两种模式一键转入微调。",
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
                        上传
                    </Button>
                    <Button size="small" icon={<ClipboardPaste className="size-3.5" />} loading={pasting} disabled={disabled} onClick={() => void handlePasteClick()}>
                        粘贴
                    </Button>
                    <Button size="small" icon={<FolderPlus className="size-3.5" />} disabled={disabled} onClick={onPickAsset}>
                        资产
                    </Button>
                    {images.length && onClearImages ? (
                        <Button size="small" type="text" danger disabled={disabled} onClick={onClearImages}>
                            清空
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
                                    className="!h-5 !w-5 !min-w-5 !rounded-full !bg-white/85 !p-0"
                                    icon={<ArrowLeft className="size-3" />}
                                    disabled={idx <= 0}
                                    onClick={() => onMove(idx, -1)}
                                />
                                <Button
                                    size="small"
                                    className="!h-5 !w-5 !min-w-5 !rounded-full !bg-white/85 !p-0"
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
                                aria-label="移除参考图"
                            >
                                <Trash2 className="size-3" />
                            </button>
                        ) : null}
                    </div>
                ))}
                {!images.length ? (
                    <div className="flex min-w-full items-center justify-center text-center text-xs text-stone-500">
                        {dragActive ? "松开即可批量添加" : emptyText}
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
            message.error(error instanceof Error ? error.message : "读取图片失败");
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
                message.error("剪贴板中没有可用图片");
                return [];
            }
            const uploaded = await Promise.all(
                blobs.map(async (blob, index) => {
                    const image = await uploadImage(blob);
                    return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            message.success(`已从剪贴板添加 ${uploaded.length} 张图片`);
            return uploaded;
        } catch {
            message.error("剪贴板中没有可用图片或无读取权限");
            return [];
        }
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
                    <span className="text-xs font-semibold text-stone-700 dark:text-stone-300">选择批量方式</span>
                    <div className="flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                        <span>并发</span>
                        <InputNumber
                            size="small"
                            min={1}
                            max={MAX_BATCH_CONCURRENCY}
                            value={concurrency}
                            disabled={running}
                            onChange={(val) => onConcurrencyChange(Math.max(1, Math.min(MAX_BATCH_CONCURRENCY, Number(val) || 3)))}
                            style={{ width: 58 }}
                        />
                        <span>上限 {MAX_BATCH_IMAGES} 张</span>
                    </div>
                </div>
                <Segmented
                    block
                    disabled={running}
                    value={scenario}
                    onChange={(val) => onScenarioChange(val as BatchScenario)}
                    options={[
                        { label: "多图同词", value: "same-prompt" },
                        { label: "一图多词", value: "multi-prompt" },
                        { label: "自由队列", value: "custom" },
                    ]}
                />
                <div className="text-xs leading-5 text-stone-500 dark:text-stone-400">{SCENARIO_DESCRIPTIONS[scenario]}</div>
            </div>

            {scenario === "same-prompt" ? (
                <div className="space-y-4">
                    <div>
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                            <span className="text-sm font-semibold">第 1 步 · 填写共用提示词</span>
                            <div className="flex gap-1.5">
                                <Button size="small" icon={<BookOpen className="size-3.5" />} disabled={running} onClick={() => onOpenPromptDialog("same-prompt")}>
                                    提示词库
                                </Button>
                                <Button size="small" icon={<FolderPlus className="size-3.5" />} disabled={running} onClick={() => onOpenAssetPicker({ mode: "same-prompt-text" })}>
                                    资产
                                </Button>
                            </div>
                        </div>
                        <Input.TextArea
                            value={sharedPrompt}
                            onChange={(e) => onSharedPromptChange(e.target.value)}
                            rows={4}
                            disabled={running}
                            placeholder="例如：让图1的人物穿上这件图2的服装，保持面部特征和光影自然；输入后自动应用到所有任务"
                        />
                    </div>

                    <div className="space-y-2.5">
                        <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-semibold">第 2 步 · 批量放入参考图（按图1/图2/图3顺序）</span>
                            <Button
                                size="small"
                                type="dashed"
                                icon={<Plus className="size-3.5" />}
                                disabled={running || samePromptSlots.length >= 12}
                                onClick={() => onSamePromptSlotsChange((prev) => [...prev, []])}
                            >
                                添加图{samePromptSlots.length + 1}
                            </Button>
                        </div>

                        {samePromptSlots.map((slotImages, slotIndex) => (
                            <ImageDropBox
                                key={slotIndex}
                                title={
                                    <>
                                        <Tag color="blue" className="m-0">
                                            {imageReferenceLabel(slotIndex)}
                                        </Tag>
                                        <span className="text-xs font-semibold">第 {slotIndex + 1} 张参考图</span>
                                        <Tag className="m-0">
                                            {slotImages.length === 1 && previewTaskCount > 1 ? `1 张（固定共用）` : `${slotImages.length} 张`}
                                        </Tag>
                                    </>
                                }
                                hint={
                                    slotIndex === 0
                                        ? "上传多张图会自动生成对应组数的任务，并与下方图2、图3按序号一一配对"
                                        : "仅放 1 张时自动固定搭配全部任务；放多张时请与图1数量一致"
                                }
                                images={slotImages}
                                showOrdinal
                                emptyText={`拖拽或点击上传多张「${imageReferenceLabel(slotIndex)}」`}
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
                        ))}

                        {samePromptMismatchError ? <Alert type="warning" showIcon message={samePromptMismatchError} /> : null}
                    </div>

                    {previewTaskCount > 0 ? (
                        <div className="flex items-center justify-between gap-2 rounded-lg border border-stone-200 px-3 py-2 text-xs dark:border-stone-800">
                            <span className="text-stone-600 dark:text-stone-300">
                                已自动配对 <strong>{previewTaskCount}</strong> 组任务（右侧可实时预览）
                            </span>
                            <Button size="small" icon={<SlidersHorizontal className="size-3.5" />} disabled={running} onClick={onConvertToCustom}>
                                转自由队列微调
                            </Button>
                        </div>
                    ) : null}
                </div>
            ) : null}

            {scenario === "multi-prompt" ? (
                <div className="space-y-4">
                    <div>
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                            <span className="text-sm font-semibold">第 1 步 · 放入共用参考图（可选）</span>
                        </div>
                        <ImageDropBox
                            title={<span className="text-xs font-medium text-stone-600 dark:text-stone-300">所有提示词将共用这里放入的参考图（不放则纯文生图）</span>}
                            images={sharedRefs}
                            emptyText="拖入或上传 1 张或多张参考图（可留空纯文生图）"
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
                            <span className="text-sm font-semibold">第 2 步 · 批量输入多条提示词</span>
                            <div className="flex flex-wrap gap-1.5">
                                <Segmented
                                    size="small"
                                    disabled={running}
                                    value={splitMode}
                                    onChange={(val) => onSplitModeChange(val as PromptSplitMode)}
                                    options={[
                                        { label: "每行一条", value: "line" },
                                        { label: "空行分段", value: "blank" },
                                    ]}
                                />
                                <Button size="small" icon={<BookOpen className="size-3.5" />} disabled={running} onClick={() => onOpenPromptDialog("multi-prompt")}>
                                    追加提示词
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
                                    ? "每行输入一条提示词，例如：\n赛博朋克霓虹夜景风格\n吉卜力手绘水彩风格\n极简产品白底棚拍光影"
                                    : "用空行分隔多条长段落提示词，每段生成一组任务"
                            }
                        />
                        {previewTaskCount > 0 ? (
                            <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-stone-200 px-3 py-2 text-xs dark:border-stone-800">
                                <span className="text-stone-600 dark:text-stone-300">
                                    已实时识别 <strong>{previewTaskCount}</strong> 条提示词（右侧可预览每组）
                                </span>
                                <Button size="small" icon={<SlidersHorizontal className="size-3.5" />} disabled={running} onClick={onConvertToCustom}>
                                    转自由队列微调
                                </Button>
                            </div>
                        ) : null}
                    </div>
                </div>
            ) : null}

            {scenario === "custom" ? (
                <div className="space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold">独立任务队列（{customItems.length} 组）</span>
                        <Button
                            size="small"
                            type="dashed"
                            icon={<Plus className="size-3.5" />}
                            disabled={running}
                            onClick={() => onCustomItemsChange((prev) => [...prev, createEmptyBatchItem()])}
                        >
                            添加一项
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
                                                {denseRefs.length ? `${denseRefs.length} 张参考图` : "纯文生图"}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <Tooltip title="上传参考图到此项">
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
                                            <Tooltip title="从我的资产添加参考图">
                                                <Button
                                                    size="small"
                                                    type="text"
                                                    icon={<FolderPlus className="size-3.5" />}
                                                    disabled={running}
                                                    onClick={() => onOpenAssetPicker({ mode: "custom-item", itemId: item.id })}
                                                />
                                            </Tooltip>
                                            <Tooltip title="复制此项">
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
                                            <Tooltip title="删除此项">
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
                                        placeholder={`输入第 ${itemIdx + 1} 项提示词...`}
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
                                                            aria-label="删除参考图"
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
