import { Suspense, lazy } from "react";
import { Spin } from "antd";
import { createBrowserRouter, Navigate, Outlet, useLocation } from "react-router-dom";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import UserLayout from "@/layouts/user-layout";
import AuthPage from "@/pages/auth";
import HomePage from "@/pages/home";
import NotFound from "@/pages/not-found";
import { useUserStore } from "@/stores/use-user-store";

const AdminPage = lazy(() => import("@/pages/admin"));
const AssetsPage = lazy(() => import("@/pages/assets"));
const CanvasPage = lazy(() => import("@/pages/canvas"));
const CanvasProjectPage = lazy(() => import("@/pages/canvas/project"));
const ImagePage = lazy(() => import("@/pages/image"));
const PromptsPage = lazy(() => import("@/pages/prompts"));
const ResultsPage = lazy(() => import("@/pages/results"));
const VideoPage = lazy(() => import("@/pages/video"));

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
                    { path: "/config", element: <Navigate to="/console?tab=config" replace /> },
                    { path: "/console", element: <AdminPage /> },
                    { path: "/admin", element: <AdminPage /> },
                ],
            },
        ],
    },
    { path: "*", element: <NotFound /> },
]);
