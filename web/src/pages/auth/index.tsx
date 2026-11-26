/** 账号登录与注册页：首注用户自动引导初始化为系统管理员，支持注册邮箱验证码、忘记密码邮箱重置及管理员受控注册策略。 */
import { useEffect, useState } from "react";
import { Alert, App, Button, Card, Form, Input, Modal, Space, Tabs, Tag, Typography } from "antd";
import { Gift, Lock, Mail, ShieldCheck, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";

import { useEmailCodeSender } from "@/hooks/use-email-code-sender";
import { authApi } from "@/services/api/server";
import { useUserStore } from "@/stores/use-user-store";

export default function AuthPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const user = useUserStore((state) => state.user);
    const bootstrapStatus = useUserStore((state) => state.bootstrapStatus);
    const setBootstrapStatus = useUserStore((state) => state.setBootstrapStatus);
    const setSession = useUserStore((state) => state.setSession);

    const [activeTab, setActiveTab] = useState<"login" | "register">("login");
    const [submitting, setSubmitting] = useState(false);
    const [loginForm] = Form.useForm<{ account: string; password: string }>();
    const [registerForm] = Form.useForm<{ username: string; displayName?: string; email?: string; emailCode?: string; inviteCode?: string; password: string }>();
    const registerEmailWatch = Form.useWatch("email", registerForm);
    const registerCodeSender = useEmailCodeSender();
    const urlInviteCode = (searchParams.get("invite") || searchParams.get("ref") || "").trim().toUpperCase();

    useEffect(() => {
        if (urlInviteCode) {
            setActiveTab("register");
            registerForm.setFieldValue("inviteCode", urlInviteCode);
        }
    }, [registerForm, urlInviteCode]);

    const [resetOpen, setResetOpen] = useState(false);
    const [resetting, setResetting] = useState(false);
    const [resetForm] = Form.useForm<{ email: string; code: string; newPassword: string; confirmPassword: string }>();
    const resetCodeSender = useEmailCodeSender();

    useEffect(() => {
        authApi
            .getBootstrapStatus()
            .then((status) => {
                setBootstrapStatus(status);
                if (!status.initialized) setActiveTab("register");
            })
            .catch(() => undefined);
    }, [setBootstrapStatus]);

    const rawRedirect = searchParams.get("redirect") || "";
    const redirectTarget = rawRedirect.startsWith("/") && !rawRedirect.startsWith("//") ? rawRedirect : "";

    const handleSuccessRedirect = (role: "admin" | "user") => {
        if (redirectTarget) {
            if (role === "admin" && redirectTarget.startsWith("/console")) {
                navigate(`/admin${redirectTarget.slice("/console".length)}`, { replace: true });
                return;
            }
            if (role !== "admin" && redirectTarget.startsWith("/admin")) {
                navigate(`/console${redirectTarget.slice("/admin".length)}`, { replace: true });
                return;
            }
            navigate(redirectTarget, { replace: true });
            return;
        }
        navigate(role === "admin" ? "/admin" : "/", { replace: true });
    };

    const handleLogin = async (values: { account: string; password: string }) => {
        setSubmitting(true);
        try {
            const session = await authApi.login(values);
            setSession(session);
            message.success(t("auth.loginSuccess"));
            handleSuccessRedirect(session.user.role);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("auth.loginFailed"));
        } finally {
            setSubmitting(false);
        }
    };

    const handleSendRegisterCode = async () => {
        try {
            const { email } = await registerForm.validateFields(["email"]);
            const cleanEmail = (email || "").trim();
            if (!cleanEmail) {
                message.warning(t("auth.emailRequiredFirst"));
                return;
            }
            await registerCodeSender.sendCode(() => authApi.sendRegisterCode(cleanEmail));
        } catch {
            // validation error shown on field
        }
    };

    const handleRegister = async (values: { username: string; displayName?: string; email?: string; emailCode?: string; inviteCode?: string; password: string }) => {
        setSubmitting(true);
        try {
            const session = await authApi.register({
                username: values.username,
                displayName: values.displayName,
                email: values.email?.trim() || undefined,
                emailCode: values.emailCode?.trim() || undefined,
                inviteCode: values.inviteCode?.trim() || undefined,
                password: values.password,
            });
            setSession(session);
            setBootstrapStatus({
                initialized: true,
                allowRegister: bootstrapStatus?.allowRegister ?? true,
                requireEmailOnRegister: bootstrapStatus?.requireEmailOnRegister ?? false,
                emailEnabled: bootstrapStatus?.emailEnabled ?? false,
                inviteEnabled: bootstrapStatus?.inviteEnabled ?? false,
            });
            message.success(session.user.role === "admin" ? t("auth.registerSuccessAdmin") : t("auth.registerSuccess"));
            handleSuccessRedirect(session.user.role);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("auth.registerFailed"));
        } finally {
            setSubmitting(false);
        }
    };

    const handleSendResetCode = async () => {
        try {
            const { email } = await resetForm.validateFields(["email"]);
            await resetCodeSender.sendCode(() => authApi.sendForgotPasswordCode(email.trim()));
        } catch {
            // validation error shown on field
        }
    };

    const handleResetPassword = async (values: { email: string; code: string; newPassword: string }) => {
        setResetting(true);
        try {
            await authApi.resetPasswordByEmail({
                email: values.email.trim(),
                code: values.code.trim(),
                newPassword: values.newPassword,
            });
            message.success(t("auth.resetSuccess"));
            loginForm.setFieldsValue({ account: values.email.trim(), password: "" });
            setResetOpen(false);
            resetForm.resetFields();
            resetCodeSender.resetCooldown();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("auth.resetFailed"));
        } finally {
            setResetting(false);
        }
    };

    if (user) {
        return (
            <div className="flex h-full items-center justify-center overflow-y-auto p-6">
                <Card className="w-full max-w-md">
                    <div className="flex flex-col items-center gap-4 text-center">
                        <Typography.Title level={4} style={{ margin: 0 }}>
                            {t("auth.loggedInTitle", { name: user.displayName || user.username })}
                        </Typography.Title>
                        <Tag color={user.role === "admin" ? "blue" : "default"}>{user.role === "admin" ? t("auth.roleAdmin") : t("auth.roleUser")}</Tag>
                        <div className="flex gap-3">
                            {user.role === "admin" ? (
                                <Button type="primary" onClick={() => navigate("/admin")}>
                                    {t("auth.enterAdmin")}
                                </Button>
                            ) : null}
                            <Button onClick={() => navigate("/")}>{t("auth.backHome")}</Button>
                        </div>
                    </div>
                </Card>
            </div>
        );
    }

    const isBootstrap = bootstrapStatus && !bootstrapStatus.initialized;
    const registerClosed = bootstrapStatus ? bootstrapStatus.initialized && !bootstrapStatus.allowRegister : false;
    const emailEnabled = Boolean(bootstrapStatus?.emailEnabled);
    const requireEmailOnRegister = !isBootstrap && emailEnabled && Boolean(bootstrapStatus?.requireEmailOnRegister);
    const showRegisterCodeInput = !isBootstrap && emailEnabled && (requireEmailOnRegister || Boolean(registerEmailWatch?.trim()));
    const showInviteCodeInput = !isBootstrap && (Boolean(bootstrapStatus?.inviteEnabled) || Boolean(urlInviteCode));

    return (
        <div className="flex h-full items-center justify-center overflow-y-auto p-6">
            <Card className="w-full max-w-md">
                <div className="mb-4 flex items-center justify-between">
                    <div>
                        <Typography.Title level={4} style={{ margin: 0 }}>
                            {t("auth.title")}
                        </Typography.Title>
                        <Typography.Text type="secondary">{t("auth.subtitle")}</Typography.Text>
                    </div>
                    {isBootstrap ? (
                        <Tag color="gold" icon={<ShieldCheck className="mr-1 inline size-3.5" />}>
                            {t("auth.uninitialized")}
                        </Tag>
                    ) : null}
                </div>

                {isBootstrap ? (
                    <Alert
                        type="info"
                        showIcon
                        className="mb-4"
                        message={t("auth.bootstrapAlertTitle")}
                        description={t("auth.bootstrapAlertDescription")}
                    />
                ) : null}

                <Tabs
                    activeKey={activeTab}
                    onChange={(key) => setActiveTab(key as "login" | "register")}
                    items={[
                        {
                            key: "login",
                            label: t("auth.loginTab"),
                            children: (
                                <Form form={loginForm} layout="vertical" onFinish={handleLogin} autoComplete="on">
                                    <Form.Item name="account" label={t("auth.accountLabel")} rules={[{ required: true, message: t("auth.accountPlaceholder") }]}>
                                        <Input prefix={<User className="size-4 opacity-50" />} placeholder={t("auth.accountPlaceholder")} />
                                    </Form.Item>
                                    <Form.Item name="password" label={t("auth.passwordLabel")} rules={[{ required: true, message: t("auth.passwordPlaceholder") }]}>
                                        <Input.Password prefix={<Lock className="size-4 opacity-50" />} placeholder={t("auth.passwordPlaceholder")} />
                                    </Form.Item>
                                    <div className="mb-3 flex justify-end">
                                        <Button type="link" size="small" className="px-0" onClick={() => setResetOpen(true)}>
                                            {t("auth.forgotPassword")}
                                        </Button>
                                    </div>
                                    <Button type="primary" htmlType="submit" block loading={submitting}>
                                        {t("auth.loginButton")}
                                    </Button>
                                </Form>
                            ),
                        },
                        {
                            key: "register",
                            label: isBootstrap ? t("auth.createAdminTab") : t("auth.registerTab"),
                            children: registerClosed ? (
                                <Alert type="warning" showIcon message={t("auth.registerClosedTitle")} description={t("auth.registerClosedDescription")} />
                            ) : (
                                <Form form={registerForm} layout="vertical" onFinish={handleRegister}>
                                    <Form.Item
                                        name="username"
                                        label={t("auth.usernameLabel")}
                                        rules={[
                                            { required: true, message: t("auth.usernameRequired") },
                                            { min: 3, max: 32, message: t("auth.usernameLength") },
                                            { pattern: /^[a-zA-Z0-9_-]+$/, message: t("auth.usernamePattern") },
                                        ]}
                                    >
                                        <Input prefix={<User className="size-4 opacity-50" />} placeholder={t("auth.usernamePlaceholder")} />
                                    </Form.Item>
                                    <Form.Item name="displayName" label={t("auth.displayNameLabel")}>
                                        <Input placeholder={t("auth.displayNamePlaceholder")} />
                                    </Form.Item>
                                    <Form.Item
                                        name="email"
                                        label={requireEmailOnRegister ? t("auth.emailRequiredLabel") : t("auth.emailOptionalLabel")}
                                        rules={[
                                            ...(requireEmailOnRegister ? [{ required: true, message: t("auth.emailRequired") }] : []),
                                            { type: "email" as const, message: t("auth.emailInvalid") },
                                        ]}
                                    >
                                        <Input prefix={<Mail className="size-4 opacity-50" />} placeholder="example@domain.com" />
                                    </Form.Item>
                                    {showRegisterCodeInput ? (
                                        <Form.Item
                                            name="emailCode"
                                            label={t("auth.emailCodeLabel")}
                                            rules={[{ required: true, message: t("auth.emailCodeRequired") }]}
                                        >
                                            <Space.Compact className="w-full">
                                                <Input placeholder={t("auth.emailCodePlaceholder")} maxLength={8} />
                                                <Button
                                                    loading={registerCodeSender.sending}
                                                    disabled={registerCodeSender.cooldown > 0}
                                                    onClick={() => void handleSendRegisterCode()}
                                                >
                                                    {registerCodeSender.cooldown > 0 ? t("auth.retryAfter", { seconds: registerCodeSender.cooldown }) : t("auth.getCode")}
                                                </Button>
                                            </Space.Compact>
                                        </Form.Item>
                                    ) : null}
                                    {showInviteCodeInput ? (
                                        <Form.Item name="inviteCode" label={t("auth.inviteCodeLabel")}>
                                            <Input prefix={<Gift className="size-4 opacity-50" />} placeholder={t("auth.inviteCodePlaceholder")} maxLength={32} />
                                        </Form.Item>
                                    ) : null}
                                    <Form.Item
                                        name="password"
                                        label={t("auth.passwordLabel")}
                                        rules={[
                                            { required: true, message: t("auth.passwordPlaceholder") },
                                            { min: 6, message: t("auth.passwordMin") },
                                        ]}
                                    >
                                        <Input.Password prefix={<Lock className="size-4 opacity-50" />} placeholder={t("auth.passwordMinPlaceholder")} />
                                    </Form.Item>
                                    <Form.Item
                                        name="confirmPassword"
                                        label={t("auth.confirmPasswordLabel")}
                                        dependencies={["password"]}
                                        rules={[
                                            { required: true, message: t("auth.confirmPasswordRequired") },
                                            ({ getFieldValue }) => ({
                                                validator(_, value) {
                                                    if (!value || getFieldValue("password") === value) return Promise.resolve();
                                                    return Promise.reject(new Error(t("auth.passwordMismatch")));
                                                },
                                            }),
                                        ]}
                                    >
                                        <Input.Password prefix={<Lock className="size-4 opacity-50" />} placeholder={t("auth.confirmPasswordPlaceholder")} />
                                    </Form.Item>
                                    <Button type="primary" htmlType="submit" block loading={submitting}>
                                        {isBootstrap ? t("auth.registerAdminButton") : t("auth.registerButton")}
                                    </Button>
                                </Form>
                            ),
                        },
                    ]}
                />
            </Card>

            <Modal
                title={t("auth.resetModalTitle")}
                open={resetOpen}
                onCancel={() => setResetOpen(false)}
                footer={null}
                destroyOnHidden
            >
                {!emailEnabled ? (
                    <Alert
                        type="warning"
                        showIcon
                        message={t("auth.mailDisabledTitle")}
                        description={t("auth.mailDisabledDescription")}
                    />
                ) : (
                    <Form form={resetForm} layout="vertical" onFinish={handleResetPassword}>
                        <Form.Item
                            name="email"
                            label={t("auth.emailRequiredLabel")}
                            rules={[
                                { required: true, message: t("auth.boundEmailRequired") },
                                { type: "email", message: t("auth.emailInvalid") },
                            ]}
                        >
                            <Input prefix={<Mail className="size-4 opacity-50" />} placeholder={t("auth.boundEmailPlaceholder")} />
                        </Form.Item>
                        <Form.Item
                            name="code"
                            label={t("auth.emailCodeLabel")}
                            rules={[{ required: true, message: t("auth.emailCodeRequired") }]}
                        >
                            <Space.Compact className="w-full">
                                <Input placeholder={t("auth.emailCodePlaceholder")} maxLength={8} />
                                <Button
                                    loading={resetCodeSender.sending}
                                    disabled={resetCodeSender.cooldown > 0}
                                    onClick={() => void handleSendResetCode()}
                                >
                                    {resetCodeSender.cooldown > 0 ? t("auth.retryAfter", { seconds: resetCodeSender.cooldown }) : t("auth.sendCode")}
                                </Button>
                            </Space.Compact>
                        </Form.Item>
                        <Form.Item
                            name="newPassword"
                            label={t("auth.newPasswordLabel")}
                            rules={[
                                { required: true, message: t("auth.newPasswordRequired") },
                                { min: 6, message: t("auth.passwordMin") },
                            ]}
                        >
                            <Input.Password prefix={<Lock className="size-4 opacity-50" />} placeholder={t("auth.newPasswordPlaceholder")} />
                        </Form.Item>
                        <Form.Item
                            name="confirmPassword"
                            label={t("auth.confirmNewPasswordLabel")}
                            dependencies={["newPassword"]}
                            rules={[
                                { required: true, message: t("auth.confirmNewPasswordRequired") },
                                ({ getFieldValue }) => ({
                                    validator(_, value) {
                                        if (!value || getFieldValue("newPassword") === value) return Promise.resolve();
                                        return Promise.reject(new Error(t("auth.passwordMismatch")));
                                    },
                                }),
                            ]}
                        >
                            <Input.Password prefix={<Lock className="size-4 opacity-50" />} placeholder={t("auth.confirmNewPasswordPlaceholder")} />
                        </Form.Item>
                        <Button type="primary" htmlType="submit" block loading={resetting}>
                            {t("auth.confirmResetButton")}
                        </Button>
                    </Form>
                )}
            </Modal>
        </div>
    );
}
