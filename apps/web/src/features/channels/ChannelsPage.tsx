/**
 * 「第三方 API 渠道」页面。
 *
 * 覆盖（实施文档 6.4 / 6.1）：
 * - 列表：`GET /channels`（筛选/分页只用生成类型里真实存在的参数），AntD Table + 行点击打开详情抽屉。
 * - 详情 / 编辑 / 启停 / 诊断 / 模型发现 / 刷新用量 / 清除错误与亲和 / 兼容性 / 删除：见 ChannelDetailDrawer。
 * - 新增：`GET /channel-catalog` → `POST /channels`，草稿诊断与草稿模型发现见 CreateChannelModal。
 * - 六类状态：AsyncState + ErrorNotice 区分加载/正常/空/失败/权限不足/连接中断；409 用 ConflictNotice 处理。
 * - 只读会话：useWriteCapability 预先禁用写按钮并说明原因。
 *
 * 排序（PUT /channels/order）本页不实现，因此页面上也不提供任何排序/拖拽入口。
 */

import { useState } from 'react';
import { Input, Select, Table, type TableColumnsType } from 'antd';
import { ApiError, type ManagementResponse } from '@/api/client';
import { UPSTREAM_CODE } from '@/api/error-codes';
import { DEFAULT_LIST_PAGE_SIZE } from '@/api/hooks';
import { useWriteCapability } from '@/app/AuthProvider';
import { DangerConfirmButton, JsonBlock, MonoText, Pill, RelativeTime } from '@/components/bits';
import { ErrorNotice } from '@/components/feedback';
import { AsyncState } from '@/components/state';
import {
  readActionResult,
  readChannelListMeta,
  useChannelCatalog,
  useChannelList,
  useClearAllChannelAffinity,
  useClearAllChannelErrors,
  useUpdateChannel,
  type ChannelListFilters,
} from './channelsApi';
import { HEALTH_OPTIONS, HEALTH_LABEL, PROTOCOL_LABEL, PROTOCOL_OPTIONS, healthTone, countText, rawNumberText } from './channelLabels';
import { ChannelNoticeBox, type ChannelNotice } from './ChannelNotice';
import { ChannelDetailDrawer } from './ChannelDetailDrawer';
import { CreateChannelModal } from './CreateChannelModal';
import type { ActionResultData, ChannelData, ChannelHealth, ChannelProtocol } from './upstream-types';
import styles from './ChannelsPage.module.scss';

interface FilterForm {
  search: string;
  enabled: boolean | null;
  protocol: ChannelProtocol | null;
  providerId: string | null;
  health: ChannelHealth | null;
}

const EMPTY_FILTERS: FilterForm = { search: '', enabled: null, protocol: null, providerId: null, health: null };

const ENABLED_OPTIONS = [
  { value: 'enabled', label: '仅已启用' },
  { value: 'disabled', label: '仅已停用' },
];

