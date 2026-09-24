/**
 * 「第三方 API 渠道」页面的接口封装。
 *
 * 全部经由 `@/api/client`（BFF 唯一入口，前端契约 §2）：
 * - 读：`useApiQuery`；写：`useApiMutation`（永不自动重试）。
 * - 写操作的 `If-Match` 一律来自"读到的 revision 原样值"（实施文档 7.2）：
 *   渠道用 `ChannelData.revision` / `ChannelDetailData.revision`，
 *   兼容性用 `ChannelCompatibilityData.revision`（与渠道 revision 是不同的资源）。
 * - 202 只登记任务，页面不自行轮询（前端契约 §4、实施文档 7.3）。
 */

import type { QueryKey } from '@tanstack/react-query';
import { encodeSegment, type ManagementResponse } from '@/api/client';
import { useApiMutation, useApiQuery, usePollingInterval } from '@/api/hooks';
import type {
  ActionResultData,
  ChannelCatalogData,
  ChannelCompatibilityData,
  ChannelCompatibilityInput,
  ChannelData,
  ChannelDetailData,
  ChannelHealth,
  ChannelProtocol,
  ChannelUpdateRequest,
  DraftChannelDiscoveryRequest,
  ExistingChannelDiscoveryRequest,
  ManagementOperationData,
  ManualChannelCreateRequest,
  OperationStatus,
  PresetChannelCreateRequest,
  ProbeDraftRequest,
  ProbeExistingRequest,
} from './upstream-types';

/** 渠道相关的查询键前缀：写操作成功后只失效这些键（前端契约 §2）。 */
export const CHANNEL_QUERY_PREFIX = ['channels'] as const;
export const CHANNEL_INVALIDATE_KEYS: QueryKey[] = [['channels'], ['overview']];

/** GET /channels 真实存在的查询参数（生成类型：page/pageSize/search/enabled/protocol/providerId/health/sort/direction）。 */
export interface ChannelListFilters {
  page: number;
  pageSize: number;
  search: string;
  enabled?: boolean;
  protocol?: ChannelProtocol;
  providerId?: string;
  health?: ChannelHealth;
}

export function channelListQueryKey(filters: ChannelListFilters): QueryKey {
  return ['channels', 'list', filters];
}

export function channelDetailQueryKey(channelId: string): QueryKey {
  return ['channels', 'detail', channelId];
}

export const channelCatalogQueryKey: QueryKey = ['channels', 'catalog'];

/** 渠道列表：20 秒轮询，后台标签页由 usePollingInterval 自动降频。 */
export function useChannelList(filters: ChannelListFilters) {
  return useApiQuery<ChannelData[]>({
    key: channelListQueryKey(filters),
    path: '/channels',
    query: {
      page: filters.page,
      pageSize: filters.pageSize,
      search: filters.search.trim() || undefined,
      enabled: filters.enabled,
      protocol: filters.protocol,
      providerId: filters.providerId,
      health: filters.health,
    },
    refetchInterval: usePollingInterval(20_000),
  });
}

/** 供应商/协议目录（新增渠道、筛选供应商用）；目录内容变化很慢，不做轮询。 */
export function useChannelCatalog(options: { enabled?: boolean } = {}) {
  return useApiQuery<ChannelCatalogData>({
    key: channelCatalogQueryKey,
    path: '/channel-catalog',
    enabled: options.enabled ?? true,
    staleTimeMs: 300_000,
  });
}

/** 渠道详情：含月度统计与运行时模型数据，属于重数据，按契约不做自动轮询。 */
export function useChannelDetail(channelId: string | null) {
  return useApiQuery<ChannelDetailData>({
    key: channelDetailQueryKey(channelId ?? ''),
    path: `/channels/${encodeSegment(channelId ?? '')}`,
    enabled: Boolean(channelId),
  });
}

/** 渠道兼容性；只有在用户主动展开该区块时才读取。 */
export function useChannelCompatibility(channelId: string | null, enabled: boolean) {
  return useApiQuery<ChannelCompatibilityData>({
    key: ['channels', 'compatibility', channelId ?? ''],
    path: `/channels/${encodeSegment(channelId ?? '')}/compatibility`,
    enabled: Boolean(channelId) && enabled,
  });
}

