/**
 * 总览页（实施文档 6.3）。
 *
 * 数据来源只有冻结的代理路径：
 * /overview、/runtime/status、/runtime/concurrency、/runtime/cooldowns、
 * /runtime/background-jobs、/stats/summary、/stats/breakdown、/stats/recent-calls。
 *
 * 口径边界（实施文档 6.3）：
 * - 只展示上游真实存在的字段；不推算余额、成本、TPS 或"全部历史累计"。
 * - 上游没有时间序列接口，因此本页不绘制趋势线或图表。
 * - 同一上游路由可能被多个别名共享累计值，本页不对任何分组求和，也不把 per-family 明细合计成总数。
 * - 每 15 秒刷新当前可见内容（usePollingInterval，后台标签页自动降频）；刷新失败保留上次成功快照，
 *   由 AsyncState 的 isStale 标注"数据可能已过期"。
 *
 * 类型来自生成契约 packages/contracts/generated/upstream-mvp.d.ts：
 * packages/contracts 的 exports 里 "./upstream" 目前指向不存在的 generated/upstream.d.ts，
 * 因此这里用相对路径直接引用生成文件（不改动共享包）。
 */

import { useCallback, useState } from 'react';
import type {
  BackgroundJobData,
  ChannelStatusData,
  ConcurrencyData,
  CooldownData,
  OverviewData,
  QuotaWarningData,
  RecentCallData,
  RuntimeStatusData,
  StatsBreakdownData,
  StatsDimension,
  StatsMetricData,
  StatsPeriod,
  StatsSummaryData,
} from '../../../../../packages/contracts/generated/upstream-mvp';
import type { ApiError } from '@/api/client';
import { useApiQuery, usePollingInterval } from '@/api/hooks';
import { useWriteCapability } from '@/app/AuthProvider';
import { KeyValueList, MonoText, Pill, RelativeTime, StatCard, TimeText, type Tone } from '@/components/bits';
import { ErrorNotice } from '@/components/feedback';
import { AsyncState } from '@/components/state';
import styles from './OverviewPage.module.scss';

/** 总览固定 15 秒刷新；页面不可见时 usePollingInterval 自动降频。 */
const POLL_MS = 15_000;
/** 分页列表只取第一页，并明确展示上游 meta.total 的完整总数。 */
const LIST_PAGE_SIZE = 20;
const BREAKDOWN_PAGE_SIZE = 10;

const PERIOD_OPTIONS: Array<{ value: StatsPeriod; label: string }> = [
  { value: 'today', label: '今日' },
  { value: '3d', label: '近 3 天' },
  { value: '7d', label: '近 7 天' },
  { value: 'month', label: '本月' },
  { value: 'lifetime', label: '全部历史（上游 lifetime 口径）' },
];

const DIMENSION_OPTIONS: Array<{ value: StatsDimension; label: string }> = [
  { value: 'channel', label: '按渠道' },
  { value: 'model', label: '按模型' },
  { value: 'apiKey', label: '按下游 API Key' },
];

const HEALTH_LABEL: Record<ChannelStatusData['health'], string> = {
  disabled: '已禁用',
  permanentCooldown: '永久冷却',
  quotaCooldown: '配额冷却',
  cooldown: '冷却中',
  healthy: '健康',
  degraded: '降级',
  unhealthy: '异常',
  unknown: '未知',
};

const JOB_STATUS_LABEL: Record<BackgroundJobData['status'], string> = {
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  unknown: '未知',
  disabled: '已禁用',
};

const COOLDOWN_STATE_LABEL: Record<CooldownData['state'], string> = {
  active: '临时冷却',
  permanent: '永久冷却',
};

/** 数字字段缺失时显示"未提供"，绝不显示 0 冒充统计值。 */
function formatCount(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未提供';
  return value.toLocaleString('zh-CN');
}

