/** 管理后台公告管理面板：配置全站弹窗通知与公告时间线列表。 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Card, Col, DatePicker, Form, Input, Modal, Row, Select, Switch, Table, Typography } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { Plus, Save } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ADMIN_TABLE_CLASS, ADMIN_TABLE_SCROLL, TableRowActions } from "@/pages/admin/components/table-row-actions";
import { adminApi, type AnnouncementItem, type AnnouncementLevel } from "@/services/api/server";
import { useNotificationStore } from "@/stores/use-notification-store";

type AnnouncementForm = {
    title: string;
    content: string;
    level: AnnouncementLevel;
    isPinned: boolean;
    isPublished: boolean;
    createdAt?: Dayjs | null;
};

type GlobalNoticeForm = {
    enabled: boolean;
    title: string;
    content: string;
};

export function AdminAnnouncementsPanel() {
    const { t, i18n } = useTranslation();
    const locale = i18n.resolvedLanguage || undefined;
    const { message } = App.useApp();

    const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [modalOpen, setModalOpen] = useState(false);
    const [editing, setEditing] = useState<AnnouncementItem | null>(null);
    const [announcementForm] = Form.useForm<AnnouncementForm>();
    const [announcementSaving, setAnnouncementSaving] = useState(false);
    const [noticeForm] = Form.useForm<GlobalNoticeForm>();
    const [noticeSaving, setNoticeSaving] = useState(false);
    const [noticeUpdatedAt, setNoticeUpdatedAt] = useState<string | null>(null);

    const loadAnnouncements = useCallback(async () => {
        setLoading(true);
        try {
            const res = await adminApi.listAnnouncements();
            setAnnouncements(res.items);
            setNoticeUpdatedAt(res.notice.updatedAt);
            noticeForm.setFieldsValue({
                enabled: res.notice.enabled,
                title: res.notice.title,
                content: res.notice.content,
            });
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.loadAnnouncementsFailed"));
        } finally {
            setLoading(false);
        }
    }, [message, noticeForm, t]);

    useEffect(() => {
        void loadAnnouncements();
    }, [loadAnnouncements]);

    const levelMeta: Record<AnnouncementLevel, { label: string; color: string; dotColor: string }> = {
        default: { label: t("userPanels.announcementLevels.default"), color: "default", dotColor: "#6b7280" },
        ongoing: { label: t("userPanels.announcementLevels.ongoing"), color: "blue", dotColor: "#2563eb" },
        success: { label: t("userPanels.announcementLevels.success"), color: "green", dotColor: "#16a34a" },
        warning: { label: t("userPanels.announcementLevels.warning"), color: "orange", dotColor: "#f97316" },
        error: { label: t("userPanels.announcementLevels.error"), color: "red", dotColor: "#ef4444" },
    };

    const levelOptions = (Object.keys(levelMeta) as AnnouncementLevel[]).map((value) => {
        const meta = levelMeta[value];
        return {
            value,
            label: (
                <span className="inline-flex items-center gap-2">
                    <span className="inline-block size-2 shrink-0 rounded-full" style={{ backgroundColor: meta.dotColor }} />
                    <span>{meta.label}</span>
                </span>
            ),
        };
    });

    const handleOpenCreate = () => {
        setEditing(null);
        announcementForm.setFieldsValue({
            title: "",
            content: "",
            level: "default",
            isPinned: false,
            isPublished: true,
            createdAt: dayjs(),
        });
        setModalOpen(true);
    };

    const handleOpenEdit = (record: AnnouncementItem) => {
        setEditing(record);
        announcementForm.setFieldsValue({
            title: record.title,
            content: record.content,
            level: record.level in levelMeta ? record.level : "default",
            isPinned: record.isPinned,
            isPublished: record.isPublished,
            createdAt: record.createdAt ? dayjs(record.createdAt) : dayjs(),
        });
        setModalOpen(true);
    };

    const handleSaveGlobalNotice = async (values: GlobalNoticeForm) => {
        setNoticeSaving(true);
        try {
            const res = await adminApi.saveGlobalNotice({
                enabled: Boolean(values.enabled),
                title: values.title?.trim() || "",
                content: values.content ?? "",
            });
            setNoticeUpdatedAt(res.notice.updatedAt);
            noticeForm.setFieldsValue(res.notice);
            message.success(t("admin.messages.noticeSaved"));
            void useNotificationStore.getState().fetchNotifications(true);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.noticeSaveFailed"));
        } finally {
            setNoticeSaving(false);
        }
    };

    const handleSaveAnnouncement = async (values: AnnouncementForm) => {
        setAnnouncementSaving(true);
        try {
            const payload = {
                title: values.title,
                content: values.content,
                level: values.level,
                isPinned: values.isPinned,
                isPublished: values.isPublished,
                ...(values.createdAt ? { createdAt: values.createdAt.toISOString() } : {}),
            };
            if (editing) {
                await adminApi.updateAnnouncement(editing.id, payload);
                message.success(t("admin.messages.announcementUpdated"));
            } else {
                await adminApi.createAnnouncement(payload);
                message.success(t("admin.messages.announcementPublished"));
            }
            setModalOpen(false);
            setEditing(null);
            void loadAnnouncements();
            void useNotificationStore.getState().fetchNotifications(true);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.announcementSaveFailed"));
        } finally {
            setAnnouncementSaving(false);
        }
    };

    const handleToggleFlag = async (record: AnnouncementItem, patch: Partial<Pick<AnnouncementItem, "isPinned" | "isPublished" | "level">>) => {
        try {
            await adminApi.updateAnnouncement(record.id, patch);
            message.success(t("admin.messages.announcementStatusUpdated"));
            void loadAnnouncements();
            void useNotificationStore.getState().fetchNotifications(true);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.announcementUpdateFailed"));
        }
    };

    const handleDelete = async (id: string) => {
        try {
            await adminApi.deleteAnnouncement(id);
            message.success(t("admin.messages.announcementDeleted"));
            void loadAnnouncements();
            void useNotificationStore.getState().fetchNotifications(true);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.announcementDeleteFailed"));
        }
    };

    return (
        <>
            <div className="flex flex-col gap-5">
                <Card
                    title={t("admin.settingsTab.announcements.globalCardTitle")}
                    extra={
                        noticeUpdatedAt ? (
                            <Typography.Text type="secondary" className="text-xs">
                                {t("admin.settingsTab.announcements.lastUpdated", { time: new Date(noticeUpdatedAt).toLocaleString(locale) })}
                            </Typography.Text>
                        ) : null
                    }
                >
                    <Alert
                        type="info"
                        showIcon
                        className="mb-4"
                        message={t("admin.settingsTab.announcements.globalAlertTitle")}
                        description={t("admin.settingsTab.announcements.globalAlertDesc")}
                    />
                    <Form
                        form={noticeForm}
                        layout="vertical"
                        initialValues={{ enabled: false, title: "", content: "" }}
                        onFinish={handleSaveGlobalNotice}
                    >
                        <Form.Item name="enabled" label={t("admin.settingsTab.announcements.globalEnabled")} valuePropName="checked">
                            <Switch />
                        </Form.Item>
                        <Form.Item name="title" label={t("admin.settingsTab.announcements.globalTitle")}>
                            <Input placeholder={t("admin.settingsTab.announcements.globalTitlePlaceholder")} maxLength={120} />
                        </Form.Item>
                        <Form.Item name="content" label={t("admin.settingsTab.announcements.globalContent")}>
                            <Input.TextArea
                                rows={6}
                                maxLength={10000}
                                showCount
                                placeholder={t("admin.settingsTab.announcements.globalContentPlaceholder")}
                            />
                        </Form.Item>
                        <Button type="primary" htmlType="submit" icon={<Save className="size-4" />} loading={noticeSaving}>
                            {t("admin.settingsTab.announcements.saveGlobalBtn")}
                        </Button>
                    </Form>
                </Card>

                <Card
                    title={t("admin.settingsTab.announcements.timelineCardTitle")}
                    extra={
                        <Button type="primary" icon={<Plus className="size-4" />} onClick={handleOpenCreate}>
                            {t("admin.settingsTab.announcements.createBtn")}
                        </Button>
                    }
                >
                    <Table<AnnouncementItem>
                        rowKey="id"
                        size="small"
                        className={ADMIN_TABLE_CLASS}
                        scroll={ADMIN_TABLE_SCROLL}
                        loading={loading}
                        dataSource={announcements}
                        pagination={{ defaultPageSize: 10, showSizeChanger: true, pageSizeOptions: [10, 20, 30, 50, 100], showTotal: (count) => t("common.totalItems", { count }) }}
                        columns={[
                            {
                                title: t("admin.settingsTab.announcements.colTitle"),
                                dataIndex: "title",
                                width: 180,
                                render: (title: string) => (
                                    <Typography.Text ellipsis={{ tooltip: title }} className="block max-w-[165px] font-medium">
                                        {title}
                                    </Typography.Text>
                                ),
                            },
                            {
                                title: t("admin.settingsTab.announcements.colBody"),
                                dataIndex: "content",
                                width: 240,
                                render: (content: string) => (
                                    <Typography.Text type="secondary" ellipsis={{ tooltip: content }} className="block max-w-[225px] text-xs">
                                        {content}
                                    </Typography.Text>
                                ),
                            },
                            {
                                title: t("admin.settingsTab.announcements.colStatus"),
                                dataIndex: "level",
                                width: 115,
                                render: (level: AnnouncementLevel, record) => (
                                    <Select
                                        size="small"
                                        value={level in levelMeta ? level : "default"}
                                        popupMatchSelectWidth={false}
                                        options={levelOptions}
                                        onChange={(val) => void handleToggleFlag(record, { level: val })}
                                    />
                                ),
                            },
                            {
                                title: t("admin.settingsTab.announcements.colPin"),
                                dataIndex: "isPinned",
                                width: 72,
                                render: (checked: boolean, record) => (
                                    <Switch size="small" checked={checked} onChange={(val) => void handleToggleFlag(record, { isPinned: val })} />
                                ),
                            },
                            {
                                title: t("admin.settingsTab.announcements.colPublished"),
                                dataIndex: "isPublished",
                                width: 82,
                                render: (checked: boolean, record) => (
                                    <Switch size="small" checked={checked} onChange={(val) => void handleToggleFlag(record, { isPublished: val })} />
                                ),
                            },
                            {
                                title: t("admin.settingsTab.announcements.colPublishedAt"),
                                dataIndex: "createdAt",
                                width: 170,
                                render: (value: string) => new Date(value).toLocaleString(locale),
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
                                                onClick: () => handleOpenEdit(record),
                                            },
                                            {
                                                key: "delete",
                                                label: t("common.delete"),
                                                danger: true,
                                                confirm: t("admin.settingsTab.announcements.confirmDelete"),
                                                onClick: () => void handleDelete(record.id),
                                            },
                                        ]}
                                    />
                                ),
                            },
                        ]}
                    />
                </Card>
            </div>

            <Modal
                open={modalOpen}
                title={editing ? t("admin.settingsTab.announcements.modalEditTitle") : t("admin.settingsTab.announcements.modalCreateTitle")}
                onCancel={() => {
                    setModalOpen(false);
                    setEditing(null);
                }}
                onOk={() => announcementForm.submit()}
                confirmLoading={announcementSaving}
            >
                <Form form={announcementForm} layout="vertical" onFinish={handleSaveAnnouncement}>
                    <Form.Item name="title" label={t("admin.settingsTab.announcements.titleLabel")} rules={[{ required: true, message: t("admin.settingsTab.announcements.titleReq") }]}>
                        <Input placeholder={t("admin.settingsTab.announcements.titlePlaceholder")} maxLength={120} />
                    </Form.Item>
                    <Row gutter={12}>
                        <Col xs={24} sm={12}>
                            <Form.Item name="level" label={t("admin.settingsTab.announcements.levelLabel")} rules={[{ required: true }]}>
                                <Select options={levelOptions} />
                            </Form.Item>
                        </Col>
                        <Col xs={24} sm={12}>
                            <Form.Item name="createdAt" label={t("admin.settingsTab.announcements.createdAtLabel")}>
                                <DatePicker showTime allowClear className="w-full" placeholder={t("admin.settingsTab.announcements.createdAtPlaceholder")} />
                            </Form.Item>
                        </Col>
                    </Row>
                    <Form.Item name="content" label={t("admin.settingsTab.announcements.contentLabel")} rules={[{ required: true, message: t("admin.settingsTab.announcements.contentReq") }]}>
                        <Input.TextArea rows={5} placeholder={t("admin.settingsTab.announcements.contentPlaceholder")} maxLength={4000} showCount />
                    </Form.Item>
                    <Row gutter={16}>
                        <Col xs={24} sm={12}>
                            <Form.Item name="isPinned" label={t("admin.settingsTab.announcements.isPinnedLabel")} valuePropName="checked">
                                <Switch />
                            </Form.Item>
                        </Col>
                        <Col xs={24} sm={12}>
                            <Form.Item name="isPublished" label={t("admin.settingsTab.announcements.isPublishedLabel")} valuePropName="checked">
                                <Switch />
                            </Form.Item>
                        </Col>
                    </Row>
                </Form>
            </Modal>
        </>
    );
}
