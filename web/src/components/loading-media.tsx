/** 通用媒体加载态组件：在图片与视频拉取、解码或缓冲期间展示加载动画，并在加载失败时支持一键重试。 */
import { useLayoutEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

export function MediaLoadBox({ kind = "image", className }: { kind?: "image" | "video"; className?: string }) {
    const { t } = useTranslation();
    return (
        <div className={cn("flex flex-col items-center justify-center gap-2.5 bg-stone-100 px-4 text-center dark:bg-stone-900", className)}>
            <div className="size-7 animate-spin rounded-full border-2 border-stone-300 border-t-stone-800 dark:border-stone-700 dark:border-t-stone-100" />
            <span className="text-[11px] font-medium tracking-wide text-stone-500 dark:text-stone-400">
                {t(kind === "video" ? "canvas.node.loadingVideo" : "canvas.node.loadingImage")}
            </span>
        </div>
    );
}

export function LoadingImage({
    src,
    pending = false,
    alt = "",
    title,
    className,
    containerClassName,
    compact = false,
    loading,
    decoding = "async",
}: {
    src?: string;
    pending?: boolean;
    alt?: string;
    title?: string;
    className?: string;
    containerClassName?: string;
    compact?: boolean;
    loading?: "lazy" | "eager";
    decoding?: "async" | "sync" | "auto";
}) {
    const { t } = useTranslation();
    const imgRef = useRef<HTMLImageElement>(null);
    const loadedKeyRef = useRef("");
    const [reloadCount, setReloadCount] = useState(0);
    const [loadState, setLoadState] = useState<{ key: string; status: "loading" | "loaded" | "error" }>({
        key: "",
        status: "loading",
    });

    const effectiveKey = `${src || ""}:${reloadCount}`;
    const isPending = pending || !src;
    const status = isPending
        ? "loading"
        : loadState.key === effectiveKey
          ? loadState.status
          : loadedKeyRef.current === effectiveKey
            ? "loaded"
            : "loading";

    useLayoutEffect(() => {
        if (isPending) return;
        const img = imgRef.current;
        if (img && img.complete && img.naturalWidth > 0) {
            loadedKeyRef.current = effectiveKey;
            setLoadState((prev) => (prev.key === effectiveKey && prev.status === "loaded" ? prev : { key: effectiveKey, status: "loaded" }));
        }
    }, [effectiveKey, isPending]);

    const handleRetry = (event: { stopPropagation: () => void; preventDefault: () => void }) => {
        event.preventDefault();
        event.stopPropagation();
        loadedKeyRef.current = "";
        setReloadCount((count) => count + 1);
    };

    return (
        <div className={cn("relative overflow-hidden bg-stone-100 dark:bg-stone-900", containerClassName)} title={title}>
            {!isPending ? (
                <img
                    ref={imgRef}
                    key={effectiveKey}
                    src={src}
                    alt={alt}
                    loading={loading}
                    decoding={decoding}
                    onLoad={() => {
                        loadedKeyRef.current = effectiveKey;
                        setLoadState({ key: effectiveKey, status: "loaded" });
                    }}
                    onError={() => {
                        if (loadedKeyRef.current === effectiveKey) return;
                        setLoadState({ key: effectiveKey, status: "error" });
                    }}
                    className={cn(className, "transition-opacity duration-200", status === "loaded" ? "opacity-100" : "opacity-0")}
                />
            ) : null}

            {status === "loading" ? (
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 px-2 text-center">
                    <div
                        className={cn(
                            "animate-spin rounded-full border-2 border-stone-300 border-t-stone-800 dark:border-stone-700 dark:border-t-stone-100",
                            compact ? "size-4" : "size-7",
                        )}
                    />
                    {!compact ? (
                        <span className="text-[11px] font-medium tracking-wide text-stone-500 dark:text-stone-400">
                            {t("canvas.node.loadingImage")}
                        </span>
                    ) : null}
                </div>
            ) : null}

            {status === "error" ? (
                <div
                    className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-stone-100/95 px-2 text-center dark:bg-stone-900/95"
                    onClick={(event) => event.stopPropagation()}
                >
                    {compact ? (
                        <span
                            role="button"
                            tabIndex={0}
                            title={t("canvas.node.mediaLoadFailed")}
                            onClick={handleRetry}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") handleRetry(event);
                            }}
                            className="inline-flex size-6 cursor-pointer items-center justify-center rounded-full border border-stone-300 bg-white text-stone-700 transition hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200 dark:hover:bg-stone-700"
                        >
                            <RefreshCw className="size-3" />
                        </span>
                    ) : (
                        <>
                            <span className="text-xs leading-5 text-stone-500 dark:text-stone-400">{t("canvas.node.mediaLoadFailed")}</span>
                            <span
                                role="button"
                                tabIndex={0}
                                onClick={handleRetry}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter" || event.key === " ") handleRetry(event);
                                }}
                                className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-stone-300 bg-white px-3 text-xs font-medium text-stone-700 transition hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200 dark:hover:bg-stone-700"
                            >
                                <RefreshCw className="size-3.5" />
                                {t("canvas.node.retry")}
                            </span>
                        </>
                    )}
                </div>
            ) : null}
        </div>
    );
}

