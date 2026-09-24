/**
 * OAuth 账号域的查询与变更 hooks。
 *
 * 只通过 @/api/hooks 的 useApiQuery / useApiMutation 访问 BFF（契约第 2 节）：
 * - 资源 ID 一律 encodeSegment；
 * - 有 revision 的资源在写入时回传 If-Match 原值；
 * - 变更成功后只失效本域的查询键；
 * - 202 只代表已受理，由调用方交给 useOperations().track 跟踪。
 */

import type { QueryKey } from '@tanstack/react-query';
import { encodeSegment } from '@/api/client';
import { useApiMutation, useApiQuery, type ApiMutationOptions } from '@/api/hooks';
import type {
  CommitOAuthImportRequest,
  CompleteOAuthLoginFlowRequest,
  ManagementOperationData,
  OAuthAccountDetailData,
  OAuthAccountFilter,
  OAuthAccountListData,
  OAuthAccountSort,
  OAuthAccountSummaryData,
  OAuthClearedCountData,
  OAuthImportCommitData,
  OAuthImportPreviewData,
  OAuthLoginFlowData,
  OAuthLoginPollData,
  OAuthModelListData,
  OAuthMutationData,
  OAuthProvider,
  OAuthSettingsData,
  PollOAuthLoginFlowRequest,
  PreviewOAuthImportRequest,
  StartOAuthLoginFlowRequest,
  UpdateOAuthAccountModelSettingsRequest,
  UpdateOAuthAccountModelsRequest,
  UpdateOAuthAccountRequest,
  UpdateOAuthSettingsRequest,
} from './oauthTypes';

const OAUTH_ROOT = 'oauth';

/** 账号相关的查询键前缀：任何账号写入后失效这些键（局部失效，不整站刷新）。 */
const ACCOUNT_KEYS: unknown[][] = [
  [OAUTH_ROOT, 'accounts'],
  [OAUTH_ROOT, 'account'],
  [OAUTH_ROOT, 'account-models'],
  [OAUTH_ROOT, 'invalid-accounts'],
  // 账号数量会影响总览统计（实施文档 7.2：业务 mutation 成功后刷新账号/渠道/模型/总览）。
  ['overview'],
];

export const oauthKeys = {
  accountsRoot: [OAUTH_ROOT, 'accounts'] as QueryKey,
  accountRoot: [OAUTH_ROOT, 'account'] as QueryKey,
  accountModelsRoot: [OAUTH_ROOT, 'account-models'] as QueryKey,
  invalidAccountsRoot: [OAUTH_ROOT, 'invalid-accounts'] as QueryKey,
  settingsRoot: [OAUTH_ROOT, 'settings'] as QueryKey,
  accounts: (params: AccountsListParams) => [OAUTH_ROOT, 'accounts', params] as QueryKey,
  account: (accountId: string) => [OAUTH_ROOT, 'account', accountId] as QueryKey,
  accountModels: (accountId: string, page: number, pageSize: number) =>
    [OAUTH_ROOT, 'account-models', accountId, { page, pageSize }] as QueryKey,
  invalidAccounts: (page: number, pageSize: number) =>
    [OAUTH_ROOT, 'invalid-accounts', { page, pageSize }] as QueryKey,
  settings: () => [OAUTH_ROOT, 'settings'] as QueryKey,
};

export interface AccountsListParams {
  filter: OAuthAccountFilter;
  provider: OAuthProvider | null;
  enabled: boolean | null;
  sort: OAuthAccountSort;
  page: number;
  pageSize: number;
}

// ------------------------------------------------------------------ 查询

/** 账号列表：只使用上游真实支持的过滤/排序参数。 */
export function useAccountsListQuery(params: AccountsListParams, refetchInterval?: number | false) {
  return useApiQuery<OAuthAccountListData>({
    key: oauthKeys.accounts(params),
    path: '/oauth/accounts',
    query: {
      filter: params.filter,
      provider: params.provider,
      enabled: params.enabled,
      sort: params.sort,
      page: params.page,
      pageSize: params.pageSize,
    },
    refetchInterval,
    staleTimeMs: 5_000,
  });
}

/** 账号详情：正文类重数据，不自动轮询。 */
export function useAccountDetailQuery(accountId: string | null) {
  return useApiQuery<OAuthAccountDetailData>({
    key: oauthKeys.account(accountId ?? ''),
    path: `/oauth/accounts/${encodeSegment(accountId ?? '')}`,
    enabled: Boolean(accountId),
    staleTimeMs: 5_000,
  });
}

