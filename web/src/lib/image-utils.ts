import i18n from "@/i18n";
import type { ReferenceImage } from "@/types/image";

export function formatBytes(bytes: number, zeroFallback = "") {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return zeroFallback;
    }
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

/** 读取媒体元数据中记录的缩略图字节数。 */
export function getMediaThumbBytes(meta?: Record<string, unknown> | null): number {
    const raw = Number(meta?.thumbBytes ?? 0);
    return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
}

/** 计算云端媒体（原文件 + 缩略图）合计占用的字节数。 */
export function getMediaTotalBytes(bytes: number, meta?: Record<string, unknown> | null): number {
    return Math.max(0, Number(bytes || 0)) + getMediaThumbBytes(meta);
}

/** 格式化存储用量与配额，无用量或无配额时统一显示为 `0 MB`。 */
export function formatStoragePair(usedBytes?: number | null, quotaBytes?: number | null) {
    return `${formatBytes(usedBytes ?? 0, "0 MB")} / ${formatBytes(quotaBytes ?? 0, "0 MB")}`;
}

export function formatDuration(ms: number) {
    const value = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(value / 60);
    const seconds = value % 60;
    return minutes ? i18n.t("common.durationMinutes", { minutes, seconds: String(seconds).padStart(2, "0") }) : i18n.t("common.durationSeconds", { seconds });
}

export function getDataUrlByteSize(dataUrl: string) {
    const base64 = dataUrl.split(",", 2)[1];
    if (!base64) {
        return 0;
    }
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export function readFileAsDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(i18n.t("common.imageReadFailed")));
        reader.readAsDataURL(file);
    });
}

export function readImageMeta(dataUrl: string) {
    return new Promise<{ width: number; height: number; mimeType: string }>((resolve) => {
        const image = new Image();
        const done = () => resolve({ width: image.naturalWidth || 1024, height: image.naturalHeight || 1024, mimeType: dataUrl.match(/^data:([^;]+)/)?.[1] || "image/png" });
        image.onload = done;
        image.onerror = done;
        setTimeout(done, 3000);
        image.src = dataUrl;
    });
}

export function dataUrlToFile(image: ReferenceImage) {
    const [header, content] = image.dataUrl.split(",", 2);
    const mimeType = header.match(/data:(.*?);base64/)?.[1] || image.type || "image/png";
    const binary = atob(content || "");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], image.name || "reference.png", { type: mimeType });
}

/** 根据文件头魔数识别常见图片 MIME（GIF / PNG / JPEG / WebP）。 */
export function detectImageMimeFromBytes(bytes: Uint8Array): string | null {
    if (
        bytes.length >= 6 &&
        bytes[0] === 0x47 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x38 &&
        (bytes[4] === 0x37 || bytes[4] === 0x39) &&
        bytes[5] === 0x61
    ) {
        return "image/gif";
    }
    if (
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
    ) {
        return "image/png";
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return "image/jpeg";
    }
    if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
    ) {
        return "image/webp";
    }
    return null;
}

/** 从 Base64 字符串头部解码并识别真实图片 MIME，避免 b64_json 统一硬编码为 image/png。 */
export function detectImageMimeFromBase64(base64: string): string {
    const clean = base64.replace(/\s+/g, "").slice(0, 24);
    try {
        const binary = atob(clean);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }
        return detectImageMimeFromBytes(bytes) || "image/png";
    } catch {
        return "image/png";
    }
}

/** 将原始 Base64 或 dataURL 转换为带真实 MIME 头的 dataURL。 */
export function b64ToDataUrl(raw: string, declaredMime?: string): string {
    if (raw.startsWith("data:")) return raw;
    const mime = declaredMime?.startsWith("image/") ? declaredMime : detectImageMimeFromBase64(raw);
    return `data:${mime};base64,${raw}`;
}

/** 读取 Blob 前 16 字节魔数识别真实图片 MIME（无法识别时回退到 blob.type 或 fallbackMime）。 */
export async function detectImageMimeFromBlob(blob: Blob, fallbackMime = "image/png"): Promise<string> {
    try {
        const buffer = await blob.slice(0, 16).arrayBuffer();
        const detected = detectImageMimeFromBytes(new Uint8Array(buffer));
        if (detected) return detected;
    } catch {
        // ignore slice read failure and fall back to declared mime
    }
    if (blob.type.startsWith("image/")) return blob.type;
    return fallbackMime.startsWith("image/") ? fallbackMime : "image/png";
}

/** 将图片 MIME 类型转换为标准文件扩展名（不含点号）。 */
export function imageExtensionFromMime(mimeType?: string): string {
    const clean = mimeType?.split(";")[0]?.trim().toLowerCase() || "";
    if (clean === "image/gif") return "gif";
    if (clean === "image/webp") return "webp";
    if (clean === "image/jpeg" || clean === "image/jpg") return "jpg";
    if (clean === "image/svg+xml") return "svg";
    if (clean === "image/avif") return "avif";
    if (clean.startsWith("image/")) return clean.slice("image/".length).split("+")[0] || "png";
    return "png";
}

/** 将已有文件名的图片扩展名修正为与真实 MIME 匹配的后缀。 */
export function replaceImageFilenameExtension(filename: string, mimeType: string): string {
    const ext = imageExtensionFromMime(mimeType);
    const dotIndex = filename.lastIndexOf(".");
    if (dotIndex > 0) {
        return `${filename.slice(0, dotIndex)}.${ext}`;
    }
    return `${filename}.${ext}`;
}
