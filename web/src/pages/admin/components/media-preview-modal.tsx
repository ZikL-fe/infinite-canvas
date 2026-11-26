/** 管理后台与个人中心通用的云端媒体预览弹窗（支持图片/视频/音频预览与带加载反馈的原文件下载）。 */
import { useState } from "react";
import { App, Button, Image, Modal, Space } from "antd";
import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";

import { storageApi, type MediaItem } from "@/services/api/server";

type MediaPreviewModalProps = {
    media: MediaItem | null;
    onClose: () => void;
};

export function MediaPreviewModal({ media, onClose }: MediaPreviewModalProps) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [downloading, setDownloading] = useState(false);

    const handleDownload = async () => {
        if (!media || downloading) return;
        setDownloading(true);
        try {
            await storageApi.downloadFile(media);
        } catch (err) {
            message.error(err instanceof Error ? err.message : t("userPanels.ledgerDetail.downloadFailed"));
        } finally {
            setDownloading(false);
        }
    };

    return (
        <Modal
            open={Boolean(media)}
            title={t("userPanels.myMedia.previewModalTitle")}
            onCancel={onClose}
            width={780}
            destroyOnHidden
            footer={
                <Space wrap>
                    {media ? (
                        <Button icon={<Download className="size-4" />} loading={downloading} onClick={() => void handleDownload()}>
                            {t("common.downloadOriginal")}
                        </Button>
                    ) : null}
                    <Button type="primary" onClick={onClose}>
                        {t("common.close")}
                    </Button>
                </Space>
            }
        >
            {media?.url ? (
                media.kind === "image" ? (
                    <div className="flex justify-center rounded-lg bg-black/5 p-2 dark:bg-white/5">
                        <Image src={media.url} alt={media.objectKey} className="max-h-[70vh] object-contain" />
                    </div>
                ) : media.kind === "video" ? (
                    <video src={media.url} controls autoPlay className="max-h-[70vh] w-full rounded-lg bg-black" />
                ) : media.kind === "audio" ? (
                    <div className="flex justify-center py-6">
                        <audio src={media.url} controls autoPlay className="w-full max-w-md" />
                    </div>
                ) : (
                    <a href={media.url} target="_blank" rel="noreferrer">
                        {t("common.openFileLink")}
                    </a>
                )
            ) : null}
        </Modal>
    );
}
