/** 应用根初始化组件：启动云同步监听、验证会话、拉取平台运行时渠道并在热更新清空内存渠道时自动补拉。 */
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

import { authApi } from "@/services/api/server";
import { initCloudSyncListeners, syncCloudWorkspace, syncRuntimeSettings } from "@/services/cloud-sync";
import { useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const syncedAuth = useRef(false);
    const emptyChannelsSyncedForToken = useRef("");
    const accessToken = useUserStore((state) => state.accessToken);
    const refreshToken = useUserStore((state) => state.refreshToken);
    const channelsCount = useConfigStore((state) => state.config.channels.length);
    const setBootstrapStatus = useUserStore((state) => state.setBootstrapStatus);
    const setUser = useUserStore((state) => state.setUser);

    usePromptSourceScheduler();

    useEffect(() => {
        initCloudSyncListeners();
        if (syncedAuth.current) return;
        syncedAuth.current = true;
        authApi
            .getBootstrapStatus()
            .then(setBootstrapStatus)
            .catch(() => undefined);
        if (accessToken || refreshToken) {
            void syncRuntimeSettings();
            authApi
                .me()
                .then((res) => {
                    setUser(res.user);
                    void syncCloudWorkspace();
                })
                .catch(() => undefined);
        }
    }, [accessToken, refreshToken, setBootstrapStatus, setUser]);

    useEffect(() => {
        if (!accessToken) {
            emptyChannelsSyncedForToken.current = "";
            return;
        }
        if (channelsCount > 0) {
            emptyChannelsSyncedForToken.current = "";
            return;
        }
        if (emptyChannelsSyncedForToken.current === accessToken) return;
        emptyChannelsSyncedForToken.current = accessToken;
        void syncRuntimeSettings();
    }, [accessToken, channelsCount]);

    return <>{children}</>;
}
