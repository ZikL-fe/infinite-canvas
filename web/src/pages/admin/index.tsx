/** 后台管理与个人后台入口页：采用左侧导航菜单与全宽内容区，管理员支持平台全局管控与个人中心切换。 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Alert, App, Button, Card, Col, DatePicker, Descriptions, Drawer, Form, Image, Input, InputNumber, Menu, Modal, Popconfirm, Progress, Radio, Result, Row, Select, Space, Statistic, Switch, Table, Tabs, Tag, Tooltip, Typography, Upload, theme as antdTheme } from "antd";
import type { MenuProps, UploadProps } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { AudioLines, Copy, Coins, Cpu, Database, Download, FileIcon, FolderKanban, Gift, HardDrive, ImageIcon, LayoutDashboard, Mail, Megaphone, Menu as MenuIcon, Plus, RefreshCw, ScrollText, Send, Shield, Sliders, Trash2, UploadCloud, UserCheck, Users, Video, Wifi } from "lucide-react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { ChannelEditorDrawer } from "@/components/layout/channel-editor-drawer";
import { ADMIN_TABLE_CLASS, ADMIN_TABLE_SCROLL, TableRowActions } from "@/pages/admin/components/table-row-actions";
import { AnnouncementsCard, ConsumptionTrendCard, MEDIA_MODULE_OPTIONS, MediaModuleTags, MyMediaPanel, MyWalletPanel, ProfileSecurityPanel, UsageLogsPanel, UserOverviewPanel, WorkspaceSizeCell } from "@/pages/admin/user-panels";
import { useCopyText } from "@/hooks/use-copy-text";
import {
    adminApi,
    storageApi,
    type AdminChannelItem,
    type AdminMailSettingsForm,
    type AdminOverview,
    type AdminUserItem,
    type AnnouncementItem,
    type MediaItem,
    type RedeemCodeItem,
    type RedeemCodeKind,
    type S3Provider,
    type S3StorageConfigForm,
    type StorageGrantItem,
    type WorkspaceDataItem,
} from "@/services/api/server";
import { notifyCloudWorkspaceChanged, WORKSPACE_CHANGED_EVENT } from "@/services/cloud-media";
import { syncCloudWorkspace, syncRuntimeSettings } from "@/services/cloud-sync";
import { createModelChannel, type ModelChannel } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

function formatBytes(bytes: number) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const val = bytes / Math.pow(1024, idx);
    return `${val >= 100 || idx === 0 ? val.toFixed(0) : val.toFixed(2)} ${units[idx]}`;
}

const providerLabels: Record<S3Provider, string> = {
    r2: "Cloudflare R2",
    oss: "阿里云 OSS",
    cos: "腾讯云 COS",
    s3: "通用 S3 / MinIO",
};

const kindLabels: Record<string, string> = {
    image: "图片",
    video: "视频",
    audio: "音频",
    file: "其他文件",
};

type WebdavPlatformForm = {
    enabled: boolean;
    url: string;
    username: string;
    password?: string;
    baseDirectory: string;
    autoAssignNewUsers: boolean;
};

type UserWebdavForm = {
    enabled: boolean;
    directory: string;
    url: string;
    username: string;
    password: string;
    quotaMb?: number | null;
    expiresAt?: Dayjs | null;
    resetUsedBytes?: boolean;
};

type UserCreditForm = {
    mode: "add" | "deduct";
    amount: number;
    note: string;
};

type UserStorageQuotaForm = {
    quotaMb: number;
    expiresAt?: Dayjs | null;
    recalculateUsedBytes?: boolean;
};

type CreateRedeemForm = {
    kind: RedeemCodeKind;
    count: number;
    credits: number;
    storageQuotaMb: number;
    storageDurationDays: number | null;
    prefix: string;
    customCode: string;
    expiresAt: Dayjs | null;
    note: string;
};

type AnnouncementForm = {
    title: string;
    content: string;
    level: "info" | "warning" | "success";
    isPinned: boolean;
    isPublished: boolean;
};

export default function AdminPage() {
    const { message } = App.useApp();
    const { token } = antdTheme.useToken();
    const copyText = useCopyText();
    const navigate = useNavigate();
    const { pathname } = useLocation();
    const [searchParams, setSearchParams] = useSearchParams();
    const user = useUserStore((state) => state.user);
    const isAdmin = user?.role === "admin";
    const isAdminRoute = pathname.startsWith("/admin");

    const requestedTab = searchParams.get("tab") || "";
    const defaultTab = isAdmin && isAdminRoute ? "overview" : "user-overview";
    const normalizeTab = useCallback((tab: string) => (tab === "settings" ? "settings-auth" : tab), []);
    const [activeTab, setActiveTab] = useState(normalizeTab(requestedTab || defaultTab));
    const [openMenuKeys, setOpenMenuKeys] = useState<string[]>(() => {
        const initial = normalizeTab(requestedTab || defaultTab);
        return initial.startsWith("settings-") ? ["settings"] : [];
    });
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

    const switchTab = useCallback(
        (nextTab: string) => {
            const resolved = normalizeTab(nextTab);
            setActiveTab(resolved);
            if (resolved.startsWith("settings-")) {
                setOpenMenuKeys((prev) => (prev.includes("settings") ? prev : [...prev, "settings"]));
            }
            setSearchParams(
                (prev) => {
                    const next = new URLSearchParams(prev);
                    next.set("tab", resolved);
                    return next;
                },
                { replace: true },
            );
        },
        [normalizeTab, setSearchParams],
    );

    useEffect(() => {
        if (requestedTab) {
            const resolved = normalizeTab(requestedTab);
            setActiveTab(resolved);
            if (resolved.startsWith("settings-")) {
                setOpenMenuKeys((prev) => (prev.includes("settings") ? prev : [...prev, "settings"]));
            }
        } else {
            setActiveTab(isAdmin && isAdminRoute ? "overview" : "user-overview");
        }
    }, [isAdmin, isAdminRoute, normalizeTab, requestedTab]);
    const [overview, setOverview] = useState<AdminOverview | null>(null);
    const [overviewLoading, setOverviewLoading] = useState(false);
    const [overviewDays, setOverviewDays] = useState<7 | 14 | 30>(7);

    const [channels, setChannels] = useState<AdminChannelItem[]>([]);
    const [channelsLoading, setChannelsLoading] = useState(false);
    const [channelsSaving, setChannelsSaving] = useState(false);
    const [editingChannel, setEditingChannel] = useState<ModelChannel | null>(null);

    const [usersList, setUsersList] = useState<AdminUserItem[]>([]);
    const [usersTotal, setUsersTotal] = useState(0);
    const [usersPage, setUsersPage] = useState(1);
    const [userQuery, setUserQuery] = useState("");
    const [userRoleFilter, setUserRoleFilter] = useState("");
    const [userStatusFilter, setUserStatusFilter] = useState("");
    const [userSort, setUserSort] = useState("created_desc");
    const [usersLoading, setUsersLoading] = useState(false);
    const [assigningUser, setAssigningUser] = useState<AdminUserItem | null>(null);
    const [userWebdavForm] = Form.useForm<UserWebdavForm>();
    const [userWebdavSaving, setUserWebdavSaving] = useState(false);
    const [creditUser, setCreditUser] = useState<AdminUserItem | null>(null);
    const [userCreditForm] = Form.useForm<UserCreditForm>();
    const [userCreditSaving, setUserCreditSaving] = useState(false);
    const [storageQuotaUser, setStorageQuotaUser] = useState<AdminUserItem | null>(null);
    const [userStorageQuotaForm] = Form.useForm<UserStorageQuotaForm>();
    const [userStorageQuotaSaving, setUserStorageQuotaSaving] = useState(false);
    const [storageQuotaGrants, setStorageQuotaGrants] = useState<StorageGrantItem[]>([]);
    const [storageQuotaGrantsLoading, setStorageQuotaGrantsLoading] = useState(false);
    const [updatingGrantId, setUpdatingGrantId] = useState<string | null>(null);

    const [storageForm] = Form.useForm<S3StorageConfigForm>();
    const [storagePreview, setStoragePreview] = useState("");
    const [storageConfigured, setStorageConfigured] = useState(false);
    const [storageSaving, setStorageSaving] = useState(false);
    const [storageTesting, setStorageTesting] = useState(false);

    const [webdavForm] = Form.useForm<WebdavPlatformForm>();
    const [webdavPasswordPreview, setWebdavPasswordPreview] = useState("");
    const [webdavSaving, setWebdavSaving] = useState(false);
    const [webdavTesting, setWebdavTesting] = useState(false);

    const [mailForm] = Form.useForm<AdminMailSettingsForm>();
    const [mailPasswordPreview, setMailPasswordPreview] = useState("");
    const [mailReady, setMailReady] = useState(false);
    const [mailSaving, setMailSaving] = useState(false);
    const [mailTesting, setMailTesting] = useState(false);
    const [testMailTo, setTestMailTo] = useState("");

    const [mediaSubTab, setMediaSubTab] = useState<"media" | "canvas" | "image_workbench" | "video_workbench">("media");
    const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
    const [mediaTotal, setMediaTotal] = useState(0);
    const [mediaFilteredBytes, setMediaFilteredBytes] = useState<number | null>(null);
    const [mediaPage, setMediaPage] = useState(1);
    const [mediaQuery, setMediaQuery] = useState("");
    const [mediaKindFilter, setMediaKindFilter] = useState("");
    const [mediaModuleFilter, setMediaModuleFilter] = useState("");
    const [mediaWorkspaceStats, setMediaWorkspaceStats] = useState({ canvasProjects: 0, imageLogs: 0, videoLogs: 0 });
    const [workspaceDataItems, setWorkspaceDataItems] = useState<WorkspaceDataItem[]>([]);
    const [workspaceDataTotal, setWorkspaceDataTotal] = useState(0);
    const [workspaceDataPage, setWorkspaceDataPage] = useState(1);
    const [workspaceDataQuery, setWorkspaceDataQuery] = useState("");
    const [workspaceDataLoading, setWorkspaceDataLoading] = useState(false);
    const [mediaLoading, setMediaLoading] = useState(false);
    const [uploadingTest, setUploadingTest] = useState(false);
    const [previewMediaItem, setPreviewMediaItem] = useState<MediaItem | null>(null);
    const [downloadingPreviewMedia, setDownloadingPreviewMedia] = useState(false);

    const [allowRegister, setAllowRegister] = useState(true);
    const [requireEmailOnRegister, setRequireEmailOnRegister] = useState(false);
    const [authPolicySaving, setAuthPolicySaving] = useState(false);

    useEffect(() => {
        const personalKeys = new Set(["user-overview", "usage-logs", "profile", "wallet", "my-media"]);
        if (!isAdmin && !personalKeys.has(activeTab)) {
            switchTab("user-overview");
        }
    }, [activeTab, isAdmin, switchTab]);

    const [redeemItems, setRedeemItems] = useState<RedeemCodeItem[]>([]);
    const [redeemTotal, setRedeemTotal] = useState(0);
    const [redeemPage, setRedeemPage] = useState(1);
    const [redeemQuery, setRedeemQuery] = useState("");
    const [redeemStatusFilter, setRedeemStatusFilter] = useState("");
    const [redeemActiveKind, setRedeemActiveKind] = useState<RedeemCodeKind>("credits");
    const [selectedRedeemIds, setSelectedRedeemIds] = useState<string[]>([]);
    const [batchDeletingRedeem, setBatchDeletingRedeem] = useState(false);
    const [redeemLoading, setRedeemLoading] = useState(false);
    const [createRedeemOpen, setCreateRedeemOpen] = useState(false);
    const [createRedeemForm] = Form.useForm<CreateRedeemForm>();
    const [creatingRedeem, setCreatingRedeem] = useState(false);
    const [generatedCodes, setGeneratedCodes] = useState<string[]>([]);
    const redeemCountWatch = Form.useWatch("count", createRedeemForm) ?? 1;
    const redeemKindWatch = Form.useWatch("kind", createRedeemForm) ?? "credits";

    const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([]);
    const [announcementsLoading, setAnnouncementsLoading] = useState(false);
    const [announcementModalOpen, setAnnouncementModalOpen] = useState(false);
    const [editingAnnouncement, setEditingAnnouncement] = useState<AnnouncementItem | null>(null);
    const [announcementForm] = Form.useForm<AnnouncementForm>();
    const [announcementSaving, setAnnouncementSaving] = useState(false);

    const loadOverview = useCallback(
        async (days = overviewDays) => {
            if (!isAdmin) return;
            setOverviewLoading(true);
            try {
                setOverview(await adminApi.getOverview(days));
            } catch (error) {
                message.error(error instanceof Error ? error.message : "加载概览失败");
            } finally {
                setOverviewLoading(false);
            }
        },
        [isAdmin, message, overviewDays],
    );

    const loadChannels = useCallback(async () => {
        setChannelsLoading(true);
        try {
            const res = await adminApi.getChannelSettings();
            setChannels(res.channels);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载模型渠道失败");
        } finally {
            setChannelsLoading(false);
        }
    }, [message]);

    const loadUsers = useCallback(
        async (page = usersPage, q = userQuery, role = userRoleFilter, status = userStatusFilter, sort = userSort) => {
            setUsersLoading(true);
            try {
                const res = await adminApi.listUsers({ page, pageSize: 15, q, role, status, sort });
                setUsersList(res.items);
                setUsersTotal(res.total);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "加载用户列表失败");
            } finally {
                setUsersLoading(false);
            }
        },
        [message, userQuery, userRoleFilter, userSort, userStatusFilter, usersPage],
    );

    const loadStorageSettings = useCallback(async () => {
        try {
            const res = await adminApi.getStorageSettings();
            setStorageConfigured(res.configured);
            setStoragePreview(res.config.secretAccessKeyPreview);
            storageForm.setFieldsValue({
                provider: res.config.provider,
                endpoint: res.config.endpoint,
                region: res.config.region,
                bucket: res.config.bucket,
                accessKeyId: res.config.accessKeyId,
                secretAccessKey: "",
                publicBaseUrl: res.config.publicBaseUrl,
                forcePathStyle: res.config.forcePathStyle,
            });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取对象存储配置失败");
        }
    }, [message, storageForm]);

    const loadMedia = useCallback(
        async (page = mediaPage, q = mediaQuery, kind = mediaKindFilter, mod = mediaModuleFilter) => {
            setMediaLoading(true);
            try {
                const res = await adminApi.listMedia({ page, pageSize: 12, q, kind, module: mod });
                setMediaItems(res.items);
                setMediaTotal(res.total);
                setMediaFilteredBytes(typeof res.filteredBytes === "number" ? res.filteredBytes : null);
                if (res.workspaceStats) setMediaWorkspaceStats(res.workspaceStats);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "加载媒体列表失败");
            } finally {
                setMediaLoading(false);
            }
        },
        [mediaKindFilter, mediaModuleFilter, mediaPage, mediaQuery, message],
    );

    const loadWorkspaceData = useCallback(
        async (kind = mediaSubTab, page = workspaceDataPage, q = workspaceDataQuery) => {
            if (kind === "media") return;
            setWorkspaceDataLoading(true);
            try {
                const res = await adminApi.listWorkspaceData({ kind, page, pageSize: 12, q });
                setWorkspaceDataItems(res.items);
                setWorkspaceDataTotal(res.total);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "加载业务云端数据失败");
            } finally {
                setWorkspaceDataLoading(false);
            }
        },
        [mediaSubTab, message, workspaceDataPage, workspaceDataQuery],
    );

    const loadAuthAndWebdavSettings = useCallback(async () => {
        try {
            const [authRes, webdavRes, mailRes] = await Promise.all([
                adminApi.getAuthSettings(),
                adminApi.getWebdavSettings(),
                adminApi.getMailSettings(),
            ]);
            setAllowRegister(authRes.allowRegister);
            setRequireEmailOnRegister(authRes.requireEmailOnRegister);
            setWebdavPasswordPreview(webdavRes.passwordPreview);
            webdavForm.setFieldsValue({
                enabled: webdavRes.enabled,
                url: webdavRes.url,
                username: webdavRes.username,
                password: "",
                baseDirectory: webdavRes.baseDirectory,
                autoAssignNewUsers: webdavRes.autoAssignNewUsers,
            });
            setMailPasswordPreview(mailRes.passwordPreview);
            setMailReady(mailRes.ready);
            mailForm.setFieldsValue({
                enabled: mailRes.enabled,
                host: mailRes.host,
                port: mailRes.port,
                secure: mailRes.secure,
                username: mailRes.username,
                password: "",
                fromName: mailRes.fromName,
                fromAddress: mailRes.fromAddress,
                lowBalanceAlertEnabled: mailRes.lowBalanceAlertEnabled,
                lowBalanceThreshold: mailRes.lowBalanceThreshold,
                lowBalanceCooldownHours: mailRes.lowBalanceCooldownHours,
            });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "读取系统设置失败");
        }
    }, [mailForm, message, webdavForm]);

    const loadRedeemCodes = useCallback(
        async (page = redeemPage, q = redeemQuery, status = redeemStatusFilter, kind = redeemActiveKind) => {
            setRedeemLoading(true);
            try {
                const res = await adminApi.listRedeemCodes({ page, pageSize: 15, q, status, kind });
                setRedeemItems(res.items);
                setRedeemTotal(res.total);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "加载兑换码失败");
            } finally {
                setRedeemLoading(false);
            }
        },
        [message, redeemActiveKind, redeemPage, redeemQuery, redeemStatusFilter],
    );

    const loadAnnouncements = useCallback(async () => {
        setAnnouncementsLoading(true);
        try {
            const res = await adminApi.listAnnouncements();
            setAnnouncements(res.items);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载公告列表失败");
        } finally {
            setAnnouncementsLoading(false);
        }
    }, [message]);

    useEffect(() => {
        if (!isAdmin) return;
        void loadOverview(overviewDays);
    }, [isAdmin, loadOverview, overviewDays]);

    useEffect(() => {
        if (!isAdmin) return;
        void loadChannels();
        void loadStorageSettings();
        void loadAuthAndWebdavSettings();
    }, [isAdmin, loadAuthAndWebdavSettings, loadChannels, loadStorageSettings]);

    useEffect(() => {
        if (!isAdmin || activeTab !== "users") return;
        void loadUsers(usersPage, userQuery, userRoleFilter, userStatusFilter, userSort);
    }, [activeTab, isAdmin, loadUsers, userQuery, userRoleFilter, userSort, userStatusFilter, usersPage]);

    useEffect(() => {
        if (!isAdmin || (activeTab !== "media" && activeTab !== "storage")) return;
        void loadMedia(mediaPage, mediaQuery, mediaKindFilter, mediaModuleFilter);
    }, [activeTab, isAdmin, loadMedia, mediaKindFilter, mediaModuleFilter, mediaPage, mediaQuery]);

    useEffect(() => {
        if (!isAdmin || activeTab !== "media" || mediaSubTab === "media") return;
        void loadWorkspaceData(mediaSubTab, workspaceDataPage, workspaceDataQuery);
    }, [activeTab, isAdmin, loadWorkspaceData, mediaSubTab, workspaceDataPage, workspaceDataQuery]);

    useEffect(() => {
        if (!isAdmin || activeTab !== "media") return;
        const handleChanged = () => {
            void loadMedia(mediaPage, mediaQuery, mediaKindFilter, mediaModuleFilter);
            void loadOverview(overviewDays);
            if (mediaSubTab !== "media") {
                void loadWorkspaceData(mediaSubTab, workspaceDataPage, workspaceDataQuery);
            }
        };
        window.addEventListener(WORKSPACE_CHANGED_EVENT, handleChanged);
        window.addEventListener("infinite-canvas:cloud-workspace-synced", handleChanged);
        return () => {
            window.removeEventListener(WORKSPACE_CHANGED_EVENT, handleChanged);
            window.removeEventListener("infinite-canvas:cloud-workspace-synced", handleChanged);
        };
    }, [activeTab, isAdmin, loadMedia, loadOverview, loadWorkspaceData, mediaKindFilter, mediaModuleFilter, mediaPage, mediaQuery, mediaSubTab, overviewDays, workspaceDataPage, workspaceDataQuery]);

    useEffect(() => {
        if (!isAdmin || !activeTab.startsWith("settings-")) return;
        void loadAuthAndWebdavSettings();
    }, [activeTab, isAdmin, loadAuthAndWebdavSettings]);

    useEffect(() => {
        if (!isAdmin || activeTab !== "redeem-codes") return;
        void loadRedeemCodes(redeemPage, redeemQuery, redeemStatusFilter, redeemActiveKind);
    }, [activeTab, isAdmin, loadRedeemCodes, redeemActiveKind, redeemPage, redeemQuery, redeemStatusFilter]);

    useEffect(() => {
        if (!isAdmin || activeTab !== "announcements") return;
        void loadAnnouncements();
    }, [activeTab, isAdmin, loadAnnouncements]);

    if (!user) {
        return (
            <div className="flex h-full items-center justify-center p-6">
                <Result
                    status="info"
                    title="请先登录账号"
                    extra={
                        <Button type="primary" onClick={() => navigate(`/auth?redirect=${encodeURIComponent(pathname)}`)}>
                            前往登录
                        </Button>
                    }
                />
            </div>
        );
    }

    if (!isAdmin && isAdminRoute) {
        return (
            <div className="flex h-full items-center justify-center p-6">
                <Result
                    status="403"
                    title="无权访问管理后台"
                    subTitle="仅系统管理员可访问管理后台，普通用户请前往个人后台。"
                    extra={
                        <Space>
                            <Button type="primary" onClick={() => navigate("/console", { replace: true })}>
                                前往个人后台
                            </Button>
                            <Button onClick={() => navigate("/", { replace: true })}>返回首页</Button>
                        </Space>
                    }
                />
            </div>
        );
    }

    const persistChannels = async (nextList: AdminChannelItem[]) => {
        setChannelsSaving(true);
        try {
            await adminApi.saveChannelSettings(nextList);
            await loadChannels();
            await syncRuntimeSettings();
            message.success("模型渠道已保存并下发");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存模型渠道失败");
        } finally {
            setChannelsSaving(false);
        }
    };

    const handleAddChannel = () => {
        const draft = createModelChannel({ name: `平台渠道 ${channels.length + 1}`, baseUrl: "https://api.openai.com", apiKey: "", enabled: true });
        setEditingChannel(draft);
    };

    const handleEditChannel = (item: AdminChannelItem) => {
        setEditingChannel({
            id: item.id,
            name: item.name,
            baseUrl: item.baseUrl,
            apiKey: "",
            apiFormat: item.apiFormat,
            enabled: item.enabled,
            hasApiKey: item.hasApiKey,
            apiKeyPreview: item.apiKeyPreview,
            models: item.models,
        });
    };

    const handleSaveChannelDrawer = async (saved: ModelChannel) => {
        const nextItem: AdminChannelItem = {
            id: saved.id,
            name: saved.name,
            baseUrl: saved.baseUrl,
            apiFormat: saved.apiFormat,
            enabled: saved.enabled ?? true,
            models: saved.models,
            apiKey: saved.apiKey,
        };
        const exists = channels.some((ch) => ch.id === nextItem.id);
        const nextList = exists ? channels.map((ch) => (ch.id === nextItem.id ? nextItem : ch)) : [...channels, nextItem];
        await persistChannels(nextList);
    };

    const handleToggleChannelEnabled = async (id: string, enabled: boolean) => {
        await persistChannels(channels.map((ch) => (ch.id === id ? { ...ch, enabled, apiKey: "" } : { ...ch, apiKey: "" })));
    };

    const handleDeleteChannel = async (id: string) => {
        await persistChannels(channels.filter((ch) => ch.id !== id).map((ch) => ({ ...ch, apiKey: "" })));
    };

    const handleSaveStorage = async (values: S3StorageConfigForm) => {
        setStorageSaving(true);
        try {
            const res = await adminApi.saveStorageSettings(values);
            setStorageConfigured(true);
            setStoragePreview(res.secretAccessKeyPreview);
            storageForm.setFieldValue("secretAccessKey", "");
            message.success("对象存储配置已保存");
            void loadOverview();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存对象存储配置失败");
        } finally {
            setStorageSaving(false);
        }
    };

    const handleTestStorage = async () => {
        try {
            const values = await storageForm.validateFields();
            setStorageTesting(true);
            const res = await adminApi.testStorageSettings(values);
            message.success(res.message);
        } catch (error) {
            if (error instanceof Error) message.error(error.message);
        } finally {
            setStorageTesting(false);
        }
    };

    const handleDirectUploadTest: UploadProps["customRequest"] = async (options) => {
        const file = options.file as File;
        setUploadingTest(true);
        try {
            await storageApi.uploadFile(file);
            message.success("直传测试成功，文件已写入对象存储并完成入库");
            options.onSuccess?.({});
            void loadMedia(1, mediaQuery, mediaKindFilter);
            void loadOverview();
        } catch (error) {
            const err = error instanceof Error ? error : new Error("直传失败");
            message.error(err.message);
            options.onError?.(err);
        } finally {
            setUploadingTest(false);
        }
    };

    const handleUpdateUser = async (targetId: string, patch: { role?: "admin" | "user"; status?: "active" | "disabled" }) => {
        try {
            await adminApi.updateUser(targetId, patch);
            message.success("用户信息已更新");
            void loadUsers();
            void loadOverview();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "更新失败");
        }
    };

    const openAssignWebdav = (record: AdminUserItem) => {
        setAssigningUser(record);
        const baseDir = webdavForm.getFieldValue("baseDirectory") || "infinite-canvas";
        const quotaBytes = record.webdavConfig?.quotaBytes;
        userWebdavForm.setFieldsValue({
            enabled: record.webdavConfig?.enabled ?? false,
            directory: record.webdavConfig?.directory || `${baseDir}/${record.username}`,
            url: record.webdavConfig?.url || "",
            username: record.webdavConfig?.username || "",
            password: "",
            quotaMb: quotaBytes && quotaBytes > 0 ? Math.round((quotaBytes / (1024 * 1024)) * 100) / 100 : null,
            expiresAt: record.webdavConfig?.expiresAt ? dayjs(record.webdavConfig.expiresAt) : null,
            resetUsedBytes: false,
        });
    };

    const handleSaveUserWebdav = async (values: UserWebdavForm) => {
        if (!assigningUser) return;
        setUserWebdavSaving(true);
        try {
            const quotaBytes = values.quotaMb && values.quotaMb > 0 ? Math.round(values.quotaMb * 1024 * 1024) : null;
            await adminApi.assignUserWebdav(assigningUser.id, {
                enabled: values.enabled,
                directory: values.directory.trim(),
                url: values.url.trim(),
                username: values.username.trim(),
                password: values.password.trim(),
                quotaBytes,
                expiresAt: values.expiresAt ? values.expiresAt.toISOString() : null,
                resetUsedBytes: Boolean(values.resetUsedBytes),
            });
            message.success("用户 WebDAV 分配已更新");
            setAssigningUser(null);
            void loadUsers();
            if (assigningUser.id === user.id) void syncRuntimeSettings();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "更新失败");
        } finally {
            setUserWebdavSaving(false);
        }
    };

    const openAdjustCredits = (record: AdminUserItem) => {
        setCreditUser(record);
        userCreditForm.setFieldsValue({ mode: "add", amount: 100, note: "" });
    };

    const loadUserStorageGrants = async (userId: string) => {
        setStorageQuotaGrantsLoading(true);
        try {
            const res = await adminApi.getUserStorageGrants(userId);
            setStorageQuotaGrants(res.grants);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "加载存储资源包失败");
        } finally {
            setStorageQuotaGrantsLoading(false);
        }
    };

    const openConfigStorageQuota = (record: AdminUserItem) => {
        setStorageQuotaUser(record);
        setStorageQuotaGrants([]);
        const baseQuotaBytes = record.baseStorageQuotaBytes ?? record.storageQuotaBytes ?? 0;
        const baseExpiresAt = record.baseStorageQuotaExpiresAt !== undefined ? record.baseStorageQuotaExpiresAt : record.storageQuotaExpiresAt;
        userStorageQuotaForm.setFieldsValue({
            quotaMb: baseQuotaBytes > 0 ? Math.round((baseQuotaBytes / (1024 * 1024)) * 100) / 100 : 0,
            expiresAt: baseExpiresAt ? dayjs(baseExpiresAt) : null,
            recalculateUsedBytes: false,
        });
        void loadUserStorageGrants(record.id);
    };

    const handleToggleStorageGrant = async (grant: StorageGrantItem) => {
        if (!storageQuotaUser) return;
        setUpdatingGrantId(grant.id);
        try {
            const nextStatus = grant.status === "active" ? "revoked" : "active";
            await adminApi.updateStorageGrantStatus(grant.id, nextStatus);
            message.success(nextStatus === "revoked" ? "已停用该存储资源包" : "已恢复该存储资源包");
            await loadUserStorageGrants(storageQuotaUser.id);
            void loadUsers();
            if (storageQuotaUser.id === user.id) {
                const refreshed = await adminApi.getUserStorageGrants(storageQuotaUser.id);
                useUserStore.getState().setUser({
                    ...user,
                    storageQuotaBytes: refreshed.storageQuotaBytes,
                    storageQuotaExpiresAt: refreshed.storageQuotaExpiresAt,
                    storageUsedBytes: refreshed.storageUsedBytes,
                });
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "更新资源包状态失败");
        } finally {
            setUpdatingGrantId(null);
        }
    };

    const handleSaveUserStorageQuota = async (values: UserStorageQuotaForm) => {
        if (!storageQuotaUser) return;
        setUserStorageQuotaSaving(true);
        try {
            const storageQuotaBytes = Math.max(0, Math.round(Number(values.quotaMb || 0) * 1024 * 1024));
            const res = await adminApi.updateUserStorageQuota(storageQuotaUser.id, {
                storageQuotaBytes,
                storageQuotaExpiresAt: values.expiresAt ? values.expiresAt.toISOString() : null,
                recalculateUsedBytes: Boolean(values.recalculateUsedBytes),
            });
            message.success(`云端存储配额已更新为 ${formatBytes(res.storageQuotaBytes)}`);
            if (storageQuotaUser.id === user.id) {
                useUserStore.getState().setUser({
                    ...user,
                    storageQuotaBytes: res.storageQuotaBytes,
                    storageQuotaExpiresAt: res.storageQuotaExpiresAt,
                    storageUsedBytes: res.storageUsedBytes,
                });
            }
            setStorageQuotaUser(null);
            void loadUsers();
            void loadOverview();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "更新云端存储配额失败");
        } finally {
            setUserStorageQuotaSaving(false);
        }
    };

    const handleAdjustUserCredits = async (values: UserCreditForm) => {
        if (!creditUser) return;
        const delta = values.mode === "deduct" ? -Math.abs(Number(values.amount)) : Math.abs(Number(values.amount));
        setUserCreditSaving(true);
        try {
            const res = await adminApi.adjustUserCredits(creditUser.id, {
                delta,
                note: values.note?.trim() || "",
            });
            message.success(`积分已调整，当前余额：${res.balance}`);
            if (creditUser.id === user.id) {
                useUserStore.getState().setUser({ ...user, creditBalance: res.balance });
            }
            setCreditUser(null);
            void loadUsers();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "调整积分失败");
        } finally {
            setUserCreditSaving(false);
        }
    };

    const handleCreateRedeemCodes = async (values: CreateRedeemForm) => {
        setCreatingRedeem(true);
        try {
            const kind = values.kind || redeemActiveKind;
            const res = await adminApi.createRedeemCodes({
                kind,
                count: Number(values.count || 1),
                ...(kind === "credits"
                    ? { credits: Number(values.credits) }
                    : {
                          storageQuotaBytes: Math.round(Number(values.storageQuotaMb || 0) * 1024 * 1024),
                          storageDurationDays:
                              typeof values.storageDurationDays === "number" && values.storageDurationDays > 0
                                  ? Math.round(values.storageDurationDays)
                                  : null,
                      }),
                maxUses: 1,
                prefix: values.prefix?.trim() || (kind === "storage" ? "ST" : "IC"),
                customCode: values.count === 1 ? values.customCode?.trim() : undefined,
                expiresAt: values.expiresAt ? values.expiresAt.toISOString() : null,
                note: values.note?.trim() || "",
            });
            setGeneratedCodes(res.items.map((item) => item.code));
            setCreateRedeemOpen(false);
            createRedeemForm.resetFields();
            message.success(`已生成 ${res.items.length} 个兑换码`);
            setSelectedRedeemIds([]);
            if (kind !== redeemActiveKind) {
                setRedeemPage(1);
                setRedeemActiveKind(kind);
            } else {
                void loadRedeemCodes(1, redeemQuery, redeemStatusFilter, kind);
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "生成兑换码失败");
        } finally {
            setCreatingRedeem(false);
        }
    };

    const selectedRedeemItems = redeemItems.filter((item) => selectedRedeemIds.includes(item.id));
    const hasSelectedUsedRedeem = selectedRedeemItems.some((item) => item.usedCount > 0);

    const handleBatchCopyRedeemCodes = () => {
        if (!selectedRedeemItems.length) return;
        copyText(
            selectedRedeemItems.map((item) => item.code).join("\n"),
            `已复制 ${selectedRedeemItems.length} 个兑换码`,
        );
    };

    const handleBatchDeleteRedeemCodes = async () => {
        if (!selectedRedeemIds.length || hasSelectedUsedRedeem) return;
        setBatchDeletingRedeem(true);
        try {
            const res = await adminApi.batchDeleteRedeemCodes(selectedRedeemIds);
            message.success(`已删除 ${res.deletedCount} 个兑换码`);
            setSelectedRedeemIds([]);
            void loadRedeemCodes();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "批量删除失败");
        } finally {
            setBatchDeletingRedeem(false);
        }
    };

    const handleToggleRedeemStatus = async (item: RedeemCodeItem) => {
        try {
            await adminApi.updateRedeemCode(item.id, { status: item.status === "active" ? "disabled" : "active" });
            message.success("兑换码状态已更新");
            void loadRedeemCodes();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "更新失败");
        }
    };

    const handleDeleteRedeemCode = async (id: string) => {
        try {
            await adminApi.deleteRedeemCode(id);
            message.success("兑换码已删除");
            void loadRedeemCodes();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除失败");
        }
    };

    const handleSavePlatformWebdav = async (values: WebdavPlatformForm) => {
        setWebdavSaving(true);
        try {
            await adminApi.saveWebdavSettings(values);
            message.success("平台 WebDAV 配置已保存");
            void loadAuthAndWebdavSettings();
            void syncRuntimeSettings();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存 WebDAV 配置失败");
        } finally {
            setWebdavSaving(false);
        }
    };

    const handleTestPlatformWebdav = async () => {
        try {
            const values = await webdavForm.validateFields();
            setWebdavTesting(true);
            const res = await adminApi.testWebdavSettings(values);
            message.success(res.message);
        } catch (error) {
            if (error instanceof Error) message.error(error.message);
        } finally {
            setWebdavTesting(false);
        }
    };

    const handleDeleteMedia = async (mediaId: string) => {
        try {
            await adminApi.deleteMedia(mediaId);
            notifyCloudWorkspaceChanged("media", { sync: false });
            message.success("媒体文件已删除并释放用户存储空间");
            void loadMedia();
            void loadOverview();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除失败");
        }
    };

    const handleUpdateAuthPolicy = async (patch: { allowRegister?: boolean; requireEmailOnRegister?: boolean }) => {
        setAuthPolicySaving(true);
        try {
            const nextAllow = patch.allowRegister ?? allowRegister;
            const nextRequireEmail = patch.requireEmailOnRegister ?? requireEmailOnRegister;
            const res = await adminApi.saveAuthSettings({
                allowRegister: nextAllow,
                requireEmailOnRegister: nextRequireEmail,
            });
            setAllowRegister(res.allowRegister);
            setRequireEmailOnRegister(res.requireEmailOnRegister);
            if (patch.allowRegister !== undefined) {
                message.success(res.allowRegister ? "已开放新用户注册" : "已关闭新用户注册");
            } else {
                message.success(res.requireEmailOnRegister ? "已开启注册强制邮箱验证" : "已关闭注册强制邮箱验证");
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        } finally {
            setAuthPolicySaving(false);
        }
    };

    const handleSaveMailSettings = async (values: AdminMailSettingsForm) => {
        setMailSaving(true);
        try {
            const res = await adminApi.saveMailSettings(values);
            setMailReady(res.ready);
            setMailPasswordPreview(res.passwordPreview);
            if (!values.enabled) {
                setRequireEmailOnRegister(false);
            }
            mailForm.setFieldValue("password", "");
            message.success("邮件服务配置已保存");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存邮件配置失败");
        } finally {
            setMailSaving(false);
        }
    };

    const handleTestMailSettings = async () => {
        const cleanTo = testMailTo.trim();
        if (!cleanTo) {
            message.warning("请先填写测试收件邮箱");
            return;
        }
        try {
            const values = await mailForm.validateFields();
            setMailTesting(true);
            const res = await adminApi.testMailSettings({ ...values, testTo: cleanTo });
            message.success(res.message);
        } catch (error) {
            if (error instanceof Error) message.error(error.message);
        } finally {
            setMailTesting(false);
        }
    };

    const announcementLevelLabels: Record<AnnouncementItem["level"], { label: string; color: string }> = {
        info: { label: "通知", color: "blue" },
        warning: { label: "重要提醒", color: "orange" },
        success: { label: "更新公告", color: "green" },
    };

    const handleOpenCreateAnnouncement = () => {
        setEditingAnnouncement(null);
        announcementForm.setFieldsValue({
            title: "",
            content: "",
            level: "info",
            isPinned: false,
            isPublished: true,
        });
        setAnnouncementModalOpen(true);
    };

    const handleOpenEditAnnouncement = (record: AnnouncementItem) => {
        setEditingAnnouncement(record);
        announcementForm.setFieldsValue({
            title: record.title,
            content: record.content,
            level: record.level,
            isPinned: record.isPinned,
            isPublished: record.isPublished,
        });
        setAnnouncementModalOpen(true);
    };

    const handleSaveAnnouncement = async (values: AnnouncementForm) => {
        setAnnouncementSaving(true);
        try {
            if (editingAnnouncement) {
                await adminApi.updateAnnouncement(editingAnnouncement.id, values);
                message.success("公告已更新");
            } else {
                await adminApi.createAnnouncement(values);
                message.success("公告已发布");
            }
            setAnnouncementModalOpen(false);
            setEditingAnnouncement(null);
            void loadAnnouncements();
            void loadOverview(overviewDays);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存公告失败");
        } finally {
            setAnnouncementSaving(false);
        }
    };

    const handleToggleAnnouncementFlag = async (
        record: AnnouncementItem,
        patch: Partial<Pick<AnnouncementItem, "isPinned" | "isPublished">>,
    ) => {
        try {
            await adminApi.updateAnnouncement(record.id, patch);
            message.success("公告状态已更新");
            void loadAnnouncements();
            void loadOverview(overviewDays);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "更新公告失败");
        }
    };

    const handleDeleteAnnouncement = async (id: string) => {
        try {
            await adminApi.deleteAnnouncement(id);
            message.success("公告已删除");
            void loadAnnouncements();
            void loadOverview(overviewDays);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除公告失败");
        }
    };

    const totalStorageBytes = overview?.totalStorageBytes ?? 0;

    const personalTabs = [
        {
            key: "user-overview",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <LayoutDashboard className="size-4" />
                    个人概览
                </span>
            ),
            children: <UserOverviewPanel onOpenWallet={() => switchTab("wallet")} />,
        },
        ...(!isAdmin
            ? [
                  {
                      key: "usage-logs",
                      label: (
                          <span className="inline-flex items-center gap-1.5">
                              <ScrollText className="size-4" />
                              使用日志
                          </span>
                      ),
                      children: <UsageLogsPanel defaultScope="self" />,
                  },
              ]
            : []),
        {
            key: "wallet",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <Coins className="size-4" />
                    积分钱包
                </span>
            ),
            children: <MyWalletPanel />,
        },
        {
            key: "profile",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <UserCheck className="size-4" />
                    个人信息与安全
                </span>
            ),
            children: <ProfileSecurityPanel />,
        },
        {
            key: "my-media",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <FolderKanban className="size-4" />
                    我的云端媒体
                </span>
            ),
            children: <MyMediaPanel />,
        },
    ];

    const adminTabs = [
                        {
                            key: "overview",
                            label: (
                                <span className="inline-flex items-center gap-1.5">
                                    <Shield className="size-4" />
                                    系统概览
                                </span>
                            ),
                            children: (
                                <div className="flex flex-col gap-5">
                                    <Row gutter={[16, 16]}>
                                        <Col xs={24} sm={12} md={6}>
                                            <Card loading={overviewLoading}>
                                                <Statistic
                                                    title="注册用户"
                                                    value={overview?.totalUsers ?? 0}
                                                    suffix={
                                                        <Typography.Text type="secondary" className="text-xs">
                                                            {overview?.adminCount ?? 0} 管理员 / {overview?.disabledUsers ?? 0} 禁用
                                                        </Typography.Text>
                                                    }
                                                />
                                            </Card>
                                        </Col>
                                        <Col xs={24} sm={12} md={6}>
                                            <Card loading={overviewLoading}>
                                                <Statistic title="累计消耗积分" value={overview?.totalConsumedCredits ?? 0} precision={4} />
                                            </Card>
                                        </Col>
                                        <Col xs={24} sm={12} md={6}>
                                            <Card loading={overviewLoading}>
                                                <Statistic title="今日消耗积分" value={overview?.todayConsumedCredits ?? 0} precision={4} />
                                            </Card>
                                        </Col>
                                        <Col xs={24} sm={12} md={6}>
                                            <Card loading={overviewLoading}>
                                                <Statistic title="已占用存储空间" value={formatBytes(totalStorageBytes)} />
                                            </Card>
                                        </Col>
                                    </Row>

                                    <Row gutter={[16, 16]}>
                                        <Col xs={24} lg={15}>
                                            <ConsumptionTrendCard
                                                title="全站积分消耗趋势"
                                                days={overviewDays}
                                                onDaysChange={(days) => setOverviewDays(days as 7 | 14 | 30)}
                                                dailyTrend={overview?.dailyTrend ?? []}
                                                topModels={overview?.topModels ?? []}
                                                rangeConsumedCredits={overview?.rangeConsumedCredits ?? 0}
                                                rangeCalls={overview?.rangeCalls ?? 0}
                                                loading={overviewLoading}
                                            />
                                        </Col>
                                        <Col xs={24} lg={9}>
                                            <AnnouncementsCard
                                                items={overview?.announcements ?? []}
                                                loading={overviewLoading}
                                                extra={
                                                    <Button type="link" size="small" onClick={() => switchTab("announcements")}>
                                                        管理公告
                                                    </Button>
                                                }
                                            />
                                        </Col>
                                    </Row>

                                    <Row gutter={[16, 16]}>
                                        <Col xs={24} sm={12}>
                                            <Card loading={overviewLoading}>
                                                <Statistic title="云端画布 / 素材" value={`${overview?.canvasProjectCount ?? 0} / ${overview?.assetCount ?? 0}`} />
                                            </Card>
                                        </Col>
                                        <Col xs={24} sm={12}>
                                            <Card loading={overviewLoading}>
                                                <Statistic title="对象存储文件数" value={overview?.activeMediaCount ?? 0} />
                                            </Card>
                                        </Col>
                                    </Row>

                                    <Row gutter={[16, 16]}>
                                        <Col xs={24} md={12}>
                                            <Card title="媒体类型占用分布" loading={overviewLoading}>
                                                <div className="flex flex-col gap-3">
                                                    {(overview?.mediaByKind ?? []).length ? (
                                                        overview!.mediaByKind.map((item) => {
                                                            const percent = totalStorageBytes > 0 ? Math.round((item.bytes / totalStorageBytes) * 100) : 0;
                                                            return (
                                                                <div key={item.kind} className="flex flex-col gap-1">
                                                                    <div className="flex items-center justify-between text-sm">
                                                                        <span>
                                                                            {kindLabels[item.kind] || item.kind}（{item.count} 个）
                                                                        </span>
                                                                        <Typography.Text type="secondary">{formatBytes(item.bytes)}</Typography.Text>
                                                                    </div>
                                                                    <Progress percent={percent} size="small" showInfo={false} />
                                                                </div>
                                                            );
                                                        })
                                                    ) : (
                                                        <Typography.Text type="secondary">暂无云端媒体文件</Typography.Text>
                                                    )}
                                                </div>
                                            </Card>
                                        </Col>
                                        <Col xs={24} md={12}>
                                            <Card title="用户存储占用排行（Top 5）" loading={overviewLoading}>
                                                <div className="flex flex-col gap-3">
                                                    {(overview?.topStorageUsers ?? []).length ? (
                                                        overview!.topStorageUsers.map((item) => {
                                                            const percent = totalStorageBytes > 0 ? Math.round((item.storageUsedBytes / totalStorageBytes) * 100) : 0;
                                                            return (
                                                                <div key={item.id} className="flex flex-col gap-1">
                                                                    <div className="flex items-center justify-between text-sm">
                                                                        <span>
                                                                            {item.displayName || item.username}{" "}
                                                                            <Tag color={item.role === "admin" ? "blue" : "default"}>{item.role === "admin" ? "管理员" : "用户"}</Tag>
                                                                        </span>
                                                                        <Typography.Text type="secondary">{formatBytes(item.storageUsedBytes)}</Typography.Text>
                                                                    </div>
                                                                    <Progress percent={percent} size="small" showInfo={false} />
                                                                </div>
                                                            );
                                                        })
                                                    ) : (
                                                        <Typography.Text type="secondary">暂无用户数据</Typography.Text>
                                                    )}
                                                </div>
                                            </Card>
                                        </Col>
                                    </Row>

                                    <Card title="当前运行状态">
                                        <Descriptions column={{ xs: 1, sm: 2 }} bordered size="small">
                                            <Descriptions.Item label="当前管理员">{user.displayName || user.username}</Descriptions.Item>
                                            <Descriptions.Item label="平台模型渠道">
                                                <Tag color={channels.some((ch) => ch.enabled) ? "green" : "orange"}>
                                                    已配置 {channels.length} 个（启用 {channels.filter((ch) => ch.enabled).length} 个）
                                                </Tag>
                                            </Descriptions.Item>
                                            <Descriptions.Item label="对象存储状态">
                                                {overview?.storageConfigured ? (
                                                    <Tag color="green">
                                                        已配置（{providerLabels[(overview.storageProvider as S3Provider) || "s3"]} / {overview.storageBucket}）
                                                    </Tag>
                                                ) : (
                                                    <Tag color="orange">未配置，请前往「对象存储」页签设置</Tag>
                                                )}
                                            </Descriptions.Item>
                                            <Descriptions.Item label="注册策略">
                                                <Tag color={allowRegister ? "blue" : "default"}>{allowRegister ? "开放普通用户注册" : "已关闭新用户注册"}</Tag>
                                            </Descriptions.Item>
                                        </Descriptions>
                                    </Card>
                                </div>
                            ),
                        },
                        {
                            key: "usage-logs",
                            label: (
                                <span className="inline-flex items-center gap-1.5">
                                    <ScrollText className="size-4" />
                                    使用日志
                                </span>
                            ),
                            children: <UsageLogsPanel defaultScope={isAdminRoute ? "all" : "self"} />,
                        },
                        {
                            key: "announcements",
                            label: (
                                <span className="inline-flex items-center gap-1.5">
                                    <Megaphone className="size-4" />
                                    公告管理
                                </span>
                            ),
                            children: (
                                <Card
                                    title="平台公告管理"
                                    extra={
                                        <Button type="primary" icon={<Plus className="size-4" />} onClick={handleOpenCreateAnnouncement}>
                                            发布公告
                                        </Button>
                                    }
                                >
                                    <Table<AnnouncementItem>
                                        rowKey="id"
                                        className={ADMIN_TABLE_CLASS}
                                        scroll={ADMIN_TABLE_SCROLL}
                                        loading={announcementsLoading}
                                        dataSource={announcements}
                                        pagination={{ pageSize: 10 }}
                                        columns={[
                                            {
                                                title: "公告内容",
                                                key: "title",
                                                width: 340,
                                                render: (_, record) => {
                                                    const lv = announcementLevelLabels[record.level] || announcementLevelLabels.info;
                                                    return (
                                                        <div className="flex max-w-[320px] flex-col gap-1">
                                                            <div className="flex items-center gap-1.5">
                                                                <Tag color={lv.color} style={{ marginInlineEnd: 0 }}>
                                                                    {lv.label}
                                                                </Tag>
                                                                {record.isPinned ? (
                                                                    <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                                                                        置顶
                                                                    </Tag>
                                                                ) : null}
                                                                <span className="truncate font-medium">{record.title}</span>
                                                            </div>
                                                            <Typography.Text type="secondary" ellipsis={{ tooltip: record.content }} className="text-xs">
                                                                {record.content}
                                                            </Typography.Text>
                                                        </div>
                                                    );
                                                },
                                            },
                                            {
                                                title: "置顶",
                                                dataIndex: "isPinned",
                                                width: 80,
                                                render: (checked: boolean, record) => (
                                                    <Switch
                                                        size="small"
                                                        checked={checked}
                                                        onChange={(val) => void handleToggleAnnouncementFlag(record, { isPinned: val })}
                                                    />
                                                ),
                                            },
                                            {
                                                title: "展示状态",
                                                dataIndex: "isPublished",
                                                width: 90,
                                                render: (checked: boolean, record) => (
                                                    <Switch
                                                        size="small"
                                                        checked={checked}
                                                        onChange={(val) => void handleToggleAnnouncementFlag(record, { isPublished: val })}
                                                    />
                                                ),
                                            },
                                            {
                                                title: "发布时间",
                                                dataIndex: "createdAt",
                                                width: 170,
                                                render: (value: string) => new Date(value).toLocaleString("zh-CN"),
                                            },
                                            {
                                                title: "操作",
                                                key: "actions",
                                                fixed: "right",
                                                width: 100,
                                                render: (_, record) => (
                                                    <TableRowActions
                                                        items={[
                                                            {
                                                                key: "edit",
                                                                label: "编辑",
                                                                onClick: () => handleOpenEditAnnouncement(record),
                                                            },
                                                            {
                                                                key: "delete",
                                                                label: "删除",
                                                                danger: true,
                                                                confirm: "确定删除这条公告吗？",
                                                                onClick: () => void handleDeleteAnnouncement(record.id),
                                                            },
                                                        ]}
                                                    />
                                                ),
                                            },
                                        ]}
                                    />
                                </Card>
                            ),
                        },
                        {
                            key: "channels",
                            label: (
                                <span className="inline-flex items-center gap-1.5">
                                    <Cpu className="size-4" />
                                    模型渠道
                                </span>
                            ),
                            children: (
                                <Card
                                    title="平台模型渠道（仅管理员配置，前台用户只能选择已启用的模型）"
                                    loading={channelsLoading}
                                    extra={
                                        <Button type="primary" icon={<Plus className="size-4" />} onClick={handleAddChannel} loading={channelsSaving}>
                                            新增渠道
                                        </Button>
                                    }
                                >
                                    <Alert
                                        type="info"
                                        showIcon
                                        className="mb-4"
                                        message="渠道密钥仅保存在服务端"
                                        description="前台普通用户不会看到您的 Base URL 与 API Key，所有 AI 生成请求均经服务端代理并校验身份后转发。"
                                    />
                                    <Table<AdminChannelItem>
                                        rowKey="id"
                                        className={ADMIN_TABLE_CLASS}
                                        scroll={ADMIN_TABLE_SCROLL}
                                        dataSource={channels}
                                        pagination={false}
                                        columns={[
                                            {
                                                title: "渠道名称",
                                                key: "name",
                                                width: 260,
                                                render: (_, record) => (
                                                    <div className="max-w-[240px]">
                                                        <div className="truncate font-medium">{record.name}</div>
                                                        <Typography.Text type="secondary" ellipsis={{ tooltip: record.baseUrl }} className="block text-xs">
                                                            {record.baseUrl || "未配置 Base URL"}
                                                        </Typography.Text>
                                                    </div>
                                                ),
                                            },
                                            {
                                                title: "协议",
                                                dataIndex: "apiFormat",
                                                width: 90,
                                                render: (fmt: string) => <Tag>{fmt === "gemini" ? "Gemini" : "OpenAI"}</Tag>,
                                            },
                                            {
                                                title: "密钥状态",
                                                key: "apiKey",
                                                width: 140,
                                                render: (_, record) =>
                                                    record.hasApiKey ? <Tag color="green">{record.apiKeyPreview}</Tag> : <Tag color="red">未配置密钥</Tag>,
                                            },
                                            {
                                                title: "模型数",
                                                key: "models",
                                                width: 85,
                                                render: (_, record) => `${record.models.length} 个`,
                                            },
                                            {
                                                title: "启用",
                                                dataIndex: "enabled",
                                                width: 80,
                                                render: (enabled: boolean, record) => (
                                                    <Switch checked={enabled} loading={channelsSaving} onChange={(checked) => void handleToggleChannelEnabled(record.id, checked)} />
                                                ),
                                            },
                                            {
                                                title: "操作",
                                                key: "actions",
                                                fixed: "right",
                                                width: 100,
                                                render: (_, record) => (
                                                    <TableRowActions
                                                        items={[
                                                            {
                                                                key: "edit",
                                                                label: "编辑",
                                                                onClick: () => handleEditChannel(record),
                                                            },
                                                            {
                                                                key: "delete",
                                                                label: "删除",
                                                                danger: true,
                                                                confirm: "确定删除该渠道吗？",
                                                                onClick: () => void handleDeleteChannel(record.id),
                                                            },
                                                        ]}
                                                    />
                                                ),
                                            },
                                        ]}
                                    />
                                </Card>
                            ),
                        },
                        {
                            key: "users",
                            label: (
                                <span className="inline-flex items-center gap-1.5">
                                    <Users className="size-4" />
                                    用户管理
                                </span>
                            ),
                            children: (
                                <Card
                                    title="账号列表与云端存储配额管理"
                                    extra={
                                        <Space wrap>
                                            <Select
                                                value={userRoleFilter}
                                                style={{ width: 115 }}
                                                onChange={(value) => {
                                                    setUsersPage(1);
                                                    setUserRoleFilter(value);
                                                }}
                                                options={[
                                                    { value: "", label: "全部角色" },
                                                    { value: "admin", label: "管理员" },
                                                    { value: "user", label: "普通用户" },
                                                ]}
                                            />
                                            <Select
                                                value={userStatusFilter}
                                                style={{ width: 115 }}
                                                onChange={(value) => {
                                                    setUsersPage(1);
                                                    setUserStatusFilter(value);
                                                }}
                                                options={[
                                                    { value: "", label: "全部状态" },
                                                    { value: "active", label: "正常" },
                                                    { value: "disabled", label: "已禁用" },
                                                ]}
                                            />
                                            <Select
                                                value={userSort}
                                                style={{ width: 145 }}
                                                onChange={(value) => {
                                                    setUsersPage(1);
                                                    setUserSort(value);
                                                }}
                                                options={[
                                                    { value: "created_desc", label: "按注册时间" },
                                                    { value: "storage_desc", label: "按存储占用" },
                                                ]}
                                            />
                                            <Input.Search
                                                allowClear
                                                placeholder="搜索用户名、昵称或邮箱"
                                                style={{ width: 220 }}
                                                onSearch={(value) => {
                                                    setUsersPage(1);
                                                    setUserQuery(value.trim());
                                                }}
                                            />
                                        </Space>
                                    }
                                >
                                    <Table<AdminUserItem>
                                        rowKey="id"
                                        className={ADMIN_TABLE_CLASS}
                                        scroll={ADMIN_TABLE_SCROLL}
                                        loading={usersLoading}
                                        dataSource={usersList}
                                        pagination={{
                                            current: usersPage,
                                            pageSize: 15,
                                            total: usersTotal,
                                            onChange: (page) => setUsersPage(page),
                                        }}
                                        columns={[
                                            {
                                                title: "账号",
                                                key: "account",
                                                width: 220,
                                                render: (_, record) => (
                                                    <div className="max-w-[200px]">
                                                        <div className="truncate font-medium">
                                                            {record.displayName || record.username}
                                                            {record.id === user.id ? <Tag className="ml-2">当前</Tag> : null}
                                                        </div>
                                                        <Typography.Text type="secondary" ellipsis className="block text-xs">
                                                            @{record.username}
                                                            {record.email ? ` · ${record.email}` : ""}
                                                        </Typography.Text>
                                                    </div>
                                                ),
                                            },
                                            {
                                                title: "角色",
                                                dataIndex: "role",
                                                width: 90,
                                                render: (role: string) => <Tag color={role === "admin" ? "blue" : "default"}>{role === "admin" ? "管理员" : "普通用户"}</Tag>,
                                            },
                                            {
                                                title: "状态",
                                                dataIndex: "status",
                                                width: 80,
                                                render: (status: string) => <Tag color={status === "active" ? "green" : "red"}>{status === "active" ? "正常" : "已禁用"}</Tag>,
                                            },
                                            {
                                                title: "积分余额",
                                                dataIndex: "creditBalance",
                                                width: 95,
                                                render: (balance?: number) => <Tag color="gold">{balance ?? 0}</Tag>,
                                            },
                                            {
                                                title: "画布 / 媒体",
                                                key: "counts",
                                                width: 100,
                                                render: (_, record) => `${record.projectCount ?? 0} / ${record.mediaCount ?? 0}`,
                                            },
                                            {
                                                title: "云端存储配额",
                                                key: "storageQuota",
                                                width: 205,
                                                render: (_, record) => {
                                                    const used = record.storageUsedBytes ?? 0;
                                                    const quota = record.storageQuotaBytes ?? 0;
                                                    const expired = Boolean(record.storageQuotaExpiresAt && new Date(record.storageQuotaExpiresAt).getTime() <= Date.now());
                                                    const exceeded = expired || quota <= 0 || used >= quota;
                                                    return (
                                                        <div className="flex w-[180px] flex-col gap-0.5">
                                                            <div className="flex items-center gap-1.5">
                                                                <span className="text-xs font-medium">
                                                                    {formatBytes(used)} / {formatBytes(quota)}
                                                                </span>
                                                                {expired ? (
                                                                    <Tag color="red" style={{ marginInlineEnd: 0 }}>
                                                                        已过期
                                                                    </Tag>
                                                                ) : exceeded ? (
                                                                    <Tag color="red" style={{ marginInlineEnd: 0 }}>
                                                                        {quota <= 0 ? "0MB" : "已满"}
                                                                    </Tag>
                                                                ) : null}
                                                            </div>
                                                            <Progress
                                                                percent={quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 100}
                                                                size="small"
                                                                showInfo={false}
                                                                status={exceeded ? "exception" : "normal"}
                                                            />
                                                            <Typography.Text type="secondary" className="text-[11px]">
                                                                {record.storageQuotaExpiresAt
                                                                    ? `至 ${new Date(record.storageQuotaExpiresAt).toLocaleDateString("zh-CN")}`
                                                                    : "永久有效"}
                                                                {record.activeGrantCount ? ` · ${record.activeGrantCount} 个资源包` : ""}
                                                            </Typography.Text>
                                                        </div>
                                                    );
                                                },
                                            },
                                            {
                                                title: "操作",
                                                key: "actions",
                                                fixed: "right",
                                                width: 150,
                                                render: (_, record) => (
                                                    <TableRowActions
                                                        items={[
                                                            {
                                                                key: "quota",
                                                                label: "配额",
                                                                onClick: () => openConfigStorageQuota(record),
                                                            },
                                                            {
                                                                key: "credits",
                                                                label: "积分",
                                                                onClick: () => openAdjustCredits(record),
                                                            },
                                                            {
                                                                key: "role",
                                                                label: record.role === "admin" ? "降级" : "提权",
                                                                confirm: record.role === "admin" ? "确定将其降为普通用户吗？" : "确定将其设为系统管理员吗？",
                                                                onClick: () => void handleUpdateUser(record.id, { role: record.role === "admin" ? "user" : "admin" }),
                                                            },
                                                            {
                                                                key: "status",
                                                                label: record.status === "active" ? "禁用" : "启用",
                                                                danger: record.status === "active",
                                                                disabled: record.id === user.id,
                                                                confirm: record.status === "active" ? "确定禁用该账号吗？其登录会话将立即失效。" : "确定重新启用该账号吗？",
                                                                onClick: () => void handleUpdateUser(record.id, { status: record.status === "active" ? "disabled" : "active" }),
                                                            },
                                                        ]}
                                                    />
                                                ),
                                            },
                                        ]}
                                    />
                                </Card>
                            ),
                        },
                        {
                            key: "redeem-codes",
                            label: (
                                <span className="inline-flex items-center gap-1.5">
                                    <Gift className="size-4" />
                                    兑换码管理
                                </span>
                            ),
                            children: (
                                <div className="flex flex-col gap-4">
                                    {generatedCodes.length ? (
                                        <Alert
                                            type="success"
                                            showIcon
                                            closable
                                            onClose={() => setGeneratedCodes([])}
                                            message={`最新生成的 ${generatedCodes.length} 个兑换码`}
                                            description={
                                                <div className="mt-2 flex flex-col gap-2">
                                                    <Input.TextArea value={generatedCodes.join("\n")} readOnly autoSize={{ minRows: 2, maxRows: 6 }} />
                                                    <div>
                                                        <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => copyText(generatedCodes.join("\n"), "已复制全部兑换码")}>
                                                            复制全部兑换码
                                                        </Button>
                                                    </div>
                                                </div>
                                            }
                                        />
                                    ) : null}

                                    <Card
                                        title="兑换码管理（每个兑换码仅限 1 人兑换，已使用不可删除）"
                                        extra={
                                            <Space wrap>
                                                <Select
                                                    value={redeemStatusFilter}
                                                    style={{ width: 115 }}
                                                    onChange={(value) => {
                                                        setRedeemPage(1);
                                                        setSelectedRedeemIds([]);
                                                        setRedeemStatusFilter(value);
                                                    }}
                                                    options={[
                                                        { value: "", label: "全部状态" },
                                                        { value: "active", label: "启用中" },
                                                        { value: "disabled", label: "已停用" },
                                                    ]}
                                                />
                                                <Input.Search
                                                    allowClear
                                                    placeholder="搜索兑换码或备注"
                                                    style={{ width: 200 }}
                                                    onSearch={(value) => {
                                                        setRedeemPage(1);
                                                        setSelectedRedeemIds([]);
                                                        setRedeemQuery(value.trim());
                                                    }}
                                                />
                                                <Button
                                                    type="primary"
                                                    icon={<Plus className="size-4" />}
                                                    onClick={() => {
                                                        createRedeemForm.setFieldsValue({
                                                            kind: redeemActiveKind,
                                                            count: 1,
                                                            credits: 100,
                                                            storageQuotaMb: 1024,
                                                            storageDurationDays: 30,
                                                            prefix: redeemActiveKind === "storage" ? "ST" : "IC",
                                                            customCode: "",
                                                            expiresAt: null,
                                                            note: "",
                                                        });
                                                        setCreateRedeemOpen(true);
                                                    }}
                                                >
                                                    {redeemActiveKind === "storage" ? "生成存储兑换码" : "生成积分兑换码"}
                                                </Button>
                                            </Space>
                                        }
                                    >
                                        <Tabs
                                            activeKey={redeemActiveKind}
                                            onChange={(key) => {
                                                setRedeemPage(1);
                                                setSelectedRedeemIds([]);
                                                setRedeemActiveKind(key as RedeemCodeKind);
                                            }}
                                            items={[
                                                { key: "credits", label: "积分兑换码" },
                                                { key: "storage", label: "云端存储兑换码" },
                                            ]}
                                        />

                                        {selectedRedeemIds.length > 0 ? (
                                            <div
                                                className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs"
                                                style={{ borderColor: token.colorBorderSecondary, background: token.colorFillAlter }}
                                            >
                                                <span>
                                                    已选择 <strong>{selectedRedeemIds.length}</strong> 个兑换码
                                                    {hasSelectedUsedRedeem ? (
                                                        <Typography.Text type="danger" className="ml-2">
                                                            （包含已使用兑换码，不可批量删除）
                                                        </Typography.Text>
                                                    ) : null}
                                                </span>
                                                <Space>
                                                    <Button size="small" icon={<Copy className="size-3.5" />} onClick={handleBatchCopyRedeemCodes}>
                                                        批量复制
                                                    </Button>
                                                    <Tooltip title={hasSelectedUsedRedeem ? "已使用过的兑换码不能删除，请取消勾选后再试" : undefined}>
                                                        {hasSelectedUsedRedeem ? (
                                                            <Button size="small" danger disabled icon={<Trash2 className="size-3.5" />}>
                                                                批量删除
                                                            </Button>
                                                        ) : (
                                                            <Popconfirm
                                                                title={`确定删除选中的 ${selectedRedeemIds.length} 个未使用兑换码吗？`}
                                                                onConfirm={() => void handleBatchDeleteRedeemCodes()}
                                                            >
                                                                <Button size="small" danger loading={batchDeletingRedeem} icon={<Trash2 className="size-3.5" />}>
                                                                    批量删除
                                                                </Button>
                                                            </Popconfirm>
                                                        )}
                                                    </Tooltip>
                                                    <Button size="small" type="text" onClick={() => setSelectedRedeemIds([])}>
                                                        取消选择
                                                    </Button>
                                                </Space>
                                            </div>
                                        ) : null}

                                        <Table<RedeemCodeItem>
                                            rowKey="id"
                                            className={ADMIN_TABLE_CLASS}
                                            scroll={ADMIN_TABLE_SCROLL}
                                            loading={redeemLoading}
                                            dataSource={redeemItems}
                                            rowSelection={{
                                                selectedRowKeys: selectedRedeemIds,
                                                onChange: (keys) => setSelectedRedeemIds(keys.map(String)),
                                            }}
                                            pagination={{
                                                current: redeemPage,
                                                pageSize: 15,
                                                total: redeemTotal,
                                                onChange: (page) => {
                                                    setSelectedRedeemIds([]);
                                                    setRedeemPage(page);
                                                },
                                            }}
                                            columns={[
                                                {
                                                    title: "兑换码",
                                                    dataIndex: "code",
                                                    width: 210,
                                                    render: (code: string) => (
                                                        <Space size={4}>
                                                            <Typography.Text code>{code}</Typography.Text>
                                                            <Button size="small" type="text" icon={<Copy className="size-3.5" />} onClick={() => copyText(code)} />
                                                        </Space>
                                                    ),
                                                },
                                                {
                                                    title: "兑换内容",
                                                    key: "reward",
                                                    width: 185,
                                                    render: (_, record) =>
                                                        record.kind === "storage" ? (
                                                            <Tag color="cyan">
                                                                +{formatBytes(record.storageQuotaBytes)}
                                                                {record.storageDurationDays ? ` · ${record.storageDurationDays} 天` : " · 永久"}
                                                            </Tag>
                                                        ) : (
                                                            <Tag color="gold">+{record.credits} 积分</Tag>
                                                        ),
                                                },
                                                {
                                                    title: "状态",
                                                    key: "state",
                                                    width: 90,
                                                    render: (_, record) => {
                                                        if (record.usedCount > 0 || record.usedCount >= record.maxUses) return <Tag color="orange">已使用</Tag>;
                                                        if (record.status === "disabled") return <Tag color="default">已停用</Tag>;
                                                        if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) return <Tag color="red">已过期</Tag>;
                                                        return <Tag color="green">可用</Tag>;
                                                    },
                                                },
                                                {
                                                    title: "兑换人 / 兑换时间",
                                                    key: "redemption",
                                                    width: 250,
                                                    render: (_, record) => {
                                                        const r = record.redemption;
                                                        if (!r) return <Typography.Text type="secondary">—</Typography.Text>;
                                                        return (
                                                            <div className="flex flex-col text-xs leading-5">
                                                                <div className="flex items-center gap-1.5">
                                                                    <span className="font-medium">{r.username || r.displayName || "未知用户"}</span>
                                                                    <Typography.Text type="secondary" code className="text-[11px]">
                                                                        {r.userId}
                                                                    </Typography.Text>
                                                                    <Button size="small" type="text" icon={<Copy className="size-3" />} onClick={() => copyText(r.userId, "已复制用户 ID")} />
                                                                </div>
                                                                <Typography.Text type="secondary" className="text-[11px]">
                                                                    {new Date(r.redeemedAt).toLocaleString("zh-CN")}
                                                                </Typography.Text>
                                                            </div>
                                                        );
                                                    },
                                                },
                                                {
                                                    title: "过期时间",
                                                    dataIndex: "expiresAt",
                                                    width: 170,
                                                    render: (v?: string | null) => (v ? new Date(v).toLocaleString("zh-CN") : "永不过期"),
                                                },
                                                {
                                                    title: "备注",
                                                    dataIndex: "note",
                                                    width: 180,
                                                    render: (v: string) => (
                                                        <Typography.Text ellipsis={{ tooltip: v || "—" }} className="block max-w-[160px]">
                                                            {v || "—"}
                                                        </Typography.Text>
                                                    ),
                                                },
                                                {
                                                    title: "操作",
                                                    key: "actions",
                                                    fixed: "right",
                                                    width: 100,
                                                    render: (_, record) => (
                                                        <TableRowActions
                                                            items={[
                                                                {
                                                                    key: "toggle",
                                                                    label: record.status === "active" ? "停用" : "启用",
                                                                    disabled: record.usedCount > 0,
                                                                    onClick: () => void handleToggleRedeemStatus(record),
                                                                },
                                                                {
                                                                    key: "delete",
                                                                    label: "删除",
                                                                    danger: true,
                                                                    disabled: record.usedCount > 0,
                                                                    confirm: "确定删除该兑换码吗？",
                                                                    onClick: () => void handleDeleteRedeemCode(record.id),
                                                                },
                                                            ]}
                                                        />
                                                    ),
                                                },
                                            ]}
                                        />
                                    </Card>
                                </div>
                            ),
                        },
                        {
                            key: "media",
                            label: (
                                <span className="inline-flex items-center gap-1.5">
                                    <Database className="size-4" />
                                    媒体监控
                                </span>
                            ),
                            children: (
                                <Card
                                    title={
                                        mediaSubTab !== "media"
                                            ? `云端业务数据监控（画布 ${mediaWorkspaceStats.canvasProjects} · 生图 ${mediaWorkspaceStats.imageLogs} · 视频 ${mediaWorkspaceStats.videoLogs}）`
                                            : mediaQuery || mediaKindFilter || mediaModuleFilter
                                              ? `云端媒体文件监控（筛选命中 ${mediaTotal} 个，合计 ${formatBytes(mediaFilteredBytes ?? 0)} / 全站总计 ${formatBytes(totalStorageBytes)}）`
                                              : `云端媒体文件监控（共 ${mediaTotal} 个，总计 ${formatBytes(mediaFilteredBytes ?? totalStorageBytes)}）`
                                    }
                                    extra={
                                        mediaSubTab === "media" ? (
                                            <Space wrap>
                                                <Select
                                                    value={mediaModuleFilter}
                                                    style={{ width: 130 }}
                                                    onChange={(value) => {
                                                        setMediaPage(1);
                                                        setMediaModuleFilter(value);
                                                    }}
                                                    options={MEDIA_MODULE_OPTIONS}
                                                />
                                                <Select
                                                    value={mediaKindFilter}
                                                    style={{ width: 120 }}
                                                    onChange={(value) => {
                                                        setMediaPage(1);
                                                        setMediaKindFilter(value);
                                                    }}
                                                    options={[
                                                        { value: "", label: "全部类型" },
                                                        { value: "image", label: "图片" },
                                                        { value: "video", label: "视频" },
                                                        { value: "audio", label: "音频" },
                                                        { value: "file", label: "其他文件" },
                                                    ]}
                                                />
                                                <Input.Search
                                                    allowClear
                                                    placeholder="搜索路径或用户名"
                                                    style={{ width: 220 }}
                                                    onSearch={(value) => {
                                                        setMediaPage(1);
                                                        setMediaQuery(value.trim());
                                                    }}
                                                />
                                                <Button icon={<RefreshCw className="size-4" />} loading={mediaLoading} onClick={() => void loadMedia()}>
                                                    刷新
                                                </Button>
                                            </Space>
                                        ) : (
                                            <Space wrap>
                                                <Input.Search
                                                    allowClear
                                                    placeholder="搜索标题、提示词或用户名"
                                                    style={{ width: 220 }}
                                                    onSearch={(value) => {
                                                        setWorkspaceDataPage(1);
                                                        setWorkspaceDataQuery(value.trim());
                                                    }}
                                                />
                                                <Button icon={<RefreshCw className="size-4" />} loading={workspaceDataLoading} onClick={() => void loadWorkspaceData()}>
                                                    刷新
                                                </Button>
                                            </Space>
                                        )
                                    }
                                >
                                    <Tabs
                                        activeKey={mediaSubTab}
                                        onChange={(key) => {
                                            setMediaSubTab(key as "media" | "canvas" | "image_workbench" | "video_workbench");
                                            setWorkspaceDataPage(1);
                                        }}
                                        items={[
                                            {
                                                key: "media",
                                                label: `云端媒体文件 (${mediaTotal})`,
                                                children: (
                                                    <Table<MediaItem>
                                                        rowKey="id"
                                                        className={ADMIN_TABLE_CLASS}
                                                        scroll={ADMIN_TABLE_SCROLL}
                                                        loading={mediaLoading}
                                                        dataSource={mediaItems}
                                                        pagination={{
                                                            current: mediaPage,
                                                            pageSize: 12,
                                                            total: mediaTotal,
                                                            onChange: (page) => setMediaPage(page),
                                                        }}
                                                        columns={[
                                                            {
                                                                title: "预览 / 对象路径",
                                                                key: "preview",
                                                                width: 300,
                                                                render: (_, record) => (
                                                                    <div className="flex max-w-[280px] items-center gap-3">
                                                                        {record.thumbnailUrl ? (
                                                                            <img src={record.thumbnailUrl} alt={record.objectKey} className="size-10 shrink-0 rounded object-cover" />
                                                                        ) : (
                                                                            <div className="flex size-10 shrink-0 items-center justify-center rounded bg-black/5 text-stone-400 dark:bg-white/10">
                                                                                {record.kind === "video" ? <Video className="size-4" /> : record.kind === "audio" ? <AudioLines className="size-4" /> : record.kind === "image" ? <ImageIcon className="size-4" /> : <FileIcon className="size-4" />}
                                                                            </div>
                                                                        )}
                                                                        <div className="min-w-0">
                                                                            <div className="truncate font-mono text-xs">{record.objectKey}</div>
                                                                            <Typography.Text type="secondary" className="block truncate text-xs">
                                                                                {record.mimeType}
                                                                            </Typography.Text>
                                                                        </div>
                                                                    </div>
                                                                ),
                                                            },
                                                            { title: "所属用户", dataIndex: "username", width: 120 },
                                                            {
                                                                title: "所属模块",
                                                                key: "modules",
                                                                width: 170,
                                                                render: (_, record) => <MediaModuleTags modules={record.modules} />,
                                                            },
                                                            {
                                                                title: "类型",
                                                                dataIndex: "kind",
                                                                width: 85,
                                                                render: (kind: string) => <Tag>{kindLabels[kind] || kind}</Tag>,
                                                            },
                                                            {
                                                                title: "大小",
                                                                dataIndex: "bytes",
                                                                width: 100,
                                                                render: (bytes: number) => formatBytes(bytes),
                                                            },
                                                            {
                                                                title: "上传时间",
                                                                dataIndex: "createdAt",
                                                                width: 170,
                                                                render: (value: string) => new Date(value).toLocaleString("zh-CN"),
                                                            },
                                                            {
                                                                title: "操作",
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
                                                                                          label: "查看",
                                                                                          onClick: () => setPreviewMediaItem(record),
                                                                                      },
                                                                                  ]
                                                                                : []),
                                                                            {
                                                                                key: "delete",
                                                                                label: "删除",
                                                                                danger: true,
                                                                                confirm: "确定从对象存储中删除该文件并扣减用户已用容量吗？",
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
                                                    { key: "canvas", label: `无限画布 (${mediaWorkspaceStats.canvasProjects})` },
                                                    { key: "image_workbench", label: `生图工作台 (${mediaWorkspaceStats.imageLogs})` },
                                                    { key: "video_workbench", label: `视频工作台 (${mediaWorkspaceStats.videoLogs})` },
                                                ] as const
                                            ).map((tabCfg) => ({
                                                key: tabCfg.key,
                                                label: tabCfg.label,
                                                children: (
                                                    <Table<WorkspaceDataItem>
                                                        rowKey="id"
                                                        className={ADMIN_TABLE_CLASS}
                                                        scroll={ADMIN_TABLE_SCROLL}
                                                        loading={workspaceDataLoading}
                                                        dataSource={workspaceDataItems}
                                                        pagination={{
                                                            current: workspaceDataPage,
                                                            pageSize: 12,
                                                            total: workspaceDataTotal,
                                                            onChange: (page) => setWorkspaceDataPage(page),
                                                        }}
                                                        columns={[
                                                            {
                                                                title: tabCfg.key === "canvas" ? "画布名称" : "标题 / 提示词",
                                                                key: "title",
                                                                width: 280,
                                                                render: (_, rec) => (
                                                                    <div className="max-w-[260px] truncate" title={rec.prompt || rec.title}>
                                                                        {rec.prompt || rec.title}
                                                                    </div>
                                                                ),
                                                            },
                                                            { title: "所属用户", dataIndex: "username", width: 120 },
                                                            tabCfg.key === "canvas"
                                                                ? { title: "节点数", dataIndex: "nodeCount", width: 90 }
                                                                : { title: "模型", dataIndex: "model", width: 170, ellipsis: true },
                                                            { title: "关联媒体", dataIndex: "mediaCount", width: 95, render: (v: number) => `${v ?? 0} 个` },
                                                            {
                                                                title: "数据大小",
                                                                key: "mediaBytes",
                                                                width: 150,
                                                                render: (_, rec) => <WorkspaceSizeCell mediaBytes={rec.mediaBytes} dataBytes={rec.dataBytes} />,
                                                            },
                                                            { title: "更新时间", dataIndex: "updatedAt", width: 170, render: (v: string) => new Date(v).toLocaleString("zh-CN") },
                                                            {
                                                                title: "操作",
                                                                key: "actions",
                                                                fixed: "right",
                                                                width: 85,
                                                                render: (_, rec) => (
                                                                    <TableRowActions
                                                                        items={[
                                                                            {
                                                                                key: "delete",
                                                                                label: "删除",
                                                                                danger: true,
                                                                                confirm: "确定删除该云端记录并清理孤立媒体文件吗？",
                                                                                onClick: () =>
                                                                                    void adminApi.deleteWorkspaceData(rec.kind, rec.id).then(() => {
                                                                                        message.success("已删除云端记录");
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
                                                                                        void loadOverview(overviewDays);
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
                            ),
                        },
                        {
                            key: "storage",
                            label: (
                                <span className="inline-flex items-center gap-1.5">
                                    <HardDrive className="size-4" />
                                    对象存储
                                </span>
                            ),
                            children: (
                                <div className="flex flex-col gap-5">
                                    <Card
                                        title="S3 兼容对象存储配置（R2 / 阿里云 OSS / 腾讯云 COS / MinIO）"
                                        extra={storageConfigured ? <Tag color="green">已配置</Tag> : <Tag color="orange">待配置</Tag>}
                                    >
                                        <Alert
                                            type="info"
                                            showIcon
                                            className="mb-4"
                                            message="浏览器直传需要存储桶开启 CORS"
                                            description="请在测试桶的跨域设置中允许当前站点来源使用 GET、PUT、HEAD 方法，并暴露 ETag 响应头。"
                                        />
                                        <Form
                                            form={storageForm}
                                            layout="vertical"
                                            initialValues={{ provider: "r2", region: "auto", forcePathStyle: false }}
                                            onFinish={handleSaveStorage}
                                        >
                                            <Row gutter={16}>
                                                <Col xs={24} md={8}>
                                                    <Form.Item name="provider" label="服务商类型" rules={[{ required: true }]}>
                                                        <Select
                                                            options={[
                                                                { value: "r2", label: "Cloudflare R2" },
                                                                { value: "oss", label: "阿里云 OSS（S3 兼容端点）" },
                                                                { value: "cos", label: "腾讯云 COS（S3 兼容端点）" },
                                                                { value: "s3", label: "通用 S3 / MinIO" },
                                                            ]}
                                                        />
                                                    </Form.Item>
                                                </Col>
                                                <Col xs={24} md={8}>
                                                    <Form.Item name="bucket" label="Bucket 名称" rules={[{ required: true, message: "请输入 Bucket 名称" }]}>
                                                        <Input placeholder="my-canvas-bucket" />
                                                    </Form.Item>
                                                </Col>
                                                <Col xs={24} md={8}>
                                                    <Form.Item name="region" label="Region（R2 填 auto）" rules={[{ required: true, message: "请输入 Region" }]}>
                                                        <Input placeholder="auto / cn-hangzhou / ap-guangzhou" />
                                                    </Form.Item>
                                                </Col>
                                                <Col xs={24} md={12}>
                                                    <Form.Item name="endpoint" label="Endpoint 地址">
                                                        <Input placeholder="https://<account_id>.r2.cloudflarestorage.com 或 OSS/COS 端点" />
                                                    </Form.Item>
                                                </Col>
                                                <Col xs={24} md={12}>
                                                    <Form.Item name="publicBaseUrl" label="自定义公开访问域名（可选，留空则使用签名 URL）">
                                                        <Input placeholder="https://cdn.example.com" />
                                                    </Form.Item>
                                                </Col>
                                                <Col xs={24} md={12}>
                                                    <Form.Item name="accessKeyId" label="AccessKey ID" rules={[{ required: true, message: "请输入 AccessKey ID" }]}>
                                                        <Input placeholder="AccessKey ID" />
                                                    </Form.Item>
                                                </Col>
                                                <Col xs={24} md={12}>
                                                    <Form.Item
                                                        name="secretAccessKey"
                                                        label={`SecretAccessKey${storagePreview ? `（已保存：${storagePreview}，留空则保持不变）` : ""}`}
                                                        rules={storageConfigured ? [] : [{ required: true, message: "请输入 SecretAccessKey" }]}
                                                    >
                                                        <Input.Password placeholder={storagePreview ? "留空表示沿用已保存密钥" : "输入 SecretAccessKey"} />
                                                    </Form.Item>
                                                </Col>
                                                <Col xs={24}>
                                                    <Form.Item name="forcePathStyle" label="Path-Style 访问（MinIO 通常开启，OSS/COS/R2 通常关闭）" valuePropName="checked">
                                                        <Switch />
                                                    </Form.Item>
                                                </Col>
                                            </Row>
                                            <Space>
                                                <Button onClick={handleTestStorage} loading={storageTesting}>
                                                    测试连接（读写删探针）
                                                </Button>
                                                <Button type="primary" htmlType="submit" loading={storageSaving}>
                                                    保存配置
                                                </Button>
                                            </Space>
                                        </Form>
                                    </Card>

                                    <Card
                                        title="端到端直传测试"
                                        extra={
                                            <Upload showUploadList={false} customRequest={handleDirectUploadTest} disabled={!storageConfigured || uploadingTest}>
                                                <Button type="primary" icon={<UploadCloud className="size-4" />} loading={uploadingTest} disabled={!storageConfigured}>
                                                    上传测试文件
                                                </Button>
                                            </Upload>
                                        }
                                    >
                                        <Typography.Text type="secondary">上传后可在「媒体监控」页签中查看记录、打开签名链接或删除释放空间。</Typography.Text>
                                    </Card>
                                </div>
                            ),
                        },
                        {
                            key: "settings",
                            label: (
                                <span className="inline-flex items-center gap-1.5">
                                    <Sliders className="size-4" />
                                    系统设置
                                </span>
                            ),
                            children: [
                                {
                                    key: "settings-auth",
                                    label: (
                                        <span className="inline-flex items-center gap-1.5">
                                            <Shield className="size-3.5" />
                                            注册与安全
                                        </span>
                                    ),
                                    pageTitle: "系统设置 · 注册与安全",
                                    children: (
                                        <Card title="注册与安全策略">
                                            <div className="flex flex-col gap-4">
                                                <div className="flex items-center justify-between gap-4">
                                                    <div>
                                                        <div className="font-medium">允许开放注册</div>
                                                        <Typography.Text type="secondary">
                                                            关闭后仅现有管理员可登录，普通用户无法通过注册页自主创建账号（系统首个管理员不受此限制）
                                                        </Typography.Text>
                                                    </div>
                                                    <Switch
                                                        checked={allowRegister}
                                                        loading={authPolicySaving}
                                                        onChange={(checked) => void handleUpdateAuthPolicy({ allowRegister: checked })}
                                                    />
                                                </div>
                                                <div className="flex items-center justify-between gap-4 border-t border-black/5 pt-4 dark:border-white/5">
                                                    <div>
                                                        <div className="font-medium">注册时必须绑定并验证邮箱</div>
                                                        <Typography.Text type="secondary">
                                                            开启后新用户注册必须填写邮箱并通过邮件验证码校验（需先在「邮件服务」中启用并完成配置；首个初始化管理员不受限制）
                                                        </Typography.Text>
                                                    </div>
                                                    <Switch
                                                        checked={requireEmailOnRegister}
                                                        disabled={!mailReady && !requireEmailOnRegister}
                                                        loading={authPolicySaving}
                                                        onChange={(checked) => void handleUpdateAuthPolicy({ requireEmailOnRegister: checked })}
                                                    />
                                                </div>
                                            </div>
                                        </Card>
                                    ),
                                },
                                {
                                    key: "settings-mail",
                                    label: (
                                        <span className="inline-flex items-center gap-1.5">
                                            <Mail className="size-3.5" />
                                            邮件服务
                                        </span>
                                    ),
                                    pageTitle: "系统设置 · 邮件服务",
                                    children: (
                                        <Card
                                            title={
                                                <span className="inline-flex items-center gap-2">
                                                    <Mail className="size-4" />
                                                    邮件服务配置（SMTP 与余额不足提醒）
                                                </span>
                                            }
                                            extra={<Tag color={mailReady ? "green" : "default"}>{mailReady ? "已启用" : "未启用"}</Tag>}
                                        >
                                            <Form
                                                form={mailForm}
                                                layout="vertical"
                                                initialValues={{
                                                    enabled: false,
                                                    port: 465,
                                                    secure: true,
                                                    fromName: "无限画布",
                                                    lowBalanceAlertEnabled: true,
                                                    lowBalanceThreshold: 10,
                                                    lowBalanceCooldownHours: 24,
                                                }}
                                                onFinish={handleSaveMailSettings}
                                            >
                                                <Row gutter={16}>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item name="enabled" label="启用平台邮件服务" valuePropName="checked">
                                                            <Switch />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item name="secure" label="使用 SSL/TLS 加密连接（465 端口通常开启，587 通常关闭）" valuePropName="checked">
                                                            <Switch />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item name="host" label="SMTP 服务器地址">
                                                            <Input placeholder="如 smtp.qq.com 或 smtp.gmail.com" />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item name="port" label="SMTP 端口">
                                                            <InputNumber min={1} max={65535} className="w-full" placeholder="465" />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item name="username" label="SMTP 登录账号">
                                                            <Input placeholder="通常与发件人邮箱一致" />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item
                                                            name="password"
                                                            label={`SMTP 密码 / 授权码${mailPasswordPreview ? `（已保存：${mailPasswordPreview}，留空则保持不变）` : ""}`}
                                                        >
                                                            <Input.Password placeholder={mailPasswordPreview ? "留空表示沿用已保存密码" : "输入 SMTP 密码或授权码"} />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item name="fromName" label="发件人显示名称">
                                                            <Input placeholder="无限画布" />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item
                                                            name="fromAddress"
                                                            label="发件人邮箱地址"
                                                            rules={[{ type: "email", message: "请输入有效的发件人邮箱地址" }]}
                                                        >
                                                            <Input placeholder="noreply@example.com" />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={8}>
                                                        <Form.Item name="lowBalanceAlertEnabled" label="全局默认开启余额不足邮件提醒" valuePropName="checked">
                                                            <Switch />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={8}>
                                                        <Form.Item name="lowBalanceThreshold" label="默认低余额提醒阈值（积分）">
                                                            <InputNumber min={0} max={1000000} precision={2} className="w-full" />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={8}>
                                                        <Form.Item name="lowBalanceCooldownHours" label="同用户提醒最小冷却间隔（小时）">
                                                            <InputNumber min={1} max={720} className="w-full" />
                                                        </Form.Item>
                                                    </Col>
                                                </Row>
                                                <div className="flex flex-wrap items-center justify-between gap-3">
                                                    <Space wrap>
                                                        <Input
                                                            value={testMailTo}
                                                            onChange={(e) => setTestMailTo(e.target.value)}
                                                            placeholder="输入测试收件邮箱"
                                                            style={{ width: 240 }}
                                                        />
                                                        <Button icon={<Send className="size-4" />} onClick={() => void handleTestMailSettings()} loading={mailTesting}>
                                                            发送测试邮件
                                                        </Button>
                                                    </Space>
                                                    <Button type="primary" htmlType="submit" loading={mailSaving}>
                                                        保存邮件配置
                                                    </Button>
                                                </div>
                                            </Form>
                                        </Card>
                                    ),
                                },
                                {
                                    key: "settings-webdav",
                                    label: (
                                        <span className="inline-flex items-center gap-1.5">
                                            <Wifi className="size-3.5" />
                                            WebDAV 同步
                                        </span>
                                    ),
                                    pageTitle: "系统设置 · WebDAV 同步",
                                    children: (
                                        <Card title="平台 WebDAV 服务配置（统一管理与按用户分配）">
                                            <Form
                                                form={webdavForm}
                                                layout="vertical"
                                                initialValues={{ enabled: false, baseDirectory: "infinite-canvas", autoAssignNewUsers: false }}
                                                onFinish={handleSavePlatformWebdav}
                                            >
                                                <Row gutter={16}>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item name="enabled" label="启用平台 WebDAV 服务" valuePropName="checked">
                                                            <Switch />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item name="autoAssignNewUsers" label="新用户注册时自动分配专属子目录" valuePropName="checked">
                                                            <Switch />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item name="url" label="WebDAV 服务地址">
                                                            <Input placeholder="https://nas.example.com/webdav" />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item name="baseDirectory" label="默认根目录">
                                                            <Input placeholder="infinite-canvas" />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item name="username" label="默认用户名">
                                                            <Input placeholder="WebDAV 用户名" />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item
                                                            name="password"
                                                            label={`默认密码${webdavPasswordPreview ? `（已保存：${webdavPasswordPreview}，留空则保持不变）` : ""}`}
                                                        >
                                                            <Input.Password placeholder={webdavPasswordPreview ? "留空表示沿用已保存密码" : "输入 WebDAV 密码"} />
                                                        </Form.Item>
                                                    </Col>
                                                </Row>
                                                <Space>
                                                    <Button icon={<Wifi className="size-4" />} onClick={() => void handleTestPlatformWebdav()} loading={webdavTesting}>
                                                        测试连接
                                                    </Button>
                                                    <Button type="primary" htmlType="submit" loading={webdavSaving}>
                                                        保存 WebDAV 配置
                                                    </Button>
                                                </Space>
                                            </Form>
                                        </Card>
                                    ),
                                },
                            ],
                        },
    ];

    type NavTabItem = {
        key: string;
        label: ReactNode;
        pageTitle?: string;
        children: ReactNode | NavTabItem[];
    };

    const flattenTabItems = (items: NavTabItem[]): Array<{ key: string; label: ReactNode; pageTitle?: string; children: ReactNode }> =>
        items.flatMap((item) =>
            Array.isArray(item.children)
                ? flattenTabItems(item.children)
                : [{ key: item.key, label: item.label, pageTitle: item.pageTitle, children: item.children }],
        );

    const allSections = flattenTabItems(
        isAdmin ? (isAdminRoute ? [...adminTabs, ...personalTabs] : [...personalTabs, ...adminTabs]) : personalTabs,
    );
    const activeSection = allSections.find((item) => item.key === activeTab) ?? allSections[0];

    const toMenuItem = (item: NavTabItem): NonNullable<MenuProps["items"]>[number] =>
        Array.isArray(item.children)
            ? {
                  key: item.key,
                  label: item.label,
                  children: item.children.map((child) => toMenuItem(child)),
              }
            : {
                  key: item.key,
                  label: item.label,
              };

    const menuItems: MenuProps["items"] = isAdmin
        ? isAdminRoute
            ? [
                  {
                      type: "group",
                      label: "平台管理",
                      children: adminTabs.map(toMenuItem),
                  },
                  {
                      type: "group",
                      label: "个人中心",
                      children: personalTabs.map(toMenuItem),
                  },
              ]
            : [
                  {
                      type: "group",
                      label: "个人中心",
                      children: personalTabs.map(toMenuItem),
                  },
                  {
                      type: "group",
                      label: "平台管理",
                      children: adminTabs.map(toMenuItem),
                  },
              ]
        : personalTabs.map(toMenuItem);

    const handleMenuSelect: MenuProps["onClick"] = ({ key }) => {
        switchTab(key);
        setMobileMenuOpen(false);
    };

    return (
        <div
            className="flex h-full flex-col overflow-hidden"
            style={{ backgroundColor: token.colorBgLayout }}
        >
            <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden p-3 lg:grid-cols-[240px_minmax(0,1fr)]">
                <aside
                    className="thin-scrollbar hidden min-h-0 flex-col overflow-y-auto rounded-lg border p-3 lg:flex"
                    style={{
                        backgroundColor: token.colorBgContainer,
                        borderColor: token.colorBorderSecondary,
                    }}
                >
                    <div className="mb-3 px-2 pt-1">
                        <Typography.Title level={5} style={{ margin: 0 }}>
                            {isAdmin && isAdminRoute ? "管理后台" : "个人后台"}
                        </Typography.Title>
                        <Typography.Text type="secondary" className="text-xs">
                            {isAdmin && isAdminRoute ? "平台管理与个人工作台" : "个人概览、钱包与媒体"}
                        </Typography.Text>
                    </div>
                    <Menu
                        mode="inline"
                        selectedKeys={[activeSection?.key || activeTab]}
                        openKeys={openMenuKeys}
                        onOpenChange={(keys) => setOpenMenuKeys(keys)}
                        items={menuItems}
                        onClick={handleMenuSelect}
                        style={{ borderInlineEnd: 0, background: "transparent" }}
                    />
                </aside>

                <main
                    className="thin-scrollbar flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto rounded-lg border p-5"
                    style={{
                        backgroundColor: token.colorBgContainer,
                        borderColor: token.colorBorderSecondary,
                    }}
                >
                    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                            <Button
                                className="lg:hidden"
                                icon={<MenuIcon className="size-4" />}
                                onClick={() => setMobileMenuOpen(true)}
                            >
                                菜单
                            </Button>
                            <div>
                                <Typography.Title level={4} style={{ margin: 0 }}>
                                    {activeSection?.pageTitle || activeSection?.label}
                                </Typography.Title>
                                <Typography.Text type="secondary" className="text-xs">
                                    {isAdmin && isAdminRoute
                                        ? "模型渠道集中管理、用户与 WebDAV 分配、对象存储、积分、公告与个人中心"
                                        : "账号概览与平台公告、个人安全设置、积分钱包流水及云端媒体管理"}
                                </Typography.Text>
                            </div>
                        </div>
                        {isAdmin && isAdminRoute ? (
                            <Button icon={<RefreshCw className="size-4" />} loading={overviewLoading} onClick={() => void loadOverview(overviewDays)}>
                                刷新数据
                            </Button>
                        ) : null}
                    </div>

                    <div className="w-full min-w-0">{activeSection?.children}</div>
                </main>
            </div>

            <Drawer
                open={mobileMenuOpen}
                placement="left"
                width={260}
                title={isAdmin && isAdminRoute ? "管理后台菜单" : "个人后台菜单"}
                onClose={() => setMobileMenuOpen(false)}
                styles={{ body: { padding: 12 } }}
            >
                <Menu
                    mode="inline"
                    selectedKeys={[activeSection?.key || activeTab]}
                    openKeys={openMenuKeys}
                    onOpenChange={(keys) => setOpenMenuKeys(keys)}
                    items={menuItems}
                    onClick={handleMenuSelect}
                    style={{ borderInlineEnd: 0, background: "transparent" }}
                />
            </Drawer>

            <ChannelEditorDrawer
                open={Boolean(editingChannel)}
                channel={editingChannel}
                onSave={(channel) => void handleSaveChannelDrawer(channel)}
                onClose={() => setEditingChannel(null)}
                onFetchModels={async (channel) => {
                    const res = await adminApi.fetchChannelModels({
                        id: channel.id,
                        baseUrl: channel.baseUrl,
                        apiKey: channel.apiKey,
                        apiFormat: channel.apiFormat,
                    });
                    return res.models;
                }}
            />

            <Modal
                open={Boolean(assigningUser)}
                title={assigningUser ? `为 ${assigningUser.displayName || assigningUser.username} 分配 WebDAV` : "分配 WebDAV"}
                onCancel={() => setAssigningUser(null)}
                onOk={() => userWebdavForm.submit()}
                confirmLoading={userWebdavSaving}
            >
                <Form form={userWebdavForm} layout="vertical" onFinish={handleSaveUserWebdav}>
                    <Form.Item name="enabled" label="开通 WebDAV 同步权限" valuePropName="checked">
                        <Switch />
                    </Form.Item>
                    <Form.Item name="directory" label="分配同步目录（留空则使用平台默认根目录）">
                        <Input placeholder="infinite-canvas/alice" />
                    </Form.Item>
                    <Form.Item name="url" label="独立 WebDAV 地址（可选，留空继承平台默认配置）">
                        <Input placeholder="留空继承平台 WebDAV 地址" />
                    </Form.Item>
                    <Form.Item name="username" label="独立用户名（可选，留空继承平台默认用户名）">
                        <Input placeholder="留空继承平台默认用户名" />
                    </Form.Item>
                    <Form.Item name="password" label="独立密码（可选，留空继承或保留已保存密码）">
                        <Input.Password placeholder="留空继承平台默认密码" />
                    </Form.Item>
                    <Row gutter={12}>
                        <Col span={12}>
                            <Form.Item
                                name="quotaMb"
                                label={`可用空间上限（MB，当前已用 ${formatBytes(assigningUser?.webdavConfig?.usedBytes ?? 0)}）`}
                            >
                                <InputNumber min={0} step={100} className="w-full" placeholder="留空或 0 不限制" />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item name="expiresAt" label="有效期限（留空永久有效）">
                                <DatePicker showTime className="w-full" placeholder="选择过期时间" />
                            </Form.Item>
                        </Col>
                    </Row>
                    {assigningUser?.webdavConfig?.usedBytes ? (
                        <Form.Item name="resetUsedBytes" label="重置已用空间统计为 0" valuePropName="checked">
                            <Switch />
                        </Form.Item>
                    ) : null}
                </Form>
            </Modal>

            <Modal
                open={Boolean(storageQuotaUser)}
                title={
                    storageQuotaUser
                        ? `配置 ${storageQuotaUser.displayName || storageQuotaUser.username} 的云端存储配额`
                        : "配置云端存储配额"
                }
                width={620}
                onCancel={() => setStorageQuotaUser(null)}
                onOk={() => userStorageQuotaForm.submit()}
                confirmLoading={userStorageQuotaSaving}
            >
                <Form form={userStorageQuotaForm} layout="vertical" onFinish={handleSaveUserStorageQuota}>
                    <Alert
                        type="info"
                        showIcon
                        className="mb-4"
                        message={`已用 ${formatBytes(storageQuotaUser?.storageUsedBytes ?? 0)} / 当前有效总配额 ${formatBytes(storageQuotaUser?.storageQuotaBytes ?? 0)}`}
                        description={`总配额 = 管理员基础配额（${formatBytes(storageQuotaUser?.baseStorageQuotaBytes ?? storageQuotaUser?.storageQuotaBytes ?? 0)}）+ 有效独立存储资源包（${formatBytes(storageQuotaUser?.storageGrantsQuotaBytes ?? 0)}）。资源包到期后将自动扣减并回落到剩余有效配额。`}
                    />
                    <Form.Item
                        name="quotaMb"
                        label="管理员基础配额上限（MB，设为 0 则仅依赖存储资源包）"
                        rules={[{ required: true, message: "请输入配额大小（MB）" }]}
                    >
                        <InputNumber min={0} step={100} className="w-full" placeholder="例如：500（表示 500 MB）" />
                    </Form.Item>
                    <div className="mb-4 flex flex-wrap gap-2">
                        {[0, 100, 500, 1024, 5120, 10240].map((mb) => (
                            <Button key={mb} size="small" onClick={() => userStorageQuotaForm.setFieldValue("quotaMb", mb)}>
                                {mb === 0 ? "0 MB" : mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`}
                            </Button>
                        ))}
                    </div>
                    <Form.Item name="expiresAt" label="基础配额有效期限（可选，不填写则不限制时间）">
                        <DatePicker showTime allowClear className="w-full" placeholder="不填写表示永久有效" />
                    </Form.Item>
                    <Form.Item name="recalculateUsedBytes" label="根据当前云端有效媒体重新核算已用空间" valuePropName="checked">
                        <Switch />
                    </Form.Item>
                </Form>

                <div className="mt-2 border-t pt-3" style={{ borderColor: token.colorBorderSecondary }}>
                    <div className="mb-2 flex items-center justify-between">
                        <Typography.Text strong className="text-xs">
                            独立存储资源包记录（{storageQuotaGrants.length}）
                        </Typography.Text>
                        <Typography.Text type="secondary" className="text-xs">
                            每个资源包独立计算过期时间
                        </Typography.Text>
                    </div>
                    {storageQuotaGrantsLoading ? (
                        <Typography.Text type="secondary" className="text-xs">
                            正在加载资源包记录...
                        </Typography.Text>
                    ) : storageQuotaGrants.length ? (
                        <div className="flex max-h-48 flex-col gap-2 overflow-y-auto pr-1">
                            {storageQuotaGrants.map((grant) => (
                                <div
                                    key={grant.id}
                                    className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs"
                                    style={{ borderColor: token.colorBorderSecondary }}
                                >
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-1.5">
                                            <span className="font-medium">+{formatBytes(grant.quotaBytes)}</span>
                                            {grant.status === "revoked" ? (
                                                <Tag color="default" style={{ marginInlineEnd: 0 }}>
                                                    已停用
                                                </Tag>
                                            ) : grant.isExpired ? (
                                                <Tag color="red" style={{ marginInlineEnd: 0 }}>
                                                    已过期
                                                </Tag>
                                            ) : (
                                                <Tag color="green" style={{ marginInlineEnd: 0 }}>
                                                    生效中
                                                </Tag>
                                            )}
                                            {grant.refId ? (
                                                <Typography.Text code className="text-[11px]">
                                                    {grant.refId}
                                                </Typography.Text>
                                            ) : null}
                                        </div>
                                        <Typography.Text type="secondary" className="mt-0.5 block text-[11px]">
                                            {grant.expiresAt
                                                ? `到期：${new Date(grant.expiresAt).toLocaleString("zh-CN")}`
                                                : "永久有效"}
                                            {grant.durationDays ? `（${grant.durationDays} 天）` : ""}
                                            {grant.note ? ` · ${grant.note}` : ""}
                                        </Typography.Text>
                                    </div>
                                    <Button
                                        size="small"
                                        type="link"
                                        danger={grant.status === "active"}
                                        loading={updatingGrantId === grant.id}
                                        onClick={() => void handleToggleStorageGrant(grant)}
                                    >
                                        {grant.status === "active" ? "停用" : "恢复"}
                                    </Button>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <Typography.Text type="secondary" className="text-xs">
                            暂无存储资源包兑换记录
                        </Typography.Text>
                    )}
                </div>
            </Modal>

            <Modal
                open={Boolean(creditUser)}
                title={creditUser ? `调整 ${creditUser.displayName || creditUser.username} 的积分（当前：${creditUser.creditBalance ?? 0}）` : "调整积分"}
                onCancel={() => setCreditUser(null)}
                onOk={() => userCreditForm.submit()}
                confirmLoading={userCreditSaving}
            >
                <Form form={userCreditForm} layout="vertical" onFinish={handleAdjustUserCredits}>
                    <Form.Item name="mode" label="操作类型" rules={[{ required: true }]}>
                        <Radio.Group>
                            <Radio.Button value="add">增加积分（充值 / 赠送）</Radio.Button>
                            <Radio.Button value="deduct">扣减积分</Radio.Button>
                        </Radio.Group>
                    </Form.Item>
                    <Form.Item
                        name="amount"
                        label="积分数量"
                        rules={[{ required: true, message: "请输入积分数量" }]}
                    >
                        <InputNumber className="w-full" min={0.0001} step={10} />
                    </Form.Item>
                    <Form.Item name="note" label="备注说明（可选）">
                        <Input placeholder="例如：管理员充值 / 活动赠送 / 异常补扣" />
                    </Form.Item>
                </Form>
            </Modal>

            <Modal
                open={createRedeemOpen}
                title="批量生成兑换码"
                onCancel={() => setCreateRedeemOpen(false)}
                onOk={() => createRedeemForm.submit()}
                confirmLoading={creatingRedeem}
            >
                <Form form={createRedeemForm} layout="vertical" onFinish={handleCreateRedeemCodes}>
                    <Form.Item name="kind" label="兑换码类型" rules={[{ required: true }]}>
                        <Radio.Group
                            optionType="button"
                            buttonStyle="solid"
                            onChange={(e) => {
                                const nextKind = e.target.value as RedeemCodeKind;
                                const currentPrefix = String(createRedeemForm.getFieldValue("prefix") || "").trim().toUpperCase();
                                if (!currentPrefix || currentPrefix === "IC" || currentPrefix === "ST") {
                                    createRedeemForm.setFieldValue("prefix", nextKind === "storage" ? "ST" : "IC");
                                }
                            }}
                            options={[
                                { label: "积分兑换码", value: "credits" },
                                { label: "云端存储兑换码", value: "storage" },
                            ]}
                        />
                    </Form.Item>
                    <Row gutter={12}>
                        <Col span={12}>
                            <Form.Item name="count" label="生成数量（1 ~ 100）" rules={[{ required: true, message: "请输入数量" }]}>
                                <InputNumber className="w-full" min={1} max={100} />
                            </Form.Item>
                        </Col>
                        {redeemKindWatch === "credits" ? (
                            <Col span={12}>
                                <Form.Item name="credits" label="单个面值（积分）" rules={[{ required: true, message: "请输入积分面值" }]}>
                                    <InputNumber className="w-full" min={0.01} step={10} />
                                </Form.Item>
                            </Col>
                        ) : (
                            <Col span={12}>
                                <Form.Item name="storageQuotaMb" label="存储容量（MB）" rules={[{ required: true, message: "请输入存储容量（MB）" }]}>
                                    <InputNumber className="w-full" min={1} step={100} />
                                </Form.Item>
                            </Col>
                        )}
                    </Row>
                    {redeemKindWatch === "storage" ? (
                        <>
                            <div className="mb-3 flex flex-wrap gap-1.5">
                                {[100, 500, 1024, 5120, 10240].map((mb) => (
                                    <Button key={mb} size="small" onClick={() => createRedeemForm.setFieldValue("storageQuotaMb", mb)}>
                                        {mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`}
                                    </Button>
                                ))}
                            </div>
                            <Form.Item name="storageDurationDays" label="资源包有效天数（留空表示永久有效，到期后自动回落）">
                                <InputNumber className="w-full" min={1} max={36500} placeholder="例如：30（留空为永久）" />
                            </Form.Item>
                            <div className="mb-4 flex flex-wrap gap-1.5">
                                {[7, 30, 90, 365].map((d) => (
                                    <Button key={d} size="small" onClick={() => createRedeemForm.setFieldValue("storageDurationDays", d)}>
                                        {d} 天
                                    </Button>
                                ))}
                                <Button size="small" onClick={() => createRedeemForm.setFieldValue("storageDurationDays", null)}>
                                    永久
                                </Button>
                            </div>
                        </>
                    ) : null}
                    <Row gutter={12}>
                        <Col span={12}>
                            <Form.Item name="prefix" label="兑换码前缀">
                                <Input placeholder={redeemKindWatch === "storage" ? "ST" : "IC"} maxLength={16} />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item label="兑换限制">
                                <Input value="每个码仅限 1 人兑换" disabled />
                            </Form.Item>
                        </Col>
                    </Row>
                    {redeemCountWatch === 1 ? (
                        <Form.Item name="customCode" label="自定义兑换码（可选，留空自动随机生成）">
                            <Input placeholder={redeemKindWatch === "storage" ? "例如：ST-2026-2GB" : "例如：VIP-2026-GIFT"} maxLength={64} />
                        </Form.Item>
                    ) : null}
                    <Form.Item name="expiresAt" label="兑换码本身过期时间（可选，留空永不过期）">
                        <DatePicker showTime className="w-full" placeholder="选择过期时间" />
                    </Form.Item>
                    <Form.Item name="note" label="备注（可选）">
                        <Input placeholder="例如：内测用户礼包 / 活动兑换码" maxLength={200} />
                    </Form.Item>
                </Form>
            </Modal>

            <Modal
                open={Boolean(previewMediaItem)}
                title="媒体原文件预览"
                onCancel={() => setPreviewMediaItem(null)}
                footer={
                    <Space>
                        {previewMediaItem ? (
                            <Button
                                icon={<Download className="size-4" />}
                                loading={downloadingPreviewMedia}
                                onClick={() => {
                                    setDownloadingPreviewMedia(true);
                                    void storageApi
                                        .downloadFile(previewMediaItem)
                                        .catch((error) => {
                                            message.error(error instanceof Error ? error.message : "下载失败");
                                        })
                                        .finally(() => setDownloadingPreviewMedia(false));
                                }}
                            >
                                下载原文件
                            </Button>
                        ) : null}
                        <Button type="primary" onClick={() => setPreviewMediaItem(null)}>
                            关闭
                        </Button>
                    </Space>
                }
                width={780}
                destroyOnHidden
            >
                {previewMediaItem?.url ? (
                    previewMediaItem.kind === "image" ? (
                        <div className="flex justify-center rounded-lg bg-black/5 p-2 dark:bg-white/5">
                            <Image src={previewMediaItem.url} alt={previewMediaItem.objectKey} className="max-h-[70vh] object-contain" />
                        </div>
                    ) : previewMediaItem.kind === "video" ? (
                        <video src={previewMediaItem.url} controls autoPlay className="max-h-[70vh] w-full rounded-lg bg-black" />
                    ) : previewMediaItem.kind === "audio" ? (
                        <div className="flex justify-center py-6">
                            <audio src={previewMediaItem.url} controls autoPlay className="w-full max-w-md" />
                        </div>
                    ) : (
                        <a href={previewMediaItem.url} target="_blank" rel="noreferrer">
                            打开文件链接
                        </a>
                    )
                ) : null}
            </Modal>

            <Modal
                open={announcementModalOpen}
                title={editingAnnouncement ? "编辑公告" : "发布平台公告"}
                onCancel={() => {
                    setAnnouncementModalOpen(false);
                    setEditingAnnouncement(null);
                }}
                onOk={() => announcementForm.submit()}
                confirmLoading={announcementSaving}
            >
                <Form form={announcementForm} layout="vertical" onFinish={handleSaveAnnouncement}>
                    <Form.Item name="title" label="公告标题" rules={[{ required: true, message: "请输入公告标题" }]}>
                        <Input placeholder="例如：模型计费调整 / 维护通知" maxLength={120} />
                    </Form.Item>
                    <Form.Item name="level" label="公告类型" rules={[{ required: true }]}>
                        <Select
                            options={[
                                { label: "普通通知", value: "info" },
                                { label: "更新公告", value: "success" },
                                { label: "重要提醒", value: "warning" },
                            ]}
                        />
                    </Form.Item>
                    <Form.Item name="content" label="公告正文" rules={[{ required: true, message: "请输入公告内容" }]}>
                        <Input.TextArea rows={5} placeholder="输入要向全体用户展示的公告详情..." maxLength={4000} showCount />
                    </Form.Item>
                    <Row gutter={16}>
                        <Col span={12}>
                            <Form.Item name="isPinned" label="置顶展示" valuePropName="checked">
                                <Switch />
                            </Form.Item>
                        </Col>
                        <Col span={12}>
                            <Form.Item name="isPublished" label="立即发布展示" valuePropName="checked">
                                <Switch />
                            </Form.Item>
                        </Col>
                    </Row>
                </Form>
            </Modal>
        </div>
    );
}
