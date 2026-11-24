/** 平台 / 个人数据看板：支持今天/24h/7d/30d、ECharts 堆叠分布与趋势分析及管理员用户消耗排行。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { App, Button, Empty, Segmented, Spin, Tabs, Tag, Tooltip, Typography, theme as antdTheme } from "antd";
import * as echarts from "echarts";
import { RefreshCw } from "lucide-react";

import { formatCompactCount, formatCompactCredits, formatExactCredits } from "@/lib/format-number";
import { accountApi, adminApi, type AnalyticsDashboardResponse, type DashboardRange } from "@/services/api/server";

const CHART_PALETTE = [
    "#3b82f6",
    "#38bdf8",
    "#10b981",
    "#f59e0b",
    "#8b5cf6",
    "#ec4899",
    "#14b8a6",
    "#f97316",
    "#6366f1",
    "#84cc16",
    "#06b6d4",
    "#ef4444",
];

function EChartBox({
    option,
    height = 300,
}: {
    option: echarts.EChartsOption;
    height?: number;
}) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const chartRef = useRef<echarts.ECharts | null>(null);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const chart = echarts.init(el);
        chartRef.current = chart;
        const observer = new ResizeObserver(() => {
            chart.resize();
        });
        observer.observe(el);
        return () => {
            observer.disconnect();
            chart.dispose();
            chartRef.current = null;
        };
    }, []);

    useEffect(() => {
        if (!chartRef.current) return;
        chartRef.current.setOption(option, { notMerge: true });
    }, [option]);

    return <div ref={containerRef} style={{ width: "100%", height }} />;
}

const rangeOptions: Array<{ label: string; value: DashboardRange }> = [
    { label: "今天", value: "today" },
    { label: "过去 24 小时", value: "24h" },
    { label: "过去 7 天", value: "7d" },
    { label: "过去 30 天", value: "30d" },
];

export function AnalyticsDashboardPanel({ scope }: { scope: "all" | "self" }) {
    const { message } = App.useApp();
    const { token } = antdTheme.useToken();
    const [range, setRange] = useState<DashboardRange>("24h");
    const [data, setData] = useState<AnalyticsDashboardResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [creditChartType, setCreditChartType] = useState<"bar" | "area">("bar");
    const [callChartMode, setCallChartMode] = useState<"trend" | "ranking">("trend");

    const loadDashboard = useCallback(
        async (targetRange = range, force = false) => {
            setLoading(true);
            try {
                const res =
                    scope === "all"
                        ? await adminApi.getDashboard(targetRange, force)
                        : await accountApi.getDashboard(targetRange, force);
                setData(res);
            } catch (error) {
                message.error(error instanceof Error ? error.message : "加载数据看板失败");
            } finally {
                setLoading(false);
            }
        },
        [message, range, scope],
    );

    useEffect(() => {
        void loadDashboard(range, false);
    }, [loadDashboard, range]);

    const summary = data?.summary;
    const textColor = token.colorText;
    const secondaryColor = token.colorTextSecondary;
    const splitLineColor = token.colorBorderSecondary;
    const tooltipBg = token.colorBgElevated;

    const commonTooltip = {
        backgroundColor: tooltipBg,
        borderColor: splitLineColor,
        textStyle: { color: textColor, fontSize: 12 },
    };

    const creditChartOption: echarts.EChartsOption = data
        ? {
              color: CHART_PALETTE,
              tooltip: {
                  ...commonTooltip,
                  trigger: "axis",
                  axisPointer: { type: creditChartType === "bar" ? "shadow" : "line" },
              },
              legend: {
                  type: "scroll",
                  bottom: 0,
                  textStyle: { color: secondaryColor, fontSize: 11 },
                  pageTextStyle: { color: secondaryColor },
              },
              grid: { left: 48, right: 16, top: 18, bottom: 42 },
              xAxis: {
                  type: "category",
                  data: data.buckets,
                  axisLine: { lineStyle: { color: splitLineColor } },
                  axisLabel: { color: secondaryColor, fontSize: 11 },
              },
              yAxis: {
                  type: "value",
                  splitLine: { lineStyle: { color: splitLineColor, type: "dashed" } },
                  axisLabel: {
                      color: secondaryColor,
                      fontSize: 11,
                      formatter: (val: number) => formatCompactCredits(val),
                  },
              },
              series: data.modelCreditSeries.map((s) =>
                  creditChartType === "bar"
                      ? {
                            name: s.model,
                            type: "bar",
                            stack: "credits",
                            barMaxWidth: 28,
                            emphasis: { focus: "series" },
                            data: s.data,
                        }
                      : {
                            name: s.model,
                            type: "line",
                            stack: "credits",
                            smooth: true,
                            showSymbol: false,
                            areaStyle: { opacity: 0.35 },
                            lineStyle: { width: 1.5 },
                            emphasis: { focus: "series" },
                            data: s.data,
                        },
              ),
          }
        : {};

    const modelCallOption: echarts.EChartsOption = data
        ? callChartMode === "trend"
            ? {
                  color: CHART_PALETTE,
                  tooltip: {
                      ...commonTooltip,
                      trigger: "axis",
                  },
                  legend: {
                      type: "scroll",
                      bottom: 0,
                      textStyle: { color: secondaryColor, fontSize: 11 },
                      pageTextStyle: { color: secondaryColor },
                  },
                  grid: { left: 48, right: 16, top: 18, bottom: 42 },
                  xAxis: {
                      type: "category",
                      data: data.buckets,
                      axisLine: { lineStyle: { color: splitLineColor } },
                      axisLabel: { color: secondaryColor, fontSize: 11 },
                  },
                  yAxis: {
                      type: "value",
                      splitLine: { lineStyle: { color: splitLineColor, type: "dashed" } },
                      axisLabel: {
                          color: secondaryColor,
                          fontSize: 11,
                          formatter: (val: number) => formatCompactCount(val),
                      },
                  },
                  series: data.modelCallSeries.map((s) => ({
                      name: s.model,
                      type: "line",
                      smooth: true,
                      showSymbol: false,
                      areaStyle: { opacity: 0.14 },
                      lineStyle: { width: 2 },
                      data: s.data,
                  })),
              }
            : {
                  tooltip: {
                      ...commonTooltip,
                      trigger: "axis",
                      axisPointer: { type: "shadow" },
                  },
                  grid: { left: 160, right: 56, top: 10, bottom: 20 },
                  xAxis: {
                      type: "value",
                      splitLine: { lineStyle: { color: splitLineColor, type: "dashed" } },
                      axisLabel: {
                          color: secondaryColor,
                          fontSize: 11,
                          formatter: (val: number) => formatCompactCount(val),
                      },
                  },
                  yAxis: {
                      type: "category",
                      inverse: true,
                      data: data.modelRanking.slice(0, 10).map((m) => m.model),
                      axisLine: { lineStyle: { color: splitLineColor } },
                      axisLabel: { color: textColor, fontSize: 11, width: 145, overflow: "truncate" },
                  },
                  series: [
                      {
                          name: "调用次数",
                          type: "bar",
                          barMaxWidth: 20,
                          data: data.modelRanking.slice(0, 10).map((m, idx) => ({
                              value: m.calls,
                              itemStyle: { color: CHART_PALETTE[idx % CHART_PALETTE.length], borderRadius: [0, 4, 4, 0] },
                          })),
                          label: {
                              show: true,
                              position: "right",
                              color: secondaryColor,
                              fontSize: 11,
                              formatter: (p) => `${formatCompactCount(Number(p.value))} 次`,
                          },
                      },
                  ],
              }
        : {};

    const rankedUsers = data?.userRanking ?? [];
    const userRankingOption: echarts.EChartsOption = rankedUsers.length
        ? {
              tooltip: {
                  ...commonTooltip,
                  trigger: "axis",
                  axisPointer: { type: "shadow" },
                  formatter: (params: unknown) => {
                      const arr = Array.isArray(params) ? params : [params];
                      const first = arr[0] as { dataIndex?: number } | undefined;
                      const item = rankedUsers[first?.dataIndex ?? 0];
                      if (!item) return "";
                      const name = item.displayName && item.displayName !== item.username ? `${item.displayName} (@${item.username})` : item.username;
                      return `${name}<br/>消耗积分：${formatExactCredits(item.credits)}<br/>调用次数：${item.calls} 次`;
                  },
              },
              grid: { left: 150, right: 64, top: 10, bottom: 20 },
              xAxis: {
                  type: "value",
                  splitLine: { lineStyle: { color: splitLineColor, type: "dashed" } },
                  axisLabel: {
                      color: secondaryColor,
                      fontSize: 11,
                      formatter: (val: number) => formatCompactCredits(val),
                  },
              },
              yAxis: {
                  type: "category",
                  inverse: true,
                  data: rankedUsers.map((u) => (u.displayName && u.displayName !== u.username ? `${u.displayName} (${u.username})` : u.username)),
                  axisLine: { lineStyle: { color: splitLineColor } },
                  axisLabel: { color: textColor, fontSize: 11, width: 135, overflow: "truncate" },
              },
              series: [
                  {
                      name: "消耗积分",
                      type: "bar",
                      barMaxWidth: 20,
                      data: rankedUsers.map((u, idx) => ({
                          value: u.credits,
                          itemStyle: { color: CHART_PALETTE[idx % CHART_PALETTE.length], borderRadius: [0, 4, 4, 0] },
                      })),
                      label: {
                          show: true,
                          position: "right",
                          color: secondaryColor,
                          fontSize: 11,
                          formatter: (p) => formatCompactCredits(Number(p.value)),
                      },
                  },
              ],
          }
        : {};

    const userTrends = data?.userTrendSeries ?? [];
    const userTrendOption: echarts.EChartsOption = data && userTrends.length
        ? {
              color: CHART_PALETTE,
              tooltip: {
                  ...commonTooltip,
                  trigger: "axis",
              },
              legend: {
                  type: "scroll",
                  bottom: 0,
                  textStyle: { color: secondaryColor, fontSize: 11 },
                  pageTextStyle: { color: secondaryColor },
              },
              grid: { left: 48, right: 16, top: 18, bottom: 42 },
              xAxis: {
                  type: "category",
                  data: data.buckets,
                  axisLine: { lineStyle: { color: splitLineColor } },
                  axisLabel: { color: secondaryColor, fontSize: 11 },
              },
              yAxis: {
                  type: "value",
                  splitLine: { lineStyle: { color: splitLineColor, type: "dashed" } },
                  axisLabel: {
                      color: secondaryColor,
                      fontSize: 11,
                      formatter: (val: number) => formatCompactCredits(val),
                  },
              },
              series: userTrends.map((u) => ({
                  name: u.label,
                  type: "line",
                  smooth: true,
                  showSymbol: false,
                  areaStyle: { opacity: 0.14 },
                  lineStyle: { width: 2 },
                  data: u.data,
              })),
          }
        : {};

    const kpis = [
        {
            label: "总请求数",
            display: formatCompactCount(summary?.totalCalls ?? 0),
            exact: `${(summary?.totalCalls ?? 0).toLocaleString("en-US")} 次`,
            sub: "统计请求数",
        },
        {
            label: "消耗积分",
            display: formatCompactCredits(summary?.totalConsumedCredits ?? 0),
            exact: `${formatExactCredits(summary?.totalConsumedCredits ?? 0)} 积分`,
            sub: "周期净消耗",
        },
        {
            label: "总 Token 数",
            display: formatCompactCount(summary?.totalTokens ?? 0),
            exact: `输入 ${formatExactCredits(summary?.inputTokens ?? 0, 0)} / 输出 ${formatExactCredits(summary?.outputTokens ?? 0, 0)}`,
            sub: "累计 Token 数",
        },
        {
            label: "缓存命中 Token",
            display: formatCompactCount(summary?.cachedInputTokens ?? 0),
            exact: `${(summary?.cachedInputTokens ?? 0).toLocaleString("en-US")} Tokens`,
            sub: "缓存输入命中",
        },
        {
            label: "平均 RPM",
            display: String(summary?.avgRpm ?? 0),
            exact: `${summary?.avgRpm ?? 0} 次/分钟`,
            sub: "每分钟请求数",
        },
        {
            label: "平均 TPM",
            display: formatCompactCount(summary?.avgTpm ?? 0),
            exact: `${(summary?.avgTpm ?? 0).toLocaleString("en-US")} Tokens/分钟`,
            sub: "每分钟 Token 数",
        },
    ];

    const overviewContent = (
        <div className="flex flex-col gap-4">
            {/* 顶部 6 张等高 KPI 卡片 */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                {kpis.map((item) => (
                    <Tooltip key={item.label} title={item.exact}>
                        <div
                            className="flex flex-col justify-between rounded-xl border p-3.5"
                            style={{
                                borderColor: token.colorBorderSecondary,
                                backgroundColor: token.colorBgContainer,
                            }}
                        >
                            <div className="text-xs" style={{ color: token.colorTextSecondary }}>
                                {item.label}
                            </div>
                            <div className="mt-1.5 text-xl font-semibold tabular-nums" style={{ color: token.colorText }}>
                                {item.display}
                            </div>
                            <div className="mt-1.5 text-[11px]" style={{ color: token.colorTextTertiary }}>
                                {item.sub}
                            </div>
                        </div>
                    </Tooltip>
                ))}
            </div>

            {/* 模型性能摘要条 */}
            <div
                className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border px-4 py-2.5 text-xs"
                style={{
                    borderColor: token.colorBorderSecondary,
                    backgroundColor: token.colorFillAlter,
                }}
            >
                <span className="font-medium" style={{ color: token.colorText }}>
                    性能摘要
                </span>
                <span style={{ color: token.colorTextSecondary }}>
                    成功率 <strong style={{ color: token.colorSuccess }}>{summary?.successRate ?? 100}%</strong>
                </span>
                <span style={{ color: token.colorTextSecondary }}>
                    平均延迟 <strong style={{ color: token.colorText }}>{((summary?.avgLatencyMs ?? 0) / 1000).toFixed(2)}s</strong>
                </span>
                <span style={{ color: token.colorTextSecondary }}>
                    平均吞吐 <strong style={{ color: token.colorText }}>{summary?.avgTokensPerSecond ?? 0} t/s</strong>
                </span>
                {(data?.modelHealth ?? []).map((m) => (
                    <Tag
                        key={m.model}
                        color={m.successRate >= 98 ? "green" : m.successRate >= 90 ? "orange" : "red"}
                        style={{ marginInlineEnd: 0 }}
                    >
                        {m.model} · {m.successRate}%
                    </Tag>
                ))}
            </div>

            {/* 消耗分布图 */}
            <div
                className="rounded-xl border p-4"
                style={{
                    borderColor: token.colorBorderSecondary,
                    backgroundColor: token.colorBgContainer,
                }}
            >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold" style={{ color: token.colorText }}>
                            消耗分布
                        </span>
                        <Tooltip title={`精确净消耗：${formatExactCredits(summary?.totalConsumedCredits ?? 0)} 积分`}>
                            <Typography.Text type="secondary" className="text-xs">
                                总计：{formatCompactCredits(summary?.totalConsumedCredits ?? 0)} 积分
                            </Typography.Text>
                        </Tooltip>
                    </div>
                    <Segmented
                        size="small"
                        value={creditChartType}
                        onChange={(val) => setCreditChartType(val as "bar" | "area")}
                        options={[
                            { label: "柱状图", value: "bar" },
                            { label: "面积图", value: "area" },
                        ]}
                    />
                </div>
                {data && data.modelCreditSeries.length ? (
                    <EChartBox option={creditChartOption} height={300} />
                ) : (
                    <div className="py-12">
                        <Empty description="当前时间范围内暂无消耗数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                    </div>
                )}
            </div>

            {/* 模型调用分析 */}
            <div
                className="rounded-xl border p-4"
                style={{
                    borderColor: token.colorBorderSecondary,
                    backgroundColor: token.colorBgContainer,
                }}
            >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold" style={{ color: token.colorText }}>
                            模型调用分析
                        </span>
                        <Typography.Text type="secondary" className="text-xs">
                            总计：{formatCompactCount(summary?.totalCalls ?? 0)} 次
                        </Typography.Text>
                    </div>
                    <Segmented
                        size="small"
                        value={callChartMode}
                        onChange={(val) => setCallChartMode(val as "trend" | "ranking")}
                        options={[
                            { label: "调用趋势", value: "trend" },
                            { label: "调用次数排行", value: "ranking" },
                        ]}
                    />
                </div>
                {data && data.modelRanking.length ? (
                    <EChartBox option={modelCallOption} height={callChartMode === "ranking" ? Math.max(240, data.modelRanking.slice(0, 10).length * 34) : 280} />
                ) : (
                    <div className="py-12">
                        <Empty description="当前时间范围内暂无调用记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                    </div>
                )}
            </div>
        </div>
    );

    const userAnalyticsContent = (
        <div className="flex flex-col gap-4">
            <div
                className="rounded-xl border p-4"
                style={{
                    borderColor: token.colorBorderSecondary,
                    backgroundColor: token.colorBgContainer,
                }}
            >
                <div className="mb-3 flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold" style={{ color: token.colorText }}>
                        用户消耗排行（Top 10）
                    </span>
                    <Typography.Text type="secondary" className="text-xs">
                        排行合计：{formatCompactCredits(rankedUsers.reduce((acc, u) => acc + u.credits, 0))} 积分
                    </Typography.Text>
                </div>
                {rankedUsers.length ? (
                    <EChartBox option={userRankingOption} height={Math.max(220, rankedUsers.length * 34)} />
                ) : (
                    <div className="py-10">
                        <Empty description="暂无用户消耗排行数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                    </div>
                )}
            </div>

            <div
                className="rounded-xl border p-4"
                style={{
                    borderColor: token.colorBorderSecondary,
                    backgroundColor: token.colorBgContainer,
                }}
            >
                <div className="mb-3 flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold" style={{ color: token.colorText }}>
                        用户消耗趋势（Top 10）
                    </span>
                    <Typography.Text type="secondary" className="text-xs">
                        总计：{formatCompactCredits(rankedUsers.reduce((acc, u) => acc + u.credits, 0))} 积分
                    </Typography.Text>
                </div>
                {userTrends.length ? (
                    <EChartBox option={userTrendOption} height={280} />
                ) : (
                    <div className="py-10">
                        <Empty description="暂无用户消耗趋势数据" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                    </div>
                )}
            </div>
        </div>
    );

    return (
        <Spin spinning={loading && !data}>
            <div className="flex flex-col gap-4">
                {/* 顶部时间窗口与采样状态栏 */}
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <Segmented
                        value={range}
                        options={rangeOptions}
                        onChange={(val) => setRange(val as DashboardRange)}
                    />
                    <div className="flex flex-wrap items-center gap-2.5">
                        {data ? (
                            <Typography.Text type="secondary" className="text-xs">
                                采样周期 {data.sampleIntervalMinutes} 分钟 · 上次采样 {new Date(data.sampledAt).toLocaleTimeString("zh-CN")}
                            </Typography.Text>
                        ) : null}
                        <Button
                            size="small"
                            icon={<RefreshCw className="size-3.5" />}
                            loading={loading}
                            onClick={() => void loadDashboard(range, true)}
                        >
                            立即采样刷新
                        </Button>
                    </div>
                </div>

                {scope === "all" ? (
                    <Tabs
                        destroyOnHidden
                        items={[
                            {
                                key: "overview",
                                label: "消耗与模型分析",
                                children: overviewContent,
                            },
                            {
                                key: "users",
                                label: "用户消耗统计",
                                children: userAnalyticsContent,
                            },
                        ]}
                    />
                ) : (
                    overviewContent
                )}
            </div>
        </Spin>
    );
}
