/**
 * 请求日志域：类型导入、筛选态、分页 meta 解析与安全展示辅助。
 *
 * 字段名严格对齐 packages/contracts/generated/upstream-mvp.d.ts（由 upstream.openapi.json 生成，禁止臆造）。
 * 本页只使用上游真实支持的参数（GET /api/management/v1/logs 的 parameterNames）：
 * status / apiKey / model / channel / protocol / query / startedAt / endedAt / sort / descending / page / pageSize。
 *
 * 安全约定：原始正文只经 JsonBlock 以纯文本/受控 JSON 展示，禁止 dangerouslySetInnerHTML。
 */

import type { ApiError } from '@/api/client';
import type { Tone } from '@/components/bits';
import type {
  BodySort,
  FilterOptionData,
  JsonValue,
  LogBodyItemData,
  LogBodyKind,
  RawLogBodyData,
  RequestLogData,
  RequestLogDetailData,
  RequestLogFilterOptionsData,
  RequestLogSort,
  RequestLogStatus,
  RequestProtocol,
} from '../../../../../packages/contracts/generated/upstream-mvp';

export type {
  BodySort,
  FilterOptionData,
  JsonValue,
  LogBodyItemData,
  LogBodyKind,
  RawLogBodyData,
  RequestLogData,
  RequestLogDetailData,
  RequestLogFilterOptionsData,
  RequestLogSort,
  RequestLogStatus,
  RequestProtocol,
};

/** 上游能力码：读取日志正文（见 Capability schema）。 */
export const LOG_BODY_CAPABILITY = 'management.logs.body.read';
/** 上游能力码：管理 API 读取。 */
export const LOG_LIST_CAPABILITY = 'management.read';

/** 上游 pageSize 上限（OpenAPI: maximum 200）。 */
export const MAX_LOG_PAGE_SIZE = 200;
export const LOG_PAGE_SIZE_OPTIONS = [20, 50, 100, 200];
export const BODY_PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 200];

/** 上游 BodySort 枚举（GET /logs/{logId}/body 的 sort 参数）。 */
export const BODY_SORT_OPTIONS: Array<{ value: BodySort; label: string }> = [
  { value: 'original', label: '原始顺序' },
  { value: 'reverse', label: '倒序' },
  { value: 'size', label: '按大小' },
  { value: 'type', label: '按条目类型' },
];

/** 上游 RequestLogSort 枚举（GET /logs 的 sort 参数）。 */
export const LOG_SORT_OPTIONS: Array<{ value: RequestLogSort; label: string }> = [
  { value: 'createdAt', label: '创建时间' },
  { value: 'status', label: '状态' },
  { value: 'latency', label: '耗时' },
  { value: 'model', label: '模型' },
];

/** 请求日志列表筛选态；空值表示该参数不下发。 */
export interface LogListFilters {
  status: string | undefined;
  apiKey: string | undefined;
  model: string | undefined;
  channel: string | undefined;
  protocol: string | undefined;
  query: string | undefined;
  startedAt: string | undefined;
  endedAt: string | undefined;
  sort: RequestLogSort;
  descending: boolean;
}

export const EMPTY_LOG_FILTERS: LogListFilters = {
  status: undefined,
  apiKey: undefined,
  model: undefined,
  channel: undefined,
  protocol: undefined,
  query: undefined,
  startedAt: undefined,
  endedAt: undefined,
  sort: 'createdAt',
  descending: true,
};

export function hasActiveFilters(filters: LogListFilters): boolean {
  return Boolean(
    filters.status ||
      filters.apiKey ||
      filters.model ||
      filters.channel ||
      filters.protocol ||
      filters.query ||
      filters.startedAt ||
      filters.endedAt,
  );
}

export function filtersDirty(draft: LogListFilters, applied: LogListFilters): boolean {
  return JSON.stringify(draft) !== JSON.stringify(applied);
}

// ---------------------------------------------------------------- 分页 meta（运行期守卫）

export interface ListPagingMeta {
  total: number | null;
  page: number | null;
  pageSize: number | null;
  hasNext: boolean | null;
  requestId: string | null;
}

