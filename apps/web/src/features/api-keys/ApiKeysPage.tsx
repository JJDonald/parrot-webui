/**
 * 下游 API Key（实施文档 6.7 + docs/frontend-contract.md）。
 *
 * 只使用允许清单内的接口：
 *   GET/POST /api-keys、GET/PATCH/DELETE /api-keys/{keyId}、
 *   PUT /api-keys/{keyId}/secret、POST /api-keys/{keyId}/actions/reset-limiter、
 *   GET /api-keys/{keyId}/stats、POST /api-keys/{keyId}/actions/generate-replacement-plan。
 * `actions/generate-replacement`（真正执行替换）不在允许清单内：本页面只生成计划，不调用、不显示。
 *
 * 秘密值规则：
 * - 列表与详情只展示上游返回的掩码（maskedHint），完整秘密值不会从读取接口返回。
 * - 只有创建 / 重置接口返回的秘密值会在当前视图内存中展示（SecretReveal + 复制），关闭即丢弃；
 *   不写 localStorage/sessionStorage、不进 URL、不进日志。
 *
 * 额度语义：0 / null / 未提供 按 schema 区分；未知额度不显示成 0，也不显示成无限。
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Table,
  Tabs,
  Tooltip,
  type TableProps,
} from 'antd';
import { DEFAULT_LIST_PAGE_SIZE, useApiMutation, useApiQuery, usePollingInterval } from '@/api/hooks';
import { encodeSegment, type ManagementResponse } from '@/api/client';
import { useOperations } from '@/api/operations';
import { AsyncState } from '@/components/state';
import { ErrorNotice } from '@/components/feedback';
import {
  DangerConfirmButton,
  JsonBlock,
  KeyValueList,
  MonoText,
  Pill,
  SecretReveal,
  TimeText,
} from '@/components/bits';
import { useWriteCapability } from '@/app/AuthProvider';
import type {
  ApiKeyCreateRequest,
  ApiKeyData,
  ApiKeyEnabledFilter,
  ApiKeyLimitOverrideData,
  ApiKeyLimitOverridePatch,
  ApiKeyLimiterData,
  ApiKeyListData,
  ApiKeyProvenance,
  ApiKeyReplacementPlanData,
  ApiKeyReplaceSecretRequest,
  ApiKeySecretData,
  ApiKeySort,
  ApiKeyStatsData,
  ApiKeyUpdateRequest,
  ApiKeyUsageData,
} from '../../../../../packages/contracts/generated/upstream-mvp';
import styles from './ApiKeysPage.module.scss';

type Tri = 'keep' | 'true' | 'false';
type McpTool = 'web_search' | 'web_fetch' | 'image_generate' | 'image_edit' | 'video_generate' | 'video_status';

const MCP_TOOLS: McpTool[] = [
  'web_search',
  'web_fetch',
  'image_generate',
  'image_edit',
  'video_generate',
  'video_status',
];

const MCP_TOOL_LABEL: Record<McpTool, string> = {
  web_search: '网页搜索',
  web_fetch: '网页抓取',
  image_generate: '图像生成',
  image_edit: '图像编辑',
  video_generate: '视频生成',
  video_status: '视频状态',
};

const PROVENANCE_LABEL: Record<ApiKeyProvenance, string> = {
  generated: '上游生成',
  custom: '自定义',
  unknown: '未知来源',
};

const SORT_LABEL: Record<ApiKeySort, string> = {
  orderAsc: '按顺序（升序）',
  orderDesc: '按顺序（降序）',
  nameAsc: '按名称（升序）',
  nameDesc: '按名称（降序）',
  monthCallsDesc: '按本月调用量（降序）',
};

const TRI_OPTIONS: Array<{ value: Tri; label: string }> = [
  { value: 'keep', label: '不修改' },
  { value: 'true', label: '是' },
  { value: 'false', label: '否' },
];

const ENABLED_TRI_OPTIONS: Array<{ value: Tri; label: string }> = [
  { value: 'keep', label: '不修改' },
  { value: 'true', label: '设为启用' },
  { value: 'false', label: '设为停用' },
];

interface EditFormValues {
  enabled: Tri;
  allowImages: Tri;
  allowVideos: Tri;
  allowMcp: Tri;
  allowedModels: string[];
  mcpTools: McpTool[];
  overrideEnabled: Tri;
  maxConcurrent: number | null;
  maxQueue: number | null;
  queueWaitSeconds: number | null;
}

interface CreateFormValues {
  name: string;
  mode: 'generated' | 'custom';
  customSecret?: string;
}

interface RevealedSecret {
  keyId: string;
  name: string;
  secret: string;
  context: 'created' | 'replaced';
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

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function mcpToolsOf(value: ApiKeyData['mcpTools']): McpTool[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown as string[]).filter((item): item is McpTool =>
    (MCP_TOOLS as readonly string[]).includes(item),
  );
}

/** 未知额度：null / undefined 表示上游未提供，绝不能显示成 0 或无限。 */
function OptionalNumber({ value, suffix }: { value: number | null | undefined; suffix?: string }) {
  if (value === null || value === undefined) return <span className="text-tertiary">未提供（未知）</span>;
  return <MonoText>{suffix ? `${value}${suffix}` : String(value)}</MonoText>;
}

function TriValue({
  value,
  trueLabel,
  falseLabel,
  inheritLabel = '未覆盖（跟随全局）',
}: {
  value: boolean | null | undefined;
  trueLabel: string;
  falseLabel: string;
  inheritLabel?: string;
}) {
  if (value === true) return <Pill tone="success">{trueLabel}</Pill>;
  if (value === false) return <Pill tone="warning">{falseLabel}</Pill>;
  if (value === null) return <Pill tone="muted">已显式清除（null：{inheritLabel}）</Pill>;
  return <Pill tone="muted">未提供（{inheritLabel}）</Pill>;
}

function sourceLabel(source: 'key' | 'global'): string {
  return source === 'key' ? 'Key 覆盖' : '全局默认';
}

function limiterValue(limiter: ApiKeyLimiterData, field: 'maxConcurrent' | 'maxQueue' | 'queueWaitSeconds'): ReactNode {
  if (limiter.unlimited) {
    return (
      <Tooltip title="上游 limiter.unlimited=true，未设置上限">
        <span className={styles.limiterUnlimited}>不限制（上游标记 unlimited）</span>
      </Tooltip>
    );
  }
  const value = limiter[field];
  const source =
    field === 'maxConcurrent'
      ? limiter.maxConcurrentSource
      : field === 'maxQueue'
        ? limiter.maxQueueSource
        : limiter.queueWaitSource;
  const suffix = field === 'queueWaitSeconds' ? ' 秒' : '';
  return (
    <span className="row" style={{ gap: 6 }}>
      <MonoText>{`${value}${suffix}`}</MonoText>
      <span className="text-tertiary text-sm">来源：{sourceLabel(source)}</span>
    </span>
  );
}

