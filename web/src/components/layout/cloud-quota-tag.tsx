import { Tag } from "antd";
import { HardDrive } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { formatStoragePair } from "@/lib/image-utils";
import { useUserStore } from "@/stores/use-user-store";

/** 工作台标题下方的云端存储配额标签，点击跳转到云端媒体管理。 */
export function CloudQuotaTag() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const user = useUserStore((state) => state.user);
    if (!user) return null;

    const expired = Boolean(user.storageQuotaExpiresAt && new Date(user.storageQuotaExpiresAt).getTime() <= Date.now());
    const exceeded = expired || (user.storageQuotaBytes ?? 0) <= 0 || (user.storageUsedBytes ?? 0) >= (user.storageQuotaBytes ?? 0);

    return (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Tag
                color={exceeded ? "red" : "blue"}
                className="m-0 cursor-pointer"
                onClick={() => navigate(user.role === "admin" ? "/admin?tab=my-media" : "/console?tab=my-media")}
            >
                <span className="inline-flex items-center gap-1">
                    <HardDrive className="size-3" />
                    {t("cloud.quotaTag", { pair: formatStoragePair(user.storageUsedBytes, user.storageQuotaBytes) })}
                    {expired ? t("cloud.quotaExpiredSuffix") : exceeded ? t("cloud.quotaExpandSuffix") : ""}
                </span>
            </Tag>
        </div>
    );
}
