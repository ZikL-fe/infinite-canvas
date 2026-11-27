import { detectImageMimeFromBlob } from "@/lib/image-utils";

export const CANVAS_IMAGE_PREVIEW_MAX_EDGE = 768;

type ImageSourceChoice = {
    previewUrl?: string;
    originalUrl: string;
    naturalWidth?: number;
    naturalHeight?: number;
    renderedWidth: number;
    renderedHeight: number;
    scale: number;
    devicePixelRatio?: number;
    previewMaxEdge?: number;
    isAnimated?: boolean;
};

/** 判断媒体是否为 GIF 动图（用于列表展示第 1 帧 WebP 缩略图而画布/结果卡保留原图播放动画）。 */
export function isGifImage(mimeType?: string, source?: string): boolean {
    if (mimeType?.toLowerCase().includes("gif")) return true;
    if (!source) return false;
    return source.startsWith("data:image/gif") || /\.gif(?:$|[?#])/i.test(source);
}

// Small previews keep panning cheap, but they look soft once the node is magnified.
// Use the original only when the on-screen size actually needs more pixels than the preview holds.
export function pickImageSource({ previewUrl, originalUrl, naturalWidth, naturalHeight, renderedWidth, renderedHeight, scale, devicePixelRatio = globalThis.devicePixelRatio || 1, previewMaxEdge = CANVAS_IMAGE_PREVIEW_MAX_EDGE, isAnimated = false }: ImageSourceChoice) {
    if (isAnimated) return originalUrl;
    if (!previewUrl) return originalUrl;
    const naturalLongEdge = Math.max(naturalWidth || 0, naturalHeight || 0);
    const previewLongEdge = naturalLongEdge > 0 ? Math.min(previewMaxEdge, naturalLongEdge) : previewMaxEdge;
    const requiredLongEdge = Math.max(renderedWidth, renderedHeight) * scale * devicePixelRatio;
    return requiredLongEdge > previewLongEdge ? originalUrl : previewUrl;
}

export function getThumbnailDimensions(width: number, height: number, maxEdge = CANVAS_IMAGE_PREVIEW_MAX_EDGE) {
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function drawFirstFrameViaImage(blob: Blob, maxEdge: number): Promise<Blob | undefined> {
    if (typeof document === "undefined") return Promise.resolve(undefined);
    const objectUrl = URL.createObjectURL(blob);
    return new Promise<Blob | undefined>((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                const sw = img.naturalWidth;
                const sh = img.naturalHeight;
                if (!sw || !sh) return resolve(undefined);
                const { width, height } = getThumbnailDimensions(sw, sh, maxEdge);
                const canvas = document.createElement("canvas");
                canvas.width = width;
                canvas.height = height;
                const context = canvas.getContext("2d");
                if (!context) return resolve(undefined);
                context.drawImage(img, 0, 0, width, height);
                canvas.toBlob((result) => resolve(result || undefined), "image/webp", 0.86);
            } catch {
                resolve(undefined);
            } finally {
                URL.revokeObjectURL(objectUrl);
            }
        };
        img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            resolve(undefined);
        };
        img.src = objectUrl;
    });
}

export async function createImageThumbnail(
    blob: Blob,
    maxEdge = CANVAS_IMAGE_PREVIEW_MAX_EDGE,
    options?: { forceWebp?: boolean },
): Promise<Blob | undefined> {
    const detectedMime = await detectImageMimeFromBlob(blob, blob.type);
    const isGif = detectedMime === "image/gif";
    const forceWebp = Boolean(options?.forceWebp || isGif);

    try {
        const bitmap = await createImageBitmap(blob);
        try {
            const { width, height } = getThumbnailDimensions(bitmap.width, bitmap.height, maxEdge);
            if (!forceWebp && width === bitmap.width && height === bitmap.height) {
                return undefined;
            }
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext("2d");
            if (!context) return undefined;
            context.drawImage(bitmap, 0, 0, width, height);
            return await new Promise<Blob | undefined>((resolve) => canvas.toBlob((result) => resolve(result || undefined), "image/webp", 0.86));
        } finally {
            bitmap.close();
        }
    } catch {
        return drawFirstFrameViaImage(blob, maxEdge);
    }
}

/** 为云端上传生成轻量缩略图：GIF 强制抽取第 1 帧 WebP（不回退传整张大 GIF），其余图片优先返回更小版本。 */
export async function createCloudImageThumbnail(blob: Blob, maxEdge = 480): Promise<Blob | undefined> {
    const detectedMime = await detectImageMimeFromBlob(blob, blob.type);
    const isGif = detectedMime === "image/gif";
    const thumb = await createImageThumbnail(blob, maxEdge, { forceWebp: isGif || blob.size > 256 * 1024 }).catch(() => undefined);
    if (isGif) return thumb;
    if (thumb && thumb.size < blob.size) return thumb;
    return blob.size <= 2 * 1024 * 1024 ? blob : thumb;
}

export async function createVideoThumbnail(source: Blob | string, maxEdge = 480): Promise<Blob | undefined> {
    if (typeof document === "undefined") return undefined;
    const objectUrl = typeof source === "string" ? "" : URL.createObjectURL(source);
    const src = objectUrl || (typeof source === "string" ? source : "");
    if (!src) return undefined;

    return new Promise<Blob | undefined>((resolve) => {
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.preload = "auto";
        if (!src.startsWith("blob:") && !src.startsWith("data:")) {
            video.crossOrigin = "anonymous";
        }

        let settled = false;
        const finish = (blob?: Blob) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            video.onloadeddata = null;
            video.onseeked = null;
            video.onerror = null;
            video.src = "";
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            resolve(blob);
        };

        const captureFrame = () => {
            try {
                const vw = video.videoWidth;
                const vh = video.videoHeight;
                if (!vw || !vh) return finish(undefined);
                const { width, height } = getThumbnailDimensions(vw, vh, maxEdge);
                const canvas = document.createElement("canvas");
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext("2d");
                if (!ctx) return finish(undefined);
                ctx.drawImage(video, 0, 0, width, height);
                canvas.toBlob((blob) => finish(blob || undefined), "image/webp", 0.82);
            } catch {
                finish(undefined);
            }
        };

        const timer = window.setTimeout(() => finish(undefined), 8000);
        video.onerror = () => finish(undefined);
        video.onloadeddata = () => {
            const seekTarget = Number.isFinite(video.duration) && video.duration > 0.2 ? Math.min(0.2, video.duration * 0.1) : 0;
            if (seekTarget > 0) {
                video.onseeked = captureFrame;
                try {
                    video.currentTime = seekTarget;
                    return;
                } catch {
                    // fall back to immediate capture
                }
            }
            captureFrame();
        };
        video.src = src;
    });
}
