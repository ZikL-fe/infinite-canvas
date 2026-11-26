/** 管理后台系统设置面板：统一管理认证策略、邮件服务、WebDAV、过期存储清理与统计日志设置。 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Card, Col, Form, Input, InputNumber, Popconfirm, Row, Space, Spin, Switch, Table, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { HardDrive, Mail, RefreshCw, Save, Send, Trash2, Wifi } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatBytes } from "@/pages/admin/admin-utils";
import { ADMIN_TABLE_CLASS, ADMIN_TABLE_SCROLL } from "@/pages/admin/components/table-row-actions";
import {
    adminApi,
    type AdminMailSettingsForm,
    type AdminStorageExpiryPolicyForm,
    type PlatformAnalyticsPolicy,
    type StorageExpirySweepItem,
    type StorageExpirySweepResult,
} from "@/services/api/server";
import { syncRuntimeSettings } from "@/services/cloud-sync";

export type SystemSettingsSection = "auth" | "mail" | "webdav" | "storage-expiry" | "analytics";

type WebdavPlatformForm = {
    enabled: boolean;
    url: string;
    username: string;
    password?: string;
    baseDirectory: string;
    autoAssignNewUsers: boolean;
};

export function AdminSystemSettingsPanel({ section }: { section: SystemSettingsSection }) {
    const { t } = useTranslation();
    const { message } = App.useApp();

    const [loading, setLoading] = useState(true);

    const [allowRegister, setAllowRegister] = useState(true);
    const [requireEmailOnRegister, setRequireEmailOnRegister] = useState(false);
    const [authPolicySaving, setAuthPolicySaving] = useState(false);

    const [webdavForm] = Form.useForm<WebdavPlatformForm>();
    const [webdavPasswordPreview, setWebdavPasswordPreview] = useState("");
    const [webdavSaving, setWebdavSaving] = useState(false);
    const [webdavTesting, setWebdavTesting] = useState(false);

    const [mailForm] = Form.useForm<AdminMailSettingsForm>();
    const [mailPasswordPreview, setMailPasswordPreview] = useState("");
    const [mailReady, setMailReady] = useState(false);
    const [mailSaving, setMailSaving] = useState(false);
    const [mailTesting, setMailTesting] = useState(false);
    const [testMailTo, setTestMailTo] = useState("");

    const [storageExpiryForm] = Form.useForm<AdminStorageExpiryPolicyForm>();
    const [storageExpiryEnabled, setStorageExpiryEnabled] = useState(false);
    const [storageExpirySaving, setStorageExpirySaving] = useState(false);
    const [storageExpiryPreviewing, setStorageExpiryPreviewing] = useState(false);
    const [storageExpiryRunning, setStorageExpiryRunning] = useState(false);
    const [cleaningSingleUserId, setCleaningSingleUserId] = useState<string | null>(null);
    const [storageExpiryResult, setStorageExpiryResult] = useState<StorageExpirySweepResult | null>(null);

    const [analyticsForm] = Form.useForm<PlatformAnalyticsPolicy>();
    const [analyticsSaving, setAnalyticsSaving] = useState(false);
    const [cleaningLogs, setCleaningLogs] = useState(false);

    const loadSettings = useCallback(async () => {
        setLoading(true);
        try {
            const [authRes, webdavRes, mailRes, expiryRes, analyticsRes] = await Promise.all([
                adminApi.getAuthSettings(),
                adminApi.getWebdavSettings(),
                adminApi.getMailSettings(),
                adminApi.getStorageExpirySettings(),
                adminApi.getAnalyticsSettings(),
            ]);
            setAllowRegister(authRes.allowRegister);
            setRequireEmailOnRegister(authRes.requireEmailOnRegister);
            setWebdavPasswordPreview(webdavRes.passwordPreview);
            webdavForm.setFieldsValue({
                enabled: webdavRes.enabled,
                url: webdavRes.url,
                username: webdavRes.username,
                password: "",
                baseDirectory: webdavRes.baseDirectory,
                autoAssignNewUsers: webdavRes.autoAssignNewUsers,
            });
            setMailPasswordPreview(mailRes.passwordPreview);
            setMailReady(mailRes.ready);
            mailForm.setFieldsValue({
                enabled: mailRes.enabled,
                host: mailRes.host,
                port: mailRes.port,
                secure: mailRes.secure,
                username: mailRes.username,
                password: "",
                fromName: mailRes.fromName,
                fromAddress: mailRes.fromAddress,
                lowBalanceAlertEnabled: mailRes.lowBalanceAlertEnabled,
                lowBalanceThreshold: mailRes.lowBalanceThreshold,
                lowBalanceCooldownHours: mailRes.lowBalanceCooldownHours,
            });
            setStorageExpiryEnabled(expiryRes.enabled);
            storageExpiryForm.setFieldsValue({
                enabled: expiryRes.enabled,
                gracePeriodDays: expiryRes.gracePeriodDays,
                preExpiryWarnDays: expiryRes.preExpiryWarnDays,
                cleanupWorkspaceData: expiryRes.cleanupWorkspaceData,
                exemptAdmins: expiryRes.exemptAdmins,
                cleanupOverQuotaWithoutExpiry: expiryRes.cleanupOverQuotaWithoutExpiry,
            });
            analyticsForm.setFieldsValue({
                sampleIntervalMinutes: analyticsRes.sampleIntervalMinutes,
                logRetentionDays: analyticsRes.logRetentionDays,
            });
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.loadSettingsFailed"));
        } finally {
            setLoading(false);
        }
    }, [analyticsForm, mailForm, message, storageExpiryForm, t, webdavForm]);

    useEffect(() => {
        void loadSettings();
    }, [loadSettings]);

    const handleUpdateAuthPolicy = async (patch: { allowRegister?: boolean; requireEmailOnRegister?: boolean }) => {
        setAuthPolicySaving(true);
        try {
            const res = await adminApi.saveAuthSettings({
                allowRegister: patch.allowRegister ?? allowRegister,
                requireEmailOnRegister: patch.requireEmailOnRegister ?? requireEmailOnRegister,
            });
            setAllowRegister(res.allowRegister);
            setRequireEmailOnRegister(res.requireEmailOnRegister);
            if (patch.allowRegister !== undefined) {
                message.success(res.allowRegister ? t("admin.messages.registerOpened") : t("admin.messages.registerClosed"));
            } else {
                message.success(res.requireEmailOnRegister ? t("admin.messages.requireEmailEnabled") : t("admin.messages.requireEmailDisabled"));
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.saveFailed"));
        } finally {
            setAuthPolicySaving(false);
        }
    };

    const handleSaveMailSettings = async (values: AdminMailSettingsForm) => {
        setMailSaving(true);
        try {
            const res = await adminApi.saveMailSettings(values);
            setMailReady(res.ready);
            setMailPasswordPreview(res.passwordPreview);
            if (!values.enabled) {
                setRequireEmailOnRegister(false);
            }
            mailForm.setFieldValue("password", "");
            message.success(t("admin.messages.mailSaved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.mailSaveFailed"));
        } finally {
            setMailSaving(false);
        }
    };

    const handleTestMailSettings = async () => {
        const cleanTo = testMailTo.trim();
        if (!cleanTo) {
            message.warning(t("admin.messages.testMailToWarning"));
            return;
        }
        try {
            const values = await mailForm.validateFields();
            setMailTesting(true);
            const res = await adminApi.testMailSettings({ ...values, testTo: cleanTo });
            message.success(res.message);
        } catch (error) {
            if (error instanceof Error) message.error(error.message);
        } finally {
            setMailTesting(false);
        }
    };

    const handleSavePlatformWebdav = async (values: WebdavPlatformForm) => {
        setWebdavSaving(true);
        try {
            await adminApi.saveWebdavSettings(values);
            message.success(t("admin.messages.webdavSaved"));
            void loadSettings();
            void syncRuntimeSettings();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.webdavSaveFailed"));
        } finally {
            setWebdavSaving(false);
        }
    };

    const handleTestPlatformWebdav = async () => {
        try {
            const values = await webdavForm.validateFields();
            setWebdavTesting(true);
            const res = await adminApi.testWebdavSettings(values);
            message.success(res.message);
        } catch (error) {
            if (error instanceof Error) message.error(error.message);
        } finally {
            setWebdavTesting(false);
        }
    };

    const handleSaveStorageExpiryPolicy = async (values: AdminStorageExpiryPolicyForm) => {
        setStorageExpirySaving(true);
        try {
            const stored = storageExpiryForm.getFieldsValue(true);
            const res = await adminApi.saveStorageExpirySettings({
                enabled: Boolean(values.enabled ?? stored.enabled ?? storageExpiryEnabled),
                gracePeriodDays: Number(values.gracePeriodDays ?? stored.gracePeriodDays ?? 7),
                preExpiryWarnDays: Number(values.preExpiryWarnDays ?? stored.preExpiryWarnDays ?? 3),
                cleanupWorkspaceData: Boolean(values.cleanupWorkspaceData ?? stored.cleanupWorkspaceData ?? true),
                exemptAdmins: Boolean(values.exemptAdmins ?? stored.exemptAdmins ?? true),
                cleanupOverQuotaWithoutExpiry: Boolean(values.cleanupOverQuotaWithoutExpiry ?? stored.cleanupOverQuotaWithoutExpiry ?? true),
            });
            setStorageExpiryEnabled(res.enabled);
            setMailReady(res.mailReady);
            storageExpiryForm.setFieldsValue({
                enabled: res.enabled,
                gracePeriodDays: res.gracePeriodDays,
                preExpiryWarnDays: res.preExpiryWarnDays,
                cleanupWorkspaceData: res.cleanupWorkspaceData,
                exemptAdmins: res.exemptAdmins,
                cleanupOverQuotaWithoutExpiry: res.cleanupOverQuotaWithoutExpiry,
            });
            message.success(t("admin.messages.expirySaved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.expirySaveFailed"));
        } finally {
            setStorageExpirySaving(false);
        }
    };

    const handleRunStorageExpirySweep = async (dryRun: boolean) => {
        if (dryRun) setStorageExpiryPreviewing(true);
        else setStorageExpiryRunning(true);
        try {
            const res = await adminApi.runStorageExpirySweep({ dryRun });
            setStorageExpiryResult(res);
            if (dryRun) {
                message.success(t("admin.messages.expiryPreviewDone", { count: res.eligibleUsers }));
            } else {
                message.success(
                    t("admin.messages.expirySweepDone", {
                        warned: res.preExpiryWarned,
                        noticed: res.expiredNoticed,
                        cleaned: res.cleanedUsers,
                        freed: formatBytes(res.freedBytesTotal),
                    }),
                );
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.expirySweepFailed"));
        } finally {
            if (dryRun) setStorageExpiryPreviewing(false);
            else setStorageExpiryRunning(false);
        }
    };

    const handleRunSingleUserStorageSweep = async (row: StorageExpirySweepItem) => {
        if (cleaningSingleUserId) return;
        setCleaningSingleUserId(row.userId);
        try {
            const res = await adminApi.runStorageExpirySweep({ dryRun: false, userId: row.userId });
            const targetItem = res.items[0];
            if (targetItem?.error) {
                message.warning(targetItem.error);
            } else if (row.action === "cleaned" || row.action === "over_quota_cleaned") {
                message.success(
                    t("admin.messages.expirySingleCleaned", {
                        user: row.displayName || row.username,
                        count: targetItem?.deletedMediaCount ?? 0,
                        freed: formatBytes(targetItem?.freedBytes ?? 0),
                    }),
                );
            } else {
                message.success(t("admin.messages.expirySingleNoticed", { user: row.displayName || row.username }));
            }
            const nextPreview = await adminApi.runStorageExpirySweep({ dryRun: true });
            setStorageExpiryResult(nextPreview);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.expirySweepFailed"));
        } finally {
            setCleaningSingleUserId(null);
        }
    };

    const handleSaveAnalyticsSettings = async (values: PlatformAnalyticsPolicy) => {
        setAnalyticsSaving(true);
        try {
            const res = await adminApi.saveAnalyticsSettings({
                sampleIntervalMinutes: Number(values.sampleIntervalMinutes || 5),
                logRetentionDays: Number(values.logRetentionDays || 0),
            });
            analyticsForm.setFieldsValue({
                sampleIntervalMinutes: res.sampleIntervalMinutes,
                logRetentionDays: res.logRetentionDays,
            });
            message.success(t("admin.messages.analyticsSaved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.analyticsSaveFailed"));
        } finally {
            setAnalyticsSaving(false);
        }
    };

    const handleCleanupExpiredLogs = async () => {
        const rawDays = Number(analyticsForm.getFieldValue("logRetentionDays") || 0);
        if (!Number.isFinite(rawDays) || rawDays <= 0) {
            message.warning(t("admin.messages.logsCleanupWarning"));
            return;
        }
        setCleaningLogs(true);
        try {
            const res = await adminApi.cleanupUsageLogs(rawDays);
            message.success(t("admin.messages.logsCleaned", { days: res.retentionDays, count: res.deletedCount }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.logsCleanupFailed"));
        } finally {
            setCleaningLogs(false);
        }
    };

    if (section === "auth") {
        return (
            <Spin spinning={loading}>
                <Card title={t("admin.settingsTab.auth.cardTitle")}>
                    <div className="flex flex-col gap-4">
                        <div className="flex items-start justify-between gap-4 sm:items-center">
                            <div className="min-w-0 flex-1">
                                <div className="font-medium">{t("admin.settingsTab.auth.allowRegister")}</div>
                                <Typography.Text type="secondary">{t("admin.settingsTab.auth.allowRegisterDesc")}</Typography.Text>
                            </div>
                            <Switch
                                className="shrink-0"
                                checked={allowRegister}
                                loading={authPolicySaving}
                                onChange={(checked) => void handleUpdateAuthPolicy({ allowRegister: checked })}
                            />
                        </div>
                        <div className="flex items-start justify-between gap-4 border-t border-black/5 pt-4 sm:items-center dark:border-white/5">
                            <div className="min-w-0 flex-1">
                                <div className="font-medium">{t("admin.settingsTab.auth.requireEmail")}</div>
                                <Typography.Text type="secondary">{t("admin.settingsTab.auth.requireEmailDesc")}</Typography.Text>
                            </div>
                            <Switch
                                className="shrink-0"
                                checked={requireEmailOnRegister}
                                disabled={!mailReady && !requireEmailOnRegister}
                                loading={authPolicySaving}
                                onChange={(checked) => void handleUpdateAuthPolicy({ requireEmailOnRegister: checked })}
                            />
                        </div>
                    </div>
                </Card>
            </Spin>
        );
    }

    if (section === "mail") {
        return (
            <Spin spinning={loading}>
                <Card
                    title={
                        <span className="inline-flex items-center gap-2">
                            <Mail className="size-4" />
                            {t("admin.settingsTab.mail.cardTitle")}
                        </span>
                    }
                    extra={<Tag color={mailReady ? "green" : "default"}>{mailReady ? t("admin.settingsTab.mail.ready") : t("admin.settingsTab.mail.notReady")}</Tag>}
                >
                    <Form
                        form={mailForm}
                        layout="vertical"
                        initialValues={{
                            enabled: false,
                            port: 465,
                            secure: true,
                            fromName: t("admin.settingsTab.mail.defaultFromName"),
                            lowBalanceAlertEnabled: true,
                            lowBalanceThreshold: 10,
                            lowBalanceCooldownHours: 24,
                        }}
                        onFinish={handleSaveMailSettings}
                    >
                        <Row gutter={16}>
                            <Col xs={24} md={12}>
                                <Form.Item name="enabled" label={t("admin.settingsTab.mail.enabled")} valuePropName="checked">
                                    <Switch />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={12}>
                                <Form.Item name="secure" label={t("admin.settingsTab.mail.secure")} valuePropName="checked">
                                    <Switch />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={12}>
                                <Form.Item name="host" label={t("admin.settingsTab.mail.host")}>
                                    <Input placeholder={t("admin.settingsTab.mail.hostPlaceholder")} />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={12}>
                                <Form.Item name="port" label={t("admin.settingsTab.mail.port")}>
                                    <InputNumber min={1} max={65535} className="w-full" placeholder="465" />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={12}>
                                <Form.Item name="username" label={t("admin.settingsTab.mail.username")}>
                                    <Input placeholder={t("admin.settingsTab.mail.usernamePlaceholder")} />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={12}>
                                <Form.Item
                                    name="password"
                                    label={`${t("admin.settingsTab.mail.passwordPrefix")}${mailPasswordPreview ? t("admin.settingsTab.mail.passwordSavedSuffix", { preview: mailPasswordPreview }) : ""}`}
                                >
                                    <Input.Password placeholder={mailPasswordPreview ? t("admin.settingsTab.mail.passwordKeepPlaceholder") : t("admin.settingsTab.mail.passwordInputPlaceholder")} />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={12}>
                                <Form.Item name="fromName" label={t("admin.settingsTab.mail.fromName")}>
                                    <Input placeholder={t("admin.settingsTab.mail.defaultFromName")} />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={12}>
                                <Form.Item
                                    name="fromAddress"
                                    label={t("admin.settingsTab.mail.fromAddress")}
                                    rules={[{ type: "email", message: t("admin.settingsTab.mail.fromAddressInvalid") }]}
                                >
                                    <Input placeholder="noreply@example.com" />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={8}>
                                <Form.Item name="lowBalanceAlertEnabled" label={t("admin.settingsTab.mail.lowBalanceEnabled")} valuePropName="checked">
                                    <Switch />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={8}>
                                <Form.Item name="lowBalanceThreshold" label={t("admin.settingsTab.mail.lowBalanceThreshold")}>
                                    <InputNumber min={0} max={1000000} precision={2} className="w-full" />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={8}>
                                <Form.Item name="lowBalanceCooldownHours" label={t("admin.settingsTab.mail.lowBalanceCooldown")}>
                                    <InputNumber min={1} max={720} className="w-full" />
                                </Form.Item>
                            </Col>
                        </Row>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="flex flex-wrap items-center gap-2">
                                <Input
                                    value={testMailTo}
                                    onChange={(e) => setTestMailTo(e.target.value)}
                                    placeholder={t("admin.settingsTab.mail.testToPlaceholder")}
                                    className="w-full! sm:w-[240px]!"
                                />
                                <Button icon={<Send className="size-4" />} onClick={() => void handleTestMailSettings()} loading={mailTesting}>
                                    {t("admin.settingsTab.mail.sendTestBtn")}
                                </Button>
                            </div>
                            <Button type="primary" htmlType="submit" icon={<Save className="size-4" />} loading={mailSaving}>
                                {t("admin.settingsTab.mail.saveBtn")}
                            </Button>
                        </div>
                    </Form>
                </Card>
            </Spin>
        );
    }

    if (section === "webdav") {
        return (
            <Spin spinning={loading}>
                <Card title={t("admin.settingsTab.webdav.cardTitle")}>
                    <Form
                        form={webdavForm}
                        layout="vertical"
                        initialValues={{ enabled: false, baseDirectory: "infinite-canvas", autoAssignNewUsers: false }}
                        onFinish={handleSavePlatformWebdav}
                    >
                        <Row gutter={16}>
                            <Col xs={24} md={12}>
                                <Form.Item name="enabled" label={t("admin.settingsTab.webdav.enabled")} valuePropName="checked">
                                    <Switch />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={12}>
                                <Form.Item name="autoAssignNewUsers" label={t("admin.settingsTab.webdav.autoAssign")} valuePropName="checked">
                                    <Switch />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={12}>
                                <Form.Item name="url" label={t("admin.settingsTab.webdav.url")}>
                                    <Input placeholder="https://nas.example.com/webdav" />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={12}>
                                <Form.Item name="baseDirectory" label={t("admin.settingsTab.webdav.baseDir")}>
                                    <Input placeholder="infinite-canvas" />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={12}>
                                <Form.Item name="username" label={t("admin.settingsTab.webdav.username")}>
                                    <Input placeholder={t("admin.settingsTab.webdav.usernamePlaceholder")} />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={12}>
                                <Form.Item
                                    name="password"
                                    label={`${t("admin.settingsTab.webdav.passwordPrefix")}${webdavPasswordPreview ? t("admin.settingsTab.webdav.passwordSavedSuffix", { preview: webdavPasswordPreview }) : ""}`}
                                >
                                    <Input.Password placeholder={webdavPasswordPreview ? t("admin.settingsTab.webdav.passwordKeepPlaceholder") : t("admin.settingsTab.webdav.passwordInputPlaceholder")} />
                                </Form.Item>
                            </Col>
                        </Row>
                        <Space wrap>
                            <Button icon={<Wifi className="size-4" />} onClick={() => void handleTestPlatformWebdav()} loading={webdavTesting}>
                                {t("admin.settingsTab.webdav.testBtn")}
                            </Button>
                            <Button type="primary" htmlType="submit" icon={<Save className="size-4" />} loading={webdavSaving}>
                                {t("admin.settingsTab.webdav.saveBtn")}
                            </Button>
                        </Space>
                    </Form>
                </Card>
            </Spin>
        );
    }

    if (section === "storage-expiry") {
        return (
            <Spin spinning={loading}>
                <Card
                    title={
                        <span className="inline-flex items-center gap-2">
                            <HardDrive className="size-4" />
                            {t("admin.settingsTab.storageExpiry.cardTitle")}
                        </span>
                    }
                    extra={<Tag color={storageExpiryEnabled ? "green" : "default"}>{storageExpiryEnabled ? t("admin.settingsTab.storageExpiry.sweepOn") : t("admin.settingsTab.storageExpiry.sweepOff")}</Tag>}
                >
                    <Alert
                        type="info"
                        showIcon
                        className="mb-4"
                        title={t("admin.settingsTab.storageExpiry.flowTitle")}
                        description={
                            <div className="space-y-1 text-xs leading-6">
                                <div>{t("admin.settingsTab.storageExpiry.flowStep1")}</div>
                                <div>{t("admin.settingsTab.storageExpiry.flowStep2")}</div>
                                <div>{t("admin.settingsTab.storageExpiry.flowStep3")}</div>
                                <div>{t("admin.settingsTab.storageExpiry.flowStep4")}</div>
                            </div>
                        }
                    />
                    <Form
                        form={storageExpiryForm}
                        layout="vertical"
                        initialValues={{
                            enabled: false,
                            gracePeriodDays: 7,
                            preExpiryWarnDays: 3,
                            cleanupWorkspaceData: true,
                            exemptAdmins: true,
                            cleanupOverQuotaWithoutExpiry: true,
                        }}
                        onFinish={handleSaveStorageExpiryPolicy}
                    >
                        <Row gutter={16}>
                            <Col xs={24} md={6}>
                                <Form.Item name="enabled" label={t("admin.settingsTab.storageExpiry.enabledLabel")} valuePropName="checked">
                                    <Switch />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={6}>
                                <Form.Item name="exemptAdmins" label={t("admin.settingsTab.storageExpiry.exemptAdminsLabel")} valuePropName="checked">
                                    <Switch />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={6}>
                                <Form.Item name="cleanupOverQuotaWithoutExpiry" label={t("admin.settingsTab.storageExpiry.cleanupOverQuotaLabel")} valuePropName="checked">
                                    <Switch />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={6}>
                                <Form.Item name="cleanupWorkspaceData" label={t("admin.settingsTab.storageExpiry.cleanupWorkspaceLabel")} valuePropName="checked">
                                    <Switch />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={12}>
                                <Form.Item name="preExpiryWarnDays" label={t("admin.settingsTab.storageExpiry.warnDaysLabel")}>
                                    <InputNumber min={0} max={30} precision={0} className="w-full" />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={12}>
                                <Form.Item name="gracePeriodDays" label={t("admin.settingsTab.storageExpiry.graceDaysLabel")}>
                                    <InputNumber min={1} max={365} precision={0} className="w-full" />
                                </Form.Item>
                            </Col>
                        </Row>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <Space wrap>
                                <Button type="primary" htmlType="submit" icon={<Save className="size-4" />} loading={storageExpirySaving}>
                                    {t("admin.settingsTab.storageExpiry.savePolicyBtn")}
                                </Button>
                                <Button
                                    icon={<RefreshCw className="size-4" />}
                                    onClick={() => void handleRunStorageExpirySweep(true)}
                                    loading={storageExpiryPreviewing}
                                    disabled={storageExpiryRunning}
                                >
                                    {t("admin.settingsTab.storageExpiry.previewBtn")}
                                </Button>
                                <Popconfirm
                                    title={t("admin.settingsTab.storageExpiry.confirmRunTitle")}
                                    description={t("admin.settingsTab.storageExpiry.confirmRunDesc")}
                                    okText={t("admin.settingsTab.storageExpiry.confirmRunOk")}
                                    cancelText={t("common.cancel")}
                                    onConfirm={() => void handleRunStorageExpirySweep(false)}
                                >
                                    <Button danger icon={<Trash2 className="size-4" />} loading={storageExpiryRunning} disabled={storageExpiryPreviewing}>
                                        {t("admin.settingsTab.storageExpiry.runNowBtn")}
                                    </Button>
                                </Popconfirm>
                            </Space>
                            {!mailReady ? <Typography.Text type="warning">{t("admin.settingsTab.storageExpiry.mailNotReadyTip")}</Typography.Text> : null}
                        </div>
                    </Form>

                    {storageExpiryResult ? (
                        <div className="mt-6 space-y-3 border-t border-black/5 pt-4 dark:border-white/5">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <Space wrap>
                                    <Tag color={storageExpiryResult.dryRun ? "blue" : "green"}>
                                        {storageExpiryResult.dryRun ? t("admin.settingsTab.storageExpiry.dryRunTag") : t("admin.settingsTab.storageExpiry.liveRunTag")}
                                    </Tag>
                                    <Tag>{t("admin.settingsTab.storageExpiry.scannedUsers", { count: storageExpiryResult.scannedUsers })}</Tag>
                                    <Tag>{t("admin.settingsTab.storageExpiry.eligibleUsers", { count: storageExpiryResult.eligibleUsers })}</Tag>
                                    <Tag color="gold">{t("admin.settingsTab.storageExpiry.warnedCount", { count: storageExpiryResult.preExpiryWarned })}</Tag>
                                    <Tag color="orange">{t("admin.settingsTab.storageExpiry.noticedCount", { count: storageExpiryResult.expiredNoticed })}</Tag>
                                    <Tag color="red">{t("admin.settingsTab.storageExpiry.cleanedCount", { count: storageExpiryResult.cleanedUsers })}</Tag>
                                    <Tag color="purple">{t("admin.settingsTab.storageExpiry.freedBytes", { size: formatBytes(storageExpiryResult.freedBytesTotal) })}</Tag>
                                    {storageExpiryResult.failedCount > 0 ? <Tag color="error">{t("admin.settingsTab.storageExpiry.failedCount", { count: storageExpiryResult.failedCount })}</Tag> : null}
                                </Space>
                                <Typography.Text type="secondary" className="text-xs">
                                    {t("admin.settingsTab.storageExpiry.executedAt", { time: dayjs(storageExpiryResult.executedAt).format("YYYY-MM-DD HH:mm:ss") })}
                                </Typography.Text>
                            </div>
                            {storageExpiryResult.truncated ? (
                                <Alert type="warning" showIcon title={t("admin.settingsTab.storageExpiry.truncatedAlert")} />
                            ) : null}
                            <Table<StorageExpirySweepItem>
                                size="small"
                                className={ADMIN_TABLE_CLASS}
                                rowKey={(row) => `${row.userId}-${row.action}`}
                                dataSource={storageExpiryResult.items}
                                pagination={{ defaultPageSize: 10, showSizeChanger: true, pageSizeOptions: [10, 20, 30, 50, 100], showTotal: (count) => t("common.totalItems", { count }) }}
                                scroll={ADMIN_TABLE_SCROLL}
                                locale={{ emptyText: t("admin.settingsTab.storageExpiry.emptyText") }}
                                columns={[
                                    {
                                        title: t("admin.settingsTab.storageExpiry.colUser"),
                                        width: 120,
                                        render: (_, row) => <span className="font-medium">{row.displayName || row.username}</span>,
                                    },
                                    {
                                        title: t("admin.settingsTab.storageExpiry.colUsername"),
                                        dataIndex: "username",
                                        width: 110,
                                        render: (username: string) => <Typography.Text type="secondary">@{username}</Typography.Text>,
                                    },
                                    {
                                        title: t("admin.settingsTab.storageExpiry.colEmail"),
                                        width: 180,
                                        render: (_, row) => row.email || <Typography.Text type="secondary">{t("admin.settingsTab.storageExpiry.unboundEmail")}</Typography.Text>,
                                    },
                                    {
                                        title: t("admin.settingsTab.storageExpiry.colAction"),
                                        width: 120,
                                        render: (_, row) => {
                                            if (row.action === "pre_expiry_warn") return <Tag color="gold" style={{ marginInlineEnd: 0 }}>{t("admin.settingsTab.storageExpiry.actionPreWarn")}</Tag>;
                                            if (row.action === "expired_notice") return <Tag color="orange" style={{ marginInlineEnd: 0 }}>{t("admin.settingsTab.storageExpiry.actionExpiredNotice")}</Tag>;
                                            if (row.action === "over_quota_cleaned") {
                                                return <Tag color="volcano" style={{ marginInlineEnd: 0 }}>{storageExpiryResult.dryRun ? t("admin.settingsTab.storageExpiry.actionOverQuotaPending") : t("admin.settingsTab.storageExpiry.actionOverQuotaDone")}</Tag>;
                                            }
                                            return <Tag color="red" style={{ marginInlineEnd: 0 }}>{storageExpiryResult.dryRun ? t("admin.settingsTab.storageExpiry.actionExpiredPending") : t("admin.settingsTab.storageExpiry.actionExpiredDone")}</Tag>;
                                        },
                                    },
                                    {
                                        title: t("admin.settingsTab.storageExpiry.colExpiresAt"),
                                        width: 150,
                                        render: (_, row) =>
                                            row.expiresAt ? (
                                                dayjs(row.expiresAt).format("YYYY-MM-DD HH:mm")
                                            ) : (
                                                <Typography.Text type="secondary">{t("admin.settingsTab.storageExpiry.permanentOverQuota")}</Typography.Text>
                                            ),
                                    },
                                    {
                                        title: t("admin.settingsTab.storageExpiry.colGraceEndsAt"),
                                        width: 150,
                                        render: (_, row) => (row.graceEndsAt ? dayjs(row.graceEndsAt).format("YYYY-MM-DD HH:mm") : "—"),
                                    },
                                    {
                                        title: t("admin.settingsTab.storageExpiry.colUsedBytes"),
                                        width: 100,
                                        render: (_, row) => formatBytes(row.usedBytes),
                                    },
                                    {
                                        title: t("admin.settingsTab.storageExpiry.colQuotaBytes"),
                                        width: 100,
                                        render: (_, row) => formatBytes(row.quotaBytes),
                                    },
                                    {
                                        title: t("admin.settingsTab.storageExpiry.colCleanupMedia"),
                                        width: 150,
                                        render: (_, row) =>
                                            row.action === "cleaned" || row.action === "over_quota_cleaned"
                                                ? t("admin.settingsTab.storageExpiry.cleanupMedia", {
                                                      count: row.deletedMediaCount,
                                                      size: formatBytes(row.freedBytes),
                                                  })
                                                : "—",
                                    },
                                    {
                                        title: t("admin.settingsTab.storageExpiry.colCleanupWorkspace"),
                                        width: 170,
                                        render: (_, row) =>
                                            (row.action === "cleaned" || row.action === "over_quota_cleaned") &&
                                            (row.deletedCanvasCount || row.deletedWorkbenchCount || row.deletedAssetCount)
                                                ? t("admin.settingsTab.storageExpiry.cleanupWorkspace", {
                                                      canvas: row.deletedCanvasCount,
                                                      workbench: row.deletedWorkbenchCount,
                                                      assets: row.deletedAssetCount,
                                                  })
                                                : "—",
                                    },
                                    {
                                        title: t("admin.settingsTab.storageExpiry.colEmailStatus"),
                                        width: 150,
                                        render: (_, row) =>
                                            row.error ? (
                                                <Typography.Text type="danger" className="text-xs">
                                                    {row.error}
                                                </Typography.Text>
                                            ) : storageExpiryResult.dryRun ? (
                                                <Typography.Text type="secondary" className="text-xs">
                                                    {t("admin.settingsTab.storageExpiry.previewPending")}
                                                </Typography.Text>
                                            ) : row.emailSent ? (
                                                <Tag color="green">{t("admin.settingsTab.storageExpiry.emailSent")}</Tag>
                                            ) : (
                                                <Tag>{t("admin.settingsTab.storageExpiry.emailSkipped")}</Tag>
                                            ),
                                    },
                                    {
                                        title: t("common.actions"),
                                        key: "actions",
                                        fixed: "right",
                                        width: 110,
                                        render: (_, row) => {
                                            if (!storageExpiryResult.dryRun) {
                                                return (
                                                    <Typography.Text type="secondary" className="text-xs">
                                                        {t("admin.settingsTab.storageExpiry.handled")}
                                                    </Typography.Text>
                                                );
                                            }
                                            const isCleanup = row.action === "cleaned" || row.action === "over_quota_cleaned";
                                            const isBusy = cleaningSingleUserId === row.userId;
                                            return (
                                                <Popconfirm
                                                    title={
                                                        isCleanup
                                                            ? t("admin.settingsTab.storageExpiry.confirmSingleCleanTitle", {
                                                                  user: row.displayName || row.username,
                                                              })
                                                            : t("admin.settingsTab.storageExpiry.confirmSingleNoticeTitle", {
                                                                  user: row.displayName || row.username,
                                                              })
                                                    }
                                                    description={
                                                        isCleanup
                                                            ? t("admin.settingsTab.storageExpiry.confirmSingleCleanDesc", {
                                                                  count: row.deletedMediaCount,
                                                                  size: formatBytes(row.freedBytes),
                                                              })
                                                            : undefined
                                                    }
                                                    okText={t("admin.settingsTab.storageExpiry.confirmRunOk")}
                                                    cancelText={t("common.cancel")}
                                                    onConfirm={() => void handleRunSingleUserStorageSweep(row)}
                                                >
                                                    <Button
                                                        type="link"
                                                        size="small"
                                                        danger={isCleanup}
                                                        loading={isBusy}
                                                        disabled={Boolean(cleaningSingleUserId && !isBusy) || storageExpiryRunning || storageExpiryPreviewing}
                                                        className="!h-6 !px-1 !text-xs whitespace-nowrap"
                                                    >
                                                        {isCleanup
                                                            ? t("admin.settingsTab.storageExpiry.singleCleanBtn")
                                                            : t("admin.settingsTab.storageExpiry.singleNoticeBtn")}
                                                    </Button>
                                                </Popconfirm>
                                            );
                                        },
                                    },
                                ]}
                            />
                        </div>
                    ) : null}
                </Card>
            </Spin>
        );
    }

    return (
        <Spin spinning={loading}>
            <Card title={t("admin.settingsTab.analytics.cardTitle")}>
                <Alert
                    type="info"
                    showIcon
                    className="mb-4"
                    message={t("admin.settingsTab.analytics.alertTitle")}
                    description={t("admin.settingsTab.analytics.alertDesc")}
                />
                <Form
                    form={analyticsForm}
                    layout="vertical"
                    initialValues={{ sampleIntervalMinutes: 5, logRetentionDays: 0 }}
                    onFinish={handleSaveAnalyticsSettings}
                >
                    <Row gutter={16}>
                        <Col xs={24} md={12}>
                            <Form.Item
                                name="sampleIntervalMinutes"
                                label={t("admin.settingsTab.analytics.sampleIntervalLabel")}
                                rules={[{ required: true, message: t("admin.settingsTab.analytics.sampleIntervalReq") }]}
                            >
                                <InputNumber min={1} max={1440} precision={0} className="w-full" />
                            </Form.Item>
                            <div className="mb-4 flex flex-wrap gap-1.5">
                                {[1, 5, 10, 15, 30, 60].map((mins) => (
                                    <Button key={mins} size="small" onClick={() => analyticsForm.setFieldValue("sampleIntervalMinutes", mins)}>
                                        {t("admin.settingsTab.analytics.minuteOption", { mins })}
                                    </Button>
                                ))}
                            </div>
                        </Col>
                        <Col xs={24} md={12}>
                            <Form.Item
                                name="logRetentionDays"
                                label={t("admin.settingsTab.analytics.logRetentionLabel")}
                                rules={[{ required: true, message: t("admin.settingsTab.analytics.logRetentionReq") }]}
                            >
                                <InputNumber min={0} max={3650} precision={0} className="w-full" />
                            </Form.Item>
                            <div className="mb-4 flex flex-wrap gap-1.5">
                                {[
                                    { label: t("admin.settingsTab.analytics.retentionPermanent"), days: 0 },
                                    { label: t("admin.settingsTab.analytics.retentionDays", { days: 7 }), days: 7 },
                                    { label: t("admin.settingsTab.analytics.retentionDays", { days: 30 }), days: 30 },
                                    { label: t("admin.settingsTab.analytics.retentionDays", { days: 90 }), days: 90 },
                                    { label: t("admin.settingsTab.analytics.retentionDays", { days: 180 }), days: 180 },
                                    { label: t("admin.settingsTab.analytics.retentionDays", { days: 365 }), days: 365 },
                                ].map((item) => (
                                    <Button key={item.days} size="small" onClick={() => analyticsForm.setFieldValue("logRetentionDays", item.days)}>
                                        {item.label}
                                    </Button>
                                ))}
                            </div>
                        </Col>
                    </Row>
                    <Space wrap>
                        <Button type="primary" htmlType="submit" icon={<Save className="size-4" />} loading={analyticsSaving}>
                            {t("admin.storageTab.saveConfigBtn")}
                        </Button>
                        <Popconfirm
                            title={t("admin.settingsTab.analytics.confirmCleanupTitle")}
                            description={t("admin.settingsTab.analytics.confirmCleanupDesc")}
                            onConfirm={() => void handleCleanupExpiredLogs()}
                        >
                            <Button danger icon={<Trash2 className="size-4" />} loading={cleaningLogs}>
                                {t("admin.settingsTab.analytics.cleanupBtn")}
                            </Button>
                        </Popconfirm>
                    </Space>
                </Form>
            </Card>
        </Spin>
    );
}
