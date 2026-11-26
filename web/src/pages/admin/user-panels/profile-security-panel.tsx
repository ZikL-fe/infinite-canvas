/** 个人资料、邮箱绑定、修改密码、低余额提醒与登录设备会话管理面板。 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Avatar, Button, Card, Col, DatePicker, Descriptions, Empty, Form, Image, Input, InputNumber, Modal, Popconfirm, Progress, Radio, Row, Segmented, Select, Space, Spin, Statistic, Switch, Table, Tabs, Tag, Tooltip, Typography, theme as antdTheme } from "antd";
import type { Dayjs } from "dayjs";
import type { TFunction } from "i18next";
import localforage from "localforage";
import { AudioLines, Bell, Download, Eye, FileIcon, Gift, ImageIcon, KeyRound, Laptop, LogOut, Megaphone, Pin, RefreshCw, RotateCcw, Save, Search, Trash2, TrendingUp, User, Video } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { useBatchZipDownload } from "@/hooks/use-batch-zip-download";
import { useEmailCodeSender } from "@/hooks/use-email-code-sender";
import { formatCompactCredits, formatExactCredits } from "@/lib/format-number";
import { createImageThumbnail, createVideoThumbnail } from "@/lib/image-thumbnail";
import { getMediaThumbBytes, getMediaTotalBytes } from "@/lib/image-utils";
import {
    formatCreditAlertCopy,
    formatStorageAlertCopy,
    formatStorageQuotaCaption,
    resolveCreditAlert,
    resolveStorageAlert,
} from "@/lib/quota-alerts";
import { previewUrlFor, purgeLocalStoredImages } from "@/services/image-storage";
import { ADMIN_TABLE_CLASS, ADMIN_TABLE_SCROLL, TableRowActions } from "@/pages/admin/components/table-row-actions";
import { notifyCloudWorkspaceChanged, WORKSPACE_CHANGED_EVENT } from "@/services/cloud-media";
import { deleteCanvasProjectsWithCloud, syncCloudWorkspace } from "@/services/cloud-sync";
import { purgeLocalStoredMedia } from "@/services/file-storage";
import { deleteWorkbenchLogsWithCloud } from "@/services/workbench-sync";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

import {
    accountApi,
    adminApi,
    billingApi,
    canvasApi,
    mediaDownloadFilename,
    storageApi,
    workbenchApi,
    type AccountOverviewResponse,
    type AccountProfileResponse,
    type AccountSessionItem,
    type AnnouncementItem,
    type CreditLedgerItem,
    type CreditLedgerSummary,
    type DailyTrendItem,
    type MediaItem,
    type MediaSourceModule,
    type StorageGrantItem,
    type TopModelUsageItem,
} from "@/services/api/server";
import { useUserStore } from "@/stores/use-user-store";

import { formatBytes } from "./shared";

export function ProfileSecurityPanel() {
    const { t, i18n } = useTranslation();
    const locale = i18n.resolvedLanguage || undefined;
    const { message } = App.useApp();
    const user = useUserStore((state) => state.user);
    const setUser = useUserStore((state) => state.setUser);

    const [profileData, setProfileData] = useState<AccountProfileResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [savingProfile, setSavingProfile] = useState(false);
    const [changingPassword, setChangingPassword] = useState(false);
    const [savingAlert, setSavingAlert] = useState(false);
    const [passwordMode, setPasswordMode] = useState<"password" | "email">("password");
    const [sessions, setSessions] = useState<AccountSessionItem[]>([]);
    const [sessionsLoading, setSessionsLoading] = useState(true);

    const bindEmailCodeSender = useEmailCodeSender();
    const changePasswordCodeSender = useEmailCodeSender();

    const [profileForm] = Form.useForm<{ displayName: string; email: string; emailCode?: string; avatarUrl: string }>();
    const [alertForm] = Form.useForm<{ mode: "inherit" | "custom_on" | "off"; threshold: number }>();
    const [passwordForm] = Form.useForm<{
        currentPassword?: string;
        emailCode?: string;
        newPassword: string;
        confirmPassword: string;
        revokeOtherSessions: boolean;
    }>();

    const loadProfile = useCallback(async () => {
        setLoading(true);
        try {
            const res = await accountApi.getProfile();
            setProfileData(res);
            setUser(res.user);
            profileForm.setFieldsValue({
                displayName: res.user.displayName,
                email: res.user.email || "",
                emailCode: "",
                avatarUrl: res.user.avatarUrl || "",
            });
            const alertCfg = res.lowBalanceAlert;
            const alertMode: "inherit" | "custom_on" | "off" =
                alertCfg?.enabled === false ? "off" : alertCfg?.enabled === true ? "custom_on" : "inherit";
            alertForm.setFieldsValue({
                mode: alertMode,
                threshold: alertCfg?.threshold ?? alertCfg?.platformThreshold ?? 10,
            });
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("userPanels.profile.loadFailed"));
        } finally {
            setLoading(false);
        }
    }, [alertForm, message, profileForm, setUser, t]);

    const loadSessions = useCallback(
        async (notifySuccess = false) => {
            setSessionsLoading(true);
            try {
                const res = await accountApi.listSessions();
                setSessions(res.items);
                if (notifySuccess) message.success(t("common.refreshed"));
            } catch (error) {
                if (notifySuccess) message.error(error instanceof Error ? error.message : t("userPanels.profile.opFailed"));
            } finally {
                setSessionsLoading(false);
            }
        },
        [message, t],
    );

    useEffect(() => {
        void loadProfile();
        void loadSessions();
    }, [loadProfile, loadSessions]);

    const handleSendBindEmailCode = async () => {
        try {
            const { email } = await profileForm.validateFields(["email"]);
            const clean = (email || "").trim();
            if (!clean) {
                message.warning(t("userPanels.profile.enterEmailFirst"));
                return;
            }
            await bindEmailCodeSender.sendCode(() => accountApi.sendEmailBindCode(clean));
        } catch {
            // validation error shown on field
        }
    };

    const handleSaveProfile = async (values: { displayName: string; email: string; emailCode?: string; avatarUrl: string }) => {
        setSavingProfile(true);
        try {
            const res = await accountApi.updateProfile({
                displayName: values.displayName.trim(),
                email: values.email.trim(),
                ...(values.emailCode?.trim() ? { emailCode: values.emailCode.trim() } : {}),
                avatarUrl: values.avatarUrl.trim(),
            });
            setUser(res.user);
            bindEmailCodeSender.resetCooldown();
            message.success(t("userPanels.profile.saved"));
            void loadProfile();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("userPanels.profile.saveFailed"));
        } finally {
            setSavingProfile(false);
        }
    };

    const handleSaveAlertSettings = async (values: { mode: "inherit" | "custom_on" | "off"; threshold: number }) => {
        setSavingAlert(true);
        try {
            const lowBalanceAlertEnabled = values.mode === "inherit" ? null : values.mode === "custom_on";
            const lowBalanceThreshold = values.mode === "custom_on" ? Number(values.threshold ?? 10) : null;
            await accountApi.updateProfile({
                lowBalanceAlertEnabled,
                lowBalanceThreshold,
            });
            message.success(t("userPanels.profile.alertSaved"));
            void loadProfile();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("userPanels.profile.alertSaveFailed"));
        } finally {
            setSavingAlert(false);
        }
    };

    const handleSendChangePasswordCode = async () => {
        await changePasswordCodeSender.sendCode(() => accountApi.sendChangePasswordCode());
    };

    const handleChangePassword = async (values: {
        currentPassword?: string;
        emailCode?: string;
        newPassword: string;
        revokeOtherSessions: boolean;
    }) => {
        setChangingPassword(true);
        try {
            await accountApi.changePassword({
                mode: passwordMode,
                currentPassword: values.currentPassword,
                emailCode: values.emailCode?.trim(),
                newPassword: values.newPassword,
                revokeOtherSessions: values.revokeOtherSessions,
            });
            passwordForm.resetFields();
            changePasswordCodeSender.resetCooldown();
            message.success(t("userPanels.profile.passwordChanged"));
            void loadSessions();
            void loadProfile();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("userPanels.profile.passwordChangeFailed"));
        } finally {
            setChangingPassword(false);
        }
    };

    const handleRevokeSession = async (id: string) => {
        try {
            await accountApi.revokeSession(id);
            message.success(t("userPanels.profile.sessionRevoked"));
            void loadSessions();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("userPanels.profile.opFailed"));
        }
    };

    const handleRevokeOtherSessions = async () => {
        try {
            await accountApi.revokeOtherSessions();
            message.success(t("userPanels.profile.otherSessionsRevoked"));
            void loadSessions();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("userPanels.profile.opFailed"));
        }
    };

    const detail = profileData?.user || user;
    const avatarWatch = Form.useWatch("avatarUrl", profileForm);
    const emailWatch = Form.useWatch("email", profileForm);
    const alertModeWatch = Form.useWatch("mode", alertForm);

    const emailServiceEnabled = Boolean(profileData?.emailServiceEnabled);
    const normalizedSavedEmail = (profileData?.user.email || "").trim().toLowerCase();
    const normalizedInputEmail = (emailWatch || "").trim().toLowerCase();
    const needsEmailVerifyCode = Boolean(
        emailServiceEnabled &&
            normalizedInputEmail &&
            (normalizedInputEmail !== normalizedSavedEmail || !profileData?.user.emailVerifiedAt),
    );
    const canResetByEmail = Boolean(emailServiceEnabled && detail?.email);

    return (
        <div className="flex flex-col gap-5">
            <Row gutter={[16, 16]}>
                <Col xs={24} sm={12} xl={6}>
                    <Card loading={loading}>
                        <Tooltip title={t("userPanels.overview.exactBalance", { value: formatExactCredits(detail?.creditBalance ?? 0) })}>
                            <div>
                                <Statistic title={t("userPanels.profile.currentCredits")} value={formatCompactCredits(detail?.creditBalance ?? 0)} />
                            </div>
                        </Tooltip>
                    </Card>
                </Col>
                <Col xs={24} sm={12} xl={6}>
                    <Card loading={loading}>
                        <Statistic
                            title={t("userPanels.profile.storageQuota")}
                            value={`${formatBytes(detail?.storageUsedBytes ?? 0)} / ${formatBytes(detail?.storageQuotaBytes ?? 0)}`}
                        />
                    </Card>
                </Col>
                <Col xs={24} sm={12} xl={6}>
                    <Card loading={loading}>
                        <Statistic title={t("userPanels.profile.canvasCount")} value={profileData?.stats.canvasProjectCount ?? 0} />
                    </Card>
                </Col>
                <Col xs={24} sm={12} xl={6}>
                    <Card loading={loading}>
                        <Statistic title={t("userPanels.profile.assetCount")} value={profileData?.stats.assetCount ?? 0} />
                    </Card>
                </Col>
            </Row>

            <Card title={t("userPanels.profile.accountDetails")}>
                <Descriptions column={{ xs: 1, sm: 2 }} bordered size="small">
                    <Descriptions.Item label={t("userPanels.profile.username")}>@{detail?.username}</Descriptions.Item>
                    <Descriptions.Item label={t("userPanels.profile.role")}>
                        <Tag color={detail?.role === "admin" ? "blue" : "default"}>
                            {detail?.role === "admin" ? t("userPanels.profile.roleAdmin") : t("userPanels.profile.roleUser")}
                        </Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label={t("userPanels.profile.status")}>
                        <Tag color={detail?.status === "active" ? "green" : "red"}>
                            {detail?.status === "active" ? t("userPanels.profile.statusActive") : t("userPanels.profile.statusDisabled")}
                        </Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label={t("userPanels.profile.cloudStorageQuota")}>
                        <div className="flex flex-wrap items-center gap-2">
                            <span>
                                {t("userPanels.profile.usedAndQuota", {
                                    used: formatBytes(detail?.storageUsedBytes ?? 0),
                                    quota: formatBytes(detail?.storageQuotaBytes ?? 0),
                                    expiry:
                                        detail?.storagePermanentBytes && detail?.storageTimedBytes && detail?.storageTimedExpiresAt
                                            ? ` · ${formatStorageQuotaCaption(
                                                  t,
                                                  {
                                                      permanentBytes: detail.storagePermanentBytes,
                                                      timedBytes: detail.storageTimedBytes,
                                                      timedExpiresAt: detail.storageTimedExpiresAt,
                                                  },
                                                  locale,
                                              )}`
                                            : detail?.storageQuotaExpiresAt
                                              ? t("userPanels.profile.expiryUntil", { time: new Date(detail.storageQuotaExpiresAt).toLocaleString(locale) })
                                              : t("userPanels.profile.expiryNone"),
                                })}
                            </span>
                            {detail?.storageQuotaExpiresAt && new Date(detail.storageQuotaExpiresAt).getTime() <= Date.now() ? (
                                <Tag color="red">{t("userPanels.profile.expired")}</Tag>
                            ) : (detail?.storageQuotaBytes ?? 0) <= 0 || (detail?.storageUsedBytes ?? 0) >= (detail?.storageQuotaBytes ?? 0) ? (
                                <Tag color="red">{t("userPanels.profile.quotaFullExpand")}</Tag>
                            ) : (
                                <Tag color="green">{t("userPanels.profile.statusActive")}</Tag>
                            )}
                        </div>
                    </Descriptions.Item>
                    {detail?.role === "admin" ? (
                        <Descriptions.Item label={t("userPanels.profile.webdavAssign")} span={2}>
                            {profileData?.webdav?.enabled ? (
                                <div className="flex flex-wrap items-center gap-2">
                                    <Tag color={profileData.webdav.isExpired ? "red" : "cyan"}>{profileData.webdav.directory}</Tag>
                                    {profileData.webdav.isExpired ? <Tag color="red">{t("userPanels.profile.expired")}</Tag> : null}
                                    {profileData.webdav.isQuotaExceeded ? <Tag color="volcano">{t("userPanels.profile.quotaExceededTag")}</Tag> : null}
                                    <Typography.Text type="secondary" className="text-xs">
                                        {t("userPanels.profile.webdavUsed", { used: formatBytes(profileData.webdav.usedBytes ?? 0) })}
                                        {profileData.webdav.quotaBytes
                                            ? ` / ${formatBytes(profileData.webdav.quotaBytes)}`
                                            : t("userPanels.profile.webdavUnlimited")}
                                        {profileData.webdav.expiresAt
                                            ? t("userPanels.profile.expiryUntil", { time: new Date(profileData.webdav.expiresAt).toLocaleString(locale) })
                                            : t("userPanels.profile.webdavPermanent")}
                                    </Typography.Text>
                                </div>
                            ) : (
                                <Tag>{t("userPanels.profile.unassigned")}</Tag>
                            )}
                        </Descriptions.Item>
                    ) : null}
                    <Descriptions.Item label={t("userPanels.profile.createdAt")}>
                        {profileData?.user.createdAt ? new Date(profileData.user.createdAt).toLocaleString(locale) : "—"}
                    </Descriptions.Item>
                    <Descriptions.Item label={t("userPanels.profile.lastLoginAt")}>
                        {profileData?.user.lastLoginAt ? new Date(profileData.user.lastLoginAt).toLocaleString(locale) : "—"}
                    </Descriptions.Item>
                </Descriptions>
            </Card>

            <Row gutter={[16, 16]}>
                <Col xs={24} lg={12}>
                    <Card
                        title={
                            <span className="inline-flex items-center gap-2">
                                <User className="size-4" />
                                {t("userPanels.profile.profileCardTitle")}
                            </span>
                        }
                    >
                        <div className="mb-4 flex items-center gap-3">
                            <Avatar size={48} src={avatarWatch || detail?.avatarUrl || undefined}>
                                {(detail?.displayName || detail?.username || "U").slice(0, 1).toUpperCase()}
                            </Avatar>
                            <div>
                                <div className="font-medium">{detail?.displayName || detail?.username}</div>
                                <Typography.Text type="secondary" className="text-xs">
                                    @{detail?.username}
                                </Typography.Text>
                            </div>
                        </div>
                        <Form form={profileForm} layout="vertical" onFinish={handleSaveProfile}>
                            <Form.Item
                                name="displayName"
                                label={t("userPanels.profile.displayName")}
                                rules={[{ required: true, message: t("userPanels.profile.displayNameReq") }]}
                            >
                                <Input maxLength={48} placeholder={t("userPanels.profile.displayNameReq")} />
                            </Form.Item>
                            <Form.Item
                                name="email"
                                label={
                                    <span className="inline-flex items-center gap-2">
                                        <span>{t("userPanels.profile.email")}</span>
                                        {detail?.email ? (
                                            detail.emailVerifiedAt ? (
                                                <Tag color="green" style={{ marginInlineEnd: 0 }}>
                                                    {t("userPanels.profile.emailVerified")}
                                                </Tag>
                                            ) : (
                                                <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                                                    {t("userPanels.profile.emailUnverified")}
                                                </Tag>
                                            )
                                        ) : null}
                                    </span>
                                }
                                rules={[
                                    ...(profileData?.requireEmailOnRegister && detail?.role !== "admin"
                                        ? [{ required: true, message: t("userPanels.profile.emailReq") }]
                                        : []),
                                    { type: "email" as const, message: t("userPanels.profile.emailInvalid") },
                                ]}
                            >
                                <Input placeholder="example@domain.com" />
                            </Form.Item>
                            {needsEmailVerifyCode ? (
                                <Form.Item
                                    name="emailCode"
                                    label={t("userPanels.profile.emailCode")}
                                    rules={[{ required: true, message: t("userPanels.profile.emailCodeReq") }]}
                                >
                                    <Space.Compact className="w-full">
                                        <Input placeholder={t("userPanels.profile.codePlaceholder")} maxLength={8} />
                                        <Button
                                            loading={bindEmailCodeSender.sending}
                                            disabled={bindEmailCodeSender.cooldown > 0}
                                            onClick={() => void handleSendBindEmailCode()}
                                        >
                                            {bindEmailCodeSender.cooldown > 0
                                                ? t("userPanels.profile.retryAfter", { seconds: bindEmailCodeSender.cooldown })
                                                : t("userPanels.profile.getCode")}
                                        </Button>
                                    </Space.Compact>
                                </Form.Item>
                            ) : null}
                            <Form.Item name="avatarUrl" label={t("userPanels.profile.avatarUrl")}>
                                <Input placeholder="https://..." />
                            </Form.Item>
                            <Button type="primary" htmlType="submit" icon={<Save className="size-4" />} loading={savingProfile}>
                                {t("userPanels.profile.saveProfile")}
                            </Button>
                        </Form>
                    </Card>
                </Col>

                <Col xs={24} lg={12}>
                    <Card
                        title={
                            <span className="inline-flex items-center gap-2">
                                <KeyRound className="size-4" />
                                {t("userPanels.profile.securityTitle")}
                            </span>
                        }
                        extra={
                            <Segmented
                                size="small"
                                value={passwordMode}
                                onChange={(val) => {
                                    setPasswordMode(val as "password" | "email");
                                    passwordForm.resetFields(["currentPassword", "emailCode"]);
                                }}
                                options={[
                                    { label: t("userPanels.profile.modePassword"), value: "password" },
                                    { label: t("userPanels.profile.modeEmail"), value: "email", disabled: !canResetByEmail },
                                ]}
                            />
                        }
                    >
                        {!canResetByEmail ? (
                            <Typography.Text type="secondary" className="mb-3 block text-xs">
                                {emailServiceEnabled ? t("userPanels.profile.emailResetHintEnabled") : t("userPanels.profile.emailResetHintDisabled")}
                            </Typography.Text>
                        ) : null}
                        <Form form={passwordForm} layout="vertical" initialValues={{ revokeOtherSessions: true }} onFinish={handleChangePassword}>
                            {passwordMode === "password" ? (
                                <Form.Item
                                    name="currentPassword"
                                    label={t("userPanels.profile.currentPassword")}
                                    rules={[{ required: true, message: t("userPanels.profile.currentPasswordReq") }]}
                                >
                                    <Input.Password placeholder={t("userPanels.profile.currentPasswordPlaceholder")} />
                                </Form.Item>
                            ) : (
                                <>
                                    <Form.Item label={t("userPanels.profile.receiveCodeEmail")}>
                                        <Input value={detail?.email || ""} disabled />
                                    </Form.Item>
                                    <Form.Item
                                        name="emailCode"
                                        label={t("userPanels.profile.emailCode")}
                                        rules={[{ required: true, message: t("userPanels.profile.emailCodeInputReq") }]}
                                    >
                                        <Space.Compact className="w-full">
                                            <Input placeholder={t("userPanels.profile.codePlaceholder")} maxLength={8} />
                                            <Button
                                                loading={changePasswordCodeSender.sending}
                                                disabled={changePasswordCodeSender.cooldown > 0}
                                                onClick={() => void handleSendChangePasswordCode()}
                                            >
                                                {changePasswordCodeSender.cooldown > 0
                                                    ? t("userPanels.profile.retryAfter", { seconds: changePasswordCodeSender.cooldown })
                                                    : t("userPanels.profile.sendCode")}
                                            </Button>
                                        </Space.Compact>
                                    </Form.Item>
                                </>
                            )}
                            <Form.Item
                                name="newPassword"
                                label={t("userPanels.profile.newPassword")}
                                rules={[
                                    { required: true, message: t("userPanels.profile.newPasswordReq") },
                                    { min: 6, message: t("userPanels.profile.newPasswordMin") },
                                ]}
                            >
                                <Input.Password placeholder={t("userPanels.profile.newPasswordPlaceholder")} />
                            </Form.Item>
                            <Form.Item
                                name="confirmPassword"
                                label={t("userPanels.profile.confirmPassword")}
                                dependencies={["newPassword"]}
                                rules={[
                                    { required: true, message: t("userPanels.profile.confirmPasswordReq") },
                                    ({ getFieldValue }) => ({
                                        validator(_, value) {
                                            if (!value || getFieldValue("newPassword") === value) return Promise.resolve();
                                            return Promise.reject(new Error(t("userPanels.profile.confirmMismatch")));
                                        },
                                    }),
                                ]}
                            >
                                <Input.Password placeholder={t("userPanels.profile.confirmPlaceholder")} />
                            </Form.Item>
                            <Form.Item name="revokeOtherSessions" label={t("userPanels.profile.revokeOtherSessions")} valuePropName="checked">
                                <Switch />
                            </Form.Item>
                            <Button type="primary" htmlType="submit" icon={<KeyRound className="size-4" />} loading={changingPassword}>
                                {t("userPanels.profile.updatePassword")}
                            </Button>
                        </Form>
                    </Card>
                </Col>
            </Row>

            <Card
                title={
                    <span className="inline-flex items-center gap-2">
                        <Bell className="size-4" />
                        {t("userPanels.profile.lowBalanceTitle")}
                    </span>
                }
            >
                {!emailServiceEnabled ? (
                    <Alert
                        type="info"
                        showIcon
                        className="mb-4"
                        message={t("userPanels.profile.mailDisabledTitle")}
                        description={t("userPanels.profile.mailDisabledDesc")}
                    />
                ) : !detail?.email ? (
                    <Alert
                        type="warning"
                        showIcon
                        className="mb-4"
                        message={t("userPanels.profile.noEmailTitle")}
                        description={t("userPanels.profile.noEmailDesc")}
                    />
                ) : null}
                <Form
                    form={alertForm}
                    layout="vertical"
                    initialValues={{ mode: "inherit", threshold: 10 }}
                    onFinish={handleSaveAlertSettings}
                >
                    <Row gutter={16} align="bottom">
                        <Col xs={24} xl={12}>
                            <Form.Item name="mode" label={t("userPanels.profile.alertPolicyLabel")}>
                                <Radio.Group className="flex flex-wrap gap-y-2">
                                    <Radio value="inherit">
                                        {t("userPanels.profile.alertInheritPrefix")}
                                        {profileData?.lowBalanceAlert?.platformEnabled
                                            ? t("userPanels.profile.alertBelowThreshold", { threshold: profileData.lowBalanceAlert.platformThreshold })
                                            : t("userPanels.profile.alertClosed")}
                                        )
                                    </Radio>
                                    <Radio value="custom_on">{t("userPanels.profile.alertCustom")}</Radio>
                                    <Radio value="off">{t("userPanels.profile.alertOff")}</Radio>
                                </Radio.Group>
                            </Form.Item>
                        </Col>
                        {alertModeWatch === "custom_on" ? (
                            <Col xs={24} sm={12} xl={6}>
                                <Form.Item
                                    name="threshold"
                                    label={t("userPanels.profile.thresholdLabel")}
                                    rules={[{ required: true, message: t("userPanels.profile.thresholdReq") }]}
                                >
                                    <InputNumber min={0} max={1000000} precision={2} className="w-full" />
                                </Form.Item>
                            </Col>
                        ) : null}
                        <Col xs={24} sm={12} xl={6}>
                            <Form.Item>
                                <Button type="primary" htmlType="submit" icon={<Save className="size-4" />} loading={savingAlert}>
                                    {t("userPanels.profile.saveAlertSettings")}
                                </Button>
                            </Form.Item>
                        </Col>
                    </Row>
                    <Typography.Text type="secondary" className="text-xs">
                        {t("userPanels.profile.alertRateLimitNote", { hours: profileData?.lowBalanceAlert?.cooldownHours ?? 24 })}
                        {profileData?.lowBalanceAlert?.lastAlertedAt
                            ? t("userPanels.profile.lastAlertedAt", {
                                  time: new Date(profileData.lowBalanceAlert.lastAlertedAt).toLocaleString(locale),
                              })
                            : ""}
                    </Typography.Text>
                </Form>
            </Card>

            <Card
                title={
                    <span className="inline-flex items-center gap-2">
                        <Laptop className="size-4" />
                        {t("userPanels.profile.sessionsTitle")}
                    </span>
                }
                extra={
                    <Space wrap>
                        <Popconfirm title={t("userPanels.profile.confirmRevokeOthers")} onConfirm={() => void handleRevokeOtherSessions()}>
                            <Button size="small" icon={<LogOut className="size-3.5" />}>
                                {t("userPanels.profile.revokeOthers")}
                            </Button>
                        </Popconfirm>
                        <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={sessionsLoading} onClick={() => void loadSessions(true)}>
                            {t("common.refresh")}
                        </Button>
                    </Space>
                }
            >
                <Table<AccountSessionItem>
                    rowKey="id"
                    size="small"
                    className={ADMIN_TABLE_CLASS}
                    scroll={ADMIN_TABLE_SCROLL}
                    loading={sessionsLoading}
                    dataSource={sessions}
                    pagination={false}
                    columns={[
                        {
                            title: t("userPanels.profile.colDevice"),
                            key: "ua",
                            width: 340,
                            render: (_, record) => (
                                <div className="flex max-w-[320px] items-center gap-2">
                                    <Typography.Text ellipsis={{ tooltip: record.userAgent }} className="min-w-0 flex-1">
                                        {record.userAgent || t("userPanels.profile.unknownDevice")}
                                    </Typography.Text>
                                    {record.isCurrent ? (
                                        <Tag color="green" style={{ marginInlineEnd: 0 }}>
                                            {t("userPanels.profile.currentDevice")}
                                        </Tag>
                                    ) : null}
                                </div>
                            ),
                        },
                        { title: t("userPanels.profile.colIp"), dataIndex: "ip", width: 130, render: (v: string) => v || "—" },
                        { title: t("userPanels.profile.colLoginTime"), dataIndex: "createdAt", width: 170, render: (v: string) => new Date(v).toLocaleString(locale) },
                        { title: t("userPanels.profile.colExpiresAt"), dataIndex: "expiresAt", width: 170, render: (v: string) => new Date(v).toLocaleString(locale) },
                        {
                            title: t("userPanels.profile.colActions"),
                            key: "actions",
                            fixed: "right",
                            width: 75,
                            render: (_, record) =>
                                record.isCurrent ? (
                                    <Typography.Text type="secondary" className="text-xs">
                                        {t("userPanels.profile.currentShort")}
                                    </Typography.Text>
                                ) : (
                                    <TableRowActions
                                        items={[
                                            {
                                                key: "revoke",
                                                label: t("userPanels.profile.revokeAction"),
                                                danger: true,
                                                confirm: t("userPanels.profile.confirmRevoke"),
                                                onClick: () => void handleRevokeSession(record.id),
                                            },
                                        ]}
                                    />
                                ),
                        },
                    ]}
                />
            </Card>
        </div>
    );
}

