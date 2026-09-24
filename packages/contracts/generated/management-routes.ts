/* eslint-disable */
// 本文件由 scripts/generate-contracts.mjs 生成，请勿手改。

/** 上游管理 API 前缀（BFF 只在此前缀内工作）。 */
export const UPSTREAM_MANAGEMENT_PREFIX = '/api/management/v1' as const;

export type UpstreamRouteClass = 'proxy' | 'auth';

export interface FrozenUpstreamRoute {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly routeClass: UpstreamRouteClass;
  readonly bodyLimit: string | null;
  readonly note: string | null;
  readonly upstreamOperationId: string | null;
}

export const FROZEN_UPSTREAM_ROUTES: readonly FrozenUpstreamRoute[] = [
  {
    "method": "GET",
    "path": "/api/management/v1/meta",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": "版本/元信息与兼容性判断",
    "upstreamOperationId": "getManagementMetadata"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/capabilities",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": "能力矩阵，决定前端模块可用性",
    "upstreamOperationId": "getManagementCapabilities"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/operations/{operationId}",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": "异步任务查询",
    "upstreamOperationId": "getManagementOperation"
  },
  {
    "method": "DELETE",
    "path": "/api/management/v1/operations/{operationId}",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": "取消任务，仅 cancellable=true 时前端放行",
    "upstreamOperationId": "cancelManagementOperation"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/overview",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": "总览",
    "upstreamOperationId": "getManagementOverview"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/stats/summary",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "getStatsSummary"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/stats/breakdown",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "getStatsBreakdown"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/stats/recent-calls",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "listRecentCalls"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/stats/models/{modelId}",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "getModelStats"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/runtime/status",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "getRuntimeStatus"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/runtime/concurrency",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "getConcurrencySnapshot"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/runtime/cooldowns",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "listCooldowns"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/runtime/background-jobs",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "listBackgroundJobs"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/channels",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "listChannels"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/channels",
    "routeClass": "proxy",
    "bodyLimit": "1mb",
    "note": null,
    "upstreamOperationId": "createChannel"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/channels/{channelId}",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "getChannel"
  },
  {
    "method": "PATCH",
    "path": "/api/management/v1/channels/{channelId}",
    "routeClass": "proxy",
    "bodyLimit": "1mb",
    "note": null,
    "upstreamOperationId": "updateChannel"
  },
  {
    "method": "DELETE",
    "path": "/api/management/v1/channels/{channelId}",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "deleteChannel"
  },
  {
    "method": "PUT",
    "path": "/api/management/v1/channels/order",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "reorderChannels"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/channel-catalog",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": "新建渠道的供应商/协议目录",
    "upstreamOperationId": "getChannelCatalog"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/channel-drafts/probes",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": "新渠道草稿诊断（与既有渠道诊断是两个动作）",
    "upstreamOperationId": "probeChannelDraft"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/channel-model-discoveries",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": "新渠道模型发现",
    "upstreamOperationId": "discoverChannelModels"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/channels/{channelId}/diagnostic-probes",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "probeExistingChannel"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/channels/{channelId}/actions/refresh-usage",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "refreshChannelProviderUsage"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/channels/{channelId}/actions/clear-errors",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "clearChannelErrors"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/channels/{channelId}/actions/clear-affinity",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "clearChannelAffinity"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/channels/actions/clear-errors",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "clearAllChannelErrors"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/channels/actions/clear-affinity",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "clearAllChannelAffinity"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/channels/{channelId}/compatibility",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "getChannelCompatibility"
  },
  {
    "method": "PATCH",
    "path": "/api/management/v1/channels/{channelId}/compatibility",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "updateChannelCompatibility"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/oauth/accounts",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "listOAuthAccounts"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/oauth/accounts",
    "routeClass": "proxy",
    "bodyLimit": "1mb",
    "note": null,
    "upstreamOperationId": "createOAuthAccount"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/oauth/accounts/{accountId}",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "getOAuthAccount"
  },
  {
    "method": "PATCH",
    "path": "/api/management/v1/oauth/accounts/{accountId}",
    "routeClass": "proxy",
    "bodyLimit": "1mb",
    "note": null,
    "upstreamOperationId": "updateOAuthAccount"
  },
  {
    "method": "DELETE",
    "path": "/api/management/v1/oauth/accounts/{accountId}",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "deleteOAuthAccount"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/oauth/accounts/{accountId}/actions/refresh-token",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "refreshOAuthToken"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/oauth/accounts/{accountId}/actions/refresh-usage",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "refreshOAuthUsage"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/oauth/accounts/{accountId}/actions/clear-errors",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "clearOAuthAccountErrors"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/oauth/accounts/{accountId}/actions/clear-affinity",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "clearOAuthAccountAffinity"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/oauth/accounts/{accountId}/models",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "listOAuthAccountModels"
  },
  {
    "method": "PATCH",
    "path": "/api/management/v1/oauth/accounts/{accountId}/models",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "updateOAuthAccountModels"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/oauth/accounts/{accountId}/models/actions/sync",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "syncOAuthAccountModels"
  },
  {
    "method": "PATCH",
    "path": "/api/management/v1/oauth/accounts/{accountId}/models/settings",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "updateOAuthAccountModelSettings"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/oauth/actions/refresh-usage",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "refreshAllOAuthUsage"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/oauth/actions/clear-errors",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "clearAllOAuthErrors"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/oauth/invalid-accounts",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "listInvalidOAuthAccounts"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/oauth/settings",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "getOAuthSettings"
  },
  {
    "method": "PATCH",
    "path": "/api/management/v1/oauth/settings",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "updateOAuthSettings"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/oauth/login-flows",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": "发起 OAuth 登录",
    "upstreamOperationId": "startOAuthLoginFlow"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/oauth/login-flows/{flowId}/poll",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "pollOAuthLoginFlow"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/oauth/login-flows/{flowId}/complete",
    "routeClass": "proxy",
    "bodyLimit": "1mb",
    "note": null,
    "upstreamOperationId": "completeOAuthLoginFlow"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/oauth/login-flows/{flowId}/cancel",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "cancelOAuthLoginFlow"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/oauth/imports/preview",
    "routeClass": "proxy",
    "bodyLimit": "5mb",
    "note": "导入预览，OAuth 导入 body 单独限额",
    "upstreamOperationId": "previewOAuthImport"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/oauth/imports/{importId}/commit",
    "routeClass": "proxy",
    "bodyLimit": "5mb",
    "note": null,
    "upstreamOperationId": "commitOAuthImport"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/models",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "listModels"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/models/{resource_key}",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": "resourceKey 由服务端提供，前端不自行拼接",
    "upstreamOperationId": "getModel"
  },
  {
    "method": "PATCH",
    "path": "/api/management/v1/models/actions/state",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": "需要 If-Match revision",
    "upstreamOperationId": "setModelState"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/api-keys",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "listApiKeys"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/api-keys",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "createApiKey"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/api-keys/{keyId}",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "getApiKey"
  },
  {
    "method": "PATCH",
    "path": "/api/management/v1/api-keys/{keyId}",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "updateApiKey"
  },
  {
    "method": "DELETE",
    "path": "/api/management/v1/api-keys/{keyId}",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "deleteApiKey"
  },
  {
    "method": "PUT",
    "path": "/api/management/v1/api-keys/{keyId}/secret",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": "重置密钥，需要 plan/commit 时按真实流程",
    "upstreamOperationId": "replaceApiKeySecret"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/api-keys/{keyId}/actions/reset-limiter",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "resetApiKeyLimiter"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/api-keys/{keyId}/actions/generate-replacement-plan",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": "替换计划，MVP 仅查询计划",
    "upstreamOperationId": "planApiKeyRegeneration"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/api-keys/{keyId}/stats",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "getApiKeyStats"
  },
  {
    "method": "PUT",
    "path": "/api/management/v1/api-keys/order",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "reorderApiKeys"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/logs",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "listRequestLogs"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/logs/filter-options",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "getRequestLogFilterOptions"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/logs/{logId}",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "getRequestLog"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/logs/{logId}/body",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": "默认不加载，用户主动展开",
    "upstreamOperationId": "getRequestLogBody"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/logs/{logId}/body/items/{itemId}",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "getRequestLogBodyItem"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/logs/{logId}/raw-body",
    "routeClass": "proxy",
    "bodyLimit": null,
    "note": null,
    "upstreamOperationId": "getRequestLogRawBody"
  },
  {
    "method": "POST",
    "path": "/api/management/v1/auth/sessions",
    "routeClass": "auth",
    "bodyLimit": null,
    "note": "管理密钥换上游 Session，仅认证控制器可调用",
    "upstreamOperationId": "createManagementSession"
  },
  {
    "method": "GET",
    "path": "/api/management/v1/auth/session",
    "routeClass": "auth",
    "bodyLimit": null,
    "note": "会话摘要/idle 刷新",
    "upstreamOperationId": "getCurrentManagementSession"
  },
  {
    "method": "DELETE",
    "path": "/api/management/v1/auth/session",
    "routeClass": "auth",
    "bodyLimit": null,
    "note": "上游注销，仅注销控制器可调用",
    "upstreamOperationId": "revokeCurrentManagementSession"
  }
] as const;

/** 允许清单内的上游路径模板集合，供 BFF 构建匹配器使用。 */
export const FROZEN_ROUTE_COUNT = 76 as const;

/** 上游契约来源（冻结在构建产物中，随 /webui/bff/diagnostics 返回脱敏摘要）。 */
export const UPSTREAM_CONTRACT_SOURCE = {
  "repository": "https://github.com/danger-dream/Parrot",
  "commit": "9b73d058635470d59eef7a10876e6532649435d9",
  "commitSubject": "chore: 发布 v0.33.1",
  "release": "v0.33.1",
  "snapshotSha256": "ab552e2f3c80f6db368297ef50240b95a34ee3150687d6c3f161280ef870a5e2",
  "operationCount": 237,
  "pathCount": 175,
  "schemaCount": 495,
  "routerCount": 24,
  "openapiVersion": "3.1.0"
} as const;
