/**
 * 实时运行视图（Keeper 风格，独立页面；路由与导航由外层接入）。
 *
 * 数据来源（全部只读管理接口）：
 * - GET /runtime/status      -> RuntimeStatusData（上游自带的 cooldownSummary、problemChannels）
 * - GET /runtime/concurrency -> ConcurrencyData（channelTotals / apiKeyTotals 聚合字段 + 逐渠道/逐 Key 明细）
 * - GET /runtime/cooldowns   -> CooldownData[]（分页，meta 带 total/page/pageSize/hasNext）
 * - GET /stats/recent-calls  -> RecentCallData[]（分页，同上）
 *
 * 遵守的展示规则：
 * - 每 15 秒刷新；页面进入后台由 usePollingInterval 自动降频。
 * - 每个区块都用 AsyncState 渲染六类状态：加载中、正常、空数据、加载失败（权限不足 /
 *   连接中断由 ErrorNotice 分别标注）、以及刷新失败时保留的上次成功快照。
 * - 不做假聚合：分页列表只展示当前页条目，派生数值（占用率、本页耗时样本、本页状态分布）
 *   一律标注"仅当前页样本"，既不跨页累计，也不冒充全窗口成功率。
 * - 缺失值显示"未提供/未知"，不显示 0；空列表显示空态，不显示 0 统计。
 * - 本页没有任何写入动作，也不会触发重启/更新原 Parrot 容器。
 */

import { useCallback, useState } from 'react';
import type { ApiError } from '@/api/client';
import { DEFAULT_LIST_PAGE_SIZE, useApiQuery, usePollingInterval } from '@/api/hooks';
import { MonoText, Pill, RelativeTime, StatCard, TimeText, type Tone } from '@/components/bits';
import { ErrorNotice } from '@/components/feedback';
import { AsyncState } from '@/components/state';
import type {
  ApiKeyConcurrencyRowData,
  ChannelConcurrencyRowData,
  ChannelStatusData,
  ConcurrencyData,
  CooldownData,
  RecentCallData,
  RuntimeStatusData,
} from '../../../../../packages/contracts/generated/upstream-mvp';
import styles from './RealtimePage.module.scss';

/** 运行视图固定 15 秒刷新。 */
const POLL_MS = 15_000;
const PAGE_SIZE_OPTIONS = [10, 20, 50];
/** 问题渠道表最多展示的上游条目数（超出的部分明确说明未展示，不做截断式误导）。 */
const PROBLEM_CHANNEL_LIMIT = 12;

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

const COOLDOWN_STATE_LABEL: Record<CooldownData['state'], string> = {
  active: '临时冷却',
  permanent: '永久冷却',
};

/** 数字字段缺失时显示"未提供"，绝不显示 0 冒充统计值。 */
function formatCount(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未提供';
  return value.toLocaleString('zh-CN');
}

function formatMilliseconds(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未提供';
  return `${value.toLocaleString('zh-CN')} ms`;
}

function formatSeconds(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '未提供';
  if (value < 1) return `${value.toFixed(1)} 秒`;
  return `${value.toLocaleString('zh-CN')} 秒`;
}

