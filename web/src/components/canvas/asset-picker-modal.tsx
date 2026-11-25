import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Empty, Input, Modal, Pagination, Tag } from "antd";
import { LoaderCircle, Search } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { ensureImagePreview, getImagePreviewRevision, previewUrlFor, subscribeImagePreviews } from "@/services/image-storage";
import { assetCoverUrl, useAssetStore, type Asset } from "@/stores/use-asset-store";

export type InsertAssetPayload = { kind: "text"; content: string; title: string } | { kind: "image"; dataUrl: string; title: string; storageKey?: string } | { kind: "video"; url: string; title: string; storageKey?: string; width?: number; height?: number };

type Props = {
    open: boolean;
    defaultTab?: string;
    onInsert: (payload: InsertAssetPayload) => void | Promise<void>;
    onClose: () => void;
};

export function AssetPickerModal({ open, onInsert, onClose }: Props) {
    const { t } = useTranslation();
    return (
        <Modal title={t("canvas.assetPicker.title")} open={open} onCancel={onClose} footer={null} width={860} destroyOnHidden styles={{ body: { padding: "0 24px 24px", minHeight: 480 } }}>
            <MyAssetsTab onInsert={onInsert} />
        </Modal>
    );
}

const PAGE_SIZE = 8;

const kindOptions = ["all", "text", "image", "video"];

function PickerCard({ title, kind, storageKey, cover, loading, disabled, onClick }: { title: string; kind: string; storageKey?: string; cover: string; loading?: boolean; disabled?: boolean; onClick: () => void }) {
    const { t } = useTranslation();
    const previewReady = previewUrlFor(storageKey);
    useEffect(() => {
        if (kind === "image" && storageKey && !previewReady) {
            void ensureImagePreview(storageKey);
        }
    }, [kind, previewReady, storageKey]);
    return (
        <button
            type="button"
            disabled={disabled}
            className={cn(
                "group relative overflow-hidden rounded-lg border border-stone-200 bg-white text-left transition dark:border-stone-700 dark:bg-stone-900",
                disabled ? (loading ? "cursor-wait border-stone-400 dark:border-stone-500" : "cursor-not-allowed opacity-60") : "cursor-pointer hover:border-stone-400 hover:shadow-md dark:hover:border-stone-500",
            )}
            onClick={onClick}
        >
            {cover ? (
                <img src={cover} alt={title} loading="lazy" decoding="async" className="aspect-[4/3] w-full object-cover" />
            ) : (
                <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-3 text-center text-xs leading-5 text-stone-500 dark:bg-stone-800 dark:text-stone-400">{title}</div>
            )}
            <div className="p-2.5">
                <div className="flex items-center justify-between gap-2">
                    <span className="line-clamp-1 text-xs font-medium text-stone-800 dark:text-stone-200">{title}</span>
                    <Tag className="m-0 shrink-0 text-[10px]">{t(`assets.kinds.${kind}`)}</Tag>
                </div>
            </div>
            <div
                className={cn(
                    "pointer-events-none absolute inset-0 flex items-center justify-center gap-1.5 text-sm font-medium text-white transition",
                    loading ? "bg-stone-950/60 opacity-100" : "bg-stone-950/0 opacity-0 group-hover:bg-stone-950/55 group-hover:opacity-100",
                )}
            >
                {loading ? (
                    <>
                        <LoaderCircle className="size-4 animate-spin" />
                        <span>{t("canvas.assetPicker.inserting")}</span>
                    </>
                ) : (
                    t("canvas.assetPicker.insert")
                )}
            </div>
        </button>
    );
}

function MyAssetsTab({ onInsert }: { onInsert: (payload: InsertAssetPayload) => void | Promise<void> }) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const assets = useAssetStore((state) => state.assets);
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState("all");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const [insertingId, setInsertingId] = useState<string | null>(null);

    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return assets
            .filter((a) => a.kind === "text" || a.kind === "image" || a.kind === "video")
            .filter((a) => kindFilter === "all" || a.kind === kindFilter)
            .filter((a) => !query || [a.title, ...(a.tags || [])].join(" ").toLowerCase().includes(query));
    }, [assets, keyword, kindFilter]);

    const visible = useMemo(() => filtered.slice((page - 1) * pageSize, page * pageSize), [filtered, page, pageSize]);

    useEffect(() => {
        const maxPage = Math.max(1, Math.ceil(filtered.length / pageSize));
        setPage((v) => Math.min(v, maxPage));
    }, [filtered.length, pageSize]);

    const handleInsert = async (asset: Asset) => {
        if (insertingId) return;
        setInsertingId(asset.id);
        try {
            if (asset.kind === "text") {
                await onInsert({ kind: "text", content: asset.data.content, title: asset.title });
            } else {
                await onInsert(asset.kind === "video" ? { kind: "video", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, width: asset.data.width, height: asset.data.height } : { kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title });
            }
        } finally {
            setInsertingId(null);
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <Input
                    className="w-56"
                    size="small"
                    prefix={<Search className="size-3.5 text-stone-400" />}
                    placeholder={t("canvas.assetPicker.search")}
                    value={keyword}
                    allowClear
                    onChange={(e) => {
                        setPage(1);
                        setKeyword(e.target.value);
                    }}
                />
                <div className="flex gap-1.5">
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

            {visible.length ? (
                <div className="grid grid-cols-4 gap-3">
                    {visible.map((asset) => (
                        <PickerCard
                            key={asset.id}
                            title={asset.title}
                            kind={asset.kind}
                            storageKey={asset.kind === "image" ? asset.data.storageKey : undefined}
                            cover={assetCoverUrl(asset)}
                            loading={insertingId === asset.id}
                            disabled={Boolean(insertingId)}
                            onClick={() => void handleInsert(asset)}
                        />
                    ))}
                </div>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("canvas.assetPicker.empty")} className="py-12" />
            )}

            {filtered.length > 0 && (
                <div className="flex justify-center">
                    <Pagination
                        size="small"
                        current={page}
                        pageSize={pageSize}
                        total={filtered.length}
                        showTotal={(count) => t("common.totalItems", { count })}
                        showSizeChanger
                        pageSizeOptions={[10, 20, 30, 50, 100]}
                        onChange={(nextPage, nextSize) => {
                            if (nextSize !== pageSize) {
                                setPageSize(nextSize);
                                setPage(1);
                            } else {
                                setPage(nextPage);
                            }
                        }}
                    />
                </div>
            )}
        </div>
    );
}