export function useAccountModelsQuery(accountId: string | null, page: number, pageSize: number) {
  return useApiQuery<OAuthModelListData>({
    key: oauthKeys.accountModels(accountId ?? '', page, pageSize),
    path: `/oauth/accounts/${encodeSegment(accountId ?? '')}/models`,
    query: { page, pageSize },
    enabled: Boolean(accountId),
    staleTimeMs: 5_000,
  });
}

export function useInvalidAccountsQuery(page: number, pageSize: number) {
  return useApiQuery<OAuthAccountListData>({
    key: oauthKeys.invalidAccounts(page, pageSize),
    path: '/oauth/invalid-accounts',
    query: { page, pageSize },
    staleTimeMs: 5_000,
  });
}

export function useOAuthSettingsQuery() {
  return useApiQuery<OAuthSettingsData>({
    key: oauthKeys.settings(),
    path: '/oauth/settings',
    staleTimeMs: 5_000,
  });
}

// ------------------------------------------------------------------ 账号写入

export interface UpdateAccountInput {
  accountId: string;
  body: UpdateOAuthAccountRequest;
  /** 读到的原始 revision，原样回传 If-Match。 */
  ifMatch?: string;
}

export function useUpdateAccountMutation() {
  return useApiMutation<UpdateAccountInput, OAuthAccountDetailData>({
    method: 'PATCH',
    path: (input) => `/oauth/accounts/${encodeSegment(input.accountId)}`,
    body: (input) => input.body,
    ifMatch: (input) => input.ifMatch,
    invalidate: ACCOUNT_KEYS,
  });
}

export interface DeleteAccountInput {
  accountId: string;
  /** DELETE 的 If-Match 是必填（schema 要求）。 */
  ifMatch: string;
}

export function useDeleteAccountMutation() {
  return useApiMutation<DeleteAccountInput, null>({
    method: 'DELETE',
    path: (input) => `/oauth/accounts/${encodeSegment(input.accountId)}`,
    ifMatch: (input) => input.ifMatch,
    invalidate: ACCOUNT_KEYS,
  });
}

export interface AccountActionInput {
  accountId: string;
}

/** 刷新令牌：同步返回 OAuthMutationData（200），必须展示上游返回的 status。 */
export function useRefreshTokenMutation() {
  return useApiMutation<AccountActionInput, OAuthMutationData>({
    method: 'POST',
    path: (input) => `/oauth/accounts/${encodeSegment(input.accountId)}/actions/refresh-token`,
    body: () => ({}),
    invalidate: ACCOUNT_KEYS,
  });
}

/** 刷新用量（单个）：202 + operation，必须交给任务面板跟踪。 */
export function useRefreshUsageMutation() {
  return useApiMutation<AccountActionInput, ManagementOperationData>({
    method: 'POST',
    path: (input) => `/oauth/accounts/${encodeSegment(input.accountId)}/actions/refresh-usage`,
    body: () => ({}),
  });
}

export function useClearAccountErrorsMutation() {
  return useApiMutation<AccountActionInput, null>({
    method: 'POST',
    path: (input) => `/oauth/accounts/${encodeSegment(input.accountId)}/actions/clear-errors`,
    body: () => ({}),
    invalidate: ACCOUNT_KEYS,
  });
}

export function useClearAffinityMutation() {
  return useApiMutation<AccountActionInput, null>({
    method: 'POST',
    path: (input) => `/oauth/accounts/${encodeSegment(input.accountId)}/actions/clear-affinity`,
    body: () => ({}),
    invalidate: ACCOUNT_KEYS,
  });
}

/** 批量刷新用量：202 + operation（上游没有按选中集合批量的接口，作用范围是全部账号）。 */
export function useBatchRefreshUsageMutation() {
  return useApiMutation<Record<string, never>, ManagementOperationData>({
    method: 'POST',
    path: () => '/oauth/actions/refresh-usage',
    body: () => ({}),
  });
}

/** 批量清除错误：同步返回实际清除数量。 */
export function useBatchClearErrorsMutation() {
  return useApiMutation<Record<string, never>, OAuthClearedCountData>({
    method: 'POST',
    path: () => '/oauth/actions/clear-errors',
    body: () => ({}),
    invalidate: ACCOUNT_KEYS,
  });
}

// ------------------------------------------------------------------ 账号模型

export interface UpdateAccountModelsInput {
  accountId: string;
  body: UpdateOAuthAccountModelsRequest;
  ifMatch?: string;
}