export function ChannelsPage() {
  const { canWrite, reason: writeBlockReason } = useWriteCapability();

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_LIST_PAGE_SIZE);
  /** 已应用的筛选条件（驱动查询）；表单里的值只有点击"查询"后才生效。 */
  const [applied, setApplied] = useState<FilterForm>(EMPTY_FILTERS);
  const [form, setForm] = useState<FilterForm>(EMPTY_FILTERS);

  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [pageNotice, setPageNotice] = useState<ChannelNotice | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [rawSyncResult, setRawSyncResult] = useState<unknown>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const update = useUpdateChannel();
  const clearAllErrors = useClearAllChannelErrors();
  const clearAllAffinity = useClearAllChannelAffinity();
  const catalog = useChannelCatalog();

  const filters: ChannelListFilters = {
    page,
    pageSize,
    search: applied.search,
    enabled: applied.enabled ?? undefined,
    protocol: applied.protocol ?? undefined,
    providerId: applied.providerId ?? undefined,
    health: applied.health ?? undefined,
  };
  const list = useChannelList(filters);
  const meta = readChannelListMeta(list.data?.meta);

  const protocolOptions = catalog.data?.data?.protocols.length
    ? catalog.data.data.protocols.map((value) => ({ value, label: `${PROTOCOL_LABEL[value]}（${value}）` }))
    : PROTOCOL_OPTIONS;
  const providerOptions = (catalog.data?.data?.providers ?? []).map((provider) => ({
    value: provider.id,
    label: `${provider.name}（${provider.id}）`,
  }));

  const applyFilters = () => {
    setPage(1);
    setApplied(form);
  };

  const resetFilters = () => {
    setForm(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setPage(1);
  };

  /** 行内启停：用列表读到的那一行的 revision 作为 If-Match（不静默改写版本）。 */
  const toggleEnabled = async (row: ChannelData) => {
    setPageNotice(null);
    setActionError(null);
    setRawSyncResult(null);
    setTogglingId(row.id);
    try {
      const response = await update.mutateAsync({
        channelId: row.id,
        body: { enabled: !row.enabled },
        ifMatch: row.revision,
      });
      setPageNotice({
        tone: 'success',
        text: (
          <>
            渠道「{row.name}」已{row.enabled ? '停用' : '启用'}（HTTP {response.status}），新 revision：
            <span className="mono">{response.data?.revision ?? '未知'}</span>。
          </>
        ),
      });
    } catch (caught) {
      const apiError = caught instanceof ApiError ? caught : null;
      if (apiError?.code === UPSTREAM_CODE.REVISION_CONFLICT) {
        // 409 不自动覆盖：刷新列表让用户看到服务端最新状态后自行决定。
        void list.refetch();
      }
      setActionError(apiError);
    } finally {
      setTogglingId(null);
    }
  };

  /** 上游的批量动作不接受渠道列表参数，因此作用范围是"全部渠道"，界面上必须说清楚。 */
  const runBatchAction = async (label: string, run: () => Promise<ManagementResponse<ActionResultData>>) => {
    setPageNotice(null);
    setActionError(null);
    setRawSyncResult(null);
    try {
      const response = await run();
      const { affected, queued } = readActionResult(response);
      setPageNotice({
        tone: queued ? 'warning' : 'success',
        text: (
          <>
            {label}：上游返回 HTTP {response.status}，affected={affected === null ? '未知' : affected}
            {queued === true
              ? '，且 queued=true（上游未返回可跟踪的任务 ID，请稍后刷新确认）。'
              : '（该端点返回的是同步结果，不是异步任务）。'}
          </>
        ),
      });
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught : null);
    }
  };

  const columns: TableColumnsType<ChannelData> = [
    {
      title: '名称',
      key: 'name',
      fixed: 'left',
      width: 200,
      render: (_, row) => (
        <div className={styles.nameCell}>
          <span className={styles.nameCell__title}>{row.name}</span>
          <span className="mono text-tertiary text-sm">{row.id}</span>
        </div>
      ),
    },
    {
      title: '供应商 / 协议',
      key: 'provider',
      width: 220,
      render: (_, row) => (
        <div className="cell">
          <Pill mono>{PROTOCOL_LABEL[row.protocol]}</Pill>
          <span className="text-sm text-secondary">
            {row.providerId
              ? `${row.providerId}${row.providerPresetId ? ` / ${row.providerPresetId}` : ''}`
              : '手动配置'}
          </span>
        </div>
      ),
    },
    {
      title: '地址',
      key: 'url',
      width: 280,
      render: (_, row) => (
        <div className={styles.urlCell}>
          <MonoText truncate>{row.url}</MonoText>
          <span className={styles.urlCell__hint} title={`baseUrl=${row.baseUrl} apiPath=${row.apiPath ?? '未设置'}`}>
            baseUrl={row.baseUrl}
            {row.apiPath ? ` · apiPath=${row.apiPath}` : ''}
          </span>
        </div>
      ),
    },
    {
      title: '配置状态',
      key: 'enabled',
      width: 190,
      render: (_, row) => (
        <div className="cell" onClick={(event) => event.stopPropagation()} role="presentation">
          <Pill tone={row.enabled ? 'success' : 'muted'}>{row.enabled ? '已启用' : '已停用'}</Pill>
          <button
            type="button"
            className="btn btn--sm btn--secondary"
            disabled={!canWrite || togglingId === row.id || update.isPending}
            title={canWrite ? undefined : writeBlockReason ?? '当前会话不可写'}
            aria-label={`${row.enabled ? '停用' : '启用'}渠道 ${row.name}`}
            onClick={() => void toggleEnabled(row)}
          >
            {togglingId === row.id ? '提交中…' : row.enabled ? '停用' : '启用'}
          </button>
          {row.disabledReason ? <span className="text-sm text-tertiary">原因：{row.disabledReason}</span> : null}
        </div>
      ),
    },
    {
      title: '运行时状态',
      key: 'health',
      width: 220,
      render: (_, row) => (
        <div className="cell">
          <Pill tone={healthTone(row.health)} title="上游运行时判定（channel.health），与配置是否启用无关">
            {HEALTH_LABEL[row.health]}
          </Pill>
          {row.cooldownCount > 0 ? <span className="text-sm text-secondary">错误/冷却计数 {row.cooldownCount}</span> : null}
          {row.providerUsage.supported ? (
            <Pill mono title="上游 providerUsage.status">
              usage {row.providerUsage.status}
              {row.providerUsage.stale ? '（已过期）' : ''}
            </Pill>
          ) : null}
        </div>
      ),
    },
    {
      title: '模型 / 并发',
      key: 'models',
      width: 150,
      render: (_, row) => (
        <div className="cell">
          <span className="text-sm">模型 {countText(row.modelCount)}</span>
          <span className="text-sm text-secondary">maxConcurrent {countText(row.maxConcurrent)}</span>
        </div>
      ),
    },
    {
      title: '最近成功率（上游原值）',
      key: 'recentSuccessRate',
      width: 170,
      align: 'right',
      render: (_, row) => rawNumberText(row.recentSuccessRate),
    },
    {
      title: '操作',
      key: 'actions',
      width: 110,
      render: (_, row) => (
        <button
          type="button"
          className="btn btn--sm btn--secondary"
          aria-label={`查看渠道 ${row.name} 详情`}
          onClick={(event) => {
            event.stopPropagation();
            setActiveChannelId(row.id);
          }}
        >
          详情
        </button>
      ),
    },
  ];

  return (
    <div className="stack">
      {!canWrite ? (
        <div className="notice-box notice-box--warning" role="status">
          当前会话不具备写能力（{writeBlockReason ?? '只读'}）：新增、编辑、启停、删除等写操作按钮已禁用，只保留读取与详情查看。
          上游仍会再次校验实际权限，隐藏/禁用按钮只是界面体验。
        </div>
      ) : null}

      <div className="keeper-card keeper-card--flush">
        <div className="keeper-card__header">
          <div className="keeper-card__heading">
            <h2 className="keeper-card__title">第三方 API 渠道</h2>
            <p className="keeper-card__subtitle">
              列表与筛选参数取自上游生成类型（page / pageSize / search / enabled / protocol / providerId / health）；
              「配置状态」与「运行时状态」是两个不同维度。
            </p>
          </div>
          <div className="page-toolbar__actions">
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={!canWrite}
              title={canWrite ? undefined : writeBlockReason ?? '当前会话不可写'}
              onClick={() => setCreateOpen(true)}
            >
              新增渠道
            </button>
          </div>
        </div>

        <div className="keeper-card__body stack">
          <div className="filters">
            <label className="field">
              <span className="field__label">搜索（上游参数 search）</span>
              <Input
                value={form.search}
                allowClear
                placeholder="渠道名称或地址关键字"
                aria-label="搜索渠道"
                onChange={(event) => setForm((previous) => ({ ...previous, search: event.target.value }))}
                onPressEnter={applyFilters}
              />
            </label>

            <label className="field">
              <span className="field__label">配置状态（上游参数 enabled）</span>
              <Select
                value={form.enabled === null ? undefined : form.enabled ? 'enabled' : 'disabled'}
                allowClear
                placeholder="全部"
                aria-label="按配置状态筛选"
                options={ENABLED_OPTIONS}
                onChange={(value?: string) =>
                  setForm((previous) => ({
                    ...previous,
                    enabled: value === undefined ? null : value === 'enabled',
                  }))
                }
              />
            </label>

            <label className="field">
              <span className="field__label">协议（上游参数 protocol）</span>
              <Select
                value={form.protocol ?? undefined}
                allowClear
                placeholder="全部"
                aria-label="按协议筛选"
                options={protocolOptions}
                onChange={(value?: ChannelProtocol) => setForm((previous) => ({ ...previous, protocol: value ?? null }))}
              />
            </label>

            <label className="field">
              <span className="field__label">供应商（上游参数 providerId）</span>
              <Select
                value={form.providerId ?? undefined}
                allowClear
                showSearch
                placeholder={providerOptions.length ? '全部' : '目录未提供供应商'}
                disabled={!providerOptions.length}
                aria-label="按供应商筛选"
                options={providerOptions}
                onChange={(value?: string) => setForm((previous) => ({ ...previous, providerId: value ?? null }))}
              />
              {catalog.error ? <span className="field__hint">供应商目录读取失败（{catalog.error.code}）</span> : null}
            </label>

            <label className="field">
              <span className="field__label">运行时健康（上游参数 health）</span>
              <Select
                value={form.health ?? undefined}
                allowClear
                placeholder="全部"
                aria-label="按运行时健康筛选"
                options={HEALTH_OPTIONS}
                onChange={(value?: ChannelHealth) => setForm((previous) => ({ ...previous, health: value ?? null }))}
              />
            </label>
          </div>

          <div className="page-toolbar">
            <div className="page-toolbar__actions">
              <button type="button" className="btn btn--sm btn--secondary" onClick={applyFilters}>
                查询
              </button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={resetFilters}>
                重置筛选
              </button>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                disabled={list.isFetching}
                onClick={() => void list.refetch()}
              >
                {list.isFetching ? '刷新中…' : '刷新列表'}
              </button>
            </div>
            <span className="text-sm text-secondary">
              {meta.total === null ? '总数未知（上游 meta 未提供 total）' : `上游 meta.total=${meta.total}`}
              {meta.hasNext === null ? '' : `，hasNext=${String(meta.hasNext)}`}
              {`，最近一次成功读取：`}
              <RelativeTime value={list.dataUpdatedAt ? new Date(list.dataUpdatedAt).toISOString() : null} />
            </span>
          </div>

          <div className={styles.noticeArea}>
            {pageNotice ? <ChannelNoticeBox notice={pageNotice} /> : null}
            {actionError ? (
              <ErrorNotice
                error={actionError}
                onResolveConflict={
                  actionError.code === UPSTREAM_CODE.REVISION_CONFLICT
                    ? () => {
                        setActionError(null);
                        void list.refetch();
                      }
                    : undefined
                }
              />
            ) : null}
            {rawSyncResult ? <JsonBlock value={rawSyncResult} maxHeight={200} /> : null}
          </div>

          <div className="page-toolbar">
            <span className="text-sm text-secondary">
              以下批量操作作用于<strong>全部渠道</strong>：上游的 /channels/actions/* 不接受渠道列表参数，
              因此本页不提供"仅对选中项生效"的假批量。
            </span>
            <div className="page-toolbar__actions">
              <DangerConfirmButton
                label="清除全部渠道错误"
                className="btn btn--sm btn--secondary"
                confirmLabel="确认清除全部渠道错误"
                resourceName="全部渠道"
                disabled={!canWrite}
                pending={clearAllErrors.isPending}
                onConfirm={() => runBatchAction('清除全部渠道错误', () => clearAllErrors.mutateAsync())}
                impact={
                  <>
                    作用于<strong>全部渠道</strong>（上游 <span className="mono">POST /channels/actions/clear-errors</span>）：
                    不会删除渠道配置。上游未说明该动作是否同时重置其他运行时状态，WebUI 不做推测。
                  </>
                }
              />
              <DangerConfirmButton
                label="清除全部渠道客户端亲和"
                className="btn btn--sm btn--secondary"
                confirmLabel="确认清除全部渠道亲和"
                resourceName="全部渠道"
                disabled={!canWrite}
                pending={clearAllAffinity.isPending}
                onConfirm={() => runBatchAction('清除全部渠道客户端亲和', () => clearAllAffinity.mutateAsync())}
                impact={
                  <>
                    作用于<strong>全部渠道</strong>（上游 <span className="mono">POST /channels/actions/clear-affinity</span>）：
                    会清除客户端会话与渠道之间的亲和绑定，后续请求将重新选择渠道；不会删除渠道配置。
                  </>
                }
              />
            </div>
          </div>

          <AsyncState
            isLoading={list.isLoading}
            error={list.error}
            data={list.data}
            isEmpty={(response) => Array.isArray(response.data) && response.data.length === 0}
            emptyTitle="还没有渠道"
            emptyDescription={
              applied.search || applied.enabled !== null || applied.protocol || applied.providerId || applied.health
                ? '当前筛选条件下没有渠道。可以重置筛选后再看。'
                : '点击右上角「新增渠道」创建一个第三方 API 渠道。'
            }
            onRetry={() => void list.refetch()}
            isStale={list.isError && Boolean(list.data)}
            staleNotice="显示的是上一次成功读取的渠道列表，本次刷新失败。"
          >
            {(response) => {
              if (!response) {
                return <div className="error-box" role="alert">上游没有返回可解析的渠道列表响应，请刷新重试。</div>;
              }
              if (!Array.isArray(response.data)) {
                return (
                  <div className="stack">
                    <div className="error-box" role="alert">
                      上游返回的成功响应中 data 不是渠道数组，无法区分"空数据"与"响应异常"。原始响应如下：
                    </div>
                    <JsonBlock value={response.raw} />
                  </div>
                );
              }
              return (
                <Table<ChannelData>
                  rowKey={(row) => row.id}
                  size="middle"
                  columns={columns}
                  dataSource={response.data}
                  loading={list.isFetching && Boolean(response.data.length)}
                  scroll={{ x: 'max-content' }}
                  onRow={(row) => ({
                    className: styles.clickableRow,
                    tabIndex: 0,
                    role: 'button',
                    'aria-label': `打开渠道 ${row.name} 的详情`,
                    onClick: () => setActiveChannelId(row.id),
                    onKeyDown: (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setActiveChannelId(row.id);
                      }
                    },
                  })}
                  pagination={{
                    current: page,
                    pageSize,
                    total: meta.total ?? 0,
                    showSizeChanger: true,
                    pageSizeOptions: ['20', '50', '100'],
                    showTotal: (total) =>
                      meta.total === null
                        ? '总数未知（上游 meta 未提供 total）'
                        : `共 ${total} 条，每页 ${pageSize} 条`,
                    onChange: (nextPage, nextPageSize) => {
                      setPage(nextPage);
                      if (nextPageSize !== pageSize) setPageSize(nextPageSize);
                    },
                  }}
                />
              );
            }}
          </AsyncState>
        </div>
      </div>

      <ChannelDetailDrawer
        key={activeChannelId ?? 'channel-drawer-closed'}
        channelId={activeChannelId}
        canWrite={canWrite}
        writeBlockReason={writeBlockReason}
        onClose={() => setActiveChannelId(null)}
        onNotice={(notice) => setPageNotice(notice)}
        onDeleted={() => {
          setActiveChannelId(null);
          void list.refetch();
        }}
      />

      <CreateChannelModal
        open={createOpen}
        canWrite={canWrite}
        writeBlockReason={writeBlockReason}
        catalog={catalog.data?.data ?? null}
        catalogLoading={catalog.isLoading}
        catalogError={catalog.error}
        onRetryCatalog={() => void catalog.refetch()}
        onClose={() => setCreateOpen(false)}
        onCreated={(created) => {
          setCreateOpen(false);
          setPageNotice({
            tone: 'success',
            text: (
              <>
                渠道「{created.name}」已创建（HTTP 201）。可以立即在详情抽屉里做诊断/模型发现，或查看上方列表。
              </>
            ),
          });
          setActiveChannelId(created.id);
        }}
      />
    </div>
  );
}