/** 成功率：直接相除两个上游字段；分母缺失或为 0 时显示未知，不显示 0%。 */
function formatRate(numerator: number | null | undefined, denominator: number | null | undefined): string {
  if (typeof numerator !== 'number' || typeof denominator !== 'number' || denominator <= 0) return '未知';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function formatSeconds(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '未知';
  const days = Math.floor(value / 86_400);
  const hours = Math.floor((value % 86_400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days} 天`);
  if (hours) parts.push(`${hours} 小时`);
  if (minutes || !parts.length) parts.push(`${minutes} 分钟`);
  return parts.join(' ');
}

function formatMilliseconds(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未提供';
  return `${value.toLocaleString('zh-CN')} ms`;
}

/** 上游 meta 只保证是对象；total/page 等字段需要按真实类型读取。 */
function metaNumber(meta: Record<string, unknown> | undefined, key: string): number | null {
  const value = meta?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function healthTone(health: ChannelStatusData['health']): Tone {
  switch (health) {
    case 'healthy':
      return 'success';
    case 'degraded':
      return 'warning';
    case 'unhealthy':
    case 'permanentCooldown':
    case 'quotaCooldown':
    case 'cooldown':
      return 'danger';
    case 'disabled':
    case 'unknown':
      return 'muted';
    default:
      return 'default';
  }
}

function jobTone(status: BackgroundJobData['status']): Tone {
  switch (status) {
    case 'succeeded':
      return 'success';
    case 'running':
      return 'primary';
    case 'failed':
      return 'danger';
    default:
      return 'muted';
  }
}

function metricCells(metrics: StatsMetricData | undefined) {
  return {
    total: formatCount(metrics?.total),
    success: formatCount(metrics?.successCount),
    error: formatCount(metrics?.errorCount),
    inputTokens: formatCount(metrics?.inputTokens),
    outputTokens: formatCount(metrics?.outputTokens),
    tps: typeof metrics?.averageTokensPerSecond === 'number' ? metrics.averageTokensPerSecond.toFixed(2) : '未提供',
    averageTotal: formatMilliseconds(metrics?.averageTotalMilliseconds),
  };
}

export function OverviewPage() {
  const interval = usePollingInterval(POLL_MS);
  const [period, setPeriod] = useState<StatsPeriod>('today');
  const [dimension, setDimension] = useState<StatsDimension>('channel');
  const { canWrite, reason: writeReason } = useWriteCapability();

  const overview = useApiQuery<OverviewData>({
    key: ['overview'],
    path: '/overview',
    refetchInterval: interval,
  });
  const runtimeStatus = useApiQuery<RuntimeStatusData>({
    key: ['runtime', 'status'],
    path: '/runtime/status',
    refetchInterval: interval,
  });
  const concurrency = useApiQuery<ConcurrencyData>({
    key: ['runtime', 'concurrency'],
    path: '/runtime/concurrency',
    refetchInterval: interval,
  });
  const cooldowns = useApiQuery<CooldownData[]>({
    key: ['runtime', 'cooldowns', { page: 1, pageSize: LIST_PAGE_SIZE }],
    path: '/runtime/cooldowns',
    query: { page: 1, pageSize: LIST_PAGE_SIZE },
    refetchInterval: interval,
  });
  const backgroundJobs = useApiQuery<BackgroundJobData[]>({
    key: ['runtime', 'background-jobs', { page: 1, pageSize: LIST_PAGE_SIZE }],
    path: '/runtime/background-jobs',
    query: { page: 1, pageSize: LIST_PAGE_SIZE },
    refetchInterval: interval,
  });
  const statsSummary = useApiQuery<StatsSummaryData>({
    key: ['stats', 'summary', { period }],
    path: '/stats/summary',
    query: { period },
    refetchInterval: interval,
  });
  const breakdown = useApiQuery<StatsBreakdownData[]>({
    key: ['stats', 'breakdown', { dimension, period, sort: 'total', descending: true, page: 1, pageSize: BREAKDOWN_PAGE_SIZE }],
    path: '/stats/breakdown',
    query: { dimension, period, sort: 'total', descending: true, page: 1, pageSize: BREAKDOWN_PAGE_SIZE },
    refetchInterval: interval,
  });
  const recentCalls = useApiQuery<RecentCallData[]>({
    key: ['stats', 'recent-calls', { page: 1, pageSize: LIST_PAGE_SIZE }],
    path: '/stats/recent-calls',
    query: { page: 1, pageSize: LIST_PAGE_SIZE },
    refetchInterval: interval,
  });

  const results = [
    overview,
    runtimeStatus,
    concurrency,
    cooldowns,
    backgroundJobs,
    statsSummary,
    breakdown,
    recentCalls,
  ];

  const refreshAll = useCallback(() => {
    void Promise.all([
      overview.refetch(),
      runtimeStatus.refetch(),
      concurrency.refetch(),
      cooldowns.refetch(),
      backgroundJobs.refetch(),
      statsSummary.refetch(),
      breakdown.refetch(),
      recentCalls.refetch(),
    ]);
  }, [overview, runtimeStatus, concurrency, cooldowns, backgroundJobs, statsSummary, breakdown, recentCalls]);

  const timestamps = results.map((result) => result.dataUpdatedAt).filter((value) => value > 0);
  const lastSuccessAt = timestamps.length ? new Date(Math.max(...timestamps)) : null;
  const lastSuccessIso = lastSuccessAt ? lastSuccessAt.toISOString() : null;
  const anyFetching = results.some((result) => result.isFetching);
  const staleSections = results.filter((result) => result.isError && Boolean(result.data)).length;
  const anyData = results.some((result) => Boolean(result.data));
  const firstError: ApiError | null = results.map((result) => result.error).find((error): error is ApiError => Boolean(error)) ?? null;
  const fatalError = anyData ? null : firstError;

  const jobsTotal = metaNumber(backgroundJobs.data?.meta, 'total');
  const cooldownsTotal = metaNumber(cooldowns.data?.meta, 'total');
  const callsTotal = metaNumber(recentCalls.data?.meta, 'total');
  const breakdownTotal = metaNumber(breakdown.data?.meta, 'total');

  return (
    <div className={styles.page}>
      <section className="keeper-card">
        <div className="keeper-card__header">
          <div className="keeper-card__heading">
            <span className="app-topbar__eyebrow">Overview</span>
            <h2 className="keeper-card__title">运行总览</h2>
            <p className="keeper-card__subtitle">
              每 15 秒刷新，标签页进入后台后自动降频。全部数值都来自上游返回的字段，本页不求和、不推算
              余额/成本/TPS，也不绘制趋势线。
            </p>
          </div>
          <div className={styles.headActions}>
            <button type="button" className="btn btn--sm btn--secondary" onClick={refreshAll} disabled={anyFetching}>
              {anyFetching ? '刷新中…' : '立即刷新'}
            </button>
          </div>
        </div>
        <div className="keeper-card__body">
          <div className={styles.sectionBody}>
            <div className={styles.refreshRow}>
              <strong>最近成功刷新时间：</strong>
              {lastSuccessIso ? (
                <>
                  <RelativeTime value={lastSuccessIso} />
                  <TimeText value={lastSuccessIso} withSeconds />
                </>
              ) : (
                <span className="text-tertiary">尚未成功刷新</span>
              )}
            </div>
            {staleSections ? (
              <div className="notice-box notice-box--warning" role="status">
                有 {staleSections} 个数据区块本次刷新失败，下面显示的是上一次成功快照，数据可能已过期。
              </div>
            ) : null}
            {!canWrite ? (
              <div className="notice-box" role="status">
                当前会话按上游能力判定为只读（{writeReason ?? '未说明'}）：本页只读取运行数据，不提供任何写入动作。
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {fatalError ? (
        <section className="keeper-card">
          <div className="keeper-card__body">
            <ErrorNotice error={fatalError} onRetry={refreshAll} />
          </div>
        </section>
      ) : (
        <>
          <section className="keeper-card">
            <div className="keeper-card__header">
              <div className="keeper-card__heading">
                <h3 className="keeper-card__title">渠道与账号概况</h3>
                <p className="keeper-card__subtitle">来源：GET /overview（counts、version、uptimeSeconds、listeners）</p>
              </div>
            </div>
            <div className="keeper-card__body">
              <AsyncState<OverviewData>
                isLoading={overview.isLoading}
                error={overview.error}
                data={overview.data?.data ?? undefined}
                onRetry={() => void overview.refetch()}
                isStale={overview.isError && Boolean(overview.data)}
                loadingLabel="正在读取 /overview…"
              >
                {(data) => (
                  <div className={styles.sectionBody}>
                    <div className="stat-grid">
                      <StatCard label="渠道数" value={formatCount(data.counts?.channels)} hint="上游字段 counts.channels" />
                      <StatCard
                        label="OAuth 账号数"
                        value={formatCount(data.counts?.oauthAccounts)}
                        hint="上游字段 counts.oauthAccounts"
                      />
                      <StatCard
                        label="下游 API Key 数"
                        value={formatCount(data.counts?.apiKeys)}
                        hint="上游字段 counts.apiKeys"
                      />
                      <StatCard
                        label="配额热点"
                        value={formatCount(data.counts?.quotaHot)}
                        tone={typeof data.counts?.quotaHot === 'number' && data.counts.quotaHot > 0 ? 'warning' : undefined}
                        hint="上游字段 counts.quotaHot（口径由上游定义）"
                      />
                      <StatCard label="实例版本" value={data.version || '未知'} hint="上游字段 version" />
                      <StatCard label="运行时长" value={formatSeconds(data.uptimeSeconds)} hint="上游字段 uptimeSeconds" />
                      <StatCard
                        label="监听地址"
                        value={data.listeners ? `${data.listeners.host}:${data.listeners.port}` : '未知'}
                        hint="上游字段 listeners"
                      />
                    </div>
                    <p className={styles.note}>
                      说明：/overview 还包含 today / lifetime / activeAlerts 等无固定 schema 的字段（Record&lt;string,
                      JsonValue&gt;），语义与聚合口径由上游定义，本页不做推算与求和。
                    </p>
                  </div>
                )}
              </AsyncState>
            </div>
          </section>

          <section className="keeper-card">
            <div className="keeper-card__header">
              <div className="keeper-card__heading">
                <h3 className="keeper-card__title">运行时状态与问题渠道</h3>
                <p className="keeper-card__subtitle">
                  来源：GET /runtime/status（problemChannels、cooldownSummary、quotaWarnings）
                </p>
              </div>
            </div>
            <div className="keeper-card__body">
              <AsyncState<RuntimeStatusData>
                isLoading={runtimeStatus.isLoading}
                error={runtimeStatus.error}
                data={runtimeStatus.data?.data ?? undefined}
                onRetry={() => void runtimeStatus.refetch()}
                isStale={runtimeStatus.isError && Boolean(runtimeStatus.data)}
                loadingLabel="正在读取 /runtime/status…"
              >
                {(data) => (
                  <div className={styles.sectionBody}>
                    <div className="stat-grid">
                      <StatCard
                        label="渠道总数"
                        value={formatCount(data.channels?.length)}
                        hint="上游 channels 数组条目数（完整列表，不是分页）"
                      />
                      <StatCard
                        label="问题渠道"
                        value={formatCount(data.problemChannels?.length)}
                        tone={data.problemChannels?.length ? 'warning' : undefined}
                        hint="上游 problemChannels 数组条目数（完整列表，不是分页）"
                      />
                      <StatCard
                        label="配额预警账号"
                        value={formatCount(data.quotaWarnings?.length)}
                        hint="上游 quotaWarnings 数组条目数"
                      />
                    </div>

                    <div>
                      <div className="field__label">cooldownSummary（上游原样分布，不做求和）</div>
                      {Object.keys(data.cooldownSummary ?? {}).length ? (
                        <KeyValueList
                          items={Object.entries(data.cooldownSummary).map(([label, value]) => ({
                            label,
                            value: formatCount(value),
                          }))}
                        />
                      ) : (
                        <span className="text-tertiary">上游未返回冷却分布</span>
                      )}
                    </div>

                    {data.problemChannels?.length ? (
                      <div className={styles.scroll}>
                        <div className={`keeper-table ${styles.table}`}>
                          <div className={`keeper-table__header ${styles.colsChannels}`}>
                            <span>渠道</span>
                            <span>健康状态</span>
                            <span>冷却数</span>
                            <span>近期成功率</span>
                            <span>问题原因</span>
                          </div>
                          {data.problemChannels.map((channel) => (
                            <div
                              key={channel.id}
                              className={`keeper-table__row ${styles.colsChannels}`}
                              style={{ cursor: 'default' }}
                            >
                              <span className="cell">
                                <span>{channel.name}</span>
                                <MonoText truncate>{channel.id}</MonoText>
                              </span>
                              <span className="cell">
                                <Pill tone={healthTone(channel.health)}>{HEALTH_LABEL[channel.health] ?? channel.health}</Pill>
                              </span>
                              <span className="cell">{formatCount(channel.cooldownCount)}</span>
                              <span className="cell">
                                {typeof channel.recentSuccessRate === 'number'
                                  ? `${channel.recentSuccessRate.toFixed(1)}%`
                                  : '未提供'}
                              </span>
                              <span className="cell">
                                {channel.problemReasons?.length ? channel.problemReasons.join('；') : '上游未给出原因'}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <p className={styles.note}>上游没有把任何渠道标记为问题渠道。</p>
                    )}

                    {data.quotaWarnings?.length ? (
                      <div className={styles.scroll}>
                        <div className={`keeper-table ${styles.table}`}>
                          <div className={`keeper-table__header ${styles.colsQuota}`}>
                            <span>账号</span>
                            <span>供应商</span>
                            <span>配额窗口</span>
                            <span>使用率</span>
                          </div>
                          {data.quotaWarnings.flatMap((warning: QuotaWarningData) =>
                            (warning.metrics ?? []).map((metric) => (
                              <div
                                key={`${warning.accountId}-${metric.window}`}
                                className={`keeper-table__row ${styles.colsQuota}`}
                                style={{ cursor: 'default' }}
                              >
                                <span className="cell">
                                  <MonoText truncate>{warning.accountId}</MonoText>
                                </span>
                                <span className="cell">{warning.provider}</span>
                                <span className="cell">{metric.window}</span>
                                <span className="cell">{`${metric.utilizationPercent.toFixed(1)}%`}</span>
                              </div>
                            )),
                          )}
                        </div>
                      </div>
                    ) : (
                      <p className={styles.note}>上游没有返回配额预警。</p>
                    )}
                  </div>
                )}
              </AsyncState>
            </div>
          </section>

          <section className="keeper-card">
            <div className="keeper-card__header">
              <div className="keeper-card__heading">
                <h3 className="keeper-card__title">并发占用</h3>
                <p className="keeper-card__subtitle">
                  来源：GET /runtime/concurrency（channelTotals / apiKeyTotals / channels）
                </p>
              </div>
            </div>
            <div className="keeper-card__body">
              <AsyncState<ConcurrencyData>
                isLoading={concurrency.isLoading}
                error={concurrency.error}
                data={concurrency.data?.data ?? undefined}
                onRetry={() => void concurrency.refetch()}
                isStale={concurrency.isError && Boolean(concurrency.data)}
                loadingLabel="正在读取 /runtime/concurrency…"
              >
                {(data) => (
                  <div className={styles.sectionBody}>
                    <div className="stat-grid">
                      <StatCard
                        label="渠道在飞请求"
                        value={formatCount(data.channelTotals?.inFlight)}
                        hint="channelTotals.inFlight"
                      />
                      <StatCard label="渠道排队等待" value={formatCount(data.channelTotals?.waiting)} hint="channelTotals.waiting" />
                      <StatCard
                        label="纳入统计渠道"
                        value={formatCount(data.channelTotals?.trackedChannels)}
                        hint="channelTotals.trackedChannels"
                      />
                      <StatCard label="Key 在飞请求" value={formatCount(data.apiKeyTotals?.inFlight)} hint="apiKeyTotals.inFlight" />
                      <StatCard label="Key 排队等待" value={formatCount(data.apiKeyTotals?.waiting)} hint="apiKeyTotals.waiting" />
                      <StatCard
                        label="纳入统计 Key"
                        value={formatCount(data.apiKeyTotals?.trackedKeys)}
                        hint="apiKeyTotals.trackedKeys"
                      />
                    </div>
                    {data.channels?.length ? (
                      <div className={styles.scroll}>
                        <div className={`keeper-table ${styles.table}`}>
                          <div className={`keeper-table__header ${styles.colsChannels}`}>
                            <span>渠道 Key</span>
                            <span>在飞</span>
                            <span>上限</span>
                            <span>等待</span>
                            <span>说明</span>
                          </div>
                          {data.channels.map((row) => (
                            <div
                              key={row.channelKey}
                              className={`keeper-table__row ${styles.colsChannels}`}
                              style={{ cursor: 'default' }}
                            >
                              <span className="cell">
                                <MonoText truncate>{row.channelKey}</MonoText>
                              </span>
                              <span className="cell">{formatCount(row.inFlight)}</span>
                              <span className="cell">{formatCount(row.maxConcurrent)}</span>
                              <span className="cell">{formatCount(row.waiting)}</span>
                              <span className="cell">{row.unlimited ? '无限制（上游 unlimited）' : '受上游上限约束'}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <p className={styles.note}>上游没有返回渠道级并发明细。</p>
                    )}
                  </div>
                )}
              </AsyncState>
            </div>
          </section>

          <section className="keeper-card">
            <div className="keeper-card__header">
              <div className="keeper-card__heading">
                <h3 className="keeper-card__title">冷却明细</h3>
                <p className="keeper-card__subtitle">来源：GET /runtime/cooldowns（第一页，共 meta.total 条）</p>
              </div>
            </div>
            <div className="keeper-card__body">
              <AsyncState<CooldownData[]>
                isLoading={cooldowns.isLoading}
                error={cooldowns.error}
                data={cooldowns.data?.data ?? undefined}
                onRetry={() => void cooldowns.refetch()}
                isStale={cooldowns.isError && Boolean(cooldowns.data)}
                emptyTitle="当前没有冷却记录"
                emptyDescription="上游 /runtime/cooldowns 返回 0 条；这不代表渠道健康度，只是当前没有冷却中的模型。"
                loadingLabel="正在读取 /runtime/cooldowns…"
              >
                {(rows) => (
                  <div className={styles.sectionBody}>
                    <p className={styles.note}>
                      上游总数 {formatCount(cooldownsTotal)} 条，本页显示第 1 页的 {formatCount(rows.length)} 条。
                    </p>
                    <div className={styles.scroll}>
                      <div className={`keeper-table ${styles.table}`}>
                        <div className={`keeper-table__header ${styles.colsCooldowns}`}>
                          <span>渠道</span>
                          <span>模型</span>
                          <span>状态</span>
                          <span>错误数</span>
                          <span>解除时间</span>
                          <span>上游消息</span>
                        </div>
                        {rows.map((row) => (
                          <div
                            key={`${row.channelId}-${row.model}-${row.state}`}
                            className={`keeper-table__row ${styles.colsCooldowns}`}
                            style={{ cursor: 'default' }}
                          >
                            <span className="cell">
                              <MonoText truncate>{row.channelId}</MonoText>
                            </span>
                            <span className="cell">{row.model}</span>
                            <span className="cell">
                              <Pill tone={row.state === 'permanent' ? 'danger' : 'warning'}>
                                {COOLDOWN_STATE_LABEL[row.state] ?? row.state}
                              </Pill>
                            </span>
                            <span className="cell">{formatCount(row.errorCount)}</span>
                            <span className="cell">
                              <TimeText value={row.until} withSeconds />
                            </span>
                            <span className="cell">{row.message ?? '上游未提供'}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </AsyncState>
            </div>
          </section>

          <section className="keeper-card">
            <div className="keeper-card__header">
              <div className="keeper-card__heading">
                <h3 className="keeper-card__title">后台任务</h3>
                <p className="keeper-card__subtitle">来源：GET /runtime/background-jobs（上游后台任务状态，不是管理操作任务）</p>
              </div>
            </div>
            <div className="keeper-card__body">
              <AsyncState<BackgroundJobData[]>
                isLoading={backgroundJobs.isLoading}
                error={backgroundJobs.error}
                data={backgroundJobs.data?.data ?? undefined}
                onRetry={() => void backgroundJobs.refetch()}
                isStale={backgroundJobs.isError && Boolean(backgroundJobs.data)}
                emptyTitle="上游没有返回后台任务"
                emptyDescription="/runtime/background-jobs 返回 0 条。管理操作的异步任务请到“管理任务”页查看。"
                loadingLabel="正在读取 /runtime/background-jobs…"
              >
                {(rows) => (
                  <div className={styles.sectionBody}>
                    <p className={styles.note}>
                      上游总数 {formatCount(jobsTotal)} 条，本页显示第 1 页的 {formatCount(rows.length)} 条。
                    </p>
                    <div className={styles.scroll}>
                      <div className={`keeper-table ${styles.table}`}>
                        <div className={`keeper-table__header ${styles.colsJobs}`}>
                          <span>任务</span>
                          <span>状态</span>
                          <span>周期</span>
                          <span>最近一次</span>
                          <span>下次计划</span>
                          <span>错误</span>
                        </div>
                        {rows.map((job) => (
                          <div key={job.id} className={`keeper-table__row ${styles.colsJobs}`} style={{ cursor: 'default' }}>
                            <span className="cell">
                              <MonoText truncate>{job.id}</MonoText>
                            </span>
                            <span className="cell">
                              <Pill tone={jobTone(job.status)}>{JOB_STATUS_LABEL[job.status] ?? job.status}</Pill>
                            </span>
                            <span className="cell">
                              {typeof job.intervalSeconds === 'number' ? `${formatCount(job.intervalSeconds)} 秒` : '未提供'}
                            </span>
                            <span className="cell">
                              <RelativeTime value={job.lastRunAt} />
                            </span>
                            <span className="cell">
                              <RelativeTime value={job.nextRunAt} />
                            </span>
                            <span className="cell">{job.error ?? '无'}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </AsyncState>
            </div>
          </section>

          <section className="keeper-card">
            <div className="keeper-card__header">
              <div className="keeper-card__heading">
                <h3 className="keeper-card__title">请求量与成功率</h3>
                <p className="keeper-card__subtitle">
                  来源：GET /stats/summary（overall / families，按上游 period 口径）
                </p>
              </div>
              <div className={styles.controls}>
                <label className="field">
                  <span className="field__label">时间窗口（上游 period）</span>
                  <select
                    className="input"
                    value={period}
                    onChange={(event) => setPeriod(event.target.value as StatsPeriod)}
                    aria-label="统计时间窗口"
                  >
                    {PERIOD_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
            <div className="keeper-card__body">
              <AsyncState<StatsSummaryData>
                isLoading={statsSummary.isLoading}
                error={statsSummary.error}
                data={statsSummary.data?.data ?? undefined}
                isEmpty={(data) => Object.keys(data.overall ?? {}).length === 0}
                emptyTitle="上游没有返回该时间窗口的统计"
                emptyDescription="这表示所选 period 内没有可展示的上游统计字段，不是“0 请求”。"
                onRetry={() => void statsSummary.refetch()}
                isStale={statsSummary.isError && Boolean(statsSummary.data)}
                loadingLabel="正在读取 /stats/summary…"
              >
                {(data) => {
                  const metrics = metricCells(data.overall);
                  const families = Object.entries(data.families ?? {});
                  return (
                    <div className={styles.sectionBody}>
                      <div className="stat-grid">
                        <StatCard label="请求总量" value={metrics.total} hint="overall.total" />
                        <StatCard label="成功请求" value={metrics.success} hint="overall.successCount" />
                        <StatCard label="失败请求" value={metrics.error} tone="danger" hint="overall.errorCount" />
                        <StatCard
                          label="成功率"
                          value={formatRate(data.overall?.successCount, data.overall?.total)}
                          hint="由上游 successCount ÷ total 计算；分母缺失时为未知"
                        />
                        <StatCard label="进行中" value={formatCount(data.overall?.pendingCount)} hint="overall.pendingCount" />
                        <StatCard label="输入 Token" value={formatCount(data.overall?.inputTokens)} hint="overall.inputTokens" />
                        <StatCard label="输出 Token" value={formatCount(data.overall?.outputTokens)} hint="overall.outputTokens" />
                        <StatCard
                          label="平均 TPS"
                          value={metrics.tps}
                          hint="上游字段 overall.averageTokensPerSecond，不是本页计算"
                        />
                        <StatCard
                          label="平均总耗时"
                          value={metrics.averageTotal}
                          hint="上游字段 overall.averageTotalMilliseconds"
                        />
                      </div>
                      <div className="notice-box">
                        口径说明：以上数值全部取自上游 period={period} 的统计字段。同一上游路由可能被多个下游别名共享，累计值
                        只属于该路由；本页不对 families 求和，也不把它当作全历史累计。上游没有时间序列接口，因此这里没有趋势线。
                      </div>
                      {families.length ? (
                        <div className={styles.scroll}>
                          <div className={`keeper-table ${styles.table}`}>
                            <div className={`keeper-table__header ${styles.colsMetrics}`}>
                              <span>family（上游分组）</span>
                              <span>请求</span>
                              <span>成功</span>
                              <span>失败</span>
                              <span>输入 Token</span>
                              <span>输出 Token</span>
                              <span>平均 TPS</span>
                              <span>平均耗时</span>
                            </div>
                            {families.map(([family, familyMetrics]) => {
                              const cells = metricCells(familyMetrics);
                              return (
                                <div
                                  key={family}
                                  className={`keeper-table__row ${styles.colsMetrics}`}
                                  style={{ cursor: 'default' }}
                                >
                                  <span className="cell">
                                    <MonoText truncate>{family}</MonoText>
                                  </span>
                                  <span className="cell">{cells.total}</span>
                                  <span className="cell">{cells.success}</span>
                                  <span className="cell">{cells.error}</span>
                                  <span className="cell">{cells.inputTokens}</span>
                                  <span className="cell">{cells.outputTokens}</span>
                                  <span className="cell">{cells.tps}</span>
                                  <span className="cell">{cells.averageTotal}</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : (
                        <p className={styles.note}>上游未返回 family 级明细。</p>
                      )}
                    </div>
                  );
                }}
              </AsyncState>
            </div>
          </section>

          <section className="keeper-card">
            <div className="keeper-card__header">
              <div className="keeper-card__heading">
                <h3 className="keeper-card__title">分组明细</h3>
                <p className="keeper-card__subtitle">
                  来源：GET /stats/breakdown（dimension、period、sort=total、descending=true）
                </p>
              </div>
              <div className={styles.controls}>
                <label className="field">
                  <span className="field__label">分组维度（上游 dimension）</span>
                  <select
                    className="input"
                    value={dimension}
                    onChange={(event) => setDimension(event.target.value as StatsDimension)}
                    aria-label="统计分组维度"
                  >
                    {DIMENSION_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
            <div className="keeper-card__body">
              <AsyncState<StatsBreakdownData[]>
                isLoading={breakdown.isLoading}
                error={breakdown.error}
                data={breakdown.data?.data ?? undefined}
                onRetry={() => void breakdown.refetch()}
                isStale={breakdown.isError && Boolean(breakdown.data)}
                emptyTitle="该窗口没有分组统计"
                emptyDescription="上游按所选维度与时间窗口返回 0 条分组数据，不是“0 请求”。"
                loadingLabel="正在读取 /stats/breakdown…"
              >
                {(rows) => (
                  <div className={styles.sectionBody}>
                    <p className={styles.note}>
                      上游总数 {formatCount(breakdownTotal)} 条，本页显示第 1 页的 {formatCount(rows.length)} 条。每行只展示该分组自身的
                      上游字段，不做跨分组求和。
                    </p>
                    <div className={styles.scroll}>
                      <div className={`keeper-table ${styles.table}`}>
                        <div className={`keeper-table__header ${styles.colsMetrics}`}>
                          <span>分组（上游 key）</span>
                          <span>请求</span>
                          <span>成功</span>
                          <span>失败</span>
                          <span>输入 Token</span>
                          <span>输出 Token</span>
                          <span>平均 TPS</span>
                          <span>平均耗时</span>
                        </div>
                        {rows.map((row) => {
                          const cells = metricCells(row.metrics);
                          return (
                            <div key={row.key} className={`keeper-table__row ${styles.colsMetrics}`} style={{ cursor: 'default' }}>
                              <span className="cell">
                                <MonoText truncate>{row.key}</MonoText>
                              </span>
                              <span className="cell">{cells.total}</span>
                              <span className="cell">{cells.success}</span>
                              <span className="cell">{cells.error}</span>
                              <span className="cell">{cells.inputTokens}</span>
                              <span className="cell">{cells.outputTokens}</span>
                              <span className="cell">{cells.tps}</span>
                              <span className="cell">{cells.averageTotal}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </AsyncState>
            </div>
          </section>

          <section className="keeper-card">
            <div className="keeper-card__header">
              <div className="keeper-card__heading">
                <h3 className="keeper-card__title">最近请求</h3>
                <p className="keeper-card__subtitle">来源：GET /stats/recent-calls（第一页）</p>
              </div>
            </div>
            <div className="keeper-card__body">
              <AsyncState<RecentCallData[]>
                isLoading={recentCalls.isLoading}
                error={recentCalls.error}
                data={recentCalls.data?.data ?? undefined}
                onRetry={() => void recentCalls.refetch()}
                isStale={recentCalls.isError && Boolean(recentCalls.data)}
                emptyTitle="上游没有返回最近请求"
                emptyDescription="/stats/recent-calls 返回 0 条；需要完整请求明细请到“请求日志”页。"
                loadingLabel="正在读取 /stats/recent-calls…"
              >
                {(rows) => (
                  <div className={styles.sectionBody}>
                    <p className={styles.note}>
                      上游总数 {formatCount(callsTotal)} 条，本页显示第 1 页的 {formatCount(rows.length)} 条。
                    </p>
                    <div className={styles.scroll}>
                      <div className={`keeper-table ${styles.table}`}>
                        <div className={`keeper-table__header ${styles.colsCalls}`}>
                          <span>时间</span>
                          <span>模型</span>
                          <span>渠道</span>
                          <span>状态</span>
                          <span>耗时</span>
                        </div>
                        {rows.map((call) => (
                          <div key={call.id} className={`keeper-table__row ${styles.colsCalls}`} style={{ cursor: 'default' }}>
                            <span className="cell">
                              <RelativeTime value={call.createdAt} />
                            </span>
                            <span className="cell">{call.model ?? '未提供'}</span>
                            <span className="cell">
                              <MonoText truncate>{call.channelId ?? '未提供'}</MonoText>
                            </span>
                            <span className="cell">
                              <Pill tone={call.status === 'success' ? 'success' : 'muted'} mono>
                                {call.status || '未提供'}
                              </Pill>
                            </span>
                            <span className="cell">{formatMilliseconds(call.durationMilliseconds)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </AsyncState>
            </div>
          </section>

          <section className="keeper-card">
            <div className="keeper-card__header">
              <div className="keeper-card__heading">
                <h3 className="keeper-card__title">口径与限制</h3>
                <p className="keeper-card__subtitle">本页刻意不做的事情，避免错误的“看起来更完整”</p>
              </div>
            </div>
            <div className="keeper-card__body">
              <ul className="stack" style={{ gap: 6, margin: 0, paddingLeft: 18 }}>
                <li>不推算余额、成本与 TPS：只展示上游返回的原始字段与计数。</li>
                <li>不伪造趋势线：上游没有时间序列接口，因此没有任何折线/柱状图。</li>
                <li>
                  不重复求和：同一上游路由可能被多个模型别名共享累计值，per-family、per-channel、per-key
                  的数值只按上游给出的分组展示。
                </li>
                <li>不把缺失当 0：上游未提供的字段显示“未提供/未知”，空列表显示空态而不是 0 统计。</li>
                <li>刷新失败保留上次成功快照，并在对应区块标注“数据可能已过期”。</li>
                <li>只使用只读管理接口；本页不提供写入、重启或更新原 Parrot 容器的能力。</li>
              </ul>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
