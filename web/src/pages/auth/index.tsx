/** 账号登录与注册页：首注用户自动引导初始化为系统管理员，支持注册邮箱验证码、忘记密码邮箱重置及管理员受控注册策略。 */
import { useEffect, useState } from "react";
import { Alert, App, Button, Card, Form, Input, Modal, Space, Tabs, Tag, Typography } from "antd";
import { Lock, Mail, ShieldCheck, User } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { useEmailCodeSender } from "@/hooks/use-email-code-sender";
import { authApi } from "@/services/api/server";
import { useUserStore } from "@/stores/use-user-store";

export default function AuthPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const user = useUserStore((state) => state.user);
    const bootstrapStatus = useUserStore((state) => state.bootstrapStatus);
    const setBootstrapStatus = useUserStore((state) => state.setBootstrapStatus);
    const setSession = useUserStore((state) => state.setSession);

    const [activeTab, setActiveTab] = useState<"login" | "register">("login");
    const [submitting, setSubmitting] = useState(false);
    const [loginForm] = Form.useForm<{ account: string; password: string }>();
    const [registerForm] = Form.useForm<{ username: string; displayName?: string; email?: string; emailCode?: string; password: string }>();
    const registerEmailWatch = Form.useWatch("email", registerForm);
    const registerCodeSender = useEmailCodeSender();

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

    const redirectTarget = searchParams.get("redirect") || "";

    const handleSuccessRedirect = (role: "admin" | "user") => {
        if (redirectTarget) {
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
            message.success("登录成功");
            handleSuccessRedirect(session.user.role);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "登录失败");
        } finally {
            setSubmitting(false);
        }
    };

    const handleSendRegisterCode = async () => {
        try {
            const { email } = await registerForm.validateFields(["email"]);
            const cleanEmail = (email || "").trim();
            if (!cleanEmail) {
                message.warning("请先填写邮箱地址");
                return;
            }
            await registerCodeSender.sendCode(() => authApi.sendRegisterCode(cleanEmail));
        } catch {
            // validation error shown on field
        }
    };

    const handleRegister = async (values: { username: string; displayName?: string; email?: string; emailCode?: string; password: string }) => {
        setSubmitting(true);
        try {
            const session = await authApi.register({
                username: values.username,
                displayName: values.displayName,
                email: values.email?.trim() || undefined,
                emailCode: values.emailCode?.trim() || undefined,
                password: values.password,
            });
            setSession(session);
            setBootstrapStatus({
                initialized: true,
                allowRegister: bootstrapStatus?.allowRegister ?? true,
                requireEmailOnRegister: bootstrapStatus?.requireEmailOnRegister ?? false,
                emailEnabled: bootstrapStatus?.emailEnabled ?? false,
            });
            message.success(session.user.role === "admin" ? "注册成功，已初始化为系统管理员" : "注册成功");
            handleSuccessRedirect(session.user.role);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "注册失败");
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
            message.success("密码已重置，请使用新密码登录");
            loginForm.setFieldsValue({ account: values.email.trim(), password: "" });
            setResetOpen(false);
            resetForm.resetFields();
            resetCodeSender.resetCooldown();
        } catch (error) {
            message.error(error instanceof Error ? error.message : "重置密码失败");
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
                            已登录：{user.displayName || user.username}
                        </Typography.Title>
                        <Tag color={user.role === "admin" ? "blue" : "default"}>{user.role === "admin" ? "系统管理员" : "普通用户"}</Tag>
                        <div className="flex gap-3">
                            {user.role === "admin" ? (
                                <Button type="primary" onClick={() => navigate("/admin")}>
                                    进入管理后台
                                </Button>
                            ) : null}
                            <Button onClick={() => navigate("/")}>返回首页</Button>
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

    return (
        <div className="flex h-full items-center justify-center overflow-y-auto p-6">
            <Card className="w-full max-w-md">
                <div className="mb-4 flex items-center justify-between">
                    <div>
                        <Typography.Title level={4} style={{ margin: 0 }}>
                            账号登录与注册
                        </Typography.Title>
                        <Typography.Text type="secondary">登录后可使用云端对象存储与多用户管理</Typography.Text>
                    </div>
                    {isBootstrap ? (
                        <Tag color="gold" icon={<ShieldCheck className="mr-1 inline size-3.5" />}>
                            待初始化
                        </Tag>
                    ) : null}
                </div>

                {isBootstrap ? (
                    <Alert
                        type="info"
                        showIcon
                        className="mb-4"
                        message="系统尚未初始化"
                        description="当前注册的第一个账号将自动成为系统管理员，后续用户将默认注册为普通用户。"
                    />
                ) : null}

                <Tabs
                    activeKey={activeTab}
                    onChange={(key) => setActiveTab(key as "login" | "register")}
                    items={[
                        {
                            key: "login",
                            label: "登录",
                            children: (
                                <Form form={loginForm} layout="vertical" onFinish={handleLogin} autoComplete="on">
                                    <Form.Item name="account" label="用户名或邮箱" rules={[{ required: true, message: "请输入用户名或邮箱" }]}>
                                        <Input prefix={<User className="size-4 opacity-50" />} placeholder="请输入用户名或邮箱" />
                                    </Form.Item>
                                    <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
                                        <Input.Password prefix={<Lock className="size-4 opacity-50" />} placeholder="请输入密码" />
                                    </Form.Item>
                                    <div className="mb-3 flex justify-end">
                                        <Button type="link" size="small" className="px-0" onClick={() => setResetOpen(true)}>
                                            忘记密码？通过邮箱重置
                                        </Button>
                                    </div>
                                    <Button type="primary" htmlType="submit" block loading={submitting}>
                                        登录
                                    </Button>
                                </Form>
                            ),
                        },
                        {
                            key: "register",
                            label: isBootstrap ? "创建管理员账号" : "注册",
                            children: registerClosed ? (
                                <Alert type="warning" showIcon message="管理员已关闭新用户注册" description="如需账号，请联系系统管理员开通。" />
                            ) : (
                                <Form form={registerForm} layout="vertical" onFinish={handleRegister}>
                                    <Form.Item
                                        name="username"
                                        label="用户名"
                                        rules={[
                                            { required: true, message: "请输入用户名" },
                                            { min: 3, max: 32, message: "用户名长度为 3 到 32 个字符" },
                                            { pattern: /^[a-zA-Z0-9_-]+$/, message: "仅支持字母、数字、下划线和连字符" },
                                        ]}
                                    >
                                        <Input prefix={<User className="size-4 opacity-50" />} placeholder="如 admin 或 alice" />
                                    </Form.Item>
                                    <Form.Item name="displayName" label="显示名称（可选）">
                                        <Input placeholder="默认与用户名一致" />
                                    </Form.Item>
                                    <Form.Item
                                        name="email"
                                        label={requireEmailOnRegister ? "绑定邮箱" : "邮箱（可选）"}
                                        rules={[
                                            ...(requireEmailOnRegister ? [{ required: true, message: "请输入绑定邮箱" }] : []),
                                            { type: "email" as const, message: "邮箱格式不正确" },
                                        ]}
                                    >
                                        <Input prefix={<Mail className="size-4 opacity-50" />} placeholder="example@domain.com" />
                                    </Form.Item>
                                    {showRegisterCodeInput ? (
                                        <Form.Item
                                            name="emailCode"
                                            label="邮箱验证码"
                                            rules={[{ required: true, message: "请输入邮箱验证码" }]}
                                        >
                                            <Space.Compact className="w-full">
                                                <Input placeholder="输入 6 位验证码" maxLength={8} />
                                                <Button
                                                    loading={registerCodeSender.sending}
                                                    disabled={registerCodeSender.cooldown > 0}
                                                    onClick={() => void handleSendRegisterCode()}
                                                >
                                                    {registerCodeSender.cooldown > 0 ? `${registerCodeSender.cooldown}s 后重试` : "获取验证码"}
                                                </Button>
                                            </Space.Compact>
                                        </Form.Item>
                                    ) : null}
                                    <Form.Item
                                        name="password"
                                        label="密码"
                                        rules={[
                                            { required: true, message: "请输入密码" },
                                            { min: 6, message: "密码至少 6 位" },
                                        ]}
                                    >
                                        <Input.Password prefix={<Lock className="size-4 opacity-50" />} placeholder="至少 6 位" />
                                    </Form.Item>
                                    <Form.Item
                                        name="confirmPassword"
                                        label="确认密码"
                                        dependencies={["password"]}
                                        rules={[
                                            { required: true, message: "请再次输入密码" },
                                            ({ getFieldValue }) => ({
                                                validator(_, value) {
                                                    if (!value || getFieldValue("password") === value) return Promise.resolve();
                                                    return Promise.reject(new Error("两次输入的密码不一致"));
                                                },
                                            }),
                                        ]}
                                    >
                                        <Input.Password prefix={<Lock className="size-4 opacity-50" />} placeholder="再次输入密码" />
                                    </Form.Item>
                                    <Button type="primary" htmlType="submit" block loading={submitting}>
                                        {isBootstrap ? "注册并初始化为管理员" : "注册账号"}
                                    </Button>
                                </Form>
                            ),
                        },
                    ]}
                />
            </Card>

            <Modal
                title="通过邮箱重置密码"
                open={resetOpen}
                onCancel={() => setResetOpen(false)}
                footer={null}
                destroyOnHidden
            >
                {!emailEnabled ? (
                    <Alert
                        type="warning"
                        showIcon
                        message="邮件服务暂未启用"
                        description="管理员尚未启用平台邮件发信服务，无法自助通过邮箱重置密码，请联系管理员协助处理。"
                    />
                ) : (
                    <Form form={resetForm} layout="vertical" onFinish={handleResetPassword}>
                        <Form.Item
                            name="email"
                            label="绑定邮箱"
                            rules={[
                                { required: true, message: "请输入账号绑定的邮箱" },
                                { type: "email", message: "邮箱格式不正确" },
                            ]}
                        >
                            <Input prefix={<Mail className="size-4 opacity-50" />} placeholder="输入绑定的邮箱地址" />
                        </Form.Item>
                        <Form.Item
                            name="code"
                            label="邮箱验证码"
                            rules={[{ required: true, message: "请输入邮箱验证码" }]}
                        >
                            <Space.Compact className="w-full">
                                <Input placeholder="输入 6 位验证码" maxLength={8} />
                                <Button
                                    loading={resetCodeSender.sending}
                                    disabled={resetCodeSender.cooldown > 0}
                                    onClick={() => void handleSendResetCode()}
                                >
                                    {resetCodeSender.cooldown > 0 ? `${resetCodeSender.cooldown}s 后重试` : "发送验证码"}
                                </Button>
                            </Space.Compact>
                        </Form.Item>
                        <Form.Item
                            name="newPassword"
                            label="新密码"
                            rules={[
                                { required: true, message: "请输入新密码" },
                                { min: 6, message: "密码至少 6 位" },
                            ]}
                        >
                            <Input.Password prefix={<Lock className="size-4 opacity-50" />} placeholder="至少 6 位字符" />
                        </Form.Item>
                        <Form.Item
                            name="confirmPassword"
                            label="确认新密码"
                            dependencies={["newPassword"]}
                            rules={[
                                { required: true, message: "请再次输入新密码" },
                                ({ getFieldValue }) => ({
                                    validator(_, value) {
                                        if (!value || getFieldValue("newPassword") === value) return Promise.resolve();
                                        return Promise.reject(new Error("两次输入的密码不一致"));
                                    },
                                }),
                            ]}
                        >
                            <Input.Password prefix={<Lock className="size-4 opacity-50" />} placeholder="再次输入新密码" />
                        </Form.Item>
                        <Button type="primary" htmlType="submit" block loading={resetting}>
                            确认重置密码
                        </Button>
                    </Form>
                )}
            </Modal>
        </div>
    );
}