function UsageList({ usage, columns = 3 }: { usage: ApiKeyUsageData; columns?: number }) {
  return (
    <KeyValueList
      columns={columns}
      items={[
        { label: '总请求', value: <MonoText>{String(usage.total)}</MonoText> },
        { label: '成功', value: <MonoText>{String(usage.successCount)}</MonoText> },
        { label: '失败', value: <MonoText>{String(usage.errorCount)}</MonoText> },
        { label: '输入 token', value: <MonoText>{String(usage.inputTokens)}</MonoText> },
        { label: '输出 token', value: <MonoText>{String(usage.outputTokens)}</MonoText> },
        { label: '缓存读取 token', value: <MonoText>{String(usage.cacheReadTokens)}</MonoText> },
        { label: '缓存写入 token', value: <MonoText>{String(usage.cacheCreationTokens)}</MonoText> },
        {
          label: '平均 TPS',
          value: <OptionalNumber value={usage.averageTps} />,
          hint: 'null 表示上游未提供，不显示为 0',
        },
        {
          label: '最小 / 最大 TPS',
          value:
            usage.minimumTps === null || usage.minimumTps === undefined || usage.maximumTps === null || usage.maximumTps === undefined ? (
              <span className="text-tertiary">未提供（未知）</span>
            ) : (
              <MonoText>{`${usage.minimumTps} / ${usage.maximumTps}`}</MonoText>
            ),
        },
        {
          label: 'costTicks / actualCostTicks',
          value: <MonoText>{`${usage.costTicks} / ${usage.actualCostTicks}`}</MonoText>,
          hint: '上游 tick 计数，WebUI 不换算货币',
        },
        { label: '有成本成功数', value: <MonoText>{String(usage.costedSuccess)}</MonoText> },
        { label: '未定价成功数', value: <MonoText>{String(usage.unpricedSuccess)}</MonoText> },
      ]}
    />
  );
}

function overrideItems(override: ApiKeyLimitOverrideData | null): ReactNode {
  if (override === null) {
    return <span className="text-secondary">上游返回 limitOverride = null：未设置任何覆盖，全部跟随全局。</span>;
  }
  // 用 in 判断字段是否存在，区分“未提供”与显式 null（清除覆盖）
  const has = (field: keyof ApiKeyLimitOverrideData) => Object.prototype.hasOwnProperty.call(override, field);
  return (
    <KeyValueList
      columns={2}
      items={[
        {
          label: 'limiter.enabled 覆盖',
          value: has('enabled') ? (
            <TriValue value={override.enabled} trueLabel="覆盖为启用" falseLabel="覆盖为停用" inheritLabel="跟随全局" />
          ) : (
            <TriValue value={undefined} trueLabel="覆盖为启用" falseLabel="覆盖为停用" inheritLabel="跟随全局" />
          ),
        },
        {
          label: 'maxConcurrent 覆盖',
          value: has('maxConcurrent') ? (
            override.maxConcurrent === null ? (
              <Pill tone="muted">已显式清除（null）</Pill>
            ) : (
              <MonoText>{String(override.maxConcurrent)}</MonoText>
            )
          ) : (
            <Pill tone="muted">未提供</Pill>
          ),
        },
        {
          label: 'maxQueue 覆盖',
          value: has('maxQueue') ? (
            override.maxQueue === null ? (
              <Pill tone="muted">已显式清除（null）</Pill>
            ) : (
              <MonoText>{String(override.maxQueue)}</MonoText>
            )
          ) : (
            <Pill tone="muted">未提供</Pill>
          ),
        },
        {
          label: 'queueWaitSeconds 覆盖',
          value: has('queueWaitSeconds') ? (
            override.queueWaitSeconds === null ? (
              <Pill tone="muted">已显式清除（null）</Pill>
            ) : (
              <MonoText>{String(override.queueWaitSeconds)}</MonoText>
            )
          ) : (
            <Pill tone="muted">未提供</Pill>
          ),
        },
      ]}
    />
  );
}

function editValuesFrom(key: ApiKeyData): EditFormValues {
  const override = key.limitOverride;
  return {
    enabled: 'keep',
    allowImages: 'keep',
    allowVideos: 'keep',
    allowMcp: 'keep',
    allowedModels: key.allowedModels ?? [],
    mcpTools: mcpToolsOf(key.mcpTools),
    overrideEnabled: override?.enabled === true ? 'true' : override?.enabled === false ? 'false' : 'keep',
    maxConcurrent: override?.maxConcurrent ?? null,
    maxQueue: override?.maxQueue ?? null,
    queueWaitSeconds: override?.queueWaitSeconds ?? null,
  };
}

function buildUpdateRequest(
  values: EditFormValues,
  allowedModelsMode: 'keep' | 'clear' | 'set',
  mcpToolsMode: 'keep' | 'clear' | 'set',
  limitOverrideMode: 'keep' | 'clear' | 'custom',
): ApiKeyUpdateRequest {
  const body: ApiKeyUpdateRequest = {};
  if (values.enabled === 'true') body.enabled = true;
  else if (values.enabled === 'false') body.enabled = false;
  if (values.allowImages === 'true') body.allowImages = true;
  else if (values.allowImages === 'false') body.allowImages = false;
  if (values.allowVideos === 'true') body.allowVideos = true;
  else if (values.allowVideos === 'false') body.allowVideos = false;
  if (values.allowMcp === 'true') body.allowMcp = true;
  else if (values.allowMcp === 'false') body.allowMcp = false;

  if (allowedModelsMode === 'clear') body.allowedModels = [];
  else if (allowedModelsMode === 'set') body.allowedModels = values.allowedModels ?? [];

  if (mcpToolsMode === 'clear') body.mcpTools = [] as unknown as ApiKeyUpdateRequest['mcpTools'];
  else if (mcpToolsMode === 'set') {
    body.mcpTools = (values.mcpTools ?? []) as unknown as ApiKeyUpdateRequest['mcpTools'];
  }

  if (limitOverrideMode === 'clear') {
    body.limitOverride = null;
  } else if (limitOverrideMode === 'custom') {
    const override: ApiKeyLimitOverridePatch = {};
    if (values.overrideEnabled === 'true') override.enabled = true;
    else if (values.overrideEnabled === 'false') override.enabled = false;
    // 留空表示显式清除该项覆盖（null），填写数字表示设置值
    override.maxConcurrent = values.maxConcurrent ?? null;
    override.maxQueue = values.maxQueue ?? null;
    override.queueWaitSeconds = values.queueWaitSeconds ?? null;
    body.limitOverride = override;
  }
  return body;
}