export function LoadingVideo({
    src,
    pending = false,
    poster,
    autoPlay = false,
    className,
    containerClassName,
}: {
    src?: string;
    pending?: boolean;
    poster?: string;
    autoPlay?: boolean;
    className?: string;
    containerClassName?: string;
}) {
    const { t } = useTranslation();
    const videoRef = useRef<HTMLVideoElement>(null);
    const [reloadCount, setReloadCount] = useState(0);
    const videoKey = `${src || ""}:${reloadCount}`;
    const [state, setState] = useState<{ key: string; ready: boolean; buffering: boolean; error: boolean }>({
        key: videoKey,
        ready: false,
        buffering: false,
        error: false,
    });

    const isPending = pending || !src;
    const isCurrent = state.key === videoKey;
    const ready = !isPending && isCurrent && state.ready;
    const buffering = !isPending && isCurrent && state.buffering;
    const error = !isPending && isCurrent && state.error;

    useLayoutEffect(() => {
        if (isPending) return;
        const video = videoRef.current;
        if (video && video.readyState >= 2) {
            setState((prev) => (prev.key === videoKey && prev.ready ? prev : { key: videoKey, ready: true, buffering: false, error: false }));
        }
    }, [isPending, videoKey]);

    return (
        <div className={cn("relative overflow-hidden bg-black", containerClassName)}>
            {!isPending ? (
                <video
                    key={videoKey}
                    ref={videoRef}
                    src={src}
                    poster={poster}
                    controls
                    autoPlay={autoPlay}
                    onLoadedData={() => setState({ key: videoKey, ready: true, buffering: false, error: false })}
                    onCanPlay={() => setState({ key: videoKey, ready: true, buffering: false, error: false })}
                    onPlaying={() => setState({ key: videoKey, ready: true, buffering: false, error: false })}
                    onWaiting={() => setState((prev) => ({ key: videoKey, ready: prev.key === videoKey ? prev.ready : false, buffering: true, error: false }))}
                    onError={() => setState({ key: videoKey, ready: false, buffering: false, error: true })}
                    className={cn("h-full w-full bg-black object-contain", className)}
                />
            ) : null}

            {error ? (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2.5 bg-stone-950/90 px-4 text-center">
                    <span className="text-xs leading-5 text-stone-300">{t("canvas.node.mediaLoadFailed")}</span>
                    <button
                        type="button"
                        onClick={() => setReloadCount((count) => count + 1)}
                        className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-stone-700 bg-stone-800 px-3 text-xs font-medium text-stone-100 transition hover:bg-stone-700"
                    >
                        <RefreshCw className="size-3.5" />
                        {t("canvas.node.retry")}
                    </button>
                </div>
            ) : !ready || buffering ? (
                <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2.5 bg-black/35 px-4 text-center">
                    <div className="size-7 animate-spin rounded-full border-2 border-white/25 border-t-white" />
                    <span className="text-[11px] font-medium tracking-wide text-stone-200">{t("canvas.node.loadingVideo")}</span>
                </div>
            ) : null}
        </div>
    );
}