// ------------------------------------------------------------------ 写操作

export interface CreateChannelInput {
  body: ManualChannelCreateRequest | PresetChannelCreateRequest;
  /** 合法的 Idempotency-Key（≤200 字符，由 BFF 原样转发），避免创建动作被重复提交两次。 */
  idempotencyKey: string;
}

export function useCreateChannel() {
  return useApiMutation<CreateChannelInput, ChannelData>({
    method: 'POST',
    path: () => '/channels',
    body: (input) => input.body,
    idempotencyKey: (input) => input.idempotencyKey,
    invalidate: CHANNEL_INVALIDATE_KEYS,
  });
}

export interface UpdateChannelInput {
  channelId: string;
  body: ChannelUpdateRequest;
  /** 读到的渠道 revision，原样作为 If-Match 回传。 */
  ifMatch: string;
}

export function useUpdateChannel() {
  return useApiMutation<UpdateChannelInput, ChannelData>({
    method: 'PATCH',
    path: (input) => `/channels/${encodeSegment(input.channelId)}`,
    body: (input) => input.body,
    ifMatch: (input) => input.ifMatch,
    invalidate: CHANNEL_INVALIDATE_KEYS,
  });
}

export interface DeleteChannelInput {
  channelId: string;
  /** DELETE /channels/{channelId} 的 If-Match 是必填头。 */
  ifMatch: string;
}

export function useDeleteChannel() {
  return useApiMutation<DeleteChannelInput, void>({
    method: 'DELETE',
    path: (input) => `/channels/${encodeSegment(input.channelId)}`,
    body: () => undefined,
    ifMatch: (input) => input.ifMatch,
    invalidate: CHANNEL_INVALIDATE_KEYS,
  });
}

/** 既有渠道诊断：POST /channels/{channelId}/diagnostic-probes（202）。 */
export interface ProbeChannelInput {
  channelId: string;
  body: ProbeExistingRequest;
}

export function useProbeChannel() {
  return useApiMutation<ProbeChannelInput, ManagementOperationData>({
    method: 'POST',
    path: (input) => `/channels/${encodeSegment(input.channelId)}/diagnostic-probes`,
    body: (input) => input.body,
    invalidate: CHANNEL_INVALIDATE_KEYS,
  });
}

/** 新渠道草稿诊断：POST /channel-drafts/probes（202）。与既有渠道诊断是两个不同动作。 */
export function useProbeChannelDraft() {
  return useApiMutation<ProbeDraftRequest, ManagementOperationData>({
    method: 'POST',
    path: () => '/channel-drafts/probes',
    body: (input) => input,
    invalidate: CHANNEL_INVALIDATE_KEYS,
  });
}

/** 模型发现：POST /channel-model-discoveries（202），既有渠道与草稿两种来源。 */
export function useDiscoverChannelModels() {
  return useApiMutation<ExistingChannelDiscoveryRequest | DraftChannelDiscoveryRequest, ManagementOperationData>({
    method: 'POST',
    path: () => '/channel-model-discoveries',
    body: (input) => input,
    invalidate: CHANNEL_INVALIDATE_KEYS,
  });
}

/** 刷新供应商用量：POST /channels/{channelId}/actions/refresh-usage（202）。 */
export function useRefreshChannelUsage() {
  return useApiMutation<{ channelId: string }, ManagementOperationData>({
    method: 'POST',
    path: (input) => `/channels/${encodeSegment(input.channelId)}/actions/refresh-usage`,
    body: () => undefined,
    invalidate: CHANNEL_INVALIDATE_KEYS,
  });
}

export function useClearChannelErrors() {
  return useApiMutation<{ channelId: string }, ActionResultData>({
    method: 'POST',
    path: (input) => `/channels/${encodeSegment(input.channelId)}/actions/clear-errors`,
    body: () => undefined,
    invalidate: CHANNEL_INVALIDATE_KEYS,
  });
}

export function useClearChannelAffinity() {
  return useApiMutation<{ channelId: string }, ActionResultData>({
    method: 'POST',
    path: (input) => `/channels/${encodeSegment(input.channelId)}/actions/clear-affinity`,
    body: () => undefined,
    invalidate: CHANNEL_INVALIDATE_KEYS,
  });
}

