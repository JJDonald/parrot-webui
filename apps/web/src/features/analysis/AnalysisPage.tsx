import { useState } from 'react';
import { Pagination, Select, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { StatsBreakdownData, StatsDimension, StatsMetricData, StatsPeriod, StatsSort, StatsSummaryData } from '../../../../../packages/contracts/generated/upstream-mvp';
import { useApiQuery, usePollingInterval } from '@/api/hooks';
import { AsyncState } from '@/components/state';
import { MonoText } from '@/components/bits';
import { ModelStatsDrawer } from './ModelStatsDrawer';
import styles from './AnalysisPage.module.scss';

const periods: Array<{ value: StatsPeriod; label: string }> = [
  { value: 'today', label: '今日' },
  { value: '3d', label: '近 3 天' },
  { value: '7d', label: '近 7 天' },
  { value: 'month', label: '本月' },
  { value: 'lifetime', label: '全部历史' },
];
const dimensions: Array<{ value: StatsDimension; label: string }> = [
  { value: 'channel', label: '渠道' },
  { value: 'model', label: '模型' },
  { value: 'apiKey', label: '下游 API Key' },
];
const sorts: Array<{ value: StatsSort; label: string }> = [
  { value: 'total', label: '请求数' },
  { value: 'success', label: '成功数' },
  { value: 'tokens', label: 'Token' },
  { value: 'cost', label: '成本 ticks' },
  { value: 'latency', label: '响应时间' },
  { value: 'tps', label: 'Token / 秒' },
  { value: 'name', label: '名称' },
];
const pageSize = 20;

function number(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '未提供';
}
function rate(metrics: StatsMetricData): string {
  return typeof metrics.total === 'number' && metrics.total > 0 && typeof metrics.successCount === 'number'
    ? `${((metrics.successCount / metrics.total) * 100).toFixed(1)}%`
    : '未知';
}
function metricRows(metrics: StatsMetricData) {
  return [
    { label: '请求', value: number(metrics.total), note: `成功 ${number(metrics.successCount)} · 错误 ${number(metrics.errorCount)}` },
    { label: 'Token', value: typeof metrics.inputTokens === 'number' && typeof metrics.outputTokens === 'number' ? number(metrics.inputTokens + metrics.outputTokens) : '未提供', note: `输入 ${number(metrics.inputTokens)} · 输出 ${number(metrics.outputTokens)}` },
    { label: '成功率', value: rate(metrics), note: `重试请求 ${number(metrics.retriedRequests)}` },
    { label: '平均响应', value: typeof metrics.averageTotalMilliseconds === 'number' ? `${number(metrics.averageTotalMilliseconds)} ms` : '未提供', note: `平均首 Token ${typeof metrics.averageFirstTokenMilliseconds === 'number' ? `${number(metrics.averageFirstTokenMilliseconds)} ms` : '未提供'}` },
    { label: '缓存读取', value: number(metrics.cacheReadTokens), note: `缓存命中请求 ${number(metrics.cacheHitRequests)}` },
    { label: '计费 ticks', value: number(metrics.costTicks), note: `实际 ${number(metrics.actualCostTicks)} · 估算 ${number(metrics.estimatedCostTicks)}` },
  ];
}

const columns = (dimension: StatsDimension, onOpenModel: (id: string) => void): ColumnsType<StatsBreakdownData> => [
  { title: '分组', dataIndex: 'key', key: 'key', render: (value: string) => dimension === 'model' ? <button type="button" className={styles.modelLink} onClick={() => onOpenModel(value)}><MonoText truncate>{value}</MonoText></button> : <MonoText truncate>{value}</MonoText> },
  { title: '请求', key: 'total', align: 'right', render: (_, row) => number(row.metrics.total) },
  { title: '成功率', key: 'success', align: 'right', render: (_, row) => rate(row.metrics) },
  { title: '输入 Token', key: 'input', align: 'right', render: (_, row) => number(row.metrics.inputTokens) },
  { title: '输出 Token', key: 'output', align: 'right', render: (_, row) => number(row.metrics.outputTokens) },
  { title: '缓存读取', key: 'cache', align: 'right', render: (_, row) => number(row.metrics.cacheReadTokens) },
  { title: '平均响应', key: 'latency', align: 'right', render: (_, row) => typeof row.metrics.averageTotalMilliseconds === 'number' ? `${number(row.metrics.averageTotalMilliseconds)} ms` : '未提供' },
  { title: '成本 ticks', key: 'cost', align: 'right', render: (_, row) => number(row.metrics.costTicks) },
];

export function AnalysisPage() {
  const [period, setPeriod] = useState<StatsPeriod>('today');
  const [dimension, setDimension] = useState<StatsDimension>('model');
  const [sort, setSort] = useState<StatsSort>('total');
  const [page, setPage] = useState(1);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const interval = usePollingInterval(30_000);
  const summary = useApiQuery<StatsSummaryData>({
    key: ['stats', 'summary', { period }], path: '/stats/summary', query: { period }, refetchInterval: interval,
  });
  const breakdown = useApiQuery<StatsBreakdownData[]>({
    key: ['stats', 'breakdown', { period, dimension, sort, descending: true, page, pageSize }],
    path: '/stats/breakdown', query: { period, dimension, sort, descending: true, page, pageSize }, refetchInterval: interval,
  });
  const totalValue = breakdown.data?.meta?.total;
  const total = typeof totalValue === 'number' && Number.isFinite(totalValue) ? totalValue : null;
  const hasNextValue = breakdown.data?.meta?.hasNext;
  const rows = breakdown.data?.data;
  const families = Object.entries(summary.data?.data?.families ?? {});
  const displayRows = rows ?? undefined;
  const changeDimension = (value: StatsDimension) => { setDimension(value); setPage(1); };
  const changeSort = (value: StatsSort) => { setSort(value); setPage(1); };
  const changePeriod = (value: StatsPeriod) => { setPeriod(value); setPage(1); };

  return <div className={styles.page}>
    <section className={styles.intro}>
      <div>
        <span className={styles.eyebrow}>USAGE ANALYSIS</span>
        <h2>用量分析</h2>
        <p>查看 Parrot 已记录的请求、Token、延迟和计费数据。统计口径以当前上游返回值为准。</p>
      </div>
      <div className={styles.actions}>
        <label>统计周期 <Select aria-label="统计周期" value={period} options={periods} onChange={changePeriod} /></label>
        <button type="button" className="btn btn--secondary" disabled={summary.isFetching || breakdown.isFetching} onClick={() => void Promise.all([summary.refetch(), breakdown.refetch()])}>刷新</button>
      </div>
    </section>

    <AsyncState<StatsSummaryData> isLoading={summary.isLoading} error={summary.error} data={summary.data?.data ?? undefined} onRetry={() => void summary.refetch()} isStale={summary.isError && Boolean(summary.data)}>
      {(data) => <>
        <section className={styles.metrics} aria-label="总体指标">
          {metricRows(data.overall).map((item) => <article className={styles.metric} key={item.label}>
            <span>{item.label}</span><strong>{item.value}</strong><small>{item.note}</small>
          </article>)}
        </section>
        {families.length > 0 && <section className={`keeper-card ${styles.families}`}>
          <div className="keeper-card__header"><div className="keeper-card__heading"><h3 className="keeper-card__title">模型族概况</h3><p className="keeper-card__subtitle">各模型族直接使用上游统计值；可能共享同一请求，不跨族相加。</p></div></div>
          <div className={styles.familyGrid}>
            {families.map(([name, metrics]) => <div className={styles.family} key={name}>
              <MonoText truncate>{name}</MonoText><strong>{number(metrics.total)}</strong>
              <span>请求 · 成功率 {rate(metrics)} · Token {typeof metrics.inputTokens === 'number' && typeof metrics.outputTokens === 'number' ? number(metrics.inputTokens + metrics.outputTokens) : '未提供'}</span>
            </div>)}
          </div>
        </section>}
      </>}
    </AsyncState>

    <section className="keeper-card keeper-card--flush">
      <div className="keeper-card__header">
        <div className="keeper-card__heading"><h3 className="keeper-card__title">分组明细</h3><p className="keeper-card__subtitle">支持按渠道、模型或 API Key 查看上游分组指标；计费仅显示原始 ticks。</p></div>
        <div className={styles.actions}>
          <label>维度 <Select aria-label="分析维度" value={dimension} options={dimensions} onChange={changeDimension} /></label>
          <label>排序 <Select aria-label="分组排序" value={sort} options={sorts} onChange={changeSort} /></label>
        </div>
      </div>
      <div className="keeper-card__body">
        <AsyncState<StatsBreakdownData[]> isLoading={breakdown.isLoading} error={breakdown.error} data={displayRows} isEmpty={(data) => data.length === 0} emptyTitle="当前周期没有分组统计" onRetry={() => void breakdown.refetch()} isStale={breakdown.isError && Boolean(displayRows)}>
          {(data) => <Table<StatsBreakdownData> rowKey="key" columns={columns(dimension, setSelectedModel)} dataSource={data} pagination={false} scroll={{ x: 'max-content' }} size="middle" />}
        </AsyncState>
        {page > 1 && displayRows?.length === 0 && <button type="button" className="btn btn--secondary btn--sm" onClick={() => setPage((value) => value - 1)}>返回上一页</button>}
        {rows && rows.length > 0 && <div className={styles.pagination}>
          <span>第 {page} 页 · {total === null ? '总数未知' : `共 ${number(total)} 个分组`}</span>
          {total === null ? <div className={styles.actions}>
            <button className="btn btn--secondary btn--sm" type="button" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>上一页</button>
            <button className="btn btn--secondary btn--sm" type="button" disabled={hasNextValue === false || (hasNextValue !== true && rows.length < pageSize)} onClick={() => setPage((current) => current + 1)}>下一页</button>
          </div> : <Pagination current={page} pageSize={pageSize} total={total} showSizeChanger={false} onChange={setPage} />}
        </div>}
      </div>
    </section>
    <ModelStatsDrawer modelId={selectedModel} period={period} onClose={() => setSelectedModel(null)} />
  </div>;
}