export function ApiKeysPage() {
  const { canWrite, reason: writeBlockedReason } = useWriteCapability();
  const { track } = useOperations();
  const listPollInterval = usePollingInterval(30_000);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_LIST_PAGE_SIZE);
  const [enabledFilter, setEnabledFilter] = useState<ApiKeyEnabledFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<ApiKeyProvenance | ''>('');
  const [name, setName] = useState('');
  const [sort, setSort] = useState<ApiKeySort>('orderAsc');

  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('config');

  const [allowedModelsMode, setAllowedModelsMode] = useState<'keep' | 'clear' | 'set'>('keep');
  const [mcpToolsMode, setMcpToolsMode] = useState<'keep' | 'clear' | 'set'>('keep');
  const [limitOverrideMode, setLimitOverrideMode] = useState<'keep' | 'clear' | 'custom'>('keep');

  const [createOpen, setCreateOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null);
  const [plan, setPlan] = useState<ApiKeyReplacementPlanData | null>(null);
  const [limiterSnapshot, setLimiterSnapshot] = useState<ApiKeyLimiterData | null>(null);
  const [tabNotice, setTabNotice] = useState<string | null>(null);
  const [pageNotice, setPageNotice] = useState<string | null>(null);

  const [editForm] = Form.useForm<EditFormValues>();
  const [createForm] = Form.useForm<CreateFormValues>();
  const [resetForm] = Form.useForm<{ customSecret: string }>();

  const filters = useMemo(
    () => ({
      page,
      pageSize,
      enabled: enabledFilter,
      source: sourceFilter || undefined,
      name: name || undefined,
      sort,
    }),
    [page, pageSize, enabledFilter, sourceFilter, name, sort],
  );

  const list = useApiQuery<ApiKeyListData>({
    key: ['api-keys', 'list', filters],
    path: '/api-keys',
    query: filters,
    refetchInterval: listPollInterval,
  });

  const detail = useApiQuery<ApiKeyData>({
    key: ['api-keys', 'detail', selectedKeyId],
    path: `/api-keys/${encodeSegment(selectedKeyId ?? '')}`,
    enabled: Boolean(selectedKeyId),
    staleTimeMs: 2_000,
  });

  const statsEnabled = activeTab === 'stats' && Boolean(selectedKeyId);
  const stats = useApiQuery<ApiKeyStatsData>({
    key: ['api-keys', 'stats', selectedKeyId],
    path: `/api-keys/${encodeSegment(selectedKeyId ?? '')}/stats`,
    enabled: statsEnabled,
    staleTimeMs: 10_000,
  });

  const createMutation = useApiMutation<ApiKeyCreateRequest, ApiKeySecretData>({
    method: 'POST',
    path: () => '/api-keys',
    body: (input) => input,
    invalidate: [['api-keys']],
  });

  const editMutation = useApiMutation<
    { keyId: string; body: ApiKeyUpdateRequest; ifMatch?: string | undefined },
    ApiKeyData
  >({
    method: 'PATCH',
    path: (input) => `/api-keys/${encodeSegment(input.keyId)}`,
    body: (input) => input.body,
    ifMatch: (input) => input.ifMatch,
    invalidate: [['api-keys']],
  });

  const rowStateMutation = useApiMutation<
    { keyId: string; body: ApiKeyUpdateRequest; ifMatch?: string | undefined },
    ApiKeyData
  >({
    method: 'PATCH',
    path: (input) => `/api-keys/${encodeSegment(input.keyId)}`,
    body: (input) => input.body,
    ifMatch: (input) => input.ifMatch,
    invalidate: [['api-keys']],
  });

  const removeMutation = useApiMutation<{ keyId: string; ifMatch?: string | undefined }, unknown>({
    method: 'DELETE',
    path: (input) => `/api-keys/${encodeSegment(input.keyId)}`,
    ifMatch: (input) => input.ifMatch,
    invalidate: [['api-keys']],
  });

  const replaceSecretMutation = useApiMutation<
    { keyId: string; body: ApiKeyReplaceSecretRequest; ifMatch?: string | undefined },
    ApiKeySecretData
  >({
    method: 'PUT',
    path: (input) => `/api-keys/${encodeSegment(input.keyId)}/secret`,
    body: (input) => input.body,
    ifMatch: (input) => input.ifMatch,
    invalidate: [['api-keys']],
  });

  const resetLimiterMutation = useApiMutation<{ keyId: string }, ApiKeyLimiterData>({
    method: 'POST',
    path: (input) => `/api-keys/${encodeSegment(input.keyId)}/actions/reset-limiter`,
    body: () => undefined,
    invalidate: [['api-keys']],
  });

  const planMutation = useApiMutation<{ keyId: string }, ApiKeyReplacementPlanData>({
    method: 'POST',
    path: (input) => `/api-keys/${encodeSegment(input.keyId)}/actions/generate-replacement-plan`,
    body: () => undefined,
  });

  const detailData = detail.data?.data ?? null;
  const listRevision = list.data?.revision ?? null;
  const totalItems = readNumber(list.data?.meta ?? {}, 'total');
  const detailRevision = detail.data?.revision ?? detailData?.revision ?? null;

  // 切换 Key 时把编辑草稿重置为服务端当前值（不跨 Key 复用）
  useEffect(() => {
    if (!detailData) return;
    editForm.setFieldsValue(editValuesFrom(detailData));
    setAllowedModelsMode('keep');
    setMcpToolsMode('keep');
    setLimitOverrideMode('keep');
    setPlan(null);
    setLimiterSnapshot(null);
    setTabNotice(null);
    // 只在切换到另一个 Key 时重置表单，避免后台刷新覆盖用户正在编辑的草稿
  }, [detailData?.keyId, editForm]);

  const reloadAfterConflict = () => {
    createMutation.reset();
    editMutation.reset();
    rowStateMutation.reset();
    removeMutation.reset();
    replaceSecretMutation.reset();
    resetLimiterMutation.reset();
    planMutation.reset();
    void list.refetch();
    if (selectedKeyId) void detail.refetch();
  };

  const notifyAccepted = (origin: string, operationId: string) => {
    track({ operationId, origin, invalidate: [['api-keys']] });
    setPageNotice(`上游已受理（202，任务 ${operationId}），尚未生效；进度请在任务面板查看。`);
  };

  const handleCreate = async (values: CreateFormValues) => {
    try {
      const response = await createMutation.mutateAsync({
        name: values.name.trim(),
        mode: values.mode,
        customSecret: values.mode === 'custom' ? (values.customSecret ?? null) : null,
      });
      const operationId = acceptedOperationId(response);
      if (operationId) {
        notifyAccepted('新建 API Key', operationId);
        setCreateOpen(false);
        createForm.resetFields();
        return;
      }
      const payload = response.data;
      if (payload?.secret) {
        setRevealed({ keyId: payload.apiKey.keyId, name: payload.apiKey.name, secret: payload.secret, context: 'created' });
      }
      setCreateOpen(false);
      createForm.resetFields();
    } catch {
      // 错误展示在创建弹窗内（ErrorNotice，含 422 fields 与 429 等待时间）
    }
  };

  const handleSave = async (values: EditFormValues) => {
    if (!detailData) return;
    const body = buildUpdateRequest(values, allowedModelsMode, mcpToolsMode, limitOverrideMode);
    if (!Object.keys(body).length) {
      setTabNotice('没有任何要提交的修改：所有字段都是“不修改”。');
      return;
    }
    setTabNotice(null);
    try {
      const response = await editMutation.mutateAsync({
        keyId: detailData.keyId,
        body,
        ifMatch: detailRevision ?? undefined,
      });
      const operationId = acceptedOperationId(response);
      if (operationId) {
        notifyAccepted('API Key 配置更新', operationId);
        return;
      }
      if (response.data) {
        editForm.setFieldsValue(editValuesFrom(response.data));
        setAllowedModelsMode('keep');
        setMcpToolsMode('keep');
        setLimitOverrideMode('keep');
      }
      setTabNotice('上游已返回 200，配置已保存（仍可能提示“已保存但未确认重载”，按提示处理）。');
    } catch {
      // 409 冲突保留草稿；错误由 ErrorNotice 展示
    }
  };

  const handleRowState = async (key: ApiKeyData, enabled: boolean) => {
    try {
      const response = await rowStateMutation.mutateAsync({
        keyId: key.keyId,
        body: { enabled },
        ifMatch: key.revision,
      });
      const operationId = acceptedOperationId(response);
      if (operationId) {
        notifyAccepted(enabled ? 'API Key 启用' : 'API Key 停用', operationId);
      }
    } catch {
      // 错误展示在列表卡片内
    }
  };

  const handleRemove = async (key: ApiKeyData) => {
    try {
      await removeMutation.mutateAsync({ keyId: key.keyId, ifMatch: key.revision });
      if (selectedKeyId === key.keyId) setSelectedKeyId(null);
    } catch {
      // 错误展示在列表/抽屉内
    }
  };

  const handleReplaceSecret = async (values: { customSecret: string }) => {
    if (!detailData) return;
    try {
      const response = await replaceSecretMutation.mutateAsync({
        keyId: detailData.keyId,
        body: { customSecret: values.customSecret },
        ifMatch: detailRevision ?? undefined,
      });
      const operationId = acceptedOperationId(response);
      if (operationId) {
        notifyAccepted('API Key 重置密钥', operationId);
        setResetOpen(false);
        resetForm.resetFields();
        return;
      }
      const payload = response.data;
      if (payload?.secret) {
        setRevealed({
          keyId: payload.apiKey.keyId,
          name: payload.apiKey.name,
          secret: payload.secret,
          context: 'replaced',
        });
      }
      setResetOpen(false);
      resetForm.resetFields();
    } catch {
      // 错误展示在重置弹窗内
    }
  };

  const handleResetLimiter = async () => {
    if (!detailData) return;
    setTabNotice(null);
    setLimiterSnapshot(null);
    try {
      const response = await resetLimiterMutation.mutateAsync({ keyId: detailData.keyId });
      const operationId = acceptedOperationId(response);
      if (operationId) {
        notifyAccepted('API Key 重置限流', operationId);
        return;
      }
      setLimiterSnapshot(response.data);
      setTabNotice('上游已返回 200：限流状态已重置（下面的快照来自该响应）。');
    } catch {
      // 错误展示在维护页签
    }
  };

  const handlePlan = async () => {
    if (!detailData) return;
    setTabNotice(null);
    try {
      const response = await planMutation.mutateAsync({ keyId: detailData.keyId });
      const operationId = acceptedOperationId(response);
      if (operationId) {
        notifyAccepted('API Key 替换计划', operationId);
        return;
      }
      setPlan(response.data);
      setTabNotice('上游已返回替换计划（仅计划）。WebUI 不会执行替换：执行接口不在允许清单内。');
    } catch {
      // 错误展示在维护页签
    }
  };

  const listColumns: TableProps<ApiKeyData>['columns'] = [
    {
      title: '名称',
      key: 'name',
      render: (_value, record) => (
        <div className="stack" style={{ gap: 2 }}>
          <button
            type="button"
            className={styles.nameButton}
            onClick={() => {
              setSelectedKeyId(record.keyId);
              setActiveTab('config');
            }}
          >
            {record.name}
          </button>
          <span className="text-tertiary text-sm">
            keyId：{record.keyId} · 顺序：{record.order}
          </span>
        </div>
      ),
    },
    {
      title: '秘密值（掩码）',
      dataIndex: 'maskedHint',
      key: 'maskedHint',
      render: (value: string) => (
        <Tooltip title="读取接口只返回掩码；完整秘密值只在创建/重置时返回一次">
          <span>
            <MonoText truncate>{value || '上游未提供'}</MonoText>
          </span>
        </Tooltip>
      ),
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      key: 'enabled',
      render: (value: boolean) => <Pill tone={value ? 'success' : 'warning'}>{value ? '已启用' : '已停用'}</Pill>,
    },
    {
      title: '来源',
      dataIndex: 'source',
      key: 'source',
      render: (value: ApiKeyProvenance) => <Pill tone="muted">{PROVENANCE_LABEL[value]}</Pill>,
    },
    {
      title: '能力',
      key: 'abilities',
      render: (_value, record) => (
        <div className="row" style={{ gap: 4 }}>
          {record.allowImages ? <Pill tone="primary">图像</Pill> : null}
          {record.allowVideos ? <Pill tone="primary">视频</Pill> : null}
          {record.allowMcp ? <Pill tone="primary">MCP</Pill> : null}
          {!record.allowImages && !record.allowVideos && !record.allowMcp ? (
            <span className="text-tertiary text-sm">未开放附加能力</span>
          ) : null}
        </div>
      ),
    },
    {
      title: '允许模型',
      dataIndex: 'allowedModels',
      key: 'allowedModels',
      render: (value: string[] | undefined, record) => {
        const models = value ?? [];
        if (!models.length) {
          return (
            <Tooltip title="空数组表示不限制模型（上游 schema：allowedModels=[]）">
              <span className="text-secondary text-sm">不限制（[]）</span>
            </Tooltip>
          );
        }
        return (
          <Tooltip title={models.slice(0, 20).join(', ')}>
            <span className="text-sm">{models.length} 个</span>
          </Tooltip>
        );
      },
    },
    {
      title: '本月调用',
      key: 'monthStats',
      render: (_value, record) => (
        <span className="text-sm">
          总 <MonoText>{String(record.monthStats.total)}</MonoText> · 成功{' '}
          <MonoText>{String(record.monthStats.successCount)}</MonoText> · 失败{' '}
          <MonoText>{String(record.monthStats.errorCount)}</MonoText>
        </span>
      ),
    },
    {
      title: '并发',
      key: 'limiter',
      render: (_value, record) => limiterValue(record.limiter, 'maxConcurrent'),
    },
    {
      title: '操作',
      key: 'actions',
      render: (_value, record) => (
        <div className="row" style={{ gap: 6 }}>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => {
              setSelectedKeyId(record.keyId);
              setActiveTab('config');
            }}
          >
            详情
          </button>
          <button
            type="button"
            className="btn btn--sm btn--secondary"
            disabled={!canWrite || record.enabled || rowStateMutation.isPending}
            aria-label={`启用 ${record.name}`}
            onClick={() => void handleRowState(record, true)}
          >
            启用
          </button>
          <button
            type="button"
            className="btn btn--sm btn--secondary"
            disabled={!canWrite || !record.enabled || rowStateMutation.isPending}
            aria-label={`停用 ${record.name}`}
            onClick={() => void handleRowState(record, false)}
          >
            停用
          </button>
        </div>
      ),
    },
  ];

  const byModelColumns: TableProps<ApiKeyStatsData['byModel'][number]>['columns'] = [
    { title: '模型', dataIndex: 'model', key: 'model', render: (value: string) => <MonoText>{value}</MonoText> },
    {
      title: '总请求',
      key: 'total',
      render: (_value, record) => <MonoText>{String(record.usage.total)}</MonoText>,
    },
    {
      title: '成功 / 失败',
      key: 'ok',
      render: (_value, record) => (
        <span className="text-sm">
          <MonoText>{String(record.usage.successCount)}</MonoText> / <MonoText>{String(record.usage.errorCount)}</MonoText>
        </span>
      ),
    },
    {
      title: '输入 / 输出 token',
      key: 'tokens',
      render: (_value, record) => (
        <span className="text-sm">
          <MonoText>{String(record.usage.inputTokens)}</MonoText> / <MonoText>{String(record.usage.outputTokens)}</MonoText>
        </span>
      ),
    },
  ];

  return (
    <div className="stack">
      <section className="keeper-card">
        <header className="keeper-card__header">
          <div className="keeper-card__heading">
            <h1 className="keeper-card__title">下游 API Key</h1>
            <p className="keeper-card__subtitle">
              这是用户主动管理的推理 Key，与 BFF 管理会话的保密规则不同：创建/重置返回的秘密值只在当前视图展示一次。
            </p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <span className="text-tertiary text-sm">
              共 {totalItems ?? '未知'} 个 · 列表 revision：{listRevision ? <MonoText>{listRevision}</MonoText> : ' 未知'}
            </span>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canWrite}
              onClick={() => setCreateOpen(true)}
              aria-label="新建 API Key"
            >
              新建 API Key
            </button>
          </div>
        </header>
        <div className="keeper-card__body stack">
          {!canWrite ? (
            <div className="notice-box notice-box--warning" role="status">
              当前会话只具备只读能力（{writeBlockedReason ?? '未授予写能力'}），创建、编辑、重置与吊销都已禁用；登录状态保留。
            </div>
          ) : null}
          {pageNotice ? (
            <div className="notice-box" role="status">
              {pageNotice}
            </div>
          ) : null}
          <div className="filters">
            <label className="field">
              <span className="field__label">启用状态</span>
              <Select<ApiKeyEnabledFilter>
                value={enabledFilter}
                onChange={(value) => {
                  setEnabledFilter(value ?? 'all');
                  setPage(1);
                }}
                aria-label="按启用状态筛选"
                options={[
                  { value: 'all', label: '全部' },
                  { value: 'enabled', label: '已启用' },
                  { value: 'disabled', label: '已停用' },
                ]}
              />
            </label>
            <label className="field">
              <span className="field__label">来源</span>
              <Select<ApiKeyProvenance | ''>
                value={sourceFilter}
                onChange={(value) => {
                  setSourceFilter(value ?? '');
                  setPage(1);
                }}
                allowClear
                placeholder="全部来源"
                aria-label="按来源筛选"
                options={[
                  { value: '', label: '全部来源' },
                  { value: 'generated', label: '上游生成' },
                  { value: 'custom', label: '自定义' },
                  { value: 'unknown', label: '未知来源' },
                ]}
              />
            </label>
            <label className="field">
              <span className="field__label">名称</span>
              <Input.Search
                defaultValue={name}
                allowClear
                placeholder="按名称查询"
                aria-label="按名称查询"
                onSearch={(value) => {
                  setName(value.trim());
                  setPage(1);
                }}
              />
            </label>
            <label className="field">
              <span className="field__label">排序</span>
              <Select<ApiKeySort>
                value={sort}
                onChange={(value) => {
                  setSort(value ?? 'orderAsc');
                  setPage(1);
                }}
                aria-label="排序方式"
                options={(Object.keys(SORT_LABEL) as ApiKeySort[]).map((value) => ({ value, label: SORT_LABEL[value] }))}
              />
            </label>
          </div>
        </div>
      </section>

      <section className="keeper-card">
        <header className="keeper-card__header">
          <div className="keeper-card__heading">
            <h2 className="keeper-card__title">Key 列表</h2>
            <p className="keeper-card__subtitle">列表只返回掩码；额度/限额字段按上游 schema 原样解释。</p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => void list.refetch()} aria-label="刷新列表">
              刷新
            </button>
            {removeMutation.isPending ? <span className="text-tertiary text-sm">正在删除…</span> : null}
          </div>
        </header>
        <div className="keeper-card__body stack">
          {rowStateMutation.error ? (
            <ErrorNotice error={rowStateMutation.error} onResolveConflict={reloadAfterConflict} compact />
          ) : null}
          {removeMutation.error ? (
            <ErrorNotice error={removeMutation.error} onResolveConflict={reloadAfterConflict} compact />
          ) : null}
          <AsyncState<ApiKeyListData>
            isLoading={list.isLoading}
            error={list.error}
            data={list.data?.data ?? undefined}
            isEmpty={(data) => data.items.length === 0}
            emptyTitle="还没有匹配的 API Key"
            emptyDescription="调整筛选条件，或点击右上角新建一个下游 Key。"
            onRetry={() => void list.refetch()}
            isStale={list.isError && Boolean(list.data)}
          >
            {(data) => (
              <Table<ApiKeyData>
                rowKey={(record) => record.keyId}
                columns={listColumns}
                dataSource={data.items}
                size="middle"
                scroll={{ x: 'max-content' }}
                pagination={{
                  current: page,
                  pageSize,
                  total: totalItems ?? data.items.length,
                  showSizeChanger: true,
                  pageSizeOptions: ['20', '50', '100'],
                  showTotal: (total, range) => `${range[0]}-${range[1]} / 共 ${total} 项（服务端计数）`,
                  onChange: (nextPage, nextPageSize) => {
                    setPage(nextPage);
                    if (nextPageSize && nextPageSize !== pageSize) setPageSize(nextPageSize);
                  },
                }}
              />
            )}
          </AsyncState>
        </div>
      </section>

      <Drawer
        open={Boolean(selectedKeyId)}
        onClose={() => {
          setSelectedKeyId(null);
          setPlan(null);
          setLimiterSnapshot(null);
          setTabNotice(null);
        }}
        width="min(860px, 100vw)"
        title={detailData ? `API Key 详情：${detailData.name}` : 'API Key 详情'}
        destroyOnHidden
      >
        <div className="stack">
          <AsyncState<ApiKeyData>
            isLoading={detail.isLoading}
            error={detail.error}
            data={detailData ?? undefined}
            isEmpty={() => false}
            onRetry={() => void detail.refetch()}
            isStale={detail.isError && Boolean(detail.data)}
          >
            {(key) => (
              <div className="stack">
                {!detailRevision ? (
                  <div className="notice-box notice-box--warning" role="status">
                    未读到 revision，写操作将缺少 If-Match 依据；请先重新读取详情。
                  </div>
                ) : null}
                {tabNotice ? (
                  <div className="notice-box" role="status">
                    {tabNotice}
                  </div>
                ) : null}

                <KeyValueList
                  columns={2}
                  items={[
                    { label: '名称', value: key.name },
                    { label: 'keyId', value: <MonoText>{key.keyId}</MonoText> },
                    { label: '状态', value: <Pill tone={key.enabled ? 'success' : 'warning'}>{key.enabled ? '已启用' : '已停用'}</Pill> },
                    { label: '来源', value: <Pill tone="muted">{PROVENANCE_LABEL[key.source]}</Pill> },
                    {
                      label: '秘密值（掩码提示）',
                      value: <MonoText>{key.maskedHint || '上游未提供'}</MonoText>,
                      hint: '详情接口不会返回完整秘密值；只有重置接口返回一次',
                    },
                    {
                      label: 'revision',
                      value: <MonoText>{key.revision}</MonoText>,
                      hint: '写操作时原样回传为 If-Match',
                    },
                    { label: '顺序 order', value: <MonoText>{String(key.order)}</MonoText> },
                    {
                      label: '允许模型',
                      value:
                        (key.allowedModels ?? []).length === 0 ? (
                          <span className="text-secondary">不限制（空数组）</span>
                        ) : (
                          <MonoText truncate>{(key.allowedModels ?? []).join(', ')}</MonoText>
                        ),
                    },
                  ]}
                />

                <Tabs
                  activeKey={activeTab}
                  onChange={(key2) => {
                    setActiveTab(key2);
                    setTabNotice(null);
                  }}
                  items={[
                    {
                      key: 'config',
                      label: '权限与限额配置',
                      children: (
                        <Form<EditFormValues>
                          form={editForm}
                          layout="vertical"
                          initialValues={editValuesFrom(key)}
                          onFinish={(values) => void handleSave(values)}
                        >
                          {editMutation.error ? (
                            <div style={{ marginBottom: 12 }}>
                              <ErrorNotice error={editMutation.error} onResolveConflict={reloadAfterConflict} />
                            </div>
                          ) : null}
                          <div className={styles.formRow}>
                            <Form.Item name="enabled" label="启用状态">
                              <Select<Tri> options={ENABLED_TRI_OPTIONS} aria-label="启用状态" />
                            </Form.Item>
                            <Form.Item name="allowImages" label="允许图像">
                              <Select<Tri> options={TRI_OPTIONS} aria-label="允许图像" />
                            </Form.Item>
                            <Form.Item name="allowVideos" label="允许视频">
                              <Select<Tri> options={TRI_OPTIONS} aria-label="允许视频" />
                            </Form.Item>
                            <Form.Item name="allowMcp" label="允许 MCP">
                              <Select<Tri> options={TRI_OPTIONS} aria-label="允许 MCP" />
                            </Form.Item>
                          </div>

                          <Form.Item label="allowedModels（允许模型列表）">
                            <Radio.Group
                              value={allowedModelsMode}
                              onChange={(event) => setAllowedModelsMode(event.target.value)}
                              aria-label="允许模型修改方式"
                            >
                              <Radio value="keep">不修改</Radio>
                              <Radio value="clear">清空（提交 []，表示不限制）</Radio>
                              <Radio value="set">指定列表</Radio>
                            </Radio.Group>
                          </Form.Item>
                          {allowedModelsMode === 'set' ? (
                            <Form.Item name="allowedModels" label="模型 ID 列表">
                              <Select
                                mode="tags"
                                tokenSeparators={[',', ' ']}
                                placeholder="输入模型 ID 后回车"
                                aria-label="模型 ID 列表"
                              />
                            </Form.Item>
                          ) : null}

                          <Form.Item label="mcpTools（MCP 工具）">
                            <Radio.Group
                              value={mcpToolsMode}
                              onChange={(event) => setMcpToolsMode(event.target.value)}
                              aria-label="MCP 工具修改方式"
                            >
                              <Radio value="keep">不修改</Radio>
                              <Radio value="clear">清空（提交 []）</Radio>
                              <Radio value="set">指定工具</Radio>
                            </Radio.Group>
                          </Form.Item>
                          {mcpToolsMode === 'set' ? (
                            <Form.Item name="mcpTools" label="工具集合">
                              <Select
                                mode="multiple"
                                aria-label="MCP 工具集合"
                                options={MCP_TOOLS.map((tool) => ({ value: tool, label: MCP_TOOL_LABEL[tool] }))}
                              />
                            </Form.Item>
                          ) : null}

                          <Form.Item label="limitOverride（本 Key 限额覆盖）">
                            <Radio.Group
                              value={limitOverrideMode}
                              onChange={(event) => setLimitOverrideMode(event.target.value)}
                              aria-label="限额覆盖修改方式"
                            >
                              <Radio value="keep">不修改</Radio>
                              <Radio value="clear">清除覆盖（提交 null，全部跟随全局）</Radio>
                              <Radio value="custom">自定义覆盖值</Radio>
                            </Radio.Group>
                          </Form.Item>
                          {limitOverrideMode === 'custom' ? (
                            <div className="stack">
                              <div className={styles.formRow}>
                                <Form.Item name="overrideEnabled" label="limiter.enabled 覆盖">
                                  <Select<Tri>
                                    aria-label="limiter 启用覆盖"
                                    options={[
                                      { value: 'keep', label: '不覆盖（跟随全局）' },
                                      { value: 'true', label: '覆盖为启用' },
                                      { value: 'false', label: '覆盖为停用' },
                                    ]}
                                  />
                                </Form.Item>
                                <Form.Item name="maxConcurrent" label="maxConcurrent">
                                  <InputNumber min={0} className={styles.numberInput} placeholder="留空=清除该项(null)" />
                                </Form.Item>
                                <Form.Item name="maxQueue" label="maxQueue">
                                  <InputNumber min={0} className={styles.numberInput} placeholder="留空=清除该项(null)" />
                                </Form.Item>
                                <Form.Item name="queueWaitSeconds" label="queueWaitSeconds">
                                  <InputNumber min={0} className={styles.numberInput} placeholder="留空=清除该项(null)" />
                                </Form.Item>
                              </div>
                              <span className="field__hint">
                                数字留空表示提交 null（显式清除该项覆盖）；填写 0 表示真的把该上限设为 0，两者语义不同。
                              </span>
                            </div>
                          ) : null}

                          <div className="row row--between">
                            <span className="text-tertiary text-sm">
                              提交 PATCH /api-keys/{key.keyId}，带 If-Match（当前 revision 原值）。
                            </span>
                            <button
                              type="submit"
                              className="btn btn--primary"
                              disabled={!canWrite || editMutation.isPending}
                            >
                              {editMutation.isPending ? '保存中…' : '保存配置'}
                            </button>
                          </div>
                        </Form>
                      ),
                    },
                    {
                      key: 'limits',
                      label: '运行与限额',
                      children: (
                        <div className="stack">
                          <span className="field__hint">
                            下面的生效值来自 GET /api-keys/{key.keyId}；每一项都标注了它是由本 Key 覆盖还是全局默认。
                          </span>
                          <KeyValueList
                            columns={2}
                            items={[
                              {
                                label: 'limiter.enabled',
                                value: (
                                  <span className="row" style={{ gap: 6 }}>
                                    <Pill tone={key.limiter.enabled ? 'success' : 'warning'}>
                                      {key.limiter.enabled ? '启用' : '停用'}
                                    </Pill>
                                    <span className="text-tertiary text-sm">来源：{sourceLabel(key.limiter.enabledSource)}</span>
                                  </span>
                                ),
                              },
                              { label: 'maxConcurrent', value: limiterValue(key.limiter, 'maxConcurrent') },
                              { label: 'maxQueue', value: limiterValue(key.limiter, 'maxQueue') },
                              { label: 'queueWaitSeconds', value: limiterValue(key.limiter, 'queueWaitSeconds') },
                              { label: 'inFlight（当前并发）', value: <MonoText>{String(key.limiter.inFlight)}</MonoText> },
                              { label: 'waiting（排队中）', value: <MonoText>{String(key.limiter.waiting)}</MonoText> },
                              {
                                label: 'oldestWaitSeconds',
                                value: <MonoText>{String(key.limiter.oldestWaitSeconds)}</MonoText>,
                              },
                              {
                                label: 'unlimited',
                                value: key.limiter.unlimited ? (
                                  <Pill tone="muted">上游标记不限制</Pill>
                                ) : (
                                  <Pill tone="muted">false（受上面限额约束）</Pill>
                                ),
                              },
                            ]}
                          />
                          <div className="field">
                            <span className="field__label">limitOverride（覆盖明细）</span>
                            {overrideItems(key.limitOverride)}
                          </div>
                        </div>
                      ),
                    },
                    {
                      key: 'stats',
                      label: '用量统计',
                      children: (
                        <div className="stack">
                          <span className="field__hint">
                            打开该页签时才请求 GET /api-keys/{key.keyId}/stats；null 数值按“未知”展示。
                          </span>
                          <AsyncState<ApiKeyStatsData>
                            isLoading={stats.isLoading}
                            error={stats.error}
                            data={stats.data?.data ?? undefined}
                            isEmpty={() => false}
                            onRetry={() => void stats.refetch()}
                            isStale={stats.isError && Boolean(stats.data)}
                          >
                            {(statsData) => (
                              <div className="stack">
                                <span className="text-sm">
                                  统计起点 since：<TimeText value={statsData.since} />（revision：
                                  <MonoText>{statsData.revision}</MonoText>）
                                </span>
                                <UsageList usage={statsData.overall} />
                                <Table<ApiKeyStatsData['byModel'][number]>
                                  rowKey={(record) => record.model}
                                  columns={byModelColumns}
                                  dataSource={statsData.byModel}
                                  size="small"
                                  scroll={{ x: 'max-content' }}
                                  pagination={false}
                                  locale={{ emptyText: '该统计区间没有按模型的用量' }}
                                />
                              </div>
                            )}
                          </AsyncState>
                        </div>
                      ),
                    },
                    {
                      key: 'maintenance',
                      label: '重置与吊销',
                      children: (
                        <div className="stack">
                          {resetLimiterMutation.error ? (
                            <ErrorNotice error={resetLimiterMutation.error} onResolveConflict={reloadAfterConflict} />
                          ) : null}
                          {planMutation.error ? (
                            <ErrorNotice error={planMutation.error} onResolveConflict={reloadAfterConflict} />
                          ) : null}
                          {removeMutation.error ? (
                            <ErrorNotice error={removeMutation.error} onResolveConflict={reloadAfterConflict} />
                          ) : null}

                          <section className={styles.actionBlock}>
                            <div className="field">
                              <span className="field__label">重置密钥（PUT /api-keys/{key.keyId}/secret）</span>
                              <span className="field__hint">
                                上游要求提交自定义新秘密值；旧秘密值随即失效。新秘密值只在返回时展示一次。
                              </span>
                            </div>
                            <button
                              type="button"
                              className="btn btn--secondary"
                              disabled={!canWrite}
                              onClick={() => setResetOpen(true)}
                            >
                              重置密钥
                            </button>
                          </section>

                          <section className={styles.actionBlock}>
                            <div className="field">
                              <span className="field__label">
                                重置限流（POST /api-keys/{key.keyId}/actions/reset-limiter）
                              </span>
                              <span className="field__hint">清空该 Key 当前的排队/并发计数；不改变限额配置本身。</span>
                            </div>
                            <div className="stack" style={{ gap: 8 }}>
                              <button
                                type="button"
                                className="btn btn--secondary"
                                disabled={!canWrite || resetLimiterMutation.isPending}
                                onClick={() => void handleResetLimiter()}
                              >
                                {resetLimiterMutation.isPending ? '重置中…' : '重置限流'}
                              </button>
                              {limiterSnapshot ? (
                                <div className="stack" style={{ gap: 6 }}>
                                  <span className="text-sm">响应中的限流快照：</span>
                                  <JsonBlock value={limiterSnapshot} maxHeight={160} />
                                </div>
                              ) : null}
                            </div>
                          </section>

                          <section className={styles.actionBlock}>
                            <div className="field">
                              <span className="field__label">
                                替换计划（POST /api-keys/{key.keyId}/actions/generate-replacement-plan）
                              </span>
                              <span className="field__hint">
                                只生成计划，不执行替换：执行替换的接口不在允许清单内，本页面既不调用也不显示。
                              </span>
                            </div>
                            <div className="stack" style={{ gap: 8 }}>
                              <button
                                type="button"
                                className="btn btn--secondary"
                                disabled={!canWrite || planMutation.isPending}
                                onClick={() => void handlePlan()}
                              >
                                {planMutation.isPending ? '生成中…' : '生成替换计划'}
                              </button>
                              {plan ? (
                                <div className="stack" style={{ gap: 8 }}>
                                  <KeyValueList
                                    columns={2}
                                    items={[
                                      { label: 'planId', value: <MonoText>{plan.planId}</MonoText> },
                                      { label: 'keyId', value: <MonoText>{plan.keyId}</MonoText> },
                                      { label: '过期时间', value: <TimeText value={plan.expiresAt} /> },
                                      { label: 'revision', value: <MonoText>{plan.revision}</MonoText> },
                                      { label: '影响说明 impact', value: plan.impact },
                                    ]}
                                  />
                                  <span className="field__label">planToken（仅本视图内存）</span>
                                  <SecretReveal
                                    value={plan.planToken}
                                    description="计划令牌只在本视图内存中；WebUI 不执行替换，离开页面即丢弃。"
                                  />
                                </div>
                              ) : null}
                            </div>
                          </section>

                          <section className={styles.actionBlock}>
                            <div className="field">
                              <span className="field__label">吊销并删除（DELETE /api-keys/{key.keyId}）</span>
                              <span className="field__hint">
                                上游返回 204 表示该 Key 已删除；使用该 Key 的客户端会立即失去访问权限。WebUI 不做级联删除假设。
                              </span>
                            </div>
                            <DangerConfirmButton
                              label="吊销并删除"
                              resourceName={`${key.name}（${key.keyId}）`}
                              requiresTyping={key.name}
                              impact={
                                <span>
                                  删除后该 Key 立即失效，无法通过 WebUI 恢复；已有请求日志不会因此被删除。请输入 Key 名称确认。
                                </span>
                              }
                              pending={removeMutation.isPending}
                              disabled={!canWrite}
                              onConfirm={async () => {
                                await handleRemove(key);
                              }}
                            />
                          </section>
                        </div>
                      ),
                    },
                  ]}
                />
              </div>
            )}
          </AsyncState>
        </div>
      </Drawer>

      <Modal
        open={createOpen}
        title="新建 API Key"
        okText="创建"
        cancelText="取消"
        confirmLoading={createMutation.isPending}
        okButtonProps={{ disabled: !canWrite }}
        onCancel={() => {
          setCreateOpen(false);
          createMutation.reset();
        }}
        onOk={() => createForm.submit()}
      >
        <Form<CreateFormValues> form={createForm} layout="vertical" initialValues={{ mode: 'generated' }} onFinish={(values) => void handleCreate(values)}>
          {createMutation.error ? (
            <div style={{ marginBottom: 12 }}>
              <ErrorNotice error={createMutation.error} onResolveConflict={reloadAfterConflict} />
            </div>
          ) : null}
          <Form.Item
            name="name"
            label="名称"
            rules={[
              { required: true, message: '请输入名称' },
              { max: 64, message: '名称最长 64 个字符' },
              { pattern: /^[A-Za-z0-9_.-]+$/, message: '上游约束：只允许字母、数字、下划线、点和短横线' },
            ]}
          >
            <Input placeholder="例如 prod-gateway" aria-label="API Key 名称" />
          </Form.Item>
          <Form.Item name="mode" label="秘密值来源" rules={[{ required: true }]}>
            <Radio.Group aria-label="秘密值来源">
              <Radio value="generated">由上游生成</Radio>
              <Radio value="custom">我提供自定义秘密值</Radio>
            </Radio.Group>
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(previous, next) => previous.mode !== next.mode}>
            {({ getFieldValue }) =>
              getFieldValue('mode') === 'custom' ? (
                <Form.Item
                  name="customSecret"
                  label="自定义秘密值"
                  rules={[
                    { required: true, message: '请输入自定义秘密值' },
                    { min: 8, message: '上游要求至少 8 个字符' },
                    { max: 256, message: '上游限制最长 256 个字符' },
                  ]}
                >
                  <Input.Password autoComplete="new-password" aria-label="自定义秘密值" />
                </Form.Item>
              ) : null
            }
          </Form.Item>
          <span className="field__hint">
            这里的秘密值只发送给上游，不写入浏览器持久化存储；返回的秘密值只在创建后展示一次。
          </span>
        </Form>
      </Modal>

      <Modal
        open={resetOpen}
        title={detailData ? `重置密钥：${detailData.name}` : '重置密钥'}
        okText="提交新密钥"
        cancelText="取消"
        confirmLoading={replaceSecretMutation.isPending}
        okButtonProps={{ disabled: !canWrite }}
        onCancel={() => {
          setResetOpen(false);
          replaceSecretMutation.reset();
          resetForm.resetFields();
        }}
        onOk={() => resetForm.submit()}
      >
        <Form form={resetForm} layout="vertical" onFinish={(values) => void handleReplaceSecret(values)}>
          {replaceSecretMutation.error ? (
            <div style={{ marginBottom: 12 }}>
              <ErrorNotice error={replaceSecretMutation.error} onResolveConflict={reloadAfterConflict} />
            </div>
          ) : null}
          <div className="notice-box notice-box--warning" role="alert">
            提交后该 Key 的旧秘密值立即失效；请确认所有调用方都已经准备好更换。此处上传的自定义值不会被 WebUI 保存。
          </div>
          <Form.Item
            name="customSecret"
            label="新的自定义秘密值"
            rules={[
              { required: true, message: '请输入新的秘密值' },
              { min: 8, message: '上游要求至少 8 个字符' },
              { max: 256, message: '上游限制最长 256 个字符' },
            ]}
          >
            <Input.Password autoComplete="new-password" aria-label="新的自定义秘密值" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={Boolean(revealed)}
        title={revealed?.context === 'replaced' ? '密钥已重置' : '新 API Key 已创建'}
        okText="我已保存，关闭"
        cancelButtonProps={{ style: { display: 'none' } }}
        onOk={() => setRevealed(null)}
        onCancel={() => setRevealed(null)}
        maskClosable={false}
      >
        {revealed ? (
          <div className="stack">
            <div className="notice-box notice-box--warning" role="alert">
              这是上游返回的推理 Key 秘密值，只存在于当前页面内存中：不写入任何持久化存储、不进入 URL、不进入日志。
              关闭本窗口后 WebUI 无法再展示它。
            </div>
            <KeyValueList
              columns={1}
              items={[
                { label: '名称', value: revealed.name },
                { label: 'keyId', value: <MonoText>{revealed.keyId}</MonoText> },
              ]}
            />
            <SecretReveal
              value={revealed.secret}
              description="请立即复制并保存到你的密钥管理系统；刷新或离开页面后不会再显示。"
            />
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
