/** 后台管理与个人后台布局壳：管理员固定使用 /admin/*，普通用户固定使用 /console/*，兼容旧 ?tab= 链接。 */
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { Button, Drawer, Menu, Result, Spin, Typography, theme as antdTheme } from "antd";
import type { MenuProps } from "antd";
import { BarChart3, Coins, Cpu, Database, FolderKanban, Gift, HardDrive, LayoutDashboard, Mail, Megaphone, Menu as MenuIcon, ScrollText, Settings2, Shield, Sliders, UserCheck, Users, Wifi } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Navigate, Outlet, useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { VersionReleaseModal } from "@/components/layout/version-release-modal";
import { useUserStore } from "@/stores/use-user-store";

type NavTabItem = {
    key: string;
    label: ReactNode;
    pageTitle?: string;
    children?: NavTabItem[];
};

const PERSONAL_TAB_KEYS = new Set(["user-overview", "user-dashboard", "usage-logs", "profile", "wallet", "my-media", "config"]);
const ADMIN_ONLY_TAB_KEYS = new Set([
    "overview",
    "dashboard",
    "channels",
    "users",
    "redeem-codes",
    "media",
    "storage",
    "settings-auth",
    "settings-invite",
    "settings-mail",
    "settings-webdav",
    "settings-storage-expiry",
    "settings-announcements",
    "settings-analytics",
]);

function normalizeTab(tab: string) {
    if (tab === "settings") return "settings-auth";
    if (tab === "announcements") return "settings-announcements";
    return tab;
}

function isKnownTab(tab: string) {
    return PERSONAL_TAB_KEYS.has(tab) || ADMIN_ONLY_TAB_KEYS.has(tab);
}

function flattenTabItems(items: NavTabItem[]): Array<{ key: string; label: ReactNode; pageTitle?: string }> {
    return items.flatMap((item) =>
        Array.isArray(item.children)
            ? flattenTabItems(item.children)
            : [{ key: item.key, label: item.label, pageTitle: item.pageTitle }],
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

function PanelFallback() {
    return (
        <div className="flex min-h-[40vh] w-full items-center justify-center">
            <Spin size="large" />
        </div>
    );
}

export default function AdminPage() {
    const { t } = useTranslation();
    const { token } = antdTheme.useToken();
    const navigate = useNavigate();
    const { pathname, search } = useLocation();
    const [searchParams] = useSearchParams();
    const user = useUserStore((state) => state.user);
    const isAdmin = user?.role === "admin";
    const isAdminRoute = pathname.startsWith("/admin");

    const basePath = isAdmin ? "/admin" : "/console";
    const defaultTab = isAdmin ? "overview" : "user-overview";
    const routePrefix = isAdminRoute ? "/admin" : "/console";
    const rawSubpath = pathname.startsWith(`${routePrefix}/`) ? pathname.slice(routePrefix.length + 1).split("/")[0] : "";
    const normalizedSubpath = normalizeTab(rawSubpath);
    const requestedTab = searchParams.get("tab") || "";
    const resolvedTab = isKnownTab(normalizedSubpath) ? normalizedSubpath : defaultTab;

    const [openMenuKeys, setOpenMenuKeys] = useState<string[]>(() => (resolvedTab.startsWith("settings-") ? ["settings"] : []));
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

    useEffect(() => {
        if (resolvedTab.startsWith("settings-")) {
            setOpenMenuKeys((prev) => (prev.includes("settings") ? prev : [...prev, "settings"]));
        }
    }, [resolvedTab]);

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

    // 兼容旧版 ?tab= 查询参数链接，统一重定向到新的嵌套子路由
    if (requestedTab) {
        const nextParams = new URLSearchParams(searchParams);
        nextParams.delete("tab");
        const nextQuery = nextParams.toString();
        const candidate = normalizeTab(requestedTab);
        const safeTab = isKnownTab(candidate) && (isAdmin || PERSONAL_TAB_KEYS.has(candidate)) ? candidate : defaultTab;
        return <Navigate to={`${basePath}/${safeTab}${nextQuery ? `?${nextQuery}` : ""}`} replace />;
    }

    if (!rawSubpath || !isKnownTab(normalizedSubpath)) {
        return <Navigate to={`${basePath}/${defaultTab}${search}`} replace />;
    }

    if (normalizedSubpath !== rawSubpath) {
        const safeTab = isAdmin || PERSONAL_TAB_KEYS.has(normalizedSubpath) ? normalizedSubpath : defaultTab;
        return <Navigate to={`${basePath}/${safeTab}${search}`} replace />;
    }

    if (isAdmin && !isAdminRoute) {
        return <Navigate to={`/admin/${normalizedSubpath}${search}`} replace />;
    }

    if (!isAdmin && isAdminRoute) {
        const safeTab = PERSONAL_TAB_KEYS.has(normalizedSubpath) ? normalizedSubpath : "user-overview";
        return <Navigate to={`/console/${safeTab}${search}`} replace />;
    }

    if (!isAdmin && !PERSONAL_TAB_KEYS.has(normalizedSubpath)) {
        return <Navigate to="/console/user-overview" replace />;
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
        },
        {
            key: "user-dashboard",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <BarChart3 className="size-4" />
                    {t("admin.nav.dashboard")}
                </span>
            ),
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
        },
        {
            key: "profile",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <UserCheck className="size-4" />
                    {t("admin.nav.profile")}
                </span>
            ),
        },
        {
            key: "my-media",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <FolderKanban className="size-4" />
                    {t("admin.nav.myMedia")}
                </span>
            ),
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
        },
        {
            key: "dashboard",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <BarChart3 className="size-4" />
                    {t("admin.nav.dashboard")}
                </span>
            ),
        },
        {
            key: "usage-logs",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <ScrollText className="size-4" />
                    {t("admin.nav.usageLogs")}
                </span>
            ),
        },
        {
            key: "channels",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <Cpu className="size-4" />
                    {t("admin.channelsTab.tabLabel")}
                </span>
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
        },
        {
            key: "redeem-codes",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <Gift className="size-4" />
                    {t("admin.redeemTab.tabLabel")}
                </span>
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
        },
        {
            key: "storage",
            label: (
                <span className="inline-flex items-center gap-1.5">
                    <HardDrive className="size-4" />
                    {t("admin.storageTab.tabLabel")}
                </span>
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
                },
                {
                    key: "settings-invite",
                    label: (
                        <span className="inline-flex items-center gap-1.5">
                            <Gift className="size-3.5" />
                            {t("admin.settingsTab.invite.tab")}
                        </span>
                    ),
                    pageTitle: t("admin.settingsTab.invite.pageTitle"),
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
                },
            ],
        },
    ];

    const allSections = flattenTabItems(isAdmin ? [...adminTabs, ...personalTabs] : personalTabs);
    const activeSection = allSections.find((item) => item.key === resolvedTab) ?? allSections[0];

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
        navigate(`${basePath}/${key}`);
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
                        selectedKeys={[activeSection?.key || resolvedTab]}
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

                    <div className="w-full min-w-0">
                        <Suspense fallback={<PanelFallback />}>
                            <Outlet />
                        </Suspense>
                    </div>
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
                    selectedKeys={[activeSection?.key || resolvedTab]}
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
