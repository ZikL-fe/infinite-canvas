/** 后台表格统一操作栏：限制最多展示 3 个入口（超出折叠至「更多」下拉），保证单行不换行。 */
import { App, Button, Dropdown, Popconfirm, type MenuProps } from "antd";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";

export type TableActionItem = {
    key: string;
    label: string;
    danger?: boolean;
    disabled?: boolean;
    loading?: boolean;
    confirm?: string;
    href?: string;
    onClick?: () => void;
};

export const ADMIN_TABLE_SCROLL = { x: "max-content" } as const;
export const ADMIN_TABLE_CLASS = "[&_th]:!whitespace-nowrap [&_td]:!whitespace-nowrap";

export function TableRowActions({ items }: { items: TableActionItem[] }) {
    const { modal } = App.useApp();
    const { t } = useTranslation();

    if (!items.length) return null;

    const visibleItems = items.length > 3 ? items.slice(0, 2) : items;
    const overflowItems = items.length > 3 ? items.slice(2) : [];

    const renderAction = (item: TableActionItem) => {
        if (item.href) {
            return (
                <a
                    key={item.key}
                    href={item.href}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-6 items-center whitespace-nowrap px-1 text-xs leading-none"
                    onClick={(e) => e.stopPropagation()}
                >
                    {item.label}
                </a>
            );
        }

        const button = (
            <Button
                key={item.key}
                type="link"
                size="small"
                danger={item.danger}
                disabled={item.disabled}
                loading={item.loading}
                className="!h-6 !px-1 !text-xs whitespace-nowrap"
                onClick={
                    item.confirm
                        ? undefined
                        : (e) => {
                              e.stopPropagation();
                              item.onClick?.();
                          }
                }
            >
                {item.label}
            </Button>
        );

        if (item.confirm && !item.disabled) {
            return (
                <Popconfirm
                    key={item.key}
                    title={item.confirm}
                    onConfirm={(e) => {
                        e?.stopPropagation();
                        item.onClick?.();
                    }}
                    onCancel={(e) => e?.stopPropagation()}
                >
                    {button}
                </Popconfirm>
            );
        }

        return button;
    };

    const moreMenuItems: MenuProps["items"] = overflowItems.map((item) => ({
        key: item.key,
        label: item.label,
        danger: item.danger,
        disabled: item.disabled,
        onClick: (info) => {
            info.domEvent.stopPropagation();
            if (item.confirm) {
                modal.confirm({
                    title: item.confirm,
                    okButtonProps: { danger: item.danger },
                    onOk: () => item.onClick?.(),
                });
                return;
            }
            item.onClick?.();
        },
    }));

    return (
        <div className="inline-flex flex-nowrap items-center gap-0.5 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
            {visibleItems.map(renderAction)}
            {overflowItems.length ? (
                <Dropdown menu={{ items: moreMenuItems }} trigger={["click"]} placement="bottomRight">
                    <Button
                        type="link"
                        size="small"
                        className="!h-6 !px-1 !text-xs whitespace-nowrap"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <span className="inline-flex items-center gap-0.5">
                            {t("common.more")}
                            <ChevronDown className="size-3" />
                        </span>
                    </Button>
                </Dropdown>
            ) : null}
        </div>
    );
}
