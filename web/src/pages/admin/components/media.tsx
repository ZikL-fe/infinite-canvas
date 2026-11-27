/** 管理后台媒体监控面板：查看全站云端媒体对象与用户画布/工作台数据，支持预览与清理。 */
import { useCallback, useEffect, useState } from "react";
import { App, Button, Card, Input, Select, Table, Tabs, Tag, Typography } from "antd";
import type { TFunction } from "i18next";
import { AudioLines, FileIcon, ImageIcon, RefreshCw, Video } from "lucide-react";
import { useTranslation } from "react-i18next";

import { getMediaThumbBytes } from "@/lib/image-utils";
import { formatBytes } from "@/pages/admin/admin-utils";
import { MediaPreviewModal } from "@/pages/admin/components/media-preview-modal";
import { ADMIN_TABLE_CLASS, ADMIN_TABLE_SCROLL, TableRowActions } from "@/pages/admin/components/table-row-actions";
import { getMediaModuleOptions, MediaModuleTags, WorkspaceSizeCell } from "@/pages/admin/user/shared";
import { adminApi, type MediaItem, type WorkspaceDataItem } from "@/services/api/server";
import { notifyCloudWorkspaceChanged, WORKSPACE_CHANGED_EVENT } from "@/services/cloud-media";
import { syncCloudWorkspace } from "@/services/cloud-sync";

function getKindLabel(kind: string, t: TFunction) {
    if (kind === "image" || kind === "video" || kind === "audio" || kind === "file") {
        return t(`userPanels.mediaKinds.${kind}`);
    }
    return kind;
}

