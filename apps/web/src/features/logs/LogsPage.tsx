/**
 * 请求日志页（实施文档 6.8 / 6.1 / 7.4 / 11.2）。
 *
 * 接口（全部通过 @/api 的共享客户端与查询 hook，页面内不写 fetch）：
 *   GET /logs                       -> 分页列表（PagedEnvelope_RequestLogData_）
 *   GET /logs/filter-options        -> 筛选选项（RequestLogFilterOptionsData）
 *   GET /logs/{logId}               -> 摘要（RequestLogDetailData，详情抽屉）
 *   GET /logs/{logId}/body          -> 正文条目分页（LogBodyPagedEnvelope，用户主动展开才请求）
 *   GET /logs/{logId}/body/items/{itemId} -> 单条内容（LogBodyItemData，展开某条才请求）
 *   GET /logs/{logId}/raw-body      -> 原始正文（RawLogBodyData，点击才请求）
 *
 * 硬约束：
 * - 只用上游真实支持的筛选参数；筛选选项来自 /logs/filter-options，不编造候选列表；
 * - 原始内容只经 JsonBlock 以纯文本/受控 JSON 展示，禁止 dangerouslySetInnerHTML；
 * - 六类状态可区分（加载/正常/空数据/失败/权限不足/连接中断），失败不被吞成空数组；
 * - 列表按需 30 秒轮询（usePollingInterval，后台标签页自动降频），正文不自动轮询；
 * - 不做自动全量导出。
 */

import { useMemo, useState } from 'react';
import { Button, Pagination, Switch } from 'antd';
import { DEFAULT_LIST_PAGE_SIZE, useApiQuery, useLastSuccessAt, usePollingInterval } from '@/api/hooks';
import { useAuth } from '@/app/AuthProvider';
import { TimeText } from '@/components/bits';
import { AsyncState } from '@/components/state';
import { LogDetailDrawer } from './LogDetailDrawer';
import { LogFilters } from './LogFilters';
import { LogListStateNotice, SensitiveBodyNotice } from './LogNotices';
import { LogsTable } from './LogsTable';
import {
  EMPTY_LOG_FILTERS,
  LOG_BODY_CAPABILITY,
  LOG_PAGE_SIZE_OPTIONS,
  filtersDirty,
  formatCount,
  hasActiveFilters,
  readCapability,
  readListMeta,
  type LogListFilters,
  type RequestLogData,
  type RequestLogFilterOptionsData,
} from './logTypes';
import styles from './logs.module.scss';