export function useUpdateAccountModelsMutation() {
  return useApiMutation<UpdateAccountModelsInput, OAuthModelListData>({
    method: 'PATCH',
    path: (input) => `/oauth/accounts/${encodeSegment(input.accountId)}/models`,
    body: (input) => input.body,
    ifMatch: (input) => input.ifMatch,
    invalidate: ACCOUNT_KEYS,
  });
}

/** 同步账号模型：202 + operation；同步失败只影响模型列表，不代表授权失败。 */
export function useSyncAccountModelsMutation() {
  return useApiMutation<AccountActionInput, ManagementOperationData>({
    method: 'POST',
    path: (input) => `/oauth/accounts/${encodeSegment(input.accountId)}/models/actions/sync`,
    body: () => ({}),
  });
}

export interface UpdateModelSettingsInput {
  accountId: string;
  body: UpdateOAuthAccountModelSettingsRequest;
  ifMatch?: string;
}

export function useUpdateAccountModelSettingsMutation() {
  return useApiMutation<UpdateModelSettingsInput, OAuthModelListData>({
    method: 'PATCH',
    path: (input) => `/oauth/accounts/${encodeSegment(input.accountId)}/models/settings`,
    body: (input) => input.body,
    ifMatch: (input) => input.ifMatch,
    invalidate: ACCOUNT_KEYS,
  });
}

// ------------------------------------------------------------------ 登录流程

export function useStartLoginFlowMutation() {
  return useApiMutation<StartOAuthLoginFlowRequest, OAuthLoginFlowData>({
    method: 'POST',
    path: () => '/oauth/login-flows',
    body: (input) => input,
  });
}

export interface PollLoginFlowInput extends PollOAuthLoginFlowRequest {
  flowId: string;
}

/** 轮询：POST + body.flowSecret（不是 GET）。flowSecret 只在内存中传递。 */
export function usePollLoginFlowMutation() {
  return useApiMutation<PollLoginFlowInput, OAuthLoginPollData>({
    method: 'POST',
    path: (input) => `/oauth/login-flows/${encodeSegment(input.flowId)}/poll`,
    body: (input) => ({ flowSecret: input.flowSecret } satisfies PollOAuthLoginFlowRequest),
  });
}

export interface CompleteLoginFlowInput extends CompleteOAuthLoginFlowRequest {
  flowId: string;
}

export function useCompleteLoginFlowMutation() {
  return useApiMutation<CompleteLoginFlowInput, OAuthMutationData>({
    method: 'POST',
    path: (input) => `/oauth/login-flows/${encodeSegment(input.flowId)}/complete`,
    body: (input) => {
      // 只提交用户实际提供的字段；flowSecret 与 replacePlanToken 只走请求体。
      const { flowId: _flowId, ...rest } = input;
      return rest satisfies CompleteOAuthLoginFlowRequest;
    },
    invalidate: ACCOUNT_KEYS,
  });
}

export function useCancelLoginFlowMutation() {
  return useApiMutation<PollLoginFlowInput, null>({
    method: 'POST',
    path: (input) => `/oauth/login-flows/${encodeSegment(input.flowId)}/cancel`,
    body: (input) => ({ flowSecret: input.flowSecret } satisfies PollOAuthLoginFlowRequest),
  });
}

// ------------------------------------------------------------------ 导入

export function usePreviewImportMutation() {
  return useApiMutation<PreviewOAuthImportRequest, OAuthImportPreviewData>({
    method: 'POST',
    path: () => '/oauth/imports/preview',
    body: (input) => input,
  });
}

export interface CommitImportInput {
  importId: string;
  body: CommitOAuthImportRequest;
}

export function useCommitImportMutation() {
  return useApiMutation<CommitImportInput, OAuthImportCommitData>({
    method: 'POST',
    path: (input) => `/oauth/imports/${encodeSegment(input.importId)}/commit`,
    body: (input) => input.body,
    invalidate: ACCOUNT_KEYS,
  });
}

// ------------------------------------------------------------------ 相关设置

export interface UpdateOAuthSettingsInput {
  body: UpdateOAuthSettingsRequest;
  ifMatch?: string;
}

export function useUpdateOAuthSettingsMutation() {
  return useApiMutation<UpdateOAuthSettingsInput, OAuthSettingsData>({
    method: 'PATCH',
    path: () => '/oauth/settings',
    body: (input) => input.body,
    ifMatch: (input) => input.ifMatch,
    invalidate: [[OAUTH_ROOT, 'settings']],
  });
}

/** 供页面把「账号变更」写入后统一失效；避免页面自己拼查询键。 */
export const accountInvalidationKeys: unknown[][] = ACCOUNT_KEYS;

export type { OAuthAccountSummaryData };
