import { ArrowLeft, ArrowRight, BookOpen, CheckSquare, ClipboardPaste, Download, FolderPlus, History, ImagePlus, LoaderCircle, PenLine, Plus, SlidersHorizontal, Sparkles, Square, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { App, Button, Checkbox, Drawer, Empty, Image, Input, Modal, Segmented, Tag, Tooltip, Typography } from "antd";
import localforage from "localforage";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";

import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { CloudQuotaTag } from "@/components/layout/cloud-quota-tag";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { useBatchZipDownload } from "@/hooks/use-batch-zip-download";
import { canvasThemes } from "@/lib/canvas-theme";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { modelOptionLabel, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { nanoid } from "nanoid";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { requestEdit, requestGeneration } from "@/services/api/image";
import { storageApi } from "@/services/api/server";
import { isCloudAuthenticated, WORKSPACE_CHANGED_EVENT, type WorkspaceChangeScope } from "@/services/cloud-media";
import { ensureRuntimeConfigForGeneration } from "@/services/cloud-sync";
import { ensureImagePreview, getImageBlob, getImagePreviewRevision, previewUrlFor, resolveImageUrl, resolvePickedImage, subscribeImagePreviews, uploadImage } from "@/services/image-storage";
import { deleteWorkbenchLogsWithCloud, pushWorkbenchLogToCloud, syncWorkbenchLogsWithCloud } from "@/services/workbench-sync";
import { useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import type { ReferenceImage } from "@/types/image";
import i18n from "@/i18n";
import { BatchEditorPanel } from "./batch-editor-panel";
import {
    DEFAULT_BATCH_CONCURRENCY,
    MAX_BATCH_IMAGES,
    buildMultiPromptBatchTasks,
    buildSamePromptBatchTasks,
    createEmptyBatchItem,
    getDenseReferences,
    runConcurrentQueue,
    type BatchResultGroup,
    type BatchScenario,
    type BatchTaskItem,
    type PromptSplitMode,
    type ResolvedBatchTask,
} from "./batch-utils";

type GeneratedImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
};

type GenerationResult = {
    id: string;
    status: "pending" | "success" | "failed";
    image?: GeneratedImage;
    error?: string;
};

type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    imageCount: number;
    size: string;
    quality: string;
    status: "pending" | "success" | "failed";
    slotTaskIds?: string[];
    images: GeneratedImage[];
};

type GenerationLogConfig = Pick<AiConfig, "model" | "imageModel" | "quality" | "size" | "count">;

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

const LOG_STORE_KEY = "infinite-canvas:image_generation_logs";
const RESULT_ACTION_BUTTON_CLASS = "min-w-0 px-1.5 [&_.ant-btn-icon]:shrink-0 [&>span:last-child]:min-w-0 [&>span:last-child]:truncate";
const logStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });

