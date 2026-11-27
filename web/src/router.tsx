import { Suspense, lazy } from "react";
import { Spin } from "antd";
import { createBrowserRouter, Navigate, Outlet, useLocation, type RouteObject } from "react-router-dom";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import UserLayout from "@/layouts/user-layout";
import AuthPage from "@/pages/auth";
import HomePage from "@/pages/home";
import NotFound from "@/pages/not-found";
import { useUserStore } from "@/stores/use-user-store";

const AdminPage = lazy(() => import("@/pages/admin"));
const AdminOverviewPanel = lazy(() => import("@/pages/admin/components/overview").then((m) => ({ default: m.AdminOverviewPanel })));
const AnalyticsDashboardPanel = lazy(() => import("@/pages/admin/components/dashboard").then((m) => ({ default: m.AnalyticsDashboardPanel })));
const AdminChannelsPanel = lazy(() => import("@/pages/admin/components/channels").then((m) => ({ default: m.AdminChannelsPanel })));
const AdminUsersPanel = lazy(() => import("@/pages/admin/components/users").then((m) => ({ default: m.AdminUsersPanel })));
const AdminRedeemCodesPanel = lazy(() => import("@/pages/admin/components/redeem-codes").then((m) => ({ default: m.AdminRedeemCodesPanel })));
const AdminMediaMonitorPanel = lazy(() => import("@/pages/admin/components/media").then((m) => ({ default: m.AdminMediaMonitorPanel })));
const AdminStorageSettingsPanel = lazy(() => import("@/pages/admin/components/storage").then((m) => ({ default: m.AdminStorageSettingsPanel })));
const AdminSystemSettingsPanel = lazy(() =>
    import("@/pages/admin/components/system-settings").then((m) => ({ default: m.AdminSystemSettingsPanel })),
);
const AdminAnnouncementsPanel = lazy(() =>
    import("@/pages/admin/components/announcements").then((m) => ({ default: m.AdminAnnouncementsPanel })),
);
const UserOverviewPanel = lazy(() => import("@/pages/admin/user/overview").then((m) => ({ default: m.UserOverviewPanel })));
const ProfileSecurityPanel = lazy(() => import("@/pages/admin/user/profile").then((m) => ({ default: m.ProfileSecurityPanel })));
const MyWalletPanel = lazy(() => import("@/pages/admin/user/wallet-and-logs").then((m) => ({ default: m.MyWalletPanel })));
const UsageLogsPanel = lazy(() => import("@/pages/admin/user/wallet-and-logs").then((m) => ({ default: m.UsageLogsPanel })));
const MyMediaPanel = lazy(() => import("@/pages/admin/user/my-media").then((m) => ({ default: m.MyMediaPanel })));
const AppConfigPanel = lazy(() => import("@/components/layout/app-config-modal").then((m) => ({ default: m.AppConfigPanel })));

const AssetsPage = lazy(() => import("@/pages/assets"));
const CanvasPage = lazy(() => import("@/pages/canvas"));
const CanvasProjectPage = lazy(() => import("@/pages/canvas/project"));
const ImagePage = lazy(() => import("@/pages/image"));
const PromptsPage = lazy(() => import("@/pages/prompts"));
const ResultsPage = lazy(() => import("@/pages/results"));
const VideoPage = lazy(() => import("@/pages/video"));

const adminChildRoutes: RouteObject[] = [
    { index: true, element: null },
    { path: "overview", element: <AdminOverviewPanel /> },
    { path: "dashboard", element: <AnalyticsDashboardPanel scope="all" /> },
    { path: "usage-logs", element: <UsageLogsPanel /> },
    { path: "channels", element: <AdminChannelsPanel /> },
    { path: "users", element: <AdminUsersPanel /> },
    { path: "redeem-codes", element: <AdminRedeemCodesPanel /> },
    { path: "media", element: <AdminMediaMonitorPanel /> },
    { path: "storage", element: <AdminStorageSettingsPanel /> },
    { path: "settings-auth", element: <AdminSystemSettingsPanel section="auth" /> },
    { path: "settings-invite", element: <AdminSystemSettingsPanel section="invite" /> },
    { path: "settings-mail", element: <AdminSystemSettingsPanel section="mail" /> },
    { path: "settings-webdav", element: <AdminSystemSettingsPanel section="webdav" /> },
    { path: "settings-storage-expiry", element: <AdminSystemSettingsPanel section="storage-expiry" /> },
    { path: "settings-announcements", element: <AdminAnnouncementsPanel /> },
    { path: "settings-analytics", element: <AdminSystemSettingsPanel section="analytics" /> },
    { path: "user-overview", element: <UserOverviewPanel /> },
    { path: "user-dashboard", element: <AnalyticsDashboardPanel scope="self" /> },
    { path: "wallet", element: <MyWalletPanel /> },
    { path: "profile", element: <ProfileSecurityPanel /> },
    { path: "my-media", element: <MyMediaPanel /> },
    { path: "config", element: <AppConfigPanel /> },
    { path: "*", element: null },
];

function RouteFallback() {
    return (
        <div className="flex min-h-[50vh] w-full items-center justify-center">
            <Spin size="large" />
        </div>
    );
}

function RequireAuth() {
    const location = useLocation();
    const user = useUserStore((state) => state.user);
    const accessToken = useUserStore((state) => state.accessToken);
    const refreshToken = useUserStore((state) => state.refreshToken);

    if (!user || (!accessToken && !refreshToken)) {
        const redirect = `${location.pathname}${location.search}${location.hash}`;
        return <Navigate to={`/auth?redirect=${encodeURIComponent(redirect)}`} replace />;
    }
    return <Outlet />;
}

export const router = createBrowserRouter([
    {
        element: (
            <UserLayout>
                <AnalyticsTracker />
                <Suspense fallback={<RouteFallback />}>
                    <Outlet />
                </Suspense>
            </UserLayout>
        ),
        children: [
            { path: "/", element: <HomePage /> },
            { path: "/prompts", element: <PromptsPage /> },
            { path: "/auth", element: <AuthPage /> },
            {
                element: <RequireAuth />,
                children: [
                    { path: "/image", element: <ImagePage /> },
                    { path: "/video", element: <VideoPage /> },
                    { path: "/results", element: <ResultsPage /> },
                    { path: "/assets", element: <AssetsPage /> },
                    { path: "/canvas", element: <CanvasPage /> },
                    { path: "/canvas/:id", element: <CanvasProjectPage /> },
                    { path: "/config", element: <Navigate to="/console/config" replace /> },
                    { path: "/console", element: <AdminPage />, children: adminChildRoutes },
                    { path: "/admin", element: <AdminPage />, children: adminChildRoutes },
                ],
            },
        ],
    },
    { path: "*", element: <NotFound /> },
]);
