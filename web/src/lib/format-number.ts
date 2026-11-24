/** 数值与积分紧凑格式化工具：自动将大数值转换为 K / M / B 单位，同时保留完整精度格式化函数用于 Tooltip。 */

export function formatExactCredits(value: number | null | undefined, maxFractionDigits = 4): string {
    const num = Number(value ?? 0);
    if (!Number.isFinite(num)) return "0";
    return num.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: maxFractionDigits });
}

export function formatCompactCredits(value: number | null | undefined, compactDecimals = 2): string {
    const num = Number(value ?? 0);
    if (!Number.isFinite(num) || num === 0) return "0";
    const abs = Math.abs(num);
    if (abs >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(compactDecimals).replace(/\.?0+$/, "")}B`;
    if (abs >= 1_000_000) return `${(num / 1_000_000).toFixed(compactDecimals).replace(/\.?0+$/, "")}M`;
    if (abs >= 1_000) return `${(num / 1_000).toFixed(compactDecimals).replace(/\.?0+$/, "")}K`;
    return Number(num.toFixed(4)).toString();
}

export function formatCompactCount(value: number | null | undefined, compactDecimals = 2): string {
    const num = Number(value ?? 0);
    if (!Number.isFinite(num) || num === 0) return "0";
    const abs = Math.abs(num);
    if (abs >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(compactDecimals).replace(/\.?0+$/, "")}B`;
    if (abs >= 1_000_000) return `${(num / 1_000_000).toFixed(compactDecimals).replace(/\.?0+$/, "")}M`;
    if (abs >= 1_000) return `${(num / 1_000).toFixed(compactDecimals).replace(/\.?0+$/, "")}K`;
    return Math.round(num).toLocaleString("en-US");
}
