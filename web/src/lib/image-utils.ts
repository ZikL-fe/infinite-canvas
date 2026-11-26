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
