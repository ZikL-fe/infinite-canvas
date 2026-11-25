import type { CSSProperties } from "react";
import { useState } from "react";
import { Dropdown, Modal, Popover, Progress, Tooltip, type MenuProps, theme as antdTheme } from "antd";
import { Coins, HardDrive, Keyboard, LogIn, LogOut, Puzzle, Shield, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { NotificationBellModal } from "@/components/layout/notification-bell-modal";
import { changeAppLocale, type AppLocale } from "@/i18n";
import { formatCompactCredits, formatExactCredits } from "@/lib/format-number";
import { formatStoragePair } from "@/lib/image-utils";
import { canvasThemes } from "@/lib/canvas-theme";
import { MyWalletPanel } from "@/pages/admin/user-panels";
import { authApi } from "@/services/api/server";
import { flushPendingCanvasSyncs } from "@/services/cloud-sync";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";

type UserStatusActionsProps = {
    variant?: "default" | "canvas";
    onOpenShortcuts?: () => void;
    onOpenPlugins?: () => void;
};

export function UserStatusActions({ variant = "default", onOpenShortcuts, onOpenPlugins }: UserStatusActionsProps) {
    const { i18n, t } = useTranslation();
    const { token } = antdTheme.useToken();
    const navigate = useNavigate();
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const user = useUserStore((state) => state.user);
    const clearSession = useUserStore((state) => state.clearSession);

    const [walletOpen, setWalletOpen] = useState(false);

    const usedBytes = user?.storageUsedBytes ?? 0;
    const quotaBytes = user?.storageQuotaBytes ?? 0;
    const storagePercent = quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : usedBytes > 0 ? 100 : 0;
    const storageExpired = Boolean(user?.storageQuotaExpiresAt && new Date(user.storageQuotaExpiresAt).getTime() <= Date.now());
    const storageOverLimit = storageExpired || (quotaBytes > 0 && usedBytes >= quotaBytes);

    const canvasTheme = canvasThemes[theme];
    const naturalIconClass = "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-stone-600 transition-colors hover:bg-black/5 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white [&_svg]:size-4";
    const iconStyle: CSSProperties | undefined = variant === "canvas" ? { color: canvasTheme.node.text } : undefined;
    const locale = i18n.resolvedLanguage as AppLocale;
    const nextLocale = locale === "zh-CN" ? "en-US" : "zh-CN";
    const languageLabel = t("topNav.switchLanguage", { language: t(nextLocale === "zh-CN" ? "locale.zhCN" : "locale.enUS") });

    const accountMenuItems: MenuProps["items"] = user
        ? [
              {
                  key: "profile",
                  disabled: true,
                  label: `${user.displayName || user.username} (${user.role === "admin" ? t("topNav.roleAdmin") : t("topNav.roleUser")})`,
              },
              {
                  key: "credits",
                  icon: <Coins className="size-4" />,
                  label: t("topNav.walletItem", { balance: formatCompactCredits(user.creditBalance ?? 0) }),
                  onClick: () => setWalletOpen(true),
              },
              {
                  key: "storage-quota",
                  icon: <HardDrive className="size-4" />,
                  label: t("topNav.storageItem", { pair: formatStoragePair(user.storageUsedBytes, user.storageQuotaBytes) }),
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
                <NotificationBellModal className={naturalIconClass} style={iconStyle} />
                <Tooltip title={languageLabel} mouseEnterDelay={0.2}>
                    <button type="button" className={`${naturalIconClass} text-[11px] font-semibold tracking-tight`} style={iconStyle} onClick={() => void changeAppLocale(nextLocale)} aria-label={languageLabel}>
                        {locale === "zh-CN" ? "中" : "EN"}
                    </button>
                </Tooltip>
                <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className={naturalIconClass} style={iconStyle} aria-label={t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme")} title={t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme")} />
                {user && variant === "default" ? (
                    <Popover
                        trigger="hover"
                        placement="bottomRight"
                        arrow={false}
                        content={
                            <div className="w-60 space-y-3 py-0.5">
                                <div>
                                    <div className="flex items-center justify-between text-xs" style={{ color: token.colorTextSecondary }}>
                                        <span className="inline-flex items-center gap-1.5">
                                            <Coins className="size-3.5" />
                                            {t("topNav.creditBalance")}
                                        </span>
                                        <button
                                            type="button"
                                            className="cursor-pointer bg-transparent p-0 text-xs transition-opacity hover:opacity-80"
                                            style={{ color: token.colorPrimary }}
                                            onClick={() => setWalletOpen(true)}
                                        >
                                            {t("topNav.wallet")}
                                        </button>
                                    </div>
                                    <div className="mt-1 text-base font-semibold tabular-nums" style={{ color: token.colorText }}>
                                        {formatExactCredits(user.creditBalance ?? 0)}
                                    </div>
                                </div>
                                <div className="border-t pt-2.5" style={{ borderColor: token.colorBorderSecondary }}>
                                    <div className="flex items-center justify-between text-xs" style={{ color: token.colorTextSecondary }}>
                                        <span className="inline-flex items-center gap-1.5">
                                            <HardDrive className="size-3.5" />
                                            {t("topNav.cloudStorage")}
                                        </span>
                                        <button
                                            type="button"
                                            className="cursor-pointer bg-transparent p-0 text-xs transition-opacity hover:opacity-80"
                                            style={{ color: token.colorPrimary }}
                                            onClick={() => navigate(user.role === "admin" ? "/admin?tab=my-media" : "/console?tab=my-media")}
                                        >
                                            {t("topNav.manage")}
                                        </button>
                                    </div>
                                    <div className="mt-1 text-xs font-medium tabular-nums" style={{ color: token.colorText }}>
                                        {formatStoragePair(user.storageUsedBytes, user.storageQuotaBytes)}
                                    </div>
                                    <Progress percent={storagePercent} size="small" showInfo={false} status={storageOverLimit ? "exception" : "normal"} className="!my-1" />
                                    <div className="text-[11px]" style={{ color: storageExpired ? token.colorError : token.colorTextTertiary }}>
                                        {storageExpired
                                            ? t("topNav.storageExpiredAt", { date: new Date(user.storageQuotaExpiresAt!).toLocaleDateString(locale) })
                                            : user.storageQuotaExpiresAt
                                              ? t("topNav.storageExpiresAt", { date: new Date(user.storageQuotaExpiresAt).toLocaleDateString(locale) })
                                              : t("topNav.storagePermanent")}
                                    </div>
                                </div>
                            </div>
                        }
                    >
                        <button
                            type="button"
                            className="hidden h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-xs font-medium tabular-nums text-stone-700 transition-colors hover:bg-black/5 hover:text-stone-950 sm:inline-flex dark:text-stone-200 dark:hover:bg-white/10 dark:hover:text-white"
                            onClick={() => setWalletOpen(true)}
                        >
                            <Coins className="size-3.5 shrink-0" />
                            <span>{t("topNav.creditsBadge", { balance: formatCompactCredits(user.creditBalance ?? 0) })}</span>
                        </button>
                    </Popover>
                ) : null}
                {onOpenShortcuts ? (
                    <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenShortcuts} aria-label={t("topNav.shortcuts")} title={t("topNav.shortcuts")}>
                        <Keyboard className="size-4" />
                    </button>
                ) : null}
                {user ? (
                    <Dropdown menu={{ items: accountMenuItems }} trigger={["click"]} placement="bottomRight">
                        <button type="button" className={naturalIconClass} style={iconStyle} aria-label={user.displayName || user.username} title={t("topNav.creditsTooltip", { name: user.displayName || user.username, balance: formatExactCredits(user.creditBalance ?? 0) })}>
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

            <Modal open={walletOpen} title={t("topNav.myWalletTitle")} onCancel={() => setWalletOpen(false)} footer={null} width={920} destroyOnHidden>
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
