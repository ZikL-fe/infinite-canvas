/** Markdown 富文本渲染包装组件：将 streamdown 及其样式拆入按需分包，避免拖慢首屏加载。 */
import "streamdown/styles.css";

export { Streamdown as default, type LinkSafetyModalProps } from "streamdown";
