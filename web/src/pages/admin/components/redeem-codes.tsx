/** 管理后台兑换码管理面板：支持积分与存储配额兑换码的生成、筛选、批量复制/删除与状态切换。 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Radio, Row, Select, Space, Table, Tabs, Tag, Tooltip, Typography, theme as antdTheme } from "antd";
import type { Dayjs } from "dayjs";
import { Copy, Plus, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useCopyText } from "@/hooks/use-copy-text";
import { formatBytes } from "@/pages/admin/admin-utils";
import { ADMIN_TABLE_CLASS, ADMIN_TABLE_SCROLL, TableRowActions } from "@/pages/admin/components/table-row-actions";
import { adminApi, type RedeemCodeItem, type RedeemCodeKind } from "@/services/api/server";

type CreateRedeemForm = {
    name: string;
    kind: RedeemCodeKind;
    count: number;
    credits: number;
    storageQuotaMb: number;
    storageDurationDays: number | null;
    prefix: string;
    customCode: string;
    expiresAt: Dayjs | null;
    note: string;
};

export function AdminRedeemCodesPanel() {
    const { t, i18n } = useTranslation();
    const locale = i18n.resolvedLanguage || undefined;
    const { message } = App.useApp();
    const { token } = antdTheme.useToken();
    const copyText = useCopyText();

    const [items, setItems] = useState<RedeemCodeItem[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [query, setQuery] = useState("");
    const [statusFilter, setStatusFilter] = useState("");
    const [usedFilter, setUsedFilter] = useState("");
    const [activeKind, setActiveKind] = useState<RedeemCodeKind>("credits");
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [batchDeleting, setBatchDeleting] = useState(false);
    const [loading, setLoading] = useState(false);
    const [createOpen, setCreateOpen] = useState(false);
    const [createForm] = Form.useForm<CreateRedeemForm>();
    const [creating, setCreating] = useState(false);
    const [generatedCodes, setGeneratedCodes] = useState<string[]>([]);
    const countWatch = Form.useWatch("count", createForm) ?? 1;
    const kindWatch = Form.useWatch("kind", createForm) ?? "credits";

    const loadRedeemCodes = useCallback(
        async (
            nextPage = page,
            q = query,
            status = statusFilter,
            used = usedFilter,
            kind = activeKind,
            nextPageSize = pageSize,
        ) => {
            setLoading(true);
            try {
                const res = await adminApi.listRedeemCodes({ page: nextPage, pageSize: nextPageSize, q, status, used, kind });
                setItems(res.items);
                setTotal(res.total);
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("admin.messages.loadRedeemFailed"));
            } finally {
                setLoading(false);
            }
        },
        [activeKind, message, page, pageSize, query, statusFilter, t, usedFilter],
    );

    useEffect(() => {
        void loadRedeemCodes(page, query, statusFilter, usedFilter, activeKind, pageSize);
    }, [activeKind, loadRedeemCodes, page, pageSize, query, statusFilter, usedFilter]);

    const handleCreateRedeemCodes = async (values: CreateRedeemForm) => {
        setCreating(true);
        try {
            const kind = values.kind || activeKind;
            const res = await adminApi.createRedeemCodes({
                name: values.name.trim(),
                kind,
                count: Number(values.count || 1),
                ...(kind === "credits"
                    ? { credits: Number(values.credits) }
                    : {
                          storageQuotaBytes: Math.round(Number(values.storageQuotaMb || 0) * 1024 * 1024),
                          storageDurationDays:
                              typeof values.storageDurationDays === "number" && values.storageDurationDays > 0
                                  ? Math.round(values.storageDurationDays)
                                  : null,
                      }),
                maxUses: 1,
                prefix: values.prefix?.trim() || (kind === "storage" ? "ST" : "IC"),
                customCode: values.count === 1 ? values.customCode?.trim() : undefined,
                expiresAt: values.expiresAt ? values.expiresAt.toISOString() : null,
                note: values.note?.trim() || "",
            });
            setGeneratedCodes(res.items.map((item) => item.code));
            setCreateOpen(false);
            createForm.resetFields();
            message.success(t("admin.messages.redeemCreated", { count: res.items.length }));
            setSelectedIds([]);
            if (kind !== activeKind) {
                setPage(1);
                setActiveKind(kind);
            } else {
                void loadRedeemCodes(1, query, statusFilter, usedFilter, kind);
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.redeemCreateFailed"));
        } finally {
            setCreating(false);
        }
    };

    const selectedItems = items.filter((item) => selectedIds.includes(item.id));
    const hasSelectedUsed = selectedItems.some((item) => item.usedCount > 0);

    const handleBatchCopy = () => {
        if (!selectedItems.length) return;
        copyText(selectedItems.map((item) => item.code).join("\n"), t("admin.messages.redeemCopied", { count: selectedItems.length }));
    };

    const handleBatchDelete = async () => {
        if (!selectedIds.length || hasSelectedUsed) return;
        setBatchDeleting(true);
        try {
            const res = await adminApi.batchDeleteRedeemCodes(selectedIds);
            message.success(t("admin.messages.redeemDeletedCount", { count: res.deletedCount }));
            setSelectedIds([]);
            void loadRedeemCodes();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.batchDeleteFailed"));
        } finally {
            setBatchDeleting(false);
        }
    };

    const handleToggleStatus = async (item: RedeemCodeItem) => {
        try {
            await adminApi.updateRedeemCode(item.id, { status: item.status === "active" ? "disabled" : "active" });
            message.success(t("admin.messages.redeemStatusUpdated"));
            void loadRedeemCodes();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.updateFailed"));
        }
    };

    const handleDelete = async (id: string) => {
        try {
            await adminApi.deleteRedeemCode(id);
            message.success(t("admin.messages.redeemDeleted"));
            void loadRedeemCodes();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("common.deleteFailed"));
        }
    };

    return (
        <>
            <div className="flex flex-col gap-4">
                {generatedCodes.length ? (
                    <Alert
                        type="success"
                        showIcon
                        closable
                        onClose={() => setGeneratedCodes([])}
                        message={t("admin.redeemTab.generatedAlertTitle", { count: generatedCodes.length })}
                        description={
                            <div className="mt-2 flex flex-col gap-2">
                                <Input.TextArea value={generatedCodes.join("\n")} readOnly autoSize={{ minRows: 2, maxRows: 6 }} />
                                <div>
                                    <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => copyText(generatedCodes.join("\n"), t("admin.redeemTab.copiedAll"))}>
                                        {t("admin.redeemTab.copyAllBtn")}
                                    </Button>
                                </div>
                            </div>
                        }
                    />
                ) : null}

                <Card
                    title={t("admin.redeemTab.cardTitle")}
                    extra={
                        <div className="flex flex-wrap items-center gap-2">
                            <Select
                                value={statusFilter}
                                className="min-w-[115px] flex-1 sm:w-[115px]! sm:flex-none"
                                onChange={(value) => {
                                    setPage(1);
                                    setSelectedIds([]);
                                    setStatusFilter(value);
                                }}
                                options={[
                                    { value: "", label: t("admin.redeemTab.allStatuses") },
                                    { value: "available", label: t("admin.redeemTab.statusAvailable") },
                                    { value: "used", label: t("admin.redeemTab.statusUsed") },
                                    { value: "disabled", label: t("admin.redeemTab.statusDisabled") },
                                    { value: "expired", label: t("admin.redeemTab.statusExpired") },
                                ]}
                            />
                            <Select
                                value={usedFilter}
                                className="min-w-[120px] flex-1 sm:w-[130px]! sm:flex-none"
                                onChange={(value) => {
                                    setPage(1);
                                    setSelectedIds([]);
                                    setUsedFilter(value);
                                }}
                                options={[
                                    { value: "", label: t("admin.redeemTab.allUsed") },
                                    { value: "unused", label: t("admin.redeemTab.usedUnused") },
                                    { value: "used", label: t("admin.redeemTab.usedUsed") },
                                ]}
                            />
                            <Input.Search
                                allowClear
                                placeholder={t("admin.redeemTab.searchPlaceholder")}
                                className="w-full! sm:w-[220px]!"
                                onSearch={(value) => {
                                    setPage(1);
                                    setSelectedIds([]);
                                    setQuery(value.trim());
                                }}
                            />
                            <Button
                                type="primary"
                                icon={<Plus className="size-4" />}
                                onClick={() => {
                                    createForm.setFieldsValue({
                                        name: "",
                                        kind: activeKind,
                                        count: 1,
                                        credits: 100,
                                        storageQuotaMb: 1024,
                                        storageDurationDays: 30,
                                        prefix: activeKind === "storage" ? "ST" : "IC",
                                        customCode: "",
                                        expiresAt: null,
                                        note: "",
                                    });
                                    setCreateOpen(true);
                                }}
                            >
                                {activeKind === "storage" ? t("admin.redeemTab.createStorageBtn") : t("admin.redeemTab.createCreditsBtn")}
                            </Button>
                        </div>
                    }
                >
                    <Tabs
                        activeKey={activeKind}
                        onChange={(key) => {
                            setPage(1);
                            setSelectedIds([]);
                            setActiveKind(key as RedeemCodeKind);
                        }}
                        items={[
                            { key: "credits", label: t("admin.redeemTab.tabCredits") },
                            { key: "storage", label: t("admin.redeemTab.tabStorage") },
                        ]}
                    />

                    {selectedIds.length > 0 ? (
                        <div
                            className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs"
                            style={{ borderColor: token.colorBorderSecondary, background: token.colorFillAlter }}
                        >
                            <span>
                                {t("admin.redeemTab.selectedPrefix")} <strong>{selectedIds.length}</strong> {t("admin.redeemTab.selectedSuffix")}
                                {hasSelectedUsed ? (
                                    <Typography.Text type="danger" className="ml-2">
                                        {t("admin.redeemTab.includesUsedWarning")}
                                    </Typography.Text>
                                ) : null}
                            </span>
                            <Space wrap>
                                <Button size="small" icon={<Copy className="size-3.5" />} onClick={handleBatchCopy}>
                                    {t("admin.redeemTab.batchCopy")}
                                </Button>
                                <Tooltip title={hasSelectedUsed ? t("admin.redeemTab.usedCannotDeleteTip") : undefined}>
                                    {hasSelectedUsed ? (
                                        <Button size="small" danger disabled icon={<Trash2 className="size-3.5" />}>
                                            {t("admin.redeemTab.batchDelete")}
                                        </Button>
                                    ) : (
                                        <Popconfirm
                                            title={t("admin.redeemTab.confirmBatchDelete", { count: selectedIds.length })}
                                            onConfirm={() => void handleBatchDelete()}
                                        >
                                            <Button size="small" danger loading={batchDeleting} icon={<Trash2 className="size-3.5" />}>
                                                {t("admin.redeemTab.batchDelete")}
                                            </Button>
                                        </Popconfirm>
                                    )}
                                </Tooltip>
                                <Button size="small" type="text" icon={<X className="size-3.5" />} onClick={() => setSelectedIds([])}>
                                    {t("admin.redeemTab.deselect")}
                                </Button>
                            </Space>
                        </div>
                    ) : null}

                    <Table<RedeemCodeItem>
                        rowKey="id"
                        size="small"
                        className={ADMIN_TABLE_CLASS}
                        scroll={ADMIN_TABLE_SCROLL}
                        loading={loading}
                        dataSource={items}
                        rowSelection={{
                            selectedRowKeys: selectedIds,
                            onChange: (keys) => setSelectedIds(keys.map(String)),
                        }}
                        pagination={{
                            current: page,
                            pageSize,
                            total,
                            showSizeChanger: true,
                            pageSizeOptions: [10, 20, 30, 50, 100],
                            showTotal: (count) => t("common.totalItems", { count }),
                            onChange: (nextPage, size) => {
                                setSelectedIds([]);
                                if (size !== pageSize) {
                                    setPageSize(size);
                                    setPage(1);
                                } else {
                                    setPage(nextPage);
                                }
                            },
                        }}
                        columns={[
                            {
                                title: t("admin.redeemTab.colName"),
                                dataIndex: "name",
                                width: 150,
                                render: (name: string) =>
                                    name ? (
                                        <Typography.Text ellipsis={{ tooltip: name }} className="block max-w-[135px] font-medium">
                                            {name}
                                        </Typography.Text>
                                    ) : (
                                        <Typography.Text type="secondary">—</Typography.Text>
                                    ),
                            },
                            {
                                title: t("admin.redeemTab.colCode"),
                                dataIndex: "code",
                                width: 280,
                                render: (code: string) => (
                                    <Space size={4}>
                                        <Typography.Text code>{code}</Typography.Text>
                                        <Button size="small" type="text" icon={<Copy className="size-3.5" />} className="!h-5 !w-5 !min-w-0 !p-0" onClick={() => copyText(code)} />
                                    </Space>
                                ),
                            },
                            {
                                title: t("admin.redeemTab.colReward"),
                                key: "reward",
                                width: 165,
                                render: (_, record) =>
                                    record.kind === "storage" ? (
                                        <Tag color="cyan" style={{ marginInlineEnd: 0 }}>
                                            +{formatBytes(record.storageQuotaBytes)}
                                            {record.storageDurationDays
                                                ? t("admin.redeemTab.rewardDays", { days: record.storageDurationDays })
                                                : t("admin.redeemTab.rewardPermanent")}
                                        </Tag>
                                    ) : (
                                        <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                                            {t("admin.redeemTab.rewardCredits", { credits: record.credits })}
                                        </Tag>
                                    ),
                            },
                            {
                                title: t("admin.redeemTab.colState"),
                                key: "state",
                                width: 85,
                                render: (_, record) => {
                                    if (record.usedCount > 0 || record.usedCount >= record.maxUses) {
                                        return (
                                            <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                                                {t("admin.redeemTab.stateUsed")}
                                            </Tag>
                                        );
                                    }
                                    if (record.status === "disabled") {
                                        return (
                                            <Tag color="default" style={{ marginInlineEnd: 0 }}>
                                                {t("admin.redeemTab.stateDisabled")}
                                            </Tag>
                                        );
                                    }
                                    if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
                                        return (
                                            <Tag color="red" style={{ marginInlineEnd: 0 }}>
                                                {t("admin.redeemTab.stateExpired")}
                                            </Tag>
                                        );
                                    }
                                    return (
                                        <Tag color="green" style={{ marginInlineEnd: 0 }}>
                                            {t("admin.redeemTab.stateAvailable")}
                                        </Tag>
                                    );
                                },
                            },
                            {
                                title: t("admin.redeemTab.colRedeemUser"),
                                key: "redeemUser",
                                width: 120,
                                render: (_, record) =>
                                    record.redemption ? (
                                        <span className="font-medium">
                                            {record.redemption.username || record.redemption.displayName || t("admin.redeemTab.unknownUser")}
                                        </span>
                                    ) : (
                                        <Typography.Text type="secondary">—</Typography.Text>
                                    ),
                            },
                            {
                                title: t("admin.redeemTab.colRedeemUserId"),
                                key: "redeemUserId",
                                width: 215,
                                render: (_, record) =>
                                    record.redemption ? (
                                        <Space size={4}>
                                            <Typography.Text type="secondary" code className="text-xs">
                                                {record.redemption.userId}
                                            </Typography.Text>
                                            <Button
                                                size="small"
                                                type="text"
                                                icon={<Copy className="size-3" />}
                                                className="!h-5 !w-5 !min-w-0 !p-0"
                                                onClick={() => copyText(record.redemption!.userId, t("admin.redeemTab.copiedUserId"))}
                                            />
                                        </Space>
                                    ) : (
                                        <Typography.Text type="secondary">—</Typography.Text>
                                    ),
                            },
                            {
                                title: t("admin.redeemTab.colRedeemTime"),
                                key: "redeemTime",
                                width: 160,
                                render: (_, record) =>
                                    record.redemption ? (
                                        new Date(record.redemption.redeemedAt).toLocaleString(locale)
                                    ) : (
                                        <Typography.Text type="secondary">—</Typography.Text>
                                    ),
                            },
                            {
                                title: t("admin.redeemTab.colExpiresAt"),
                                dataIndex: "expiresAt",
                                width: 160,
                                render: (v?: string | null) => (v ? new Date(v).toLocaleString(locale) : t("admin.redeemTab.neverExpires")),
                            },
                            {
                                title: t("admin.redeemTab.colNote"),
                                dataIndex: "note",
                                width: 160,
                                render: (v: string) => (
                                    <Typography.Text ellipsis={{ tooltip: v || "—" }} className="block max-w-[145px]">
                                        {v || "—"}
                                    </Typography.Text>
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
                                                key: "toggle",
                                                label: record.status === "active" ? t("admin.redeemTab.actionDisable") : t("admin.redeemTab.actionEnable"),
                                                disabled: record.usedCount > 0,
                                                onClick: () => void handleToggleStatus(record),
                                            },
                                            {
                                                key: "delete",
                                                label: t("common.delete"),
                                                danger: true,
                                                disabled: record.usedCount > 0,
                                                confirm: t("admin.redeemTab.confirmDelete"),
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
                open={createOpen}
                title={t("admin.modals.redeem.title")}
                onCancel={() => setCreateOpen(false)}
                onOk={() => createForm.submit()}
                confirmLoading={creating}
            >
                <Form form={createForm} layout="vertical" onFinish={handleCreateRedeemCodes}>
                    <Form.Item name="kind" label={t("admin.modals.redeem.kindLabel")} rules={[{ required: true }]}>
                        <Radio.Group
                            optionType="button"
                            buttonStyle="solid"
                            onChange={(e) => {
                                const nextKind = e.target.value as RedeemCodeKind;
                                const currentPrefix = String(createForm.getFieldValue("prefix") || "").trim().toUpperCase();
                                if (!currentPrefix || currentPrefix === "IC" || currentPrefix === "ST") {
                                    createForm.setFieldValue("prefix", nextKind === "storage" ? "ST" : "IC");
                                }
                            }}
                            options={[
                                { label: t("admin.modals.redeem.kindCredits"), value: "credits" },
                                { label: t("admin.modals.redeem.kindStorage"), value: "storage" },
                            ]}
                        />
                    </Form.Item>
                    <Form.Item
                        name="name"
                        label={t("admin.modals.redeem.nameLabel")}
                        rules={[{ required: true, whitespace: true, message: t("admin.modals.redeem.nameReq") }]}
                    >
                        <Input placeholder={t("admin.modals.redeem.namePlaceholder")} maxLength={80} />
                    </Form.Item>
                    <Row gutter={12}>
                        <Col xs={24} sm={12}>
                            <Form.Item name="count" label={t("admin.modals.redeem.countLabel")} rules={[{ required: true, message: t("admin.modals.redeem.countReq") }]}>
                                <InputNumber className="w-full" min={1} max={100} />
                            </Form.Item>
                        </Col>
                        {kindWatch === "credits" ? (
                            <Col xs={24} sm={12}>
                                <Form.Item name="credits" label={t("admin.modals.redeem.creditsLabel")} rules={[{ required: true, message: t("admin.modals.redeem.creditsReq") }]}>
                                    <InputNumber className="w-full" min={0.01} step={10} />
                                </Form.Item>
                            </Col>
                        ) : (
                            <Col xs={24} sm={12}>
                                <Form.Item name="storageQuotaMb" label={t("admin.modals.redeem.storageQuotaLabel")} rules={[{ required: true, message: t("admin.modals.redeem.storageQuotaReq") }]}>
                                    <InputNumber className="w-full" min={1} step={100} />
                                </Form.Item>
                            </Col>
                        )}
                    </Row>
                    {kindWatch === "storage" ? (
                        <>
                            <div className="mb-3 flex flex-wrap gap-1.5">
                                {[100, 500, 1024, 5120, 10240].map((mb) => (
                                    <Button key={mb} size="small" onClick={() => createForm.setFieldValue("storageQuotaMb", mb)}>
                                        {mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`}
                                    </Button>
                                ))}
                            </div>
                            <Form.Item name="storageDurationDays" label={t("admin.modals.redeem.durationLabel")}>
                                <InputNumber className="w-full" min={1} max={36500} placeholder={t("admin.modals.redeem.durationPlaceholder")} />
                            </Form.Item>
                            <div className="mb-4 flex flex-wrap gap-1.5">
                                {[7, 30, 90, 365].map((d) => (
                                    <Button key={d} size="small" onClick={() => createForm.setFieldValue("storageDurationDays", d)}>
                                        {t("admin.modals.redeem.durationDaysOption", { days: d })}
                                    </Button>
                                ))}
                                <Button size="small" onClick={() => createForm.setFieldValue("storageDurationDays", null)}>
                                    {t("admin.modals.redeem.durationPermanent")}
                                </Button>
                            </div>
                        </>
                    ) : null}
                    <Row gutter={12}>
                        <Col xs={24} sm={12}>
                            <Form.Item name="prefix" label={t("admin.modals.redeem.prefixLabel")}>
                                <Input placeholder={kindWatch === "storage" ? "ST" : "IC"} maxLength={16} />
                            </Form.Item>
                        </Col>
                        <Col xs={24} sm={12}>
                            <Form.Item label={t("admin.modals.redeem.limitLabel")}>
                                <Input value={t("admin.modals.redeem.limitValue")} disabled />
                            </Form.Item>
                        </Col>
                    </Row>
                    {countWatch === 1 ? (
                        <Form.Item name="customCode" label={t("admin.modals.redeem.customCodeLabel")}>
                            <Input placeholder={kindWatch === "storage" ? t("admin.modals.redeem.customCodeStoragePh") : t("admin.modals.redeem.customCodeCreditsPh")} maxLength={64} />
                        </Form.Item>
                    ) : null}
                    <Form.Item name="expiresAt" label={t("admin.modals.redeem.expiresLabel")}>
                        <DatePicker showTime className="w-full" placeholder={t("admin.modals.redeem.expiresPlaceholder")} />
                    </Form.Item>
                    <Form.Item name="note" label={t("admin.modals.redeem.noteLabel")}>
                        <Input placeholder={t("admin.modals.redeem.notePlaceholder")} maxLength={200} />
                    </Form.Item>
                </Form>
            </Modal>
        </>
    );
}
