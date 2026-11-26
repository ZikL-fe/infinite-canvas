/** 后台管理与个人后台入口页：管理员固定使用 /admin（平台管理在上），普通用户固定使用 /console。 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, Drawer, Menu, Result, Typography, theme as antdTheme } from "antd";
import type { MenuProps } from "antd";
import { BarChart3, Coins, Cpu, Database, FolderKanban, Gift, HardDrive, LayoutDashboard, Mail, Megaphone, Menu as MenuIcon, ScrollText, Settings2, Shield, Sliders, UserCheck, Users, Wifi } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { AppConfigPanel } from "@/components/layout/app-config-modal";
import { VersionReleaseModal } from "@/components/layout/version-release-modal";
import { AdminAnnouncementsPanel } from "@/pages/admin/components/announcements-panel";
import { AnalyticsDashboardPanel } from "@/pages/admin/components/analytics-dashboard-panel";
import { AdminChannelsPanel } from "@/pages/admin/components/channels-panel";
import { AdminMediaMonitorPanel } from "@/pages/admin/components/media-monitor-panel";
import { AdminOverviewPanel } from "@/pages/admin/components/overview-panel";
import { AdminRedeemCodesPanel } from "@/pages/admin/components/redeem-codes-panel";
import { AdminStorageSettingsPanel } from "@/pages/admin/components/storage-settings-panel";
import { AdminSystemSettingsPanel } from "@/pages/admin/components/system-settings-panel";
import { AdminUsersPanel } from "@/pages/admin/components/users-panel";
import { MyMediaPanel, MyWalletPanel, ProfileSecurityPanel, UsageLogsPanel, UserOverviewPanel } from "@/pages/admin/user-panels";
import { useUserStore } from "@/stores/use-user-store";

type NavTabItem = {
    key: string;
    label: ReactNode;
    pageTitle?: string;
    render?: () => ReactNode;
    children?: NavTabItem[];
};

const PERSONAL_TAB_KEYS = new Set(["user-overview", "user-dashboard", "usage-logs", "profile", "wallet", "my-media", "config"]);

function flattenTabItems(items: NavTabItem[]): Array<{ key: string; label: ReactNode; pageTitle?: string; render?: () => ReactNode }> {
    return items.flatMap((item) =>
        Array.isArray(item.children)
            ? flattenTabItems(item.children)
            : [{ key: item.key, label: item.label, pageTitle: item.pageTitle, render: item.render }],
    );
}

function toMenuItem(item: NavTabItem): NonNullable<MenuProps["items"]>[number] {
    return Array.isArray(item.children)
        ? {
              key: item.key,
              label: item.label,
              children: item.children.map(toMenuItem),
          }
        : {
              key: item.key,
              label: item.label,
          };
}

export default function AdminPage() {
    const { t } = useTranslation();
    const { token } = antdTheme.useToken();
    const navigate = useNavigate();
    const { pathname, search } = useLocation();
    const [searchParams, setSearchParams] = useSearchParams();
    const user = useUserStore((state) => state.user);
    const isAdmin = user?.role === "admin";
    const isAdminRoute = pathname.startsWith("/admin");

    const requestedTab = searchParams.get("tab") || "";
    const defaultTab = isAdmin ? "overview" : "user-overview";
    const normalizeTab = useCallback((tab: string) => {
        if (tab === "settings") return "settings-auth";
        if (tab === "announcements") return "settings-announcements";
        return tab;
    }, []);

    const [activeTab, setActiveTab] = useState(() => normalizeTab(requestedTab || defaultTab));
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
            setActiveTab(isAdmin ? "overview" : "user-overview");
        }
    }, [isAdmin, normalizeTab, requestedTab]);

    useEffect(() => {
        if (!isAdmin && !PERSONAL_TAB_KEYS.has(activeTab)) {
            switchTab("user-overview");
        }
    }, [activeTab, isAdmin, switchTab]);

    if (!user) {
        return (
            <div className="flex h-full items-center justify-center p-6">
                <Result
                    status="info"
                    title={t("admin.authGuard.loginRequired")}
                    extra={
                        <Button type="primary" onClick={() => navigate(`/auth?redirect=${encodeURIComponent(pathname + search)}`)}>
                            {t("admin.authGuard.goLogin")}
                        </Button>
                    }
                />
            </div>
        );
    }

    if (isAdmin && !isAdminRoute) {
        return <Navigate to={`/admin${search}`} replace />;
    }

    if (!isAdmin && isAdminRoute) {
        return <Navigate to={`/console${search}`} replace />;
    }

    const personalTabs: NavTabItem[] = [
        {
            key: "user-overview",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <LayoutDashboard className="size-4" />
                    {t("admin.nav.userOverview")}
                </span>
            ),
            render: () => <UserOverviewPanel onOpenWallet={() => switchTab("wallet")} onOpenMedia={() => switchTab("my-media")} />,
        },
        {
            key: "user-dashboard",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <BarChart3 className="size-4" />
                    {t("admin.nav.dashboard")}
                </span>
            ),
            render: () => <AnalyticsDashboardPanel scope="self" />,
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
                      render: () => <UsageLogsPanel defaultScope="self" />,
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
            render: () => <MyWalletPanel />,
        },
        {
            key: "profile",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <UserCheck className="size-4" />
                    {t("admin.nav.profile")}
                </span>
            ),
            render: () => <ProfileSecurityPanel />,
        },
        {
            key: "my-media",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <FolderKanban className="size-4" />
                    {t("admin.nav.myMedia")}
                </span>
            ),
            render: () => <MyMediaPanel />,
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
            render: () => <AppConfigPanel />,
        },
    ];

    const adminTabs: NavTabItem[] = [
        {
            key: "overview",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <Shield className="size-4" />
                    {t("admin.overviewTab.tabLabel")}
                </span>
            ),
            render: () => <AdminOverviewPanel onManageAnnouncements={() => switchTab("settings-announcements")} />,
        },
        {
            key: "dashboard",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <BarChart3 className="size-4" />
                    {t("admin.nav.dashboard")}
                </span>
            ),
            render: () => <AnalyticsDashboardPanel scope="all" />,
        },
        {
            key: "usage-logs",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <ScrollText className="size-4" />
                    {t("admin.nav.usageLogs")}
                </span>
            ),
            render: () => <UsageLogsPanel defaultScope="all" />,
        },
        {
            key: "channels",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <Cpu className="size-4" />
                    {t("admin.channelsTab.tabLabel")}
                </span>
            ),
            render: () => <AdminChannelsPanel />,
        },
        {
            key: "users",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <Users className="size-4" />
                    {t("admin.usersTab.tabLabel")}
                </span>
            ),
            render: () => <AdminUsersPanel />,
        },
        {
            key: "redeem-codes",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <Gift className="size-4" />
                    {t("admin.redeemTab.tabLabel")}
                </span>
            ),
            render: () => <AdminRedeemCodesPanel />,
        },
        {
            key: "media",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <Database className="size-4" />
                    {t("admin.mediaTab.tabLabel")}
                </span>
            ),
            render: () => <AdminMediaMonitorPanel />,
        },
        {
            key: "storage",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <HardDrive className="size-4" />
                    {t("admin.storageTab.tabLabel")}
                </span>
            ),
            render: () => <AdminStorageSettingsPanel />,
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
                    render: () => <AdminSystemSettingsPanel section="auth" />,
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
                    render: () => <AdminSystemSettingsPanel section="mail" />,
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
                    render: () => <AdminSystemSettingsPanel section="webdav" />,
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
                    render: () => <AdminSystemSettingsPanel section="storage-expiry" />,
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
                    render: () => <AdminAnnouncementsPanel />,
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
                    render: () => <AdminSystemSettingsPanel section="analytics" />,
                },
            ],
        },
    ];

    const allSections = flattenTabItems(isAdmin ? [...adminTabs, ...personalTabs] : personalTabs);
    const activeSection = allSections.find((item) => item.key === activeTab) ?? allSections[0];

    const menuItems: MenuProps["items"] = isAdmin
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
        : personalTabs.map(toMenuItem);

    const handleMenuSelect: MenuProps["onClick"] = ({ key }) => {
        switchTab(key);
        setMobileMenuOpen(false);
    };

    return (
        <div className="admin-shell flex h-full flex-col overflow-hidden" style={{ backgroundColor: token.colorBgLayout }}>
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
                            {isAdmin ? t("admin.nav.adminTitle") : t("admin.nav.personalTitle")}
                        </Typography.Title>
                        <Typography.Text type="secondary" className="text-xs">
                            {isAdmin ? t("admin.nav.adminSub") : t("admin.nav.personalSub")}
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

                    <div className="w-full min-w-0">{activeSection?.render?.()}</div>
                </main>
            </div>

            <Drawer
                open={mobileMenuOpen}
                placement="left"
                width={260}
                title={isAdmin ? t("admin.nav.adminDrawerTitle") : t("admin.nav.personalDrawerTitle")}
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
        </div>
    );
}