export interface BodyPagingMeta extends ListPagingMeta {
  revision: string | null;
  kindCounts: Array<{ kind: string; count: number }>;
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readBoolean(source: Record<string, unknown>, key: string): boolean | null {
  const value = source[key];
  return typeof value === 'boolean' ? value : null;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value ? value : null;
}

/** PagedResponseMeta：只读取真实存在的字段，缺失即 unknown（不伪造 0）。 */
export function readListMeta(meta: Record<string, unknown> | undefined): ListPagingMeta {
  const source = meta ?? {};
  return {
    total: readNumber(source, 'total'),
    page: readNumber(source, 'page'),
    pageSize: readNumber(source, 'pageSize'),
    hasNext: readBoolean(source, 'hasNext'),
    requestId: readString(source, 'requestId'),
  };
}

/** LogBodyPagedResponseMeta：额外读取 revision 与 kindCounts（条目类型分布）。 */
export function readBodyMeta(meta: Record<string, unknown> | undefined): BodyPagingMeta {
  const base = readListMeta(meta);
  const rawCounts = (meta ?? {}).kindCounts;
  const kindCounts: Array<{ kind: string; count: number }> = [];
  if (Array.isArray(rawCounts)) {
    for (const entry of rawCounts) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const kind = typeof record.kind === 'string' ? record.kind : null;
      const count = typeof record.count === 'number' ? record.count : null;
      if (kind && count !== null) kindCounts.push({ kind, count });
    }
  }
  return { ...base, revision: readString(meta ?? {}, 'revision'), kindCounts };
}

/** 上游 filter-options 列表：非数组一律视为未提供，不编造选项。 */
export function filterOptionList(list: FilterOptionData[] | undefined | null): FilterOptionData[] {
  return Array.isArray(list) ? list : [];
}

// ---------------------------------------------------------------- 体积上限（未完整展示）

const SIZE_LIMIT_CODES = ['WEBUI_PAYLOAD_TOO_LARGE', 'WEBUI_RESPONSE_TOO_LARGE'];

/**
 * 413 WEBUI_PAYLOAD_TOO_LARGE / 502 WEBUI_RESPONSE_TOO_LARGE 表示本次内容没有完整返回。
 * 命中时必须明确提示"未完整展示"，不能假称已完整展示。
 */
export function isSizeLimitError(error: ApiError | null | undefined): boolean {
  if (!error) return false;
  if (SIZE_LIMIT_CODES.includes(error.code)) return true;
  if (error.status === 413) return true;
  return error.status === 502 && /TOO_LARGE|TRUNCAT/i.test(error.code);
}

export function sizeLimitReason(error: ApiError | null | undefined): string | null {
  if (!isSizeLimitError(error)) return null;
  const code = error?.code ?? 'WEBUI_RESPONSE_TOO_LARGE';
  return `触发了体积上限（${code}）：本次内容未完整返回，页面只展示已收到的部分，不代表日志已完整读取。请缩小时间范围、增加筛选条件，或按条目/分页查看。`;
}

// ---------------------------------------------------------------- 展示辅助

/** 上游 capabilities 缺失时不做本地限制（由上游再校验）；否则按能力码判断。 */
export function readCapability(capabilities: string[], code: string): { allowed: boolean; reason: string | null } {
  if (!capabilities.length) return { allowed: true, reason: null };
  if (capabilities.includes(code)) return { allowed: true, reason: null };
  return {
    allowed: false,
    reason: `当前会话缺少 ${code} 能力，已禁用该动作（上游仍会再次校验）。`,
  };
}

const STATUS_LABELS: Record<string, string> = {
  success: '成功',
  error: '失败',
  cancelled: '已取消',
  pending: '进行中',
};

/** status 在 schema 中是 string（枚举值见 RequestLogStatus）；未知值原样显示，不猜语义。 */
export function statusLabel(status: string | null | undefined): string {
  if (!status) return '未知';
  return STATUS_LABELS[status] ?? status;
}

export function statusTone(status: string | null | undefined): Tone {
  switch (status) {
    case 'success':
      return 'success';
    case 'error':
      return 'danger';
    case 'cancelled':
      return 'warning';
    case 'pending':
      return 'primary';
    default:
      return 'muted';
  }
}

/** 耗时：未知就是"未知"，不显示 0。 */
export function formatDuration(milliseconds: number | null | undefined): string {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds)) return '未知';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(2)} s`;
}

export function formatCount(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '未知';
}

export function formatBytes(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未知';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

export interface ModelSummary {
  requested: string | null;
  final: string | null;
  changed: boolean;
}

/** 请求模型与最终模型分别展示，不挑一个冒充另一个。 */
export function modelSummary(log: RequestLogData): ModelSummary {
  const requested = log.requestedModel ?? null;
  const final = log.finalModel ?? null;
  return { requested, final, changed: Boolean(requested && final && requested !== final) };
}

/**
 * 受控 JSON：能解析为 JSON 就结构化展示，否则按纯文本展示。
 * 无论哪种情况都不会被当作 HTML 执行（JsonBlock 只渲染文本节点）。
 */
export function asDisplayText(text: string | null | undefined): unknown {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (/^[[{"-]|^(true|false|null)$/.test(trimmed)) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

/** 成本：上游只给 ticks，单位未提供，本页不做任何金额换算。 */
export const COST_TICKS_HINT = '上游字段为 costTicks；单位未在本契约中提供，本页不做金额换算。';
