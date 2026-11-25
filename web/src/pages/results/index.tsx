/** 云端生成成果页面：列表仅加载云端缩略图，点击查看或下载时才按需加载原图/原视频。 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { App, Button, Card, Checkbox, Descriptions, Drawer, Empty, Image, Input, Pagination, Popconfirm, Progress, Result, Space, Spin, Tag, Typography } from "antd";
import { AudioLines, CheckSquare, Copy, Download, Eye, FolderPlus, HardDrive, ImageIcon, Play, RefreshCw, Search, Trash2, Video } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { useBatchZipDownload } from "@/hooks/use-batch-zip-download";
import { useCopyText } from "@/hooks/use-copy-text";
import { createImageThumbnail, createVideoThumbnail } from "@/lib/image-thumbnail";
import { formatBytes, formatStoragePair } from "@/lib/image-utils";
import { authApi, mediaDownloadFilename, storageApi, type MediaItem } from "@/services/api/server";
import { notifyCloudWorkspaceChanged, WORKSPACE_CHANGED_EVENT } from "@/services/cloud-media";
import { uploadMediaFile } from "@/services/file-storage";
import { getImagePreviewRevision, previewUrlFor, subscribeImagePreviews, uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";

const kindFilterValues = ["", "image", "video", "audio"] as const;

export default function ResultsPage() {
    const { message } = App.useApp();
    const { i18n, t } = useTranslation();
    const copyText = useCopyText();
    const navigate = useNavigate();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const user = useUserStore((state) => state.user);
    const accessToken = useUserStore((state) => state.accessToken);
    const addAsset = useAssetStore((state) => state.addAsset);

    const [items, setItems] = useState<MediaItem[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [kind, setKind] = useState("");
    const [keyword, setKeyword] = useState("");
    const [loading, setLoading] = useState(false);
    const [savingId, setSavingId] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [previewItem, setPreviewItem] = useState<MediaItem | null>(null);
    const [previewOriginalUrl, setPreviewOriginalUrl] = useState("");
    const [loadingOriginalId, setLoadingOriginalId] = useState<string | null>(null);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const { downloading: batchDownloading, downloadZip } = useBatchZipDownload();

    const loadResults = useCallback(async () => {
        if (!accessToken) return;
        setLoading(true);
        try {
            const res = await storageApi.list({
                sourceType: "ai_generated",
                kind: kind || undefined,
                q: keyword.trim() || undefined,
                page,
                pageSize,
            });
            setItems(res.items);
            setTotal(res.total ?? res.items.length);
            const loadedIds = new Set(res.items.map((entry) => entry.id));
            setSelectedIds((prev) => prev.filter((id) => loadedIds.has(id)));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("results.loadFailed"));
        } finally {
            setLoading(false);
        }
    }, [accessToken, keyword, kind, message, page, pageSize, t]);

    useEffect(() => {
        void loadResults();
    }, [loadResults]);

    useEffect(() => {
        const handleChanged = () => {
            void loadResults();
        };
        window.addEventListener(WORKSPACE_CHANGED_EVENT, handleChanged);
        window.addEventListener("infinite-canvas:cloud-workspace-synced", handleChanged);
        return () => {
            window.removeEventListener(WORKSPACE_CHANGED_EVENT, handleChanged);
            window.removeEventListener("infinite-canvas:cloud-workspace-synced", handleChanged);
        };
    }, [loadResults]);

    const resolveOriginalUrl = async (item: MediaItem) => {
        if (item.url) return item.url;
        const res = await storageApi.getUrl(item.id);
        return res.url;
    };

    const backfillCloudThumbnail = async (item: MediaItem, originalUrl: string) => {
        if (item.thumbnailUrl) return;
        try {
            let thumbBlob: Blob | undefined;
            if (item.kind === "image") {
                const res = await fetch(originalUrl);
                if (!res.ok) return;
                const blob = await res.blob();
                thumbBlob = (await createImageThumbnail(blob, 480).catch(() => undefined)) || blob;
            } else if (item.kind === "video") {
                thumbBlob = await createVideoThumbnail(originalUrl, 480).catch(() => undefined);
            }
            if (!thumbBlob) return;
            const uploaded = await storageApi.uploadThumbnail(item.id, thumbBlob);
            if (uploaded.thumbnailUrl) {
                setItems((prev) => prev.map((entry) => (entry.id === item.id ? { ...entry, thumbnailUrl: uploaded.thumbnailUrl } : entry)));
            }
        } catch {
            // ignore thumbnail backfill error
        }
    };

    const handleOpenPreview = async (item: MediaItem) => {
        setLoadingOriginalId(item.id);
        try {
            const url = await resolveOriginalUrl(item);
            if (!url) {
                message.error(t("results.linkUnavailable"));
                return;
            }
            setPreviewOriginalUrl(url);
            setPreviewItem(item);
            if (!item.thumbnailUrl && (item.kind === "image" || item.kind === "video")) {
                void backfillCloudThumbnail(item, url);
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("results.fetchFailed"));
        } finally {
            setLoadingOriginalId(null);
        }
    };

    const handleDownload = async (item: MediaItem) => {
        setLoadingOriginalId(item.id);
        try {
            const ext = item.mimeType?.split("/")[1]?.split("+")[0] || (item.kind === "video" ? "mp4" : item.kind === "audio" ? "mp3" : "png");
            await storageApi.downloadFile(item, `result-${item.id.replace(/:/g, "_")}.${ext}`);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("assets.downloadFailed"));
        } finally {
            setLoadingOriginalId(null);
        }
    };

    const allPageSelected = Boolean(items.length) && items.every((item) => selectedIds.includes(item.id));
    const toggleSelectAllPage = () => {
        setSelectedIds(allPageSelected ? [] : items.map((item) => item.id));
    };

    const handleBatchDownload = async () => {
        const targets = items.filter((item) => selectedIds.includes(item.id));
        await downloadZip({
            entries: targets.map((item) => ({
                filename: mediaDownloadFilename(item),
                loadBlob: () => storageApi.downloadBlob(item.id),
            })),
            zipFilename: `results-${Date.now()}.zip`,
        });
    };

    const handleSaveToAssets = async (item: MediaItem) => {
        setSavingId(item.id);
        try {
            const url = await resolveOriginalUrl(item);
            if (!url) return;
            const promptText = typeof item.meta?.prompt === "string" ? item.meta.prompt : "";
            const modelText = typeof item.meta?.model === "string" ? item.meta.model : "";
            const kindLabel = t(`results.kinds.${item.kind}`, { defaultValue: t("results.defaultKind") });
            const title = promptText ? promptText.slice(0, 32) : t("results.defaultResultName", { kind: kindLabel });
            if (item.kind === "image") {
                const stored = await uploadImage(url, { existingStorageKey: item.id, sourceType: "ai_generated" });
                addAsset({
                    kind: "image",
                    title,
                    coverUrl: stored.url,
                    tags: modelText ? [modelText] : [],
                    source: t("results.sourceName"),
                    data: {
                        dataUrl: stored.url,
                        storageKey: item.id,
                        width: item.width || stored.width,
                        height: item.height || stored.height,
                        bytes: item.bytes || stored.bytes,
                        mimeType: item.mimeType || stored.mimeType,
                    },
                    metadata: { source: "results", prompt: promptText, model: modelText },
                });
            } else if (item.kind === "video") {
                const stored = await uploadMediaFile(url, "video", { sourceType: "ai_generated" });
                addAsset({
                    kind: "video",
                    title,
                    coverUrl: "",
                    tags: modelText ? [modelText] : [],
                    source: t("results.sourceName"),
                    data: {
                        url: stored.url,
                        storageKey: stored.storageKey,
                        width: item.width || stored.width || 0,
                        height: item.height || stored.height || 0,
                        bytes: item.bytes || stored.bytes,
                        mimeType: item.mimeType || stored.mimeType,
                    },
                    metadata: { source: "results", prompt: promptText, model: modelText },
                });
            } else {
                message.warning(t("results.audioAssetUnsupported"));
                return;
            }
            message.success(t("common.addedToAssets"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("results.addAssetFailed"));
        } finally {
            setSavingId(null);
        }
    };

    const handleDelete = async (mediaId: string) => {
        setDeletingId(mediaId);
        try {
            await storageApi.remove(mediaId);
            void authApi
                .me()
                .then((res) => useUserStore.getState().setUser(res.user))
                .catch(() => undefined);
            notifyCloudWorkspaceChanged("media", { sync: false });
            message.success(t("results.deletedFreed"));
            void loadResults();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("results.deleteFailed"));
        } finally {
            setDeletingId(null);
        }
    };

    if (!user || !accessToken) {
        return (
            <div className="flex h-full items-center justify-center p-6">
                <Result
                    status="info"
                    title={t("results.loginTitle")}
                    subTitle={t("results.loginSubtitle")}
                    extra={
                        <Button type="primary" onClick={() => navigate("/auth?redirect=/results")}>
                            {t("results.goToLogin")}
                        </Button>
                    }
                />
            </div>
        );
    }

    const expired = Boolean(user.storageQuotaExpiresAt && new Date(user.storageQuotaExpiresAt).getTime() <= Date.now());
    const exceeded = expired || (user.storageQuotaBytes ?? 0) <= 0 || (user.storageUsedBytes ?? 0) >= (user.storageQuotaBytes ?? 0);

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-900 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-4 py-6 [background-size:16px_16px] sm:px-6 lg:px-10 dark:bg-[radial-gradient(rgba(245,245,244,.14)_1px,transparent_1px)]">
                <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-5 pb-6">
                    <div className="flex flex-col gap-4 border-b border-stone-200/80 pb-5 md:flex-row md:items-end md:justify-between dark:border-stone-800/80">
                        <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-3">
                                <h1 className="text-2xl font-semibold tracking-tight text-stone-950 dark:text-stone-100">{t("results.title")}</h1>
                                <div className="inline-flex flex-wrap items-center gap-2.5 rounded-full border border-stone-200 bg-background/90 px-3 py-1 text-xs shadow-xs dark:border-stone-800">
                                    <span className="inline-flex items-center gap-1.5 font-medium text-stone-700 dark:text-stone-200">
                                        <HardDrive className="size-3.5" />
                                        {t("assets.cloudQuotaLabel", { pair: formatStoragePair(user.storageUsedBytes, user.storageQuotaBytes) })}
                                    </span>
                                    <div className="w-20">
                                        <Progress
                                            percent={
                                                (user.storageQuotaBytes ?? 0) > 0
                                                    ? Math.min(100, Math.round(((user.storageUsedBytes ?? 0) / (user.storageQuotaBytes ?? 1)) * 100))
                                                    : 100
                                            }
                                            size="small"
                                            showInfo={false}
                                            status={exceeded ? "exception" : "active"}
                                        />
                                    </div>
                                    {expired ? (
                                        <Tag
                                            color="red"
                                            className="m-0 cursor-pointer"
                                            onClick={() => navigate(user.role === "admin" ? "/admin?tab=my-media" : "/console?tab=my-media")}
                                        >
                                            {t("assets.quotaExpiredAction")}
                                        </Tag>
                                    ) : exceeded ? (
                                        <Tag
                                            color="red"
                                            className="m-0 cursor-pointer"
                                            onClick={() => navigate(user.role === "admin" ? "/admin?tab=my-media" : "/console?tab=my-media")}
                                        >
                                            {t("assets.quotaExceededAction")}
                                        </Tag>
                                    ) : null}
                                    <Button
                                        type="link"
                                        size="small"
                                        className="!h-auto !p-0 text-xs"
                                        onClick={() => navigate(user.role === "admin" ? "/admin?tab=my-media" : "/console?tab=my-media")}
                                    >
                                        {t("assets.manageCloudMedia")}
                                    </Button>
                                </div>
                            </div>
                            <p className="mt-1.5 text-sm text-stone-500 dark:text-stone-400">
                                {t("results.description")}
                            </p>
                        </div>

                        <div className="w-full shrink-0 md:w-80 lg:w-96">
                            <Input.Search
                                className="w-full"
                                size="large"
                                allowClear
                                prefix={<Search className="size-4 text-stone-400" />}
                                placeholder={t("results.searchPlaceholder")}
                                onSearch={(val) => {
                                    setPage(1);
                                    setKeyword(val);
                                }}
                            />
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-medium text-stone-500 dark:text-stone-400">{t("results.typeLabel")}</span>
                            {kindFilterValues.map((value) => (
                                <Tag.CheckableTag
                                    key={value || "all"}
                                    checked={kind === value}
                                    onChange={() => {
                                        setPage(1);
                                        setKind(value);
                                    }}
                                >
                                    {t(`results.kinds.${value || "all"}`)}
                                </Tag.CheckableTag>
                            ))}
                        </div>
                        <Space wrap>
                            <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!items.length} onClick={toggleSelectAllPage}>
                                {allPageSelected ? t("common.deselectAll") : t("common.selectAllPage")}
                            </Button>
                            {selectedIds.length > 0 ? (
                                <Button
                                    size="small"
                                    type="primary"
                                    icon={<Download className="size-3.5" />}
                                    loading={batchDownloading}
                                    onClick={() => void handleBatchDownload()}
                                >
                                    {t("common.batchDownloadCount", { count: selectedIds.length })}
                                </Button>
                            ) : null}
                            <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={() => void loadResults()}>
                                {t("common.refresh")}
                            </Button>
                        </Space>
                    </div>
                </div>

                <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-5">
                    <Spin spinning={loading}>
                        {items.length ? (
                            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                                {items.map((item) => {
                                    const model = typeof item.meta?.model === "string" ? item.meta.model : "";
                                    const promptText = typeof item.meta?.prompt === "string" ? item.meta.prompt : "";
                                    const thumbSrc = item.thumbnailUrl || previewUrlFor(item.id) || "";
                                    const selected = selectedIds.includes(item.id);
                                    return (
                                        <Card
                                            key={item.id}
                                            hoverable
                                            className={`flex h-full flex-col overflow-hidden ${selected ? "ring-2 ring-stone-900 dark:ring-stone-100" : ""}`}
                                            styles={{ body: { padding: 14, flex: 1, display: "flex", flexDirection: "column" } }}
                                            cover={
                                                <div className="relative">
                                                    <div
                                                        className="absolute left-2.5 top-2.5 z-10 rounded-md bg-white/85 px-1.5 py-0.5 shadow-sm backdrop-blur dark:bg-stone-900/80"
                                                        onClick={(event) => event.stopPropagation()}
                                                    >
                                                        <Checkbox
                                                            checked={selected}
                                                            onChange={(event) =>
                                                                setSelectedIds((prev) =>
                                                                    event.target.checked
                                                                        ? Array.from(new Set([...prev, item.id]))
                                                                        : prev.filter((id) => id !== item.id),
                                                                )
                                                            }
                                                        />
                                                    </div>
                                                    {item.kind === "image" ? (
                                                        thumbSrc ? (
                                                            <button
                                                                type="button"
                                                                className="group relative block aspect-[4/3] w-full cursor-pointer overflow-hidden bg-stone-100 dark:bg-stone-900"
                                                                onClick={() => void handleOpenPreview(item)}
                                                            >
                                                                <img src={thumbSrc} alt={promptText || item.objectKey} loading="lazy" decoding="async" className="h-full w-full object-cover transition group-hover:scale-[1.02]" />
                                                            </button>
                                                        ) : (
                                                            <button
                                                                type="button"
                                                                className="flex aspect-[4/3] w-full cursor-pointer flex-col items-center justify-center gap-2 bg-stone-100 text-stone-500 transition hover:bg-stone-200/70 dark:bg-stone-900 dark:text-stone-400 dark:hover:bg-stone-800/70"
                                                                onClick={() => void handleOpenPreview(item)}
                                                            >
                                                                <ImageIcon className="size-7" />
                                                                <span className="text-xs">{t("results.clickViewImage")}</span>
                                                            </button>
                                                        )
                                                    ) : item.kind === "video" ? (
                                                        <button
                                                            type="button"
                                                            className="group relative flex aspect-[4/3] w-full cursor-pointer items-center justify-center overflow-hidden bg-stone-950 text-white"
                                                            onClick={() => void handleOpenPreview(item)}
                                                        >
                                                            {thumbSrc ? (
                                                                <img src={thumbSrc} alt={promptText || item.objectKey} loading="lazy" decoding="async" className="h-full w-full object-cover opacity-85 transition group-hover:scale-[1.02]" />
                                                            ) : (
                                                                <Video className="size-8 text-stone-400" />
                                                            )}
                                                            <span className="absolute flex size-11 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm transition group-hover:scale-105">
                                                                <Play className="ml-0.5 size-5 fill-current" />
                                                            </span>
                                                        </button>
                                                    ) : (
                                                        <button
                                                            type="button"
                                                            className="flex aspect-[4/3] w-full cursor-pointer flex-col items-center justify-center gap-2 bg-stone-100 text-stone-500 transition hover:bg-stone-200/70 dark:bg-stone-900 dark:text-stone-400 dark:hover:bg-stone-800/70"
                                                            onClick={() => void handleOpenPreview(item)}
                                                        >
                                                            <AudioLines className="size-8" />
                                                            <span className="text-xs">{t("results.clickPlayAudio")}</span>
                                                        </button>
                                                    )}
                                                </div>
                                            }
                                        >
                                            <div className="flex flex-1 flex-col gap-2">
                                                <div className="flex min-h-6 items-center gap-1.5 overflow-hidden">
                                                    <Tag className="m-0 shrink-0 text-[11px]">{t(`results.kinds.${item.kind}`, { defaultValue: item.kind })}</Tag>
                                                    {model ? (
                                                        <Tag color="blue" className="m-0 min-w-0 truncate text-[11px]">
                                                            {model}
                                                        </Tag>
                                                    ) : null}
                                                </div>
                                                <div className="min-h-10 flex-1">
                                                    {promptText ? (
                                                        <Typography.Paragraph ellipsis={{ rows: 2, tooltip: promptText }} className="!mb-0 text-xs leading-5">
                                                            {promptText}
                                                        </Typography.Paragraph>
                                                    ) : (
                                                        <Typography.Text type="secondary" ellipsis className="block font-mono text-xs leading-5">
                                                            {item.objectKey.split("/").pop() || item.id}
                                                        </Typography.Text>
                                                    )}
                                                </div>
                                                <div className="mt-auto space-y-2">
                                                    <Typography.Text
                                                        type="secondary"
                                                        ellipsis={{ tooltip: `${item.width && item.height ? `${item.width}x${item.height} · ` : ""}${formatBytes(item.bytes)} · ${new Date(item.createdAt).toLocaleString(i18n.resolvedLanguage)}` }}
                                                        className="block text-[11px]"
                                                    >
                                                        {item.width && item.height ? `${item.width}x${item.height} · ` : ""}
                                                        {formatBytes(item.bytes)} · {new Date(item.createdAt).toLocaleString(i18n.resolvedLanguage)}
                                                    </Typography.Text>
                                                    <div className="flex items-center justify-between gap-1.5 border-t border-black/5 pt-2 dark:border-white/5">
                                                        <div className="flex min-w-0 items-center gap-1.5">
                                                            <Button
                                                                size="small"
                                                                icon={<Eye className="size-3.5" />}
                                                                loading={loadingOriginalId === item.id}
                                                                onClick={() => void handleOpenPreview(item)}
                                                            >
                                                                {t("common.view")}
                                                            </Button>
                                                            {item.kind === "image" || item.kind === "video" ? (
                                                                <Button
                                                                    size="small"
                                                                    icon={<FolderPlus className="size-3.5" />}
                                                                    loading={savingId === item.id}
                                                                    onClick={() => void handleSaveToAssets(item)}
                                                                >
                                                                    {t("results.saveAsset")}
                                                                </Button>
                                                            ) : null}
                                                            <Button
                                                                size="small"
                                                                icon={<Download className="size-3.5" />}
                                                                loading={loadingOriginalId === item.id}
                                                                onClick={() => void handleDownload(item)}
                                                            >
                                                                {t("common.download")}
                                                            </Button>
                                                        </div>
                                                        <Popconfirm title={t("results.deleteConfirm")} onConfirm={() => void handleDelete(item.id)}>
                                                            <Button size="small" danger loading={deletingId === item.id} icon={<Trash2 className="size-3.5" />} />
                                                        </Popconfirm>
                                                    </div>
                                                </div>
                                            </div>
                                        </Card>
                                    );
                                })}
                            </div>
                        ) : (
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("results.empty")} className="py-20" />
                        )}
                    </Spin>

                    {total > 0 ? (
                        <div className="flex justify-center">
                            <Pagination
                                current={page}
                                pageSize={pageSize}
                                total={total}
                                showTotal={(count) => t("common.totalItems", { count })}
                                showSizeChanger
                                pageSizeOptions={[10, 20, 30, 50, 100]}
                                onChange={(nextPage, nextPageSize) => {
                                    setPage(nextPage);
                                    setPageSize(nextPageSize);
                                }}
                            />
                        </div>
                    ) : null}
                </div>
            </main>

            <Drawer
                title={t("results.drawerTitle")}
                open={Boolean(previewItem)}
                size="large"
                onClose={() => {
                    setPreviewItem(null);
                    setPreviewOriginalUrl("");
                }}
                destroyOnHidden
            >
                {previewItem && previewOriginalUrl
                    ? (() => {
                          const drawerModel = typeof previewItem.meta?.model === "string" ? previewItem.meta.model : "";
                          const drawerPrompt = typeof previewItem.meta?.prompt === "string" ? previewItem.meta.prompt : "";
                          const drawerModules = previewItem.modules || [];
                          return (
                              <div className="space-y-5">
                                  {previewItem.kind === "image" ? (
                                      <div className="overflow-hidden rounded-lg bg-stone-100 dark:bg-stone-900">
                                          <Image src={previewOriginalUrl} preview={{ src: previewOriginalUrl }} alt={drawerPrompt || previewItem.objectKey} className="max-h-[420px] w-full object-contain" />
                                      </div>
                                  ) : previewItem.kind === "video" ? (
                                      <video src={previewOriginalUrl} controls autoPlay className="aspect-video w-full rounded-lg bg-black" />
                                  ) : previewItem.kind === "audio" ? (
                                      <div className="flex flex-col items-center gap-4 rounded-lg border border-stone-200 bg-stone-50 p-6 dark:border-stone-800 dark:bg-stone-900">
                                          <AudioLines className="size-10 text-stone-400" />
                                          <audio src={previewOriginalUrl} controls autoPlay className="w-full" />
                                      </div>
                                  ) : null}

                                  <div className="flex flex-wrap items-center gap-1.5">
                                      <Tag className="m-0">{t(`results.kinds.${previewItem.kind}`, { defaultValue: previewItem.kind })}</Tag>
                                      {drawerModel ? (
                                          <Tag color="blue" className="m-0">
                                              {drawerModel}
                                          </Tag>
                                      ) : null}
                                      {drawerModules.map((mod) => (
                                          <Tag key={mod} color="cyan" className="m-0">
                                              {t(`results.modules.${mod}`, { defaultValue: mod })}
                                          </Tag>
                                      ))}
                                  </div>

                                  {drawerPrompt ? (
                                      <div className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                                          <div className="mb-2 flex items-center justify-between gap-2">
                                              <Typography.Text type="secondary" className="text-xs">
                                                  {t("results.promptLabel")}
                                              </Typography.Text>
                                              <Button size="small" type="text" icon={<Copy className="size-3.5" />} onClick={() => copyText(drawerPrompt, t("common.promptCopied"))}>
                                                  {t("common.copy")}
                                              </Button>
                                          </div>
                                          <div className="thin-scrollbar max-h-44 overflow-y-auto pr-1">
                                              <Typography.Paragraph className="!mb-0 whitespace-pre-wrap text-sm leading-6">
                                                  {drawerPrompt}
                                              </Typography.Paragraph>
                                          </div>
                                      </div>
                                  ) : null}

                                  <Descriptions column={1} bordered size="small" styles={{ label: { whiteSpace: "nowrap", width: 120 } }}>
                                      <Descriptions.Item label={t("results.resolutionDuration")}>
                                          {previewItem.width && previewItem.height ? `${previewItem.width} × ${previewItem.height}` : "—"}
                                          {previewItem.durationMs ? ` · ${(previewItem.durationMs / 1000).toFixed(1)}s` : ""}
                                      </Descriptions.Item>
                                      <Descriptions.Item label={t("results.fileSize")}>{formatBytes(previewItem.bytes)}</Descriptions.Item>
                                      <Descriptions.Item label={t("results.fileType")}>{previewItem.mimeType}</Descriptions.Item>
                                      <Descriptions.Item label={t("results.createdAt")}>{new Date(previewItem.createdAt).toLocaleString(i18n.resolvedLanguage)}</Descriptions.Item>
                                  </Descriptions>

                                  <div className="pt-3">
                                      <Space wrap>
                                          <Button
                                              type="primary"
                                              icon={<Download className="size-4" />}
                                              loading={loadingOriginalId === previewItem.id}
                                              onClick={() => void handleDownload(previewItem)}
                                          >
                                              {t("results.downloadOriginal")}
                                          </Button>
                                          {previewItem.kind === "image" || previewItem.kind === "video" ? (
                                              <Button
                                                  icon={<FolderPlus className="size-4" />}
                                                  loading={savingId === previewItem.id}
                                                  onClick={() => void handleSaveToAssets(previewItem)}
                                              >
                                                  {t("results.saveAsset")}
                                              </Button>
                                          ) : null}
                                          <Popconfirm
                                              title={t("results.deleteConfirm")}
                                              onConfirm={async () => {
                                                  await handleDelete(previewItem.id);
                                                  setPreviewItem(null);
                                                  setPreviewOriginalUrl("");
                                              }}
                                          >
                                              <Button danger icon={<Trash2 className="size-4" />} loading={deletingId === previewItem.id}>
                                                  {t("common.delete")}
                                              </Button>
                                          </Popconfirm>
                                      </Space>
                                  </div>
                              </div>
                          );
                      })()
                    : null}
            </Drawer>
        </div>
    );
}