/** 批量：上游没有"按选中渠道"的批量接口，这两个动作作用于全部渠道。 */
export function useClearAllChannelErrors() {
  return useApiMutation<void, ActionResultData>({
    method: 'POST',
    path: () => '/channels/actions/clear-errors',
    body: () => undefined,
    invalidate: CHANNEL_INVALIDATE_KEYS,
  });
}

export function useClearAllChannelAffinity() {
  return useApiMutation<void, ActionResultData>({
    method: 'POST',
    path: () => '/channels/actions/clear-affinity',
    body: () => undefined,
    invalidate: CHANNEL_INVALIDATE_KEYS,
  });
}

export interface UpdateCompatibilityInput {
  channelId: string;
  body: ChannelCompatibilityInput;
  /** 兼容性资源自己的 revision，不是渠道 revision。 */
  ifMatch: string;
}

export function useUpdateChannelCompatibility() {
  return useApiMutation<UpdateCompatibilityInput, ChannelCompatibilityData>({
    method: 'PATCH',
    path: (input) => `/channels/${encodeSegment(input.channelId)}/compatibility`,
    body: (input) => input.body,
    ifMatch: (input) => input.ifMatch,
    invalidate: [['channels']],
  });
}

// ------------------------------------------------------------------ 响应解析

export interface ChannelListMeta {
  page: number | null;
  pageSize: number | null;
  total: number | null;
  hasNext: boolean | null;
  /** GET /channels 的 meta 里用于 PUT /channels/order 的排序版本（不是渠道自身 revision）。 */
  orderRevision: string | null;
}

/** 按真实 meta 字段读取分页信息；缺失就是未知，不用 0 冒充。 */
export function readChannelListMeta(meta: Record<string, unknown> | undefined): ChannelListMeta {
  const readNumber = (key: string): number | null => {
    const value = meta?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const rawHasNext = meta?.['hasNext'];
  const rawOrderRevision = meta?.['orderRevision'];
  return {
    page: readNumber('page'),
    pageSize: readNumber('pageSize'),
    total: readNumber('total'),
    hasNext: typeof rawHasNext === 'boolean' ? rawHasNext : null,
    orderRevision: typeof rawOrderRevision === 'string' ? rawOrderRevision : null,
  };
}

export interface AcceptedOperation {
  operationId: string;
  status: OperationStatus;
  kind: string | null;
}

function normalizeOperationStatus(raw: unknown): OperationStatus {
  switch (raw) {
    case 'queued':
    case 'running':
    case 'succeeded':
    case 'failed':
    case 'cancelled':
      return raw;
    default:
      return 'running';
  }
}

/**
 * 识别 202 受理结果：只有 HTTP 202 且有任务 ID 才算"已受理"，
 * 用于登记任务；绝不能当成成功（实施文档 7.3）。
 *
 * 泛型是因为调用方可能用具体资源类型声明成功响应（例如 POST /channels 的 201 ChannelData）；
 * 只有 status===202 时才读取任务字段，其它状态一律返回 null。
 */
export function acceptedOperation<T>(response: ManagementResponse<T>): AcceptedOperation | null {
  if (response.status !== 202) return null;
  const data = (response.data ?? null) as { id?: unknown; status?: unknown; kind?: unknown } | null;
  const rawId = data && typeof data.id === 'string' && data.id.length > 0 ? data.id : null;
  const metaOperationId = typeof response.meta['operationId'] === 'string' ? (response.meta['operationId'] as string) : null;
  const operationId = rawId ?? metaOperationId;
  if (!operationId) return null;
  return {
    operationId,
    status: normalizeOperationStatus(data?.status),
    kind: data && typeof data.kind === 'string' ? data.kind : null,
  };
}

/** 同步结果（200）里的 ActionResultData：按真实字段展示 affected（以及上游可选的 queued）。 */
export function readActionResult(response: ManagementResponse<ActionResultData>): { affected: number | null; queued: boolean | null } {
  const data = response.data;
  return {
    affected: typeof data?.affected === 'number' ? data.affected : null,
    queued: typeof data?.queued === 'boolean' ? data.queued : null,
  };
}

/** 生成一个合法的 Idempotency-Key（只在内存中出现，提交后不复用）。 */
export function newIdempotencyKey(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `channels-${random}`;
}
