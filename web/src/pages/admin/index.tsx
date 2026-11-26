/** 后台管理与个人后台入口页：采用左侧导航菜单与全宽内容区，管理员支持平台全局管控与个人中心切换。 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Alert, App, Button, Card, Col, DatePicker, Descriptions, Drawer, Form, Image, Input, InputNumber, Menu, Modal, Popconfirm, Progress, Radio, Result, Row, Select, Space, Spin, Statistic, Switch, Table, Tabs, Tag, Tooltip, Typography, Upload, theme as antdTheme } from "antd";
import type { MenuProps, UploadProps } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import type { TFunction } from "i18next";
import { AudioLines, BarChart3, Copy, Coins, Cpu, Database, Download, FileIcon, FolderKanban, Gift, HardDrive, ImageIcon, LayoutDashboard, Mail, Megaphone, Menu as MenuIcon, Plus, RefreshCw, Save, ScrollText, Send, Settings2, Shield, Sliders, Trash2, UploadCloud, UserCheck, Users, Video, Wifi, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { AppConfigPanel } from "@/components/layout/app-config-modal";
import { ChannelEditorDrawer } from "@/components/layout/channel-editor-drawer";
import { VersionReleaseModal } from "@/components/layout/version-release-modal";
import { formatCompactCredits, formatExactCredits } from "@/lib/format-number";
import { getMediaThumbBytes } from "@/lib/image-utils";
import { AnalyticsDashboardPanel } from "@/pages/admin/components/analytics-dashboard-panel";
import { ADMIN_TABLE_CLASS, ADMIN_TABLE_SCROLL, TableRowActions } from "@/pages/admin/components/table-row-actions";
import { UserDetailDrawer } from "@/pages/admin/components/user-detail-drawer";
import { AnnouncementsCard, ConsumptionTrendCard, getMediaModuleOptions, MediaModuleTags, MyMediaPanel, MyWalletPanel, ProfileSecurityPanel, UsageLogsPanel, UserOverviewPanel, WorkspaceSizeCell } from "@/pages/admin/user-panels";
import { useCopyText } from "@/hooks/use-copy-text";
import {
    adminApi,
    storageApi,
    type AdminChannelItem,
    type AdminMailSettingsForm,
    type AdminOverview,
    type AdminStorageExpiryPolicyForm,
    type AdminUserItem,
    type AnnouncementItem,
    type AnnouncementLevel,
    type MediaItem,
    type PlatformAnalyticsPolicy,
    type RedeemCodeItem,
    type RedeemCodeKind,
    type S3Provider,
    type S3StorageConfigForm,
    type StorageExpirySweepItem,
    type StorageExpirySweepResult,
    type StorageGrantItem,
    type WorkspaceDataItem,
} from "@/services/api/server";
import { notifyCloudWorkspaceChanged, WORKSPACE_CHANGED_EVENT } from "@/services/cloud-media";
import { syncCloudWorkspace, syncRuntimeSettings } from "@/services/cloud-sync";
import { createModelChannel, type ModelChannel } from "@/stores/use-config-store";
import { useNotificationStore } from "@/stores/use-notification-store";
import { useUserStore } from "@/stores/use-user-store";

function formatBytes(bytes: number) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const val = bytes / Math.pow(1024, idx);
    return `${val >= 100 || idx === 0 ? val.toFixed(0) : val.toFixed(2)} ${units[idx]}`;
}

function getProviderLabel(provider: S3Provider, t: TFunction) {
    return t(`admin.providers.${provider}`);
}

function getKindLabel(kind: string, t: TFunction) {
    if (kind === "image" || kind === "video" || kind === "audio" || kind === "file") {
        return t(`userPanels.mediaKinds.${kind}`);
    }
    return kind;
}

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
    mode: "add" | "deduct" | "clear";
    amount?: number;
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
    level: AnnouncementLevel;
    isPinned: boolean;
    isPublished: boolean;
    createdAt?: Dayjs | null;
};

type GlobalNoticeForm = {
    enabled: boolean;
    title: string;
    content: string;
};

export default function AdminPage() {
    const { t, i18n } = useTranslation();
    const locale = i18n.resolvedLanguage || undefined;
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
    const normalizeTab = useCallback((tab: string) => {
        if (tab === "settings") return "settings-auth";
        if (tab === "announcements") return "settings-announcements";
        return tab;
    }, []);
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
    const [overviewLoading, setOverviewLoading] = useState(isAdmin);
    const [overviewDays, setOverviewDays] = useState<7 | 14 | 30>(7);

    const [channels, setChannels] = useState<AdminChannelItem[]>([]);
    const [channelsLoading, setChannelsLoading] = useState(isAdmin);
    const [channelsSaving, setChannelsSaving] = useState(false);
    const [editingChannel, setEditingChannel] = useState<ModelChannel | null>(null);

    const [usersList, setUsersList] = useState<AdminUserItem[]>([]);
    const [usersTotal, setUsersTotal] = useState(0);
    const [usersPage, setUsersPage] = useState(1);
    const [usersPageSize, setUsersPageSize] = useState(20);
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
    const creditModeWatch = Form.useWatch("mode", userCreditForm) || "add";
    const [userCreditSaving, setUserCreditSaving] = useState(false);
    const [storageQuotaUser, setStorageQuotaUser] = useState<AdminUserItem | null>(null);
    const [userStorageQuotaForm] = Form.useForm<UserStorageQuotaForm>();
    const [userStorageQuotaSaving, setUserStorageQuotaSaving] = useState(false);
    const [storageQuotaGrants, setStorageQuotaGrants] = useState<StorageGrantItem[]>([]);
    const [storageQuotaGrantsLoading, setStorageQuotaGrantsLoading] = useState(false);
    const [updatingGrantId, setUpdatingGrantId] = useState<string | null>(null);
    const [detailUserId, setDetailUserId] = useState<string | null>(null);
    const [detailRefreshKey, setDetailRefreshKey] = useState(0);

    const [storageForm] = Form.useForm<S3StorageConfigForm>();
    const [storagePreview, setStoragePreview] = useState("");
    const [storageConfigured, setStorageConfigured] = useState(false);
    const [storageLoading, setStorageLoading] = useState(isAdmin);
    const [storageSaving, setStorageSaving] = useState(false);
    const [storageTesting, setStorageTesting] = useState(false);
    const [settingsLoading, setSettingsLoading] = useState(isAdmin);

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

    const [storageExpiryForm] = Form.useForm<AdminStorageExpiryPolicyForm>();
    const [storageExpiryEnabled, setStorageExpiryEnabled] = useState(false);
    const [storageExpirySaving, setStorageExpirySaving] = useState(false);
    const [storageExpiryPreviewing, setStorageExpiryPreviewing] = useState(false);
    const [storageExpiryRunning, setStorageExpiryRunning] = useState(false);
    const [cleaningSingleUserId, setCleaningSingleUserId] = useState<string | null>(null);
    const [storageExpiryResult, setStorageExpiryResult] = useState<StorageExpirySweepResult | null>(null);
    const [analyticsForm] = Form.useForm<PlatformAnalyticsPolicy>();
    const [analyticsSaving, setAnalyticsSaving] = useState(false);
    const [cleaningLogs, setCleaningLogs] = useState(false);

    const [mediaSubTab, setMediaSubTab] = useState<"media" | "canvas" | "image_workbench" | "video_workbench">("media");
    const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
    const [mediaTotal, setMediaTotal] = useState(0);
    const [mediaFilteredBytes, setMediaFilteredBytes] = useState<number | null>(null);
    const [mediaPage, setMediaPage] = useState(1);
    const [mediaPageSize, setMediaPageSize] = useState(20);
    const [mediaQuery, setMediaQuery] = useState("");
    const [mediaKindFilter, setMediaKindFilter] = useState("");
    const [mediaModuleFilter, setMediaModuleFilter] = useState("");
    const [mediaWorkspaceStats, setMediaWorkspaceStats] = useState({ canvasProjects: 0, imageLogs: 0, videoLogs: 0 });
    const [workspaceDataItems, setWorkspaceDataItems] = useState<WorkspaceDataItem[]>([]);
    const [workspaceDataTotal, setWorkspaceDataTotal] = useState(0);
    const [workspaceDataPage, setWorkspaceDataPage] = useState(1);
    const [workspaceDataPageSize, setWorkspaceDataPageSize] = useState(20);
    const [workspaceDataQuery, setWorkspaceDataQuery] = useState("");
    const [workspaceDataLoading, setWorkspaceDataLoading] = useState(false);
    const [mediaLoading, setMediaLoading] = useState(false);
    const [uploadingTest, setUploadingTest] = useState(false);
    const [previewMediaItem, setPreviewMediaItem] = useState<MediaItem | null>(null);
    const [downloadingPreviewMedia, setDownloadingPreviewMedia] = useState(false);
    const [deletingMediaId, setDeletingMediaId] = useState<string | null>(null);

    const [allowRegister, setAllowRegister] = useState(true);
    const [requireEmailOnRegister, setRequireEmailOnRegister] = useState(false);
    const [authPolicySaving, setAuthPolicySaving] = useState(false);

    useEffect(() => {
        const personalKeys = new Set(["user-overview", "user-dashboard", "usage-logs", "profile", "wallet", "my-media"]);
        if (!isAdmin && !personalKeys.has(activeTab)) {
            switchTab("user-overview");
        }
    }, [activeTab, isAdmin, switchTab]);

    const [redeemItems, setRedeemItems] = useState<RedeemCodeItem[]>([]);
    const [redeemTotal, setRedeemTotal] = useState(0);
    const [redeemPage, setRedeemPage] = useState(1);
    const [redeemPageSize, setRedeemPageSize] = useState(20);
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
    const [noticeForm] = Form.useForm<GlobalNoticeForm>();
    const [noticeSaving, setNoticeSaving] = useState(false);
    const [noticeUpdatedAt, setNoticeUpdatedAt] = useState<string | null>(null);

    const loadOverview = useCallback(
        async (days = overviewDays) => {
            if (!isAdmin) return;
            setOverviewLoading(true);
            try {
                setOverview(await adminApi.getOverview(days));
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("admin.messages.loadOverviewFailed"));
            } finally {
                setOverviewLoading(false);
            }
        },
        [isAdmin, message, overviewDays, t],
    );

    const loadChannels = useCallback(async () => {
        setChannelsLoading(true);
        try {
            const res = await adminApi.getChannelSettings();
            setChannels(res.channels);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.loadChannelsFailed"));
        } finally {
            setChannelsLoading(false);
        }
    }, [message, t]);

    const loadUsers = useCallback(
        async (page = usersPage, q = userQuery, role = userRoleFilter, status = userStatusFilter, sort = userSort, pageSize = usersPageSize) => {
            setUsersLoading(true);
            try {
                const res = await adminApi.listUsers({ page, pageSize, q, role, status, sort });
                setUsersList(res.items);
                setUsersTotal(res.total);
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("admin.messages.loadUsersFailed"));
            } finally {
                setUsersLoading(false);
            }
        },
        [message, t, userQuery, userRoleFilter, userSort, userStatusFilter, usersPage, usersPageSize],
    );

    const loadStorageSettings = useCallback(async () => {
        setStorageLoading(true);
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
            message.error(error instanceof Error ? error.message : t("admin.messages.loadStorageFailed"));
        } finally {
            setStorageLoading(false);
        }
    }, [message, storageForm, t]);

    const loadMedia = useCallback(
        async (page = mediaPage, q = mediaQuery, kind = mediaKindFilter, mod = mediaModuleFilter, pageSize = mediaPageSize, notifySuccess = false) => {
            setMediaLoading(true);
            try {
                const res = await adminApi.listMedia({ page, pageSize, q, kind, module: mod });
                setMediaItems(res.items);
                setMediaTotal(res.total);
                setMediaFilteredBytes(typeof res.filteredBytes === "number" ? res.filteredBytes : null);
                if (res.workspaceStats) setMediaWorkspaceStats(res.workspaceStats);
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
        async (kind = mediaSubTab, page = workspaceDataPage, q = workspaceDataQuery, pageSize = workspaceDataPageSize, notifySuccess = false) => {
            if (kind === "media") return;
            setWorkspaceDataLoading(true);
            try {
                const res = await adminApi.listWorkspaceData({ kind, page, pageSize, q });
                setWorkspaceDataItems(res.items);
                setWorkspaceDataTotal(res.total);
                if (notifySuccess) message.success(t("common.refreshed"));
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("admin.messages.loadWorkspaceFailed"));
            } finally {
                setWorkspaceDataLoading(false);
            }
        },
        [mediaSubTab, message, t, workspaceDataPage, workspaceDataPageSize, workspaceDataQuery],
    );

    const loadAuthAndWebdavSettings = useCallback(async () => {
        setSettingsLoading(true);
        try {
            const [authRes, webdavRes, mailRes, expiryRes, analyticsRes] = await Promise.all([
                adminApi.getAuthSettings(),
                adminApi.getWebdavSettings(),
                adminApi.getMailSettings(),
                adminApi.getStorageExpirySettings(),
                adminApi.getAnalyticsSettings(),
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
            setStorageExpiryEnabled(expiryRes.enabled);
            storageExpiryForm.setFieldsValue({
                enabled: expiryRes.enabled,
                gracePeriodDays: expiryRes.gracePeriodDays,
                preExpiryWarnDays: expiryRes.preExpiryWarnDays,
                cleanupWorkspaceData: expiryRes.cleanupWorkspaceData,
                exemptAdmins: expiryRes.exemptAdmins,
                cleanupOverQuotaWithoutExpiry: expiryRes.cleanupOverQuotaWithoutExpiry,
            });
            analyticsForm.setFieldsValue({
                sampleIntervalMinutes: analyticsRes.sampleIntervalMinutes,
                logRetentionDays: analyticsRes.logRetentionDays,
            });
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.loadSettingsFailed"));
        } finally {
            setSettingsLoading(false);
        }
    }, [analyticsForm, mailForm, message, storageExpiryForm, t, webdavForm]);

    const loadRedeemCodes = useCallback(
        async (page = redeemPage, q = redeemQuery, status = redeemStatusFilter, kind = redeemActiveKind, pageSize = redeemPageSize) => {
            setRedeemLoading(true);
            try {
                const res = await adminApi.listRedeemCodes({ page, pageSize, q, status, kind });
                setRedeemItems(res.items);
                setRedeemTotal(res.total);
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("admin.messages.loadRedeemFailed"));
            } finally {
                setRedeemLoading(false);
            }
        },
        [message, redeemActiveKind, redeemPage, redeemPageSize, redeemQuery, redeemStatusFilter, t],
    );

    const loadAnnouncements = useCallback(async () => {
        setAnnouncementsLoading(true);
        try {
            const res = await adminApi.listAnnouncements();
            setAnnouncements(res.items);
            setNoticeUpdatedAt(res.notice.updatedAt);
            noticeForm.setFieldsValue({
                enabled: res.notice.enabled,
                title: res.notice.title,
                content: res.notice.content,
            });
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.loadAnnouncementsFailed"));
        } finally {
            setAnnouncementsLoading(false);
        }
    }, [message, noticeForm, t]);

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
        if (!isAdmin || activeTab !== "settings-announcements") return;
        void loadAnnouncements();
    }, [activeTab, isAdmin, loadAnnouncements]);

    if (!user) {
        return (
            <div className="flex h-full items-center justify-center p-6">
                <Result
                    status="info"
                    title={t("admin.authGuard.loginRequired")}
                    extra={
                        <Button type="primary" onClick={() => navigate(`/auth?redirect=${encodeURIComponent(pathname)}`)}>
                            {t("admin.authGuard.goLogin")}
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
                    title={t("admin.authGuard.forbiddenTitle")}
                    subTitle={t("admin.authGuard.forbiddenSubtitle")}
                    extra={
                        <Space>
                            <Button type="primary" onClick={() => navigate("/console", { replace: true })}>
                                {t("admin.authGuard.goConsole")}
                            </Button>
                            <Button onClick={() => navigate("/", { replace: true })}>{t("admin.authGuard.backHome")}</Button>
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
            message.success(t("admin.messages.channelsSaved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.channelsSaveFailed"));
        } finally {
            setChannelsSaving(false);
        }
    };

    const handleAddChannel = () => {
        const draft = createModelChannel({
            name: t("admin.messages.defaultChannelName", { index: channels.length + 1 }),
            baseUrl: "https://api.openai.com",
            apiKey: "",
            enabled: true,
        });
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
            message.success(t("admin.messages.storageSaved"));
            void loadOverview();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.storageSaveFailed"));
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
            message.success(t("admin.messages.directUploadSuccess"));
            options.onSuccess?.({});
            void loadMedia(1, mediaQuery, mediaKindFilter);
            void loadOverview();
        } catch (error) {
            const err = error instanceof Error ? error : new Error(t("admin.messages.directUploadFailed"));
            message.error(err.message);
            options.onError?.(err);
        } finally {
            setUploadingTest(false);
        }
    };

    const handleUpdateUser = async (targetId: string, patch: { role?: "admin" | "user"; status?: "active" | "disabled" }) => {
        try {
            await adminApi.updateUser(targetId, patch);
            message.success(t("admin.messages.userUpdated"));
            void loadUsers();
            void loadOverview();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.updateFailed"));
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
            message.success(t("admin.messages.userWebdavUpdated"));
            setAssigningUser(null);
            void loadUsers();
            if (assigningUser.id === user.id) void syncRuntimeSettings();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.updateFailed"));
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
            message.error(error instanceof Error ? error.message : t("admin.messages.loadGrantsFailed"));
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
            message.success(nextStatus === "revoked" ? t("admin.messages.grantRevoked") : t("admin.messages.grantRestored"));
            await loadUserStorageGrants(storageQuotaUser.id);
            void loadUsers();
            setDetailRefreshKey((v) => v + 1);
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
            message.error(error instanceof Error ? error.message : t("admin.messages.grantUpdateFailed"));
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
            message.success(t("admin.messages.quotaUpdated", { size: formatBytes(res.storageQuotaBytes) }));
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
            setDetailRefreshKey((v) => v + 1);
            void loadOverview();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.quotaUpdateFailed"));
        } finally {
            setUserStorageQuotaSaving(false);
        }
    };

    const handleAdjustUserCredits = async (values: UserCreditForm) => {
        if (!creditUser) return;
        const isClear = values.mode === "clear";
        const delta = values.mode === "deduct" ? -Math.abs(Number(values.amount)) : Math.abs(Number(values.amount));
        setUserCreditSaving(true);
        try {
            const res = await adminApi.adjustUserCredits(
                creditUser.id,
                isClear
                    ? { clear: true, note: values.note?.trim() || t("admin.messages.adminClearDefaultNote") }
                    : { delta, note: values.note?.trim() || "" },
            );
            message.success(isClear ? t("admin.messages.creditsCleared") : t("admin.messages.creditsAdjusted", { balance: res.balance }));
            if (creditUser.id === user.id) {
                useUserStore.getState().setUser({ ...user, creditBalance: res.balance });
            }
            setCreditUser(null);
            void loadUsers();
            setDetailRefreshKey((v) => v + 1);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.creditsAdjustFailed"));
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
            message.success(t("admin.messages.redeemCreated", { count: res.items.length }));
            setSelectedRedeemIds([]);
            if (kind !== redeemActiveKind) {
                setRedeemPage(1);
                setRedeemActiveKind(kind);
            } else {
                void loadRedeemCodes(1, redeemQuery, redeemStatusFilter, kind);
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.redeemCreateFailed"));
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
            t("admin.messages.redeemCopied", { count: selectedRedeemItems.length }),
        );
    };

    const handleBatchDeleteRedeemCodes = async () => {
        if (!selectedRedeemIds.length || hasSelectedUsedRedeem) return;
        setBatchDeletingRedeem(true);
        try {
            const res = await adminApi.batchDeleteRedeemCodes(selectedRedeemIds);
            message.success(t("admin.messages.redeemDeletedCount", { count: res.deletedCount }));
            setSelectedRedeemIds([]);
            void loadRedeemCodes();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.batchDeleteFailed"));
        } finally {
            setBatchDeletingRedeem(false);
        }
    };

    const handleToggleRedeemStatus = async (item: RedeemCodeItem) => {
        try {
            await adminApi.updateRedeemCode(item.id, { status: item.status === "active" ? "disabled" : "active" });
            message.success(t("admin.messages.redeemStatusUpdated"));
            void loadRedeemCodes();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.updateFailed"));
        }
    };

    const handleDeleteRedeemCode = async (id: string) => {
        try {
            await adminApi.deleteRedeemCode(id);
            message.success(t("admin.messages.redeemDeleted"));
            void loadRedeemCodes();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("common.deleteFailed"));
        }
    };

    const handleSavePlatformWebdav = async (values: WebdavPlatformForm) => {
        setWebdavSaving(true);
        try {
            await adminApi.saveWebdavSettings(values);
            message.success(t("admin.messages.webdavSaved"));
            void loadAuthAndWebdavSettings();
            void syncRuntimeSettings();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.webdavSaveFailed"));
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
        if (deletingMediaId) return;
        setDeletingMediaId(mediaId);
        try {
            await adminApi.deleteMedia(mediaId);
            notifyCloudWorkspaceChanged("media", { sync: false });
            message.success(t("admin.messages.mediaDeleted"));
            void loadMedia();
            void loadOverview();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("common.deleteFailed"));
        } finally {
            setDeletingMediaId(null);
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
                message.success(res.allowRegister ? t("admin.messages.registerOpened") : t("admin.messages.registerClosed"));
            } else {
                message.success(res.requireEmailOnRegister ? t("admin.messages.requireEmailEnabled") : t("admin.messages.requireEmailDisabled"));
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.saveFailed"));
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
            message.success(t("admin.messages.mailSaved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.mailSaveFailed"));
        } finally {
            setMailSaving(false);
        }
    };

    const handleTestMailSettings = async () => {
        const cleanTo = testMailTo.trim();
        if (!cleanTo) {
            message.warning(t("admin.messages.testMailToWarning"));
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

    const handleSaveStorageExpiryPolicy = async (values: AdminStorageExpiryPolicyForm) => {
        setStorageExpirySaving(true);
        try {
            const stored = storageExpiryForm.getFieldsValue(true);
            const payload: AdminStorageExpiryPolicyForm = {
                enabled: Boolean(values.enabled ?? stored.enabled ?? storageExpiryEnabled),
                gracePeriodDays: Number(values.gracePeriodDays ?? stored.gracePeriodDays ?? 7),
                preExpiryWarnDays: Number(values.preExpiryWarnDays ?? stored.preExpiryWarnDays ?? 3),
                cleanupWorkspaceData: Boolean(values.cleanupWorkspaceData ?? stored.cleanupWorkspaceData ?? true),
                exemptAdmins: Boolean(values.exemptAdmins ?? stored.exemptAdmins ?? true),
                cleanupOverQuotaWithoutExpiry: Boolean(values.cleanupOverQuotaWithoutExpiry ?? stored.cleanupOverQuotaWithoutExpiry ?? true),
            };
            const res = await adminApi.saveStorageExpirySettings(payload);
            setStorageExpiryEnabled(res.enabled);
            setMailReady(res.mailReady);
            storageExpiryForm.setFieldsValue({
                enabled: res.enabled,
                gracePeriodDays: res.gracePeriodDays,
                preExpiryWarnDays: res.preExpiryWarnDays,
                cleanupWorkspaceData: res.cleanupWorkspaceData,
                exemptAdmins: res.exemptAdmins,
                cleanupOverQuotaWithoutExpiry: res.cleanupOverQuotaWithoutExpiry,
            });
            message.success(t("admin.messages.expirySaved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.expirySaveFailed"));
        } finally {
            setStorageExpirySaving(false);
        }
    };

    const handleRunStorageExpirySweep = async (dryRun: boolean) => {
        if (dryRun) {
            setStorageExpiryPreviewing(true);
        } else {
            setStorageExpiryRunning(true);
        }
        try {
            const res = await adminApi.runStorageExpirySweep({ dryRun });
            setStorageExpiryResult(res);
            if (dryRun) {
                message.success(t("admin.messages.expiryPreviewDone", { count: res.eligibleUsers }));
            } else {
                message.success(
                    t("admin.messages.expirySweepDone", {
                        warned: res.preExpiryWarned,
                        noticed: res.expiredNoticed,
                        cleaned: res.cleanedUsers,
                        freed: formatBytes(res.freedBytesTotal),
                    }),
                );
                void loadOverview(overviewDays);
                void loadUsers();
                void loadMedia();
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.expirySweepFailed"));
        } finally {
            if (dryRun) {
                setStorageExpiryPreviewing(false);
            } else {
                setStorageExpiryRunning(false);
            }
        }
    };

    const handleRunSingleUserStorageSweep = async (row: StorageExpirySweepItem) => {
        if (cleaningSingleUserId) return;
        setCleaningSingleUserId(row.userId);
        try {
            const res = await adminApi.runStorageExpirySweep({ dryRun: false, userId: row.userId });
            const targetItem = res.items[0];
            if (targetItem?.error) {
                message.warning(targetItem.error);
            } else if (row.action === "cleaned" || row.action === "over_quota_cleaned") {
                message.success(
                    t("admin.messages.expirySingleCleaned", {
                        user: row.displayName || row.username,
                        count: targetItem?.deletedMediaCount ?? 0,
                        freed: formatBytes(targetItem?.freedBytes ?? 0),
                    }),
                );
            } else {
                message.success(
                    t("admin.messages.expirySingleNoticed", {
                        user: row.displayName || row.username,
                    }),
                );
            }
            const nextPreview = await adminApi.runStorageExpirySweep({ dryRun: true });
            setStorageExpiryResult(nextPreview);
            void loadOverview(overviewDays);
            void loadUsers();
            void loadMedia();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.expirySweepFailed"));
        } finally {
            setCleaningSingleUserId(null);
        }
    };

    const handleSaveAnalyticsSettings = async (values: PlatformAnalyticsPolicy) => {
        setAnalyticsSaving(true);
        try {
            const res = await adminApi.saveAnalyticsSettings({
                sampleIntervalMinutes: Number(values.sampleIntervalMinutes || 5),
                logRetentionDays: Number(values.logRetentionDays || 0),
            });
            analyticsForm.setFieldsValue({
                sampleIntervalMinutes: res.sampleIntervalMinutes,
                logRetentionDays: res.logRetentionDays,
            });
            message.success(t("admin.messages.analyticsSaved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.analyticsSaveFailed"));
        } finally {
            setAnalyticsSaving(false);
        }
    };

    const handleCleanupExpiredLogs = async () => {
        const rawDays = Number(analyticsForm.getFieldValue("logRetentionDays") || 0);
        if (!Number.isFinite(rawDays) || rawDays <= 0) {
            message.warning(t("admin.messages.logsCleanupWarning"));
            return;
        }
        setCleaningLogs(true);
        try {
            const res = await adminApi.cleanupUsageLogs(rawDays);
            message.success(t("admin.messages.logsCleaned", { days: res.retentionDays, count: res.deletedCount }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.logsCleanupFailed"));
        } finally {
            setCleaningLogs(false);
        }
    };

    const announcementLevelMeta: Record<AnnouncementLevel, { label: string; color: string; dotColor: string }> = {
        default: { label: t("userPanels.announcementLevels.default"), color: "default", dotColor: "#6b7280" },
        ongoing: { label: t("userPanels.announcementLevels.ongoing"), color: "blue", dotColor: "#2563eb" },
        success: { label: t("userPanels.announcementLevels.success"), color: "green", dotColor: "#16a34a" },
        warning: { label: t("userPanels.announcementLevels.warning"), color: "orange", dotColor: "#f97316" },
        error: { label: t("userPanels.announcementLevels.error"), color: "red", dotColor: "#ef4444" },
    };

    const renderLevelOption = (value: AnnouncementLevel) => {
        const meta = announcementLevelMeta[value] || announcementLevelMeta.default;
        return (
            <span className="inline-flex items-center gap-2">
                <span className="inline-block size-2 shrink-0 rounded-full" style={{ backgroundColor: meta.dotColor }} />
                <span>{meta.label}</span>
            </span>
        );
    };

    const announcementLevelOptions = (Object.keys(announcementLevelMeta) as AnnouncementLevel[]).map((value) => ({
        value,
        label: renderLevelOption(value),
    }));

    const handleOpenCreateAnnouncement = () => {
        setEditingAnnouncement(null);
        announcementForm.setFieldsValue({
            title: "",
            content: "",
            level: "default",
            isPinned: false,
            isPublished: true,
            createdAt: dayjs(),
        });
        setAnnouncementModalOpen(true);
    };

    const handleOpenEditAnnouncement = (record: AnnouncementItem) => {
        setEditingAnnouncement(record);
        const normalizedLevel: AnnouncementLevel = record.level in announcementLevelMeta ? record.level : "default";
        announcementForm.setFieldsValue({
            title: record.title,
            content: record.content,
            level: normalizedLevel,
            isPinned: record.isPinned,
            isPublished: record.isPublished,
            createdAt: record.createdAt ? dayjs(record.createdAt) : dayjs(),
        });
        setAnnouncementModalOpen(true);
    };

    const handleSaveGlobalNotice = async (values: GlobalNoticeForm) => {
        setNoticeSaving(true);
        try {
            const res = await adminApi.saveGlobalNotice({
                enabled: Boolean(values.enabled),
                title: values.title?.trim() || "",
                content: values.content ?? "",
            });
            setNoticeUpdatedAt(res.notice.updatedAt);
            noticeForm.setFieldsValue(res.notice);
            message.success(t("admin.messages.noticeSaved"));
            void useNotificationStore.getState().fetchNotifications(true);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.noticeSaveFailed"));
        } finally {
            setNoticeSaving(false);
        }
    };

    const handleSaveAnnouncement = async (values: AnnouncementForm) => {
        setAnnouncementSaving(true);
        try {
            const payload = {
                title: values.title,
                content: values.content,
                level: values.level,
                isPinned: values.isPinned,
                isPublished: values.isPublished,
                ...(values.createdAt ? { createdAt: values.createdAt.toISOString() } : {}),
            };
            if (editingAnnouncement) {
                await adminApi.updateAnnouncement(editingAnnouncement.id, payload);
                message.success(t("admin.messages.announcementUpdated"));
            } else {
                await adminApi.createAnnouncement(payload);
                message.success(t("admin.messages.announcementPublished"));
            }
            setAnnouncementModalOpen(false);
            setEditingAnnouncement(null);
            void loadAnnouncements();
            void loadOverview(overviewDays);
            void useNotificationStore.getState().fetchNotifications(true);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.announcementSaveFailed"));
        } finally {
            setAnnouncementSaving(false);
        }
    };

    const handleToggleAnnouncementFlag = async (
        record: AnnouncementItem,
        patch: Partial<Pick<AnnouncementItem, "isPinned" | "isPublished" | "level">>,
    ) => {
        try {
            await adminApi.updateAnnouncement(record.id, patch);
            message.success(t("admin.messages.announcementStatusUpdated"));
            void loadAnnouncements();
            void loadOverview(overviewDays);
            void useNotificationStore.getState().fetchNotifications(true);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.announcementUpdateFailed"));
        }
    };

    const handleDeleteAnnouncement = async (id: string) => {
        try {
            await adminApi.deleteAnnouncement(id);
            message.success(t("admin.messages.announcementDeleted"));
            void loadAnnouncements();
            void loadOverview(overviewDays);
            void useNotificationStore.getState().fetchNotifications(true);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.announcementDeleteFailed"));
        }
    };

    const totalStorageBytes = overview?.totalStorageBytes ?? 0;

    const personalTabs = [
        {
            key: "user-overview",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <LayoutDashboard className="size-4" />
                    {t("admin.nav.userOverview")}
                </span>
            ),
            children: <UserOverviewPanel onOpenWallet={() => switchTab("wallet")} onOpenMedia={() => switchTab("my-media")} />,
        },
        {
            key: "user-dashboard",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <BarChart3 className="size-4" />
                    {t("admin.nav.dashboard")}
                </span>
            ),
            children: <AnalyticsDashboardPanel scope="self" />,
        },
        ...(!isAdmin
            ? [
                  {
                      key: "usage-logs",
                      label: (
                          <span className="inline-flex items-center gap-1.5">
                              <ScrollText className="size-4" />
                              {t("admin.nav.usageLogs")}
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
                    {t("admin.nav.wallet")}
                </span>
            ),
            children: <MyWalletPanel />,
        },
        {
            key: "profile",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <UserCheck className="size-4" />
                    {t("admin.nav.profile")}
                </span>
            ),
            children: <ProfileSecurityPanel />,
        },
        {
            key: "my-media",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <FolderKanban className="size-4" />
                    {t("admin.nav.myMedia")}
                </span>
            ),
            children: <MyMediaPanel />,
        },
        {
            key: "config",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <Settings2 className="size-4" />
                    {t("admin.nav.config")}
                </span>
            ),
            pageTitle: t("config.title"),
            children: <AppConfigPanel />,
        },
    ];

    const adminTabs = [
                        {
                            key: "overview",
                            label: (
                                <span className="inline-flex items-center gap-1.5">
                                    <Shield className="size-4" />
                                    {t("admin.overviewTab.tabLabel")}
                                </span>
                            ),
                            children: (
                                <div className="flex flex-col gap-5">
                                    <Row gutter={[16, 16]}>
                                        <Col xs={24} sm={12} xl={6}>
                                            <Card loading={overviewLoading}>
                                                <Statistic
                                                    title={t("admin.overviewTab.totalUsers")}
                                                    value={overview?.totalUsers ?? 0}
                                                    suffix={
                                                        <Typography.Text type="secondary" className="text-xs">
                                                            {t("admin.overviewTab.usersSuffix", {
                                                                admins: overview?.adminCount ?? 0,
                                                                disabled: overview?.disabledUsers ?? 0,
                                                            })}
                                                        </Typography.Text>
                                                    }
                                                />
                                            </Card>
                                        </Col>
                                        <Col xs={24} sm={12} xl={6}>
                                            <Card loading={overviewLoading}>
                                                <Tooltip title={t("admin.overviewTab.exactCreditsTooltip", { value: formatExactCredits(overview?.totalConsumedCredits ?? 0) })}>
                                                    <div>
                                                        <Statistic title={t("admin.overviewTab.totalConsumed")} value={formatCompactCredits(overview?.totalConsumedCredits ?? 0)} />
                                                    </div>
                                                </Tooltip>
                                            </Card>
                                        </Col>
                                        <Col xs={24} sm={12} xl={6}>
                                            <Card loading={overviewLoading}>
                                                <Tooltip title={t("admin.overviewTab.exactCreditsTooltip", { value: formatExactCredits(overview?.todayConsumedCredits ?? 0) })}>
                                                    <div>
                                                        <Statistic title={t("admin.overviewTab.todayConsumed")} value={formatCompactCredits(overview?.todayConsumedCredits ?? 0)} />
                                                    </div>
                                                </Tooltip>
                                            </Card>
                                        </Col>
                                        <Col xs={24} sm={12} xl={6}>
                                            <Card loading={overviewLoading}>
                                                <Statistic title={t("admin.overviewTab.usedStorage")} value={formatBytes(totalStorageBytes)} />
                                            </Card>
                                        </Col>
                                    </Row>

                                    <Row gutter={[16, 16]}>
                                        <Col xs={24} lg={15}>
                                            <ConsumptionTrendCard
                                                title={t("admin.overviewTab.trendTitle")}
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
                                                    <Button type="link" size="small" onClick={() => switchTab("settings-announcements")}>
                                                        {t("admin.overviewTab.manageAnnouncements")}
                                                    </Button>
                                                }
                                            />
                                        </Col>
                                    </Row>

                                    <Row gutter={[16, 16]}>
                                        <Col xs={24} sm={12}>
                                            <Card loading={overviewLoading}>
                                                <Statistic title={t("admin.overviewTab.cloudCanvasAssets")} value={`${overview?.canvasProjectCount ?? 0} / ${overview?.assetCount ?? 0}`} />
                                            </Card>
                                        </Col>
                                        <Col xs={24} sm={12}>
                                            <Card loading={overviewLoading}>
                                                <Statistic title={t("admin.overviewTab.objectMediaCount")} value={overview?.activeMediaCount ?? 0} />
                                            </Card>
                                        </Col>
                                    </Row>

                                    <Row gutter={[16, 16]}>
                                        <Col xs={24} md={12}>
                                            <Card title={t("admin.overviewTab.mediaByKindTitle")} loading={overviewLoading}>
                                                <div className="flex flex-col gap-3">
                                                    {(overview?.mediaByKind ?? []).length ? (
                                                        overview!.mediaByKind.map((item) => {
                                                            const percent = totalStorageBytes > 0 ? Math.round((item.bytes / totalStorageBytes) * 100) : 0;
                                                            return (
                                                                <div key={item.kind} className="flex flex-col gap-1">
                                                                    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                                                                        <span className="min-w-0">
                                                                            {t("admin.overviewTab.kindItemCount", {
                                                                                kind: getKindLabel(item.kind, t),
                                                                                count: item.count,
                                                                            })}
                                                                        </span>
                                                                        <Typography.Text type="secondary" className="shrink-0">{formatBytes(item.bytes)}</Typography.Text>
                                                                    </div>
                                                                    <Progress percent={percent} size="small" showInfo={false} />
                                                                </div>
                                                            );
                                                        })
                                                    ) : (
                                                        <Typography.Text type="secondary">{t("admin.overviewTab.noCloudMedia")}</Typography.Text>
                                                    )}
                                                </div>
                                            </Card>
                                        </Col>
                                        <Col xs={24} md={12}>
                                            <Card title={t("admin.overviewTab.topStorageUsersTitle")} loading={overviewLoading}>
                                                <div className="flex flex-col gap-3">
                                                    {(overview?.topStorageUsers ?? []).length ? (
                                                        overview!.topStorageUsers.map((item) => {
                                                            const percent = totalStorageBytes > 0 ? Math.round((item.storageUsedBytes / totalStorageBytes) * 100) : 0;
                                                            return (
                                                                <div key={item.id} className="flex flex-col gap-1">
                                                                    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                                                                        <span className="min-w-0 truncate">
                                                                            {item.displayName || item.username}{" "}
                                                                            <Tag color={item.role === "admin" ? "blue" : "default"}>
                                                                                {item.role === "admin"
                                                                                    ? t("admin.overviewTab.roleAdminTag")
                                                                                    : t("admin.overviewTab.roleUserTag")}
                                                                            </Tag>
                                                                        </span>
                                                                        <Typography.Text type="secondary" className="shrink-0">{formatBytes(item.storageUsedBytes)}</Typography.Text>
                                                                    </div>
                                                                    <Progress percent={percent} size="small" showInfo={false} />
                                                                </div>
                                                            );
                                                        })
                                                    ) : (
                                                        <Typography.Text type="secondary">{t("admin.overviewTab.noUsersData")}</Typography.Text>
                                                    )}
                                                </div>
                                            </Card>
                                        </Col>
                                    </Row>

                                    <Card title={t("admin.overviewTab.runtimeStatusTitle")}>
                                        <Descriptions column={{ xs: 1, sm: 2 }} bordered size="small">
                                            <Descriptions.Item label={t("admin.overviewTab.currentAdminLabel")}>{user.displayName || user.username}</Descriptions.Item>
                                            <Descriptions.Item label={t("admin.overviewTab.platformChannelsLabel")}>
                                                <Tag color={channels.some((ch) => ch.enabled) ? "green" : "orange"}>
                                                    {t("admin.overviewTab.channelsSummaryTag", {
                                                        total: channels.length,
                                                        enabled: channels.filter((ch) => ch.enabled).length,
                                                    })}
                                                </Tag>
                                            </Descriptions.Item>
                                            <Descriptions.Item label={t("admin.overviewTab.objectStorageStatusLabel")}>
                                                {overview?.storageConfigured ? (
                                                    <Tag color="green">
                                                        {t("admin.overviewTab.storageConfiguredTag", {
                                                            provider: getProviderLabel((overview.storageProvider as S3Provider) || "s3", t),
                                                            bucket: overview.storageBucket,
                                                        })}
                                                    </Tag>
                                                ) : (
                                                    <Tag color="orange">{t("admin.overviewTab.storageNotConfiguredTag")}</Tag>
                                                )}
                                            </Descriptions.Item>
                                            <Descriptions.Item label={t("admin.overviewTab.registerPolicyLabel")}>
                                                <Tag color={allowRegister ? "blue" : "default"}>
                                                    {allowRegister ? t("admin.overviewTab.registerOpenTag") : t("admin.overviewTab.registerClosedTag")}
                                                </Tag>
                                            </Descriptions.Item>
                                        </Descriptions>
                                    </Card>
                                </div>
                            ),
                        },
                        {
                            key: "dashboard",
                            label: (
                                <span className="inline-flex items-center gap-1.5">
                                    <BarChart3 className="size-4" />
                                    {t("admin.nav.dashboard")}
                                </span>
                            ),
                            children: <AnalyticsDashboardPanel scope="all" />,
                        },
                        {
                            key: "usage-logs",
                            label: (
                                <span className="inline-flex items-center gap-1.5">
                                    <ScrollText className="size-4" />
                                    {t("admin.nav.usageLogs")}
                                </span>
                            ),
                            children: <UsageLogsPanel defaultScope={isAdminRoute ? "all" : "self"} />,
                        },
                        {
                            key: "channels",
                            label: (
                                <span className="inline-flex items-center gap-1.5">
                                    <Cpu className="size-4" />
                                    {t("admin.channelsTab.tabLabel")}
                                </span>
                            ),
                            children: (
                                <Card
                                    title={t("admin.channelsTab.cardTitle")}
                                    loading={channelsLoading}
                                    extra={
                                        <Button type="primary" icon={<Plus className="size-4" />} onClick={handleAddChannel} loading={channelsSaving}>
                                            {t("admin.channelsTab.addChannel")}
                                        </Button>
                                    }
                                >
                                    <Alert
                                        type="info"
                                        showIcon
                                        className="mb-4"
                                        message={t("admin.channelsTab.alertTitle")}
                                        description={t("admin.channelsTab.alertDesc")}
                                    />
                                    <Table<AdminChannelItem>
                                        rowKey="id"
                                        className={ADMIN_TABLE_CLASS}
                                        scroll={ADMIN_TABLE_SCROLL}
                                        dataSource={channels}
                                        pagination={false}
                                        columns={[
                                            {
                                                title: t("admin.channelsTab.colName"),
                                                key: "name",
                                                width: 260,
                                                render: (_, record) => (
                                                    <div className="max-w-[240px]">
                                                        <div className="truncate font-medium">{record.name}</div>
                                                        <Typography.Text type="secondary" ellipsis={{ tooltip: record.baseUrl }} className="block text-xs">
                                                            {record.baseUrl || t("admin.channelsTab.noBaseUrl")}
                                                        </Typography.Text>
                                                    </div>
                                                ),
                                            },
                                            {
                                                title: t("admin.channelsTab.colFormat"),
                                                dataIndex: "apiFormat",
                                                width: 90,
                                                render: (fmt: string) => <Tag>{fmt === "gemini" ? "Gemini" : "OpenAI"}</Tag>,
                                            },
                                            {
                                                title: t("admin.channelsTab.colKeyStatus"),
                                                key: "apiKey",
                                                width: 140,
                                                render: (_, record) =>
                                                    record.hasApiKey ? <Tag color="green">{record.apiKeyPreview}</Tag> : <Tag color="red">{t("admin.channelsTab.noKey")}</Tag>,
                                            },
                                            {
                                                title: t("admin.channelsTab.colModels"),
                                                key: "models",
                                                width: 85,
                                                render: (_, record) => t("admin.channelsTab.modelsCount", { count: record.models.length }),
                                            },
                                            {
                                                title: t("admin.channelsTab.colEnabled"),
                                                dataIndex: "enabled",
                                                width: 80,
                                                render: (enabled: boolean, record) => (
                                                    <Switch checked={enabled} loading={channelsSaving} onChange={(checked) => void handleToggleChannelEnabled(record.id, checked)} />
                                                ),
                                            },
                                            {
                                                title: t("admin.channelsTab.colActions"),
                                                key: "actions",
                                                fixed: "right",
                                                width: 100,
                                                render: (_, record) => (
                                                    <TableRowActions
                                                        items={[
                                                            {
                                                                key: "edit",
                                                                label: t("common.edit"),
                                                                onClick: () => handleEditChannel(record),
                                                            },
                                                            {
                                                                key: "delete",
                                                                label: t("common.delete"),
                                                                danger: true,
                                                                confirm: t("admin.channelsTab.confirmDelete"),
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
                                    {t("admin.usersTab.tabLabel")}
                                </span>
                            ),
                            children: (
                                <Card
                                    title={t("admin.usersTab.cardTitle")}
                                    extra={
                                        <div className="flex flex-wrap items-center gap-2">
                                            <Select
                                                value={userRoleFilter}
                                                className="min-w-[115px] flex-1 sm:w-[115px]! sm:flex-none"
                                                onChange={(value) => {
                                                    setUsersPage(1);
                                                    setUserRoleFilter(value);
                                                }}
                                                options={[
                                                    { value: "", label: t("admin.usersTab.allRoles") },
                                                    { value: "admin", label: t("admin.usersTab.roleAdmin") },
                                                    { value: "user", label: t("admin.usersTab.roleUser") },
                                                ]}
                                            />
                                            <Select
                                                value={userStatusFilter}
                                                className="min-w-[115px] flex-1 sm:w-[115px]! sm:flex-none"
                                                onChange={(value) => {
                                                    setUsersPage(1);
                                                    setUserStatusFilter(value);
                                                }}
                                                options={[
                                                    { value: "", label: t("admin.usersTab.allStatuses") },
                                                    { value: "active", label: t("admin.usersTab.statusActive") },
                                                    { value: "disabled", label: t("admin.usersTab.statusDisabled") },
                                                ]}
                                            />
                                            <Select
                                                value={userSort}
                                                className="min-w-[140px] flex-1 sm:w-[145px]! sm:flex-none"
                                                onChange={(value) => {
                                                    setUsersPage(1);
                                                    setUserSort(value);
                                                }}
                                                options={[
                                                    { value: "created_desc", label: t("admin.usersTab.sortCreated") },
                                                    { value: "storage_desc", label: t("admin.usersTab.sortStorage") },
                                                ]}
                                            />
                                            <Input.Search
                                                allowClear
                                                placeholder={t("admin.usersTab.searchPlaceholder")}
                                                className="w-full! sm:w-[220px]!"
                                                onSearch={(value) => {
                                                    setUsersPage(1);
                                                    setUserQuery(value.trim());
                                                }}
                                            />
                                        </div>
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
                                            pageSize: usersPageSize,
                                            total: usersTotal,
                                            showSizeChanger: true,
                                            pageSizeOptions: [10, 20, 30, 50, 100],
                                            showTotal: (count) => t("common.totalItems", { count }),
                                            onChange: (page, size) => {
                                                if (size !== usersPageSize) {
                                                    setUsersPageSize(size);
                                                    setUsersPage(1);
                                                } else {
                                                    setUsersPage(page);
                                                }
                                            },
                                        }}
                                        columns={[
                                            {
                                                title: t("admin.usersTab.colAccount"),
                                                key: "account",
                                                width: 220,
                                                render: (_, record) => (
                                                    <div className="max-w-[200px]">
                                                        <div className="truncate font-medium">
                                                            <button
                                                                type="button"
                                                                className="cursor-pointer border-0 bg-transparent p-0 text-left font-medium hover:underline"
                                                                onClick={() => setDetailUserId(record.id)}
                                                            >
                                                                {record.displayName || record.username}
                                                            </button>
                                                            {record.id === user.id ? <Tag className="ml-2">{t("admin.usersTab.currentTag")}</Tag> : null}
                                                        </div>
                                                        <Typography.Text type="secondary" ellipsis className="block text-xs">
                                                            @{record.username}
                                                            {record.email ? ` · ${record.email}` : ""}
                                                        </Typography.Text>
                                                    </div>
                                                ),
                                            },
                                            {
                                                title: t("admin.usersTab.colRole"),
                                                dataIndex: "role",
                                                width: 90,
                                                render: (role: string) => (
                                                    <Tag color={role === "admin" ? "blue" : "default"}>
                                                        {role === "admin" ? t("admin.usersTab.roleAdmin") : t("admin.usersTab.roleUser")}
                                                    </Tag>
                                                ),
                                            },
                                            {
                                                title: t("admin.usersTab.colStatus"),
                                                dataIndex: "status",
                                                width: 80,
                                                render: (status: string) => (
                                                    <Tag color={status === "active" ? "green" : "red"}>
                                                        {status === "active" ? t("admin.usersTab.statusActive") : t("admin.usersTab.statusDisabled")}
                                                    </Tag>
                                                ),
                                            },
                                            {
                                                title: t("admin.usersTab.colCredits"),
                                                dataIndex: "creditBalance",
                                                width: 105,
                                                render: (balance?: number) => (
                                                    <Tooltip title={t("admin.usersTab.exactBalanceTip", { value: formatExactCredits(balance ?? 0) })}>
                                                        <Tag color="gold">{formatCompactCredits(balance ?? 0)}</Tag>
                                                    </Tooltip>
                                                ),
                                            },
                                            {
                                                title: t("admin.usersTab.colCanvasMedia"),
                                                key: "counts",
                                                width: 100,
                                                render: (_, record) => `${record.projectCount ?? 0} / ${record.mediaCount ?? 0}`,
                                            },
                                            {
                                                title: t("admin.usersTab.colStorageQuota"),
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
                                                                        {t("admin.usersTab.expiredTag")}
                                                                    </Tag>
                                                                ) : exceeded ? (
                                                                    <Tag color="red" style={{ marginInlineEnd: 0 }}>
                                                                        {quota <= 0 ? "0MB" : t("admin.usersTab.fullTag")}
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
                                                                    ? t("admin.usersTab.untilDate", {
                                                                          date: new Date(record.storageQuotaExpiresAt).toLocaleDateString(locale),
                                                                      })
                                                                    : t("admin.usersTab.permanent")}
                                                                {record.activeGrantCount
                                                                    ? t("admin.usersTab.activeGrantsSuffix", { count: record.activeGrantCount })
                                                                    : ""}
                                                            </Typography.Text>
                                                        </div>
                                                    );
                                                },
                                            },
                                            {
                                                title: t("admin.channelsTab.colActions"),
                                                key: "actions",
                                                fixed: "right",
                                                width: 150,
                                                render: (_, record) => (
                                                    <TableRowActions
                                                        items={[
                                                            {
                                                                key: "detail",
                                                                label: t("admin.usersTab.actionDetail"),
                                                                onClick: () => setDetailUserId(record.id),
                                                            },
                                                            {
                                                                key: "quota",
                                                                label: t("admin.usersTab.actionQuota"),
                                                                onClick: () => openConfigStorageQuota(record),
                                                            },
                                                            {
                                                                key: "credits",
                                                                label: t("admin.usersTab.actionCredits"),
                                                                onClick: () => openAdjustCredits(record),
                                                            },
                                                            {
                                                                key: "role",
                                                                label: record.role === "admin" ? t("admin.usersTab.actionDemote") : t("admin.usersTab.actionPromote"),
                                                                disabled: Boolean(record.isInitialAdmin && record.role === "admin"),
                                                                confirm: record.role === "admin" ? t("admin.usersTab.confirmDemote") : t("admin.usersTab.confirmPromote"),
                                                                onClick: () => void handleUpdateUser(record.id, { role: record.role === "admin" ? "user" : "admin" }),
                                                            },
                                                            {
                                                                key: "status",
                                                                label: record.status === "active" ? t("admin.usersTab.actionDisable") : t("admin.usersTab.actionEnable"),
                                                                danger: record.status === "active",
                                                                disabled: record.id === user.id || Boolean(record.isInitialAdmin),
                                                                confirm: record.status === "active" ? t("admin.usersTab.confirmDisable") : t("admin.usersTab.confirmEnable"),
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
                                    {t("admin.redeemTab.tabLabel")}
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
                                            message={t("admin.redeemTab.generatedAlertTitle", { count: generatedCodes.length })}
                                            description={
                                                <div className="mt-2 flex flex-col gap-2">
                                                    <Input.TextArea value={generatedCodes.join("\n")} readOnly autoSize={{ minRows: 2, maxRows: 6 }} />
                                                    <div>
                                                        <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => copyText(generatedCodes.join("\n"), t("admin.redeemTab.copiedAll"))}>
                                                            {t("admin.redeemTab.copyAllBtn")}
                                                        </Button>
                                                    </div>
                                                </div>
                                            }
                                        />
                                    ) : null}

                                    <Card
                                        title={t("admin.redeemTab.cardTitle")}
                                        extra={
                                            <div className="flex flex-wrap items-center gap-2">
                                                <Select
                                                    value={redeemStatusFilter}
                                                    className="min-w-[115px] flex-1 sm:w-[115px]! sm:flex-none"
                                                    onChange={(value) => {
                                                        setRedeemPage(1);
                                                        setSelectedRedeemIds([]);
                                                        setRedeemStatusFilter(value);
                                                    }}
                                                    options={[
                                                        { value: "", label: t("admin.redeemTab.allStatuses") },
                                                        { value: "active", label: t("admin.redeemTab.statusActive") },
                                                        { value: "disabled", label: t("admin.redeemTab.statusDisabled") },
                                                    ]}
                                                />
                                                <Input.Search
                                                    allowClear
                                                    placeholder={t("admin.redeemTab.searchPlaceholder")}
                                                    className="w-full! sm:w-[200px]!"
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
                                                    {redeemActiveKind === "storage" ? t("admin.redeemTab.createStorageBtn") : t("admin.redeemTab.createCreditsBtn")}
                                                </Button>
                                            </div>
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
                                                { key: "credits", label: t("admin.redeemTab.tabCredits") },
                                                { key: "storage", label: t("admin.redeemTab.tabStorage") },
                                            ]}
                                        />

                                        {selectedRedeemIds.length > 0 ? (
                                            <div
                                                className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs"
                                                style={{ borderColor: token.colorBorderSecondary, background: token.colorFillAlter }}
                                            >
                                                <span>
                                                    {t("admin.redeemTab.selectedPrefix")} <strong>{selectedRedeemIds.length}</strong> {t("admin.redeemTab.selectedSuffix")}
                                                    {hasSelectedUsedRedeem ? (
                                                        <Typography.Text type="danger" className="ml-2">
                                                            {t("admin.redeemTab.includesUsedWarning")}
                                                        </Typography.Text>
                                                    ) : null}
                                                </span>
                                                <Space wrap>
                                                    <Button size="small" icon={<Copy className="size-3.5" />} onClick={handleBatchCopyRedeemCodes}>
                                                        {t("admin.redeemTab.batchCopy")}
                                                    </Button>
                                                    <Tooltip title={hasSelectedUsedRedeem ? t("admin.redeemTab.usedCannotDeleteTip") : undefined}>
                                                        {hasSelectedUsedRedeem ? (
                                                            <Button size="small" danger disabled icon={<Trash2 className="size-3.5" />}>
                                                                {t("admin.redeemTab.batchDelete")}
                                                            </Button>
                                                        ) : (
                                                            <Popconfirm
                                                                title={t("admin.redeemTab.confirmBatchDelete", { count: selectedRedeemIds.length })}
                                                                onConfirm={() => void handleBatchDeleteRedeemCodes()}
                                                            >
                                                                <Button size="small" danger loading={batchDeletingRedeem} icon={<Trash2 className="size-3.5" />}>
                                                                    {t("admin.redeemTab.batchDelete")}
                                                                </Button>
                                                            </Popconfirm>
                                                        )}
                                                    </Tooltip>
                                                    <Button size="small" type="text" icon={<X className="size-3.5" />} onClick={() => setSelectedRedeemIds([])}>
                                                        {t("admin.redeemTab.deselect")}
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
                                                pageSize: redeemPageSize,
                                                total: redeemTotal,
                                                showSizeChanger: true,
                                                pageSizeOptions: [10, 20, 30, 50, 100],
                                                showTotal: (count) => t("common.totalItems", { count }),
                                                onChange: (page, size) => {
                                                    setSelectedRedeemIds([]);
                                                    if (size !== redeemPageSize) {
                                                        setRedeemPageSize(size);
                                                        setRedeemPage(1);
                                                    } else {
                                                        setRedeemPage(page);
                                                    }
                                                },
                                            }}
                                            columns={[
                                                {
                                                    title: t("admin.redeemTab.colCode"),
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
                                                    title: t("admin.redeemTab.colReward"),
                                                    key: "reward",
                                                    width: 185,
                                                    render: (_, record) =>
                                                        record.kind === "storage" ? (
                                                            <Tag color="cyan">
                                                                +{formatBytes(record.storageQuotaBytes)}
                                                                {record.storageDurationDays
                                                                    ? t("admin.redeemTab.rewardDays", { days: record.storageDurationDays })
                                                                    : t("admin.redeemTab.rewardPermanent")}
                                                            </Tag>
                                                        ) : (
                                                            <Tag color="gold">{t("admin.redeemTab.rewardCredits", { credits: record.credits })}</Tag>
                                                        ),
                                                },
                                                {
                                                    title: t("admin.redeemTab.colState"),
                                                    key: "state",
                                                    width: 90,
                                                    render: (_, record) => {
                                                        if (record.usedCount > 0 || record.usedCount >= record.maxUses) return <Tag color="orange">{t("admin.redeemTab.stateUsed")}</Tag>;
                                                        if (record.status === "disabled") return <Tag color="default">{t("admin.redeemTab.stateDisabled")}</Tag>;
                                                        if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) return <Tag color="red">{t("admin.redeemTab.stateExpired")}</Tag>;
                                                        return <Tag color="green">{t("admin.redeemTab.stateAvailable")}</Tag>;
                                                    },
                                                },
                                                {
                                                    title: t("admin.redeemTab.colRedemption"),
                                                    key: "redemption",
                                                    width: 250,
                                                    render: (_, record) => {
                                                        const r = record.redemption;
                                                        if (!r) return <Typography.Text type="secondary">—</Typography.Text>;
                                                        return (
                                                            <div className="flex flex-col text-xs leading-5">
                                                                <div className="flex items-center gap-1.5">
                                                                    <span className="font-medium">{r.username || r.displayName || t("admin.redeemTab.unknownUser")}</span>
                                                                    <Typography.Text type="secondary" code className="text-[11px]">
                                                                        {r.userId}
                                                                    </Typography.Text>
                                                                    <Button size="small" type="text" icon={<Copy className="size-3" />} onClick={() => copyText(r.userId, t("admin.redeemTab.copiedUserId"))} />
                                                                </div>
                                                                <Typography.Text type="secondary" className="text-[11px]">
                                                                    {new Date(r.redeemedAt).toLocaleString(locale)}
                                                                </Typography.Text>
                                                            </div>
                                                        );
                                                    },
                                                },
                                                {
                                                    title: t("admin.redeemTab.colExpiresAt"),
                                                    dataIndex: "expiresAt",
                                                    width: 170,
                                                    render: (v?: string | null) => (v ? new Date(v).toLocaleString(locale) : t("admin.redeemTab.neverExpires")),
                                                },
                                                {
                                                    title: t("admin.redeemTab.colNote"),
                                                    dataIndex: "note",
                                                    width: 180,
                                                    render: (v: string) => (
                                                        <Typography.Text ellipsis={{ tooltip: v || "—" }} className="block max-w-[160px]">
                                                            {v || "—"}
                                                        </Typography.Text>
                                                    ),
                                                },
                                                {
                                                    title: t("admin.channelsTab.colActions"),
                                                    key: "actions",
                                                    fixed: "right",
                                                    width: 100,
                                                    render: (_, record) => (
                                                        <TableRowActions
                                                            items={[
                                                                {
                                                                    key: "toggle",
                                                                    label: record.status === "active" ? t("admin.redeemTab.actionDisable") : t("admin.redeemTab.actionEnable"),
                                                                    disabled: record.usedCount > 0,
                                                                    onClick: () => void handleToggleRedeemStatus(record),
                                                                },
                                                                {
                                                                    key: "delete",
                                                                    label: t("common.delete"),
                                                                    danger: true,
                                                                    disabled: record.usedCount > 0,
                                                                    confirm: t("admin.redeemTab.confirmDelete"),
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
                                    {t("admin.mediaTab.tabLabel")}
                                </span>
                            ),
                            children: (
                                <Card
                                    title={
                                        mediaSubTab !== "media"
                                            ? t("admin.mediaTab.workspaceCardTitle", {
                                                  canvas: mediaWorkspaceStats.canvasProjects,
                                                  image: mediaWorkspaceStats.imageLogs,
                                                  video: mediaWorkspaceStats.videoLogs,
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
                                        mediaSubTab === "media" ? (
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
                                                        setWorkspaceDataPage(1);
                                                        setWorkspaceDataQuery(value.trim());
                                                    }}
                                                />
                                                <Button
                                                    icon={<RefreshCw className="size-4" />}
                                                    loading={workspaceDataLoading}
                                                    onClick={() => void loadWorkspaceData(mediaSubTab, workspaceDataPage, workspaceDataQuery, workspaceDataPageSize, true)}
                                                >
                                                    {t("common.refresh")}
                                                </Button>
                                            </div>
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
                                                label: t("admin.mediaTab.tabMedia", { count: mediaTotal }),
                                                children: (
                                                    <Table<MediaItem>
                                                        rowKey="id"
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
                                                                title: t("admin.mediaTab.colPreviewPath"),
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
                                                            { title: t("admin.mediaTab.colOwner"), dataIndex: "username", width: 120 },
                                                            {
                                                                title: t("admin.mediaTab.colModule"),
                                                                key: "modules",
                                                                width: 170,
                                                                render: (_, record) => <MediaModuleTags modules={record.modules} />,
                                                            },
                                                            {
                                                                title: t("admin.mediaTab.colKind"),
                                                                dataIndex: "kind",
                                                                width: 85,
                                                                render: (kind: string) => <Tag>{getKindLabel(kind, t)}</Tag>,
                                                            },
                                                            {
                                                                title: t("admin.mediaTab.colSize"),
                                                                dataIndex: "bytes",
                                                                width: 105,
                                                                render: (bytes: number) => <span className="whitespace-nowrap">{formatBytes(bytes)}</span>,
                                                            },
                                                            {
                                                                title: t("admin.mediaTab.colThumbSize"),
                                                                key: "thumbBytes",
                                                                width: 115,
                                                                render: (_, record: MediaItem) => {
                                                                    const thumbBytes = getMediaThumbBytes(record.meta);
                                                                    return <span className="whitespace-nowrap">{thumbBytes > 0 ? formatBytes(thumbBytes) : "—"}</span>;
                                                                },
                                                            },
                                                            {
                                                                title: t("admin.mediaTab.colUploadedAt"),
                                                                dataIndex: "createdAt",
                                                                width: 170,
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
                                                    { key: "canvas", label: t("admin.mediaTab.tabCanvas", { count: mediaWorkspaceStats.canvasProjects }) },
                                                    { key: "image_workbench", label: t("admin.mediaTab.tabImageWorkbench", { count: mediaWorkspaceStats.imageLogs }) },
                                                    { key: "video_workbench", label: t("admin.mediaTab.tabVideoWorkbench", { count: mediaWorkspaceStats.videoLogs }) },
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
                                                            pageSize: workspaceDataPageSize,
                                                            total: workspaceDataTotal,
                                                            showSizeChanger: true,
                                                            pageSizeOptions: [10, 20, 30, 50, 100],
                                                            showTotal: (count) => t("common.totalItems", { count }),
                                                            onChange: (page, size) => {
                                                                if (size !== workspaceDataPageSize) {
                                                                    setWorkspaceDataPageSize(size);
                                                                    setWorkspaceDataPage(1);
                                                                } else {
                                                                    setWorkspaceDataPage(page);
                                                                }
                                                            },
                                                        }}
                                                        columns={[
                                                            {
                                                                title: tabCfg.key === "canvas" ? t("admin.mediaTab.colCanvasTitle") : t("admin.mediaTab.colPromptTitle"),
                                                                key: "title",
                                                                width: 280,
                                                                render: (_, rec) => (
                                                                    <div className="max-w-[260px] truncate" title={rec.prompt || rec.title}>
                                                                        {rec.prompt || rec.title}
                                                                    </div>
                                                                ),
                                                            },
                                                            { title: t("admin.mediaTab.colOwner"), dataIndex: "username", width: 120 },
                                                            tabCfg.key === "canvas"
                                                                ? { title: t("admin.mediaTab.colNodes"), dataIndex: "nodeCount", width: 90 }
                                                                : { title: t("admin.mediaTab.colModel"), dataIndex: "model", width: 170, ellipsis: true },
                                                            { title: t("admin.mediaTab.colLinkedMedia"), dataIndex: "mediaCount", width: 95, render: (v: number) => t("admin.mediaTab.linkedMediaCount", { count: v ?? 0 }) },
                                                            {
                                                                title: t("admin.mediaTab.colDataSize"),
                                                                key: "mediaBytes",
                                                                width: 150,
                                                                render: (_, rec) => <WorkspaceSizeCell mediaBytes={rec.mediaBytes} dataBytes={rec.dataBytes} />,
                                                            },
                                                            { title: t("admin.mediaTab.colUpdatedAt"), dataIndex: "updatedAt", width: 170, render: (v: string) => new Date(v).toLocaleString(locale) },
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
                                                                                            void loadOverview(overviewDays);
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
                            ),
                        },
                        {
                            key: "storage",
                            label: (
                                <span className="inline-flex items-center gap-1.5">
                                    <HardDrive className="size-4" />
                                    {t("admin.storageTab.tabLabel")}
                                </span>
                            ),
                            children: (
                                <div className="flex flex-col gap-5">
                                    <Spin spinning={storageLoading}>
                                        <Card
                                            title={t("admin.storageTab.cardTitle")}
                                            extra={storageLoading ? <Tag>{t("topNav.loading")}</Tag> : storageConfigured ? <Tag color="green">{t("admin.storageTab.configured")}</Tag> : <Tag color="orange">{t("admin.storageTab.pending")}</Tag>}
                                        >
                                        <Alert
                                            type="info"
                                            showIcon
                                            className="mb-4"
                                            message={t("admin.storageTab.corsTitle")}
                                            description={t("admin.storageTab.corsDesc")}
                                        />
                                        <Form
                                            form={storageForm}
                                            layout="vertical"
                                            initialValues={{ provider: "r2", region: "auto", forcePathStyle: false }}
                                            onFinish={handleSaveStorage}
                                        >
                                            <Row gutter={16}>
                                                <Col xs={24} md={8}>
                                                    <Form.Item name="provider" label={t("admin.storageTab.providerLabel")} rules={[{ required: true }]}>
                                                        <Select
                                                            options={[
                                                                { value: "r2", label: t("admin.storageTab.providerR2") },
                                                                { value: "oss", label: t("admin.storageTab.providerOss") },
                                                                { value: "cos", label: t("admin.storageTab.providerCos") },
                                                                { value: "s3", label: t("admin.storageTab.providerS3") },
                                                            ]}
                                                        />
                                                    </Form.Item>
                                                </Col>
                                                <Col xs={24} md={8}>
                                                    <Form.Item name="bucket" label={t("admin.storageTab.bucketLabel")} rules={[{ required: true, message: t("admin.storageTab.bucketReq") }]}>
                                                        <Input placeholder="my-canvas-bucket" />
                                                    </Form.Item>
                                                </Col>
                                                <Col xs={24} md={8}>
                                                    <Form.Item name="region" label={t("admin.storageTab.regionLabel")} rules={[{ required: true, message: t("admin.storageTab.regionReq") }]}>
                                                        <Input placeholder="auto / cn-hangzhou / ap-guangzhou" />
                                                    </Form.Item>
                                                </Col>
                                                <Col xs={24} md={12}>
                                                    <Form.Item name="endpoint" label={t("admin.storageTab.endpointLabel")}>
                                                        <Input placeholder={t("admin.storageTab.endpointPlaceholder")} />
                                                    </Form.Item>
                                                </Col>
                                                <Col xs={24} md={12}>
                                                    <Form.Item name="publicBaseUrl" label={t("admin.storageTab.publicBaseUrlLabel")}>
                                                        <Input placeholder="https://cdn.example.com" />
                                                    </Form.Item>
                                                </Col>
                                                <Col xs={24} md={12}>
                                                    <Form.Item name="accessKeyId" label={t("admin.storageTab.accessKeyLabel")} rules={[{ required: true, message: t("admin.storageTab.accessKeyReq") }]}>
                                                        <Input placeholder="AccessKey ID" />
                                                    </Form.Item>
                                                </Col>
                                                <Col xs={24} md={12}>
                                                    <Form.Item
                                                        name="secretAccessKey"
                                                        label={`SecretAccessKey${storagePreview ? t("admin.storageTab.secretSavedSuffix", { preview: storagePreview }) : ""}`}
                                                        rules={storageConfigured ? [] : [{ required: true, message: t("admin.storageTab.secretReq") }]}
                                                    >
                                                        <Input.Password placeholder={storagePreview ? t("admin.storageTab.secretKeepPlaceholder") : t("admin.storageTab.secretInputPlaceholder")} />
                                                    </Form.Item>
                                                </Col>
                                                <Col xs={24}>
                                                    <Form.Item name="forcePathStyle" label={t("admin.storageTab.forcePathStyleLabel")} valuePropName="checked">
                                                        <Switch />
                                                    </Form.Item>
                                                </Col>
                                            </Row>
                                            <Space wrap>
                                                <Button icon={<Wifi className="size-4" />} onClick={handleTestStorage} loading={storageTesting}>
                                                    {t("admin.storageTab.testProbeBtn")}
                                                </Button>
                                                <Button type="primary" htmlType="submit" icon={<Save className="size-4" />} loading={storageSaving}>
                                                    {t("admin.storageTab.saveConfigBtn")}
                                                </Button>
                                            </Space>
                                        </Form>
                                    </Card>
                                    </Spin>

                                    <Card
                                        title={t("admin.storageTab.directUploadTitle")}
                                        extra={
                                            <Upload showUploadList={false} customRequest={handleDirectUploadTest} disabled={!storageConfigured || uploadingTest}>
                                                <Button type="primary" icon={<UploadCloud className="size-4" />} loading={uploadingTest} disabled={!storageConfigured}>
                                                    {t("admin.storageTab.uploadTestBtn")}
                                                </Button>
                                            </Upload>
                                        }
                                    >
                                        <Typography.Text type="secondary">{t("admin.storageTab.directUploadHint")}</Typography.Text>
                                    </Card>
                                </div>
                            ),
                        },
                        {
                            key: "settings",
                            label: (
                                <span className="inline-flex items-center gap-1.5">
                                    <Sliders className="size-4" />
                                    {t("admin.settingsTab.tabLabel")}
                                </span>
                            ),
                            children: [
                                {
                                    key: "settings-auth",
                                    label: (
                                        <span className="inline-flex items-center gap-1.5">
                                            <Shield className="size-3.5" />
                                            {t("admin.settingsTab.auth.tab")}
                                        </span>
                                    ),
                                    pageTitle: t("admin.settingsTab.auth.pageTitle"),
                                    children: (
                                        <Spin spinning={settingsLoading}>
                                            <Card title={t("admin.settingsTab.auth.cardTitle")}>
                                            <div className="flex flex-col gap-4">
                                                <div className="flex items-start justify-between gap-4 sm:items-center">
                                                    <div className="min-w-0 flex-1">
                                                        <div className="font-medium">{t("admin.settingsTab.auth.allowRegister")}</div>
                                                        <Typography.Text type="secondary">
                                                            {t("admin.settingsTab.auth.allowRegisterDesc")}
                                                        </Typography.Text>
                                                    </div>
                                                    <Switch
                                                        className="shrink-0"
                                                        checked={allowRegister}
                                                        loading={authPolicySaving}
                                                        onChange={(checked) => void handleUpdateAuthPolicy({ allowRegister: checked })}
                                                    />
                                                </div>
                                                <div className="flex items-start justify-between gap-4 border-t border-black/5 pt-4 sm:items-center dark:border-white/5">
                                                    <div className="min-w-0 flex-1">
                                                        <div className="font-medium">{t("admin.settingsTab.auth.requireEmail")}</div>
                                                        <Typography.Text type="secondary">
                                                            {t("admin.settingsTab.auth.requireEmailDesc")}
                                                        </Typography.Text>
                                                    </div>
                                                    <Switch
                                                        className="shrink-0"
                                                        checked={requireEmailOnRegister}
                                                        disabled={!mailReady && !requireEmailOnRegister}
                                                        loading={authPolicySaving}
                                                        onChange={(checked) => void handleUpdateAuthPolicy({ requireEmailOnRegister: checked })}
                                                    />
                                                </div>
                                            </div>
                                        </Card>
                                        </Spin>
                                    ),
                                },
                                {
                                    key: "settings-mail",
                                    label: (
                                        <span className="inline-flex items-center gap-1.5">
                                            <Mail className="size-3.5" />
                                            {t("admin.settingsTab.mail.tab")}
                                        </span>
                                    ),
                                    pageTitle: t("admin.settingsTab.mail.pageTitle"),
                                    children: (
                                        <Spin spinning={settingsLoading}>
                                            <Card
                                            title={
                                                <span className="inline-flex items-center gap-2">
                                                    <Mail className="size-4" />
                                                    {t("admin.settingsTab.mail.cardTitle")}
                                                </span>
                                            }
                                            extra={<Tag color={mailReady ? "green" : "default"}>{mailReady ? t("admin.settingsTab.mail.ready") : t("admin.settingsTab.mail.notReady")}</Tag>}
                                        >
                                            <Form
                                                form={mailForm}
                                                layout="vertical"
                                                initialValues={{
                                                    enabled: false,
                                                    port: 465,
                                                    secure: true,
                                                    fromName: t("admin.settingsTab.mail.defaultFromName"),
                                                    lowBalanceAlertEnabled: true,
                                                    lowBalanceThreshold: 10,
                                                    lowBalanceCooldownHours: 24,
                                                }}
                                                onFinish={handleSaveMailSettings}
                                            >
                                                <Row gutter={16}>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item name="enabled" label={t("admin.settingsTab.mail.enabled")} valuePropName="checked">
                                                            <Switch />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item name="secure" label={t("admin.settingsTab.mail.secure")} valuePropName="checked">
                                                            <Switch />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item name="host" label={t("admin.settingsTab.mail.host")}>
                                                            <Input placeholder={t("admin.settingsTab.mail.hostPlaceholder")} />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item name="port" label={t("admin.settingsTab.mail.port")}>
                                                            <InputNumber min={1} max={65535} className="w-full" placeholder="465" />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item name="username" label={t("admin.settingsTab.mail.username")}>
                                                            <Input placeholder={t("admin.settingsTab.mail.usernamePlaceholder")} />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item
                                                            name="password"
                                                            label={`${t("admin.settingsTab.mail.passwordPrefix")}${mailPasswordPreview ? t("admin.settingsTab.mail.passwordSavedSuffix", { preview: mailPasswordPreview }) : ""}`}
                                                        >
                                                            <Input.Password placeholder={mailPasswordPreview ? t("admin.settingsTab.mail.passwordKeepPlaceholder") : t("admin.settingsTab.mail.passwordInputPlaceholder")} />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item name="fromName" label={t("admin.settingsTab.mail.fromName")}>
                                                            <Input placeholder={t("admin.settingsTab.mail.defaultFromName")} />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item
                                                            name="fromAddress"
                                                            label={t("admin.settingsTab.mail.fromAddress")}
                                                            rules={[{ type: "email", message: t("admin.settingsTab.mail.fromAddressInvalid") }]}
                                                        >
                                                            <Input placeholder="noreply@example.com" />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={8}>
                                                        <Form.Item name="lowBalanceAlertEnabled" label={t("admin.settingsTab.mail.lowBalanceEnabled")} valuePropName="checked">
                                                            <Switch />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={8}>
                                                        <Form.Item name="lowBalanceThreshold" label={t("admin.settingsTab.mail.lowBalanceThreshold")}>
                                                            <InputNumber min={0} max={1000000} precision={2} className="w-full" />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={8}>
                                                        <Form.Item name="lowBalanceCooldownHours" label={t("admin.settingsTab.mail.lowBalanceCooldown")}>
                                                            <InputNumber min={1} max={720} className="w-full" />
                                                        </Form.Item>
                                                    </Col>
                                                </Row>
                                                <div className="flex flex-wrap items-center justify-between gap-3">
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <Input
                                                            value={testMailTo}
                                                            onChange={(e) => setTestMailTo(e.target.value)}
                                                            placeholder={t("admin.settingsTab.mail.testToPlaceholder")}
                                                            className="w-full! sm:w-[240px]!"
                                                        />
                                                        <Button icon={<Send className="size-4" />} onClick={() => void handleTestMailSettings()} loading={mailTesting}>
                                                            {t("admin.settingsTab.mail.sendTestBtn")}
                                                        </Button>
                                                    </div>
                                                    <Button type="primary" htmlType="submit" icon={<Save className="size-4" />} loading={mailSaving}>
                                                        {t("admin.settingsTab.mail.saveBtn")}
                                                    </Button>
                                                </div>
                                            </Form>
                                        </Card>
                                        </Spin>
                                    ),
                                },
                                {
                                    key: "settings-webdav",
                                    label: (
                                        <span className="inline-flex items-center gap-1.5">
                                            <Wifi className="size-3.5" />
                                            {t("admin.settingsTab.webdav.tab")}
                                        </span>
                                    ),
                                    pageTitle: t("admin.settingsTab.webdav.pageTitle"),
                                    children: (
                                        <Spin spinning={settingsLoading}>
                                            <Card title={t("admin.settingsTab.webdav.cardTitle")}>
                                            <Form
                                                form={webdavForm}
                                                layout="vertical"
                                                initialValues={{ enabled: false, baseDirectory: "infinite-canvas", autoAssignNewUsers: false }}
                                                onFinish={handleSavePlatformWebdav}
                                            >
                                                <Row gutter={16}>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item name="enabled" label={t("admin.settingsTab.webdav.enabled")} valuePropName="checked">
                                                            <Switch />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item name="autoAssignNewUsers" label={t("admin.settingsTab.webdav.autoAssign")} valuePropName="checked">
                                                            <Switch />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item name="url" label={t("admin.settingsTab.webdav.url")}>
                                                            <Input placeholder="https://nas.example.com/webdav" />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item name="baseDirectory" label={t("admin.settingsTab.webdav.baseDir")}>
                                                            <Input placeholder="infinite-canvas" />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item name="username" label={t("admin.settingsTab.webdav.username")}>
                                                            <Input placeholder={t("admin.settingsTab.webdav.usernamePlaceholder")} />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item
                                                            name="password"
                                                            label={`${t("admin.settingsTab.webdav.passwordPrefix")}${webdavPasswordPreview ? t("admin.settingsTab.webdav.passwordSavedSuffix", { preview: webdavPasswordPreview }) : ""}`}
                                                        >
                                                            <Input.Password placeholder={webdavPasswordPreview ? t("admin.settingsTab.webdav.passwordKeepPlaceholder") : t("admin.settingsTab.webdav.passwordInputPlaceholder")} />
                                                        </Form.Item>
                                                    </Col>
                                                </Row>
                                                <Space wrap>
                                                    <Button icon={<Wifi className="size-4" />} onClick={() => void handleTestPlatformWebdav()} loading={webdavTesting}>
                                                        {t("admin.settingsTab.webdav.testBtn")}
                                                    </Button>
                                                    <Button type="primary" htmlType="submit" icon={<Save className="size-4" />} loading={webdavSaving}>
                                                        {t("admin.settingsTab.webdav.saveBtn")}
                                                    </Button>
                                                </Space>
                                            </Form>
                                        </Card>
                                        </Spin>
                                    ),
                                },
                                {
                                    key: "settings-storage-expiry",
                                    label: (
                                        <span className="inline-flex items-center gap-1.5">
                                            <HardDrive className="size-3.5" />
                                            {t("admin.settingsTab.storageExpiry.tab")}
                                        </span>
                                    ),
                                    pageTitle: t("admin.settingsTab.storageExpiry.pageTitle"),
                                    children: (
                                        <Spin spinning={settingsLoading}>
                                            <Card
                                            title={
                                                <span className="inline-flex items-center gap-2">
                                                    <HardDrive className="size-4" />
                                                    {t("admin.settingsTab.storageExpiry.cardTitle")}
                                                </span>
                                            }
                                            extra={<Tag color={storageExpiryEnabled ? "green" : "default"}>{storageExpiryEnabled ? t("admin.settingsTab.storageExpiry.sweepOn") : t("admin.settingsTab.storageExpiry.sweepOff")}</Tag>}
                                        >
                                            <Alert
                                                type="info"
                                                showIcon
                                                className="mb-4"
                                                title={t("admin.settingsTab.storageExpiry.flowTitle")}
                                                description={
                                                    <div className="space-y-1 text-xs leading-6">
                                                        <div>{t("admin.settingsTab.storageExpiry.flowStep1")}</div>
                                                        <div>{t("admin.settingsTab.storageExpiry.flowStep2")}</div>
                                                        <div>{t("admin.settingsTab.storageExpiry.flowStep3")}</div>
                                                        <div>{t("admin.settingsTab.storageExpiry.flowStep4")}</div>
                                                    </div>
                                                }
                                            />
                                            <Form
                                                form={storageExpiryForm}
                                                layout="vertical"
                                                initialValues={{
                                                    enabled: false,
                                                    gracePeriodDays: 7,
                                                    preExpiryWarnDays: 3,
                                                    cleanupWorkspaceData: true,
                                                    exemptAdmins: true,
                                                    cleanupOverQuotaWithoutExpiry: true,
                                                }}
                                                onFinish={handleSaveStorageExpiryPolicy}
                                            >
                                                <Row gutter={16}>
                                                    <Col xs={24} md={6}>
                                                        <Form.Item name="enabled" label={t("admin.settingsTab.storageExpiry.enabledLabel")} valuePropName="checked">
                                                            <Switch />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={6}>
                                                        <Form.Item name="exemptAdmins" label={t("admin.settingsTab.storageExpiry.exemptAdminsLabel")} valuePropName="checked">
                                                            <Switch />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={6}>
                                                        <Form.Item name="cleanupOverQuotaWithoutExpiry" label={t("admin.settingsTab.storageExpiry.cleanupOverQuotaLabel")} valuePropName="checked">
                                                            <Switch />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={6}>
                                                        <Form.Item name="cleanupWorkspaceData" label={t("admin.settingsTab.storageExpiry.cleanupWorkspaceLabel")} valuePropName="checked">
                                                            <Switch />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item name="preExpiryWarnDays" label={t("admin.settingsTab.storageExpiry.warnDaysLabel")}>
                                                            <InputNumber min={0} max={30} precision={0} className="w-full" />
                                                        </Form.Item>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item name="gracePeriodDays" label={t("admin.settingsTab.storageExpiry.graceDaysLabel")}>
                                                            <InputNumber min={1} max={365} precision={0} className="w-full" />
                                                        </Form.Item>
                                                    </Col>
                                                </Row>
                                                <div className="flex flex-wrap items-center justify-between gap-3">
                                                    <Space wrap>
                                                        <Button type="primary" htmlType="submit" icon={<Save className="size-4" />} loading={storageExpirySaving}>
                                                            {t("admin.settingsTab.storageExpiry.savePolicyBtn")}
                                                        </Button>
                                                        <Button
                                                            icon={<RefreshCw className="size-4" />}
                                                            onClick={() => void handleRunStorageExpirySweep(true)}
                                                            loading={storageExpiryPreviewing}
                                                            disabled={storageExpiryRunning}
                                                        >
                                                            {t("admin.settingsTab.storageExpiry.previewBtn")}
                                                        </Button>
                                                        <Popconfirm
                                                            title={t("admin.settingsTab.storageExpiry.confirmRunTitle")}
                                                            description={t("admin.settingsTab.storageExpiry.confirmRunDesc")}
                                                            okText={t("admin.settingsTab.storageExpiry.confirmRunOk")}
                                                            cancelText={t("common.cancel")}
                                                            onConfirm={() => void handleRunStorageExpirySweep(false)}
                                                        >
                                                            <Button
                                                                danger
                                                                icon={<Trash2 className="size-4" />}
                                                                loading={storageExpiryRunning}
                                                                disabled={storageExpiryPreviewing}
                                                            >
                                                                {t("admin.settingsTab.storageExpiry.runNowBtn")}
                                                            </Button>
                                                        </Popconfirm>
                                                    </Space>
                                                    {!mailReady ? <Typography.Text type="warning">{t("admin.settingsTab.storageExpiry.mailNotReadyTip")}</Typography.Text> : null}
                                                </div>
                                            </Form>

                                            {storageExpiryResult ? (
                                                <div className="mt-6 space-y-3 border-t border-black/5 pt-4 dark:border-white/5">
                                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                                        <Space wrap>
                                                            <Tag color={storageExpiryResult.dryRun ? "blue" : "green"}>
                                                                {storageExpiryResult.dryRun ? t("admin.settingsTab.storageExpiry.dryRunTag") : t("admin.settingsTab.storageExpiry.liveRunTag")}
                                                            </Tag>
                                                            <Tag>{t("admin.settingsTab.storageExpiry.scannedUsers", { count: storageExpiryResult.scannedUsers })}</Tag>
                                                            <Tag>{t("admin.settingsTab.storageExpiry.eligibleUsers", { count: storageExpiryResult.eligibleUsers })}</Tag>
                                                            <Tag color="gold">{t("admin.settingsTab.storageExpiry.warnedCount", { count: storageExpiryResult.preExpiryWarned })}</Tag>
                                                            <Tag color="orange">{t("admin.settingsTab.storageExpiry.noticedCount", { count: storageExpiryResult.expiredNoticed })}</Tag>
                                                            <Tag color="red">{t("admin.settingsTab.storageExpiry.cleanedCount", { count: storageExpiryResult.cleanedUsers })}</Tag>
                                                            <Tag color="purple">{t("admin.settingsTab.storageExpiry.freedBytes", { size: formatBytes(storageExpiryResult.freedBytesTotal) })}</Tag>
                                                            {storageExpiryResult.failedCount > 0 ? <Tag color="error">{t("admin.settingsTab.storageExpiry.failedCount", { count: storageExpiryResult.failedCount })}</Tag> : null}
                                                        </Space>
                                                        <Typography.Text type="secondary" className="text-xs">
                                                            {t("admin.settingsTab.storageExpiry.executedAt", { time: dayjs(storageExpiryResult.executedAt).format("YYYY-MM-DD HH:mm:ss") })}
                                                        </Typography.Text>
                                                    </div>
                                                    {storageExpiryResult.truncated ? (
                                                        <Alert type="warning" showIcon title={t("admin.settingsTab.storageExpiry.truncatedAlert")} />
                                                    ) : null}
                                                    <Table<StorageExpirySweepItem>
                                                        className={ADMIN_TABLE_CLASS}
                                                        rowKey={(row) => `${row.userId}-${row.action}`}
                                                        dataSource={storageExpiryResult.items}
                                                        pagination={{ defaultPageSize: 10, showSizeChanger: true, pageSizeOptions: [10, 20, 30, 50, 100], showTotal: (count) => t("common.totalItems", { count }) }}
                                                        scroll={ADMIN_TABLE_SCROLL}
                                                        locale={{ emptyText: t("admin.settingsTab.storageExpiry.emptyText") }}
                                                        columns={[
                                                            {
                                                                title: t("admin.settingsTab.storageExpiry.colUser"),
                                                                width: 180,
                                                                render: (_, row) => (
                                                                    <div>
                                                                        <div className="font-medium">{row.displayName || row.username}</div>
                                                                        <Typography.Text type="secondary" className="text-xs">
                                                                            @{row.username}
                                                                        </Typography.Text>
                                                                    </div>
                                                                ),
                                                            },
                                                            {
                                                                title: t("admin.settingsTab.storageExpiry.colEmail"),
                                                                width: 190,
                                                                render: (_, row) => row.email || <Typography.Text type="secondary">{t("admin.settingsTab.storageExpiry.unboundEmail")}</Typography.Text>,
                                                            },
                                                            {
                                                                title: t("admin.settingsTab.storageExpiry.colAction"),
                                                                width: 120,
                                                                render: (_, row) => {
                                                                    if (row.action === "pre_expiry_warn") return <Tag color="gold">{t("admin.settingsTab.storageExpiry.actionPreWarn")}</Tag>;
                                                                    if (row.action === "expired_notice") return <Tag color="orange">{t("admin.settingsTab.storageExpiry.actionExpiredNotice")}</Tag>;
                                                                    if (row.action === "over_quota_cleaned") {
                                                                        return <Tag color="volcano">{storageExpiryResult.dryRun ? t("admin.settingsTab.storageExpiry.actionOverQuotaPending") : t("admin.settingsTab.storageExpiry.actionOverQuotaDone")}</Tag>;
                                                                    }
                                                                    return <Tag color="red">{storageExpiryResult.dryRun ? t("admin.settingsTab.storageExpiry.actionExpiredPending") : t("admin.settingsTab.storageExpiry.actionExpiredDone")}</Tag>;
                                                                },
                                                            },
                                                            {
                                                                title: t("admin.settingsTab.storageExpiry.colExpiryGrace"),
                                                                width: 210,
                                                                render: (_, row) =>
                                                                    row.expiresAt ? (
                                                                        <div className="text-xs leading-5">
                                                                            <div>{t("admin.settingsTab.storageExpiry.expiresLine", { time: dayjs(row.expiresAt).format("YYYY-MM-DD HH:mm") })}</div>
                                                                            {row.graceEndsAt ? (
                                                                                <Typography.Text type="secondary">
                                                                                    {t("admin.settingsTab.storageExpiry.graceLine", { time: dayjs(row.graceEndsAt).format("YYYY-MM-DD HH:mm") })}
                                                                                </Typography.Text>
                                                                            ) : null}
                                                                        </div>
                                                                    ) : (
                                                                        <Typography.Text type="secondary" className="text-xs">
                                                                            {t("admin.settingsTab.storageExpiry.permanentOverQuota")}
                                                                        </Typography.Text>
                                                                    ),
                                                            },
                                                            {
                                                                title: t("admin.settingsTab.storageExpiry.colUsedQuota"),
                                                                width: 160,
                                                                render: (_, row) => (
                                                                    <div className="text-xs leading-5">
                                                                        <div>{t("admin.settingsTab.storageExpiry.usedLine", { size: formatBytes(row.usedBytes) })}</div>
                                                                        <Typography.Text type="secondary">{t("admin.settingsTab.storageExpiry.quotaLine", { size: formatBytes(row.quotaBytes) })}</Typography.Text>
                                                                    </div>
                                                                ),
                                                            },
                                                            {
                                                                title: t("admin.settingsTab.storageExpiry.colCleanup"),
                                                                width: 190,
                                                                render: (_, row) =>
                                                                    row.action === "cleaned" || row.action === "over_quota_cleaned" ? (
                                                                        <div className="text-xs leading-5">
                                                                            <div>
                                                                                {t("admin.settingsTab.storageExpiry.cleanupMedia", {
                                                                                    count: row.deletedMediaCount,
                                                                                    size: formatBytes(row.freedBytes),
                                                                                })}
                                                                            </div>
                                                                            {row.deletedCanvasCount || row.deletedWorkbenchCount || row.deletedAssetCount ? (
                                                                                <Typography.Text type="secondary">
                                                                                    {t("admin.settingsTab.storageExpiry.cleanupWorkspace", {
                                                                                        canvas: row.deletedCanvasCount,
                                                                                        workbench: row.deletedWorkbenchCount,
                                                                                        assets: row.deletedAssetCount,
                                                                                    })}
                                                                                </Typography.Text>
                                                                            ) : null}
                                                                        </div>
                                                                    ) : (
                                                                        <Typography.Text type="secondary">-</Typography.Text>
                                                                    ),
                                                            },
                                                            {
                                                                title: t("admin.settingsTab.storageExpiry.colEmailStatus"),
                                                                width: 150,
                                                                render: (_, row) =>
                                                                    row.error ? (
                                                                        <Typography.Text type="danger" className="text-xs">
                                                                            {row.error}
                                                                        </Typography.Text>
                                                                    ) : storageExpiryResult.dryRun ? (
                                                                        <Typography.Text type="secondary" className="text-xs">
                                                                            {t("admin.settingsTab.storageExpiry.previewPending")}
                                                                        </Typography.Text>
                                                                    ) : row.emailSent ? (
                                                                        <Tag color="green">{t("admin.settingsTab.storageExpiry.emailSent")}</Tag>
                                                                    ) : (
                                                                        <Tag>{t("admin.settingsTab.storageExpiry.emailSkipped")}</Tag>
                                                                    ),
                                                            },
                                                            {
                                                                title: t("common.actions"),
                                                                key: "actions",
                                                                fixed: "right",
                                                                width: 110,
                                                                render: (_, row) => {
                                                                    if (!storageExpiryResult.dryRun) {
                                                                        return (
                                                                            <Typography.Text type="secondary" className="text-xs">
                                                                                {t("admin.settingsTab.storageExpiry.handled")}
                                                                            </Typography.Text>
                                                                        );
                                                                    }
                                                                    const isCleanup = row.action === "cleaned" || row.action === "over_quota_cleaned";
                                                                    const isBusy = cleaningSingleUserId === row.userId;
                                                                    return (
                                                                        <Popconfirm
                                                                            title={
                                                                                isCleanup
                                                                                    ? t("admin.settingsTab.storageExpiry.confirmSingleCleanTitle", {
                                                                                          user: row.displayName || row.username,
                                                                                      })
                                                                                    : t("admin.settingsTab.storageExpiry.confirmSingleNoticeTitle", {
                                                                                          user: row.displayName || row.username,
                                                                                      })
                                                                            }
                                                                            description={
                                                                                isCleanup
                                                                                    ? t("admin.settingsTab.storageExpiry.confirmSingleCleanDesc", {
                                                                                          count: row.deletedMediaCount,
                                                                                          size: formatBytes(row.freedBytes),
                                                                                      })
                                                                                    : undefined
                                                                            }
                                                                            okText={t("admin.settingsTab.storageExpiry.confirmRunOk")}
                                                                            cancelText={t("common.cancel")}
                                                                            onConfirm={() => void handleRunSingleUserStorageSweep(row)}
                                                                        >
                                                                            <Button
                                                                                type="link"
                                                                                size="small"
                                                                                danger={isCleanup}
                                                                                loading={isBusy}
                                                                                disabled={Boolean(cleaningSingleUserId && !isBusy) || storageExpiryRunning || storageExpiryPreviewing}
                                                                                className="!h-6 !px-1 !text-xs whitespace-nowrap"
                                                                            >
                                                                                {isCleanup
                                                                                    ? t("admin.settingsTab.storageExpiry.singleCleanBtn")
                                                                                    : t("admin.settingsTab.storageExpiry.singleNoticeBtn")}
                                                                            </Button>
                                                                        </Popconfirm>
                                                                    );
                                                                },
                                                            },
                                                        ]}
                                                    />
                                                </div>
                                            ) : null}
                                        </Card>
                                        </Spin>
                                    ),
                                },
                                {
                                    key: "settings-announcements",
                                    label: (
                                        <span className="inline-flex items-center gap-1.5">
                                            <Megaphone className="size-3.5" />
                                            {t("admin.settingsTab.announcements.tab")}
                                        </span>
                                    ),
                                    pageTitle: t("admin.settingsTab.announcements.pageTitle"),
                                    children: (
                                        <div className="flex flex-col gap-5">
                                            <Card
                                                title={t("admin.settingsTab.announcements.globalCardTitle")}
                                                extra={
                                                    noticeUpdatedAt ? (
                                                        <Typography.Text type="secondary" className="text-xs">
                                                            {t("admin.settingsTab.announcements.lastUpdated", { time: new Date(noticeUpdatedAt).toLocaleString(locale) })}
                                                        </Typography.Text>
                                                    ) : null
                                                }
                                            >
                                                <Alert
                                                    type="info"
                                                    showIcon
                                                    className="mb-4"
                                                    message={t("admin.settingsTab.announcements.globalAlertTitle")}
                                                    description={t("admin.settingsTab.announcements.globalAlertDesc")}
                                                />
                                                <Form
                                                    form={noticeForm}
                                                    layout="vertical"
                                                    initialValues={{ enabled: false, title: "", content: "" }}
                                                    onFinish={handleSaveGlobalNotice}
                                                >
                                                    <Form.Item name="enabled" label={t("admin.settingsTab.announcements.globalEnabled")} valuePropName="checked">
                                                        <Switch />
                                                    </Form.Item>
                                                    <Form.Item name="title" label={t("admin.settingsTab.announcements.globalTitle")}>
                                                        <Input placeholder={t("admin.settingsTab.announcements.globalTitlePlaceholder")} maxLength={120} />
                                                    </Form.Item>
                                                    <Form.Item name="content" label={t("admin.settingsTab.announcements.globalContent")}>
                                                        <Input.TextArea
                                                            rows={6}
                                                            maxLength={10000}
                                                            showCount
                                                            placeholder={t("admin.settingsTab.announcements.globalContentPlaceholder")}
                                                        />
                                                    </Form.Item>
                                                    <Button type="primary" htmlType="submit" icon={<Save className="size-4" />} loading={noticeSaving}>
                                                        {t("admin.settingsTab.announcements.saveGlobalBtn")}
                                                    </Button>
                                                </Form>
                                            </Card>

                                            <Card
                                                title={t("admin.settingsTab.announcements.timelineCardTitle")}
                                                extra={
                                                    <Button type="primary" icon={<Plus className="size-4" />} onClick={handleOpenCreateAnnouncement}>
                                                        {t("admin.settingsTab.announcements.createBtn")}
                                                    </Button>
                                                }
                                            >
                                                <Table<AnnouncementItem>
                                                    rowKey="id"
                                                    className={ADMIN_TABLE_CLASS}
                                                    scroll={ADMIN_TABLE_SCROLL}
                                                    loading={announcementsLoading}
                                                    dataSource={announcements}
                                                    pagination={{ defaultPageSize: 10, showSizeChanger: true, pageSizeOptions: [10, 20, 30, 50, 100], showTotal: (count) => t("common.totalItems", { count }) }}
                                                    columns={[
                                                        {
                                                            title: t("admin.settingsTab.announcements.colContent"),
                                                            key: "title",
                                                            width: 320,
                                                            render: (_, record) => (
                                                                <div className="flex max-w-[300px] flex-col gap-1">
                                                                    <div className="flex items-center gap-1.5">
                                                                        {record.isPinned ? (
                                                                            <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                                                                                {t("admin.settingsTab.announcements.pinnedTag")}
                                                                            </Tag>
                                                                        ) : null}
                                                                        <span className="truncate font-medium">{record.title}</span>
                                                                    </div>
                                                                    <Typography.Text type="secondary" ellipsis={{ tooltip: record.content }} className="text-xs">
                                                                        {record.content}
                                                                    </Typography.Text>
                                                                </div>
                                                            ),
                                                        },
                                                        {
                                                            title: t("admin.settingsTab.announcements.colStatus"),
                                                            dataIndex: "level",
                                                            width: 120,
                                                            render: (level: AnnouncementLevel, record) => (
                                                                <Select
                                                                    size="small"
                                                                    value={level in announcementLevelMeta ? level : "default"}
                                                                    popupMatchSelectWidth={false}
                                                                    options={announcementLevelOptions}
                                                                    onChange={(val) => void handleToggleAnnouncementFlag(record, { level: val })}
                                                                />
                                                            ),
                                                        },
                                                        {
                                                            title: t("admin.settingsTab.announcements.colPin"),
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
                                                            title: t("admin.settingsTab.announcements.colPublished"),
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
                                                            title: t("admin.settingsTab.announcements.colPublishedAt"),
                                                            dataIndex: "createdAt",
                                                            width: 170,
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
                                                                        {
                                                                            key: "edit",
                                                                            label: t("common.edit"),
                                                                            onClick: () => handleOpenEditAnnouncement(record),
                                                                        },
                                                                        {
                                                                            key: "delete",
                                                                            label: t("common.delete"),
                                                                            danger: true,
                                                                            confirm: t("admin.settingsTab.announcements.confirmDelete"),
                                                                            onClick: () => void handleDeleteAnnouncement(record.id),
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
                                    key: "settings-analytics",
                                    label: (
                                        <span className="inline-flex items-center gap-1.5">
                                            <BarChart3 className="size-3.5" />
                                            {t("admin.settingsTab.analytics.tab")}
                                        </span>
                                    ),
                                    pageTitle: t("admin.settingsTab.analytics.pageTitle"),
                                    children: (
                                        <Spin spinning={settingsLoading}>
                                            <Card title={t("admin.settingsTab.analytics.cardTitle")}>
                                            <Alert
                                                type="info"
                                                showIcon
                                                className="mb-4"
                                                message={t("admin.settingsTab.analytics.alertTitle")}
                                                description={t("admin.settingsTab.analytics.alertDesc")}
                                            />
                                            <Form
                                                form={analyticsForm}
                                                layout="vertical"
                                                initialValues={{ sampleIntervalMinutes: 5, logRetentionDays: 0 }}
                                                onFinish={handleSaveAnalyticsSettings}
                                            >
                                                <Row gutter={16}>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item
                                                            name="sampleIntervalMinutes"
                                                            label={t("admin.settingsTab.analytics.sampleIntervalLabel")}
                                                            rules={[{ required: true, message: t("admin.settingsTab.analytics.sampleIntervalReq") }]}
                                                        >
                                                            <InputNumber min={1} max={1440} precision={0} className="w-full" />
                                                        </Form.Item>
                                                        <div className="mb-4 flex flex-wrap gap-1.5">
                                                            {[1, 5, 10, 15, 30, 60].map((mins) => (
                                                                <Button
                                                                    key={mins}
                                                                    size="small"
                                                                    onClick={() => analyticsForm.setFieldValue("sampleIntervalMinutes", mins)}
                                                                >
                                                                    {t("admin.settingsTab.analytics.minuteOption", { mins })}
                                                                </Button>
                                                            ))}
                                                        </div>
                                                    </Col>
                                                    <Col xs={24} md={12}>
                                                        <Form.Item
                                                            name="logRetentionDays"
                                                            label={t("admin.settingsTab.analytics.logRetentionLabel")}
                                                            rules={[{ required: true, message: t("admin.settingsTab.analytics.logRetentionReq") }]}
                                                        >
                                                            <InputNumber min={0} max={3650} precision={0} className="w-full" />
                                                        </Form.Item>
                                                        <div className="mb-4 flex flex-wrap gap-1.5">
                                                            {[
                                                                { label: t("admin.settingsTab.analytics.retentionPermanent"), days: 0 },
                                                                { label: t("admin.settingsTab.analytics.retentionDays", { days: 7 }), days: 7 },
                                                                { label: t("admin.settingsTab.analytics.retentionDays", { days: 30 }), days: 30 },
                                                                { label: t("admin.settingsTab.analytics.retentionDays", { days: 90 }), days: 90 },
                                                                { label: t("admin.settingsTab.analytics.retentionDays", { days: 180 }), days: 180 },
                                                                { label: t("admin.settingsTab.analytics.retentionDays", { days: 365 }), days: 365 },
                                                            ].map((item) => (
                                                                <Button
                                                                    key={item.days}
                                                                    size="small"
                                                                    onClick={() => analyticsForm.setFieldValue("logRetentionDays", item.days)}
                                                                >
                                                                    {item.label}
                                                                </Button>
                                                            ))}
                                                        </div>
                                                    </Col>
                                                </Row>
                                                <Space wrap>
                                                    <Button type="primary" htmlType="submit" icon={<Save className="size-4" />} loading={analyticsSaving}>
                                                        {t("admin.storageTab.saveConfigBtn")}
                                                    </Button>
                                                    <Popconfirm
                                                        title={t("admin.settingsTab.analytics.confirmCleanupTitle")}
                                                        description={t("admin.settingsTab.analytics.confirmCleanupDesc")}
                                                        onConfirm={() => void handleCleanupExpiredLogs()}
                                                    >
                                                        <Button danger icon={<Trash2 className="size-4" />} loading={cleaningLogs}>
                                                            {t("admin.settingsTab.analytics.cleanupBtn")}
                                                        </Button>
                                                    </Popconfirm>
                                                </Space>
                                            </Form>
                                        </Card>
                                        </Spin>
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
                      label: t("admin.nav.platformAdmin"),
                      children: adminTabs.map(toMenuItem),
                  },
                  {
                      type: "group",
                      label: t("admin.nav.personalCenter"),
                      children: personalTabs.map(toMenuItem),
                  },
              ]
            : [
                  {
                      type: "group",
                      label: t("admin.nav.personalCenter"),
                      children: personalTabs.map(toMenuItem),
                  },
                  {
                      type: "group",
                      label: t("admin.nav.platformAdmin"),
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
            className="admin-shell flex h-full flex-col overflow-hidden"
            style={{ backgroundColor: token.colorBgLayout }}
        >
            <div className="mx-auto grid min-h-0 w-full max-w-[1680px] flex-1 grid-cols-1 gap-3 overflow-hidden px-2.5 py-2.5 sm:px-6 sm:py-3 lg:grid-cols-[216px_minmax(0,1fr)] lg:px-6 xl:grid-cols-[240px_minmax(0,1fr)] xl:px-8">
                <aside
                    className="thin-scrollbar hidden min-h-0 flex-col overflow-y-auto rounded-lg border p-3 lg:flex"
                    style={{
                        backgroundColor: token.colorBgContainer,
                        borderColor: token.colorBorderSecondary,
                    }}
                >
                    <div className="mb-3 px-2 pt-1">
                        <Typography.Title level={5} style={{ margin: 0 }}>
                            {isAdmin && isAdminRoute ? t("admin.nav.adminTitle") : t("admin.nav.personalTitle")}
                        </Typography.Title>
                        <Typography.Text type="secondary" className="text-xs">
                            {isAdmin && isAdminRoute ? t("admin.nav.adminSub") : t("admin.nav.personalSub")}
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
                    {isAdmin ? (
                        <div
                            className="mt-auto flex items-center justify-between border-t px-2 pt-3 text-xs"
                            style={{ borderColor: token.colorBorderSecondary }}
                        >
                            <Typography.Text type="secondary" className="text-xs">
                                {t("admin.nav.currentVersion")}
                            </Typography.Text>
                            <VersionReleaseModal />
                        </div>
                    ) : null}
                </aside>

                <main
                    className="thin-scrollbar flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto rounded-lg border p-3 sm:p-5"
                    style={{
                        backgroundColor: token.colorBgContainer,
                        borderColor: token.colorBorderSecondary,
                    }}
                >
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 sm:mb-5 sm:gap-3">
                        <div className="flex items-center gap-3">
                            <div className="lg:hidden">
                                <Button icon={<MenuIcon className="size-4" />} onClick={() => setMobileMenuOpen(true)}>
                                    {t("admin.nav.menuBtn")}
                                </Button>
                            </div>
                            <Typography.Title level={4} style={{ margin: 0 }}>
                                {activeSection?.pageTitle || activeSection?.label}
                            </Typography.Title>
                        </div>
                    </div>

                    <div className="w-full min-w-0">{activeSection?.children}</div>
                </main>
            </div>

            <Drawer
                open={mobileMenuOpen}
                placement="left"
                width={260}
                title={isAdmin && isAdminRoute ? t("admin.nav.adminDrawerTitle") : t("admin.nav.personalDrawerTitle")}
                onClose={() => setMobileMenuOpen(false)}
                styles={{ body: { padding: 12 } }}
                footer={
                    isAdmin ? (
                        <div className="flex items-center justify-between text-xs">
                            <Typography.Text type="secondary" className="text-xs">
                                {t("admin.nav.currentVersion")}
                            </Typography.Text>
                            <VersionReleaseModal />
                        </div>
                    ) : undefined
                }
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
                title={assigningUser ? t("admin.modals.webdav.titleWithUser", { name: assigningUser.displayName || assigningUser.username }) : t("admin.modals.webdav.titleFallback")}
                onCancel={() => setAssigningUser(null)}
                onOk={() => userWebdavForm.submit()}
                confirmLoading={userWebdavSaving}
            >
                <Form form={userWebdavForm} layout="vertical" onFinish={handleSaveUserWebdav}>
                    <Form.Item name="enabled" label={t("admin.modals.webdav.enabled")} valuePropName="checked">
                        <Switch />
                    </Form.Item>
                    <Form.Item name="directory" label={t("admin.modals.webdav.directory")}>
                        <Input placeholder="infinite-canvas/alice" />
                    </Form.Item>
                    <Form.Item name="url" label={t("admin.modals.webdav.url")}>
                        <Input placeholder={t("admin.modals.webdav.urlPlaceholder")} />
                    </Form.Item>
                    <Form.Item name="username" label={t("admin.modals.webdav.username")}>
                        <Input placeholder={t("admin.modals.webdav.usernamePlaceholder")} />
                    </Form.Item>
                    <Form.Item name="password" label={t("admin.modals.webdav.password")}>
                        <Input.Password placeholder={t("admin.modals.webdav.passwordPlaceholder")} />
                    </Form.Item>
                    <Row gutter={12}>
                        <Col xs={24} sm={12}>
                            <Form.Item
                                name="quotaMb"
                                label={t("admin.modals.webdav.quotaMb", { used: formatBytes(assigningUser?.webdavConfig?.usedBytes ?? 0) })}
                            >
                                <InputNumber min={0} step={100} className="w-full" placeholder={t("admin.modals.webdav.quotaPlaceholder")} />
                            </Form.Item>
                        </Col>
                        <Col xs={24} sm={12}>
                            <Form.Item name="expiresAt" label={t("admin.modals.webdav.expiresAt")}>
                                <DatePicker showTime className="w-full" placeholder={t("admin.modals.webdav.expiresPlaceholder")} />
                            </Form.Item>
                        </Col>
                    </Row>
                    {assigningUser?.webdavConfig?.usedBytes ? (
                        <Form.Item name="resetUsedBytes" label={t("admin.modals.webdav.resetUsedBytes")} valuePropName="checked">
                            <Switch />
                        </Form.Item>
                    ) : null}
                </Form>
            </Modal>

            <Modal
                open={Boolean(storageQuotaUser)}
                zIndex={1020}
                title={
                    storageQuotaUser
                        ? t("admin.modals.quota.titleWithUser", { name: storageQuotaUser.displayName || storageQuotaUser.username })
                        : t("admin.modals.quota.titleFallback")
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
                        message={t("admin.modals.quota.alertTitle", {
                            used: formatBytes(storageQuotaUser?.storageUsedBytes ?? 0),
                            total: formatBytes(storageQuotaUser?.storageQuotaBytes ?? 0),
                        })}
                        description={t("admin.modals.quota.alertDesc", {
                            base: formatBytes(storageQuotaUser?.baseStorageQuotaBytes ?? storageQuotaUser?.storageQuotaBytes ?? 0),
                            grants: formatBytes(storageQuotaUser?.storageGrantsQuotaBytes ?? 0),
                        })}
                    />
                    <Form.Item
                        name="quotaMb"
                        label={t("admin.modals.quota.baseQuotaLabel")}
                        rules={[{ required: true, message: t("admin.modals.quota.baseQuotaReq") }]}
                    >
                        <InputNumber min={0} step={100} className="w-full" placeholder={t("admin.modals.quota.baseQuotaPlaceholder")} />
                    </Form.Item>
                    <div className="mb-4 flex flex-wrap gap-2">
                        {[0, 100, 500, 1024, 5120, 10240].map((mb) => (
                            <Button key={mb} size="small" onClick={() => userStorageQuotaForm.setFieldValue("quotaMb", mb)}>
                                {mb === 0 ? "0 MB" : mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`}
                            </Button>
                        ))}
                    </div>
                    <Form.Item name="expiresAt" label={t("admin.modals.quota.expiresLabel")}>
                        <DatePicker showTime allowClear className="w-full" placeholder={t("admin.modals.quota.expiresPlaceholder")} />
                    </Form.Item>
                    <Form.Item name="recalculateUsedBytes" label={t("admin.modals.quota.recalculateLabel")} valuePropName="checked">
                        <Switch />
                    </Form.Item>
                </Form>

                <div className="mt-2 border-t pt-3" style={{ borderColor: token.colorBorderSecondary }}>
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <Typography.Text strong className="text-xs">
                            {t("admin.modals.quota.grantsTitle", { count: storageQuotaGrants.length })}
                        </Typography.Text>
                        <Typography.Text type="secondary" className="text-xs">
                            {t("admin.modals.quota.grantsHint")}
                        </Typography.Text>
                    </div>
                    {storageQuotaGrantsLoading ? (
                        <Typography.Text type="secondary" className="text-xs">
                            {t("admin.modals.quota.grantsLoading")}
                        </Typography.Text>
                    ) : storageQuotaGrants.length ? (
                        <div className="flex max-h-48 flex-col gap-2 overflow-y-auto pr-1">
                            {storageQuotaGrants.map((grant) => (
                                <div
                                    key={grant.id}
                                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs"
                                    style={{ borderColor: token.colorBorderSecondary }}
                                >
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-1.5">
                                            <span className="font-medium">+{formatBytes(grant.quotaBytes)}</span>
                                            {grant.status === "revoked" ? (
                                                <Tag color="default" style={{ marginInlineEnd: 0 }}>
                                                    {t("admin.modals.quota.grantRevoked")}
                                                </Tag>
                                            ) : grant.isExpired ? (
                                                <Tag color="red" style={{ marginInlineEnd: 0 }}>
                                                    {t("admin.modals.quota.grantExpired")}
                                                </Tag>
                                            ) : (
                                                <Tag color="green" style={{ marginInlineEnd: 0 }}>
                                                    {t("admin.modals.quota.grantActive")}
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
                                                ? t("admin.modals.quota.grantExpiresAt", { time: new Date(grant.expiresAt).toLocaleString(locale) })
                                                : t("admin.modals.quota.grantPermanent")}
                                            {grant.durationDays ? t("admin.modals.quota.grantDurationDays", { days: grant.durationDays }) : ""}
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
                                        {grant.status === "active" ? t("admin.modals.quota.grantRevokeBtn") : t("admin.modals.quota.grantRestoreBtn")}
                                    </Button>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <Typography.Text type="secondary" className="text-xs">
                            {t("admin.modals.quota.grantsEmpty")}
                        </Typography.Text>
                    )}
                </div>
            </Modal>

            <Modal
                open={Boolean(creditUser)}
                zIndex={1020}
                title={
                    creditUser
                        ? t("admin.modals.credit.titleWithUser", {
                              name: creditUser.displayName || creditUser.username,
                              balance: creditUser.creditBalance ?? 0,
                          })
                        : t("admin.modals.credit.titleFallback")
                }
                onCancel={() => setCreditUser(null)}
                onOk={() => userCreditForm.submit()}
                okText={creditModeWatch === "clear" ? t("admin.modals.credit.confirmClear") : t("common.confirm")}
                okButtonProps={{ danger: creditModeWatch === "clear" }}
                confirmLoading={userCreditSaving}
            >
                <Form form={userCreditForm} layout="vertical" onFinish={handleAdjustUserCredits}>
                    <Form.Item name="mode" label={t("admin.modals.credit.modeLabel")} rules={[{ required: true }]}>
                        <Radio.Group>
                            <Radio.Button value="add">{t("admin.modals.credit.modeAdd")}</Radio.Button>
                            <Radio.Button value="deduct">{t("admin.modals.credit.modeDeduct")}</Radio.Button>
                            <Radio.Button value="clear">{t("admin.modals.credit.modeClear")}</Radio.Button>
                        </Radio.Group>
                    </Form.Item>
                    {creditModeWatch === "clear" ? (
                        <Alert
                            type="warning"
                            showIcon
                            className="mb-4"
                            message={t("admin.modals.credit.clearAlertTitle", { balance: creditUser?.creditBalance ?? 0 })}
                            description={t("admin.modals.credit.clearAlertDesc")}
                        />
                    ) : (
                        <Form.Item
                            name="amount"
                            label={t("admin.modals.credit.amountLabel")}
                            rules={[{ required: true, message: t("admin.modals.credit.amountReq") }]}
                        >
                            <InputNumber className="w-full" min={0.0001} step={10} />
                        </Form.Item>
                    )}
                    <Form.Item name="note" label={t("admin.modals.credit.noteLabel")}>
                        <Input placeholder={creditModeWatch === "clear" ? t("admin.modals.credit.clearNotePlaceholder") : t("admin.modals.credit.adjustNotePlaceholder")} />
                    </Form.Item>
                </Form>
            </Modal>

            <Modal
                open={createRedeemOpen}
                title={t("admin.modals.redeem.title")}
                onCancel={() => setCreateRedeemOpen(false)}
                onOk={() => createRedeemForm.submit()}
                confirmLoading={creatingRedeem}
            >
                <Form form={createRedeemForm} layout="vertical" onFinish={handleCreateRedeemCodes}>
                    <Form.Item name="kind" label={t("admin.modals.redeem.kindLabel")} rules={[{ required: true }]}>
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
                                { label: t("admin.modals.redeem.kindCredits"), value: "credits" },
                                { label: t("admin.modals.redeem.kindStorage"), value: "storage" },
                            ]}
                        />
                    </Form.Item>
                    <Row gutter={12}>
                        <Col xs={24} sm={12}>
                            <Form.Item name="count" label={t("admin.modals.redeem.countLabel")} rules={[{ required: true, message: t("admin.modals.redeem.countReq") }]}>
                                <InputNumber className="w-full" min={1} max={100} />
                            </Form.Item>
                        </Col>
                        {redeemKindWatch === "credits" ? (
                            <Col xs={24} sm={12}>
                                <Form.Item name="credits" label={t("admin.modals.redeem.creditsLabel")} rules={[{ required: true, message: t("admin.modals.redeem.creditsReq") }]}>
                                    <InputNumber className="w-full" min={0.01} step={10} />
                                </Form.Item>
                            </Col>
                        ) : (
                            <Col xs={24} sm={12}>
                                <Form.Item name="storageQuotaMb" label={t("admin.modals.redeem.storageQuotaLabel")} rules={[{ required: true, message: t("admin.modals.redeem.storageQuotaReq") }]}>
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
                            <Form.Item name="storageDurationDays" label={t("admin.modals.redeem.durationLabel")}>
                                <InputNumber className="w-full" min={1} max={36500} placeholder={t("admin.modals.redeem.durationPlaceholder")} />
                            </Form.Item>
                            <div className="mb-4 flex flex-wrap gap-1.5">
                                {[7, 30, 90, 365].map((d) => (
                                    <Button key={d} size="small" onClick={() => createRedeemForm.setFieldValue("storageDurationDays", d)}>
                                        {t("admin.modals.redeem.durationDaysOption", { days: d })}
                                    </Button>
                                ))}
                                <Button size="small" onClick={() => createRedeemForm.setFieldValue("storageDurationDays", null)}>
                                    {t("admin.modals.redeem.durationPermanent")}
                                </Button>
                            </div>
                        </>
                    ) : null}
                    <Row gutter={12}>
                        <Col xs={24} sm={12}>
                            <Form.Item name="prefix" label={t("admin.modals.redeem.prefixLabel")}>
                                <Input placeholder={redeemKindWatch === "storage" ? "ST" : "IC"} maxLength={16} />
                            </Form.Item>
                        </Col>
                        <Col xs={24} sm={12}>
                            <Form.Item label={t("admin.modals.redeem.limitLabel")}>
                                <Input value={t("admin.modals.redeem.limitValue")} disabled />
                            </Form.Item>
                        </Col>
                    </Row>
                    {redeemCountWatch === 1 ? (
                        <Form.Item name="customCode" label={t("admin.modals.redeem.customCodeLabel")}>
                            <Input placeholder={redeemKindWatch === "storage" ? t("admin.modals.redeem.customCodeStoragePh") : t("admin.modals.redeem.customCodeCreditsPh")} maxLength={64} />
                        </Form.Item>
                    ) : null}
                    <Form.Item name="expiresAt" label={t("admin.modals.redeem.expiresLabel")}>
                        <DatePicker showTime className="w-full" placeholder={t("admin.modals.redeem.expiresPlaceholder")} />
                    </Form.Item>
                    <Form.Item name="note" label={t("admin.modals.redeem.noteLabel")}>
                        <Input placeholder={t("admin.modals.redeem.notePlaceholder")} maxLength={200} />
                    </Form.Item>
                </Form>
            </Modal>

            <UserDetailDrawer
                userId={detailUserId}
                refreshKey={detailRefreshKey}
                currentUserId={user.id}
                onClose={() => setDetailUserId(null)}
                onOpenCredits={(target) => openAdjustCredits(target)}
                onOpenQuota={(target) => openConfigStorageQuota(target)}
                onUpdateUser={handleUpdateUser}
            />

            <Modal
                open={Boolean(previewMediaItem)}
                title={t("userPanels.myMedia.previewModalTitle")}
                onCancel={() => setPreviewMediaItem(null)}
                footer={
                    <Space wrap>
                        {previewMediaItem ? (
                            <Button
                                icon={<Download className="size-4" />}
                                loading={downloadingPreviewMedia}
                                onClick={() => {
                                    setDownloadingPreviewMedia(true);
                                    void storageApi
                                        .downloadFile(previewMediaItem)
                                        .catch((error) => {
                                            message.error(error instanceof Error ? error.message : t("userPanels.ledgerDetail.downloadFailed"));
                                        })
                                        .finally(() => setDownloadingPreviewMedia(false));
                                }}
                            >
                                {t("common.downloadOriginal")}
                            </Button>
                        ) : null}
                        <Button type="primary" onClick={() => setPreviewMediaItem(null)}>
                            {t("common.close")}
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
                            {t("common.openFileLink")}
                        </a>
                    )
                ) : null}
            </Modal>

            <Modal
                open={announcementModalOpen}
                title={editingAnnouncement ? t("admin.settingsTab.announcements.modalEditTitle") : t("admin.settingsTab.announcements.modalCreateTitle")}
                onCancel={() => {
                    setAnnouncementModalOpen(false);
                    setEditingAnnouncement(null);
                }}
                onOk={() => announcementForm.submit()}
                confirmLoading={announcementSaving}
            >
                <Form form={announcementForm} layout="vertical" onFinish={handleSaveAnnouncement}>
                    <Form.Item name="title" label={t("admin.settingsTab.announcements.titleLabel")} rules={[{ required: true, message: t("admin.settingsTab.announcements.titleReq") }]}>
                        <Input placeholder={t("admin.settingsTab.announcements.titlePlaceholder")} maxLength={120} />
                    </Form.Item>
                    <Row gutter={12}>
                        <Col xs={24} sm={12}>
                            <Form.Item name="level" label={t("admin.settingsTab.announcements.levelLabel")} rules={[{ required: true }]}>
                                <Select options={announcementLevelOptions} />
                            </Form.Item>
                        </Col>
                        <Col xs={24} sm={12}>
                            <Form.Item name="createdAt" label={t("admin.settingsTab.announcements.createdAtLabel")}>
                                <DatePicker showTime allowClear className="w-full" placeholder={t("admin.settingsTab.announcements.createdAtPlaceholder")} />
                            </Form.Item>
                        </Col>
                    </Row>
                    <Form.Item name="content" label={t("admin.settingsTab.announcements.contentLabel")} rules={[{ required: true, message: t("admin.settingsTab.announcements.contentReq") }]}>
                        <Input.TextArea rows={5} placeholder={t("admin.settingsTab.announcements.contentPlaceholder")} maxLength={4000} showCount />
                    </Form.Item>
                    <Row gutter={16}>
                        <Col xs={24} sm={12}>
                            <Form.Item name="isPinned" label={t("admin.settingsTab.announcements.isPinnedLabel")} valuePropName="checked">
                                <Switch />
                            </Form.Item>
                        </Col>
                        <Col xs={24} sm={12}>
                            <Form.Item name="isPublished" label={t("admin.settingsTab.announcements.isPublishedLabel")} valuePropName="checked">
                                <Switch />
                            </Form.Item>
                        </Col>
                    </Row>
                </Form>
            </Modal>
        </div>
    );
}
