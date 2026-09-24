/**
 * OAuth 账号域的契约类型与纯函数辅助。
 *
 * 字段名必须与真实 schema 一致：这里不手写字段，而是直接从构建期生成的契约类型
 * （packages/contracts/generated/upstream-mvp.d.ts，来源 packages/contracts/upstream.openapi.json）
 * 做 type-only 再导出，避免臆造字段。使用相对路径是因为 packages/contracts 的 package.json
 * exports 里 "./upstream" 指向不存在的 generated/upstream.d.ts，而本任务不允许修改本目录之外的文件。
 * 全部为 type-only 导入，编译后不会留下运行时代码。
 */

import type {
  CchMode,
  CommitOAuthImportRequest,
  CompleteOAuthLoginFlowRequest,
  ManagementOperationData,
  OAuthAccountDetailData,
  OAuthAccountFilter,
  OAuthAccountListData,
  OAuthAccountSort,
  OAuthAccountSummaryData,
  OAuthClearedCountData,
  OAuthImportCandidateData,
  OAuthImportCommitData,
  OAuthImportDecisionRequest,
  OAuthImportPreviewData,
  OAuthImportProblemData,
  OAuthLocalStatsData,
  OAuthLoginFlowData,
  OAuthLoginPollData,
  OAuthModelData,
  OAuthModelListData,
  OAuthMutationData,
  OAuthProvider,
  OAuthRuntimeErrorData,
  OAuthSettingsData,
  OAuthUsageWindowData,
  PollOAuthLoginFlowRequest,
  PreviewOAuthImportRequest,
  StartOAuthLoginFlowRequest,
  UpdateOAuthAccountModelSettingsRequest,
  UpdateOAuthAccountModelsRequest,
  UpdateOAuthAccountRequest,
  UpdateOAuthSettingsRequest,
  UpdateQuotaMonitorRequest,
} from '../../../../../packages/contracts/generated/upstream-mvp';
import type { ApiError } from '@/api/client';

export type {
  CchMode,
  CommitOAuthImportRequest,
  CompleteOAuthLoginFlowRequest,
  ManagementOperationData,
  OAuthAccountDetailData,
  OAuthAccountFilter,
  OAuthAccountListData,
  OAuthAccountSort,
  OAuthAccountSummaryData,
  OAuthClearedCountData,
  OAuthImportCandidateData,
  OAuthImportCommitData,
  OAuthImportDecisionRequest,
  OAuthImportPreviewData,
  OAuthImportProblemData,
  OAuthLocalStatsData,
  OAuthLoginFlowData,
  OAuthLoginPollData,
  OAuthModelData,
  OAuthModelListData,
  OAuthMutationData,
  OAuthProvider,
  OAuthRuntimeErrorData,
  OAuthSettingsData,
  OAuthUsageWindowData,
  PollOAuthLoginFlowRequest,
  PreviewOAuthImportRequest,
  StartOAuthLoginFlowRequest,
  UpdateOAuthAccountModelSettingsRequest,
  UpdateOAuthAccountModelsRequest,
  UpdateOAuthAccountRequest,
  UpdateOAuthSettingsRequest,
  UpdateQuotaMonitorRequest,
};

// ------------------------------------------------------------------ 枚举标签

export const OAUTH_PROVIDERS: readonly OAuthProvider[] = [
  'openai',
  'claude',
  'cursor',
  'xai',
  'antigravity',
  'workbuddy',
];

export const PROVIDER_LABEL: Record<OAuthProvider, string> = {
  openai: 'OpenAI',
  claude: 'Claude',
  cursor: 'Cursor',
  xai: 'xAI',
  antigravity: 'Antigravity',
  workbuddy: 'WorkBuddy',
};

export function providerLabel(provider: OAuthProvider | null | undefined): string {
  if (!provider) return '未知供应商';
  return PROVIDER_LABEL[provider] ?? provider;
}

export const ACCOUNT_FILTER_LABEL: Record<OAuthAccountFilter, string> = {
  all: '全部',
  available: '可用',
  quota: '额度受限',
  invalid: '已失效',
};

export const ACCOUNT_SORT_LABEL: Record<OAuthAccountSort, string> = {
  configured: '按配置顺序',
  displayName: '按显示名',
  provider: '按供应商',
  status: '按状态',
};

export const CLIENT_PROFILE_LABEL: Record<'cli' | 'ide', string> = {
  cli: 'CLI',
  ide: 'IDE',
};

export const REALM_LABEL: Record<'cn' | 'global', string> = {
  cn: '中国大陆（cn）',
  global: '全球（global）',
};

export const CCH_MODE_LABEL: Record<CchMode, string> = {
  disabled: '关闭',
  dynamic: '动态',
};

export const IMPORT_FORMAT_LABEL: Record<PreviewOAuthImportRequest['format'], string> = {
  openai: 'OpenAI 凭据',
  cpa: 'CPA 导出文件',
  sub2api: 'sub2api 导出文件',
};

export const IMPORT_DECISION_LABEL: Record<OAuthImportDecisionRequest['action'], string> = {
  keep: '保留现状（跳过该候选）',
  overwrite: '写入导入内容',
};

// ------------------------------------------------------------------ 登录流程

