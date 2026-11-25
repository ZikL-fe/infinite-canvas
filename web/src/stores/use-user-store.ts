/** 全局用户会话与引导状态 Store：持久化登录令牌与当前登录用户信息。 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type UserRole = "admin" | "user";
export type UserStatus = "active" | "disabled";

export type LocalUser = {
    id: string;
    username: string;
    email?: string | null;
    emailVerifiedAt?: string | null;
    displayName: string;
    avatarUrl: string;
    role: UserRole;
    status: UserStatus;
    storageUsedBytes: number;
    storageQuotaBytes?: number;
    storageQuotaExpiresAt?: string | null;
    lowBalanceThreshold?: number | null;
    storageWarningDays?: number;
    storageExpiringAt?: string | null;
    creditBalance?: number;
    createdAt?: string;
};

export type BootstrapStatus = {
    initialized: boolean;
    allowRegister: boolean;
    requireEmailOnRegister?: boolean;
    emailEnabled?: boolean;
};

type UserStore = {
    user: LocalUser | null;
    accessToken: string;
    refreshToken: string;
    bootstrapStatus: BootstrapStatus | null;
    setSession: (payload: { user: LocalUser; accessToken: string; refreshToken: string }) => void;
    setTokens: (payload: { accessToken: string; refreshToken: string }) => void;
    setUser: (user: LocalUser | null) => void;
    setBootstrapStatus: (status: BootstrapStatus) => void;
    clearSession: () => void;
};

export const useUserStore = create<UserStore>()(
    persist(
        (set) => ({
            user: null,
            accessToken: "",
            refreshToken: "",
            bootstrapStatus: null,
            setSession: ({ user, accessToken, refreshToken }) => set({ user, accessToken, refreshToken }),
            setTokens: ({ accessToken, refreshToken }) => set({ accessToken, refreshToken }),
            setUser: (user) => set({ user }),
            setBootstrapStatus: (bootstrapStatus) => set({ bootstrapStatus }),
            clearSession: () => set({ user: null, accessToken: "", refreshToken: "" }),
        }),
        {
            name: "infinite-canvas:user_session",
            partialize: (state) => ({
                user: state.user,
                accessToken: state.accessToken,
                refreshToken: state.refreshToken,
            }),
        },
    ),
);
