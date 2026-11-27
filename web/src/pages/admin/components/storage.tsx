/** 管理后台对象存储配置面板：配置 S3/R2/OSS/COS 存储参数并支持连通性探测与直传测试。 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Card, Col, Form, Input, Row, Select, Space, Spin, Switch, Tag, Typography, Upload } from "antd";
import type { UploadProps } from "antd";
import { Save, UploadCloud, Wifi } from "lucide-react";
import { useTranslation } from "react-i18next";

import { adminApi, storageApi, type S3StorageConfigForm } from "@/services/api/server";

export function AdminStorageSettingsPanel() {
    const { t } = useTranslation();
    const { message } = App.useApp();

    const [form] = Form.useForm<S3StorageConfigForm>();
    const [preview, setPreview] = useState("");
    const [configured, setConfigured] = useState(false);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [uploadingTest, setUploadingTest] = useState(false);

    const loadStorageSettings = useCallback(async () => {
        setLoading(true);
        try {
            const res = await adminApi.getStorageSettings();
            setConfigured(res.configured);
            setPreview(res.config.secretAccessKeyPreview);
            form.setFieldsValue({
                provider: res.config.provider,
                endpoint: res.config.endpoint,
                region: res.config.region,
                bucket: res.config.bucket,
                accessKeyId: res.config.accessKeyId,
                secretAccessKey: "",
                publicBaseUrl: res.config.publicBaseUrl,
                forcePathStyle: res.config.forcePathStyle,
            });
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.loadStorageFailed"));
        } finally {
            setLoading(false);
        }
    }, [form, message, t]);

    useEffect(() => {
        void loadStorageSettings();
    }, [loadStorageSettings]);

    const handleSave = async (values: S3StorageConfigForm) => {
        setSaving(true);
        try {
            const res = await adminApi.saveStorageSettings(values);
            setConfigured(true);
            setPreview(res.secretAccessKeyPreview);
            form.setFieldValue("secretAccessKey", "");
            message.success(t("admin.messages.storageSaved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.storageSaveFailed"));
        } finally {
            setSaving(false);
        }
    };

    const handleTest = async () => {
        try {
            const values = await form.validateFields();
            setTesting(true);
            const res = await adminApi.testStorageSettings(values);
            message.success(res.message);
        } catch (error) {
            if (error instanceof Error) message.error(error.message);
        } finally {
            setTesting(false);
        }
    };

    const handleDirectUploadTest: UploadProps["customRequest"] = async (options) => {
        const file = options.file as File;
        setUploadingTest(true);
        try {
            await storageApi.uploadFile(file);
            message.success(t("admin.messages.directUploadSuccess"));
            options.onSuccess?.({});
        } catch (error) {
            const err = error instanceof Error ? error : new Error(t("admin.messages.directUploadFailed"));
            message.error(err.message);
            options.onError?.(err);
        } finally {
            setUploadingTest(false);
        }
    };

    return (
        <div className="flex flex-col gap-5">
            <Spin spinning={loading}>
                <Card
                    title={t("admin.storageTab.cardTitle")}
                    extra={
                        loading ? (
                            <Tag>{t("topNav.loading")}</Tag>
                        ) : configured ? (
                            <Tag color="green">{t("admin.storageTab.configured")}</Tag>
                        ) : (
                            <Tag color="orange">{t("admin.storageTab.pending")}</Tag>
                        )
                    }
                >
                    <Alert
                        type="info"
                        showIcon
                        className="mb-4"
                        message={t("admin.storageTab.corsTitle")}
                        description={t("admin.storageTab.corsDesc")}
                    />
                    <Form
                        form={form}
                        layout="vertical"
                        initialValues={{ provider: "r2", region: "auto", forcePathStyle: false }}
                        onFinish={handleSave}
                    >
                        <Row gutter={16}>
                            <Col xs={24} md={8}>
                                <Form.Item name="provider" label={t("admin.storageTab.providerLabel")} rules={[{ required: true }]}>
                                    <Select
                                        options={[
                                            { value: "r2", label: t("admin.storageTab.providerR2") },
                                            { value: "oss", label: t("admin.storageTab.providerOss") },
                                            { value: "cos", label: t("admin.storageTab.providerCos") },
                                            { value: "s3", label: t("admin.storageTab.providerS3") },
                                        ]}
                                    />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={8}>
                                <Form.Item name="bucket" label={t("admin.storageTab.bucketLabel")} rules={[{ required: true, message: t("admin.storageTab.bucketReq") }]}>
                                    <Input placeholder="my-canvas-bucket" />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={8}>
                                <Form.Item name="region" label={t("admin.storageTab.regionLabel")} rules={[{ required: true, message: t("admin.storageTab.regionReq") }]}>
                                    <Input placeholder="auto / cn-hangzhou / ap-guangzhou" />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={12}>
                                <Form.Item name="endpoint" label={t("admin.storageTab.endpointLabel")}>
                                    <Input placeholder={t("admin.storageTab.endpointPlaceholder")} />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={12}>
                                <Form.Item name="publicBaseUrl" label={t("admin.storageTab.publicBaseUrlLabel")}>
                                    <Input placeholder="https://cdn.example.com" />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={12}>
                                <Form.Item name="accessKeyId" label={t("admin.storageTab.accessKeyLabel")} rules={[{ required: true, message: t("admin.storageTab.accessKeyReq") }]}>
                                    <Input placeholder="AccessKey ID" />
                                </Form.Item>
                            </Col>
                            <Col xs={24} md={12}>
                                <Form.Item
                                    name="secretAccessKey"
                                    label={`SecretAccessKey${preview ? t("admin.storageTab.secretSavedSuffix", { preview }) : ""}`}
                                    rules={configured ? [] : [{ required: true, message: t("admin.storageTab.secretReq") }]}
                                >
                                    <Input.Password placeholder={preview ? t("admin.storageTab.secretKeepPlaceholder") : t("admin.storageTab.secretInputPlaceholder")} />
                                </Form.Item>
                            </Col>
                            <Col xs={24}>
                                <Form.Item name="forcePathStyle" label={t("admin.storageTab.forcePathStyleLabel")} valuePropName="checked">
                                    <Switch />
                                </Form.Item>
                            </Col>
                        </Row>
                        <Space wrap>
                            <Button icon={<Wifi className="size-4" />} onClick={handleTest} loading={testing}>
                                {t("admin.storageTab.testProbeBtn")}
                            </Button>
                            <Button type="primary" htmlType="submit" icon={<Save className="size-4" />} loading={saving}>
                                {t("admin.storageTab.saveConfigBtn")}
                            </Button>
                        </Space>
                    </Form>
                </Card>
            </Spin>

            <Card
                title={t("admin.storageTab.directUploadTitle")}
                extra={
                    <Upload showUploadList={false} customRequest={handleDirectUploadTest} disabled={!configured || uploadingTest}>
                        <Button type="primary" icon={<UploadCloud className="size-4" />} loading={uploadingTest} disabled={!configured}>
                            {t("admin.storageTab.uploadTestBtn")}
                        </Button>
                    </Upload>
                }
            >
                <Typography.Text type="secondary">{t("admin.storageTab.directUploadHint")}</Typography.Text>
            </Card>
        </div>
    );
}
