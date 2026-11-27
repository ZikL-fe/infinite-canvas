import { CheckSquare, Copy, Download, Eye, HardDrive, PencilLine, Search, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { App, Button, Card, Checkbox, Drawer, Empty, Form, Image, Input, Modal, Pagination, Popconfirm, Progress, Select, Space, Spin, Tag, Typography } from "antd";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { LoadingImage, LoadingVideo, MediaLoadBox } from "@/components/loading-media";
import { useBatchZipDownload } from "@/hooks/use-batch-zip-download";
import { useCopyText } from "@/hooks/use-copy-text";
import { formatBytes, formatStoragePair, readFileAsDataUrl } from "@/lib/image-utils";
import { getMediaBlob } from "@/services/file-storage";
import { deleteAssetsWithCloud, deleteAssetWithCloud, useCloudSyncing } from "@/services/cloud-sync";
import { ensureImagePreview, getImageBlob, getImagePreviewRevision, previewUrlFor, subscribeImagePreviews, uploadImage } from "@/services/image-storage";
import { cn } from "@/lib/utils";
import { assetCoverUrl, useAssetStore, type Asset, type AssetKind, type ImageAsset } from "@/stores/use-asset-store";
import { useUserStore } from "@/stores/use-user-store";
import { exportAssets, readAssetPackage } from "./asset-transfer";

type AssetFormValues = {
    kind: AssetKind;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    content?: string;
};

type ImageDraft = ImageAsset["data"] | null;

const kindOptions = ["all", "text", "image", "video"] as const;

export default function AssetsPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const copyText = useCopyText();
    const user = useUserStore((state) => state.user);
    const [form] = Form.useForm<AssetFormValues>();
    const coverInputRef = useRef<HTMLInputElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const assetInputRef = useRef<HTMLInputElement>(null);
    const assets = useAssetStore((state) => state.assets);
    const hydrated = useAssetStore((state) => state.hydrated);
    const cloudSyncing = useCloudSyncing();
    const addAsset = useAssetStore((state) => state.addAsset);
    const updateAsset = useAssetStore((state) => state.updateAsset);
    const [deleting, setDeleting] = useState(false);
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState<AssetKind | "all">("all");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const [editingAsset, setEditingAsset] = useState<Asset | null>(null);
    const [isAssetOpen, setIsAssetOpen] = useState(false);
    const [previewAsset, setPreviewAsset] = useState<Asset | null>(null);
    const [deletingAsset, setDeletingAsset] = useState<Asset | null>(null);
    const [formKind, setFormKind] = useState<AssetKind>("text");
    const [imageDraft, setImageDraft] = useState<ImageDraft>(null);
    const [uploadingImage, setUploadingImage] = useState(false);
    const [uploadingCover, setUploadingCover] = useState(false);
    const [importingAssets, setImportingAssets] = useState(false);
    const [exportingAssets, setExportingAssets] = useState(false);
    const [downloadingId, setDownloadingId] = useState<string | null>(null);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [batchDeleting, setBatchDeleting] = useState(false);
    const { downloading: batchDownloading, downloadZip } = useBatchZipDownload();
    const coverUrl = Form.useWatch("coverUrl", form) || "";
    const title = Form.useWatch("title", form) || "";
    const tags = Form.useWatch("tags", form) || [];
    const content = Form.useWatch("content", form) || "";
    const validAssets = useMemo(() => assets.filter((asset) => asset.kind === "text" || asset.kind === "image" || asset.kind === "video"), [assets]);

    const filteredAssets = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return validAssets.filter((asset) => {
            if (kindFilter !== "all" && asset.kind !== kindFilter) return false;
            if (!query) return true;
            return assetSearchText(asset).includes(query);
        });
    }, [validAssets, keyword, kindFilter]);

    const visibleAssets = useMemo(() => {
        const start = (page - 1) * pageSize;
        return filteredAssets.slice(start, start + pageSize);
    }, [filteredAssets, page, pageSize]);

    useEffect(() => {
        const maxPage = Math.max(1, Math.ceil(filteredAssets.length / pageSize));
        setPage((value) => Math.min(value, maxPage));
    }, [filteredAssets.length, pageSize]);

    useEffect(() => {
        const validIdSet = new Set(validAssets.map((asset) => asset.id));
        setSelectedIds((prev) => prev.filter((id) => validIdSet.has(id)));
    }, [validAssets]);

    const openCreate = () => {
        setEditingAsset(null);
        setImageDraft(null);
        setFormKind("text");
        form.setFieldsValue({ kind: "text", title: "", coverUrl: "", tags: [], source: t("assets.manual"), note: "", content: "" });
        setIsAssetOpen(true);
    };

    const openEdit = (asset: Asset) => {
        setEditingAsset(asset);
        setFormKind(asset.kind);
        setImageDraft(asset.kind === "image" ? asset.data : null);
        form.setFieldsValue({
            kind: asset.kind,
            title: asset.title,
            coverUrl: asset.coverUrl,
            tags: asset.tags || [],
            source: asset.source,
            note: asset.note,
            content: asset.kind === "text" ? asset.data.content : "",
        });
        setIsAssetOpen(true);
    };

    const saveAsset = async () => {
        const values = await form.validateFields();
        const base = {
            title: values.title.trim(),
            coverUrl: values.coverUrl?.trim() || (values.kind === "image" && imageDraft ? imageDraft.dataUrl : ""),
            tags: values.tags || [],
            source: values.source?.trim(),
            note: values.note?.trim(),
            metadata: editingAsset?.metadata || { source: "manual" },
        };

        if (values.kind === "text") {
            const asset = { ...base, kind: "text" as const, data: { content: (values.content || "").trim() } };
            editingAsset ? updateAsset(editingAsset.id, asset) : addAsset(asset);
        } else {
            if (!imageDraft) {
                message.error(t("assets.selectImage"));
                return;
            }
            const asset = { ...base, kind: "image" as const, data: imageDraft };
            editingAsset ? updateAsset(editingAsset.id, asset) : addAsset(asset);
        }

        message.success(editingAsset ? t("assets.updated") : t("assets.saved"));
        setIsAssetOpen(false);
    };

    const readCoverFile = async (file?: File) => {
        if (!file) return;
        setUploadingCover(true);
        try {
            const dataUrl = await readFileAsDataUrl(file);
            form.setFieldValue("coverUrl", dataUrl);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("common.imageReadFailed"));
        } finally {
            setUploadingCover(false);
        }
    };

    const readImageFile = async (file?: File) => {
        if (!file || !file.type.startsWith("image/")) return;
        setUploadingImage(true);
        try {
            const image = await uploadImage(file, { localOnly: true });
            const draft = { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType };
            setImageDraft(draft);
            if (!form.getFieldValue("coverUrl")) form.setFieldValue("coverUrl", draft.dataUrl);
            if (!form.getFieldValue("title")) form.setFieldValue("title", file.name);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("common.imageReadFailed"));
        } finally {
            setUploadingImage(false);
        }
    };

    const copyAssetText = async (asset: Asset) => {
        if (asset.kind !== "text") return;
        copyText(asset.data.content, t("assets.textCopied"));
    };

    const downloadImage = async (asset: Asset) => {
        if ((asset.kind !== "image" && asset.kind !== "video") || downloadingId) return;
        setDownloadingId(asset.id);
        const hide = message.loading(t("assets.downloadingResource"), 0);
        try {
            const blob = await readAssetMediaBlob(asset);
            if (!blob) {
                message.error(t("assets.downloadFailed"));
                return;
            }
            const ext = asset.data.mimeType?.split("/")[1]?.split("+")[0] || (asset.kind === "video" ? "mp4" : "png");
            saveAs(blob, `${asset.title || "asset"}.${ext}`);
            message.success(t("common.downloaded"));
        } catch {
            message.error(t("assets.downloadFailed"));
        } finally {
            hide();
            setDownloadingId(null);
        }
    };

    const exportAllAssets = async () => {
        if (!validAssets.length) {
            message.warning(t("assets.noneToExport"));
            return;
        }
        if (exportingAssets) return;
        setExportingAssets(true);
        const hide = message.loading(t("assets.exportingPackage"), 0);
        try {
            await exportAssets(validAssets, t("assets.packageName"));
            message.success(t("common.exported"));
        } catch {
            message.error(t("assets.exportFailed"));
        } finally {
            hide();
            setExportingAssets(false);
        }
    };

    const allPageSelected = Boolean(visibleAssets.length) && visibleAssets.every((asset) => selectedIds.includes(asset.id));
    const toggleSelectAllPage = () => {
        const pageIds = visibleAssets.map((asset) => asset.id);
        if (allPageSelected) {
            const pageSet = new Set(pageIds);
            setSelectedIds((prev) => prev.filter((id) => !pageSet.has(id)));
        } else {
            setSelectedIds((prev) => Array.from(new Set([...prev, ...pageIds])));
        }
    };

    const handleBatchDownload = async () => {
        const targets = validAssets.filter((asset) => selectedIds.includes(asset.id));
        await downloadZip({
            entries: targets.map((asset) => {
                if (asset.kind === "text") {
                    return {
                        filename: `${asset.title || "text-asset"}.txt`,
                        loadBlob: async () => new Blob([asset.data.content], { type: "text/plain;charset=utf-8" }),
                    };
                }
                const ext = asset.data.mimeType?.split("/")[1]?.split("+")[0] || (asset.kind === "video" ? "mp4" : "png");
                return {
                    filename: `${asset.title || "asset"}.${ext}`,
                    loadBlob: () => readAssetMediaBlob(asset),
                };
            }),
            zipFilename: `assets-batch-${Date.now()}.zip`,
        });
    };

    const importAssetZip = async (file?: File) => {
        if (!file) return;
        setImportingAssets(true);
        try {
            const importedAssets = await readAssetPackage(file);
            importedAssets.forEach((asset) => {
                const payload = { ...asset } as Record<string, unknown>;
                delete payload.id;
                delete payload.createdAt;
                delete payload.updatedAt;
                addAsset(payload as Parameters<typeof addAsset>[0]);
            });
            message.success(t("assets.imported", { count: importedAssets.length }));
        } catch {
            message.error(t("assets.importFailed"));
        } finally {
            setImportingAssets(false);
            if (assetInputRef.current) assetInputRef.current.value = "";
        }
    };

    const confirmDelete = async () => {
        if (!deletingAsset || deleting) return;
        setDeleting(true);
        try {
            await deleteAssetWithCloud(deletingAsset.id);
            message.success(t("assets.deleted"));
            setDeletingAsset(null);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("common.deleteFailed"));
        } finally {
            setDeleting(false);
        }
    };

    const handleBatchDelete = async () => {
        if (!selectedIds.length || batchDeleting) return;
        const deletingIds = [...selectedIds];
        setBatchDeleting(true);
        try {
            await deleteAssetsWithCloud(deletingIds);
            setSelectedIds([]);
            message.success(t("common.deletedCount", { count: deletingIds.length }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("common.deleteFailed"));
        } finally {
            setBatchDeleting(false);
        }
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-900 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-4 py-6 [background-size:16px_16px] sm:px-6 lg:px-10 dark:bg-[radial-gradient(rgba(245,245,244,.14)_1px,transparent_1px)]">
                <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-5 pb-6">
                    <div className="flex flex-col gap-4 border-b border-stone-200/80 pb-5 md:flex-row md:items-end md:justify-between dark:border-stone-800/80">
                        <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-3">
                                <h1 className="text-2xl font-semibold tracking-tight text-stone-950 dark:text-stone-100">{t("assets.title")}</h1>
                                {user ? (
                                    <div className="inline-flex flex-wrap items-center gap-2.5 rounded-full border border-stone-200 bg-background/90 px-3 py-1 text-xs shadow-xs dark:border-stone-800">
                                        {(() => {
                                            const expired = Boolean(user.storageQuotaExpiresAt && new Date(user.storageQuotaExpiresAt).getTime() <= Date.now());
                                            const exceeded = expired || (user.storageQuotaBytes ?? 0) <= 0 || (user.storageUsedBytes ?? 0) >= (user.storageQuotaBytes ?? 0);
                                            return (
                                                <>
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
                                                            onClick={() => navigate(user.role === "admin" ? "/admin/my-media" : "/console/my-media")}
                                                        >
                                                            {t("assets.quotaExpiredAction")}
                                                        </Tag>
                                                    ) : exceeded ? (
                                                        <Tag
                                                            color="red"
                                                            className="m-0 cursor-pointer"
                                                            onClick={() => navigate(user.role === "admin" ? "/admin/my-media" : "/console/my-media")}
                                                        >
                                                            {t("assets.quotaExceededAction")}
                                                        </Tag>
                                                    ) : null}
                                                    <Button
                                                        type="link"
                                                        size="small"
                                                        className="!h-auto !p-0 text-xs"
                                                        onClick={() => navigate(user.role === "admin" ? "/admin/my-media" : "/console/my-media")}
                                                    >
                                                        {t("assets.manageCloudMedia")}
                                                    </Button>
                                                </>
                                            );
                                        })()}
                                    </div>
                                ) : null}
                            </div>
                            <p className="mt-1.5 text-sm text-stone-500 dark:text-stone-400">{t("assets.description")}</p>
                        </div>

                        <div className="w-full shrink-0 md:w-80 lg:w-96">
                            <Input.Search
                                className="w-full"
                                size="large"
                                allowClear
                                prefix={<Search className="size-4 text-stone-400" />}
                                value={keyword}
                                placeholder={t("assets.search")}
                                onChange={(event) => {
                                    setPage(1);
                                    setKeyword(event.target.value);
                                }}
                                onSearch={(value) => {
                                    setPage(1);
                                    setKeyword(value);
                                }}
                            />
                        </div>
                    </div>

                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-medium text-stone-500 dark:text-stone-400">{t("assets.type")}</span>
                            <div className="flex flex-wrap gap-2">
                                {kindOptions.map((option) => (
                                    <Tag.CheckableTag
                                        key={option}
                                        checked={kindFilter === option}
                                        className={cn("prompt-filter-tag", kindFilter === option && "is-active")}
                                        onChange={() => {
                                            setPage(1);
                                            setKindFilter(option);
                                        }}
                                    >
                                        {option === "all" ? t("common.all") : t(`assets.kinds.${option}`)}
                                    </Tag.CheckableTag>
                                ))}
                            </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                            <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!visibleAssets.length} onClick={toggleSelectAllPage}>
                                {allPageSelected ? t("common.deselectAll") : t("common.selectAllPage")}
                            </Button>
                            {selectedIds.length > 0 ? (
                                <>
                                    <Button
                                        size="small"
                                        type="primary"
                                        icon={<Download className="size-3.5" />}
                                        loading={batchDownloading}
                                        disabled={batchDeleting}
                                        onClick={() => void handleBatchDownload()}
                                    >
                                        {t("common.batchDownloadCount", { count: selectedIds.length })}
                                    </Button>
                                    <Popconfirm
                                        title={t("assets.batchDeleteConfirm", { count: selectedIds.length })}
                                        okText={t("common.delete")}
                                        okButtonProps={{ danger: true }}
                                        cancelText={t("common.cancel")}
                                        onConfirm={() => void handleBatchDelete()}
                                    >
                                        <Button
                                            size="small"
                                            danger
                                            icon={<Trash2 className="size-3.5" />}
                                            loading={batchDeleting}
                                            disabled={batchDownloading}
                                        >
                                            {t("common.batchDeleteCount", { count: selectedIds.length })}
                                        </Button>
                                    </Popconfirm>
                                </>
                            ) : null}
                            <button
                                type="button"
                                disabled={exportingAssets}
                                className="cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline disabled:cursor-not-allowed disabled:opacity-50 dark:text-stone-300"
                                onClick={() => void exportAllAssets()}
                            >
                                {exportingAssets ? t("common.exporting") : t("assets.export")}
                            </button>
                            <button
                                type="button"
                                disabled={importingAssets}
                                className="cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline disabled:cursor-not-allowed disabled:opacity-50 dark:text-stone-300"
                                onClick={() => assetInputRef.current?.click()}
                            >
                                {importingAssets ? t("common.importing") : t("assets.import")}
                            </button>
                            <button
                                type="button"
                                className="cursor-pointer text-sm font-medium text-stone-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:underline dark:text-stone-300"
                                onClick={openCreate}
                            >
                                {t("assets.add")}
                            </button>
                        </div>
                    </div>
                </div>

                <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-5">
                    {!hydrated || (cloudSyncing && !validAssets.length) ? (
                        <div className="flex min-h-[280px] flex-col items-center justify-center gap-3 text-sm text-stone-500">
                            <Spin />
                            <span>{t("assets.loading")}</span>
                        </div>
                    ) : (
                        <>
                            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                                {visibleAssets.map((asset) => (
                                    <AssetCard
                                        key={asset.id}
                                        asset={asset}
                                        selected={selectedIds.includes(asset.id)}
                                        downloading={downloadingId === asset.id}
                                        onSelectedChange={(checked) =>
                                            setSelectedIds((prev) =>
                                                checked ? Array.from(new Set([...prev, asset.id])) : prev.filter((id) => id !== asset.id),
                                            )
                                        }
                                        onOpen={() => setPreviewAsset(asset)}
                                        onEdit={() => openEdit(asset)}
                                        onCopy={copyAssetText}
                                        onDownload={downloadImage}
                                        onDelete={() => setDeletingAsset(asset)}
                                    />
                                ))}
                            </div>

                            {!visibleAssets.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("assets.empty")} className="py-20" /> : null}
                        </>
                    )}

                    <div className="flex justify-center">
                        <Pagination
                            current={page}
                            pageSize={pageSize}
                            total={filteredAssets.length}
                            showTotal={(count) => t("common.totalItems", { count })}
                            showSizeChanger
                            pageSizeOptions={[10, 20, 30, 50, 100]}
                            onChange={(nextPage, nextPageSize) => {
                                setPage(nextPage);
                                setPageSize(nextPageSize);
                            }}
                        />
                    </div>
                </div>
            </main>

            <Modal
                title={editingAsset ? t("assets.edit") : t("assets.add")}
                open={isAssetOpen}
                width={980}
                onCancel={() => setIsAssetOpen(false)}
                onOk={() => void saveAsset()}
                okText={t("common.save")}
                okButtonProps={{ disabled: uploadingImage || uploadingCover }}
                cancelText={t("common.cancel")}
                destroyOnHidden
            >
                <div className="grid gap-6 pt-1 lg:grid-cols-[minmax(0,1fr)_320px]">
                    <Form form={form} layout="vertical" requiredMark={false} initialValues={{ kind: "text", tags: [] }}>
                        <Form.Item name="kind" label={t("assets.type")}>
                            <Select
                                options={[
                                    { label: t("assets.kinds.text"), value: "text" },
                                    { label: t("assets.kinds.image"), value: "image" },
                                ]}
                                onChange={(value) => setFormKind(value)}
                            />
                        </Form.Item>
                        <Form.Item name="title" label={t("assets.fields.title")} rules={[{ required: true, message: t("assets.fields.titleRequired") }]}>
                            <Input size="large" placeholder={t("assets.fields.titlePlaceholder")} />
                        </Form.Item>
                        <Form.Item name="coverUrl" label={t("assets.fields.coverUrl")}>
                            <Space.Compact className="w-full">
                                <Input placeholder={t("assets.fields.coverPlaceholder")} />
                                <Button icon={<Upload className="size-3.5" />} loading={uploadingCover} onClick={() => coverInputRef.current?.click()}>
                                    {uploadingCover ? t("common.uploadingEllipsis") : t("common.upload")}
                                </Button>
                            </Space.Compact>
                        </Form.Item>
                        <Form.Item name="tags" label={t("assets.fields.tags")}>
                            <Select mode="tags" tokenSeparators={[",", "，"]} placeholder={t("assets.fields.tagsPlaceholder")} />
                        </Form.Item>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <Form.Item name="source" label={t("assets.fields.source")}>
                                <Input placeholder={t("assets.fields.sourcePlaceholder")} />
                            </Form.Item>
                            <Form.Item name="note" label={t("assets.fields.note")}>
                                <Input placeholder={t("assets.fields.optional")} />
                            </Form.Item>
                        </div>
                        {formKind === "text" ? (
                            <Form.Item name="content" label={t("assets.fields.textContent")} rules={[{ required: true, message: t("assets.fields.textRequired") }]}>
                                <Input.TextArea rows={8} placeholder={t("assets.fields.textPlaceholder")} />
                            </Form.Item>
                        ) : (
                            <Form.Item label={t("assets.fields.imageContent")} required>
                                <div className="rounded-lg border border-dashed border-stone-300 p-4 dark:border-stone-700">
                                    <Button icon={<Upload className="size-4" />} loading={uploadingImage} onClick={() => imageInputRef.current?.click()}>
                                        {uploadingImage ? t("common.uploadingEllipsis") : t("assets.selectImageFile")}
                                    </Button>
                                    {uploadingImage ? (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            {t("assets.uploadingImageHint")}
                                        </Typography.Text>
                                    ) : imageDraft ? (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            {imageDraft.width}x{imageDraft.height} · {formatBytes(imageDraft.bytes)}
                                        </Typography.Text>
                                    ) : (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            {t("assets.noImageSelected")}
                                        </Typography.Text>
                                    )}
                                </div>
                            </Form.Item>
                        )}
                    </Form>
                    <div className="rounded-xl border border-stone-200 bg-stone-50 p-4 dark:border-stone-800 dark:bg-stone-950">
                        <Typography.Text strong>{t("assets.preview")}</Typography.Text>
                        <div className="mt-3 overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
                            {coverUrl || imageDraft?.dataUrl ? (
                                <LoadingImage src={coverUrl || imageDraft?.dataUrl} alt="" containerClassName="aspect-[4/3] w-full" className="h-full w-full object-cover" />
                            ) : (
                                <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-5 text-center text-sm text-stone-500 dark:bg-stone-900">{content || t("assets.noCover")}</div>
                            )}
                            <div className="p-4">
                                <Typography.Text strong ellipsis className="block">
                                    {title || t("assets.untitled")}
                                </Typography.Text>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                    {tags.length ? (
                                        tags.map((tag) => (
                                            <Tag key={tag} className="m-0">
                                                {tag}
                                            </Tag>
                                        ))
                                    ) : (
                                        <Tag className="m-0">{t("assets.untagged")}</Tag>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <input
                    ref={coverInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                        void readCoverFile(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
                <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                        void readImageFile(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
            </Modal>

            <AssetDrawer asset={previewAsset} downloading={Boolean(previewAsset && downloadingId === previewAsset.id)} onClose={() => setPreviewAsset(null)} onCopy={copyAssetText} onDownload={downloadImage} />

            <input ref={assetInputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importAssetZip(event.target.files?.[0])} />

            <Modal
                title={t("assets.deleteTitle")}
                open={Boolean(deletingAsset)}
                closable={!deleting}
                maskClosable={!deleting}
                confirmLoading={deleting}
                onCancel={() => !deleting && setDeletingAsset(null)}
                onOk={() => void confirmDelete()}
                okText={t("common.delete")}
                okButtonProps={{ danger: true }}
                cancelButtonProps={{ disabled: deleting }}
                cancelText={t("common.cancel")}
            >
                {t("assets.deleteConfirm", { name: deletingAsset?.title })}
            </Modal>
        </div>
    );
}

function AssetCard({ asset, selected, downloading, onSelectedChange, onOpen, onEdit, onCopy, onDownload, onDelete }: { asset: Asset; selected?: boolean; downloading?: boolean; onSelectedChange: (checked: boolean) => void; onOpen: () => void; onEdit: () => void; onCopy: (asset: Asset) => void; onDownload: (asset: Asset) => void; onDelete: () => void }) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const storageKey = asset.kind === "image" ? asset.data.storageKey : undefined;
    const previewReady = previewUrlFor(storageKey);
    useEffect(() => {
        if (storageKey && !previewReady) {
            void ensureImagePreview(storageKey);
        }
    }, [previewReady, storageKey]);
    const cover = assetCoverUrl(asset);
    const summary = assetSummary(asset);
    return (
        <Card
            hoverable
            className={`flex h-full flex-col overflow-hidden ${selected ? "!border-stone-900 outline-2 -outline-offset-2 outline-stone-900 dark:!border-stone-100 dark:outline-stone-100" : ""}`}
            styles={{ body: { padding: 0, flex: 1, display: "flex", flexDirection: "column" } }}
            cover={
                <div className="relative">
                    <div
                        className="absolute left-2.5 top-2.5 z-10 rounded-md bg-white/85 px-1.5 py-0.5 shadow-sm backdrop-blur dark:bg-stone-900/80"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <Checkbox checked={selected} onChange={(event) => onSelectedChange(event.target.checked)} />
                    </div>
                    <button type="button" className="block w-full text-left" onClick={onOpen}>
                        {cover || (asset.kind === "image" && storageKey && !previewReady) ? (
                            <LoadingImage
                                src={cover}
                                pending={!cover && Boolean(storageKey)}
                                alt={asset.title}
                                containerClassName="aspect-[4/3] w-full"
                                className="h-full w-full object-cover"
                                loading="lazy"
                            />
                        ) : (
                            <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-5 text-center text-sm leading-6 text-stone-600 dark:bg-stone-900 dark:text-stone-300">{asset.kind === "text" ? asset.data.content : t("assets.noCover")}</div>
                        )}
                    </button>
                </div>
            }
        >
            <button type="button" className="flex w-full flex-1 flex-col text-left" onClick={onOpen}>
                <div className="flex flex-1 flex-col p-3.5">
                    <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                            <h2 className="line-clamp-1 text-sm font-semibold text-stone-950 dark:text-stone-100">{asset.title}</h2>
                            <Typography.Text type="secondary" ellipsis className="mt-1 block text-xs">
                                {asset.source || t("assets.unknownSource")}
                            </Typography.Text>
                        </div>
                        <Tag className="m-0 shrink-0 text-[11px]">{t(`assets.kinds.${asset.kind}`)}</Tag>
                    </div>
                    <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }} className="!mb-0 !mt-2 min-h-10 !text-xs !leading-5">
                        {summary}
                    </Typography.Paragraph>
                    <div className="mt-auto flex flex-wrap gap-1.5 pt-2.5">
                        {(asset.tags || []).slice(0, 3).map((tag) => (
                            <Tag key={tag} className="m-0 max-w-[140px] truncate text-[11px]">
                                {tag}
                            </Tag>
                        ))}
                        {!asset.tags?.length ? <Tag className="m-0 text-[11px]">{t("assets.noTags")}</Tag> : null}
                    </div>
                </div>
            </button>
            <div className="mt-auto flex items-center justify-between gap-1.5 border-t border-black/5 px-3.5 py-2.5 dark:border-white/5">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <Button size="small" icon={<Eye className="size-3.5" />} onClick={onOpen}>
                        {t("common.view")}
                    </Button>
                    {asset.kind !== "video" ? (
                        <Button size="small" icon={<PencilLine className="size-3.5" />} onClick={onEdit}>
                            {t("common.edit")}
                        </Button>
                    ) : null}
                    {asset.kind === "text" ? (
                        <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => void onCopy(asset)}>
                            {t("common.copy")}
                        </Button>
                    ) : null}
                    {asset.kind === "image" || asset.kind === "video" ? (
                        <Button size="small" icon={<Download className="size-3.5" />} loading={downloading} onClick={() => onDownload(asset)}>
                            {t("common.download")}
                        </Button>
                    ) : null}
                </div>
                <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={onDelete} aria-label={t("common.delete")} title={t("common.delete")} />
            </div>
        </Card>
    );
}

