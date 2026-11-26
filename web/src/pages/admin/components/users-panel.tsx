/** 管理后台用户管理面板：支持用户筛选、角色与状态切换、积分调整、存储配额管理与用户详情抽屉。 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Card, DatePicker, Form, Input, InputNumber, Modal, Radio, Select, Space, Switch, Table, Tag, Tooltip, Typography, theme as antdTheme } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { Copy, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useCopyText } from "@/hooks/use-copy-text";
import { formatCompactCredits, formatExactCredits } from "@/lib/format-number";
import { formatBytes } from "@/pages/admin/admin-utils";
import { ADMIN_TABLE_CLASS, ADMIN_TABLE_SCROLL, TableRowActions } from "@/pages/admin/components/table-row-actions";
import { UserDetailDrawer } from "@/pages/admin/components/user-detail-drawer";
import { adminApi, type AdminUserItem, type StorageGrantItem } from "@/services/api/server";
import { useUserStore } from "@/stores/use-user-store";

type UserCreditForm = {
    mode: "add" | "deduct" | "clear";
    amount?: number;
    note: string;
};

type UserStorageQuotaForm = {
    quotaMb: number;
    expiresAt?: Dayjs | null;
    recalculateUsedBytes?: boolean;
};

export function AdminUsersPanel() {
    const { t, i18n } = useTranslation();
    const locale = i18n.resolvedLanguage || undefined;
    const { message } = App.useApp();
    const { token } = antdTheme.useToken();
    const copyText = useCopyText();
    const currentUser = useUserStore((state) => state.user);

    const [usersList, setUsersList] = useState<AdminUserItem[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [query, setQuery] = useState("");
    const [roleFilter, setRoleFilter] = useState("");
    const [statusFilter, setStatusFilter] = useState("");
    const [sort, setSort] = useState("created_desc");
    const [loading, setLoading] = useState(false);
    const [refreshing, setRefreshing] = useState(false);

    const [creditUser, setCreditUser] = useState<AdminUserItem | null>(null);
    const [creditForm] = Form.useForm<UserCreditForm>();
    const creditModeWatch = Form.useWatch("mode", creditForm) || "add";
    const creditAmountWatch = Form.useWatch("amount", creditForm);
    const [creditSaving, setCreditSaving] = useState(false);

    const [quotaUser, setQuotaUser] = useState<AdminUserItem | null>(null);
    const [quotaForm] = Form.useForm<UserStorageQuotaForm>();
    const quotaMbWatch = Form.useWatch("quotaMb", quotaForm);
    const quotaExpiresAtWatch = Form.useWatch("expiresAt", quotaForm);
    const [quotaSaving, setQuotaSaving] = useState(false);
    const [grants, setGrants] = useState<StorageGrantItem[]>([]);
    const [grantsLoading, setGrantsLoading] = useState(false);
    const [updatingGrantId, setUpdatingGrantId] = useState<string | null>(null);

    const [detailUserId, setDetailUserId] = useState<string | null>(null);
    const [detailRefreshKey, setDetailRefreshKey] = useState(0);

    const loadUsers = useCallback(
        async (
            nextPage = page,
            q = query,
            role = roleFilter,
            status = statusFilter,
            nextSort = sort,
            nextPageSize = pageSize,
            notifySuccess = false,
        ) => {
            if (notifySuccess) setRefreshing(true);
            else setLoading(true);
            try {
                const res = await adminApi.listUsers({ page: nextPage, pageSize: nextPageSize, q, role, status, sort: nextSort });
                setUsersList(res.items);
                setTotal(res.total);
                if (notifySuccess) message.success(t("common.refreshed"));
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("admin.messages.loadUsersFailed"));
            } finally {
                if (notifySuccess) setRefreshing(false);
                else setLoading(false);
            }
        },
        [message, page, pageSize, query, roleFilter, sort, statusFilter, t],
    );

    useEffect(() => {
        void loadUsers(page, query, roleFilter, statusFilter, sort, pageSize);
    }, [loadUsers, page, pageSize, query, roleFilter, sort, statusFilter]);

    const handleUpdateUser = async (targetId: string, patch: { role?: "admin" | "user"; status?: "active" | "disabled" }) => {
        try {
            await adminApi.updateUser(targetId, patch);
            message.success(t("admin.messages.userUpdated"));
            void loadUsers();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.updateFailed"));
        }
    };

    const openAdjustCredits = (record: AdminUserItem) => {
        setCreditUser(record);
        creditForm.setFieldsValue({ mode: "add", amount: 100, note: "" });
    };

    const loadUserStorageGrants = async (userId: string) => {
        setGrantsLoading(true);
        try {
            const res = await adminApi.getUserStorageGrants(userId);
            setGrants(res.grants);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.loadGrantsFailed"));
        } finally {
            setGrantsLoading(false);
        }
    };

    const openConfigStorageQuota = (record: AdminUserItem) => {
        setQuotaUser(record);
        setGrants([]);
        const baseQuotaBytes = record.baseStorageQuotaBytes ?? record.storageQuotaBytes ?? 0;
        const baseExpiresAt = record.baseStorageQuotaExpiresAt !== undefined ? record.baseStorageQuotaExpiresAt : record.storageQuotaExpiresAt;
        quotaForm.setFieldsValue({
            quotaMb: baseQuotaBytes > 0 ? Math.round((baseQuotaBytes / (1024 * 1024)) * 100) / 100 : 0,
            expiresAt: baseExpiresAt ? dayjs(baseExpiresAt) : null,
            recalculateUsedBytes: false,
        });
        void loadUserStorageGrants(record.id);
    };

    const handleToggleStorageGrant = async (grant: StorageGrantItem) => {
        if (!quotaUser) return;
        setUpdatingGrantId(grant.id);
        try {
            const nextStatus = grant.status === "active" ? "revoked" : "active";
            await adminApi.updateStorageGrantStatus(grant.id, nextStatus);
            message.success(nextStatus === "revoked" ? t("admin.messages.grantRevoked") : t("admin.messages.grantRestored"));
            await loadUserStorageGrants(quotaUser.id);
            void loadUsers();
            setDetailRefreshKey((v) => v + 1);
            if (currentUser && quotaUser.id === currentUser.id) {
                const refreshed = await adminApi.getUserStorageGrants(quotaUser.id);
                useUserStore.getState().setUser({
                    ...currentUser,
                    storageQuotaBytes: refreshed.storageQuotaBytes,
                    storageQuotaExpiresAt: refreshed.storageQuotaExpiresAt,
                    storageUsedBytes: refreshed.storageUsedBytes,
                });
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.grantUpdateFailed"));
        } finally {
            setUpdatingGrantId(null);
        }
    };

    const handleSaveUserStorageQuota = async (values: UserStorageQuotaForm) => {
        if (!quotaUser) return;
        setQuotaSaving(true);
        try {
            const storageQuotaBytes = Math.max(0, Math.round(Number(values.quotaMb || 0) * 1024 * 1024));
            const res = await adminApi.updateUserStorageQuota(quotaUser.id, {
                storageQuotaBytes,
                storageQuotaExpiresAt: values.expiresAt ? values.expiresAt.toISOString() : null,
                recalculateUsedBytes: Boolean(values.recalculateUsedBytes),
            });
            message.success(t("admin.messages.quotaUpdated", { size: formatBytes(res.storageQuotaBytes) }));
            if (currentUser && quotaUser.id === currentUser.id) {
                useUserStore.getState().setUser({
                    ...currentUser,
                    storageQuotaBytes: res.storageQuotaBytes,
                    storageQuotaExpiresAt: res.storageQuotaExpiresAt,
                    storageUsedBytes: res.storageUsedBytes,
                });
            }
            setQuotaUser(null);
            void loadUsers();
            setDetailRefreshKey((v) => v + 1);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.quotaUpdateFailed"));
        } finally {
            setQuotaSaving(false);
        }
    };

    const handleAdjustUserCredits = async (values: UserCreditForm) => {
        if (!creditUser) return;
        const isClear = values.mode === "clear";
        const delta = values.mode === "deduct" ? -Math.abs(Number(values.amount)) : Math.abs(Number(values.amount));
        setCreditSaving(true);
        try {
            const res = await adminApi.adjustUserCredits(
                creditUser.id,
                isClear
                    ? { clear: true, note: values.note?.trim() || t("admin.messages.adminClearDefaultNote") }
                    : { delta, note: values.note?.trim() || "" },
            );
            message.success(isClear ? t("admin.messages.creditsCleared") : t("admin.messages.creditsAdjusted", { balance: res.balance }));
            if (currentUser && creditUser.id === currentUser.id) {
                useUserStore.getState().setUser({ ...currentUser, creditBalance: res.balance });
            }
            setCreditUser(null);
            void loadUsers();
            setDetailRefreshKey((v) => v + 1);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("admin.messages.creditsAdjustFailed"));
        } finally {
            setCreditSaving(false);
        }
    };

    return (
        <>
            <Card
                title={t("admin.usersTab.cardTitle")}
                extra={
                    <div className="flex flex-wrap items-center gap-2">
                        <Select
                            value={roleFilter}
                            className="min-w-[115px] flex-1 sm:w-[115px]! sm:flex-none"
                            onChange={(value) => {
                                setPage(1);
                                setRoleFilter(value);
                            }}
                            options={[
                                { value: "", label: t("admin.usersTab.allRoles") },
                                { value: "admin", label: t("admin.usersTab.roleAdmin") },
                                { value: "user", label: t("admin.usersTab.roleUser") },
                            ]}
                        />
                        <Select
                            value={statusFilter}
                            className="min-w-[115px] flex-1 sm:w-[115px]! sm:flex-none"
                            onChange={(value) => {
                                setPage(1);
                                setStatusFilter(value);
                            }}
                            options={[
                                { value: "", label: t("admin.usersTab.allStatuses") },
                                { value: "active", label: t("admin.usersTab.statusActive") },
                                { value: "disabled", label: t("admin.usersTab.statusDisabled") },
                            ]}
                        />
                        <Select
                            value={sort}
                            className="min-w-[140px] flex-1 sm:w-[145px]! sm:flex-none"
                            onChange={(value) => {
                                setPage(1);
                                setSort(value);
                            }}
                            options={[
                                { value: "created_desc", label: t("admin.usersTab.sortCreated") },
                                { value: "storage_desc", label: t("admin.usersTab.sortStorage") },
                            ]}
                        />
                        <Input.Search
                            allowClear
                            placeholder={t("admin.usersTab.searchPlaceholder")}
                            className="w-full! sm:w-[250px]!"
                            onSearch={(value) => {
                                setPage(1);
                                setQuery(value.trim());
                            }}
                        />
                        <Button
                            icon={<RefreshCw className="size-4" />}
                            loading={refreshing || loading}
                            onClick={() => void loadUsers(page, query, roleFilter, statusFilter, sort, pageSize, true)}
                        >
                            {t("common.refresh")}
                        </Button>
                    </div>
                }
            >
                <Table<AdminUserItem>
                    rowKey="id"
                    size="small"
                    className={ADMIN_TABLE_CLASS}
                    scroll={ADMIN_TABLE_SCROLL}
                    loading={loading}
                    dataSource={usersList}
                    pagination={{
                        current: page,
                        pageSize,
                        total,
                        showSizeChanger: true,
                        pageSizeOptions: [10, 20, 30, 50, 100],
                        showTotal: (count) => t("common.totalItems", { count }),
                        onChange: (nextPage, size) => {
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
                            title: t("admin.usersTab.colUserId"),
                            dataIndex: "id",
                            width: 210,
                            render: (id: string) => (
                                <Space size={4}>
                                    <Typography.Text type="secondary" code className="text-xs">
                                        {id}
                                    </Typography.Text>
                                    <Button
                                        size="small"
                                        type="text"
                                        icon={<Copy className="size-3" />}
                                        className="!h-5 !w-5 !min-w-0 !p-0"
                                        onClick={() => copyText(id, t("admin.redeemTab.copiedUserId"))}
                                    />
                                </Space>
                            ),
                        },
                        {
                            title: t("admin.usersTab.colAccount"),
                            key: "displayName",
                            width: 145,
                            render: (_, record) => (
                                <div className="flex max-w-[135px] items-center gap-1.5">
                                    <button
                                        type="button"
                                        className="cursor-pointer truncate border-0 bg-transparent p-0 text-left font-medium hover:underline"
                                        onClick={() => setDetailUserId(record.id)}
                                    >
                                        {record.displayName || record.username}
                                    </button>
                                    {record.id === currentUser?.id ? (
                                        <Tag style={{ marginInlineEnd: 0 }}>{t("admin.usersTab.currentTag")}</Tag>
                                    ) : null}
                                </div>
                            ),
                        },
                        {
                            title: t("admin.usersTab.colUsername"),
                            dataIndex: "username",
                            width: 120,
                            render: (username: string) => (
                                <Typography.Text type="secondary" className="block max-w-[110px] truncate text-xs">
                                    @{username}
                                </Typography.Text>
                            ),
                        },
                        {
                            title: t("admin.usersTab.colEmail"),
                            dataIndex: "email",
                            width: 170,
                            render: (email?: string | null) =>
                                email ? (
                                    <Typography.Text type="secondary" ellipsis={{ tooltip: email }} className="block max-w-[155px] text-xs">
                                        {email}
                                    </Typography.Text>
                                ) : (
                                    <Typography.Text type="secondary">—</Typography.Text>
                                ),
                        },
                        {
                            title: t("admin.usersTab.colRole"),
                            dataIndex: "role",
                            width: 85,
                            render: (role: string) => (
                                <Tag color={role === "admin" ? "blue" : "default"} style={{ marginInlineEnd: 0 }}>
                                    {role === "admin" ? t("admin.usersTab.roleAdmin") : t("admin.usersTab.roleUser")}
                                </Tag>
                            ),
                        },
                        {
                            title: t("admin.usersTab.colStatus"),
                            dataIndex: "status",
                            width: 78,
                            render: (status: string) => (
                                <Tag color={status === "active" ? "green" : "red"} style={{ marginInlineEnd: 0 }}>
                                    {status === "active" ? t("admin.usersTab.statusActive") : t("admin.usersTab.statusDisabled")}
                                </Tag>
                            ),
                        },
                        {
                            title: t("admin.usersTab.colCredits"),
                            dataIndex: "creditBalance",
                            width: 95,
                            render: (balance?: number) => (
                                <Tooltip title={t("admin.usersTab.exactBalanceTip", { value: formatExactCredits(balance ?? 0) })}>
                                    <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                                        {formatCompactCredits(balance ?? 0)}
                                    </Tag>
                                </Tooltip>
                            ),
                        },
                        {
                            title: t("admin.usersTab.colCanvasCount"),
                            dataIndex: "projectCount",
                            width: 68,
                            render: (v?: number) => <span className="tabular-nums">{v ?? 0}</span>,
                        },
                        {
                            title: t("admin.usersTab.colMediaCount"),
                            dataIndex: "mediaCount",
                            width: 68,
                            render: (v?: number) => <span className="tabular-nums">{v ?? 0}</span>,
                        },
                        {
                            title: t("admin.usersTab.colUsedStorage"),
                            dataIndex: "storageUsedBytes",
                            width: 95,
                            render: (used?: number) => <span className="whitespace-nowrap tabular-nums">{formatBytes(used ?? 0)}</span>,
                        },
                        {
                            title: t("admin.usersTab.colQuotaLimit"),
                            key: "storageQuotaLimit",
                            width: 135,
                            render: (_, record) => {
                                const used = record.storageUsedBytes ?? 0;
                                const quota = record.storageQuotaBytes ?? 0;
                                const expired = Boolean(record.storageQuotaExpiresAt && new Date(record.storageQuotaExpiresAt).getTime() <= Date.now());
                                const exceeded = expired || quota <= 0 || used >= quota;
                                return (
                                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                                        <span className="tabular-nums">{formatBytes(quota)}</span>
                                        {expired ? (
                                            <Tag color="red" style={{ marginInlineEnd: 0 }}>
                                                {t("admin.usersTab.expiredTag")}
                                            </Tag>
                                        ) : exceeded ? (
                                            <Tag color="red" style={{ marginInlineEnd: 0 }}>
                                                {quota <= 0 ? "0MB" : t("admin.usersTab.fullTag")}
                                            </Tag>
                                        ) : null}
                                    </span>
                                );
                            },
                        },
                        {
                            title: t("admin.usersTab.colQuotaExpiry"),
                            key: "storageExpiry",
                            width: 145,
                            render: (_, record) => {
                                const expirySummary = `${
                                    record.storageQuotaExpiresAt
                                        ? t("admin.usersTab.untilDate", {
                                              date: new Date(record.storageQuotaExpiresAt).toLocaleDateString(locale),
                                          })
                                        : t("admin.usersTab.permanent")
                                }${record.activeGrantCount ? t("admin.usersTab.activeGrantsSuffix", { count: record.activeGrantCount }) : ""}`;
                                return (
                                    <Typography.Text type="secondary" ellipsis={{ tooltip: expirySummary }} className="block max-w-[135px] text-xs">
                                        {expirySummary}
                                    </Typography.Text>
                                );
                            },
                        },
                        {
                            title: t("admin.channelsTab.colActions"),
                            key: "actions",
                            fixed: "right",
                            width: 150,
                            render: (_, record) => (
                                <TableRowActions
                                    items={[
                                        {
                                            key: "detail",
                                            label: t("admin.usersTab.actionDetail"),
                                            onClick: () => setDetailUserId(record.id),
                                        },
                                        {
                                            key: "quota",
                                            label: t("admin.usersTab.actionQuota"),
                                            onClick: () => openConfigStorageQuota(record),
                                        },
                                        {
                                            key: "credits",
                                            label: t("admin.usersTab.actionCredits"),
                                            onClick: () => openAdjustCredits(record),
                                        },
                                        {
                                            key: "role",
                                            label: record.role === "admin" ? t("admin.usersTab.actionDemote") : t("admin.usersTab.actionPromote"),
                                            disabled: Boolean(record.isInitialAdmin && record.role === "admin"),
                                            confirm: record.role === "admin" ? t("admin.usersTab.confirmDemote") : t("admin.usersTab.confirmPromote"),
                                            onClick: () => void handleUpdateUser(record.id, { role: record.role === "admin" ? "user" : "admin" }),
                                        },
                                        {
                                            key: "status",
                                            label: record.status === "active" ? t("admin.usersTab.actionDisable") : t("admin.usersTab.actionEnable"),
                                            danger: record.status === "active",
                                            disabled: record.id === currentUser?.id || Boolean(record.isInitialAdmin),
                                            confirm: record.status === "active" ? t("admin.usersTab.confirmDisable") : t("admin.usersTab.confirmEnable"),
                                            onClick: () => void handleUpdateUser(record.id, { status: record.status === "active" ? "disabled" : "active" }),
                                        },
                                    ]}
                                />
                            ),
                        },
                    ]}
                />
            </Card>

            <Modal
                open={Boolean(quotaUser)}
                zIndex={1020}
                title={
                    quotaUser
                        ? t("admin.modals.quota.titleWithUser", { name: quotaUser.displayName || quotaUser.username })
                        : t("admin.modals.quota.titleFallback")
                }
                width={620}
                onCancel={() => setQuotaUser(null)}
                onOk={() => quotaForm.submit()}
                confirmLoading={quotaSaving}
            >
                <Form form={quotaForm} layout="vertical" onFinish={handleSaveUserStorageQuota}>
                    <Alert
                        type="info"
                        showIcon
                        className="mb-4"
                        message={t("admin.modals.quota.alertTitle", {
                            used: formatBytes(quotaUser?.storageUsedBytes ?? 0),
                            total: formatBytes(quotaUser?.storageQuotaBytes ?? 0),
                        })}
                        description={t("admin.modals.quota.alertDesc", {
                            base: formatBytes(quotaUser?.baseStorageQuotaBytes ?? quotaUser?.storageQuotaBytes ?? 0),
                            grants: formatBytes(quotaUser?.storageGrantsQuotaBytes ?? 0),
                        })}
                    />
                    <Form.Item
                        name="quotaMb"
                        label={t("admin.modals.quota.baseQuotaLabel")}
                        rules={[{ required: true, message: t("admin.modals.quota.baseQuotaReq") }]}
                    >
                        <InputNumber min={0} step={100} className="w-full" placeholder={t("admin.modals.quota.baseQuotaPlaceholder")} />
                    </Form.Item>
                    <div className="mb-4 flex flex-wrap gap-2">
                        {[0, 100, 500, 1024, 5120, 10240].map((mb) => (
                            <Button key={mb} size="small" onClick={() => quotaForm.setFieldValue("quotaMb", mb)}>
                                {mb === 0 ? "0 MB" : mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`}
                            </Button>
                        ))}
                    </div>
                    <Form.Item name="expiresAt" label={t("admin.modals.quota.expiresLabel")}>
                        <DatePicker showTime allowClear className="w-full" placeholder={t("admin.modals.quota.expiresPlaceholder")} />
                    </Form.Item>
                    <Form.Item name="recalculateUsedBytes" label={t("admin.modals.quota.recalculateLabel")} valuePropName="checked">
                        <Switch />
                    </Form.Item>
                    {quotaUser
                        ? (() => {
                              const prevBaseBytes = quotaUser.baseStorageQuotaBytes ?? quotaUser.storageQuotaBytes ?? 0;
                              const prevTotalBytes = quotaUser.storageQuotaBytes ?? 0;
                              const usedBytes = quotaUser.storageUsedBytes ?? 0;
                              const effectiveGrantsBytes = grantsLoading
                                  ? (quotaUser.storageGrantsQuotaBytes ?? 0)
                                  : grants.length
                                    ? grants.filter((g) => g.isEffective).reduce((sum, g) => sum + g.quotaBytes, 0)
                                    : (quotaUser.storageGrantsQuotaBytes ?? 0);
                              const nextBaseBytes = Math.max(0, Math.round((Number(quotaMbWatch) || 0) * 1024 * 1024));
                              const baseExpired = Boolean(quotaExpiresAtWatch && quotaExpiresAtWatch.valueOf() <= Date.now());
                              const nextTotalBytes = (baseExpired ? 0 : nextBaseBytes) + effectiveGrantsBytes;
                              const totalDelta = nextTotalBytes - prevTotalBytes;
                              const remainingBytes = nextTotalBytes - usedBytes;

                              return (
                                  <div
                                      className="mb-3 rounded-lg border px-3 py-2.5 text-xs"
                                      style={{
                                          backgroundColor: token.colorFillQuaternary,
                                          borderColor: token.colorBorderSecondary,
                                      }}
                                  >
                                      <div className="mb-2 flex items-center justify-between gap-2">
                                          <Typography.Text strong className="text-xs">
                                              {t("admin.modals.quota.previewTitle")}
                                          </Typography.Text>
                                          {baseExpired && nextBaseBytes > 0 ? (
                                              <Tag color="red" style={{ marginInlineEnd: 0 }}>
                                                  {t("admin.modals.quota.previewBaseExpired")}
                                              </Tag>
                                          ) : null}
                                      </div>
                                      <div className="flex flex-col gap-1.5">
                                          <div className="flex flex-wrap items-center justify-between gap-2">
                                              <Typography.Text type="secondary">{t("admin.modals.quota.previewBase")}</Typography.Text>
                                              <span className="font-medium">
                                                  {formatBytes(prevBaseBytes)} → {formatBytes(nextBaseBytes)}
                                              </span>
                                          </div>
                                          <div className="flex flex-wrap items-center justify-between gap-2">
                                              <Typography.Text type="secondary">{t("admin.modals.quota.previewTotal")}</Typography.Text>
                                              <span className="inline-flex items-center gap-1.5 font-medium">
                                                  <span>
                                                      {formatBytes(prevTotalBytes)} → {formatBytes(nextTotalBytes)}
                                                  </span>
                                                  {totalDelta !== 0 ? (
                                                      <Tag color={totalDelta > 0 ? "green" : "orange"} style={{ marginInlineEnd: 0 }}>
                                                          {totalDelta > 0 ? `+${formatBytes(totalDelta)}` : `-${formatBytes(Math.abs(totalDelta))}`}
                                                      </Tag>
                                                  ) : null}
                                              </span>
                                          </div>
                                          <div className="flex flex-wrap items-center justify-between gap-2">
                                              <Typography.Text type="secondary">{t("admin.modals.quota.previewRemaining")}</Typography.Text>
                                              <span className="font-medium" style={{ color: remainingBytes < 0 ? token.colorError : undefined }}>
                                                  {remainingBytes >= 0
                                                      ? formatBytes(remainingBytes)
                                                      : t("admin.modals.quota.previewOverQuota", { over: formatBytes(Math.abs(remainingBytes)) })}
                                              </span>
                                          </div>
                                      </div>
                                  </div>
                              );
                          })()
                        : null}
                </Form>

                <div className="mt-2 border-t pt-3" style={{ borderColor: token.colorBorderSecondary }}>
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <Typography.Text strong className="text-xs">
                            {t("admin.modals.quota.grantsTitle", { count: grants.length })}
                        </Typography.Text>
                        <Typography.Text type="secondary" className="text-xs">
                            {t("admin.modals.quota.grantsHint")}
                        </Typography.Text>
                    </div>
                    {grantsLoading ? (
                        <Typography.Text type="secondary" className="text-xs">
                            {t("admin.modals.quota.grantsLoading")}
                        </Typography.Text>
                    ) : grants.length ? (
                        <div className="flex max-h-48 flex-col gap-2 overflow-y-auto pr-1">
                            {grants.map((grant) => (
                                <div
                                    key={grant.id}
                                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs"
                                    style={{ borderColor: token.colorBorderSecondary }}
                                >
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-1.5">
                                            <span className="font-medium">+{formatBytes(grant.quotaBytes)}</span>
                                            {grant.status === "revoked" ? (
                                                <Tag color="default" style={{ marginInlineEnd: 0 }}>
                                                    {t("admin.modals.quota.grantRevoked")}
                                                </Tag>
                                            ) : grant.isExpired ? (
                                                <Tag color="red" style={{ marginInlineEnd: 0 }}>
                                                    {t("admin.modals.quota.grantExpired")}
                                                </Tag>
                                            ) : (
                                                <Tag color="green" style={{ marginInlineEnd: 0 }}>
                                                    {t("admin.modals.quota.grantActive")}
                                                </Tag>
                                            )}
                                            {grant.refId ? (
                                                <Typography.Text code className="text-[11px]">
                                                    {grant.refId}
                                                </Typography.Text>
                                            ) : null}
                                        </div>
                                        <Typography.Text type="secondary" className="mt-0.5 block text-[11px]">
                                            {grant.expiresAt
                                                ? t("admin.modals.quota.grantExpiresAt", { time: new Date(grant.expiresAt).toLocaleString(locale) })
                                                : t("admin.modals.quota.grantPermanent")}
                                            {grant.durationDays ? t("admin.modals.quota.grantDurationDays", { days: grant.durationDays }) : ""}
                                            {grant.note ? ` · ${grant.note}` : ""}
                                        </Typography.Text>
                                    </div>
                                    <Button
                                        size="small"
                                        type="link"
                                        danger={grant.status === "active"}
                                        loading={updatingGrantId === grant.id}
                                        onClick={() => void handleToggleStorageGrant(grant)}
                                    >
                                        {grant.status === "active" ? t("admin.modals.quota.grantRevokeBtn") : t("admin.modals.quota.grantRestoreBtn")}
                                    </Button>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <Typography.Text type="secondary" className="text-xs">
                            {t("admin.modals.quota.grantsEmpty")}
                        </Typography.Text>
                    )}
                </div>
            </Modal>

            <Modal
                open={Boolean(creditUser)}
                zIndex={1020}
                title={
                    creditUser
                        ? t("admin.modals.credit.titleWithUser", {
                              name: creditUser.displayName || creditUser.username,
                              balance: creditUser.creditBalance ?? 0,
                          })
                        : t("admin.modals.credit.titleFallback")
                }
                onCancel={() => setCreditUser(null)}
                onOk={() => creditForm.submit()}
                okText={creditModeWatch === "clear" ? t("admin.modals.credit.confirmClear") : t("common.confirm")}
                okButtonProps={{ danger: creditModeWatch === "clear" }}
                confirmLoading={creditSaving}
            >
                <Form form={creditForm} layout="vertical" onFinish={handleAdjustUserCredits}>
                    <Form.Item name="mode" label={t("admin.modals.credit.modeLabel")} rules={[{ required: true }]}>
                        <Radio.Group>
                            <Radio.Button value="add">{t("admin.modals.credit.modeAdd")}</Radio.Button>
                            <Radio.Button value="deduct">{t("admin.modals.credit.modeDeduct")}</Radio.Button>
                            <Radio.Button value="clear">{t("admin.modals.credit.modeClear")}</Radio.Button>
                        </Radio.Group>
                    </Form.Item>
                    {creditModeWatch === "clear" ? (
                        <Alert
                            type="warning"
                            showIcon
                            className="mb-4"
                            message={t("admin.modals.credit.clearAlertTitle", { balance: creditUser?.creditBalance ?? 0 })}
                            description={t("admin.modals.credit.clearAlertDesc")}
                        />
                    ) : (
                        <Form.Item
                            name="amount"
                            label={t("admin.modals.credit.amountLabel")}
                            rules={[{ required: true, message: t("admin.modals.credit.amountReq") }]}
                        >
                            <InputNumber className="w-full" min={0.0001} step={10} />
                        </Form.Item>
                    )}
                    <Form.Item name="note" label={t("admin.modals.credit.noteLabel")}>
                        <Input placeholder={creditModeWatch === "clear" ? t("admin.modals.credit.clearNotePlaceholder") : t("admin.modals.credit.adjustNotePlaceholder")} />
                    </Form.Item>
                    {creditUser
                        ? (() => {
                              const currentBalance = creditUser.creditBalance ?? 0;
                              const amount = Math.max(0, Number(creditAmountWatch) || 0);
                              const delta = creditModeWatch === "clear" ? -currentBalance : creditModeWatch === "deduct" ? -amount : amount;
                              const afterBalance = Math.round((currentBalance + delta) * 10000) / 10000;
                              const insufficient = afterBalance < 0;

                              return (
                                  <div
                                      className="rounded-lg border px-3 py-2.5 text-xs"
                                      style={{
                                          backgroundColor: token.colorFillQuaternary,
                                          borderColor: token.colorBorderSecondary,
                                      }}
                                  >
                                      <div className="mb-2 flex items-center justify-between gap-2">
                                          <Typography.Text strong className="text-xs">
                                              {t("admin.modals.credit.previewTitle")}
                                          </Typography.Text>
                                          {insufficient ? (
                                              <Tag color="red" style={{ marginInlineEnd: 0 }}>
                                                  {t("admin.modals.credit.previewInsufficient")}
                                              </Tag>
                                          ) : null}
                                      </div>
                                      <div className="flex flex-col gap-1.5">
                                          <div className="flex flex-wrap items-center justify-between gap-2">
                                              <Typography.Text type="secondary">{t("admin.modals.credit.previewCurrent")}</Typography.Text>
                                              <span className="font-medium">{formatExactCredits(currentBalance)}</span>
                                          </div>
                                          <div className="flex flex-wrap items-center justify-between gap-2">
                                              <Typography.Text type="secondary">{t("admin.modals.credit.previewDelta")}</Typography.Text>
                                              <Tag color={delta > 0 ? "green" : delta < 0 ? (insufficient ? "red" : "orange") : "default"} style={{ marginInlineEnd: 0 }}>
                                                  {delta > 0 ? `+${formatExactCredits(delta)}` : delta < 0 ? `-${formatExactCredits(Math.abs(delta))}` : "0"}
                                              </Tag>
                                          </div>
                                          <div className="flex flex-wrap items-center justify-between gap-2">
                                              <Typography.Text type="secondary">{t("admin.modals.credit.previewAfter")}</Typography.Text>
                                              <span className="font-semibold" style={{ color: insufficient ? token.colorError : token.colorPrimary }}>
                                                  {formatExactCredits(afterBalance)}
                                              </span>
                                          </div>
                                      </div>
                                  </div>
                              );
                          })()
                        : null}
                </Form>
            </Modal>

            <UserDetailDrawer
                userId={detailUserId}
                refreshKey={detailRefreshKey}
                onClose={() => setDetailUserId(null)}
                onOpenCredits={(target) => openAdjustCredits(target)}
                onOpenQuota={(target) => openConfigStorageQuota(target)}
                onUpdateUser={handleUpdateUser}
            />
        </>
    );
}
