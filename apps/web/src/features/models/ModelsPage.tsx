/**
 * 模型中心（实施文档 6.6 + docs/frontend-contract.md）。
 *
 * 遵守的关键规则：
 * - 列表分页/筛选只用生成契约里真实存在的查询参数：page/pageSize（1 起）+ type/text/sourceType/sourceId/status。
 * - 详情路径参数使用服务端返回的 resourceKey 原样值；encodeSegment 只做单段编码，不解析、不拼接 resourceKey。
 * - 全局状态（scope.type='global'）与来源状态（scope.type='oauth'|'api' + id）分开操作，互不冒充。
 * - 批量提交明确目标状态（enabled/visible 三态），不做盲目 toggle；If-Match 用刚读到的 meta.revision 原值。
 * - 409 REVISION_CONFLICT 进入冲突处理（保留草稿 + 重新读取），不自动覆盖。
 * - 202 只登记 operation 任务，不立即提示成功。
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Drawer, Input, Radio, Select, Table, Tooltip, type TableProps } from 'antd';
import { DEFAULT_LIST_PAGE_SIZE, useApiMutation, useApiQuery, usePollingInterval } from '@/api/hooks';
import { encodeSegment, type ManagementResponse } from '@/api/client';
import { useOperations } from '@/api/operations';
import { AsyncState } from '@/components/state';
import { ErrorNotice } from '@/components/feedback';
import { CopyableText, JsonBlock, KeyValueList, MonoText, Pill } from '@/components/bits';
import { useWriteCapability } from '@/app/AuthProvider';
import type {
  ModelData,
  ModelFilterRequest,
  ModelKind,
  ModelSelectionRequest,
  ModelSourceData,
  ModelSourceRequest,
  ModelSourceType,
  ModelStateData,
  ModelStateRequest,
  ModelStateTargetRequest,
  ModelStatus,
} from '../../../../../packages/contracts/generated/upstream-mvp';
import styles from './ModelsPage.module.scss';

const MODEL_KIND_LABEL: Record<ModelKind, string> = { chat: '对话', image: '图像', video: '视频' };
const MODEL_SOURCE_LABEL: Record<ModelSourceType, string> = {
  global: '全局',
  oauth: 'OAuth 账号',
  api: 'API 渠道',
};

type EnabledAction = 'unchanged' | 'enabled' | 'disabled';
type VisibleAction = 'unchanged' | 'visible' | 'hidden';

interface StateActionInput {
  body: ModelStateRequest;
  ifMatch?: string | undefined;
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 202 只代表已受理：只有服务端真的给了 operationId 才登记任务。 */
function acceptedOperationId(response: ManagementResponse<unknown>): string | null {
  if (response.status !== 202) return null;
  const data = response.data;
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  if (typeof record.operationId === 'string') return record.operationId;
  const operation = record.operation;
  if (operation && typeof operation === 'object') {
    const id = (operation as Record<string, unknown>).id;
    if (typeof id === 'string') return id;
  }
  return null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function NullableFlag({
  value,
  trueLabel,
  falseLabel,
}: {
  value: boolean | null | undefined;
  trueLabel: string;
  falseLabel: string;
}) {
  if (value === true) return <Pill tone="success">{trueLabel}</Pill>;
  if (value === false) return <Pill tone="warning">{falseLabel}</Pill>;
  return (
    <Pill tone="muted" title="上游未提供该字段，未知不等于 false">
      未知
    </Pill>
  );
}

function NoticeBar({ tone, children }: { tone: 'info' | 'success' | 'warning'; children: ReactNode }) {
  const extra = tone === 'warning' ? 'notice-box--warning' : tone === 'success' ? styles.noticeSuccess : styles.noticeInfo;
  return (
    <div className={`notice-box ${extra}`} role="status">
      {children}
    </div>
  );
}

function valueSourceText(valueSource: Record<string, string>): string {
  const entries = Object.entries(valueSource);
  if (!entries.length) return '未提供';
  return entries.map(([field, source]) => `${field} ← ${source}`).join('；');
}

function constrainedByText(constrainedBy: Record<string, string[]>): string {
  const entries = Object.entries(constrainedBy);
  if (!entries.length) return '无约束';
  return entries.map(([field, values]) => `${field}: ${values.join(' / ')}`).join('；');
}

export function ModelsPage() {
  const { canWrite, reason: writeBlockedReason } = useWriteCapability();
  const { track } = useOperations();
  const listPollInterval = usePollingInterval(30_000);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_LIST_PAGE_SIZE);
  const [typeFilter, setTypeFilter] = useState<ModelKind | ''>('');
  const [text, setText] = useState('');
  const [sourceTypeFilter, setSourceTypeFilter] = useState<ModelSourceType | ''>('');
  const [sourceIdFilter, setSourceIdFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<ModelStatus | ''>('');

  // 批量操作草稿（提交成功后不清空，冲突时也保留）
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState<'ids' | 'filter'>('ids');
  const [filterConfirmed, setFilterConfirmed] = useState(false);
  const [scopeType, setScopeType] = useState<ModelSourceType>('global');
  const [scopeSourceId, setScopeSourceId] = useState('');
  const [enabledAction, setEnabledAction] = useState<EnabledAction>('unchanged');
  const [visibleAction, setVisibleAction] = useState<VisibleAction>('unchanged');
  const [panelNotice, setPanelNotice] = useState<{ tone: 'info' | 'success' | 'warning'; text: ReactNode } | null>(null);
  const [batchResult, setBatchResult] = useState<ModelStateData | null>(null);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [detailNotice, setDetailNotice] = useState<string | null>(null);

  const filters = useMemo(
    () => ({
      page,
      pageSize,
      type: typeFilter || undefined,
      text: text || undefined,
      sourceType: sourceTypeFilter || undefined,
      sourceId: sourceIdFilter || undefined,
      status: statusFilter || undefined,
    }),
    [page, pageSize, typeFilter, text, sourceTypeFilter, sourceIdFilter, statusFilter],
  );

  const list = useApiQuery<ModelData[]>({
    key: ['models', 'list', filters],
    path: '/models',
    query: filters,
    refetchInterval: listPollInterval,
  });

  const detail = useApiQuery<ModelData>({
    key: ['models', 'detail', detailKey],
    path: `/models/${encodeSegment(detailKey ?? '')}`,
    enabled: Boolean(detailKey),
    staleTimeMs: 2_000,
  });

  const batchMutation = useApiMutation<StateActionInput, ModelStateData>({
    method: 'PATCH',
    path: () => '/models/actions/state',
    body: (input) => input.body,
    ifMatch: (input) => input.ifMatch,
    invalidate: [['models']],
  });

  const singleMutation = useApiMutation<StateActionInput, ModelStateData>({
    method: 'PATCH',
    path: () => '/models/actions/state',
    body: (input) => input.body,
    ifMatch: (input) => input.ifMatch,
    invalidate: [['models']],
  });

  // 换页或换筛选条件后不能沿用旧的跨页选择：只允许“当前页已选”视为有效选择。
  useEffect(() => {
    setSelectedIds([]);
    setFilterConfirmed(false);
  }, [page, pageSize, typeFilter, text, sourceTypeFilter, sourceIdFilter, statusFilter]);

  useEffect(() => {
    setDetailNotice(null);
  }, [detailKey]);

  const listRevision = list.data?.revision ?? null;
  const totalItems = readNumber(list.data?.meta ?? {}, 'total');
  const detailData = detail.data?.data ?? null;
  const detailRevision = detail.data?.revision ?? detailData?.revision ?? null;

  const activeFilterCount =
    (typeFilter ? 1 : 0) + (text ? 1 : 0) + (sourceTypeFilter ? 1 : 0) + (sourceIdFilter ? 1 : 0) + (statusFilter ? 1 : 0);

  const buildScope = useCallback((): ModelSourceRequest | null => {
    if (scopeType === 'global') return { type: 'global' };
    const id = scopeSourceId.trim();
    if (!id) return null;
    return { type: scopeType, id };
  }, [scopeSourceId, scopeType]);

  const buildTarget = useCallback((): ModelStateTargetRequest | null => {
    const target: ModelStateTargetRequest = {};
    if (enabledAction !== 'unchanged') target.enabled = enabledAction === 'enabled';
    if (visibleAction !== 'unchanged') target.visible = visibleAction === 'visible';
    return Object.keys(target).length ? target : null;
  }, [enabledAction, visibleAction]);

  const buildSelection = useCallback((): ModelSelectionRequest | null => {
    if (selectionMode === 'ids') {
      if (!selectedIds.length) return null;
      return { mode: 'ids', modelIds: selectedIds };
    }
    if (!activeFilterCount || !filterConfirmed) return null;
    const filter: ModelFilterRequest = {};
    if (typeFilter) filter.type = [typeFilter];
    if (text) filter.text = text;
    if (sourceTypeFilter) filter.sourceType = sourceTypeFilter;
    if (sourceIdFilter) filter.sourceId = sourceIdFilter;
    if (statusFilter) filter.status = [statusFilter];
    return { mode: 'filter', filter };
  }, [
    activeFilterCount,
    filterConfirmed,
    selectedIds,
    selectionMode,
    sourceIdFilter,
    sourceTypeFilter,
    statusFilter,
    text,
    typeFilter,
  ]);

  const submitStateAction = async (input: StateActionInput, origin: string) => {
    const response = await batchMutation.mutateAsync(input);
    const operationId = acceptedOperationId(response);
    if (operationId) {
      track({ operationId, origin, invalidate: [['models']] });
      return { kind: 'accepted' as const, data: null, operationId };
    }
    return { kind: 'done' as const, data: response.data, operationId: null };
  };

  const handleBatchSubmit = async () => {
    const scope = buildScope();
    const target = buildTarget();
    const selection = buildSelection();
    if (!scope) {
      setPanelNotice({ tone: 'warning', text: '选择了来源范围时必须填写来源 ID；否则不知道该改哪一组来源状态。' });
      return;
    }
    if (!target) {
      setPanelNotice({ tone: 'warning', text: '请明确选择这次要提交的目标状态（启用/停用、可见/隐藏），WebUI 不做盲目切换。' });
      return;
    }
    if (!selection) {
      setPanelNotice({
        tone: 'warning',
        text:
          selectionMode === 'ids'
            ? '当前页没有选中任何模型。'
            : '“全部筛选结果”需要至少一个筛选条件，并勾选确认；没有任何条件时不会提交。',
      });
      return;
    }
    if (!listRevision) {
      setPanelNotice({ tone: 'warning', text: '尚未读到列表 meta.revision，缺少 If-Match 依据；请先刷新列表。' });
      return;
    }
    setPanelNotice(null);
    setBatchResult(null);
    try {
      const result = await submitStateAction(
        { body: { scope, selection, target }, ifMatch: listRevision },
        '模型批量状态修改',
      );
      if (result.kind === 'accepted') {
        setPanelNotice({
          tone: 'info',
          text: `上游已受理（202，任务 ${result.operationId}），尚未生效；进度请在任务面板查看。`,
        });
        return;
      }
      setBatchResult(result.data);
      setPanelNotice({ tone: 'success', text: '上游已返回 200，状态修改结果如下。' });
      setSelectedIds([]);
    } catch {
      // 错误统一交给 ErrorNotice（含 409 冲突处理与 429 等待时间）
      setBatchResult(null);
    }
  };

  const handleSingleAction = async (params: {
    scope: ModelSourceRequest;
    modelId: string;
    enabled: boolean;
    ifMatch: string;
    origin: string;
  }) => {
    setDetailNotice(null);
    try {
      const result = await submitSingleAction(params);
      if (result.kind === 'accepted') {
        setDetailNotice(`上游已受理（202，任务 ${result.operationId}），尚未生效；进度请在任务面板查看。`);
        return;
      }
      const items = result.data?.items ?? [];
      const updated = items.filter((item) => item.status === 'updated').length;
      const unchanged = items.filter((item) => item.status === 'unchanged').length;
      setDetailNotice(`提交完成：更新 ${updated} 项，未变化 ${unchanged} 项（未变化表示目标状态已生效）。`);
    } catch {
      // 错误在抽屉内以 ErrorNotice 展示
    }
  };

  const submitSingleAction = async (params: {
    scope: ModelSourceRequest;
    modelId: string;
    enabled: boolean;
    ifMatch: string;
    origin: string;
  }) => {
    const body: ModelStateRequest = {
      scope: params.scope,
      selection: { mode: 'ids', modelIds: [params.modelId] },
      target: { enabled: params.enabled },
    };
    const response = await singleMutation.mutateAsync({ body, ifMatch: params.ifMatch });
    const operationId = acceptedOperationId(response);
    if (operationId) {
      track({ operationId, origin: params.origin, invalidate: [['models']] });
      return { kind: 'accepted' as const, data: null as ModelStateData | null, operationId };
    }
    return { kind: 'done' as const, data: response.data, operationId: null };
  };

  const reloadAfterConflict = () => {
    batchMutation.reset();
    singleMutation.reset();
    void list.refetch();
    if (detailKey) void detail.refetch();
  };

  const batchSummary = useMemo(() => {
    const scopeLabel = scopeType === 'global' ? '全局' : `${MODEL_SOURCE_LABEL[scopeType]}（${scopeSourceId.trim() || '未填来源 ID'}）`;
    const parts: string[] = [];
    if (enabledAction !== 'unchanged') parts.push(enabledAction === 'enabled' ? '启用' : '停用');
    if (visibleAction !== 'unchanged') parts.push(visibleAction === 'visible' ? '设为可见' : '设为隐藏');
    const targetLabel = parts.length ? parts.join(' + ') : '未选择目标状态';
    const selectionLabel =
      selectionMode === 'ids'
        ? `当前页已选 ${selectedIds.length} 项`
        : `全部筛选结果（共 ${totalItems ?? '未知'} 项，服务端按筛选条件应用）`;
    return `${scopeLabel} · ${targetLabel} · ${selectionLabel}`;
  }, [enabledAction, scopeSourceId, scopeType, selectedIds.length, selectionMode, totalItems, visibleAction]);

  const canSubmitBatch =
    canWrite &&
    Boolean(listRevision) &&
    (enabledAction !== 'unchanged' || visibleAction !== 'unchanged') &&
    buildSelection() !== null &&
    !batchMutation.isPending;

  const listColumns: TableProps<ModelData>['columns'] = [
    {
      title: '模型',
      dataIndex: 'modelId',
      key: 'modelId',
      render: (_value, record) => (
        <div className="stack" style={{ gap: 2 }}>
          <MonoText truncate>{record.modelId}</MonoText>
          <span className="text-tertiary text-sm">
            {record.identity.provider ? `供应商：${record.identity.provider}` : '供应商未知'}
            {record.identity.owner ? ` · 归属：${MODEL_SOURCE_LABEL[record.identity.owner.type]}` : ''}
          </span>
        </div>
      ),
    },
    {
      title: '类型',
      dataIndex: ['identity', 'type'],
      key: 'type',
      render: (_value, record) => <Pill tone="primary">{MODEL_KIND_LABEL[record.identity.type]}</Pill>,
    },
    {
      title: '来源数',
      dataIndex: 'sourceCount',
      key: 'sourceCount',
      render: (value: number) => <MonoText>{String(value)}</MonoText>,
    },
    {
      title: '全局启用',
      dataIndex: 'globalEnabled',
      key: 'globalEnabled',
      render: (_value, record) => (
        <NullableFlag value={record.globalEnabled} trueLabel="全局启用" falseLabel="全局停用" />
      ),
    },
    {
      title: '可见性',
      dataIndex: 'visible',
      key: 'visible',
      render: (_value, record) => (
        <Tooltip title="隐藏只影响发现（列表/发现流程），不等于不能显式调用">
          <span>
            <NullableFlag value={record.visible} trueLabel="可见" falseLabel="隐藏" />
          </span>
        </Tooltip>
      ),
    },
    {
      title: '来源生效概况',
      key: 'sources',
      render: (_value, record) => {
        if (!record.sources) return <span className="text-tertiary text-sm">列表未返回来源明细，请查看详情</span>;
        const routable = record.sources.filter((source) => source.effectiveRoutable).length;
        return (
          <span className="text-sm">
            可路由 {routable} / {record.sources.length}
          </span>
        );
      },
    },
    {
      title: '别名',
      dataIndex: 'aliases',
      key: 'aliases',
      render: (value: string[] | undefined) => <MonoText truncate>{stringList(value).join(', ') || '无'}</MonoText>,
    },
    {
      title: '操作',
      key: 'actions',
      render: (_value, record) => (
        <button type="button" className="btn btn--sm btn--secondary" onClick={() => setDetailKey(record.resourceKey)}>
          查看详情
        </button>
      ),
    },
  ];

  const sourceColumns: TableProps<ModelSourceData>['columns'] = [
    {
      title: '来源',
      key: 'source',
      render: (_value, record) => (
        <div className="stack" style={{ gap: 2 }}>
          <span>{record.label || record.id}</span>
          <span className="text-tertiary text-sm">
            {MODEL_SOURCE_LABEL[record.type]} · id：{record.id} · 供应商：{record.provider || '未知'}
          </span>
        </div>
      ),
    },
    {
      title: '出站模型',
      dataIndex: 'outboundModel',
      key: 'outboundModel',
      render: (value: string) => <MonoText truncate>{value || '未知'}</MonoText>,
    },
    {
      title: '来源启用',
      dataIndex: 'sourceEnabled',
      key: 'sourceEnabled',
      render: (value: boolean) => <NullableFlag value={value} trueLabel="已启用" falseLabel="已停用" />,
    },
    {
      title: '容器启用',
      dataIndex: 'containerEnabled',
      key: 'containerEnabled',
      render: (value: boolean) => <NullableFlag value={value} trueLabel="容器级启用" falseLabel="容器级停用" />,
    },
    {
      title: '生效可路由',
      dataIndex: 'effectiveRoutable',
      key: 'effectiveRoutable',
      render: (value: boolean) => <NullableFlag value={value} trueLabel="可路由" falseLabel="当前不可路由" />,
    },
    {
      title: '不可用原因',
      dataIndex: 'unavailableReason',
      key: 'unavailableReason',
      render: (value: string | null | undefined) =>
        value ? <span className="text-sm">{value}</span> : <span className="text-tertiary text-sm">无</span>,
    },
    {
      title: '取值来源',
      dataIndex: 'valueSource',
      key: 'valueSource',
      render: (value: Record<string, string>) => <span className="text-sm">{valueSourceText(value ?? {})}</span>,
    },
    {
      title: '该来源操作',
      key: 'actions',
      render: (_value, record) => {
        const sourceScope: ModelSourceRequest =
          record.type === 'global' ? { type: 'global' } : { type: record.type, id: record.id };
        const disabled = !canWrite || !detailRevision || !detailData || singleMutation.isPending;
        return (
          <div className="row" style={{ gap: 6 }}>
            <button
              type="button"
              className="btn btn--sm btn--secondary"
              disabled={disabled}
              aria-label={`在该来源启用 ${record.label || record.id}`}
              onClick={() =>
                void handleSingleAction({
                  scope: sourceScope,
                  modelId: detailData?.modelId ?? '',
                  enabled: true,
                  ifMatch: detailRevision ?? '',
                  origin: `模型来源启用（${record.label || record.id}）`,
                })
              }
            >
              启用
            </button>
            <button
              type="button"
              className="btn btn--sm btn--danger"
              disabled={disabled}
              aria-label={`在该来源停用 ${record.label || record.id}`}
              onClick={() =>
                void handleSingleAction({
                  scope: sourceScope,
                  modelId: detailData?.modelId ?? '',
                  enabled: false,
                  ifMatch: detailRevision ?? '',
                  origin: `模型来源停用（${record.label || record.id}）`,
                })
              }
            >
              停用
            </button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="stack">
      <section className="keeper-card">
        <header className="keeper-card__header">
          <div className="keeper-card__heading">
            <h1 className="keeper-card__title">模型中心</h1>
            <p className="keeper-card__subtitle">
              筛选条件与分页只使用上游真实支持的参数；<code>enabled</code> 与 <code>visible</code> 分开处理，隐藏只影响发现。
            </p>
          </div>
          <span className="text-tertiary text-sm">
            共 {totalItems ?? '未知'} 个模型（服务端计数）· 服务端 revision：
            {listRevision ? <MonoText>{listRevision}</MonoText> : ' 未知'}
          </span>
        </header>
        <div className="keeper-card__body stack">
          <div className="filters">
            <label className="field">
              <span className="field__label">类型</span>
              <Select<ModelKind | ''>
                value={typeFilter}
                onChange={(value) => {
                  setTypeFilter(value ?? '');
                  setPage(1);
                }}
                allowClear
                placeholder="全部类型"
                aria-label="按模型类型筛选"
                options={[
                  { value: '', label: '全部类型' },
                  { value: 'chat', label: '对话' },
                  { value: 'image', label: '图像' },
                  { value: 'video', label: '视频' },
                ]}
              />
            </label>
            <label className="field">
              <span className="field__label">查询词</span>
              <Input.Search
                defaultValue={text}
                allowClear
                placeholder="模型 ID / 别名"
                aria-label="按模型 ID 或别名查询"
                onSearch={(value) => {
                  setText(value.trim());
                  setPage(1);
                }}
              />
            </label>
            <label className="field">
              <span className="field__label">来源类型</span>
              <Select<ModelSourceType | ''>
                value={sourceTypeFilter}
                onChange={(value) => {
                  setSourceTypeFilter(value ?? '');
                  setPage(1);
                }}
                allowClear
                placeholder="全部来源"
                aria-label="按来源类型筛选"
                options={[
                  { value: '', label: '全部来源' },
                  { value: 'global', label: '全局' },
                  { value: 'oauth', label: 'OAuth 账号' },
                  { value: 'api', label: 'API 渠道' },
                ]}
              />
            </label>
            <label className="field">
              <span className="field__label">来源 ID</span>
              <Input.Search
                defaultValue={sourceIdFilter}
                allowClear
                placeholder="需与来源类型配合"
                aria-label="按来源 ID 筛选"
                onSearch={(value) => {
                  setSourceIdFilter(value.trim());
                  setPage(1);
                }}
              />
            </label>
            <label className="field">
              <span className="field__label">状态</span>
              <Select<ModelStatus | ''>
                value={statusFilter}
                onChange={(value) => {
                  setStatusFilter(value ?? '');
                  setPage(1);
                }}
                allowClear
                placeholder="全部状态"
                aria-label="按模型状态筛选"
                options={[
                  { value: '', label: '全部状态' },
                  { value: 'enabled', label: '已启用' },
                  { value: 'disabled', label: '已停用' },
                  { value: 'visible', label: '可见' },
                  { value: 'hidden', label: '隐藏' },
                ]}
              />
            </label>
          </div>
          <span className="field__hint">
            上游 status 取值：enabled / disabled / visible / hidden；筛选参数会原样传给服务端，不做本地猜测。
          </span>
        </div>
      </section>

      <section className="keeper-card">
        <header className="keeper-card__header">
          <div className="keeper-card__heading">
            <h2 className="keeper-card__title">模型列表</h2>
            <p className="keeper-card__subtitle">
              选择只对当前页有效；跨页批量请使用下方“全部筛选结果”并确认筛选条件。
            </p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <span className="pill pill--mono">当前页已选 {selectedIds.length} 项</span>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => void list.refetch()}
              aria-label="刷新模型列表"
            >
              刷新
            </button>
          </div>
        </header>
        <div className="keeper-card__body">
          <AsyncState<ModelData[]>
            isLoading={list.isLoading}
            error={list.error}
            data={list.data?.data ?? undefined}
            isEmpty={(items) => items.length === 0}
            emptyTitle="没有匹配的模型"
            emptyDescription="调整筛选条件，或确认上游是否已具备可用模型来源。"
            onRetry={() => void list.refetch()}
            isStale={list.isError && Boolean(list.data)}
          >
            {(items) => (
              <Table<ModelData>
                rowKey={(record) => record.modelId}
                columns={listColumns}
                dataSource={items}
                size="middle"
                scroll={{ x: 'max-content' }}
                rowSelection={{
                  selectedRowKeys: selectedIds,
                  preserveSelectedRowKeys: false,
                  onChange: (keys) => setSelectedIds(keys.map((key) => String(key))),
                }}
                pagination={{
                  current: page,
                  pageSize,
                  total: totalItems ?? items.length,
                  showSizeChanger: true,
                  pageSizeOptions: ['20', '50', '100'],
                  showTotal: (total, range) => `${range[0]}-${range[1]} / 共 ${total} 项（服务端计数）`,
                  onChange: (nextPage, nextPageSize) => {
                    setPage(nextPage);
                    if (nextPageSize && nextPageSize !== pageSize) setPageSize(nextPageSize);
                  },
                }}
                onRow={(record) => ({
                  onDoubleClick: () => setDetailKey(record.resourceKey),
                })}
              />
            )}
          </AsyncState>
        </div>
      </section>

      <section className="keeper-card">
        <header className="keeper-card__header">
          <div className="keeper-card__heading">
            <h2 className="keeper-card__title">批量状态修改</h2>
            <p className="keeper-card__subtitle">
              接口 PATCH /models/actions/state，必须带 If-Match（读到的 meta.revision 原值）。提交的是明确目标状态，不是 toggle。
            </p>
          </div>
        </header>
        <div className="keeper-card__body stack">
          {!canWrite ? (
            <NoticeBar tone="warning">
              当前会话只具备只读能力（{writeBlockedReason ?? '未授予写能力'}），已禁用批量状态修改；登录状态不受影响。
            </NoticeBar>
          ) : null}
          {batchMutation.error ? (
            <ErrorNotice error={batchMutation.error} onResolveConflict={reloadAfterConflict} />
          ) : null}
          {panelNotice ? <NoticeBar tone={panelNotice.tone}>{panelNotice.text}</NoticeBar> : null}

          <div className={styles.batchGrid}>
            <div className="field">
              <span className="field__label">1. 作用范围（全局与来源分开操作）</span>
              <Radio.Group
                value={scopeType}
                onChange={(event) => setScopeType(event.target.value as ModelSourceType)}
                aria-label="选择作用范围"
              >
                <Radio.Button value="global">全局状态</Radio.Button>
                <Radio.Button value="oauth">某 OAuth 账号来源</Radio.Button>
                <Radio.Button value="api">某 API 渠道来源</Radio.Button>
              </Radio.Group>
              {scopeType === 'global' ? (
                <span className="field__hint">只改全局状态；各来源自己的开关不会被连带修改（详情里按来源单独操作）。</span>
              ) : (
                <span className="field__hint">必须填写来源 ID；只改该来源的状态，不会冒充全局状态。</span>
              )}
              {scopeType !== 'global' ? (
                <label className="field">
                  <span className="field__label">来源 ID</span>
                  <Input
                    value={scopeSourceId}
                    onChange={(event) => setScopeSourceId(event.target.value)}
                    placeholder="OAuth 账号 ID 或渠道 ID"
                    aria-label="批量操作的来源 ID"
                  />
                </label>
              ) : null}
            </div>

            <div className="field">
              <span className="field__label">2. 目标状态</span>
              <Radio.Group
                value={enabledAction}
                onChange={(event) => setEnabledAction(event.target.value as EnabledAction)}
                aria-label="选择目标启用状态"
              >
                <Radio.Button value="unchanged">不修改启用状态</Radio.Button>
                <Radio.Button value="enabled">设为启用</Radio.Button>
                <Radio.Button value="disabled">设为停用</Radio.Button>
              </Radio.Group>
              <Radio.Group
                value={visibleAction}
                onChange={(event) => setVisibleAction(event.target.value as VisibleAction)}
                aria-label="选择目标可见性"
              >
                <Radio.Button value="unchanged">不修改可见性</Radio.Button>
                <Radio.Button value="visible">设为可见</Radio.Button>
                <Radio.Button value="hidden">设为隐藏</Radio.Button>
              </Radio.Group>
              <span className="field__hint">
                至少选择一项目标状态。<code>visible=false</code> 只影响发现流程，不表示该模型不能被显式调用。
              </span>
            </div>

            <div className="field">
              <span className="field__label">3. 选择范围</span>
              <Radio.Group
                value={selectionMode}
                onChange={(event) => {
                  setSelectionMode(event.target.value as 'ids' | 'filter');
                  setFilterConfirmed(false);
                }}
                aria-label="选择批量作用对象"
              >
                <Radio.Button value="ids">当前页已选（{selectedIds.length} 项）</Radio.Button>
                <Radio.Button value="filter">全部筛选结果</Radio.Button>
              </Radio.Group>
              {selectionMode === 'ids' ? (
                <span className="field__hint">只提交表格中勾选的模型（仅当前页）；翻页后勾选会被清空，不会假装跨页全选。</span>
              ) : (
                <div className="stack" style={{ gap: 6 }}>
                  <span className="field__hint">
                    服务端按当前筛选条件（{activeFilterCount} 个条件）应用，不受分页限制；当前筛选结果共{' '}
                    {totalItems ?? '未知'} 项。
                  </span>
                  {activeFilterCount === 0 ? (
                    <span className="text-danger text-sm">没有任何筛选条件时不允许提交，避免误改全部模型。</span>
                  ) : null}
                  <label className="row" style={{ gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={filterConfirmed}
                      onChange={(event) => setFilterConfirmed(event.target.checked)}
                      aria-label="确认对全部筛选结果应用"
                    />
                    <span className="text-sm">我确认对全部筛选结果应用上述目标状态</span>
                  </label>
                </div>
              )}
            </div>
          </div>

          <div className="row row--between">
            <span className="text-secondary text-sm">将提交：{batchSummary}</span>
            <div className="row" style={{ gap: 8 }}>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() => void list.refetch()}
                aria-label="重新读取列表与 revision"
              >
                重新读取 revision
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={!canSubmitBatch}
                onClick={() => void handleBatchSubmit()}
              >
                {batchMutation.isPending ? '提交中…' : '提交目标状态'}
              </button>
            </div>
          </div>

          {batchResult ? (
            <div className="stack" style={{ gap: 6 }}>
              <span className="text-sm">
                更新 {batchResult.items.filter((item) => item.status === 'updated').length} 项，未变化{' '}
                {batchResult.items.filter((item) => item.status === 'unchanged').length} 项（未变化表示目标状态已生效）。
              </span>
              <span className="text-sm">
                服务端返回的新 revision：<MonoText>{batchResult.revision}</MonoText>
              </span>
              <JsonBlock value={batchResult.items} maxHeight={180} />
            </div>
          ) : null}
        </div>
      </section>

      <Drawer
        open={Boolean(detailKey)}
        onClose={() => setDetailKey(null)}
        width="min(820px, 100vw)"
        title="模型详情"
        destroyOnHidden
      >
        <div className="stack">
          <AsyncState<ModelData>
            isLoading={detail.isLoading}
            error={detail.error}
            data={detailData ?? undefined}
            isEmpty={() => false}
            onRetry={() => void detail.refetch()}
            isStale={detail.isError && Boolean(detail.data)}
          >
            {(model) => (
              <div className="stack">
                {!canWrite ? (
                  <NoticeBar tone="warning">
                    当前会话只具备只读能力（{writeBlockedReason ?? '未授予写能力'}），状态修改按钮已禁用。
                  </NoticeBar>
                ) : null}
                {!detailRevision ? (
                  <NoticeBar tone="warning">未读到该模型的 revision，无法安全提交状态修改；请重新读取详情。</NoticeBar>
                ) : null}
                {singleMutation.error ? (
                  <ErrorNotice error={singleMutation.error} onResolveConflict={reloadAfterConflict} />
                ) : null}
                {detailNotice ? <NoticeBar tone="info">{detailNotice}</NoticeBar> : null}

                <KeyValueList
                  columns={2}
                  items={[
                    { label: '模型 ID', value: <MonoText>{model.modelId}</MonoText> },
                    {
                      label: '身份 modelId',
                      value: <MonoText>{model.identity.modelId}</MonoText>,
                      hint: model.identity.modelId === model.modelId ? '与模型 ID 一致' : '与模型 ID 不同，上游原样返回',
                    },
                    { label: '类型', value: <Pill tone="primary">{MODEL_KIND_LABEL[model.identity.type]}</Pill> },
                    { label: '供应商', value: model.identity.provider ?? <span className="text-tertiary">未知</span> },
                    {
                      label: '归属',
                      value: model.identity.owner
                        ? `${MODEL_SOURCE_LABEL[model.identity.owner.type]}${model.identity.owner.id ? `（${model.identity.owner.id}）` : ''}`
                        : <span className="text-tertiary">未知</span>,
                    },
                    { label: 'resourceKey（原样使用）', value: <CopyableText value={model.resourceKey} /> },
                    {
                      label: 'revision',
                      value: <MonoText>{model.revision}</MonoText>,
                      hint: '写操作时原样回传为 If-Match',
                    },
                    {
                      label: '可编辑',
                      value: model.editable ? <Pill tone="success">可编辑</Pill> : <Pill tone="muted">上游标记不可编辑</Pill>,
                    },
                    { label: '来源数量', value: <MonoText>{String(model.sourceCount)}</MonoText> },
                    { label: '别名', value: <MonoText truncate>{stringList(model.aliases).join(', ') || '无'}</MonoText> },
                  ]}
                />

                <section className="keeper-card keeper-card--flush">
                  <header className="keeper-card__header">
                    <div className="keeper-card__heading">
                      <h3 className="keeper-card__title">全局状态</h3>
                      <p className="keeper-card__subtitle">
                        来自服务端 globalEnabled / visible；未知表示上游未提供，不当作 false。
                      </p>
                    </div>
                  </header>
                  <div className="keeper-card__body stack">
                    <div className="row" style={{ gap: 12 }}>
                      <span className="field">
                        <span className="field__label">全局启用</span>
                        <NullableFlag value={model.globalEnabled} trueLabel="全局启用" falseLabel="全局停用" />
                      </span>
                      <span className="field">
                        <span className="field__label">可见性</span>
                        <NullableFlag value={model.visible} trueLabel="可见" falseLabel="隐藏" />
                      </span>
                    </div>
                    <span className="field__hint">
                      隐藏（visible=false）只影响发现流程，不等于不能显式调用；可用性请以上面各来源的“生效可路由”为准。
                    </span>
                    <div className="row" style={{ gap: 8 }}>
                      <button
                        type="button"
                        className="btn btn--sm btn--secondary"
                        disabled={!canWrite || !detailRevision || singleMutation.isPending}
                        onClick={() =>
                          void handleSingleAction({
                            scope: { type: 'global' },
                            modelId: model.modelId,
                            enabled: true,
                            ifMatch: detailRevision ?? '',
                            origin: '模型全局启用',
                          })
                        }
                      >
                        全局启用
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm btn--danger"
                        disabled={!canWrite || !detailRevision || singleMutation.isPending}
                        onClick={() =>
                          void handleSingleAction({
                            scope: { type: 'global' },
                            modelId: model.modelId,
                            enabled: false,
                            ifMatch: detailRevision ?? '',
                            origin: '模型全局停用',
                          })
                        }
                      >
                        全局停用
                      </button>
                    </div>
                  </div>
                </section>

                <section className="keeper-card keeper-card--flush">
                  <header className="keeper-card__header">
                    <div className="keeper-card__heading">
                      <h3 className="keeper-card__title">各来源及生效状态</h3>
                      <p className="keeper-card__subtitle">
                        每个来源的状态互相独立，仅代表该来源；不拿其中一个来源冒充全局状态。
                      </p>
                    </div>
                  </header>
                  <div className="keeper-card__body">
                    <Table<ModelSourceData>
                      rowKey={(record) => `${record.type}:${record.id}`}
                      columns={sourceColumns}
                      dataSource={model.sources ?? []}
                      size="small"
                      scroll={{ x: 'max-content' }}
                      pagination={false}
                      locale={{ emptyText: '上游未返回来源明细' }}
                      expandable={{
                        expandedRowRender: (record) => (
                          <div className="stack" style={{ gap: 8 }}>
                            <span className="field__label">约束条件 constrainedBy</span>
                            <span className="text-sm">{constrainedByText(record.constrainedBy ?? {})}</span>
                            <span className="field__label">生效元数据 effectiveMetadata</span>
                            <JsonBlock value={record.effectiveMetadata ?? {}} maxHeight={200} />
                          </div>
                        ),
                      }}
                    />
                  </div>
                </section>

                {model.commonMetadata ? (
                  <section className="keeper-card keeper-card--flush">
                    <header className="keeper-card__header">
                      <div className="keeper-card__heading">
                        <h3 className="keeper-card__title">commonMetadata</h3>
                        <p className="keeper-card__subtitle">上游原样内容，按纯文本渲染，高级覆盖编辑属于第二阶段。</p>
                      </div>
                    </header>
                    <div className="keeper-card__body">
                      <JsonBlock value={model.commonMetadata} />
                    </div>
                  </section>
                ) : null}
              </div>
            )}
          </AsyncState>
        </div>
      </Drawer>
    </div>
  );
}
