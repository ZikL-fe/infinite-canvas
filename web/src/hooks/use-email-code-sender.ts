/** 邮箱验证码发送与倒计时 Hook：统一处理防重复点击、60 秒冷却倒计时与结果提示。 */
import { useCallback, useEffect, useState } from "react";
import { App } from "antd";

export function useEmailCodeSender() {
    const { message } = App.useApp();
    const [sending, setSending] = useState(false);
    const [cooldown, setCooldown] = useState(0);

    useEffect(() => {
        if (cooldown <= 0) return;
        const timer = window.setInterval(() => {
            setCooldown((prev) => (prev <= 1 ? 0 : prev - 1));
        }, 1000);
        return () => window.clearInterval(timer);
    }, [cooldown]);

    const sendCode = useCallback(
        async (action: () => Promise<{ cooldownSeconds?: number }>, successMsg = "验证码已发送，请查收邮箱") => {
            if (sending || cooldown > 0) return false;
            setSending(true);
            try {
                const res = await action();
                setCooldown(res.cooldownSeconds || 60);
                message.success(successMsg);
                return true;
            } catch (error) {
                message.error(error instanceof Error ? error.message : "发送验证码失败");
                return false;
            } finally {
                setSending(false);
            }
        },
        [cooldown, message, sending],
    );

    const resetCooldown = useCallback(() => setCooldown(0), []);

    return { sending, cooldown, sendCode, resetCooldown };
}
