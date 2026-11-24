import { createBrowserRouter, Navigate, Outlet, useLocation } from "react-router-dom";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import UserLayout from "@/layouts/user-layout";
import AdminPage from "@/pages/admin";
import AssetsPage from "@/pages/assets";
import AuthPage from "@/pages/auth";
import CanvasPage from "@/pages/canvas";
import CanvasProjectPage from "@/pages/canvas/project";
import ConfigPage from "@/pages/config";
import HomePage from "@/pages/home";
import ImagePage from "@/pages/image";
import NotFound from "@/pages/not-found";
import PromptsPage from "@/pages/prompts";
import ResultsPage from "@/pages/results";
import VideoPage from "@/pages/video";
import { useUserStore } from "@/stores/use-user-store";

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
                <Outlet />
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
                    { path: "/config", element: <ConfigPage /> },
                    { path: "/console", element: <AdminPage /> },
                    { path: "/admin", element: <AdminPage /> },
                ],
            },
        ],
    },
    { path: "*", element: <NotFound /> },
]);
