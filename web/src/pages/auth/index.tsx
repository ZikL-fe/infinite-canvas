/** 账号登录与注册页：首注用户自动引导初始化为系统管理员，支持管理员关闭开放注册后的受控提示。 */
import { useEffect, useState } from "react";
import { Alert, App, Button, Card, Form, Input, Tabs, Tag, Typography } from "antd";
import { Lock, Mail, ShieldCheck, User } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";

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

    const handleRegister = async (values: { username: string; displayName?: string; email?: string; password: string }) => {
        setSubmitting(true);
        try {
            const session = await authApi.register({
                username: values.username,
                displayName: values.displayName,
                email: values.email,
                password: values.password,
            });
            setSession(session);
            setBootstrapStatus({ initialized: true, allowRegister: bootstrapStatus?.allowRegister ?? true });
            message.success(session.user.role === "admin" ? "注册成功，已初始化为系统管理员" : "注册成功");
            handleSuccessRedirect(session.user.role);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "注册失败");
        } finally {
            setSubmitting(false);
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
                                <Form layout="vertical" onFinish={handleLogin} autoComplete="on">
                                    <Form.Item name="account" label="用户名或邮箱" rules={[{ required: true, message: "请输入用户名或邮箱" }]}>
                                        <Input prefix={<User className="size-4 opacity-50" />} placeholder="请输入用户名或邮箱" />
                                    </Form.Item>
                                    <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
                                        <Input.Password prefix={<Lock className="size-4 opacity-50" />} placeholder="请输入密码" />
                                    </Form.Item>
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
                                <Form layout="vertical" onFinish={handleRegister}>
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
                                    <Form.Item name="email" label="邮箱（可选）" rules={[{ type: "email", message: "邮箱格式不正确" }]}>
                                        <Input prefix={<Mail className="size-4 opacity-50" />} placeholder="example@domain.com" />
                                    </Form.Item>
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
        </div>
    );
}