export function LogsPage() {
  const { capabilities } = useAuth();
  const [draft, setDraft] = useState<LogListFilters>(EMPTY_LOG_FILTERS);
  const [applied, setApplied] = useState<LogListFilters>(EMPTY_LOG_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_LIST_PAGE_SIZE);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selectedLogId, setSelectedLogId] = useState<string | null>(null);

  const listQuery = useMemo(
    () => ({
      status: applied.status,
      apiKey: applied.apiKey,
      model: applied.model,
      channel: applied.channel,
      protocol: applied.protocol,
      query: applied.query,
      startedAt: applied.startedAt,
      endedAt: applied.endedAt,
      sort: applied.sort,
      descending: applied.descending,
      page,
      pageSize,
    }),
    [applied, page, pageSize],
  );

  const list = useApiQuery<RequestLogData[]>({
    key: ['logs', 'list', listQuery],
    path: '/logs',
    query: listQuery,
    // 列表按需 30 秒刷新；页面进入后台时 usePollingInterval 会自动降频
    refetchInterval: usePollingInterval(30_000, { enabled: autoRefresh }),
  });

  const filterOptions = useApiQuery<RequestLogFilterOptionsData>({
    key: ['logs', 'filter-options'],
    path: '/logs/filter-options',
    staleTimeMs: 60_000,
  });

  const rows = list.data?.data ?? undefined;
  const meta = readListMeta(list.data?.meta);
  const lastSuccessAt = useLastSuccessAt(list);
  const bodyCapability = readCapability(capabilities, LOG_BODY_CAPABILITY);
  const filtered = hasActiveFilters(applied);

  const apply = () => {
    setApplied(draft);
    setPage(1);
  };

  const reset = () => {
    setDraft(EMPTY_LOG_FILTERS);
    setApplied(EMPTY_LOG_FILTERS);
    setPage(1);
  };

  return (
    <div className={styles.page}>
      <section className="keeper-card keeper-card--flush">
        <div className="keeper-card__header">
          <div className="keeper-card__heading">
            <span className="keeper-card__title">请求日志</span>
            <span className="keeper-card__subtitle">
              通过上游管理 API 读取既有日志；默认只加载摘要，正文按需展开。上游字符串（模型名、错误信息、正文）
              一律按纯文本渲染，绝不作为 HTML 执行。
            </span>
          </div>
          <div className="page-toolbar__actions">
            <Button onClick={() => void list.refetch()} aria-label="立即刷新日志列表">
              刷新
            </Button>
            <div className="row" style={{ gap: 8 }}>
              <Switch checked={autoRefresh} onChange={setAutoRefresh} aria-label="每 30 秒自动刷新日志列表" />
              <span className="text-sm text-secondary">每 30 秒自动刷新（后台标签页自动降频）</span>
            </div>
          </div>
        </div>

        <div className="keeper-card__body stack" style={{ gap: 'var(--keeper-section-gap)' }}>
          <LogListStateNotice error={list.error} />

          <SensitiveBodyNotice compact />

          <LogFilters
            draft={draft}
            dirty={filtersDirty(draft, applied)}
            options={filterOptions.data?.data ?? undefined}
            optionsLoading={filterOptions.isLoading}
            optionsError={filterOptions.error}
            pageSize={pageSize}
            onDraftChange={setDraft}
            onApply={apply}
            onReset={reset}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
          />

          <div className={styles.metaRow}>
            <span className="text-sm text-secondary">
              共 {meta.total === null ? '未知' : formatCount(meta.total)} 条 · 第 {meta.page ?? page} 页 · 每页{' '}
              {meta.pageSize ?? pageSize} 条
              {meta.hasNext === true ? ' · 还有下一页' : meta.hasNext === false ? ' · 已到最后一页' : ''}
            </span>
            <span className="text-sm text-tertiary">
              最近成功刷新：{lastSuccessAt ? <TimeText value={lastSuccessAt.toISOString()} withSeconds /> : '本次会话还没有成功刷新'}
            </span>
          </div>

          <AsyncState<RequestLogData[]>
            isLoading={list.isLoading}
            error={list.error}
            data={rows}
            isEmpty={(data) => data.length === 0}
            loadingLabel="正在读取请求日志…"
            emptyTitle={filtered ? '没有符合条件的日志' : '还没有请求日志'}
            emptyDescription={
              filtered
                ? '当前筛选条件（时间范围/状态/渠道/模型/Key/关键词）下上游返回 0 条。这不等于没有日志：可以放宽条件后重试。'
                : '上游返回 0 条日志。若刚清空过日志或实例刚启动，属正常；这里不会用 0 统计冒充数据。'
            }
            onRetry={() => void list.refetch()}
            isStale={list.isError && Boolean(rows)}
          >
            {(data) => <LogsTable rows={data} onOpenDetail={setSelectedLogId} />}
          </AsyncState>

          {rows && rows.length > 0 ? (
            <div className={styles.pager}>
              {meta.total === null ? (
                <div className="row" style={{ gap: 8 }}>
                  <span className="text-sm text-tertiary">上游未返回总数，仅支持逐页前后翻页。</span>
                  <Button disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
                    上一页
                  </Button>
                  <Button disabled={meta.hasNext !== true} onClick={() => setPage((current) => current + 1)}>
                    下一页
                  </Button>
                </div>
              ) : (
                <Pagination
                  current={page}
                  pageSize={pageSize}
                  total={meta.total}
                  showSizeChanger
                  pageSizeOptions={LOG_PAGE_SIZE_OPTIONS.map((size) => String(size))}
                  onChange={(nextPage, nextPageSize) => {
                    if (nextPageSize !== pageSize) {
                      setPageSize(nextPageSize);
                      setPage(1);
                      return;
                    }
                    setPage(nextPage);
                  }}
                />
              )}
              <span className="text-sm text-tertiary">当前页 {rows.length} 条</span>
            </div>
          ) : null}

          <span className="text-sm text-tertiary">
            本页不提供自动全量导出：请缩小时间范围或增加筛选条件后分页查看；导出需要真实接口支持时再单独设计。
          </span>
        </div>
      </section>

      <LogDetailDrawer
        logId={selectedLogId}
        open={Boolean(selectedLogId)}
        onClose={() => setSelectedLogId(null)}
        bodyCapability={bodyCapability}
      />
    </div>
  );
}