export default function ImagePage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dragDepthRef = useRef(0);
    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const cleanupImages = useAssetStore((state) => state.cleanupImages);
    const [prompt, setPrompt] = useState("");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [logsOpen, setLogsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [elapsedNow, setElapsedNow] = useState(() => performance.now());
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [deletingLogs, setDeletingLogs] = useState(false);
    const [isReferenceDragActive, setIsReferenceDragActive] = useState(false);
    const [uploadingRefs, setUploadingRefs] = useState(false);
    const [pastingRefs, setPastingRefs] = useState(false);
    const [autoRunToken, setAutoRunToken] = useState(0);
    const [workbenchMode, setWorkbenchMode] = useState<"single" | "batch">("single");
    const [liveSingleJobs, setLiveSingleJobs] = useState<Record<string, { startedAt: number; running: boolean; results: GenerationResult[] }>>({});
    const [activeSingleLogId, setActiveSingleLogId] = useState<string | null>(null);
    const [batchScenario, setBatchScenario] = useState<BatchScenario>("same-prompt");
    const [batchConcurrency, setBatchConcurrency] = useState(DEFAULT_BATCH_CONCURRENCY);
    const [batchSharedPrompt, setBatchSharedPrompt] = useState("");
    const [batchSamePromptSlots, setBatchSamePromptSlots] = useState<ReferenceImage[][]>(() => [[]]);
    const [batchSharedRefs, setBatchSharedRefs] = useState<ReferenceImage[]>([]);
    const [batchMultiPromptRaw, setBatchMultiPromptRaw] = useState("");
    const [batchSplitMode, setBatchSplitMode] = useState<PromptSplitMode>("line");
    const [batchCustomItems, setBatchCustomItems] = useState<BatchTaskItem[]>(() => [createEmptyBatchItem()]);
    const [liveBatchJobs, setLiveBatchJobs] = useState<Record<string, { id: string; startedAt: number; running: boolean; groups: BatchResultGroup[] }>>({});
    const [activeBatchJobId, setActiveBatchJobId] = useState<string | null>(null);
    const [batchShowPreview, setBatchShowPreview] = useState(true);
    const { downloading: downloadingZip, downloadZip } = useBatchZipDownload();
    const [promptDialogTarget, setPromptDialogTarget] = useState<"single" | "same-prompt" | "multi-prompt">("single");
    const [assetPickerTarget, setAssetPickerTarget] = useState<
        | { mode: "single" }
        | { mode: "same-prompt-text" }
        | { mode: "same-slot"; slotIndex: number }
        | { mode: "multi-ref" }
        | { mode: "custom-item"; itemId: string }
    >({ mode: "single" });
    const batchStopControllersRef = useRef<Map<string, { stopped: boolean }>>(new Map());
    const imageCommand = useWorkbenchAgentStore((state) => state.imageCommand);
    const clearImageCommand = useWorkbenchAgentStore((state) => state.clearImageCommand);
    const updateAgentTask = useWorkbenchAgentStore((state) => state.updateTask);
    const processedCommandRef = useRef(0);
    const agentTaskIdRef = useRef<string | undefined>(undefined);
    const activeLogIdsRef = useRef<Set<string>>(new Set());

    const model = effectiveConfig.imageModel || effectiveConfig.model;
    const canGenerate = Boolean(prompt.trim());
    const generationCount = Math.max(1, Math.min(10, Number(config.count) || 1));

    const activeSingleJob = activeSingleLogId ? liveSingleJobs[activeSingleLogId] : undefined;
    const activeBatchJob = activeBatchJobId ? liveBatchJobs[activeBatchJobId] : undefined;
    const batchGroups = activeBatchJob?.groups ?? [];
    const runningBatchJobs = Object.values(liveBatchJobs).filter((job) => job.running);
    const runningSingleJobs = Object.values(liveSingleJobs).filter((job) => job.running);
    const totalRunningJobs = runningBatchJobs.length + runningSingleJobs.length;
    const isCurrentViewRunning =
        workbenchMode === "batch" ? Boolean(!batchShowPreview && activeBatchJob?.running) : Boolean(activeSingleJob?.running);
    const currentViewStartedAt =
        workbenchMode === "batch" ? (activeBatchJob?.startedAt ?? 0) : (activeSingleJob?.startedAt ?? 0);
    const elapsedMs = isCurrentViewRunning && currentViewStartedAt ? Math.max(0, elapsedNow - currentViewStartedAt) : 0;

    const displayedSingleResults: GenerationResult[] = (() => {
        if (activeSingleJob) return activeSingleJob.results;
        if (previewLog) {
            if (previewLog.status === "pending") {
                return Array.from({ length: Math.max(1, previewLog.imageCount || 1) }, (_, i) => ({
                    id: `${previewLog.id}-pending-${i}`,
                    status: "pending" as const,
                }));
            }
            if (previewLog.status === "failed" && !previewLog.images.length) {
                return [{ id: `${previewLog.id}-failed`, status: "failed" as const, error: t("workbench.generationFailed") }];
            }
            return previewLog.images.map((image) => ({ id: image.id, status: "success" as const, image }));
        }
        return [];
    })();

    const resolvedBatchPlan: {
        tasks: ResolvedBatchTask[];
        mismatchError: string | null;
        missingReason: string | null;
    } =
        batchScenario === "same-prompt"
            ? buildSamePromptBatchTasks(batchSharedPrompt, batchSamePromptSlots)
            : batchScenario === "multi-prompt"
              ? { ...buildMultiPromptBatchTasks(batchMultiPromptRaw, batchSplitMode, batchSharedRefs), mismatchError: null }
              : {
                    tasks: batchCustomItems.map((item) => ({
                        id: item.id,
                        prompt: item.prompt.trim(),
                        references: getDenseReferences(item.references),
                    })),
                    mismatchError: null,
                    missingReason:
                        batchCustomItems.length === 0
                            ? "请添加至少 1 组任务"
                            : batchCustomItems.some((item) => !item.prompt.trim())
                              ? "请补全自由队列中所有任务的提示词"
                              : null,
                };

    const batchTotalImages = resolvedBatchPlan.tasks.length * generationCount;
    const batchCanGenerate =
        resolvedBatchPlan.tasks.length > 0 &&
        !resolvedBatchPlan.mismatchError &&
        !resolvedBatchPlan.missingReason &&
        batchTotalImages > 0 &&
        batchTotalImages <= MAX_BATCH_IMAGES;

    useEffect(() => {
        if (!totalRunningJobs) return;
        setElapsedNow(performance.now());
        const timer = window.setInterval(() => setElapsedNow(performance.now()), 1000);
        return () => window.clearInterval(timer);
    }, [totalRunningJobs]);

    useEffect(() => {
        const syncAndRefresh = () => {
            void refreshLogs().then(() => {
                void syncWorkbenchLogsWithCloud("image", logStore, serializeLog).then(() => refreshLogs());
            });
        };
        syncAndRefresh();
        const handleSessionChanged = () => {
            setLogs([]);
            setLiveSingleJobs({});
            setLiveBatchJobs({});
            setActiveSingleLogId(null);
            setActiveBatchJobId(null);
            setPreviewLog(null);
            setSelectedLogIds([]);
            syncAndRefresh();
        };
        const handleCloudSynced = () => {
            void refreshLogs().then((stored) => {
                setPreviewLog((cur) => {
                    if (cur && !stored.some((item) => item.id === cur.id)) {
                        setActiveSingleLogId((prev) => (prev === cur.id ? null : prev));
                        return null;
                    }
                    return cur;
                });
            });
        };
        const handleWorkspaceChanged = (event: Event) => {
            const scope = (event as CustomEvent<{ scope?: WorkspaceChangeScope }>).detail?.scope;
            if (scope && scope !== "all" && scope !== "image" && scope !== "media") return;
            handleCloudSynced();
        };
        window.addEventListener("infinite-canvas:user-session-changed", handleSessionChanged);
        window.addEventListener("infinite-canvas:cloud-workspace-synced", handleCloudSynced);
        window.addEventListener(WORKSPACE_CHANGED_EVENT, handleWorkspaceChanged);
        return () => {
            window.removeEventListener("infinite-canvas:user-session-changed", handleSessionChanged);
            window.removeEventListener("infinite-canvas:cloud-workspace-synced", handleCloudSynced);
            window.removeEventListener(WORKSPACE_CHANGED_EVENT, handleWorkspaceChanged);
        };
    }, []);

    const addReferences = async (files?: FileList | null) => {
        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        if (!imageFiles.length) return;
        setUploadingRefs(true);
        try {
            const nextReferences = await Promise.all(
                imageFiles.map(async (file) => {
                    const image = await uploadImage(file);
                    return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            setReferences((value) => [...value, ...nextReferences]);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("common.imageReadFailed"));
        } finally {
            setUploadingRefs(false);
        }
    };

    const addReferencesFromClipboard = async () => {
        setPastingRefs(true);
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) {
                message.error(t("imageWorkbench.clipboardEmpty"));
                return;
            }
            const nextReferences = await Promise.all(
                blobs.map(async (blob, index) => {
                    const image = await uploadImage(blob);
                    return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            setReferences((value) => [...value, ...nextReferences]);
            message.success(t("imageWorkbench.clipboardAdded", { count: nextReferences.length }));
        } catch {
            message.error(t("imageWorkbench.clipboardEmpty"));
        } finally {
            setPastingRefs(false);
        }
    };

    const generate = async () => {
        const agentTaskId = agentTaskIdRef.current;
        agentTaskIdRef.current = undefined;
        const text = prompt.trim();
        if (!text) {
            message.error(t("imageWorkbench.promptRequired"));
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.promptRequired") });
            return;
        }
        const snapshot = await buildRequestSnapshot();
        if (!snapshot) {
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.configIncomplete") });
            return;
        }

        const count = generationCount;
        const logId = nanoid();
        const batchStartedAt = performance.now();
        const slotTaskIds = Array.from({ length: count }, () => nanoid());

        if (agentTaskId) updateAgentTask(agentTaskId, { status: "running", error: undefined });
        setPreviewLog(null);
        setActiveSingleLogId(logId);
        setLiveSingleJobs((prev) => ({
            ...prev,
            [logId]: {
                startedAt: batchStartedAt,
                running: true,
                results: Array.from({ length: count }, () => ({ id: nanoid(), status: "pending" })),
            },
        }));

        activeLogIdsRef.current.add(logId);
        const pendingLog = buildLog({
            id: logId,
            prompt: text,
            model,
            config: { ...snapshot.config, count: String(count) },
            references: snapshot.references,
            durationMs: 0,
            successCount: 0,
            failCount: 0,
            status: "pending",
            slotTaskIds,
            images: [],
        });
        saveLog(pendingLog);

        const tasks = Array.from({ length: count }, (_, index) => runGenerationSlot(logId, index, snapshot, slotTaskIds[index]));

        const result = await Promise.allSettled(tasks);
        const successImages = result.filter((item): item is PromiseFulfilledResult<GeneratedImage> => item.status === "fulfilled").map((item) => item.value);
        const successCount = successImages.length;
        const failCount = count - successCount;
        const failed = result.find((item): item is PromiseRejectedResult => item.status === "rejected");
        const error = failed?.reason instanceof Error ? failed.reason.message : failCount ? t("workbench.generationFailed") : undefined;
        if (agentTaskId) updateAgentTask(agentTaskId, { status: successCount ? "succeeded" : "failed", successCount, failCount, error: successCount ? undefined : error });

        try {
            activeLogIdsRef.current.delete(logId);
            saveLog({
                ...pendingLog,
                durationMs: performance.now() - batchStartedAt,
                successCount,
                failCount,
                status: successCount ? "success" : "failed",
                images: successImages,
            });
            successCount ? message.success(t("imageWorkbench.generated")) : message.error(failed?.reason instanceof Error ? failed.reason.message : t("workbench.generationFailed"));
        } finally {
            activeLogIdsRef.current.delete(logId);
            setLiveSingleJobs((prev) => (prev[logId] ? { ...prev, [logId]: { ...prev[logId], running: false } } : prev));
        }
    };

    // Handle image-generation commands from the Agent panel by setting the prompt and optionally starting generation.
    useEffect(() => {
        if (!imageCommand || imageCommand.nonce === processedCommandRef.current) return;
        processedCommandRef.current = imageCommand.nonce;
        clearImageCommand();
        if (typeof imageCommand.prompt === "string") setPrompt(imageCommand.prompt);
        if (imageCommand.run) {
            agentTaskIdRef.current = imageCommand.taskId;
            setAutoRunToken((value) => value + 1);
        }
    }, [imageCommand, clearImageCommand, updateAgentTask]);

    useEffect(() => {
        if (!autoRunToken) return;
        void generate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRunToken]);

    const downloadImage = (image: GeneratedImage, index: number) => {
        saveAs(image.dataUrl, `image-${index + 1}.png`);
    };

    const addResultToReferences = async (image: GeneratedImage, index: number, addToBatch?: boolean) => {
        try {
            const stored = await resolvePickedImage(image);
            const nextRef: ReferenceImage = { id: nanoid(), name: `result-${index + 1}.png`, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey };
            if (addToBatch) {
                if (batchScenario === "same-prompt") {
                    setBatchSamePromptSlots((prev) => prev.map((list, idx) => (idx === 0 ? [...list, nextRef] : list)));
                    message.success("已加入「第 1 张参考图」队列");
                } else if (batchScenario === "multi-prompt") {
                    setBatchSharedRefs((prev) => [...prev, nextRef]);
                    message.success("已加入共用参考图");
                } else {
                    setBatchCustomItems((prev) => [...prev, createEmptyBatchItem(batchSharedPrompt.trim(), [nextRef])]);
                    message.success("已新增一条带该参考图的任务");
                }
                return;
            }
            setReferences((value) => [...value, nextRef]);
            message.success(t("imageWorkbench.addedReference"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("common.imageReadFailed"));
        }
    };

    const saveResultToAssets = async (image: GeneratedImage, index: number, promptOverride?: string) => {
        try {
            const stored = image.storageKey ? await resolvePickedImage(image) : await uploadImage(image.dataUrl);
            addAsset({
                kind: "image",
                title: t("imageWorkbench.resultTitle", { count: index + 1 }),
                coverUrl: stored.url,
                tags: [],
                source: t("imageWorkbench.source"),
                data: { dataUrl: stored.url, storageKey: stored.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: stored.mimeType || image.mimeType || "image/png" },
                metadata: { source: "image-page", prompt: promptOverride ?? prompt },
            });
            message.success(t("common.addedToAssets"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("common.imageReadFailed"));
        }
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind === "text") {
            if (assetPickerTarget.mode === "same-prompt-text") {
                setBatchSharedPrompt(payload.content);
            } else if (assetPickerTarget.mode === "multi-ref") {
                setBatchMultiPromptRaw((prev) => (prev.trim() ? `${prev.trim()}\n${payload.content}` : payload.content));
            } else {
                setPrompt(payload.content);
            }
            setAssetPickerOpen(false);
            return;
        }
        if (payload.kind !== "image") {
            message.warning(t("imageWorkbench.unsupportedAsset"));
            setAssetPickerOpen(false);
            return;
        }
        const hide = message.loading(t("workbench.importingReference"), 0);
        try {
            const stored = await resolvePickedImage(payload);
            const nextRef: ReferenceImage = { id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey };
            if (assetPickerTarget.mode === "same-slot") {
                const targetSlot = assetPickerTarget.slotIndex;
                setBatchSamePromptSlots((prev) => prev.map((list, idx) => (idx === targetSlot ? [...list, nextRef] : list)));
            } else if (assetPickerTarget.mode === "multi-ref") {
                setBatchSharedRefs((prev) => [...prev, nextRef]);
            } else if (assetPickerTarget.mode === "custom-item") {
                const targetItemId = assetPickerTarget.itemId;
                setBatchCustomItems((prev) =>
                    prev.map((item) => (item.id === targetItemId ? { ...item, references: [...item.references, nextRef] } : item)),
                );
            } else {
                setReferences((value) => [...value, nextRef]);
            }
            setAssetPickerOpen(false);
            message.success(t("imageWorkbench.addedReference"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("common.imageReadFailed"));
        } finally {
            hide();
        }
    };

    const createSession = () => {
        if (workbenchMode === "batch") {
            setBatchSharedPrompt("");
            setBatchSamePromptSlots([[]]);
            setBatchSharedRefs([]);
            setBatchMultiPromptRaw("");
            setBatchCustomItems([createEmptyBatchItem()]);
            setActiveBatchJobId(null);
            setBatchShowPreview(true);
        } else {
            setPrompt("");
            setReferences([]);
            setActiveSingleLogId(null);
        }
        setSelectedLogIds([]);
        setPreviewLog(null);
    };

    const deleteSelectedLogs = async () => {
        if (deletingLogs) return;
        const deletingIds = [...selectedLogIds];
        setDeletingLogs(true);
        try {
            await deleteWorkbenchLogsWithCloud(logStore, deletingIds, () => cleanupImages(), "image");
            await refreshLogs();
            if (previewLog && deletingIds.includes(previewLog.id)) {
                setPreviewLog(null);
                setActiveSingleLogId((prev) => (prev === previewLog.id ? null : prev));
            }
            setSelectedLogIds([]);
            setDeleteConfirmOpen(false);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除失败，请重试");
        } finally {
            setDeletingLogs(false);
        }
    };

    const saveLog = (log: GenerationLog) => {
        const serialized = serializeLog(log);
        void logStore.setItem(log.id, serialized).then(refreshLogs);
        void pushWorkbenchLogToCloud("image", serialized);
    };

    const refreshLogs = async () => {
        const stored = await readStoredLogs();
        setLogs(stored);
        return stored;
    };

    useEffect(() => {
        if (!isCloudAuthenticated()) return;
        const pendingLogs = logs.filter(
            (log) =>
                log.status === "pending" &&
                !activeLogIdsRef.current.has(log.id) &&
                log.slotTaskIds?.length &&
                Date.now() - log.createdAt < 30 * 60_000,
        );
        if (!pendingLogs.length) return;

        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let attempt = 0;

        const recover = async () => {
            if (cancelled) return;
            const taskIds = pendingLogs.flatMap((log) => log.slotTaskIds || []);
            try {
                const res = await storageApi.getByTasks(taskIds);
                if (cancelled) return;

                let changed = false;
                for (const log of pendingLogs) {
                    const slotIds = log.slotTaskIds || [];
                    const recoveredImages: GeneratedImage[] = [];
                    let hasStillProcessing = false;

                    for (const tid of slotIds) {
                        const mediaList = res.itemsByTask[tid] || [];
                        if (mediaList.length) {
                            for (const media of mediaList) {
                                if (!media.url) continue;
                                const stored = await uploadImage(media.url, { existingStorageKey: media.id, sourceType: "ai_generated" }).catch(() => null);
                                if (stored) {
                                    recoveredImages.push({
                                        id: media.id,
                                        dataUrl: stored.url,
                                        storageKey: stored.storageKey || media.id,
                                        durationMs: Date.now() - log.createdAt,
                                        width: stored.width || media.width || 0,
                                        height: stored.height || media.height || 0,
                                        bytes: stored.bytes || media.bytes || 0,
                                        mimeType: stored.mimeType || media.mimeType || "image/png",
                                    });
                                }
                            }
                        } else if (res.processingTaskIds.includes(tid)) {
                            hasStillProcessing = true;
                        }
                    }

                    if (recoveredImages.length > 0 && (!hasStillProcessing || attempt >= 20)) {
                        const updated: GenerationLog = {
                            ...log,
                            status: "success",
                            successCount: recoveredImages.length,
                            failCount: Math.max(0, slotIds.length - recoveredImages.length),
                            durationMs: Date.now() - log.createdAt,
                            images: recoveredImages,
                        };
                        await logStore.setItem(log.id, serializeLog(updated));
                        changed = true;
                        setPreviewLog((cur) => (cur?.id === log.id ? updated : cur));
                    } else if (!hasStillProcessing && !recoveredImages.length && attempt >= 1) {
                        const failedLog: GenerationLog = { ...log, status: "failed", failCount: slotIds.length };
                        await logStore.setItem(log.id, serializeLog(failedLog));
                        changed = true;
                        setPreviewLog((cur) => (cur?.id === log.id ? failedLog : cur));
                    }
                }

                if (changed) {
                    await refreshLogs();
                }
                if (res.processingTaskIds.length > 0 && attempt < 24 && !cancelled) {
                    attempt += 1;
                    timer = setTimeout(() => void recover(), 2500);
                }
            } catch {
                // ignore network recovery error
            }
        };

        void recover();
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [logs.map((l) => `${l.id}:${l.status}`).join(",")]);

    const previewGenerationLog = async (log: GenerationLog) => {
        setWorkbenchMode("single");
        setPreviewLog(log);
        setActiveSingleLogId(log.id);
        setLogsOpen(false);
        setPrompt(log.prompt);
        setReferences(log.references || []);
        if (log.config.imageModel || log.model) updateConfig("imageModel", log.config.imageModel || log.model);
        if (log.config.quality) updateConfig("quality", log.config.quality);
        if (log.config.size) updateConfig("size", log.config.size);
        if (log.config.count) updateConfig("count", log.config.count);
    };

    const ensureGenerationConfig = async (): Promise<AiConfig | null> => {
        let snapshotConfig: AiConfig = { ...effectiveConfig, model, count: "1" };
        if (!isAiConfigReady(snapshotConfig, snapshotConfig.model)) {
            const refreshed = await ensureRuntimeConfigForGeneration(snapshotConfig, snapshotConfig.model, isAiConfigReady);
            if (!refreshed) {
                message.warning(t("workbench.configFirst"));
                openConfigDialog(true);
                return null;
            }
            snapshotConfig = { ...refreshed, count: "1" };
        }
        return snapshotConfig;
    };

    const buildRequestSnapshot = async () => {
        const text = prompt.trim();
        if (!text) {
            message.error(t("imageWorkbench.promptRequired"));
            return null;
        }
        const snapshotConfig = await ensureGenerationConfig();
        if (!snapshotConfig) return null;
        return { text, config: snapshotConfig, references: [...references] };
    };

    const executeImageSlotRequest = async (params: {
        text: string;
        config: AiConfig;
        references: ReferenceImage[];
        clientTaskId?: string;
    }): Promise<GeneratedImage> => {
        const itemStartedAt = performance.now();
        const result = params.references.length
            ? await requestEdit(params.config, params.text, params.references, { clientTaskId: params.clientTaskId })
            : await requestGeneration(params.config, params.text, { clientTaskId: params.clientTaskId });
        const image = result[0];
        if (!image) throw new Error(t("imageWorkbench.missingResult"));
        const stored = await uploadImage(image.dataUrl, { sourceType: "ai_generated", existingStorageKey: image.storageKey });
        return {
            id: image.id,
            dataUrl: stored.url,
            ...(stored.storageKey ? { storageKey: stored.storageKey } : {}),
            durationMs: performance.now() - itemStartedAt,
            width: stored.width,
            height: stored.height,
            bytes: stored.bytes,
            mimeType: stored.mimeType,
        };
    };

    const runGenerationSlot = async (
        logId: string,
        index: number,
        snapshot: { text: string; config: AiConfig; references: ReferenceImage[] },
        clientTaskId?: string,
    ) => {
        try {
            const nextImage = await executeImageSlotRequest({ ...snapshot, clientTaskId });
            setLiveSingleJobs((prev) =>
                prev[logId]
                    ? { ...prev, [logId]: { ...prev[logId], results: updateResultAt(prev[logId].results, index, { status: "success", image: nextImage }) } }
                    : prev,
            );
            return nextImage;
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : t("workbench.generationFailed");
            setLiveSingleJobs((prev) =>
                prev[logId]
                    ? { ...prev, [logId]: { ...prev[logId], results: updateResultAt(prev[logId].results, index, { status: "failed", error: errMsg }) } }
                    : prev,
            );
            throw error;
        }
    };

    const convertBatchPlanToCustom = () => {
        if (!resolvedBatchPlan.tasks.length) {
            message.warning("请先在当前模式中添加至少 1 组任务");
            return;
        }
        setBatchCustomItems(
            resolvedBatchPlan.tasks.map((task) => createEmptyBatchItem(task.prompt, task.references)),
        );
        setBatchScenario("custom");
        message.success(`已将 ${resolvedBatchPlan.tasks.length} 组任务转入「自由队列」，可单独微调每项`);
    };

    const updateBatchJobGroups = (jobId: string, updater: (groups: BatchResultGroup[]) => BatchResultGroup[]) => {
        setLiveBatchJobs((prev) => (prev[jobId] ? { ...prev, [jobId]: { ...prev[jobId], groups: updater(prev[jobId].groups) } } : prev));
    };

    const generateBatch = async () => {
        if (resolvedBatchPlan.mismatchError) {
            message.error(resolvedBatchPlan.mismatchError);
            return;
        }
        if (resolvedBatchPlan.missingReason) {
            message.error(resolvedBatchPlan.missingReason);
            return;
        }
        if (!resolvedBatchPlan.tasks.length) {
            message.error("请先配置至少 1 组生成任务");
            return;
        }
        if (batchTotalImages > MAX_BATCH_IMAGES) {
            message.error(`单批次最多生成 ${MAX_BATCH_IMAGES} 张图片（当前预计 ${batchTotalImages} 张）`);
            return;
        }

        const snapshotConfig = await ensureGenerationConfig();
        if (!snapshotConfig) return;

        const jobId = nanoid();
        const perGroupCount = generationCount;
        const jobStartedAt = performance.now();
        const stopController = { stopped: false };
        batchStopControllersRef.current.set(jobId, stopController);

        const preparedGroups: BatchResultGroup[] = resolvedBatchPlan.tasks.map((task, idx) => ({
            id: `${task.id}-${idx}`,
            index: idx,
            prompt: task.prompt,
            references: task.references,
            status: "queued",
            results: Array.from({ length: perGroupCount }, () => ({ id: nanoid(), status: "pending" })),
        }));

        setPreviewLog(null);
        setBatchShowPreview(false);
        setActiveBatchJobId(jobId);
        setLiveBatchJobs((prev) => ({
            ...prev,
            [jobId]: {
                id: jobId,
                startedAt: jobStartedAt,
                running: true,
                groups: preparedGroups,
            },
        }));

        const groupState = preparedGroups.map((group) => ({
            group,
            slotTaskIds: Array.from({ length: perGroupCount }, () => nanoid()),
            startedAt: 0,
            remaining: perGroupCount,
            pendingLog: null as GenerationLog | null,
            successImages: [] as GeneratedImage[],
            failCount: 0,
            cancelledCount: 0,
        }));

        const finalizeGroupIfDone = (state: (typeof groupState)[number]) => {
            if (state.remaining > 0) return;
            const successCount = state.successImages.length;
            let nextStatus: BatchResultGroup["status"] = "failed";
            if (successCount === perGroupCount) nextStatus = "success";
            else if (successCount > 0) nextStatus = "partial";
            else if (state.cancelledCount === perGroupCount) nextStatus = "cancelled";

            updateBatchJobGroups(jobId, (prev) => prev.map((g) => (g.id === state.group.id ? { ...g, status: nextStatus } : g)));

            if (state.pendingLog) {
                activeLogIdsRef.current.delete(state.pendingLog.id);
                saveLog({
                    ...state.pendingLog,
                    durationMs: performance.now() - state.startedAt,
                    successCount,
                    failCount: perGroupCount - successCount,
                    status: successCount > 0 ? "success" : "failed",
                    images: state.successImages,
                });
            }
        };

        const slotTasks = groupState.flatMap((state, groupIndex) =>
            state.slotTaskIds.map((taskId, slotIndex) => ({
                groupIndex,
                slotIndex,
                taskId,
            })),
        );

        let totalSuccess = 0;
        let totalFail = 0;

        try {
            await runConcurrentQueue(
                slotTasks,
                batchConcurrency,
                async (task) => {
                    const state = groupState[task.groupIndex];
                    if (!state.pendingLog) {
                        state.startedAt = performance.now();
                        const logId = nanoid();
                        activeLogIdsRef.current.add(logId);
                        const pendingLog = buildLog({
                            id: logId,
                            prompt: state.group.prompt,
                            model,
                            config: { ...snapshotConfig, count: String(perGroupCount) },
                            references: state.group.references,
                            durationMs: 0,
                            successCount: 0,
                            failCount: 0,
                            status: "pending",
                            slotTaskIds: state.slotTaskIds,
                            images: [],
                        });
                        state.pendingLog = pendingLog;
                        saveLog(pendingLog);
                        updateBatchJobGroups(jobId, (prev) =>
                            prev.map((g) => (g.id === state.group.id ? { ...g, status: "pending", logId } : g)),
                        );
                    }

                    try {
                        const nextImage = await executeImageSlotRequest({
                            text: state.group.prompt,
                            config: snapshotConfig,
                            references: state.group.references,
                            clientTaskId: task.taskId,
                        });
                        state.successImages.push(nextImage);
                        totalSuccess += 1;
                        updateBatchJobGroups(jobId, (prev) =>
                            prev.map((g) =>
                                g.id === state.group.id
                                    ? { ...g, results: updateResultAt(g.results, task.slotIndex, { status: "success", image: nextImage }) }
                                    : g,
                            ),
                        );
                    } catch (error) {
                        state.failCount += 1;
                        totalFail += 1;
                        const errMsg = error instanceof Error ? error.message : t("workbench.generationFailed");
                        updateBatchJobGroups(jobId, (prev) =>
                            prev.map((g) =>
                                g.id === state.group.id
                                    ? { ...g, results: updateResultAt(g.results, task.slotIndex, { status: "failed", error: errMsg }) }
                                    : g,
                            ),
                        );
                    } finally {
                        state.remaining -= 1;
                        finalizeGroupIfDone(state);
                    }
                },
                () => stopController.stopped,
                (task) => {
                    const state = groupState[task.groupIndex];
                    state.cancelledCount += 1;
                    state.failCount += 1;
                    totalFail += 1;
                    updateBatchJobGroups(jobId, (prev) =>
                        prev.map((g) =>
                            g.id === state.group.id
                                ? { ...g, results: updateResultAt(g.results, task.slotIndex, { status: "failed", error: "已停止队列" }) }
                                : g,
                        ),
                    );
                    state.remaining -= 1;
                    finalizeGroupIfDone(state);
                },
            );

            if (stopController.stopped) {
                message.info(`已停止剩余队列，本次成功生成 ${totalSuccess} 张`);
            } else if (totalFail === 0) {
                message.success(`批量生成完成，共成功 ${totalSuccess} 张`);
            } else if (totalSuccess > 0) {
                message.warning(`批量生成完成：成功 ${totalSuccess} 张，失败 ${totalFail} 张`);
            } else {
                message.error("批量生成全部失败，请检查模型配置或提示词");
            }
        } finally {
            batchStopControllersRef.current.delete(jobId);
            groupState.forEach((state) => {
                if (state.pendingLog) activeLogIdsRef.current.delete(state.pendingLog.id);
            });
            setLiveBatchJobs((prev) => (prev[jobId] ? { ...prev, [jobId]: { ...prev[jobId], running: false } } : prev));
        }
    };

    const retryBatchSlot = async (jobId: string, groupId: string, slotIndex: number) => {
        const targetGroup = liveBatchJobs[jobId]?.groups.find((g) => g.id === groupId);
        if (!targetGroup) return;
        const snapshotConfig = await ensureGenerationConfig();
        if (!snapshotConfig) return;

        updateBatchJobGroups(jobId, (prev) =>
            prev.map((g) =>
                g.id === groupId
                    ? { ...g, status: "pending", results: updateResultAt(g.results, slotIndex, { status: "pending", error: undefined, image: undefined }) }
                    : g,
            ),
        );
        const retryStartedAt = performance.now();
        try {
            const image = await executeImageSlotRequest({
                text: targetGroup.prompt,
                config: snapshotConfig,
                references: targetGroup.references,
                clientTaskId: nanoid(),
            });
            updateBatchJobGroups(jobId, (prev) =>
                prev.map((g) => {
                    if (g.id !== groupId) return g;
                    const nextResults = updateResultAt(g.results, slotIndex, { status: "success", image });
                    const okCount = nextResults.filter((r) => r.status === "success").length;
                    const hasPending = nextResults.some((r) => r.status === "pending");
                    const nextStatus: BatchResultGroup["status"] = hasPending
                        ? "pending"
                        : okCount === nextResults.length
                          ? "success"
                          : okCount > 0
                            ? "partial"
                            : "failed";
                    return { ...g, status: nextStatus, results: nextResults };
                }),
            );
            saveLog(
                buildLog({
                    prompt: targetGroup.prompt,
                    model,
                    config: { ...snapshotConfig, count: "1" },
                    references: targetGroup.references,
                    durationMs: performance.now() - retryStartedAt,
                    successCount: 1,
                    failCount: 0,
                    status: "success",
                    images: [image],
                }),
            );
            message.success(t("workbench.retrySuccess"));
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : t("workbench.generationFailed");
            updateBatchJobGroups(jobId, (prev) =>
                prev.map((g) => {
                    if (g.id !== groupId) return g;
                    const nextResults = updateResultAt(g.results, slotIndex, { status: "failed", error: errMsg });
                    const okCount = nextResults.filter((r) => r.status === "success").length;
                    return { ...g, status: okCount > 0 ? "partial" : "failed", results: nextResults };
                }),
            );
        }
    };

    const loadGeneratedImageBlob = async (image: GeneratedImage): Promise<Blob | null> => {
        if (image.storageKey) {
            const localBlob = await getImageBlob(image.storageKey).catch(() => null);
            if (localBlob) return localBlob;
        }
        const url = image.dataUrl || (image.storageKey ? previewUrlFor(image.storageKey) : "");
        if (!url) {
            if (image.storageKey && !image.storageKey.startsWith("image:")) {
                return storageApi.downloadBlob(image.storageKey).catch(() => null);
            }
            return null;
        }
        const res = await fetch(url);
        return res.ok ? res.blob() : null;
    };

    const imageExtOf = (image: GeneratedImage) => image.mimeType?.split("/")[1]?.split("+")[0] || "png";

    const downloadAllBatchResults = async () => {
        const entries = batchGroups.flatMap((group) =>
            group.results
                .map((slot, slotIdx) => (slot.status === "success" && slot.image ? { groupIndex: group.index, slotIdx, image: slot.image } : null))
                .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
        );
        await downloadZip({
            entries: entries.map(({ groupIndex, slotIdx, image }) => ({
                filename: `batch-${String(groupIndex + 1).padStart(2, "0")}-${slotIdx + 1}.${imageExtOf(image)}`,
                loadBlob: () => loadGeneratedImageBlob(image),
            })),
            zipFilename: `image-batch-${Date.now()}.zip`,
            emptyWarning: "暂无可下载的生成图片",
        });
    };

    const downloadAllSingleResults = async () => {
        const images = displayedSingleResults
            .map((r) => (r.status === "success" && r.image ? r.image : null))
            .filter((img): img is GeneratedImage => Boolean(img));
        await downloadZip({
            entries: images.map((image, idx) => ({
                filename: `image-${idx + 1}.${imageExtOf(image)}`,
                loadBlob: () => loadGeneratedImageBlob(image),
            })),
            zipFilename: `image-results-${Date.now()}.zip`,
            emptyWarning: "当前结果中暂无可下载的图片",
        });
    };

    const downloadSelectedLogs = async () => {
        const selectedLogs = logs.filter((log) => selectedLogIds.includes(log.id));
        const entries = selectedLogs.flatMap((log, logIdx) =>
            log.images
                .filter((image) => Boolean(image.dataUrl || image.storageKey))
                .map((image, imgIdx) => ({
                    filename: `${log.title || `log-${logIdx + 1}`}-${imgIdx + 1}.${imageExtOf(image)}`,
                    loadBlob: () => loadGeneratedImageBlob(image),
                })),
        );
        await downloadZip({
            entries,
            zipFilename: `image-logs-${Date.now()}.zip`,
            emptyWarning: "所选记录中没有可下载的成功图片",
        });
    };

    const retryResult = async (index: number) => {
        const snapshot = await buildRequestSnapshot();
        if (!snapshot) return;
        const targetLogId = activeSingleLogId && liveSingleJobs[activeSingleLogId] ? activeSingleLogId : nanoid();
        const existingResults =
            activeSingleLogId && liveSingleJobs[activeSingleLogId]
                ? liveSingleJobs[activeSingleLogId].results
                : displayedSingleResults.length
                  ? displayedSingleResults
                  : [{ id: nanoid(), status: "pending" as const }];

        setPreviewLog(null);
        setActiveSingleLogId(targetLogId);
        setLiveSingleJobs((prev) => ({
            ...prev,
            [targetLogId]: {
                startedAt: performance.now(),
                running: true,
                results: updateResultAt(existingResults, index, { status: "pending", error: undefined, image: undefined }),
            },
        }));

        const retryStartedAt = performance.now();
        try {
            const image = await runGenerationSlot(targetLogId, index, snapshot, nanoid());
            saveLog(
                buildLog({
                    prompt: snapshot.text,
                    model,
                    config: { ...snapshot.config, count: "1" },
                    references: snapshot.references,
                    durationMs: performance.now() - retryStartedAt,
                    successCount: 1,
                    failCount: 0,
                    status: "success",
                    images: [image],
                }),
            );
            message.success(t("workbench.retrySuccess"));
        } catch {
            // runGenerationSlot has already marked the result as failed.
        } finally {
            setLiveSingleJobs((prev) =>
                prev[targetLogId] ? { ...prev, [targetLogId]: { ...prev[targetLogId], running: false } } : prev,
            );
        }
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[300px_minmax(0,1fr)] lg:overflow-hidden xl:grid-cols-[320px_minmax(0,1fr)]">
                <aside className="thin-scrollbar hidden min-h-0 overflow-y-auto rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:block">
                    <LogPanel
                        logs={logs}
                        selectedLogIds={selectedLogIds}
                        activeLogId={previewLog?.id}
                        onSelectedLogIdsChange={setSelectedLogIds}
                        onCreateSession={createSession}
                        onDownloadSelected={() => void downloadSelectedLogs()}
                        downloadingSelected={downloadingZip}
                        onDeleteSelected={() => setDeleteConfirmOpen(true)}
                        onPreviewLog={(log) => void previewGenerationLog(log)}
                    />
                </aside>

                <section className={`grid gap-3 lg:min-h-0 lg:overflow-hidden ${workbenchMode === "batch" ? "xl:grid-cols-[460px_minmax(0,1fr)]" : "xl:grid-cols-[420px_minmax(0,1fr)]"}`}>
                    <div className="thin-scrollbar flex flex-col rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto">
                        <div>
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">{t("imageWorkbench.title")}</h1>
                                    <CloudQuotaTag />
                                </div>
                                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                                    <Segmented
                                        size="small"
                                        value={workbenchMode}
                                        onChange={(val) => setWorkbenchMode(val as "single" | "batch")}
                                        options={[
                                            { label: "单次生图", value: "single" },
                                            { label: "批量生图", value: "batch" },
                                        ]}
                                    />
                                    <div className="flex gap-2 lg:hidden">
                                        <Button icon={<History className="size-4" />} onClick={() => setLogsOpen(true)}>
                                            {t("workbench.logs")}
                                        </Button>
                                        <Button icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                            {t("workbench.settings")}
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="mt-5 space-y-5">
                            {workbenchMode === "batch" ? (
                                <BatchEditorPanel
                                    scenario={batchScenario}
                                    onScenarioChange={(val) => {
                                        setBatchScenario(val);
                                        setBatchShowPreview(true);
                                    }}
                                    concurrency={batchConcurrency}
                                    onConcurrencyChange={setBatchConcurrency}
                                    sharedPrompt={batchSharedPrompt}
                                    onSharedPromptChange={(val) => {
                                        setBatchSharedPrompt(val);
                                        setBatchShowPreview(true);
                                    }}
                                    samePromptSlots={batchSamePromptSlots}
                                    onSamePromptSlotsChange={(updater) => {
                                        setBatchSamePromptSlots(updater);
                                        setBatchShowPreview(true);
                                    }}
                                    samePromptMismatchError={resolvedBatchPlan.mismatchError}
                                    sharedRefs={batchSharedRefs}
                                    onSharedRefsChange={(updater) => {
                                        setBatchSharedRefs(updater);
                                        setBatchShowPreview(true);
                                    }}
                                    multiPromptRaw={batchMultiPromptRaw}
                                    onMultiPromptRawChange={(val) => {
                                        setBatchMultiPromptRaw(val);
                                        setBatchShowPreview(true);
                                    }}
                                    splitMode={batchSplitMode}
                                    onSplitModeChange={(mode) => {
                                        setBatchSplitMode(mode);
                                        setBatchShowPreview(true);
                                    }}
                                    customItems={batchCustomItems}
                                    onCustomItemsChange={(updater) => {
                                        setBatchCustomItems(updater);
                                        setBatchShowPreview(true);
                                    }}
                                    onConvertToCustom={convertBatchPlanToCustom}
                                    previewTaskCount={resolvedBatchPlan.tasks.length}
                                    running={false}
                                    onOpenPromptDialog={(target) => {
                                        setPromptDialogTarget(target);
                                        setPromptDialogOpen(true);
                                    }}
                                    onOpenAssetPicker={(target) => {
                                        setAssetPickerTarget(target);
                                        setAssetPickerOpen(true);
                                    }}
                                />
                            ) : (
                                <>
                                    <div>
                                        <div className="mb-2 flex items-center justify-between gap-3">
                                            <span className="text-base font-semibold">{t("workbench.prompt")}</span>
                                            <div className="flex gap-2">
                                                <Button
                                                    size="small"
                                                    icon={<BookOpen className="size-3.5" />}
                                                    onClick={() => {
                                                        setPromptDialogTarget("single");
                                                        setPromptDialogOpen(true);
                                                    }}
                                                >
                                                    {t("workbench.viewPrompts")}
                                                </Button>
                                                <Button
                                                    size="small"
                                                    icon={<FolderPlus className="size-3.5" />}
                                                    onClick={() => {
                                                        setAssetPickerTarget({ mode: "single" });
                                                        setAssetPickerOpen(true);
                                                    }}
                                                >
                                                    {t("workbench.viewAssets")}
                                                </Button>
                                            </div>
                                        </div>
                                        <Input.TextArea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={7} placeholder={t("imageWorkbench.promptPlaceholder")} />
                                    </div>

                                    <div className="min-w-0">
                                        <div className="mb-2 flex items-center justify-between gap-3">
                                            <span className="text-base font-semibold">{t("imageWorkbench.references")}</span>
                                            <div className="flex gap-2">
                                                <Button size="small" icon={<ClipboardPaste className="size-3.5" />} loading={pastingRefs} onClick={() => void addReferencesFromClipboard()}>
                                                    {t("workbench.clipboard")}
                                                </Button>
                                                <Button size="small" icon={<Upload className="size-3.5" />} loading={uploadingRefs} onClick={() => fileInputRef.current?.click()}>
                                                    {uploadingRefs ? "上传中..." : t("workbench.upload")}
                                                </Button>
                                            </div>
                                        </div>
                                        <div
                                            className={`hover-scrollbar hover-scrollbar-hint relative flex min-h-24 w-full min-w-0 max-w-full gap-2 overflow-x-scroll overflow-y-hidden rounded-lg border border-dashed p-2 pb-3 overscroll-x-contain transition-colors ${isReferenceDragActive ? "border-stone-900 bg-stone-100/80 dark:border-stone-100 dark:bg-stone-900/80" : "border-stone-300 dark:border-stone-700"}`}
                                            onDragEnter={(event) => {
                                                event.preventDefault();
                                                dragDepthRef.current += 1;
                                                if (event.dataTransfer.types.includes("Files")) setIsReferenceDragActive(true);
                                            }}
                                            onDragOver={(event) => {
                                                event.preventDefault();
                                                event.dataTransfer.dropEffect = "copy";
                                            }}
                                            onDragLeave={(event) => {
                                                event.preventDefault();
                                                dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
                                                if (!dragDepthRef.current) setIsReferenceDragActive(false);
                                            }}
                                            onDrop={(event) => {
                                                event.preventDefault();
                                                dragDepthRef.current = 0;
                                                setIsReferenceDragActive(false);
                                                void addReferences(event.dataTransfer.files);
                                            }}
                                            onWheel={(event) => {
                                                if (event.currentTarget.scrollWidth <= event.currentTarget.clientWidth) return;
                                                event.preventDefault();
                                                event.currentTarget.scrollLeft += event.deltaY;
                                            }}
                                        >
                                            {references.map((item, index) => (
                                                <div key={item.id} className="group relative size-20 shrink-0 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
                                                    <img src={previewUrlFor(item.storageKey) || item.dataUrl} alt={item.name} className="size-full object-cover" />
                                                    <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">{imageReferenceLabel(index)}</span>
                                                    <ReferenceOrderButtons index={index} total={references.length} onMove={(offset) => setReferences((value) => moveListItem(value, index, offset))} />
                                                    <button
                                                        type="button"
                                                        className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded bg-black/60 text-white group-hover:flex"
                                                        onClick={() => setReferences((value) => value.filter((ref) => ref.id !== item.id))}
                                                        aria-label={t("imageWorkbench.removeReference")}
                                                    >
                                                        <Trash2 className="size-3.5" />
                                                    </button>
                                                </div>
                                            ))}
                                            {!references.length ? <div className="flex min-w-full items-center justify-center text-sm text-stone-500">{isReferenceDragActive ? t("imageWorkbench.dropReferences") : t("imageWorkbench.noReferences")}</div> : null}
                                        </div>
                                    </div>
                                </>
                            )}

                            <div className="flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-900 sm:hidden">
                                <span className="truncate text-stone-500 dark:text-stone-400">
                                    {modelOptionLabel(effectiveConfig, model)} · {effectiveConfig.size} · {effectiveConfig.quality}
                                </span>
                                <Button size="small" type="text" icon={<SlidersHorizontal className="size-4" />} onClick={() => setSettingsOpen(true)}>
                                    {t("workbench.adjust")}
                                </Button>
                            </div>

                            <div className="hidden gap-4 sm:grid sm:grid-cols-2">
                                <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                            </div>
                        </div>

                        <div className="mt-auto pt-6">
                            {workbenchMode === "batch" ? (
                                <div className="space-y-2">
                                    {resolvedBatchPlan.mismatchError || resolvedBatchPlan.missingReason ? (
                                        <div className="text-xs text-amber-600 dark:text-amber-400">
                                            {resolvedBatchPlan.mismatchError || resolvedBatchPlan.missingReason}
                                        </div>
                                    ) : batchTotalImages > MAX_BATCH_IMAGES ? (
                                        <div className="text-xs text-red-500">
                                            单批次最多生成 {MAX_BATCH_IMAGES} 张图片（当前 {resolvedBatchPlan.tasks.length} 组 × {generationCount} 张 = {batchTotalImages} 张）
                                        </div>
                                    ) : null}
                                    <Button
                                        type="primary"
                                        size="large"
                                        block
                                        icon={<Sparkles className="size-4" />}
                                        disabled={!batchCanGenerate}
                                        onClick={() => void generateBatch()}
                                    >
                                        开始批量生成（{resolvedBatchPlan.tasks.length} 组 × {generationCount} 张 = {batchTotalImages} 张）
                                    </Button>
                                </div>
                            ) : (
                                <Button type="primary" size="large" block icon={<Sparkles className="size-4" />} disabled={!canGenerate} onClick={() => void generate()}>
                                    {t("workbench.generate")}
                                </Button>
                            )}
                        </div>
                    </div>

                    <div className="thin-scrollbar rounded-lg border border-stone-200 bg-card p-4 shadow-sm dark:border-stone-800 lg:min-h-0 lg:overflow-y-auto lg:p-5">
                        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                            <div className="flex items-center gap-2">
                                <h2 className="text-xl font-semibold">
                                    {workbenchMode === "batch"
                                        ? !batchShowPreview && batchGroups.length
                                            ? "批量生成结果"
                                            : "待生成队列预览"
                                        : t("workbench.results")}
                                </h2>
                                {workbenchMode === "batch" && (batchShowPreview || !batchGroups.length) && resolvedBatchPlan.tasks.length ? (
                                    <Tag color="blue" className="m-0">
                                        {resolvedBatchPlan.tasks.length} 组 · 共 {batchTotalImages} 张
                                    </Tag>
                                ) : null}
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                {isCurrentViewRunning ? <Tag className="m-0 px-2 py-1">{t("workbench.waiting", { time: formatDuration(elapsedMs) })}</Tag> : null}
                                {totalRunningJobs > 0 && !isCurrentViewRunning ? (
                                    <Tag
                                        color="processing"
                                        className="m-0 cursor-pointer px-2 py-1"
                                        onClick={() => {
                                            if (runningBatchJobs.length) {
                                                setWorkbenchMode("batch");
                                                setActiveBatchJobId(runningBatchJobs[0].id);
                                                setBatchShowPreview(false);
                                            } else if (runningSingleJobs.length) {
                                                const runningLogId = Object.entries(liveSingleJobs).find(([, job]) => job.running)?.[0];
                                                if (runningLogId) {
                                                    setWorkbenchMode("single");
                                                    setActiveSingleLogId(runningLogId);
                                                }
                                            }
                                        }}
                                    >
                                        后台生成中：{totalRunningJobs} 个任务（点击查看）
                                    </Tag>
                                ) : null}
                                {workbenchMode === "batch" && batchGroups.length ? (
                                    <Button size="small" onClick={() => setBatchShowPreview((prev) => !prev)}>
                                        {batchShowPreview ? "查看当前批次结果" : "回到队列预览"}
                                    </Button>
                                ) : null}
                                {workbenchMode === "batch" && !batchShowPreview && activeBatchJob?.running ? (
                                    <Button
                                        size="small"
                                        danger
                                        icon={<Square className="size-3.5" />}
                                        onClick={() => {
                                            const ctrl = batchStopControllersRef.current.get(activeBatchJob.id);
                                            if (ctrl) ctrl.stopped = true;
                                            message.info("正在停止未开始的队列任务...");
                                        }}
                                    >
                                        停止队列
                                    </Button>
                                ) : null}
                                {workbenchMode === "batch" &&
                                !batchShowPreview &&
                                batchGroups.some((g) => g.results.some((r) => r.status === "success")) ? (
                                    <Button
                                        size="small"
                                        icon={<Download className="size-3.5" />}
                                        loading={downloadingZip}
                                        onClick={() => void downloadAllBatchResults()}
                                    >
                                        打包下载全部 ({batchGroups.reduce((sum, g) => sum + g.results.filter((r) => r.status === "success").length, 0)})
                                    </Button>
                                ) : null}
                                {workbenchMode === "single" &&
                                displayedSingleResults.some((r) => r.status === "success" && r.image) ? (
                                    <Button
                                        size="small"
                                        icon={<Download className="size-3.5" />}
                                        loading={downloadingZip}
                                        onClick={() => void downloadAllSingleResults()}
                                    >
                                        打包下载 ({displayedSingleResults.filter((r) => r.status === "success" && r.image).length})
                                    </Button>
                                ) : null}
                            </div>
                        </div>
                        {workbenchMode === "batch" ? (
                            !batchShowPreview && batchGroups.length ? (
                                <div className="space-y-4">
                                    {batchGroups.map((group) => {
                                        const okCount = group.results.filter((r) => r.status === "success").length;
                                        const statusTag =
                                            group.status === "success"
                                                ? { color: "green", text: `已完成 ${okCount}/${group.results.length}` }
                                                : group.status === "partial"
                                                  ? { color: "orange", text: `部分成功 ${okCount}/${group.results.length}` }
                                                  : group.status === "failed"
                                                    ? { color: "red", text: "全部失败" }
                                                    : group.status === "cancelled"
                                                      ? { color: "default", text: "已停止" }
                                                      : group.status === "pending"
                                                        ? { color: "blue", text: "生成中" }
                                                        : { color: "default", text: "排队中" };
                                        return (
                                            <div key={group.id} className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                                                    <div className="flex min-w-0 flex-1 items-center gap-2">
                                                        <Tag className="m-0 shrink-0" color="blue">
                                                            #{group.index + 1}
                                                        </Tag>
                                                        {group.references.slice(0, 4).map((ref, refIdx) => (
                                                            <img
                                                                key={ref.id}
                                                                src={previewUrlFor(ref.storageKey) || ref.dataUrl}
                                                                alt={ref.name}
                                                                title={`${imageReferenceLabel(refIdx)}: ${ref.name}`}
                                                                className="size-7 shrink-0 rounded border border-stone-200 object-cover dark:border-stone-700"
                                                            />
                                                        ))}
                                                        {group.references.length > 4 ? (
                                                            <Tag className="m-0 shrink-0">+{group.references.length - 4}</Tag>
                                                        ) : null}
                                                        <Tooltip title={group.prompt}>
                                                            <Typography.Text ellipsis className="min-w-0 flex-1 text-sm">
                                                                {group.prompt}
                                                            </Typography.Text>
                                                        </Tooltip>
                                                    </div>
                                                    <Tag className="m-0 shrink-0" color={statusTag.color}>
                                                        {statusTag.text}
                                                    </Tag>
                                                </div>
                                                <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                                                    {group.results.map((result, slotIdx) =>
                                                        result.status === "success" && result.image ? (
                                                            <ResultImageCard
                                                                key={result.id}
                                                                image={result.image}
                                                                index={slotIdx}
                                                                onEdit={(img, idx) => addResultToReferences(img, idx, true)}
                                                                onDownload={(img, idx) => saveAs(img.dataUrl, `batch-${group.index + 1}-${idx + 1}.png`)}
                                                                onSaveAsset={(img, idx) => saveResultToAssets(img, idx, group.prompt)}
                                                            />
                                                        ) : result.status === "failed" ? (
                                                            <FailedImageCard
                                                                key={result.id}
                                                                error={result.error || t("workbench.generationFailed")}
                                                                onRetry={() => activeBatchJob && void retryBatchSlot(activeBatchJob.id, group.id, slotIdx)}
                                                            />
                                                        ) : (
                                                            <PendingImageCard key={result.id} />
                                                        ),
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            ) : resolvedBatchPlan.tasks.length ? (
                                <div className="space-y-2.5">
                                    {resolvedBatchPlan.tasks.map((task, idx) => (
                                        <div key={task.id} className="flex flex-col gap-2 rounded-lg border border-stone-200 p-3 dark:border-stone-800 sm:flex-row sm:items-center sm:justify-between">
                                            <div className="flex min-w-0 flex-1 items-center gap-2.5">
                                                <Tag color="blue" className="m-0 shrink-0">
                                                    #{idx + 1}
                                                </Tag>
                                                {task.references.length ? (
                                                    <div className="flex shrink-0 items-center gap-1.5">
                                                        {task.references.map((ref, refIdx) => (
                                                            <div key={`${ref.id}-${refIdx}`} className="relative size-11 overflow-hidden rounded border border-stone-200 dark:border-stone-700">
                                                                <img src={previewUrlFor(ref.storageKey) || ref.dataUrl} alt={ref.name} className="size-full object-cover" />
                                                                <span className="absolute left-0.5 top-0.5 rounded bg-black/65 px-1 text-[9px] text-white">
                                                                    {imageReferenceLabel(refIdx)}
                                                                </span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                ) : (
                                                    <Tag className="m-0 shrink-0">纯文生图</Tag>
                                                )}
                                                <Typography.Paragraph ellipsis={{ rows: 2, tooltip: task.prompt }} className="!mb-0 min-w-0 flex-1 text-sm">
                                                    {task.prompt || <span className="text-stone-400">待填写提示词…</span>}
                                                </Typography.Paragraph>
                                            </div>
                                            <Tag className="m-0 shrink-0">将生成 {generationCount} 张</Tag>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 p-6 text-center dark:border-stone-700 lg:min-h-[560px]">
                                    <ImagePlus className="mb-3 size-11 text-stone-400" />
                                    <div className="mb-1 text-sm font-medium text-stone-700 dark:text-stone-200">
                                        {batchScenario === "same-prompt"
                                            ? "多图同词：第 1 步写共用提示词，第 2 步批量放入参考图"
                                            : batchScenario === "multi-prompt"
                                              ? "一图多词：第 1 步放共用参考图（可选），第 2 步输入多条提示词"
                                              : "自由队列：为每条任务单独配置提示词与参考图"}
                                    </div>
                                    <div className="max-w-md text-xs leading-5 text-stone-500 dark:text-stone-400">
                                        {batchScenario === "same-prompt"
                                            ? "左侧配置后，这里会实时列出配对好的每一组任务清单（含图1/图2/图3组合），确认无误即可一键批量生成。"
                                            : "左侧输入后，这里会实时列出即将生成的每一组任务清单，点击左下角即可排队并发生成。"}
                                    </div>
                                </div>
                            )
                        ) : displayedSingleResults.length ? (
                            <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
                                {displayedSingleResults.map((result, index) =>
                                    result.status === "success" && result.image ? (
                                        <ResultImageCard key={result.id} image={result.image} index={index} onEdit={addResultToReferences} onDownload={downloadImage} onSaveAsset={saveResultToAssets} />
                                    ) : result.status === "failed" ? (
                                        <FailedImageCard key={result.id} error={result.error || t("workbench.generationFailed")} onRetry={() => retryResult(index)} />
                                    ) : (
                                        <PendingImageCard key={result.id} />
                                    ),
                                )}
                            </div>
                        ) : (
                            <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-stone-300 text-center dark:border-stone-700 lg:min-h-[560px]">
                                <ImagePlus className="mb-4 size-11 text-stone-400" />
                                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("imageWorkbench.empty")} />
                            </div>
                        )}
                    </div>
                </section>
            </main>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    void addReferences(event.target.files);
                    event.target.value = "";
                }}
            />
            <Drawer title={t("workbench.logs")} placement="bottom" size="large" open={logsOpen} onClose={() => setLogsOpen(false)}>
                <LogPanel
                    logs={logs}
                    selectedLogIds={selectedLogIds}
                    activeLogId={previewLog?.id}
                    onSelectedLogIdsChange={setSelectedLogIds}
                    onCreateSession={createSession}
                    onDownloadSelected={() => void downloadSelectedLogs()}
                    downloadingSelected={downloadingZip}
                    onDeleteSelected={() => setDeleteConfirmOpen(true)}
                    onPreviewLog={(log) => void previewGenerationLog(log)}
                />
            </Drawer>
            <Drawer title={t("workbench.settings")} placement="bottom" size="82vh" open={settingsOpen} onClose={() => setSettingsOpen(false)}>
                <div className="grid grid-cols-2 gap-3 pb-4">
                    <GenerationSettings config={effectiveConfig} model={model} updateConfig={updateConfig} openConfigDialog={openConfigDialog} />
                </div>
            </Drawer>
            <PromptSelectDialog
                open={promptDialogOpen}
                onOpenChange={setPromptDialogOpen}
                onSelect={(selectedPrompt) => {
                    if (promptDialogTarget === "same-prompt") {
                        setBatchSharedPrompt(selectedPrompt);
                    } else if (promptDialogTarget === "multi-prompt") {
                        setBatchMultiPromptRaw((prev) => (prev.trim() ? `${prev.trim()}\n${selectedPrompt}` : selectedPrompt));
                    } else {
                        setPrompt(selectedPrompt);
                    }
                }}
            />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={insertPickedAsset} onClose={() => setAssetPickerOpen(false)} />
            <Modal
                title={t("workbench.deleteLogs")}
                open={deleteConfirmOpen}
                closable={!deletingLogs}
                maskClosable={!deletingLogs}
                confirmLoading={deletingLogs}
                onCancel={() => !deletingLogs && setDeleteConfirmOpen(false)}
                onOk={() => void deleteSelectedLogs()}
                okText={t("common.delete")}
                okButtonProps={{ danger: true }}
                cancelButtonProps={{ disabled: deletingLogs }}
                cancelText={t("common.cancel")}
            >
                {t("workbench.deleteLogsConfirm", { count: selectedLogIds.length })}
            </Modal>
        </div>
    );
}

function GenerationSettings({ config, model, updateConfig, openConfigDialog }: { config: AiConfig; model: string; updateConfig: UpdateAiConfig; openConfigDialog: (shouldPromptContinue?: boolean) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();

    return (
        <>
            <label className="col-span-2 block min-w-0 sm:col-span-1">
                <span className="mb-1.5 block text-sm font-semibold sm:mb-2 sm:text-base">{t("workbench.model")}</span>
                <ModelPicker config={config} value={model} onChange={(value) => updateConfig("imageModel", value)} capability="image" fullWidth onMissingConfig={() => openConfigDialog(false)} />
            </label>
            <div className="col-span-2">
                <ImageSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="space-y-4" maxCount={10} />
            </div>
        </>
    );
}

function ResultImageCard({
    image,
    index,
    onEdit,
    onDownload,
    onSaveAsset,
}: {
    image: GeneratedImage;
    index: number;
    onEdit: (image: GeneratedImage, index: number) => Promise<void>;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => Promise<void>;
}) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const [saving, setSaving] = useState(false);
    const [addingRef, setAddingRef] = useState(false);
    return (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <Image src={previewUrlFor(image.storageKey) || image.dataUrl} preview={{ src: image.dataUrl }} alt={t("imageWorkbench.resultAlt", { count: index + 1 })} className="aspect-square object-cover" />
            <div className="space-y-2 border-t border-stone-200 px-3 py-2.5 dark:border-stone-800">
                <div className="flex min-w-0 gap-x-2 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                    <span>
                        {image.width}x{image.height}
                    </span>
                    <span>{formatBytes(image.bytes)}</span>
                    <span>{formatDuration(image.durationMs)}</span>
                </div>
                <div className="grid min-w-0 grid-cols-3 gap-2">
                    <Tooltip title={t("common.addToAssets")}>
                        <Button
                            className={RESULT_ACTION_BUTTON_CLASS}
                            size="small"
                            icon={<FolderPlus className="size-3.5" />}
                            loading={saving}
                            onClick={async () => {
                                setSaving(true);
                                try {
                                    await onSaveAsset(image, index);
                                } finally {
                                    setSaving(false);
                                }
                            }}
                        >
                            {t("common.addToAssets")}
                        </Button>
                    </Tooltip>
                    <Tooltip title={t("imageWorkbench.addReference")}>
                        <Button
                            className={RESULT_ACTION_BUTTON_CLASS}
                            size="small"
                            icon={<PenLine className="size-3.5" />}
                            loading={addingRef}
                            onClick={async () => {
                                setAddingRef(true);
                                try {
                                    await onEdit(image, index);
                                } finally {
                                    setAddingRef(false);
                                }
                            }}
                        >
                            {t("imageWorkbench.addReference")}
                        </Button>
                    </Tooltip>
                    <Tooltip title={t("common.download")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(image, index)}>
                            {t("common.download")}
                        </Button>
                    </Tooltip>
                </div>
            </div>
        </div>
    );
}

function PendingImageCard() {
    const { t } = useTranslation();
    return (
        <div className="relative aspect-square overflow-hidden rounded-lg border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
            <div
                className="absolute inset-0 opacity-60"
                style={{
                    backgroundImage: "radial-gradient(circle, rgba(120,113,108,0.35) 1.4px, transparent 1.6px)",
                    backgroundSize: "16px 16px",
                }}
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                <LoaderCircle className="size-6 animate-spin" />
                <span>{t("workbench.generating")}</span>
            </div>
        </div>
    );
}

function FailedImageCard({ error, onRetry }: { error: string; onRetry: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="overflow-hidden rounded-lg border border-red-200 bg-red-50 dark:border-red-950 dark:bg-red-950/20">
            <div className="flex aspect-square flex-col items-center justify-center gap-3 p-5 text-center">
                <div className="text-sm font-medium text-red-600 dark:text-red-300">{t("workbench.failed")}</div>
                <Typography.Paragraph ellipsis={{ rows: 4 }} className="!mb-0 !text-xs !text-red-500 dark:!text-red-300">
                    {error}
                </Typography.Paragraph>
            </div>
            <div className="flex justify-end border-t border-red-200 p-3 dark:border-red-950">
                <Button size="small" danger onClick={onRetry}>
                    {t("workbench.retry")}
                </Button>
            </div>
        </div>
    );
}

function updateResultAt(results: GenerationResult[], index: number, next: Partial<GenerationResult>) {
    return results.map((item, itemIndex) => (itemIndex === index ? { ...item, ...next } : item));
}

function LogPanel({
    logs,
    selectedLogIds,
    activeLogId,
    downloadingSelected,
    onSelectedLogIdsChange,
    onCreateSession,
    onDownloadSelected,
    onDeleteSelected,
    onPreviewLog,
}: {
    logs: GenerationLog[];
    selectedLogIds: string[];
    activeLogId?: string;
    downloadingSelected?: boolean;
    onSelectedLogIdsChange: (ids: string[]) => void;
    onCreateSession: () => void;
    onDownloadSelected: () => void;
    onDeleteSelected: () => void;
    onPreviewLog: (log: GenerationLog) => void;
}) {
    const { t } = useTranslation();
    const allSelected = Boolean(logs.length) && selectedLogIds.length === logs.length;
    const toggleAll = () => onSelectedLogIdsChange(allSelected ? [] : logs.map((log) => log.id));

    return (
        <>
            <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold">{t("workbench.logs")}</h2>
                </div>
                <Tag className="m-0">{logs.length}</Tag>
            </div>
            <div className="mb-4 flex flex-wrap gap-2">
                <Button size="small" icon={<Plus className="size-3.5" />} onClick={onCreateSession}>
                    {t("workbench.new")}
                </Button>
                <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!logs.length} onClick={toggleAll}>
                    {allSelected ? t("common.cancel") : t("workbench.selectAll")}
                </Button>
                <Button size="small" icon={<Download className="size-3.5" />} loading={downloadingSelected} disabled={!selectedLogIds.length} onClick={onDownloadSelected}>
                    打包下载
                </Button>
                <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedLogIds.length} onClick={onDeleteSelected}>
                    {t("common.delete")}
                </Button>
            </div>
            <div className="space-y-3">
                {logs.map((log) => (
                    <LogCard
                        key={log.id}
                        log={log}
                        selected={selectedLogIds.includes(log.id)}
                        active={activeLogId === log.id}
                        onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))}
                        onClick={() => onPreviewLog(log)}
                    />
                ))}
                {!logs.length ? <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-stone-300 text-center text-sm text-stone-500 dark:border-stone-700">{t("workbench.noLogs")}</div> : null}
            </div>
        </>
    );
}

function LogCard({ log, selected, active, onSelectedChange, onClick }: { log: GenerationLog; selected: boolean; active: boolean; onSelectedChange: (checked: boolean) => void; onClick: () => void }) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const thumbnails = log.images.filter((image) => image.dataUrl).slice(0, 4);

    return (
        <button
            type="button"
            className={`block w-full rounded-lg border p-2 text-left transition ${active ? "border-stone-900 bg-blue-50 dark:border-stone-100 dark:bg-blue-950/20" : "border-stone-200 bg-background hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900"}`}
            onClick={onClick}
        >
            <div className="grid grid-cols-[minmax(128px,1fr)_auto] gap-2">
                <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
                    <Checkbox className="mt-0.5" checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => onSelectedChange(event.target.checked)} />
                    <div className="min-w-0">
                        <div className="truncate text-sm font-semibold leading-5">{log.title}</div>
                        {thumbnails.length ? (
                            <div className="mt-2 flex gap-1 overflow-hidden">
                                {thumbnails.map((image) => (
                                    <img key={image.id} src={previewUrlFor(image.storageKey) || image.dataUrl} alt="" className="size-8 shrink-0 rounded-md object-cover" />
                                ))}
                            </div>
                        ) : null}
                    </div>
                </div>
                <div className="grid justify-items-end gap-2">
                    <div className="flex gap-1">
                        {log.status === "pending" ? (
                            <Tag
                                className="m-0 flex h-6 items-center gap-1 rounded-md px-1.5 text-xs leading-none"
                                color="processing"
                                icon={<LoaderCircle className="size-3 animate-spin" />}
                            >
                                {t("workbench.generating")}
                            </Tag>
                        ) : (
                            <>
                                {log.successCount > 0 || log.status === "success" ? (
                                    <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="blue">
                                        {t("workbench.successCount", { count: log.successCount ?? log.imageCount })}
                                    </Tag>
                                ) : null}
                                {log.failCount > 0 || (log.status === "failed" && !log.successCount) ? (
                                    <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="red">
                                        {t("workbench.failCount", { count: log.failCount || log.imageCount || 1 })}
                                    </Tag>
                                ) : null}
                            </>
                        )}
                    </div>
                    <div className="flex flex-wrap justify-end gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{t("workbench.itemCount", { count: log.imageCount })}</Tag>
                        {log.status !== "pending" ? (
                            <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="green">
                                {formatDuration(log.durationMs)}
                            </Tag>
                        ) : null}
                    </div>
                    <div className="flex justify-end">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.time}</Tag>
                    </div>
                </div>
            </div>
        </button>
    );
}

async function readStoredLogs() {
    if (typeof window === "undefined") return [];
    try {
        const values: GenerationLog[] = [];
        await logStore.iterate<GenerationLog, void>((value) => {
            values.push(value);
        });
        const logs = await Promise.all(values.map(normalizeLog));
        return logs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch {
        return [];
    }
}

async function normalizeLog(log: Partial<GenerationLog>): Promise<GenerationLog> {
    const references = await Promise.all(
        (log.references || []).map(async (item) => {
            void ensureImagePreview(item.storageKey);
            return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        }),
    );
    const images = await Promise.all(
        (log.images || []).map(async (item) => {
            void ensureImagePreview(item.storageKey);
            return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        }),
    );
    const config = normalizeLogConfig(log);
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || i18n.t("workbench.untitled"),
        prompt: log.prompt || log.title || "",
        time: log.time || new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model: log.model || config.imageModel || "",
        config,
        references,
        durationMs: log.durationMs || 0,
        successCount: log.successCount ?? log.imageCount ?? 0,
        failCount: log.failCount || 0,
        imageCount: log.imageCount || log.successCount || 0,
        size: log.size || config.size || "",
        quality: log.quality || config.quality || "",
        status: log.status || "success",
        ...(log.slotTaskIds ? { slotTaskIds: log.slotTaskIds } : {}),
        images,
    };
}

function serializeLog(log: GenerationLog): GenerationLog {
    return {
        ...log,
        references: log.references.map((item) => ({ ...item, dataUrl: item.storageKey ? "" : item.dataUrl })),
        images: log.images.map((image) => ({ ...image, dataUrl: image.storageKey ? "" : image.dataUrl })),
    };
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    return {
        model: log.config?.model || log.model || "",
        imageModel: log.config?.imageModel || log.model || "",
        quality: log.config?.quality || log.quality || "",
        size: log.config?.size || log.size || "",
        count: log.config?.count || String(log.imageCount || log.successCount || 1),
    };
}

function moveListItem<T>(items: T[], index: number, offset: number) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= items.length) return items;
    const next = [...items];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    return next;
}

function ReferenceOrderButtons({ index, total, onMove }: { index: number; total: number; onMove: (offset: number) => void }) {
    if (total <= 1) return null;
    return (
        <div className="absolute inset-x-1 bottom-1 flex justify-between">
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowLeft className="size-3" />} disabled={index <= 0} onClick={() => onMove(-1)} />
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowRight className="size-3" />} disabled={index >= total - 1} onClick={() => onMove(1)} />
        </div>
    );
}

function buildLog({
    id,
    prompt,
    model,
    config,
    references,
    durationMs,
    successCount,
    failCount,
    status,
    slotTaskIds,
    images,
}: {
    id?: string;
    prompt: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    status: GenerationLog["status"];
    slotTaskIds?: string[];
    images: GeneratedImage[];
}): GenerationLog {
    const logConfig = {
        model: config.model,
        imageModel: config.imageModel,
        quality: config.quality,
        size: config.size,
        count: config.count,
    };
    return {
        id: id || nanoid(),
        createdAt: Date.now(),
        title: prompt.slice(0, 12) || i18n.t("workbench.untitled"),
        prompt,
        time: new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model,
        config: logConfig,
        references,
        durationMs,
        successCount,
        failCount,
        imageCount: Number(logConfig.count) || successCount,
        size: logConfig.size,
        quality: logConfig.quality,
        status,
        ...(slotTaskIds ? { slotTaskIds } : {}),
        images,
    };
}
