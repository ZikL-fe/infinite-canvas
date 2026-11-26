/** 积分低余额与云端存储即将到期/已满预警判断、混合配额构成描述及统一文案格式化工具。 */
import type { TFunction } from "i18next";

import { formatExactCredits } from "@/lib/format-number";
import { formatBytes } from "@/lib/image-utils";

export type AlertSeverity = "none" | "warning" | "error";

export type CreditAlertState = {
    level: AlertSeverity;
    depleted: boolean;
    low: boolean;
    balance: number;
    threshold: number;
};

export type StorageAlertState = {
    level: AlertSeverity;
    expired: boolean;
    expiringSoon: boolean;
    overQuota: boolean;
    isPartialPackExpiry: boolean;
    expiringWillExceed: boolean;
    expiringBytes: number;
    remainingAfterExpiryBytes: number | null;
    expiringAt: string | null;
    expiresAt: string | null;
    warningDays: number;
    daysLeft: number | null;
    usedBytes: number;
    quotaBytes: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** 根据当前积分与有效预警阈值计算积分预警状态 */
export function resolveCreditAlert(balanceInput?: number | null, thresholdInput?: number | null): CreditAlertState {
    const balance = Number(balanceInput ?? 0);
    const threshold = typeof thresholdInput === "number" && Number.isFinite(thresholdInput) && thresholdInput > 0 ? thresholdInput : 0;
    const depleted = balance <= 0;
    const low = !depleted && threshold > 0 && balance < threshold;
    return {
        level: depleted ? "error" : low ? "warning" : "none",
        depleted,
        low,
        balance,
        threshold,
    };
}

/** 计算云端存储配额是否已过期、即将在预警窗口内到期（含永久+限时组合包）或已满 */
export function resolveStorageAlert(input: {
    usedBytes?: number | null;
    quotaBytes?: number | null;
    expiresAt?: string | null;
    expiringAt?: string | null;
    expiringBytes?: number | null;
    remainingAfterExpiryBytes?: number | null;
    expiringWillExceed?: boolean | null;
    warningDays?: number | null;
    nowMs?: number;
}): StorageAlertState {
    const nowMs = input.nowMs ?? Date.now();
    const usedBytes = Math.max(0, Number(input.usedBytes ?? 0));
    const quotaBytes = Math.max(0, Number(input.quotaBytes ?? 0));
    const expiresAt = input.expiresAt ?? null;
    const warningDays = typeof input.warningDays === "number" && Number.isFinite(input.warningDays) ? Math.max(0, input.warningDays) : 0;

    const expired = Boolean(expiresAt && new Date(expiresAt).getTime() <= nowMs);
    const overQuota = (quotaBytes > 0 && usedBytes >= quotaBytes) || (quotaBytes <= 0 && usedBytes > 0);

    let expiringAt: string | null = null;
    if (!expired) {
        if (input.expiringAt) {
            const ms = new Date(input.expiringAt).getTime();
            if (ms > nowMs) expiringAt = input.expiringAt;
        } else if (expiresAt && warningDays > 0) {
            const ms = new Date(expiresAt).getTime();
            if (ms > nowMs && ms <= nowMs + warningDays * DAY_MS) {
                expiringAt = expiresAt;
            }
        }
    }

    const expiringSoon = Boolean(expiringAt);
    const daysLeft = expiringAt ? Math.max(1, Math.ceil((new Date(expiringAt).getTime() - nowMs) / DAY_MS)) : null;
    const isPartialPackExpiry = Boolean(expiringSoon && !expiresAt);
    const expiringBytes = Math.max(0, Number(input.expiringBytes ?? 0));
    const remainingAfterExpiryBytes =
        typeof input.remainingAfterExpiryBytes === "number" ? Math.max(0, input.remainingAfterExpiryBytes) : null;
    const expiringWillExceed =
        typeof input.expiringWillExceed === "boolean"
            ? input.expiringWillExceed
            : Boolean(expiringSoon && !isPartialPackExpiry);
    const level: AlertSeverity = expired || overQuota ? "error" : expiringSoon ? "warning" : "none";

    return {
        level,
        expired,
        expiringSoon,
        overQuota,
        isPartialPackExpiry,
        expiringWillExceed,
        expiringBytes,
        remainingAfterExpiryBytes,
        expiringAt,
        expiresAt,
        warningDays,
        daysLeft,
        usedBytes,
        quotaBytes,
    };
}

/** 格式化云端存储的有效期构成（兼容全永久、全限时及「永久 + 限时扩容包」混合场景） */
export function formatStorageQuotaCaption(
    t: TFunction,
    input: {
        expired?: boolean;
        expiresAt?: string | null;
        permanentBytes?: number | null;
        timedBytes?: number | null;
        timedExpiresAt?: string | null;
    },
    locale?: string,
) {
    if (input.expired && input.expiresAt) {
        return t("topNav.storageExpiredAt", { date: new Date(input.expiresAt).toLocaleDateString(locale) });
    }
    const perm = Math.max(0, Number(input.permanentBytes ?? 0));
    const timed = Math.max(0, Number(input.timedBytes ?? 0));
    if (perm > 0 && timed > 0 && input.timedExpiresAt) {
        return t("topNav.storageMixedExpiry", {
            permanent: formatBytes(perm, "0 MB"),
            timed: formatBytes(timed, "0 MB"),
            date: new Date(input.timedExpiresAt).toLocaleDateString(locale),
        });
    }
    if (input.expiresAt) {
        return t("topNav.storageExpiresAt", { date: new Date(input.expiresAt).toLocaleDateString(locale) });
    }
    return t("topNav.storagePermanent");
}

/** 生成积分耗尽或低余额预警的国际化标题、详情与顶部徽章短文案。 */
export function formatCreditAlertCopy(t: TFunction, state: CreditAlertState): { title: string; description: string; short: string } | null {
    if (state.level === "none") return null;
    const balance = formatExactCredits(state.balance);
    if (state.depleted) {
        return {
            title: t("quotaAlerts.creditDepletedTitle"),
            description: t("quotaAlerts.creditDepletedDesc", { balance }),
            short: t("quotaAlerts.creditDepletedShort"),
        };
    }
    const threshold = formatExactCredits(state.threshold);
    return {
        title: t("quotaAlerts.creditLowTitle"),
        description: t("quotaAlerts.creditLowDesc", { balance, threshold }),
        short: t("quotaAlerts.creditLowShort", { threshold }),
    };
}

/** 生成云端存储已到期、即将到期（含部分资源包缩容场景）或已满预警的国际化文案。 */
export function formatStorageAlertCopy(
    t: TFunction,
    state: StorageAlertState,
    locale?: string,
): { title: string; description: string; short: string } | null {
    if (state.level === "none") return null;
    if (state.expired) {
        const time = state.expiresAt ? new Date(state.expiresAt).toLocaleString(locale) : "";
        return {
            title: t("quotaAlerts.storageExpiredTitle"),
            description: t("quotaAlerts.storageExpiredDesc", { time }),
            short: t("quotaAlerts.storageExpiredShort"),
        };
    }
    if (state.expiringSoon && state.expiringAt) {
        const target = new Date(state.expiringAt);
        const date = target.toLocaleDateString(locale);
        const time = target.toLocaleString(locale);
        const days = state.daysLeft ?? 1;
        if (state.isPartialPackExpiry) {
            const expiringSize = state.expiringBytes > 0 ? formatBytes(state.expiringBytes, "0 MB") : "";
            const remaining =
                state.remainingAfterExpiryBytes !== null ? formatBytes(state.remainingAfterExpiryBytes, "0 MB") : "";
            if (state.expiringWillExceed) {
                return {
                    title: t("quotaAlerts.packExpiringTitle"),
                    description: t("quotaAlerts.packExpiringDesc", { time, days, expiringSize, remaining }),
                    short: t("quotaAlerts.packExpiringShort", { date, days, expiringSize }),
                };
            }
            return {
                title: t("quotaAlerts.packExpiringTitle"),
                description: t("quotaAlerts.packExpiringShrinkDesc", { time, days, expiringSize, remaining }),
                short: t("quotaAlerts.packExpiringShrinkShort", { date, days, expiringSize, remaining }),
            };
        }
        return {
            title: t("quotaAlerts.storageExpiringTitle"),
            description: t("quotaAlerts.storageExpiringDesc", { time, days }),
            short: t("quotaAlerts.storageExpiringShort", { date, days }),
        };
    }
    if (state.overQuota) {
        return {
            title: t("quotaAlerts.storageFullTitle"),
            description: t("quotaAlerts.storageFullDesc"),
            short: t("quotaAlerts.storageFullShort"),
        };
    }
    return null;
}

/** 合并两个告警等级，返回更高的严重级别（error > warning > none）。 */
export function maxAlertSeverity(a: AlertSeverity, b: AlertSeverity): AlertSeverity {
    if (a === "error" || b === "error") return "error";
    if (a === "warning" || b === "warning") return "warning";
    return "none";
}