/** 上游 meta 只保证是对象；字段按真实类型读取，缺失返回 null（未知）。 */
function metaNumber(meta: Record<string, unknown> | undefined, key: string): number | null {
  const value = meta?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function metaBoolean(meta: Record<string, unknown> | undefined, key: string): boolean | null {
  const value = meta?.[key];
  return typeof value === 'boolean' ? value : null;
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

/**
 * 逐行占用率：同一行上游字段的 inFlight ÷ maxConcurrent。
 * unlimited 或上限 <= 0 时无法计算，返回 null（显示"无法计算"，不显示 0%）。
 * 绝不跨行求和，也不与 channelTotals 混淆。
 */
function rowUtilization(row: { inFlight: number; maxConcurrent: number; unlimited: boolean }): number | null {
  if (row.unlimited) return null;
  if (typeof row.maxConcurrent !== 'number' || !Number.isFinite(row.maxConcurrent) || row.maxConcurrent <= 0) return null;
  if (typeof row.inFlight !== 'number' || !Number.isFinite(row.inFlight)) return null;
  return row.inFlight / row.maxConcurrent;
}

interface DurationSample {
  count: number;
  average: number | null;
  min: number | null;
  max: number | null;
}

/** 本页耗时样本：只统计当前页中上游给出了 durationMilliseconds 的行。 */
function durationSample(rows: RecentCallData[]): DurationSample {
  const values = rows
    .map((row) => row.durationMilliseconds)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (!values.length) return { count: 0, average: null, min: null, max: null };
  let sum = 0;
  let min = values[0] ?? 0;
  let max = values[0] ?? 0;
  for (const value of values) {
    sum += value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { count: values.length, average: sum / values.length, min, max };
}

/** 本页状态分布：上游 status 字符串原样计数，不做 success/failure 归类猜测。 */
function statusDistribution(rows: RecentCallData[]): Array<{ status: string; count: number }> {
  const buckets = new Map<string, number>();
  for (const row of rows) {
    const key = typeof row.status === 'string' && row.status.trim() ? row.status : '(上游未提供 status)';
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return Array.from(buckets.entries()).map(([status, count]) => ({ status, count }));
}

function Utilization({ ratio }: { ratio: number | null }) {
  if (ratio === null) {
    return <span className="text-tertiary">无法计算（unlimited 或上限未知）</span>;
  }
  const percent = ratio * 100;
  const width = Math.max(0, Math.min(100, percent));
  const warn = ratio >= 0.9;
  return (
    <span className={styles.utilization}>
      <span className={warn ? `${styles.utilizationText} text-danger` : styles.utilizationText}>
        {percent.toFixed(1)}%
      </span>
      <span className={styles.meter} aria-hidden="true">
        <span
          className={warn ? `${styles.meterFill} ${styles.meterFillWarn}` : styles.meterFill}
          style={{ width: `${width}%` }}
        />
      </span>
    </span>
  );
}

function Pager({
  label,
  page,
  pageSize,
  total,
  hasNext,
  busy,
  onPageChange,
  onPageSizeChange,
}: {
  label: string;
  page: number;
  pageSize: number;
  total: number | null;
  hasNext: boolean | null;
  busy: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  return (
    <div className={styles.pager}>
      <span className="text-sm text-secondary">
        上游总数 {total === null ? '未提供' : formatCount(total)} 条 · 第 {page} 页 · 每页 {pageSize} 条
        {hasNext === true ? ' · 上游标记还有下一页' : hasNext === false ? ' · 上游标记已到最后一页' : ' · 上游未返回翻页标记'}
      </span>
      <div className={styles.pagerActions}>
        <button
          type="button"
          className="btn btn--sm btn--secondary"
          disabled={busy || page <= 1}
          onClick={() => onPageChange(page - 1)}
          aria-label={`查看${label}的上一页`}
        >
          上一页
        </button>
        <button
          type="button"
          className="btn btn--sm btn--secondary"
          disabled={busy || hasNext !== true}
          onClick={() => onPageChange(page + 1)}
          aria-label={`查看${label}的下一页`}
        >
          下一页
        </button>
        <label className={styles.pageSize}>
          <span className="text-sm text-secondary">每页</span>
          <select
            className="input"
            value={String(pageSize)}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            aria-label={`设置${label}每页条数`}
          >
            {PAGE_SIZE_OPTIONS.map((option) => (
              <option key={option} value={String(option)}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

export function RealtimePage() {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const interval = usePollingInterval(POLL_MS, { enabled: autoRefresh });

  const [cooldownPage, setCooldownPage] = useState(1);
  const [cooldownPageSize, setCooldownPageSize] = useState(DEFAULT_LIST_PAGE_SIZE);
  const [callPage, setCallPage] = useState(1);
  const [callPageSize, setCallPageSize] = useState(DEFAULT_LIST_PAGE_SIZE);

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
    key: ['runtime', 'cooldowns', { page: cooldownPage, pageSize: cooldownPageSize }],
    path: '/runtime/cooldowns',
    query: { page: cooldownPage, pageSize: cooldownPageSize },
    refetchInterval: interval,
  });
  const recentCalls = useApiQuery<RecentCallData[]>({
    key: ['stats', 'recent-calls', { page: callPage, pageSize: callPageSize }],
    path: '/stats/recent-calls',
    query: { page: callPage, pageSize: callPageSize },
    refetchInterval: interval,
  });

  const results = [runtimeStatus, concurrency, cooldowns, recentCalls];

  const refreshAll = useCallback(() => {
    void Promise.all([
      runtimeStatus.refetch(),
      concurrency.refetch(),
      cooldowns.refetch(),
      recentCalls.refetch(),
    ]);
  }, [runtimeStatus, concurrency, cooldowns, recentCalls]);

  const timestamps = results.map((result) => result.dataUpdatedAt).filter((value) => value > 0);
  const lastSuccessAt = timestamps.length ? new Date(Math.max(...timestamps)) : null;
  const lastSuccessIso = lastSuccessAt ? lastSuccessAt.toISOString() : null;
  const anyFetching = results.some((result) => result.isFetching);
  const staleSections = results.filter((result) => result.isError && Boolean(result.data)).length;
  const anyData = results.some((result) => Boolean(result.data));
  const firstError: ApiError | null =
    results.map((result) => result.error).find((error): error is ApiError => Boolean(error)) ?? null;
  /** 四个接口全部失败且没有任何快照时，只显示一个总错误卡，避免四份重复错误。 */
  const fatalError = anyData ? null : firstError;

  // ---------------------------------------------------------------- 分页数据与派生样本
  const cooldownRows = cooldowns.data?.data ?? undefined;
  const cooldownMeta = cooldowns.data?.meta;
  const cooldownTotal = metaNumber(cooldownMeta, 'total');
  const cooldownHasNext = metaBoolean(cooldownMeta, 'hasNext');

  const callRows = recentCalls.data?.data ?? undefined;
  const callMeta = recentCalls.data?.meta;
  const callTotal = metaNumber(callMeta, 'total');
  const callHasNext = metaBoolean(callMeta, 'hasNext');

  const cooldownActiveInPage = cooldownRows?.filter((row) => row.state === 'active').length ?? 0;
  const cooldownPermanentInPage = cooldownRows?.filter((row) => row.state === 'permanent').length ?? 0;
  const callStatuses = statusDistribution(callRows ?? []);
  const callDurations = durationSample(callRows ?? []);

  const problemChannels = runtimeStatus.data?.data?.problemChannels ?? [];
  const visibleProblemChannels = problemChannels.slice(0, PROBLEM_CHANNEL_LIMIT);

  const changeCooldownPageSize = (next: number) => {
    if (next === cooldownPageSize) return;
    setCooldownPageSize(next);
    setCooldownPage(1);
  };
  const changeCallPageSize = (next: number) => {
    if (next === callPageSize) return;
    setCallPageSize(next);
    setCallPage(1);
  };

  return (
    <div className={styles.page}>
      <section className="keeper-card">
        <div className="keeper-card__header">
          <div className="keeper-card__heading">
            <span className="app-topbar__eyebrow">Realtime</span>
            <h2 className="keeper-card__title">实时运行视图</h2>
            <p className="keeper-card__subtitle">
              只读运行观测：并发占用与排队、冷却明细、最近请求。每 15 秒刷新一次，标签页进入后台后自动降频。
              所有数值都来自上游返回的字段，本页不推算余额/成本，不绘制趋势线，也不把"当前页样本"说成全量统计。
            </p>
          </div>
          <div className={styles.headActions}>
            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(event) => setAutoRefresh(event.target.checked)}
                aria-label="每 15 秒自动刷新运行数据"
              />
              <span className="text-sm text-secondary">每 15 秒自动刷新</span>
            </label>
            <button type="button" className="btn btn--sm btn--secondary" onClick={refreshAll} disabled={anyFetching}>
              {anyFetching ? '刷新中…' : '立即刷新'}
            </button>
          </div>
        </div>
        <div className="keeper-card__body">
          <div className={styles.sectionBody}>
            <div className={styles.refreshRow}>
              <strong>最近成功刷新：</strong>
              {lastSuccessIso ? (
                <>
                  <RelativeTime value={lastSuccessIso} />
                  <TimeText value={lastSuccessIso} withSeconds />
                </>
              ) : (
                <span className="text-tertiary">本次会话尚未成功刷新</span>
              )}
            </div>
            {staleSections ? (
              <div className="notice-box notice-box--warning" role="status">
                有 {staleSections} 个区块本次刷新失败，下面显示的是上一次成功快照，数据可能已过期。
              </div>
            ) : null}
            <div className="notice-box" role="note">
              状态口径：每个区块都区分加载中、正常、空数据、加载失败（权限不足与连接中断分别标注）、以及刷新失败时
              保留的上次快照。上游未提供的字段显示"未提供/未知"，空列表显示空态而不是 0 统计。本页为只读视图，
              不提供任何写入、重启或更新操作。
            </div>
          </div>
        </div>
      </section>

      {fatalError ? (
        <section className="keeper-card">
          <div className="keeper-card__body">
            <div className={styles.sectionBody}>
              <ErrorNotice error={fatalError} onRetry={refreshAll} />
              <p className={styles.note}>
                四个只读接口（/runtime/status、/runtime/concurrency、/runtime/cooldowns、/stats/recent-calls）
                本次都没有返回可用数据。请先确认 WebUI 到 Parrot 的链路与上游管理权限，再重试。
              </p>
            </div>
          </div>
        </section>
      ) : (
        <>
          {/* ------------------------------------------------ 运行时状态与冷却分布 */}
          <section className="keeper-card">
            <div className="keeper-card__header">
              <div className="keeper-card__heading">
                <h3 className="keeper-card__title">运行时状态与冷却分布</h3>
                <p className="keeper-card__subtitle">
                  来源：GET /runtime/status（channels、problemChannels、cooldownSummary、quotaWarnings）
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
                        hint="上游 channels 数组条目数（上游给出的完整状态列表，不是分页）"
                      />
                      <StatCard
                        label="问题渠道"
                        value={formatCount(data.problemChannels?.length)}
                        tone={data.problemChannels?.length ? 'warning' : undefined}
                        hint="上游 problemChannels 数组条目数"
                      />
                      <StatCard
                        label="配额预警账号"
                        value={formatCount(data.quotaWarnings?.length)}
                        hint="上游 quotaWarnings 数组条目数"
                      />
                    </div>

                    <div>
                      <div className="field__label">cooldownSummary（上游原样分布，不做求和与换算）</div>
                      {Object.keys(data.cooldownSummary ?? {}).length ? (
                        <div className={styles.summaryRow}>
                          {Object.entries(data.cooldownSummary).map(([label, value]) => (
                            <span key={label} className={styles.summaryItem}>
                              <MonoText truncate>{label}</MonoText>
                              <span>{formatCount(value)}</span>
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-tertiary">上游未返回冷却分布</span>
                      )}
                    </div>

                    {visibleProblemChannels.length ? (
                      <div className={styles.scroll}>
                        <div className={`keeper-table ${styles.table}`}>
                          <div className={`keeper-table__header ${styles.colsProblems}`}>
                            <span>渠道</span>
                            <span>健康状态</span>
                            <span>冷却数</span>
                            <span>近期成功率</span>
                            <span>问题原因</span>
                          </div>
                          {visibleProblemChannels.map((channel) => (
                            <div
                              key={channel.id}
                              className={`keeper-table__row ${styles.colsProblems}`}
                              style={{ cursor: 'default' }}
                            >
                              <span className="cell">
                                <span>{channel.name}</span>
                                <MonoText truncate>{channel.id}</MonoText>
                              </span>
                              <span className="cell">
                                <Pill title="上游 health 字段原生值">{HEALTH_LABEL[channel.health] ?? channel.health}</Pill>
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

                    {problemChannels.length > visibleProblemChannels.length ? (
                      <p className={styles.note}>
                        只显示前 {PROBLEM_CHANNEL_LIMIT} 个问题渠道（上游共 {formatCount(problemChannels.length)} 个）；
                        本页不将这 {PROBLEM_CHANNEL_LIMIT} 条视为全部问题渠道。
                      </p>
                    ) : null}

                    <p className={styles.note}>
                      说明：/runtime/status 还包含 affinitySummary、database、fastestByFamily 等无固定 schema 的字段
                      （Record&lt;string, JsonValue&gt;），语义与口径由上游定义，本页不做推算，因此原样留空不展示。
                    </p>
                  </div>
                )}
              </AsyncState>
            </div>
          </section>

          {/* ------------------------------------------------ 并发占用与排队 */}
          <section className="keeper-card">
            <div className="keeper-card__header">
              <div className="keeper-card__heading">
                <h3 className="keeper-card__title">并发占用与排队</h3>
                <p className="keeper-card__subtitle">
                  来源：GET /runtime/concurrency（channelTotals / apiKeyTotals 聚合字段 + channels / apiKeys 明细）
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
                        hint="上游聚合字段 channelTotals.inFlight（本页不对明细行求和）"
                      />
                      <StatCard
                        label="渠道排队等待"
                        value={formatCount(data.channelTotals?.waiting)}
                        tone={typeof data.channelTotals?.waiting === 'number' && data.channelTotals.waiting > 0 ? 'warning' : undefined}
                        hint="上游聚合字段 channelTotals.waiting（本页不对明细行求和）"
                      />
                      <StatCard
                        label="纳入统计渠道"
                        value={formatCount(data.channelTotals?.trackedChannels)}
                        hint="上游聚合字段 channelTotals.trackedChannels"
                      />
                      <StatCard
                        label="Key 在飞请求"
                        value={formatCount(data.apiKeyTotals?.inFlight)}
                        hint="上游聚合字段 apiKeyTotals.inFlight"
                      />
                      <StatCard
                        label="Key 排队等待"
                        value={formatCount(data.apiKeyTotals?.waiting)}
                        tone={typeof data.apiKeyTotals?.waiting === 'number' && data.apiKeyTotals.waiting > 0 ? 'warning' : undefined}
                        hint="上游聚合字段 apiKeyTotals.waiting"
                      />
                      <StatCard
                        label="纳入统计 Key"
                        value={formatCount(data.apiKeyTotals?.trackedKeys)}
                        hint="上游聚合字段 apiKeyTotals.trackedKeys"
                      />
                    </div>

                    <div className="notice-box" role="note">
                      占用 % 为本页按<strong>同一行</strong>上游字段 inFlight ÷ maxConcurrent 计算；unlimited 或上限未知时显示
                      "无法计算"。既不对明细行求和，也不把明细与 channelTotals / apiKeyTotals 混为一谈（两者口径由上游定义）。
                      明细按下游返回顺序展示。
                    </div>

                    <div>
                      <div className="field__label">渠道级并发（上游 channels）</div>
                      {data.channels?.length ? (
                        <div className={styles.scroll}>
                          <div className={`keeper-table ${styles.table}`}>
                            <div className={`keeper-table__header ${styles.colsChannels}`}>
                              <span>渠道 Key</span>
                              <span>在飞</span>
                              <span>上限</span>
                              <span>等待</span>
                              <span>占用（本行派生）</span>
                              <span>说明</span>
                            </div>
                            {data.channels.map((row: ChannelConcurrencyRowData) => (
                              <div
                                key={row.channelKey}
                                className={`keeper-table__row ${styles.colsChannels}`}
                                style={{ cursor: 'default' }}
                              >
                                <span className="cell">
                                  <MonoText truncate>{row.channelKey}</MonoText>
                                </span>
                                <span className="cell">{formatCount(row.inFlight)}</span>
                                <span className="cell">{row.unlimited ? '无限制' : formatCount(row.maxConcurrent)}</span>
                                <span className="cell">{formatCount(row.waiting)}</span>
                                <span className="cell">
                                  <Utilization ratio={rowUtilization(row)} />
                                </span>
                                <span className="cell">
                                  {row.unlimited ? '上游 unlimited=true' : '受上游上限约束'}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <p className={styles.note}>上游没有返回渠道级并发明细（channels 为空）。</p>
                      )}
                    </div>

                    <div>
                      <div className="field__label">下游 Key 级并发（上游 apiKeys）</div>
                      {data.apiKeys?.length ? (
                        <div className={styles.scroll}>
                          <div className={`keeper-table ${styles.table}`}>
                            <div className={`keeper-table__header ${styles.colsKeys}`}>
                              <span>Key 名称</span>
                              <span>在飞</span>
                              <span>上限</span>
                              <span>等待</span>
                              <span>队列上限</span>
                              <span>队列等待</span>
                              <span>最久等待</span>
                              <span>启用 / 说明</span>
                            </div>
                            {data.apiKeys.map((row: ApiKeyConcurrencyRowData, index) => (
                              <div
                                key={`${index}-${row.keyName}`}
                                className={`keeper-table__row ${styles.colsKeys}`}
                                style={{ cursor: 'default' }}
                              >
                                <span className="cell">
                                  <MonoText truncate>{row.keyName}</MonoText>
                                </span>
                                <span className="cell">{formatCount(row.inFlight)}</span>
                                <span className="cell">{row.unlimited ? '无限制' : formatCount(row.maxConcurrent)}</span>
                                <span className="cell">{formatCount(row.waiting)}</span>
                                <span className="cell">{formatCount(row.maxQueue)}</span>
                                <span className="cell">{formatSeconds(row.queueWaitSeconds)}</span>
                                <span className="cell">{formatSeconds(row.oldestWaitSeconds)}</span>
                                <span className="cell">
                                  <Pill tone={row.enabled ? 'success' : 'muted'}>{row.enabled ? '启用' : '停用'}</Pill>
                                  <span className="text-sm text-secondary">
                                    上限来源 {row.maxConcurrentSource || '未提供'} · 队列来源 {row.maxQueueSource || '未提供'} · 等待来源{' '}
                                    {row.queueWaitSource || '未提供'} · 启用来源 {row.enabledSource || '未提供'}
                                  </span>
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <p className={styles.note}>上游没有返回 Key 级并发明细（apiKeys 为空）。</p>
                      )}
                    </div>
                  </div>
                )}
              </AsyncState>
            </div>
          </section>

          {/* ------------------------------------------------ 冷却明细（分页） */}
          <section className="keeper-card">
            <div className="keeper-card__header">
              <div className="keeper-card__heading">
                <h3 className="keeper-card__title">冷却明细</h3>
                <p className="keeper-card__subtitle">
                  来源：GET /runtime/cooldowns（分页；本页只展示当前页，翻页由上游 hasNext 决定）
                </p>
              </div>
            </div>
            <div className="keeper-card__body">
              <AsyncState<CooldownData[]>
                isLoading={cooldowns.isLoading}
                error={cooldowns.error}
                data={cooldownRows}
                isEmpty={(rows) => rows.length === 0}
                emptyTitle={cooldownPage > 1 ? '当前页没有冷却记录' : '当前没有冷却记录'}
                emptyDescription={
                  cooldownPage > 1
                    ? '上游在这一页返回 0 条。可能是总数变化导致页面越界，请用"上一页"回到仍有数据的页面。'
                    : '上游 /runtime/cooldowns 返回 0 条；这表示当前没有冷却中的渠道/模型，不等于渠道健康度评分。'
                }
                onRetry={() => void cooldowns.refetch()}
                isStale={cooldowns.isError && Boolean(cooldownRows)}
                loadingLabel="正在读取 /runtime/cooldowns…"
              >
                {(rows) => (
                  <div className={styles.sectionBody}>
                    <Pager
                      label="冷却明细"
                      page={cooldownPage}
                      pageSize={cooldownPageSize}
                      total={cooldownTotal}
                      hasNext={cooldownHasNext}
                      busy={cooldowns.isFetching}
                      onPageChange={setCooldownPage}
                      onPageSizeChange={changeCooldownPageSize}
                    />
                    <p className={styles.note}>
                      当前页状态分布（仅本页 {formatCount(rows.length)} 条样本，不是全量冷却数）：
                      临时冷却 {formatCount(cooldownActiveInPage)} 条 · 永久冷却 {formatCount(cooldownPermanentInPage)} 条。
                      全量口径请以上方 /runtime/status 的 cooldownSummary 与上游 meta.total 为准。
                    </p>
                    <div className={styles.scroll}>
                      <div className={`keeper-table ${styles.table}`}>
                        <div className={`keeper-table__header ${styles.colsCooldowns}`}>
                          <span>渠道 ID</span>
                          <span>模型</span>
                          <span>状态</span>
                          <span>错误数</span>
                          <span>解除时间</span>
                          <span>上游消息</span>
                        </div>
                        {rows.map((row) => (
                          <div
                            key={`${row.channelId}-${row.model}-${row.state}-${row.until ?? 'no-until'}`}
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
                              {row.state === 'permanent' ? (
                                <Pill tone="danger" title="上游 state=permanent，需要人工处理，不会自动解除">
                                  无自动解除时间
                                </Pill>
                              ) : (
                                <TimeText value={row.until} withSeconds />
                              )}
                            </span>
                            <span className="cell">{row.message ?? '上游未提供'}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <p className={styles.note}>
                      行内只展示上游原样字段：错误数与解除时间都来自上游，本页不推断剩余时长，也不把临时冷却当作永久冷却。
                    </p>
                  </div>
                )}
              </AsyncState>
              {cooldownPage > 1 && cooldownRows?.length === 0 && (
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => setCooldownPage((value) => value - 1)}>返回上一页</button>
              )}
            </div>
          </section>

          {/* ------------------------------------------------ 最近请求（分页） */}
          <section className="keeper-card">
            <div className="keeper-card__header">
              <div className="keeper-card__heading">
                <h3 className="keeper-card__title">最近请求</h3>
                <p className="keeper-card__subtitle">
                  来源：GET /stats/recent-calls（分页；本页派生数值只针对当前页样本）
                </p>
              </div>
            </div>
            <div className="keeper-card__body">
              <AsyncState<RecentCallData[]>
                isLoading={recentCalls.isLoading}
                error={recentCalls.error}
                data={callRows}
                isEmpty={(rows) => rows.length === 0}
                emptyTitle={callPage > 1 ? '当前页没有请求记录' : '上游没有返回最近请求'}
                emptyDescription={
                  callPage > 1
                    ? '上游在这一页返回 0 条。可能是新请求写入导致页面越界，请用"上一页"回到仍有数据的页面。'
                    : '/stats/recent-calls 返回 0 条；需要按条件检索完整请求明细，请到"请求日志"页。'
                }
                onRetry={() => void recentCalls.refetch()}
                isStale={recentCalls.isError && Boolean(callRows)}
                loadingLabel="正在读取 /stats/recent-calls…"
              >
                {(rows) => (
                  <div className={styles.sectionBody}>
                    <Pager
                      label="最近请求"
                      page={callPage}
                      pageSize={callPageSize}
                      total={callTotal}
                      hasNext={callHasNext}
                      busy={recentCalls.isFetching}
                      onPageChange={setCallPage}
                      onPageSizeChange={changeCallPageSize}
                    />

                    <div className={styles.sampleBox} role="note">
                      <strong>样本口径（仅当前页，不是全窗口统计）</strong>
                      <span className="text-sm text-secondary">
                        上游没有时间窗口接口，因此下面的派生值只对本页 {formatCount(rows.length)} 条记录成立，不跨页累计，
                        也不代表全量成功率或平均延迟。
                      </span>
                      <span className={styles.sampleLine}>
                        <span className="text-sm text-secondary">状态分布（上游 status 原样计数）：</span>
                        {callStatuses.length ? (
                          callStatuses.map((item) => (
                            <Pill key={item.status} tone="muted" mono>
                              {item.status} × {item.count}
                            </Pill>
                          ))
                        ) : (
                          <span className="text-tertiary">本页无可用记录</span>
                        )}
                      </span>
                      <span className="text-sm text-secondary">
                        耗时样本：{formatCount(callDurations.count)} 条带 durationMilliseconds
                        {callDurations.count
                          ? ` · 本页平均 ${formatMilliseconds(callDurations.average)} · 最小 ${formatMilliseconds(
                              callDurations.min,
                            )} · 最大 ${formatMilliseconds(callDurations.max)}`
                          : ' · 本页没有任何耗时字段，无法给出平均值'}
                      </span>
                    </div>

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
                              <span className="text-sm text-tertiary">
                                <TimeText value={call.createdAt} withSeconds />
                              </span>
                            </span>
                            <span className="cell">{call.model ?? '未提供'}</span>
                            <span className="cell">
                              <MonoText truncate>{call.channelId ?? '未提供'}</MonoText>
                            </span>
                            <span className="cell">
                              <Pill mono title="上游 status 原样值，本页不判定成功/失败">
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
              {callPage > 1 && callRows?.length === 0 && (
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => setCallPage((value) => value - 1)}>返回上一页</button>
              )}
            </div>
          </section>

          {/* ------------------------------------------------ 口径与限制 */}
          <section className="keeper-card">
            <div className="keeper-card__header">
              <div className="keeper-card__heading">
                <h3 className="keeper-card__title">口径与限制</h3>
                <p className="keeper-card__subtitle">本页刻意不做的事情</p>
              </div>
            </div>
            <div className="keeper-card__body">
              <ul className={styles.limits}>
                <li>不伪造聚合：分页列表只统计当前页样本，并逐处标注；不做跨页累加，也不把样本值当成全窗口指标。</li>
                <li>
                  不猜测状态语义：/stats/recent-calls 的 status 原样展示并原样计数，WebUI 不自行把某个字符串判定为"失败"或
                  "限流"。
                </li>
                <li>不重复求和：并发明细按上游返回顺序逐行展示，占用率只由同一行字段推导；汇总值一律取上游 channelTotals / apiKeyTotals。</li>
                <li>不把缺失当 0：未提供的字段显示"未提供/未知"；unlimited 的行显示"无法计算"而不是 0%。</li>
                <li>不伪造趋势：上游没有时间序列接口，因此没有折线图或柱状图。</li>
                <li>刷新失败保留上次成功快照并标注"数据可能已过期"；权限不足与连接中断按 ApiError 来源分别提示，不被吞成空数据。</li>
                <li>只读：本页不写任何管理资源，也不重启或更新原 Parrot 容器。</li>
              </ul>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
