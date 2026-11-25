import type { ThemeConfig } from "antd";
import { theme as antdTheme } from "antd";

const neutral = {
    light: {
        primary: "#171717",
        primaryHover: "#000000",
        primaryText: "#ffffff",
        primaryBg: "#f5f5f5",
        primaryBgHover: "#e5e5e5",
        primaryBorder: "#d4d4d4",
        primaryBorderHover: "#a3a3a3",
        infoBg: "#f5f5f5",
        infoBgHover: "#ededed",
        infoBorder: "#e5e5e5",
        infoBorderHover: "#d4d4d4",
        controlOutline: "rgba(23, 23, 23, 0.1)",
        spotlightBg: "#171717",
        elevatedBg: "#ffffff",
        itemHoverBg: "rgba(23, 23, 23, 0.06)",
        itemSelectedBg: "rgba(23, 23, 23, 0.1)",
        itemSelectedHoverBg: "rgba(23, 23, 23, 0.14)",
        itemText: "#171717",
        tableSelectedBg: "rgba(17, 17, 17, 0.05)",
        tableSelectedHoverBg: "rgba(17, 17, 17, 0.08)",
    },
    dark: {
        primary: "#fafafa",
        primaryHover: "#ffffff",
        primaryText: "#171717",
        primaryBg: "#262626",
        primaryBgHover: "#333333",
        primaryBorder: "#525252",
        primaryBorderHover: "#737373",
        infoBg: "#262626",
        infoBgHover: "#333333",
        infoBorder: "#404040",
        infoBorderHover: "#525252",
        controlOutline: "rgba(250, 250, 249, 0.16)",
        spotlightBg: "#333333",
        elevatedBg: "#1c1917",
        itemHoverBg: "rgba(250, 250, 249, 0.08)",
        itemSelectedBg: "rgba(250, 250, 249, 0.12)",
        itemSelectedHoverBg: "rgba(250, 250, 249, 0.16)",
        itemText: "#fafafa",
        tableSelectedBg: "rgba(255, 255, 255, 0.08)",
        tableSelectedHoverBg: "rgba(255, 255, 255, 0.12)",
    },
};

export function getAntThemeConfig(dark: boolean): ThemeConfig {
    const color = dark ? neutral.dark : neutral.light;

    return {
        algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        cssVar: { key: dark ? "infinite-canvas-dark" : "infinite-canvas-light" },
        token: {
            colorPrimary: color.primary,
            colorPrimaryBg: color.primaryBg,
            colorPrimaryBgHover: color.primaryBgHover,
            colorPrimaryBorder: color.primaryBorder,
            colorPrimaryBorderHover: color.primaryBorderHover,
            colorInfo: color.primary,
            colorInfoBg: color.infoBg,
            colorInfoBgHover: color.infoBgHover,
            colorInfoBorder: color.infoBorder,
            colorInfoBorderHover: color.infoBorderHover,
            colorLink: color.primary,
            colorLinkHover: color.primaryHover,
            colorLinkActive: color.primary,
            // 保持全局亮色反白文本为白色，避免深色模式下 Tooltip、Badge、危险实心按钮、图片预览工具条变成黑字；主色底文字由组件 Token 单独指定
            colorTextLightSolid: "#ffffff",
            colorBgSpotlight: color.spotlightBg,
            colorBgElevated: color.elevatedBg,
            controlOutline: color.controlOutline,
            controlItemBgHover: color.itemHoverBg,
            controlItemBgActive: color.itemSelectedBg,
            controlItemBgActiveHover: color.itemSelectedHoverBg,
        },
        components: {
            Button: {
                primaryShadow: "none",
                primaryColor: color.primaryText,
                dangerColor: "#ffffff",
            },
            Dropdown: {
                colorBgElevated: color.elevatedBg,
                colorText: color.itemText,
                controlItemBgHover: color.itemHoverBg,
                controlItemBgActive: color.itemSelectedBg,
                controlItemBgActiveHover: color.itemSelectedHoverBg,
            },
            Menu: {
                popupBg: color.elevatedBg,
                itemActiveBg: color.itemSelectedBg,
                itemHoverBg: color.itemHoverBg,
                itemSelectedBg: color.itemSelectedBg,
                itemSelectedColor: color.itemText,
                darkPopupBg: neutral.dark.elevatedBg,
                darkItemHoverBg: neutral.dark.itemHoverBg,
                darkItemSelectedBg: neutral.dark.itemSelectedBg,
                darkItemSelectedColor: neutral.dark.itemText,
            },
            Radio: {
                buttonSolidCheckedColor: color.primaryText,
            },
            Select: {
                optionActiveBg: color.itemHoverBg,
                optionSelectedBg: color.itemSelectedBg,
                optionSelectedColor: color.itemText,
            },
            Slider: {
                trackBg: color.primary,
                trackHoverBg: color.primaryHover,
                handleColor: color.primary,
                handleActiveColor: color.primaryHover,
            },
            Table: {
                rowSelectedBg: color.tableSelectedBg,
                rowSelectedHoverBg: color.tableSelectedHoverBg,
            },
            Tree: {
                directoryNodeSelectedColor: color.primaryText,
            },
        },
    };
}
