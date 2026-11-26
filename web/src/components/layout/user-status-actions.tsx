import type { CSSProperties } from "react";
import { useState } from "react";
import { App, Dropdown, Modal, Popover, Progress, Spin, Tooltip, type MenuProps, theme as antdTheme } from "antd";
import { AlertTriangle, Coins, HardDrive, Keyboard, Loader2, LogIn, LogOut, Puzzle, Shield, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { NotificationBellModal } from "@/components/layout/notification-bell-modal";
import { changeAppLocale, type AppLocale } from "@/i18n";
import { formatCompactCredits, formatExactCredits } from "@/lib/format-number";
import { formatStoragePair } from "@/lib/image-utils";
import {
    formatCreditAlertCopy,
    formatStorageAlertCopy,
    formatStorageQuotaCaption,
    maxAlertSeverity,
    resolveCreditAlert,
    resolveStorageAlert,
    type AlertSeverity,
} from "@/lib/quota-alerts";
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

function PopoverAlertStrip({ level, text }: { level: Exclude<AlertSeverity, "none">; text: string }) {
    const { token } = antdTheme.useToken();
    const isError = level === "error";
    return (
        <div
            className="mt-1.5 flex items-start gap-1.5 rounded-md border px-2 py-1 text-[11px] leading-4"
            style={{
                backgroundColor: isError ? token.colorErrorBg : token.colorWarningBg,
                borderColor: isError ? token.colorErrorBorder : token.colorWarningBorder,
                color: isError ? token.colorErrorText : token.colorWarningText,
            }}
        >
            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            <span>{text}</span>
        </div>
    );
}

export function UserStatusActions({ variant = "default", onOpenShortcuts, onOpenPlugins }: UserStatusActionsProps) {
    const { i18n, t } = useTranslation();
    const { message } = App.useApp();
    const { token } = antdTheme.useToken();
    const navigate = useNavigate();
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const user = useUserStore((state) => state.user);
    const accessToken = useUserStore((state) => state.accessToken);
    const refreshToken = useUserStore((state) => state.refreshToken);
    const userLoading = useUserStore((state) => state.userLoading);
    const userLoaded = useUserStore((state) => state.userLoaded);
    const clearSession = useUserStore((state) => state.clearSession);

    const [walletOpen, setWalletOpen] = useState(false);

    const profilePending = Boolean(user && ((userLoading && !userLoaded) || typeof user.creditBalance !== "number"));
    const sessionPending = Boolean(!user && (accessToken || refreshToken) && userLoading);
    const usedBytes = user?.storageUsedBytes ?? 0;
    const quotaBytes = user?.storageQuotaBytes ?? 0;
    const storagePercent = quotaBytes > 0 ? Math.min(100, Math.round((usedBytes / quotaBytes) * 100)) : usedBytes > 0 ? 100 : 0;
    const locale = i18n.resolvedLanguage as AppLocale;
    const creditAlert = profilePending ? { level: "none" as const } : resolveCreditAlert(user?.creditBalance, user?.lowBalanceThreshold);
    const storageAlert = profilePending
        ? { level: "none" as const, expired: false, expiringSoon: false, overQuota: false }
        : resolveStorageAlert({
              usedBytes,
              quotaBytes,
              expiresAt: user?.storageQuotaExpiresAt,
              expiringAt: user?.storageExpiringAt,
              expiringBytes: user?.storageExpiringBytes,
              remainingAfterExpiryBytes: user?.storageRemainingAfterExpiryBytes,
              expiringWillExceed: user?.storageExpiringWillExceed,
              warningDays: user?.storageWarningDays,
          });
    const creditAlertCopy = profilePending ? null : formatCreditAlertCopy(t, creditAlert);
    const storageAlertCopy = profilePending ? null : formatStorageAlertCopy(t, storageAlert, locale);
    const topAlertSeverity = maxAlertSeverity(creditAlert.level, storageAlert.level);

    const canvasTheme = canvasThemes[theme];
    const naturalIconClass = "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-stone-600 transition-colors hover:bg-black/5 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white [&_svg]:size-4";
    const iconStyle: CSSProperties | undefined = variant === "canvas" ? { color: canvasTheme.node.text } : undefined;
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
                  label: profilePending
                      ? t("topNav.walletItemLoading")
                      : t("topNav.walletItem", { balance: formatCompactCredits(user.creditBalance ?? 0) }),
                  onClick: () => setWalletOpen(true),
              },
              {
                  key: "storage-quota",
                  icon: <HardDrive className="size-4" />,
                  label: profilePending
                      ? t("topNav.storageItemLoading")
                      : t("topNav.storageItem", { pair: formatStoragePair(user.storageUsedBytes, user.storageQuotaBytes) }),
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
                          .finally(() =>
                              authApi.logout().finally(() => {
                                  clearSession();
                                  message.success(t("topNav.loggedOut"));
                              }),
                          );
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
                            <div className="w-64 space-y-3 py-0.5">
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
                                    <div
                                        className="mt-1 text-base font-semibold tabular-nums"
                                        style={{
                                            color:
                                                creditAlert.level === "error"
                                                    ? token.colorError
                                                    : creditAlert.level === "warning"
                                                      ? token.colorWarningText
                                                      : token.colorText,
                                        }}
                                    >
                                        {profilePending ? (
                                            <span className="inline-flex items-center gap-1.5 text-xs font-normal" style={{ color: token.colorTextSecondary }}>
                                                <Spin size="small" />
                                                <span>{t("topNav.loading")}</span>
                                            </span>
                                        ) : (
                                            formatExactCredits(user.creditBalance ?? 0)
                                        )}
                                    </div>
                                    {creditAlertCopy && creditAlert.level !== "none" ? (
                                        <PopoverAlertStrip level={creditAlert.level} text={creditAlertCopy.short} />
                                    ) : null}
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
                                        {profilePending ? t("topNav.loading") : formatStoragePair(user.storageUsedBytes, user.storageQuotaBytes)}
                                    </div>
                                    <Progress
                                        percent={storagePercent}
                                        size="small"
                                        showInfo={false}
                                        status={storageAlert.level === "error" ? "exception" : "normal"}
                                        strokeColor={storageAlert.expiringSoon ? token.colorWarning : undefined}
                                        className="!my-1"
                                    />
                                    <div
                                        className="text-[11px]"
                                        style={{
                                            color: storageAlert.expired
                                                ? token.colorError
                                                : storageAlert.expiringSoon
                                                  ? token.colorWarningText
                                                  : token.colorTextTertiary,
                                        }}
                                    >
                                        {formatStorageQuotaCaption(
                                            t,
                                            {
                                                expired: storageAlert.expired,
                                                expiresAt: user.storageQuotaExpiresAt,
                                                permanentBytes: user.storagePermanentBytes,
                                                timedBytes: user.storageTimedBytes,
                                                timedExpiresAt: user.storageTimedExpiresAt,
                                            },
                                            locale,
                                        )}
                                    </div>
                                    {storageAlertCopy && storageAlert.level !== "none" ? (
                                        <PopoverAlertStrip level={storageAlert.level} text={storageAlertCopy.short} />
                                    ) : null}
                                </div>
                            </div>
                        }
                    >
                        <button
                            type="button"
                            className="hidden h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-xs font-medium tabular-nums text-stone-700 transition-colors hover:bg-black/5 hover:text-stone-950 sm:inline-flex dark:text-stone-200 dark:hover:bg-white/10 dark:hover:text-white"
                            style={
                                topAlertSeverity === "none"
                                    ? undefined
                                    : {
                                          backgroundColor: topAlertSeverity === "error" ? token.colorErrorBg : token.colorWarningBg,
                                          color: topAlertSeverity === "error" ? token.colorError : token.colorWarningText,
                                      }
                            }
                            onClick={() => setWalletOpen(true)}
                        >
                            {profilePending ? (
                                <Loader2 className="size-3.5 shrink-0 animate-spin" />
                            ) : (
                                <Coins className="size-3.5 shrink-0" />
                            )}
                            <span>
                                {profilePending
                                    ? t("topNav.creditsLoadingBadge")
                                    : t("topNav.creditsBadge", { balance: formatCompactCredits(user.creditBalance ?? 0) })}
                            </span>
                            {topAlertSeverity !== "none" ? (
                                <span
                                    className="size-1.5 shrink-0 rounded-full"
                                    style={{ backgroundColor: topAlertSeverity === "error" ? token.colorError : token.colorWarning }}
                                />
                            ) : null}
                        </button>
                    </Popover>
                ) : sessionPending && variant === "default" ? (
                    <span className="hidden h-7 items-center gap-1 px-2 text-xs text-stone-500 sm:inline-flex dark:text-stone-400">
                        <Loader2 className="size-3.5 animate-spin" />
                        <span>{t("topNav.creditsLoadingBadge")}</span>
                    </span>
                ) : null}
                {onOpenShortcuts ? (
                    <button type="button" className={naturalIconClass} style={iconStyle} onClick={onOpenShortcuts} aria-label={t("topNav.shortcuts")} title={t("topNav.shortcuts")}>
                        <Keyboard className="size-4" />
                    </button>
                ) : null}
                {user ? (
                    <Dropdown menu={{ items: accountMenuItems }} trigger={["click"]} placement="bottomRight">
                        <button
                            type="button"
                            className={naturalIconClass}
                            style={iconStyle}
                            aria-label={user.displayName || user.username}
                            title={
                                profilePending
                                    ? `${user.displayName || user.username} · ${t("topNav.loading")}`
                                    : t("topNav.creditsTooltip", {
                                          name: user.displayName || user.username,
                                          balance: formatExactCredits(user.creditBalance ?? 0),
                                      })
                            }
                        >
                            <User className="size-4" />
                        </button>
                    </Dropdown>
                ) : sessionPending ? (
                    <span className={naturalIconClass} style={iconStyle} title={t("topNav.loading")}>
                        <Loader2 className="size-4 animate-spin" />
                    </span>
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