function AssetDrawer({ asset, downloading, onClose, onCopy, onDownload }: { asset: Asset | null; downloading?: boolean; onClose: () => void; onCopy: (asset: Asset) => void; onDownload: (asset: Asset) => void }) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const cover = asset ? asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : "") : "";
    const displayCover = asset ? assetCoverUrl(asset) || cover : "";
    return (
        <Drawer title={t("assets.details")} open={Boolean(asset)} size="large" onClose={onClose}>
            {asset ? (
                <div className="space-y-5">
                    {displayCover ? (
                        <Image
                            src={displayCover}
                            preview={{ src: cover || displayCover }}
                            alt={asset.title}
                            rootClassName="block w-full overflow-hidden rounded-lg"
                            className="w-full rounded-lg"
                            placeholder={<MediaLoadBox kind="image" className="aspect-[4/3] w-full rounded-lg" />}
                        />
                    ) : (
                        <div className="rounded-lg border border-stone-200 bg-stone-50 p-5 text-sm leading-6 text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300">{asset.kind === "text" ? asset.data.content : t("assets.noCover")}</div>
                    )}
                    <div>
                        <Typography.Title level={4} className="!mb-2">
                            {asset.title}
                        </Typography.Title>
                        <Space size={[4, 4]} wrap>
                            <Tag>{t(`assets.kinds.${asset.kind}`)}</Tag>
                            {(asset.tags || []).map((tag) => (
                                <Tag key={tag}>{tag}</Tag>
                            ))}
                        </Space>
                    </div>
                    <div className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                        <Typography.Text type="secondary" className="block text-xs">
                            {t("assets.fields.textContent")}
                        </Typography.Text>
                        {asset.kind === "text" ? (
                            <Typography.Paragraph className="mt-2 whitespace-pre-wrap">{asset.data.content}</Typography.Paragraph>
                        ) : asset.kind === "video" ? (
                            <LoadingVideo
                                src={asset.data.url}
                                containerClassName="mt-2 aspect-video w-full overflow-hidden rounded-lg bg-black"
                                className="aspect-video w-full bg-black"
                            />
                        ) : (
                            <Typography.Text className="mt-2 block">
                                {asset.data.width}x{asset.data.height} · {formatBytes(asset.data.bytes)} · {asset.data.mimeType}
                            </Typography.Text>
                        )}
                    </div>
                    {asset.note ? (
                        <div>
                            <Typography.Text type="secondary">{t("assets.fields.note")}</Typography.Text>
                            <Typography.Paragraph className="mt-1">{asset.note}</Typography.Paragraph>
                        </div>
                    ) : null}
                    <Space>
                        {asset.kind === "text" ? (
                            <Button type="primary" icon={<Copy className="size-4" />} onClick={() => onCopy(asset)}>
                                {t("assets.copyText")}
                            </Button>
                        ) : null}
                        {asset.kind === "image" || asset.kind === "video" ? (
                            <Button type="primary" icon={<Download className="size-4" />} loading={downloading} onClick={() => onDownload(asset)}>
                                {asset.kind === "video" ? t("assets.downloadVideo") : t("assets.downloadImage")}
                            </Button>
                        ) : null}
                    </Space>
                </div>
            ) : null}
        </Drawer>
    );
}

async function readAssetMediaBlob(asset: Extract<Asset, { kind: "image" | "video" }>) {
    const storageKey = asset.data.storageKey;
    if (storageKey) {
        const stored = asset.kind === "image" ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
        if (stored) return stored;
    }
    const url = asset.kind === "video" ? asset.data.url : asset.data.dataUrl || asset.coverUrl;
    if (!url) return null;
    const response = await fetch(url);
    return response.ok ? response.blob() : null;
}

function assetSummary(asset: Asset) {
    if (asset.kind === "text") return asset.data.content;
    return `${asset.data.width}x${asset.data.height} · ${formatBytes(asset.data.bytes)} · ${asset.data.mimeType}`;
}

function assetSearchText(asset: Asset) {
    return [asset.title, asset.source || "", asset.note || "", (asset.tags || []).join(" "), asset.kind === "text" ? asset.data.content : asset.data.mimeType].join(" ").toLowerCase();
}
