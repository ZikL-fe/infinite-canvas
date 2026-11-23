/** 云端生成成果页面：列表仅加载云端缩略图，点击查看或下载时才按需加载原图/原视频。 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { App, Button, Card, Empty, Image, Input, Modal, Pagination, Popconfirm, Progress, Result, Space, Spin, Tag, Typography } from "antd";
import { AudioLines, Download, Eye, FolderPlus, HardDrive, ImageIcon, Play, RefreshCw, Search, Trash2, Video } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { createImageThumbnail, createVideoThumbnail } from "@/lib/image-thumbnail";
import { formatBytes, formatStoragePair } from "@/lib/image-utils";
import { storageApi, type MediaItem } from "@/services/api/server";
import { uploadMediaFile } from "@/services/file-storage";
import { getImagePreviewRevision, previewUrlFor, subscribeImagePreviews, uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";

const kindOptions = [
    { value: "", label: "全部" },
    { value: "image", label: "图片" },
    { value: "video", label: "视频" },
    { value: "audio", label: "音频" },
] as const;

const kindLabels: Record<string, string> = {
    image: "图片",
    video: "视频",
    audio: "音频",
    file: "文件",
};

export default function ResultsPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const user = useUserStore((state) => state.user);
    const accessToken = useUserStore((state) => state.accessToken);
    const addAsset = useAssetStore((state) => state.addAsset);

    const [items, setItems] = useState<MediaItem[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(12);
    const [kind, setKind] = useState("");
    const [keyword, setKeyword] = useState("");
    const [loading, setLoading] = useState(false);
    const [savingId, setSavingId] = useState<string | null>(null);
    const [previewItem, setPreviewItem] = useState<MediaItem | null>(null);
    const [previewOriginalUrl, setPreviewOriginalUrl] = useState("");
    const [loadingOriginalId, setLoadingOriginalId] = useState<string | null>(null);

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
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载云端成果失败");
        } finally {
            setLoading(false);
        }
    }, [accessToken, keyword, kind, message, page, pageSize]);

    useEffect(() => {
        void loadResults();
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
                message.error("文件链接暂不可用");
                return;
            }
            setPreviewOriginalUrl(url);
            setPreviewItem(item);
            if (!item.thumbnailUrl && (item.kind === "image" || item.kind === "video")) {
                void backfillCloudThumbnail(item, url);
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "获取原文件失败");
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
            message.error(error instanceof Error ? error.message : "下载失败，请稍后重试");
        } finally {
            setLoadingOriginalId(null);
        }
    };

    const handleSaveToAssets = async (item: MediaItem) => {
        setSavingId(item.id);
        try {
            const url = await resolveOriginalUrl(item);
            if (!url) return;
            const promptText = typeof item.meta?.prompt === "string" ? item.meta.prompt : "";
            const modelText = typeof item.meta?.model === "string" ? item.meta.model : "";
            const title = promptText ? promptText.slice(0, 32) : `${kindLabels[item.kind] || "生成"}成果`;
            if (item.kind === "image") {
                const stored = await uploadImage(url, { existingStorageKey: item.id, sourceType: "ai_generated" });
                addAsset({
                    kind: "image",
                    title,
                    coverUrl: stored.url,
                    tags: modelText ? [modelText] : [],
                    source: "云端成果",
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
                    source: "云端成果",
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
                message.warning("音频成果暂不支持加入资产库，可直接播放或下载");
                return;
            }
            message.success("已加入我的资产");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加入资产失败");
        } finally {
            setSavingId(null);
        }
    };

    const handleDelete = async (mediaId: string) => {
        try {
            await storageApi.remove(mediaId);
            message.success("已从云端删除并释放配额空间");
            void loadResults();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除失败");
        }
    };

    if (!user || !accessToken) {
        return (
            <div className="flex h-full items-center justify-center p-6">
                <Result
                    status="info"
                    title="登录后查看云端生成成果"
                    subTitle="画布与工作台生成的图片、视频与音频会自动保存至云端，即使网络卡顿或刷新页面也不会丢失。"
                    extra={
                        <Button type="primary" onClick={() => navigate("/auth?redirect=/results")}>
                            前往登录
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
            <main className="min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-6 py-8 [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.14)_1px,transparent_1px)]">
                <div className="pb-8">
                    <div className="mx-auto max-w-5xl text-center">
                        <h1 className="text-4xl font-semibold tracking-tight text-stone-950 dark:text-stone-100">云端生成成果</h1>
                        <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">
                            列表默认仅加载轻量化缩略图，点击查看或下载时再按需加载原图与原视频。
                        </p>
                        <div className="mx-auto mt-4 inline-flex flex-wrap items-center justify-center gap-3 rounded-full border border-stone-200 bg-background/90 px-4 py-1.5 text-xs shadow-sm dark:border-stone-800">
                            <span className="inline-flex items-center gap-1.5 font-medium text-stone-700 dark:text-stone-200">
                                <HardDrive className="size-3.5" />
                                云端存储配额：{formatStoragePair(user.storageUsedBytes, user.storageQuotaBytes)}
                            </span>
                            <div className="w-24">
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
                                <Tag color="red" className="m-0">
                                    配额已过期，请联系管理员续期
                                </Tag>
                            ) : exceeded ? (
                                <Tag color="red" className="m-0">
                                    配额不足，请联系管理员扩容
                                </Tag>
                            ) : null}
                            <Button
                                type="link"
                                size="small"
                                className="!h-auto !p-0 text-xs"
                                onClick={() => navigate(user.role === "admin" ? "/admin?tab=my-media" : "/console?tab=my-media")}
                            >
                                管理云端媒体
                            </Button>
                        </div>
                    </div>

                    <div className="mx-auto mt-8 w-full max-w-2xl">
                        <Input.Search
                            className="w-full"
                            size="large"
                            allowClear
                            prefix={<Search className="size-4 text-stone-400" />}
                            placeholder="搜索提示词、模型名称或文件路径"
                            onSearch={(val) => {
                                setPage(1);
                                setKeyword(val);
                            }}
                        />
                    </div>

                    <div className="mx-auto mt-6 flex max-w-7xl flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-medium text-stone-500 dark:text-stone-400">类型</span>
                            {kindOptions.map((option) => (
                                <Tag.CheckableTag
                                    key={option.value || "all"}
                                    checked={kind === option.value}
                                    onChange={() => {
                                        setPage(1);
                                        setKind(option.value);
                                    }}
                                >
                                    {option.label}
                                </Tag.CheckableTag>
                            ))}
                        </div>
                        <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={() => void loadResults()}>
                            刷新
                        </Button>
                    </div>
                </div>

                <div className="mx-auto flex max-w-7xl flex-col gap-5">
                    <Spin spinning={loading}>
                        {items.length ? (
                            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                                {items.map((item) => {
                                    const model = typeof item.meta?.model === "string" ? item.meta.model : "";
                                    const promptText = typeof item.meta?.prompt === "string" ? item.meta.prompt : "";
                                    const thumbSrc = item.thumbnailUrl || previewUrlFor(item.id) || "";
                                    return (
                                        <Card
                                            key={item.id}
                                            hoverable
                                            className="overflow-hidden"
                                            styles={{ body: { padding: 14 } }}
                                            cover={
                                                item.kind === "image" ? (
                                                    thumbSrc ? (
                                                        <button
                                                            type="button"
                                                            className="group relative block aspect-[4/3] w-full cursor-pointer overflow-hidden bg-stone-100 dark:bg-stone-900"
                                                            onClick={() => void handleOpenPreview(item)}
                                                        >
                                                            <img src={thumbSrc} alt={promptText || item.objectKey} className="h-full w-full object-cover transition group-hover:scale-[1.02]" />
                                                        </button>
                                                    ) : (
                                                        <button
                                                            type="button"
                                                            className="flex aspect-[4/3] w-full cursor-pointer flex-col items-center justify-center gap-2 bg-stone-100 text-stone-500 transition hover:bg-stone-200/70 dark:bg-stone-900 dark:text-stone-400 dark:hover:bg-stone-800/70"
                                                            onClick={() => void handleOpenPreview(item)}
                                                        >
                                                            <ImageIcon className="size-7" />
                                                            <span className="text-xs">点击查看原图</span>
                                                        </button>
                                                    )
                                                ) : item.kind === "video" ? (
                                                    <button
                                                        type="button"
                                                        className="group relative flex aspect-[4/3] w-full cursor-pointer items-center justify-center overflow-hidden bg-stone-950 text-white"
                                                        onClick={() => void handleOpenPreview(item)}
                                                    >
                                                        {thumbSrc ? (
                                                            <img src={thumbSrc} alt={promptText || item.objectKey} className="h-full w-full object-cover opacity-85 transition group-hover:scale-[1.02]" />
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
                                                        <span className="text-xs">点击试听音频</span>
                                                    </button>
                                                )
                                            }
                                        >
                                            <div className="flex flex-col gap-2">
                                                <div className="flex flex-wrap items-center gap-1.5">
                                                    <Tag className="m-0 text-[11px]">{kindLabels[item.kind] || item.kind}</Tag>
                                                    {model ? (
                                                        <Tag color="blue" className="m-0 max-w-[160px] truncate text-[11px]">
                                                            {model}
                                                        </Tag>
                                                    ) : null}
                                                </div>
                                                {promptText ? (
                                                    <Typography.Paragraph ellipsis={{ rows: 2, tooltip: promptText }} className="!mb-0 text-xs leading-5">
                                                        {promptText}
                                                    </Typography.Paragraph>
                                                ) : (
                                                    <Typography.Text type="secondary" ellipsis className="font-mono text-xs">
                                                        {item.objectKey.split("/").pop() || item.id}
                                                    </Typography.Text>
                                                )}
                                                <Typography.Text type="secondary" className="text-[11px]">
                                                    {item.width && item.height ? `${item.width}x${item.height} · ` : ""}
                                                    {formatBytes(item.bytes)} · {new Date(item.createdAt).toLocaleString("zh-CN")}
                                                </Typography.Text>
                                                <Space size={4} wrap className="pt-1">
                                                    <Button
                                                        size="small"
                                                        icon={<Eye className="size-3.5" />}
                                                        loading={loadingOriginalId === item.id}
                                                        onClick={() => void handleOpenPreview(item)}
                                                    >
                                                        查看
                                                    </Button>
                                                    {item.kind === "image" || item.kind === "video" ? (
                                                        <Button
                                                            size="small"
                                                            icon={<FolderPlus className="size-3.5" />}
                                                            loading={savingId === item.id}
                                                            onClick={() => void handleSaveToAssets(item)}
                                                        >
                                                            存资产
                                                        </Button>
                                                    ) : null}
                                                    <Button
                                                        size="small"
                                                        icon={<Download className="size-3.5" />}
                                                        loading={loadingOriginalId === item.id}
                                                        onClick={() => void handleDownload(item)}
                                                    >
                                                        下载
                                                    </Button>
                                                    <Popconfirm title="确定从云端删除该成果并释放空间吗？" onConfirm={() => void handleDelete(item.id)}>
                                                        <Button size="small" danger icon={<Trash2 className="size-3.5" />} />
                                                    </Popconfirm>
                                                </Space>
                                            </div>
                                        </Card>
                                    );
                                })}
                            </div>
                        ) : (
                            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无云端生成成果" className="py-20" />
                        )}
                    </Spin>

                    {total > 0 ? (
                        <div className="flex justify-center">
                            <Pagination
                                current={page}
                                pageSize={pageSize}
                                total={total}
                                showSizeChanger
                                pageSizeOptions={[12, 24, 48]}
                                onChange={(nextPage, nextPageSize) => {
                                    setPage(nextPage);
                                    setPageSize(nextPageSize);
                                }}
                            />
                        </div>
                    ) : null}
                </div>
            </main>

            <Modal
                open={Boolean(previewItem)}
                title={previewItem ? `${kindLabels[previewItem.kind] || "文件"}原图预览` : "预览"}
                onCancel={() => {
                    setPreviewItem(null);
                    setPreviewOriginalUrl("");
                }}
                footer={
                    previewItem ? (
                        <Space>
                            <Button icon={<Download className="size-4" />} loading={loadingOriginalId === previewItem.id} onClick={() => void handleDownload(previewItem)}>
                                下载原文件
                            </Button>
                            <Button
                                type="primary"
                                onClick={() => {
                                    setPreviewItem(null);
                                    setPreviewOriginalUrl("");
                                }}
                            >
                                关闭
                            </Button>
                        </Space>
                    ) : null
                }
                width={820}
                destroyOnHidden
            >
                {previewItem && previewOriginalUrl ? (
                    <div className="flex flex-col gap-3">
                        {previewItem.kind === "image" ? (
                            <div className="flex justify-center overflow-hidden rounded-lg bg-stone-100 p-2 dark:bg-stone-900">
                                <Image src={previewOriginalUrl} alt={previewItem.objectKey} className="max-h-[70vh] object-contain" />
                            </div>
                        ) : previewItem.kind === "video" ? (
                            <video src={previewOriginalUrl} controls autoPlay className="max-h-[70vh] w-full rounded-lg bg-black" />
                        ) : previewItem.kind === "audio" ? (
                            <div className="flex flex-col items-center gap-4 py-8">
                                <AudioLines className="size-10 text-stone-400" />
                                <audio src={previewOriginalUrl} controls autoPlay className="w-full max-w-md" />
                            </div>
                        ) : null}
                        <Typography.Text type="secondary" className="text-xs">
                            {previewItem.width && previewItem.height ? `${previewItem.width}x${previewItem.height} · ` : ""}
                            {formatBytes(previewItem.bytes)} · {previewItem.mimeType}
                        </Typography.Text>
                    </div>
                ) : null}
            </Modal>
        </div>
    );
}
