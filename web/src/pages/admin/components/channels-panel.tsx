/** 管理后台模型渠道面板：管理平台级 AI 渠道配置与模型拉取。 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Card, Switch, Table, Tag, Typography } from "antd";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ChannelEditorDrawer } from "@/components/layout/channel-editor-drawer";
import { ADMIN_TABLE_CLASS, ADMIN_TABLE_SCROLL, TableRowActions } from "@/pages/admin/components/table-row-actions";
import { adminApi, type AdminChannelItem } from "@/services/api/server";
import { syncRuntimeSettings } from "@/services/cloud-sync";
import { createModelChannel, type ModelChannel } from "@/stores/use-config-store";

export function AdminChannelsPanel() {
    const { t } = useTranslation();
    const { message } = App.useApp();

    const [channels, setChannels] = useState<AdminChannelItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [editingChannel, setEditingChannel] = useState<ModelChannel | null>(null);

    const loadChannels = useCallback(async () => {
        setLoading(true);
        try {
            const res = await adminApi.getChannelSettings();
            setChannels(res.channels);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.loadChannelsFailed"));
        } finally {
            setLoading(false);
        }
    }, [message, t]);

    useEffect(() => {
        void loadChannels();
    }, [loadChannels]);

    const persistChannels = async (nextList: AdminChannelItem[]) => {
        setSaving(true);
        try {
            await adminApi.saveChannelSettings(nextList);
            await loadChannels();
            await syncRuntimeSettings();
            message.success(t("admin.messages.channelsSaved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.channelsSaveFailed"));
        } finally {
            setSaving(false);
        }
    };

    const handleAddChannel = () => {
        setEditingChannel(
            createModelChannel({
                name: t("admin.messages.defaultChannelName", { index: channels.length + 1 }),
                baseUrl: "https://api.openai.com",
                apiKey: "",
                enabled: true,
            }),
        );
    };

    const handleEditChannel = (item: AdminChannelItem) => {
        setEditingChannel({
            id: item.id,
            name: item.name,
            baseUrl: item.baseUrl,
            apiKey: "",
            apiFormat: item.apiFormat,
            enabled: item.enabled,
            hasApiKey: item.hasApiKey,
            apiKeyPreview: item.apiKeyPreview,
            models: item.models,
        });
    };

    const handleSaveChannelDrawer = async (saved: ModelChannel) => {
        const nextItem: AdminChannelItem = {
            id: saved.id,
            name: saved.name,
            baseUrl: saved.baseUrl,
            apiFormat: saved.apiFormat,
            enabled: saved.enabled ?? true,
            models: saved.models,
            apiKey: saved.apiKey,
        };
        const exists = channels.some((ch) => ch.id === nextItem.id);
        const nextList = exists ? channels.map((ch) => (ch.id === nextItem.id ? nextItem : ch)) : [...channels, nextItem];
        await persistChannels(nextList);
    };

    const handleToggleChannelEnabled = async (id: string, enabled: boolean) => {
        await persistChannels(channels.map((ch) => (ch.id === id ? { ...ch, enabled, apiKey: "" } : { ...ch, apiKey: "" })));
    };

    const handleDeleteChannel = async (id: string) => {
        await persistChannels(channels.filter((ch) => ch.id !== id).map((ch) => ({ ...ch, apiKey: "" })));
    };

    return (
        <>
            <Card
                title={t("admin.channelsTab.cardTitle")}
                loading={loading}
                extra={
                    <Button type="primary" icon={<Plus className="size-4" />} onClick={handleAddChannel} loading={saving}>
                        {t("admin.channelsTab.addChannel")}
                    </Button>
                }
            >
                <Alert
                    type="info"
                    showIcon
                    className="mb-4"
                    message={t("admin.channelsTab.alertTitle")}
                    description={t("admin.channelsTab.alertDesc")}
                />
                <Table<AdminChannelItem>
                    rowKey="id"
                    size="small"
                    className={ADMIN_TABLE_CLASS}
                    scroll={ADMIN_TABLE_SCROLL}
                    dataSource={channels}
                    pagination={false}
                    columns={[
                        {
                            title: t("admin.channelsTab.colName"),
                            dataIndex: "name",
                            width: 170,
                            ellipsis: true,
                            render: (name: string) => <span className="font-medium">{name}</span>,
                        },
                        {
                            title: t("admin.channelsTab.colBaseUrl"),
                            dataIndex: "baseUrl",
                            width: 220,
                            render: (baseUrl: string) => (
                                <Typography.Text type="secondary" ellipsis={{ tooltip: baseUrl }} className="block max-w-[205px] text-xs">
                                    {baseUrl || t("admin.channelsTab.noBaseUrl")}
                                </Typography.Text>
                            ),
                        },
                        {
                            title: t("admin.channelsTab.colFormat"),
                            dataIndex: "apiFormat",
                            width: 88,
                            render: (fmt: string) => <Tag style={{ marginInlineEnd: 0 }}>{fmt === "gemini" ? "Gemini" : "OpenAI"}</Tag>,
                        },
                        {
                            title: t("admin.channelsTab.colKeyStatus"),
                            key: "apiKey",
                            width: 135,
                            render: (_, record) =>
                                record.hasApiKey ? (
                                    <Tag color="green" style={{ marginInlineEnd: 0 }}>
                                        {record.apiKeyPreview}
                                    </Tag>
                                ) : (
                                    <Tag color="red" style={{ marginInlineEnd: 0 }}>
                                        {t("admin.channelsTab.noKey")}
                                    </Tag>
                                ),
                        },
                        {
                            title: t("admin.channelsTab.colModels"),
                            key: "models",
                            width: 80,
                            render: (_, record) => t("admin.channelsTab.modelsCount", { count: record.models.length }),
                        },
                        {
                            title: t("admin.channelsTab.colEnabled"),
                            dataIndex: "enabled",
                            width: 72,
                            render: (enabled: boolean, record) => (
                                <Switch size="small" checked={enabled} loading={saving} onChange={(checked) => void handleToggleChannelEnabled(record.id, checked)} />
                            ),
                        },
                        {
                            title: t("admin.channelsTab.colActions"),
                            key: "actions",
                            fixed: "right",
                            width: 100,
                            render: (_, record) => (
                                <TableRowActions
                                    items={[
                                        {
                                            key: "edit",
                                            label: t("common.edit"),
                                            onClick: () => handleEditChannel(record),
                                        },
                                        {
                                            key: "delete",
                                            label: t("common.delete"),
                                            danger: true,
                                            confirm: t("admin.channelsTab.confirmDelete"),
                                            onClick: () => void handleDeleteChannel(record.id),
                                        },
                                    ]}
                                />
                            ),
                        },
                    ]}
                />
            </Card>

            <ChannelEditorDrawer
                open={Boolean(editingChannel)}
                channel={editingChannel}
                onSave={(channel) => void handleSaveChannelDrawer(channel)}
                onClose={() => setEditingChannel(null)}
                onFetchModels={async (channel) => {
                    const res = await adminApi.fetchChannelModels({
                        id: channel.id,
                        baseUrl: channel.baseUrl,
                        apiKey: channel.apiKey,
                        apiFormat: channel.apiFormat,
                    });
                    return res.models;
                }}
            />
        </>
    );
}
