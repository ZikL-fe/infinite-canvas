import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

/** 画布进入与恢复阶段的全屏骨架加载壳，遵循当前画布主题。 */
export function CanvasRefreshShell({ message }: { message?: string }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <main
            className="relative h-full min-h-0 overflow-hidden"
            style={{ background: theme.canvas.background, color: theme.node.text }}
        >
            <div
                className="pointer-events-none absolute inset-0 opacity-60"
                style={{
                    backgroundImage: `radial-gradient(circle, ${theme.canvas.dot} 1px, transparent 1px)`,
                    backgroundSize: "28px 28px",
                }}
            />

            <div className="relative z-10 flex h-full w-full flex-col items-center justify-center gap-3.5 px-6 text-center">
                <div
                    className="size-10 animate-spin rounded-full border-2"
                    style={{ borderColor: theme.node.stroke, borderTopColor: theme.node.activeStroke }}
                />
                <span className="text-sm font-medium tracking-wide" style={{ color: theme.node.muted }}>
                    {message || t("canvas.loading")}
                </span>
            </div>

            <div
                className="pointer-events-none absolute bottom-5 left-1/2 z-50 flex h-14 -translate-x-1/2 items-center gap-1 rounded-xl border px-2 opacity-60 shadow-lg backdrop-blur"
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}
                aria-hidden="true"
            >
                {Array.from({ length: 7 }).map((_, index) => (
                    <div key={index} className="size-8 rounded-md bg-current opacity-10" />
                ))}
            </div>

            <div
                className="pointer-events-none absolute bottom-24 left-6 z-50 hidden h-40 w-[240px] rounded-lg border opacity-60 shadow-2xl backdrop-blur-sm sm:block"
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}
                aria-hidden="true"
            >
                <div className="absolute left-7 top-7 h-5 w-12 rounded-sm bg-current opacity-10" />
                <div className="absolute left-28 top-16 h-6 w-16 rounded-sm bg-current opacity-10" />
                <div className="absolute bottom-7 left-16 h-8 w-20 rounded-sm bg-current opacity-10" />
                <div className="absolute inset-5 rounded border border-current opacity-15" />
            </div>

            <div
                className="pointer-events-none absolute bottom-5 left-5 z-50 hidden h-14 w-[260px] items-center gap-2 rounded-xl border px-2 opacity-60 shadow-lg backdrop-blur sm:flex"
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border }}
                aria-hidden="true"
            >
                <div className="size-8 rounded-md bg-current opacity-10" />
                <div className="size-8 rounded-md bg-current opacity-10" />
                <div className="h-1 flex-1 rounded-full bg-current opacity-10" />
                <div className="h-4 w-10 rounded bg-current opacity-10" />
                <div className="size-8 rounded-md bg-current opacity-10" />
            </div>
        </main>
    );
}
