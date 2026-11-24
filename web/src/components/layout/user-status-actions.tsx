import type { CSSProperties } from "react";
import { useState } from "react";
import { Dropdown, Modal, Tooltip, type MenuProps } from "antd";
import { Coins, HardDrive, Keyboard, LogIn, LogOut, Puzzle, Settings2, Shield, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { NotificationBellModal } from "@/components/layout/notification-bell-modal";
import { VersionReleaseModal } from "@/components/layout/version-release-modal";
import { changeAppLocale, type AppLocale } from "@/i18n";
import { formatCompactCredits, formatExactCredits } from "@/lib/format-number";
import { formatStoragePair } from "@/lib/image-utils";
import { canvasThemes } from "@/lib/canvas-theme";
import { MyWalletPanel } from "@/pages/admin/user-panels";
import { authApi } from "@/services/api/server";
import { flushPendingCanvasSyncs } from "@/services/cloud-sync";
import { useConfigStore } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";

type UserStatusActionsProps = {
    showConfig?: boolean;
    variant?: "default" | "canvas";
    onOpenShortcuts?: () => void;
    onOpenPlugins?: () => void;
};

export function UserStatusActions({ showConfig = true, variant = "default", onOpenShortcuts, onOpenPlugins }: UserStatusActionsProps) {
    const { i18n, t } = useTranslation();
    const navigate = useNavigate();
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const user = useUserStore((state) => state.user);
    const clearSession = useUserStore((state) => state.clearSession);

    const [walletOpen, setWalletOpen] = useState(false);

    const canvasTheme = canvasThemes[theme];
    const naturalIconClass = "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-stone-600 transition-colors hover:bg-black/5 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white [&_svg]:size-4";
    const iconStyle: CSSProperties | undefined = variant === "canvas" ? { color: canvasTheme.node.text } : undefined;
    const versionStyle = iconStyle;
    const locale = i18n.resolvedLanguage as AppLocale;
    const nextLocale = locale === "zh-CN" ? "en-US" : "zh-CN";
    const languageLabel = t("topNav.switchLanguage", { language: t(nextLocale === "zh-CN" ? "locale.zhCN" : "locale.enUS") });

    const accountMenuItems: MenuProps["items"] = user
        ? [
              {
                  key: "profile",
                  disabled: true,
                  label: `${user.displayName || user.username}（${user.role === "admin" ? t("topNav.roleAdmin") : t("topNav.roleUser")}）`,
              },
              {
                  key: "credits",
                  icon: <Coins className="size-4" />,
                  label: `积分钱包（余额：${formatCompactCredits(user.creditBalance ?? 0)}）`,
                  onClick: () => setWalletOpen(true),
              },
              {
                  key: "storage-quota",
                  icon: <HardDrive className="size-4" />,
                  label: `云端存储（${formatStoragePair(user.storageUsedBytes, user.storageQuotaBytes)}）`,
                  onClick: () => navigate(user.role === "admin" ? "/admin?tab=my-media" : "/console?tab=my-media"),
              },
              {
                  key: "console",
                  icon: <Shield className="size-4" />,
                  label: user.role === "admin" ? t("topNav.adminConsole") : t("topNav.userConsole"),
                  onClick: () => navigate(user.role === "admin" ? "/admin" : "/console"),
              },
              { type: "divider" as const },
              {
                  key: "logout",
                  icon: <LogOut className="size-4" />,
                  label: t("topNav.logout"),
                  onClick: () => {
                      void flushPendingCanvasSyncs()
                          .catch(() => undefined)
                          .finally(() => authApi.logout().finally(() => clearSession()));
                  },
              },
          ]
        : [];

    return (
        <>
            <div className="inline-flex shrink-0 items-center gap-1">
                {onOpenPlugins ? (
                    <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenPlugins} aria-label={t("topNav.plugins")} title={t("topNav.plugins")}>
                        <Puzzle className="size-4" />
                    </button>
                ) : null}
                {showConfig && user ? (
                    <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => openConfigDialog(false)} aria-label={t("navigation.config")} title={t("navigation.config")}>
                        <Settings2 className="size-4" />
                    </button>
                ) : null}
                <NotificationBellModal className={naturalIconClass} style={iconStyle} />
                <Tooltip title={languageLabel} mouseEnterDelay={0.2}>
                    <button type="button" className={`${naturalIconClass} text-[11px] font-semibold tracking-tight`} style={iconStyle} onClick={() => void changeAppLocale(nextLocale)} aria-label={languageLabel}>
                        {locale === "zh-CN" ? "中" : "EN"}
                    </button>
                </Tooltip>
                <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className={naturalIconClass} style={iconStyle} aria-label={t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme")} title={t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme")} />
                <VersionReleaseModal style={versionStyle} />
                {onOpenShortcuts ? (
                    <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenShortcuts} aria-label={t("topNav.shortcuts")} title={t("topNav.shortcuts")}>
                        <Keyboard className="size-4" />
                    </button>
                ) : null}
                {user ? (
                    <Dropdown menu={{ items: accountMenuItems }} trigger={["click"]} placement="bottomRight">
                        <button type="button" className={naturalIconClass} style={iconStyle} aria-label={user.displayName || user.username} title={`${user.displayName || user.username} · 积分 ${formatExactCredits(user.creditBalance ?? 0)}`}>
                            <User className="size-4" />
                        </button>
                    </Dropdown>
                ) : (
                    <Tooltip title={t("topNav.login")} mouseEnterDelay={0.2}>
                        <button type="button" className={naturalIconClass} style={iconStyle} onClick={() => navigate("/auth")} aria-label={t("topNav.login")}>
                            <LogIn className="size-4" />
                        </button>
                    </Tooltip>
                )}
            </div>

            <Modal open={walletOpen} title="我的积分钱包" onCancel={() => setWalletOpen(false)} footer={null} width={920} destroyOnHidden>
                <MyWalletPanel
                    compact
                    onOpenLogs={() => {
                        setWalletOpen(false);
                        navigate(user?.role === "admin" ? "/admin?tab=usage-logs" : "/console?tab=usage-logs");
                    }}
                />
            </Modal>
        </>
    );
}