/**
 * 登录流程的界面状态（与上游 poll status 不是一回事）：
 * 发起 / 等待授权 / 需要回填 / 等待保存 / 保存成功 / 超时 / 已取消 / 失败 分别展示。
 */
export type LoginFlowStage =
  | 'idle'
  | 'starting'
  | 'waiting'
  | 'needs-input'
  | 'ready'
  | 'saved'
  | 'expired'
  | 'cancelled'
  | 'failed';

export const LOGIN_FLOW_STAGE_LABEL: Record<LoginFlowStage, string> = {
  idle: '未发起',
  starting: '发起中',
  waiting: '等待授权',
  'needs-input': '需要回填',
  ready: '等待保存',
  saved: '保存成功',
  expired: '已超时',
  cancelled: '已取消',
  failed: '失败',
};

export const LOGIN_FLOW_STAGE_TONE: Record<
  LoginFlowStage,
  'default' | 'primary' | 'success' | 'warning' | 'danger' | 'muted'
> = {
  idle: 'muted',
  starting: 'primary',
  waiting: 'primary',
  'needs-input': 'warning',
  ready: 'primary',
  saved: 'success',
  expired: 'warning',
  cancelled: 'muted',
  failed: 'danger',
};

export const POLL_STATUS_LABEL: Record<OAuthLoginPollData['status'], string> = {
  pending: '等待授权（pending）',
  identity_pending: '需要回填（identity_pending）',
  ready: '等待保存（ready）',
  completed: '已完成（completed）',
  cancelled: '已取消（cancelled）',
  expired: '已超时（expired）',
};

export function isTerminalPollStatus(status: OAuthLoginPollData['status']): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'expired';
}

/** 上游只在 saveStatus 里说明是新建还是替换，不要在界面里自己猜。 */
export function saveStatusLabel(saveStatus: OAuthLoginPollData['saveStatus']): string {
  if (saveStatus === 'created') return '已新建账号';
  if (saveStatus === 'replaced') return '已替换同身份账号';
  return '已保存';
}

/**
 * 同身份冲突时上游返回一次性替换令牌（writeOnly 秘密值）。
 * 处理该冲突必须由用户明确确认，禁止自动覆盖。
 */
export interface ReplacePlan {
  accountId: string;
  replacePlanToken: string;
}

export function readReplacePlan(error: ApiError | null | undefined): ReplacePlan | null {
  if (!error || !error.payload || typeof error.payload !== 'object') return null;
  const conflict = (error.payload as Record<string, unknown>).conflict;
  if (!conflict || typeof conflict !== 'object') return null;
  const record = conflict as Record<string, unknown>;
  const accountId = record.accountId;
  const token = record.replacePlanToken;
  if (typeof accountId !== 'string' || typeof token !== 'string' || !token) return null;
  return { accountId, replacePlanToken: token };
}

/** 202 只表示已受理：取真实的 operationId 交给任务面板跟踪。 */
export function operationIdFrom(response: { status: number; data: unknown }): string | null {
  if (response.status !== 202) return null;
  const data = response.data;
  if (!data || typeof data !== 'object') return null;
  const id = (data as Record<string, unknown>).id;
  return typeof id === 'string' && id ? id : null;
}

// ------------------------------------------------------------------ 展示辅助

/**
 * 额度/用量只展示上游真实返回的数值：null / undefined 一律返回 null，
 * 由调用方显示“未知”，绝不折算成 0 或无限。
 */
export function formatPercent(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return `${Math.round(value * 10) / 10}%`;
}

export function formatCount(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value.toLocaleString('zh-CN');
}

export function formatUsd(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

export function formatBoolean(value: boolean | null | undefined): string {
  if (value === true) return '是';
  if (value === false) return '否';
  return '未知';
}

/** 外链只接受 http/https；其他协议（javascript:、data: 等）一律拒绝打开。 */
export function externalHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.toString();
}

export function isExpiredAt(expiresAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!expiresAt) return false;
  const timestamp = Date.parse(expiresAt);
  if (Number.isNaN(timestamp)) return false;
  return timestamp <= now;
}

/** 账号在列表里的综合状态（只由上游真实字段推导，不引入额外含义）。 */
export function accountAvailabilityLabel(account: OAuthAccountSummaryData): {
  label: string;
  tone: 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'muted';
} {
  if (account.invalid) return { label: '凭据失效', tone: 'danger' };
  if (!account.available) {
    return { label: account.disabledUntil ? '冷却中' : '暂不可用', tone: 'warning' };
  }
  if (account.quotaLimited) return { label: '额度受限', tone: 'warning' };
  return { label: '可用', tone: 'success' };
}

/** 列表分页 meta（OAuthPageMeta）只在运行时读取：缺失即未知，不伪造 0。 */
export interface OAuthPageMetaView {
  page: number | null;
  pageSize: number | null;
  total: number | null;
  hasNext: boolean | null;
}

export function readPageMeta(meta: Record<string, unknown> | null | undefined): OAuthPageMetaView {
  const source = meta ?? {};
  return {
    page: typeof source.page === 'number' ? source.page : null,
    pageSize: typeof source.pageSize === 'number' ? source.pageSize : null,
    total: typeof source.total === 'number' ? source.total : null,
    hasNext: typeof source.hasNext === 'boolean' ? source.hasNext : null,
  };
}
