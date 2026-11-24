/** 通用批量打包下载 Hook：顺序/批量获取资源 Blob、自动去重文件名并打包导出为 zip 压缩包。 */
import { App } from "antd";
import { saveAs } from "file-saver";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { createZip } from "@/lib/zip";

export type BatchZipEntry = {
    filename: string;
    loadBlob: () => Promise<Blob | null | undefined>;
};

function sanitizeZipFilename(name: string) {
    return name.replace(/[\\/:*?"<>|]+/g, "_").trim() || "file";
}

function dedupeZipName(rawName: string, usedNames: Set<string>) {
    const clean = sanitizeZipFilename(rawName);
    if (!usedNames.has(clean)) {
        usedNames.add(clean);
        return clean;
    }
    const dotIndex = clean.lastIndexOf(".");
    const base = dotIndex > 0 ? clean.slice(0, dotIndex) : clean;
    const ext = dotIndex > 0 ? clean.slice(dotIndex) : "";
    let index = 2;
    let candidate = `${base}-${index}${ext}`;
    while (usedNames.has(candidate)) {
        index += 1;
        candidate = `${base}-${index}${ext}`;
    }
    usedNames.add(candidate);
    return candidate;
}

export function useBatchZipDownload() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [downloading, setDownloading] = useState(false);

    const downloadZip = async (params: {
        entries: BatchZipEntry[];
        zipFilename: string;
        emptyWarning?: string;
        loadingText?: string;
    }) => {
        if (downloading) return false;
        if (!params.entries.length) {
            message.warning(params.emptyWarning || t("zip.selectItems"));
            return false;
        }
        setDownloading(true);
        const hide = message.loading(params.loadingText || t("zip.packaging", { count: params.entries.length }), 0);
        try {
            const usedNames = new Set<string>();
            const settled = await Promise.all(
                params.entries.map(async (entry) => {
                    try {
                        const blob = await entry.loadBlob();
                        if (!blob || !blob.size) return null;
                        return { name: dedupeZipName(entry.filename, usedNames), data: blob };
                    } catch {
                        return null;
                    }
                }),
            );
            const files = settled.filter((item): item is { name: string; data: Blob } => Boolean(item));
            if (!files.length) {
                message.error(t("zip.failedNoFiles"));
                return false;
            }
            const zipBlob = await createZip(files);
            saveAs(zipBlob, params.zipFilename);
            const failedCount = params.entries.length - files.length;
            if (failedCount > 0) {
                message.warning(t("zip.downloadedPartial", { count: files.length, failed: failedCount }));
            } else {
                message.success(t("zip.downloaded", { count: files.length }));
            }
            return true;
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("zip.failed"));
            return false;
        } finally {
            hide();
            setDownloading(false);
        }
    };

    return { downloading, downloadZip };
}