export function AdminMediaMonitorPanel() {
    const { t, i18n } = useTranslation();
    const locale = i18n.resolvedLanguage || undefined;
    const { message } = App.useApp();

    const [subTab, setSubTab] = useState<"media" | "canvas" | "image_workbench" | "video_workbench">("media");
    const [totalStorageBytes, setTotalStorageBytes] = useState(0);
    const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
    const [mediaTotal, setMediaTotal] = useState(0);
    const [mediaFilteredBytes, setMediaFilteredBytes] = useState<number | null>(null);
    const [mediaPage, setMediaPage] = useState(1);
    const [mediaPageSize, setMediaPageSize] = useState(20);
    const [mediaQuery, setMediaQuery] = useState("");
    const [mediaKindFilter, setMediaKindFilter] = useState("");
    const [mediaModuleFilter, setMediaModuleFilter] = useState("");
    const [workspaceStats, setWorkspaceStats] = useState({ canvasProjects: 0, imageLogs: 0, videoLogs: 0 });
    const [mediaLoading, setMediaLoading] = useState(false);
    const [previewMediaItem, setPreviewMediaItem] = useState<MediaItem | null>(null);
    const [deletingMediaId, setDeletingMediaId] = useState<string | null>(null);

    const [workspaceItems, setWorkspaceItems] = useState<WorkspaceDataItem[]>([]);
    const [workspaceTotal, setWorkspaceTotal] = useState(0);
    const [workspacePage, setWorkspacePage] = useState(1);
    const [workspacePageSize, setWorkspacePageSize] = useState(20);
    const [workspaceQuery, setWorkspaceQuery] = useState("");
    const [workspaceLoading, setWorkspaceLoading] = useState(false);

    const loadTotalStorage = useCallback(async () => {
        try {
            const overview = await adminApi.getOverview(7);
            setTotalStorageBytes(overview.totalStorageBytes ?? 0);
        } catch {
            // ignore auxiliary stat error
        }
    }, []);

    const loadMedia = useCallback(
        async (page = mediaPage, q = mediaQuery, kind = mediaKindFilter, mod = mediaModuleFilter, pageSize = mediaPageSize, notifySuccess = false) => {
            setMediaLoading(true);
            try {
                const res = await adminApi.listMedia({ page, pageSize, q, kind, module: mod });
                setMediaItems(res.items);
                setMediaTotal(res.total);
                setMediaFilteredBytes(typeof res.filteredBytes === "number" ? res.filteredBytes : null);
                if (res.workspaceStats) setWorkspaceStats(res.workspaceStats);
                if (notifySuccess) message.success(t("common.refreshed"));
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("admin.messages.loadMediaFailed"));
            } finally {
                setMediaLoading(false);
            }
        },
        [mediaKindFilter, mediaModuleFilter, mediaPage, mediaPageSize, mediaQuery, message, t],
    );

    const loadWorkspaceData = useCallback(
        async (kind = subTab, page = workspacePage, q = workspaceQuery, pageSize = workspacePageSize, notifySuccess = false) => {
            if (kind === "media") return;
            setWorkspaceLoading(true);
            try {
                const res = await adminApi.listWorkspaceData({ kind, page, pageSize, q });
                setWorkspaceItems(res.items);
                setWorkspaceTotal(res.total);
                if (notifySuccess) message.success(t("common.refreshed"));
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("admin.messages.loadWorkspaceFailed"));
            } finally {
                setWorkspaceLoading(false);
            }
        },
        [message, subTab, t, workspacePage, workspacePageSize, workspaceQuery],
    );

    useEffect(() => {
        void loadTotalStorage();
    }, [loadTotalStorage]);

    useEffect(() => {
        void loadMedia(mediaPage, mediaQuery, mediaKindFilter, mediaModuleFilter, mediaPageSize);
    }, [loadMedia, mediaKindFilter, mediaModuleFilter, mediaPage, mediaPageSize, mediaQuery]);

    useEffect(() => {
        if (subTab === "media") return;
        void loadWorkspaceData(subTab, workspacePage, workspaceQuery, workspacePageSize);
    }, [loadWorkspaceData, subTab, workspacePage, workspacePageSize, workspaceQuery]);

    useEffect(() => {
        const handleChanged = () => {
            void loadMedia(mediaPage, mediaQuery, mediaKindFilter, mediaModuleFilter, mediaPageSize);
            void loadTotalStorage();
            if (subTab !== "media") {
                void loadWorkspaceData(subTab, workspacePage, workspaceQuery, workspacePageSize);
            }
        };
        window.addEventListener(WORKSPACE_CHANGED_EVENT, handleChanged);
        window.addEventListener("infinite-canvas:cloud-workspace-synced", handleChanged);
        return () => {
            window.removeEventListener(WORKSPACE_CHANGED_EVENT, handleChanged);
            window.removeEventListener("infinite-canvas:cloud-workspace-synced", handleChanged);
        };
    }, [loadMedia, loadTotalStorage, loadWorkspaceData, mediaKindFilter, mediaModuleFilter, mediaPage, mediaPageSize, mediaQuery, subTab, workspacePage, workspacePageSize, workspaceQuery]);

    const handleDeleteMedia = async (mediaId: string) => {
        if (deletingMediaId) return;
        setDeletingMediaId(mediaId);
        try {
            await adminApi.deleteMedia(mediaId);
            notifyCloudWorkspaceChanged("media", { sync: false });
            message.success(t("admin.messages.mediaDeleted"));
            void loadMedia();
            void loadTotalStorage();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("common.deleteFailed"));
        } finally {
            setDeletingMediaId(null);
        }
    };

    return (
        <>
            <Card
                title={
                    subTab !== "media"
                        ? t("admin.mediaTab.workspaceCardTitle", {
                              canvas: workspaceStats.canvasProjects,
                              image: workspaceStats.imageLogs,
                              video: workspaceStats.videoLogs,
                          })
                        : mediaQuery || mediaKindFilter || mediaModuleFilter
                          ? t("admin.mediaTab.filteredMediaTitle", {
                                total: mediaTotal,
                                filtered: formatBytes(mediaFilteredBytes ?? 0),
                                siteTotal: formatBytes(totalStorageBytes),
                            })
                          : t("admin.mediaTab.allMediaTitle", {
                                total: mediaTotal,
                                size: formatBytes(mediaFilteredBytes ?? totalStorageBytes),
                            })
                }
                extra={
                    subTab === "media" ? (
                        <div className="flex flex-wrap items-center gap-2">
                            <Select
                                value={mediaModuleFilter}
                                className="min-w-[125px] flex-1 sm:w-[130px]! sm:flex-none"
                                onChange={(value) => {
                                    setMediaPage(1);
                                    setMediaModuleFilter(value);
                                }}
                                options={getMediaModuleOptions(t)}
                            />
                            <Select
                                value={mediaKindFilter}
                                className="min-w-[115px] flex-1 sm:w-[120px]! sm:flex-none"
                                onChange={(value) => {
                                    setMediaPage(1);
                                    setMediaKindFilter(value);
                                }}
                                options={[
                                    { value: "", label: t("admin.mediaTab.allKinds") },
                                    { value: "image", label: t("userPanels.mediaKinds.image") },
                                    { value: "video", label: t("userPanels.mediaKinds.video") },
                                    { value: "audio", label: t("userPanels.mediaKinds.audio") },
                                    { value: "file", label: t("userPanels.mediaKinds.file") },
                                ]}
                            />
                            <Input.Search
                                allowClear
                                placeholder={t("admin.mediaTab.searchMediaPlaceholder")}
                                className="w-full! sm:w-[220px]!"
                                onSearch={(value) => {
                                    setMediaPage(1);
                                    setMediaQuery(value.trim());
                                }}
                            />
                            <Button
                                icon={<RefreshCw className="size-4" />}
                                loading={mediaLoading}
                                onClick={() => void loadMedia(mediaPage, mediaQuery, mediaKindFilter, mediaModuleFilter, mediaPageSize, true)}
                            >
                                {t("common.refresh")}
                            </Button>
                        </div>
                    ) : (
                        <div className="flex flex-wrap items-center gap-2">
                            <Input.Search
                                allowClear
                                placeholder={t("admin.mediaTab.searchWorkspacePlaceholder")}
                                className="w-full! sm:w-[220px]!"
                                onSearch={(value) => {
                                    setWorkspacePage(1);
                                    setWorkspaceQuery(value.trim());
                                }}
                            />
                            <Button
                                icon={<RefreshCw className="size-4" />}
                                loading={workspaceLoading}
                                onClick={() => void loadWorkspaceData(subTab, workspacePage, workspaceQuery, workspacePageSize, true)}
                            >
                                {t("common.refresh")}
                            </Button>
                        </div>
                    )
                }
            >
                <Tabs
                    activeKey={subTab}
                    onChange={(key) => {
                        setSubTab(key as "media" | "canvas" | "image_workbench" | "video_workbench");
                        setWorkspacePage(1);
                    }}
                    items={[
                        {
                            key: "media",
                            label: t("admin.mediaTab.tabMedia", { count: mediaTotal }),
                            children: (
                                <Table<MediaItem>
                                    rowKey="id"
                                    size="small"
                                    className={ADMIN_TABLE_CLASS}
                                    scroll={ADMIN_TABLE_SCROLL}
                                    loading={mediaLoading}
                                    dataSource={mediaItems}
                                    pagination={{
                                        current: mediaPage,
                                        pageSize: mediaPageSize,
                                        total: mediaTotal,
                                        showSizeChanger: true,
                                        pageSizeOptions: [10, 20, 30, 50, 100],
                                        showTotal: (count) => t("common.totalItems", { count }),
                                        onChange: (page, size) => {
                                            if (size !== mediaPageSize) {
                                                setMediaPageSize(size);
                                                setMediaPage(1);
                                            } else {
                                                setMediaPage(page);
                                            }
                                        },
                                    }}
                                    columns={[
                                        {
                                            title: t("admin.mediaTab.colPreview"),
                                            key: "preview",
                                            width: 64,
                                            render: (_, record) =>
                                                record.thumbnailUrl ? (
                                                    <img src={record.thumbnailUrl} alt={record.objectKey} className="size-8 shrink-0 rounded object-cover" />
                                                ) : (
                                                    <div className="flex size-8 shrink-0 items-center justify-center rounded bg-black/5 text-stone-400 dark:bg-white/10">
                                                        {record.kind === "video" ? <Video className="size-4" /> : record.kind === "audio" ? <AudioLines className="size-4" /> : record.kind === "image" ? <ImageIcon className="size-4" /> : <FileIcon className="size-4" />}
                                                    </div>
                                                ),
                                        },
                                        {
                                            title: t("admin.mediaTab.colObjectKey"),
                                            dataIndex: "objectKey",
                                            width: 220,
                                            render: (objectKey: string) => (
                                                <Typography.Text ellipsis={{ tooltip: objectKey }} className="block max-w-[205px] font-mono text-xs">
                                                    {objectKey}
                                                </Typography.Text>
                                            ),
                                        },
                                        { title: t("admin.mediaTab.colOwner"), dataIndex: "username", width: 110, ellipsis: true },
                                        {
                                            title: t("admin.mediaTab.colModule"),
                                            key: "modules",
                                            width: 155,
                                            render: (_, record) => <MediaModuleTags modules={record.modules} />,
                                        },
                                        {
                                            title: t("admin.mediaTab.colKind"),
                                            dataIndex: "kind",
                                            width: 80,
                                            render: (kind: string) => <Tag style={{ marginInlineEnd: 0 }}>{getKindLabel(kind, t)}</Tag>,
                                        },
                                        {
                                            title: t("admin.mediaTab.colMimeType"),
                                            dataIndex: "mimeType",
                                            width: 120,
                                            render: (mimeType: string) => (
                                                <Typography.Text type="secondary" ellipsis={{ tooltip: mimeType }} className="block max-w-[105px] font-mono text-xs">
                                                    {mimeType}
                                                </Typography.Text>
                                            ),
                                        },
                                        {
                                            title: t("admin.mediaTab.colSize"),
                                            dataIndex: "bytes",
                                            width: 95,
                                            render: (bytes: number) => <span className="whitespace-nowrap">{formatBytes(bytes)}</span>,
                                        },
                                        {
                                            title: t("admin.mediaTab.colThumbSize"),
                                            key: "thumbBytes",
                                            width: 100,
                                            render: (_, record: MediaItem) => {
                                                const thumbBytes = getMediaThumbBytes(record.meta);
                                                return <span className="whitespace-nowrap">{thumbBytes > 0 ? formatBytes(thumbBytes) : "—"}</span>;
                                            },
                                        },
                                        {
                                            title: t("admin.mediaTab.colUploadedAt"),
                                            dataIndex: "createdAt",
                                            width: 165,
                                            render: (value: string) => new Date(value).toLocaleString(locale),
                                        },
                                        {
                                            title: t("admin.channelsTab.colActions"),
                                            key: "actions",
                                            fixed: "right",
                                            width: 100,
                                            render: (_, record) => (
                                                <TableRowActions
                                                    items={[
                                                        ...(record.url
                                                            ? [
                                                                  {
                                                                      key: "view",
                                                                      label: t("common.view"),
                                                                      onClick: () => setPreviewMediaItem(record),
                                                                  },
                                                              ]
                                                            : []),
                                                        {
                                                            key: "delete",
                                                            label: t("common.delete"),
                                                            danger: true,
                                                            loading: deletingMediaId === record.id,
                                                            disabled: Boolean(deletingMediaId && deletingMediaId !== record.id),
                                                            confirm: t("admin.mediaTab.confirmDeleteMedia"),
                                                            onClick: () => void handleDeleteMedia(record.id),
                                                        },
                                                    ]}
                                                />
                                            ),
                                        },
                                    ]}
                                />
                            ),
                        },
                        ...(
                            [
                                { key: "canvas", label: t("admin.mediaTab.tabCanvas", { count: workspaceStats.canvasProjects }) },
                                { key: "image_workbench", label: t("admin.mediaTab.tabImageWorkbench", { count: workspaceStats.imageLogs }) },
                                { key: "video_workbench", label: t("admin.mediaTab.tabVideoWorkbench", { count: workspaceStats.videoLogs }) },
                            ] as const
                        ).map((tabCfg) => ({
                            key: tabCfg.key,
                            label: tabCfg.label,
                            children: (
                                <Table<WorkspaceDataItem>
                                    rowKey="id"
                                    size="small"
                                    className={ADMIN_TABLE_CLASS}
                                    scroll={ADMIN_TABLE_SCROLL}
                                    loading={workspaceLoading}
                                    dataSource={workspaceItems}
                                    pagination={{
                                        current: workspacePage,
                                        pageSize: workspacePageSize,
                                        total: workspaceTotal,
                                        showSizeChanger: true,
                                        pageSizeOptions: [10, 20, 30, 50, 100],
                                        showTotal: (count) => t("common.totalItems", { count }),
                                        onChange: (page, size) => {
                                            if (size !== workspacePageSize) {
                                                setWorkspacePageSize(size);
                                                setWorkspacePage(1);
                                            } else {
                                                setWorkspacePage(page);
                                            }
                                        },
                                    }}
                                    columns={[
                                        {
                                            title: tabCfg.key === "canvas" ? t("admin.mediaTab.colCanvasTitle") : t("admin.mediaTab.colPromptTitle"),
                                            key: "title",
                                            width: 260,
                                            render: (_, rec) => (
                                                <div className="max-w-[245px] truncate" title={rec.prompt || rec.title}>
                                                    {rec.prompt || rec.title}
                                                </div>
                                            ),
                                        },
                                        { title: t("admin.mediaTab.colOwner"), dataIndex: "username", width: 115, ellipsis: true },
                                        tabCfg.key === "canvas"
                                            ? { title: t("admin.mediaTab.colNodes"), dataIndex: "nodeCount", width: 85 }
                                            : { title: t("admin.mediaTab.colModel"), dataIndex: "model", width: 160, ellipsis: true },
                                        { title: t("admin.mediaTab.colLinkedMedia"), dataIndex: "mediaCount", width: 90, render: (v: number) => t("admin.mediaTab.linkedMediaCount", { count: v ?? 0 }) },
                                        {
                                            title: t("admin.mediaTab.colDataSize"),
                                            key: "mediaBytes",
                                            width: 140,
                                            render: (_, rec) => <WorkspaceSizeCell mediaBytes={rec.mediaBytes} dataBytes={rec.dataBytes} />,
                                        },
                                        { title: t("admin.mediaTab.colUpdatedAt"), dataIndex: "updatedAt", width: 165, render: (v: string) => new Date(v).toLocaleString(locale) },
                                        {
                                            title: t("admin.channelsTab.colActions"),
                                            key: "actions",
                                            fixed: "right",
                                            width: 85,
                                            render: (_, rec) => (
                                                <TableRowActions
                                                    items={[
                                                        {
                                                            key: "delete",
                                                            label: t("common.delete"),
                                                            danger: true,
                                                            confirm: t("admin.mediaTab.confirmDeleteWorkspace"),
                                                            onClick: () =>
                                                                void adminApi
                                                                    .deleteWorkspaceData(rec.kind, rec.id)
                                                                    .then(() => {
                                                                        message.success(t("admin.messages.workspaceDeleted"));
                                                                        const scope =
                                                                            rec.kind === "canvas"
                                                                                ? "canvas"
                                                                                : rec.kind === "image_workbench"
                                                                                  ? "image"
                                                                                  : "video";
                                                                        notifyCloudWorkspaceChanged(scope, { sync: true });
                                                                        void syncCloudWorkspace();
                                                                        void loadWorkspaceData();
                                                                        void loadMedia();
                                                                        void loadTotalStorage();
                                                                    })
                                                                    .catch((error) => {
                                                                        message.error(error instanceof Error ? error.message : t("common.deleteFailed"));
                                                                    }),
                                                        },
                                                    ]}
                                                />
                                            ),
                                        },
                                    ]}
                                />
                            ),
                        })),
                    ]}
                />
            </Card>

            <MediaPreviewModal media={previewMediaItem} onClose={() => setPreviewMediaItem(null)} />
        </>
    );
}
