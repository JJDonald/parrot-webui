/* eslint-disable */
// 本文件由 scripts/generate-contracts.mjs 生成，请勿手改。

// 覆盖上游 schema 闭包中的 222 个模型（基线共 495 个）。
// 这里只生成 MVP 允许清单真正触及的类型；全量类型见 --full 模式。

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** 所有管理接口共用的成功信封。 */
export interface DataEnvelope<T> {
  data: T;
  meta: { requestId: string; [key: string]: unknown };
}

/** 上游业务错误信封（HTTP 4xx/5xx）。 */
export interface UpstreamErrorEnvelope {
  error: {
    code: string;
    message: string;
    fields: Array<{ path: string; code: string; message: string }>;
    retryable: boolean;
    requestId: string;
    operationId?: string | null;
  };
}

/**
 * ActionResultData
 */
export interface ActionResultData {
    affected: number;
    queued?: boolean | null;
  }

/**
 * ApiKeyConcurrencyRowData
 */
export interface ApiKeyConcurrencyRowData {
    enabled: boolean;
    enabledSource: string;
    inFlight: number;
    keyName: string;
    maxConcurrent: number;
    maxConcurrentSource: string;
    maxQueue: number;
    maxQueueSource: string;
    oldestWaitSeconds: number;
    queueWaitSeconds: number;
    queueWaitSource: string;
    unlimited: boolean;
    waiting: number;
  }

/**
 * ApiKeyCreateRequest
 * 来源：POST /api/management/v1/api-keys
 */
export interface ApiKeyCreateRequest {
    customSecret?: string | null;
    mode: ApiKeySource;
    name: string;
  }

/**
 * ApiKeyData
 */
export interface ApiKeyData {
    allowImages: boolean;
    allowMcp: boolean;
    allowVideos: boolean;
    allowedModels: string[];
    enabled: boolean;
    keyId: string;
    limitOverride: ApiKeyLimitOverrideData | null;
    limiter: ApiKeyLimiterData;
    maskedHint: string;
    mcpTools: "web_search" | "web_fetch" | "image_generate" | "image_edit" | "video_generate" | "video_status"[];
    modelStats: ApiKeyModelUsageData[];
    monthStats: ApiKeyUsageData;
    name: string;
    order: number;
    revision: string;
    source: ApiKeyProvenance;
  }

/**
 * ApiKeyEnabledFilter
 * 来源：GET /api/management/v1/api-keys
 */
export type ApiKeyEnabledFilter = "all" | "enabled" | "disabled";

/**
 * ApiKeyEnvelope
 * 来源：GET /api/management/v1/api-keys/{keyId}
 */
export interface ApiKeyEnvelope {
    data: ApiKeyData;
    meta: ResponseMeta;
  }

/**
 * ApiKeyLimitOverrideData
 */
export interface ApiKeyLimitOverrideData {
    enabled?: boolean | null;
    maxConcurrent?: number | null;
    maxQueue?: number | null;
    queueWaitSeconds?: number | null;
  }

/**
 * ApiKeyLimitOverridePatch
 */
export interface ApiKeyLimitOverridePatch {
    enabled?: boolean | null;
    maxConcurrent?: number | null;
    maxQueue?: number | null;
    queueWaitSeconds?: number | null;
  }

/**
 * ApiKeyLimiterData
 */
export interface ApiKeyLimiterData {
    enabled: boolean;
    enabledSource: "key" | "global";
    inFlight: number;
    maxConcurrent: number;
    maxConcurrentSource: "key" | "global";
    maxQueue: number;
    maxQueueSource: "key" | "global";
    oldestWaitSeconds: number;
    queueWaitSeconds: number;
    queueWaitSource: "key" | "global";
    unlimited: boolean;
    waiting: number;
  }

/**
 * ApiKeyLimiterEnvelope
 * 来源：POST /api/management/v1/api-keys/{keyId}/actions/reset-limiter
 */
export interface ApiKeyLimiterEnvelope {
    data: ApiKeyLimiterData;
    meta: ResponseMeta;
  }

/**
 * ApiKeyLimiterTotalsData
 */
export interface ApiKeyLimiterTotalsData {
    inFlight?: number;
    trackedKeys?: number;
    waiting?: number;
  }

/**
 * ApiKeyListData
 */
export interface ApiKeyListData {
    items: ApiKeyData[];
  }

/**
 * ApiKeyListEnvelope
 * 来源：GET /api/management/v1/api-keys
 */
export interface ApiKeyListEnvelope {
    data: ApiKeyListData;
    meta: ApiKeyListMeta;
  }

/**
 * ApiKeyListMeta
 */
export interface ApiKeyListMeta {
    hasNext: boolean;
    page: number;
    pageSize: number;
    requestId: string;
    revision: string;
    total: number;
  }

/**
 * ApiKeyModelUsageData
 */
export interface ApiKeyModelUsageData {
    model: string;
    usage: ApiKeyUsageData;
  }

/**
 * ApiKeyOrderData
 */
export interface ApiKeyOrderData {
    keyIds: string[];
    revision: string;
  }

/**
 * ApiKeyOrderEnvelope
 * 来源：PUT /api/management/v1/api-keys/order
 */
export interface ApiKeyOrderEnvelope {
    data: ApiKeyOrderData;
    meta: ResponseMeta;
  }

/**
 * ApiKeyOrderRequest
 * 来源：PUT /api/management/v1/api-keys/order
 */
export interface ApiKeyOrderRequest {
    keyIds: string[];
  }

/** Persisted source; old entries without evidence remain explicitly unknown. */
/**
 * ApiKeyProvenance
 * 来源：GET /api/management/v1/api-keys
 */
export type ApiKeyProvenance = "generated" | "custom" | "unknown";

/**
 * ApiKeyReplaceSecretRequest
 * 来源：PUT /api/management/v1/api-keys/{keyId}/secret
 */
export interface ApiKeyReplaceSecretRequest {
    customSecret: string;
  }

/**
 * ApiKeyReplacementPlanData
 */
export interface ApiKeyReplacementPlanData {
    expiresAt: string;
    impact: string;
    keyId: string;
    planId: string;
    planToken: string;
    revision: string;
  }

/**
 * ApiKeyReplacementPlanEnvelope
 * 来源：POST /api/management/v1/api-keys/{keyId}/actions/generate-replacement-plan
 */
export interface ApiKeyReplacementPlanEnvelope {
    data: ApiKeyReplacementPlanData;
    meta: ResponseMeta;
  }

/**
 * ApiKeySecretData
 */
export interface ApiKeySecretData {
    apiKey: ApiKeyData;
    secret: string;
  }

/**
 * ApiKeySecretEnvelope
 * 来源：POST /api/management/v1/api-keys
 */
export interface ApiKeySecretEnvelope {
    data: ApiKeySecretData;
    meta: ResponseMeta;
  }

/**
 * ApiKeySort
 * 来源：GET /api/management/v1/api-keys
 */
export type ApiKeySort = "orderAsc" | "orderDesc" | "nameAsc" | "nameDesc" | "monthCallsDesc";

/** Creation/replacement mode for newly observed secret material. */
/**
 * ApiKeySource
 */
export type ApiKeySource = "generated" | "custom";

/**
 * ApiKeyStatsData
 */
export interface ApiKeyStatsData {
    byModel: ApiKeyModelUsageData[];
    keyId: string;
    overall: ApiKeyUsageData;
    revision: string;
    since: string;
  }

/**
 * ApiKeyStatsEnvelope
 * 来源：GET /api/management/v1/api-keys/{keyId}/stats
 */
export interface ApiKeyStatsEnvelope {
    data: ApiKeyStatsData;
    meta: ResponseMeta;
  }

/**
 * ApiKeyUpdateRequest
 * 来源：PATCH /api/management/v1/api-keys/{keyId}
 */
export interface ApiKeyUpdateRequest {
    allowImages?: boolean | null;
    allowMcp?: boolean | null;
    allowVideos?: boolean | null;
    allowedModels?: string[] | null;
    enabled?: boolean | null;
    limitOverride?: ApiKeyLimitOverridePatch | null;
    mcpTools?: "web_search" | "web_fetch" | "image_generate" | "image_edit" | "video_generate" | "video_status"[] | null;
  }

/**
 * ApiKeyUsageData
 */
export interface ApiKeyUsageData {
    actualCostTicks: number;
    averageTps?: number | null;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    costTicks: number;
    costedSuccess: number;
    errorCount: number;
    estimatedCostTicks: number;
    inputTokens: number;
    maximumTps?: number | null;
    minimumTps?: number | null;
    outputTokens: number;
    successCount: number;
    total: number;
    unpricedSuccess: number;
  }

/**
 * AuthMethod
 */
export type AuthMethod = "managementKey" | "telegramApproval" | "telegramAdmin";

/**
 * BackgroundJobData
 */
export interface BackgroundJobData {
    error?: string | null;
    id: string;
    intervalSeconds?: number | null;
    lastRunAt?: string | null;
    nextRunAt?: string | null;
    revision: string;
    status: "running" | "succeeded" | "failed" | "unknown" | "disabled";
  }

/**
 * BodySort
 * 来源：GET /api/management/v1/logs/{logId}/body
 */
export type BodySort = "original" | "reverse" | "size" | "type";

/**
 * Capability
 */
export type Capability = "management.read" | "management.write" | "management.secrets.write" | "management.destructive" | "management.update" | "management.logs.body.read";

/**
 * CapabilityDomain
 */
export interface CapabilityDomain {
    actionDetails: ManagementActionDescriptor[];
    actions: string[];
    capabilities: Capability[];
    domain: string;
    features: string[];
    modes: string[];
    presets: string[];
    protocols: string[];
    providers: string[];
  }

/**
 * CatalogProtocolEndpointData
 */
export interface CatalogProtocolEndpointData {
    endpoint: string;
    protocol: ChannelProtocol;
  }

/**
 * CchMode
 */
export type CchMode = "disabled" | "dynamic";

/**
 * ChannelCatalogData
 */
export interface ChannelCatalogData {
    compatibilityModes: CompatibilityMode[];
    features: string[];
    protocols: ChannelProtocol[];
    providers: ChannelProviderData[];
  }

/**
 * ChannelCompatibilityData
 */
export interface ChannelCompatibilityData {
    context1m: CompatibilityFeatureData;
    fast: CompatibilityFeatureData;
    revision: string;
  }

/**
 * ChannelCompatibilityInput
 * 来源：PATCH /api/management/v1/channels/{channelId}/compatibility
 */
export interface ChannelCompatibilityInput {
    context1m?: CompatibilityFeatureInput;
    fast?: CompatibilityFeatureInput;
  }

/**
 * ChannelConcurrencyRowData
 */
export interface ChannelConcurrencyRowData {
    channelKey: string;
    inFlight: number;
    maxConcurrent: number;
    unlimited: boolean;
    waiting: number;
  }

/**
 * ChannelCooldownData
 */
export interface ChannelCooldownData {
    errorCount: number;
    message?: string | null;
    model: string;
    quota: boolean;
    state: "active" | "permanent";
    until?: string | null;
  }

/**
 * ChannelData
 */
export interface ChannelData {
    affinityCount: number;
    apiKeyConfigured: boolean;
    apiKeyMaskedHint?: string | null;
    apiPath?: string | null;
    baseUrl: string;
    ccMimicry: boolean;
    clientAffinityCount: number;
    compatibility: ChannelCompatibilityData;
    cooldownCount: number;
    disabledReason?: string | null;
    enabled: boolean;
    health: ChannelHealth;
    id: string;
    maxConcurrent: number;
    modelCount: number;
    models: ChannelModelData[];
    name: string;
    omitTemperature: boolean;
    omitThinking: boolean;
    protocol: ChannelProtocol;
    providerId?: string | null;
    providerPresetId?: string | null;
    providerUsage: ProviderUsageData;
    recentSuccessRate?: number | null;
    revision: string;
    url: string;
  }

/**
 * ChannelDetailData
 */
export interface ChannelDetailData {
    affinityCount: number;
    apiKeyConfigured: boolean;
    apiKeyMaskedHint?: string | null;
    apiPath?: string | null;
    baseUrl: string;
    ccMimicry: boolean;
    clientAffinityCount: number;
    compatibility: ChannelCompatibilityData;
    cooldownCount: number;
    disabledReason?: string | null;
    enabled: boolean;
    health: ChannelHealth;
    id: string;
    maxConcurrent: number;
    modelCount: number;
    modelStats: ChannelModelStatsData[];
    models: ChannelModelData[];
    monthStats: ChannelMonthStatsData;
    name: string;
    omitTemperature: boolean;
    omitThinking: boolean;
    protocol: ChannelProtocol;
    providerId?: string | null;
    providerPresetId?: string | null;
    providerUsage: ProviderUsageData;
    recentSuccessRate?: number | null;
    revision: string;
    runtimeModels: ChannelRuntimeModelData[];
    url: string;
  }

/**
 * ChannelHealth
 * 来源：GET /api/management/v1/channels
 */
export type ChannelHealth = "disabled" | "permanentCooldown" | "quotaCooldown" | "cooldown" | "healthy" | "degraded" | "unhealthy" | "unknown";

/**
 * ChannelLimiterTotalsData
 */
export interface ChannelLimiterTotalsData {
    inFlight?: number;
    trackedChannels?: number;
    waiting?: number;
  }

/**
 * ChannelListEnvelope
 * 来源：GET /api/management/v1/channels
 */
export interface ChannelListEnvelope {
    data: ChannelData[];
    meta: ChannelPageMeta;
  }

/**
 * ChannelModelData
 */
export interface ChannelModelData {
    alias: string;
    real: string;
  }

/**
 * ChannelModelInput
 */
export interface ChannelModelInput {
    alias: string;
    real: string;
  }

/**
 * ChannelModelStatsData
 */
export interface ChannelModelStatsData {
    actualCostTicks: number;
    actualCostedSuccess: number;
    averageTokensPerSecond?: number | null;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    costTicks: number;
    costedSuccess: number;
    errorCount: number;
    estimatedCostTicks: number;
    estimatedCostedSuccess: number;
    finalModel: string;
    inputTokens: number;
    maximumTokensPerSecond?: number | null;
    minimumTokensPerSecond?: number | null;
    outputTokens: number;
    successCount: number;
    total: number;
    unpricedSuccess: number;
  }

/**
 * ChannelMonthStatsData
 */
export interface ChannelMonthStatsData {
    averageTokensPerSecond?: number | null;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    cost?: string | null;
    errorCount: number;
    inputTokens: number;
    maximumTokensPerSecond?: number | null;
    minimumTokensPerSecond?: number | null;
    outputTokens: number;
    successCount: number;
    total: number;
  }

/**
 * ChannelOrderData
 */
export interface ChannelOrderData {
    channelIds: string[];
    revision: string;
  }

/**
 * ChannelOrderRequest
 * 来源：PUT /api/management/v1/channels/order
 */
export interface ChannelOrderRequest {
    channelIds: string[];
  }

/**
 * ChannelPageMeta
 */
export interface ChannelPageMeta {
    hasNext: boolean;
    orderRevision: string;
    page: number;
    pageSize: number;
    requestId: string;
    total: number;
  }

/**
 * ChannelPresetData
 */
export interface ChannelPresetData {
    ccMimicry: boolean;
    id: string;
    modelDiscoveryAuth: string;
    modelDiscoveryParser: string;
    modelsUrlConfigured: boolean;
    name: string;
    protocols: CatalogProtocolEndpointData[];
    providerUsageSupported: boolean;
    staticModels: string[];
  }

/**
 * ChannelProtocol
 * 来源：GET /api/management/v1/channels
 */
export type ChannelProtocol = "anthropic" | "openai-chat" | "openai-responses";

/**
 * ChannelProviderData
 */
export interface ChannelProviderData {
    id: string;
    name: string;
    presets: ChannelPresetData[];
  }

/**
 * ChannelRuntimeModelData
 */
export interface ChannelRuntimeModelData {
    alias: string;
    averageConnectMilliseconds?: number | null;
    averageFirstByteMilliseconds?: number | null;
    cooldownKind?: "permanent" | "quota" | "temporary" | null;
    cooldownUntil?: string | null;
    errorCount: number;
    real: string;
    recentRequests: number;
    recentSuccessRate?: number | null;
    score?: number | null;
    totalRequests: number;
  }

/**
 * ChannelSort
 * 来源：GET /api/management/v1/channels
 */
export type ChannelSort = "name" | "enabled" | "health" | "protocol" | "provider" | "modelCount" | "order";

/**
 * ChannelStatusData
 */
export interface ChannelStatusData {
    cooldownCount: number;
    cooldowns: ChannelCooldownData[];
    disabledReason?: string | null;
    enabled: boolean;
    health: "disabled" | "permanentCooldown" | "quotaCooldown" | "cooldown" | "healthy" | "degraded" | "unhealthy" | "unknown";
    id: string;
    name: string;
    permanentCooldownCount: number;
    problemReasons: string[];
    protocol: string;
    recentSuccessRate?: number | null;
    type: string;
  }

/**
 * ChannelUpdateRequest
 * 来源：PATCH /api/management/v1/channels/{channelId}
 */
export interface ChannelUpdateRequest {
    apiKey?: string | null;
    apiPath?: string | null;
    baseUrl?: string | null;
    ccMimicry?: boolean | null;
    compatibility?: ChannelCompatibilityInput | null;
    enabled?: boolean | null;
    maxConcurrent?: number | null;
    models?: ChannelModelInput[] | null;
    name?: string | null;
    omitTemperature?: boolean | null;
    omitThinking?: boolean | null;
    protocol?: ChannelProtocol | null;
    providerId?: string | null;
    providerPresetId?: string | null;
  }

/**
 * CommitOAuthImportRequest
 * 来源：POST /api/management/v1/oauth/imports/{importId}/commit
 */
export interface CommitOAuthImportRequest {
    decisions: OAuthImportDecisionRequest[];
    importSecret: string;
  }

/**
 * CompatibilityFeatureData
 */
export interface CompatibilityFeatureData {
    allModels: boolean;
    mode: CompatibilityMode;
    models: string[];
  }

/**
 * CompatibilityFeatureInput
 */
export interface CompatibilityFeatureInput {
    mode?: CompatibilityMode;
    models?: string[];
  }

/**
 * CompatibilityMode
 */
export type CompatibilityMode = "auto" | "force";

/**
 * CompleteOAuthLoginFlowRequest
 * 来源：POST /api/management/v1/oauth/login-flows/{flowId}/complete
 */
export interface CompleteOAuthLoginFlowRequest {
    callbackUrl?: string | null;
    code?: string | null;
    completed?: boolean | null;
    flowSecret?: string | null;
    replacePlanToken?: string | null;
    state?: string | null;
  }

/**
 * ConcurrencyData
 */
export interface ConcurrencyData {
    apiKeyTotals: ApiKeyLimiterTotalsData;
    apiKeys: ApiKeyConcurrencyRowData[];
    channelTotals: ChannelLimiterTotalsData;
    channels: ChannelConcurrencyRowData[];
    revision: string;
  }

/**
 * CooldownData
 */
export interface CooldownData {
    channelId: string;
    errorCount: number;
    message?: string | null;
    model: string;
    revision: string;
    state: "active" | "permanent";
    until?: string | null;
  }

/**
 * CreateOAuthAccountRequest
 * 来源：POST /api/management/v1/oauth/accounts
 */
export interface CreateOAuthAccountRequest {
    credential: ManualOAuthCredential | JsonOAuthCredential | RefreshTokenOAuthCredential;
    replacePlanToken?: string | null;
  }

/**
 * DataEnvelope_ActionResultData_
 * 来源：POST /api/management/v1/channels/{channelId}/actions/clear-errors
 */
export interface DataEnvelope_ActionResultData_ {
    data: ActionResultData;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_ChannelCatalogData_
 * 来源：GET /api/management/v1/channel-catalog
 */
export interface DataEnvelope_ChannelCatalogData_ {
    data: ChannelCatalogData;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_ChannelCompatibilityData_
 * 来源：GET /api/management/v1/channels/{channelId}/compatibility
 */
export interface DataEnvelope_ChannelCompatibilityData_ {
    data: ChannelCompatibilityData;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_ChannelData_
 * 来源：POST /api/management/v1/channels
 */
export interface DataEnvelope_ChannelData_ {
    data: ChannelData;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_ChannelDetailData_
 * 来源：GET /api/management/v1/channels/{channelId}
 */
export interface DataEnvelope_ChannelDetailData_ {
    data: ChannelDetailData;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_ChannelOrderData_
 * 来源：PUT /api/management/v1/channels/order
 */
export interface DataEnvelope_ChannelOrderData_ {
    data: ChannelOrderData;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_ConcurrencyData_
 * 来源：GET /api/management/v1/runtime/concurrency
 */
export interface DataEnvelope_ConcurrencyData_ {
    data: ConcurrencyData;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_LogBodyItemData_
 * 来源：GET /api/management/v1/logs/{logId}/body/items/{itemId}
 */
export interface DataEnvelope_LogBodyItemData_ {
    data: LogBodyItemData;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_ManagementCapabilitiesData_
 * 来源：GET /api/management/v1/capabilities
 */
export interface DataEnvelope_ManagementCapabilitiesData_ {
    data: ManagementCapabilitiesData;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_ManagementMetadataData_
 * 来源：GET /api/management/v1/meta
 */
export interface DataEnvelope_ManagementMetadataData_ {
    data: ManagementMetadataData;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_ManagementOperationData_
 * 来源：GET /api/management/v1/operations/{operationId}
 */
export interface DataEnvelope_ManagementOperationData_ {
    data: ManagementOperationData;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_ModelStatsData_
 * 来源：GET /api/management/v1/stats/models/{modelId}
 */
export interface DataEnvelope_ModelStatsData_ {
    data: ModelStatsData;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_OAuthAccountDetailData_
 * 来源：GET /api/management/v1/oauth/accounts/{accountId}
 */
export interface DataEnvelope_OAuthAccountDetailData_ {
    data: OAuthAccountDetailData;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_OAuthClearedCountData_
 * 来源：POST /api/management/v1/oauth/actions/clear-errors
 */
export interface DataEnvelope_OAuthClearedCountData_ {
    data: OAuthClearedCountData;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_OAuthImportCommitData_
 * 来源：POST /api/management/v1/oauth/imports/{importId}/commit
 */
export interface DataEnvelope_OAuthImportCommitData_ {
    data: OAuthImportCommitData;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_OAuthImportPreviewData_
 * 来源：POST /api/management/v1/oauth/imports/preview
 */
export interface DataEnvelope_OAuthImportPreviewData_ {
    data: OAuthImportPreviewData;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_OAuthLoginFlowData_
 * 来源：POST /api/management/v1/oauth/login-flows
 */
export interface DataEnvelope_OAuthLoginFlowData_ {
    data: OAuthLoginFlowData;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_OAuthLoginPollData_
 * 来源：POST /api/management/v1/oauth/login-flows/{flowId}/poll
 */
export interface DataEnvelope_OAuthLoginPollData_ {
    data: OAuthLoginPollData;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_OAuthMutationData_
 * 来源：POST /api/management/v1/oauth/accounts
 */
export interface DataEnvelope_OAuthMutationData_ {
    data: OAuthMutationData;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_OAuthSettingsData_
 * 来源：GET /api/management/v1/oauth/settings
 */
export interface DataEnvelope_OAuthSettingsData_ {
    data: OAuthSettingsData;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_OverviewData_
 * 来源：GET /api/management/v1/overview
 */
export interface DataEnvelope_OverviewData_ {
    data: OverviewData;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_RawLogBodyData_
 * 来源：GET /api/management/v1/logs/{logId}/raw-body
 */
export interface DataEnvelope_RawLogBodyData_ {
    data: RawLogBodyData;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_RequestLogDetailData_
 * 来源：GET /api/management/v1/logs/{logId}
 */
export interface DataEnvelope_RequestLogDetailData_ {
    data: RequestLogDetailData;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_RequestLogFilterOptionsData_
 * 来源：GET /api/management/v1/logs/filter-options
 */
export interface DataEnvelope_RequestLogFilterOptionsData_ {
    data: RequestLogFilterOptionsData;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_RuntimeStatusData_
 * 来源：GET /api/management/v1/runtime/status
 */
export interface DataEnvelope_RuntimeStatusData_ {
    data: RuntimeStatusData;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_SessionCredentialData_
 * 来源：POST /api/management/v1/auth/sessions
 */
export interface DataEnvelope_SessionCredentialData_ {
    data: SessionCredentialData;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_SessionSummary_
 * 来源：GET /api/management/v1/auth/session
 */
export interface DataEnvelope_SessionSummary_ {
    data: SessionSummary;
    meta: ResponseMeta;
  }

/**
 * DataEnvelope_StatsSummaryData_
 * 来源：GET /api/management/v1/stats/summary
 */
export interface DataEnvelope_StatsSummaryData_ {
    data: StatsSummaryData;
    meta: ResponseMeta;
  }

/**
 * DraftChannelDiscoveryRequest
 * 来源：POST /api/management/v1/channel-model-discoveries
 */
export interface DraftChannelDiscoveryRequest {
    apiKey: string;
    apiPath?: string | null;
    baseUrl: string;
    protocol: ChannelProtocol;
    providerId?: string | null;
    providerPresetId?: string | null;
    source: "draft";
  }

/**
 * EnumDescriptor
 */
export interface EnumDescriptor {
    name: string;
    values: string[];
  }

/**
 * ErrorDetailSchema
 */
export interface ErrorDetailSchema {
    code: ManagementErrorCode;
    fields: ErrorFieldSchema[];
    message: string;
    operationId?: string | null;
    requestId: string;
    retryable: boolean;
  }

/**
 * ErrorEnvelope
 * 来源：GET /api/management/v1/meta
 */
export interface ErrorEnvelope {
    error: ErrorDetailSchema;
  }

/**
 * ErrorFieldSchema
 */
export interface ErrorFieldSchema {
    code: string;
    message: string;
    path: string;
  }

/**
 * ExistingChannelDiscoveryRequest
 * 来源：POST /api/management/v1/channel-model-discoveries
 */
export interface ExistingChannelDiscoveryRequest {
    channelId: string;
    source: "existing";
  }

/**
 * FastestChannelData
 */
export interface FastestChannelData {
    averageFirstByteMilliseconds?: number | null;
    channelId: string;
    model: string;
    score: number;
    successRate: number;
  }

/**
 * FilterOptionData
 */
export interface FilterOptionData {
    count: number;
    value: string;
  }

/**
 * JsonOAuthCredential
 */
export interface JsonOAuthCredential {
    kind: "json";
    payload: string;
    provider: "claude" | "openai" | "xai" | "cursor" | "antigravity";
  }

/**
 * JsonValue
 */
export type JsonValue = Record<string, unknown>;

/**
 * ListenerSummary
 */
export interface ListenerSummary {
    host: string;
    port: number;
  }

/**
 * LogBodyItemData
 */
export interface LogBodyItemData {
    id?: string | null;
    kind: string;
    meta: Record<string, JsonValue>;
    raw: string;
    revision: string;
    seq: number;
    size: number;
    summary: string;
    text: string;
    title: string;
  }

/**
 * LogBodyKind
 * 来源：GET /api/management/v1/logs/{logId}/body
 */
export type LogBodyKind = "request" | "response";

/**
 * LogBodyKindCountData
 */
export interface LogBodyKindCountData {
    count: number;
    kind: string;
  }

/**
 * LogBodyPagedEnvelope
 * 来源：GET /api/management/v1/logs/{logId}/body
 */
export interface LogBodyPagedEnvelope {
    data: LogBodyItemData[];
    meta: LogBodyPagedResponseMeta;
  }

/**
 * LogBodyPagedResponseMeta
 */
export interface LogBodyPagedResponseMeta {
    hasNext: boolean;
    kindCounts: LogBodyKindCountData[];
    page: number;
    pageSize: number;
    requestId: string;
    revision: string;
    total: number;
  }

/**
 * ManagementActionDescriptor
 */
export interface ManagementActionDescriptor {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    operationId: string;
    path: string;
  }

/**
 * ManagementCapabilitiesData
 */
export interface ManagementCapabilitiesData {
    domains: CapabilityDomain[];
    principalCapabilities: Capability[];
    supportedCapabilities: Capability[];
  }

/**
 * ManagementErrorCode
 */
export type ManagementErrorCode = "INVALID_REQUEST" | "CONFIRMATION_REQUIRED" | "INVALID_OPERATION_STATE" | "SESSION_REQUIRED" | "SESSION_EXPIRED" | "AUTHENTICATION_FAILED" | "CAPABILITY_DENIED" | "ORIGIN_DENIED" | "RESOURCE_NOT_FOUND" | "OPERATION_NOT_FOUND" | "RESOURCE_CONFLICT" | "IDENTITY_CONFLICT" | "REVISION_CONFLICT" | "STATE_CONFLICT" | "VALIDATION_FAILED" | "UNSUPPORTED_VALUE" | "RATE_LIMITED" | "OPERATION_ALREADY_RUNNING" | "UPSTREAM_ERROR" | "SERVICE_NOT_READY" | "DEPENDENCY_UNAVAILABLE" | "UPSTREAM_TIMEOUT";

/**
 * ManagementFeatureDescriptor
 */
export interface ManagementFeatureDescriptor {
    actionCount: number;
    id: string;
  }

/**
 * ManagementKeyGrant
 * 来源：POST /api/management/v1/auth/sessions
 */
export interface ManagementKeyGrant {
    grantType: "managementKey";
    managementKey: string;
  }

/**
 * ManagementMetadataData
 */
export interface ManagementMetadataData {
    apiVersion: string;
    applicationVersion: string;
    documentationUrl: string;
    enums: EnumDescriptor[];
    features: ManagementFeatureDescriptor[];
    principalCapabilities: Capability[];
    supportedCapabilities: Capability[];
  }

/**
 * ManagementOperationData
 */
export interface ManagementOperationData {
    cancellable: boolean;
    createdAt: string;
    error: OperationErrorData | null;
    finishedAt: string | null;
    id: string;
    kind: string;
    progress: OperationProgressData | null;
    result: JsonValue | null;
    startedAt: string | null;
    status: OperationStatus;
  }

/**
 * ManualChannelCreateRequest
 * 来源：POST /api/management/v1/channels
 */
export interface ManualChannelCreateRequest {
    apiKey: string;
    apiPath?: string | null;
    baseUrl: string;
    ccMimicry?: boolean | null;
    compatibility?: ChannelCompatibilityInput;
    enabled?: boolean;
    maxConcurrent?: number;
    mode: "manual";
    models: ChannelModelInput[];
    name: string;
    omitTemperature?: boolean;
    omitThinking?: boolean;
    protocol: ChannelProtocol;
  }

/**
 * ManualOAuthCredential
 */
export interface ManualOAuthCredential {
    accessToken: string;
    displayName?: string | null;
    email?: string;
    expiresAt?: string | null;
    identitySubject?: string | null;
    kind: "manual";
    projectId?: string | null;
    provider: "claude" | "openai" | "xai" | "cursor" | "antigravity";
    refreshToken: string;
    workspaceId?: string | null;
  }

/**
 * ModelData
 */
export interface ModelData {
    aliases?: string[];
    commonMetadata?: Record<string, unknown>;
    editable: boolean;
    globalEnabled?: boolean | null;
    identity: ModelIdentityData;
    modelId: string;
    resourceKey: string;
    revision: string;
    sourceCount: number;
    sources?: ModelSourceData[];
    visible?: boolean | null;
  }

/**
 * ModelEnvelope
 * 来源：GET /api/management/v1/models/{resource_key}
 */
export interface ModelEnvelope {
    data: ModelData;
    meta: ResponseMeta;
  }

/**
 * ModelFilterRequest
 */
export interface ModelFilterRequest {
    sourceId?: string | null;
    sourceType?: ModelSourceType | null;
    status?: ModelStatus[];
    text?: string | null;
    type?: ModelKind[];
  }

/**
 * ModelIdentityData
 */
export interface ModelIdentityData {
    modelId: string;
    owner?: ModelOwnerData | null;
    provider?: string | null;
    type: ModelKind;
  }

/**
 * ModelKind
 * 来源：GET /api/management/v1/models
 */
export type ModelKind = "chat" | "image" | "video";

/**
 * ModelListEnvelope
 * 来源：GET /api/management/v1/models
 */
export interface ModelListEnvelope {
    data: ModelData[];
    meta: ModelListMeta;
  }

/**
 * ModelListMeta
 */
export interface ModelListMeta {
    hasNext: boolean;
    page: number;
    pageSize: number;
    requestId: string;
    revision: string;
    total: number;
  }

/**
 * ModelOwnerData
 */
export interface ModelOwnerData {
    id?: string | null;
    type: ModelSourceType;
  }

/**
 * ModelSelectionRequest
 */
export interface ModelSelectionRequest {
    excludedModelIds?: string[];
    filter?: ModelFilterRequest | null;
    mode: "ids" | "filter";
    modelIds?: string[];
  }

/**
 * ModelSourceData
 */
export interface ModelSourceData {
    constrainedBy: Record<string, string[]>;
    containerEnabled: boolean;
    effectiveMetadata: Record<string, unknown>;
    effectiveRoutable: boolean;
    id: string;
    label: string;
    outboundModel: string;
    provider: string;
    sourceEnabled: boolean;
    type: ModelSourceType;
    unavailableReason?: string | null;
    valueSource: Record<string, string>;
  }

/**
 * ModelSourceRequest
 */
export interface ModelSourceRequest {
    id?: string | null;
    type: ModelSourceType;
  }

/**
 * ModelSourceType
 * 来源：GET /api/management/v1/models
 */
export type ModelSourceType = "global" | "oauth" | "api";

/**
 * ModelStateData
 */
export interface ModelStateData {
    items: ModelStateItemData[];
    revision: string;
  }

/**
 * ModelStateEnvelope
 * 来源：PATCH /api/management/v1/models/actions/state
 */
export interface ModelStateEnvelope {
    data: ModelStateData;
    meta: ResponseMeta;
  }

/**
 * ModelStateItemData
 */
export interface ModelStateItemData {
    modelId: string;
    status: "updated" | "unchanged";
  }

/**
 * ModelStateRequest
 * 来源：PATCH /api/management/v1/models/actions/state
 */
export interface ModelStateRequest {
    scope: ModelSourceRequest;
    selection: ModelSelectionRequest;
    target: ModelStateTargetRequest;
  }

/**
 * ModelStateTargetRequest
 */
export interface ModelStateTargetRequest {
    enabled?: boolean | null;
    visible?: boolean | null;
  }

/**
 * ModelStatsChannelData
 */
export interface ModelStatsChannelData {
    count: number;
    key: string;
    type?: string | null;
    upstreamProtocol?: string | null;
  }

/**
 * ModelStatsData
 */
export interface ModelStatsData {
    channels: ModelStatsChannelData[];
    metrics: StatsMetricData;
    modelId: string;
    period: "today" | "3d" | "7d" | "month" | "lifetime";
    revision: string;
  }

/**
 * ModelStatus
 * 来源：GET /api/management/v1/models
 */
export type ModelStatus = "enabled" | "disabled" | "visible" | "hidden";

/**
 * OAuthAccountDetailData
 */
export interface OAuthAccountDetailData {
    account: OAuthAccountSummaryData;
    credentialConfigured: boolean;
    expiresAt?: string | null;
    lastModelSync?: string | null;
    localStats: OAuthLocalStatsData;
    planType?: string | null;
    runtimeErrors: OAuthRuntimeErrorData[];
    usageWindows: OAuthUsageWindowData[];
    workbuddy?: Record<string, unknown> | null;
    workspaceId?: string | null;
    workspaceName?: string | null;
  }

/**
 * OAuthAccountFilter
 * 来源：GET /api/management/v1/oauth/accounts
 */
export type OAuthAccountFilter = "all" | "available" | "quota" | "invalid";

/**
 * OAuthAccountListData
 */
export interface OAuthAccountListData {
    items: OAuthAccountSummaryData[];
    revision: string;
  }

/**
 * OAuthAccountListEnvelope
 * 来源：GET /api/management/v1/oauth/accounts
 */
export interface OAuthAccountListEnvelope {
    data: OAuthAccountListData;
    meta: OAuthPageMeta;
  }

/**
 * OAuthAccountSort
 * 来源：GET /api/management/v1/oauth/accounts
 */
export type OAuthAccountSort = "configured" | "displayName" | "provider" | "status";

/**
 * OAuthAccountSummaryData
 */
export interface OAuthAccountSummaryData {
    accountId: string;
    available: boolean;
    credentialConfigured?: boolean;
    disabledModelCount: number;
    disabledReason?: string | null;
    disabledUntil?: string | null;
    displayName: string;
    enabled: boolean;
    identity: string;
    invalid: boolean;
    maxConcurrent: number;
    modelCount: number;
    provider: OAuthProvider;
    quotaLimited: boolean;
    revision: string;
  }

/**
 * OAuthClearedCountData
 */
export interface OAuthClearedCountData {
    cleared: number;
  }

/**
 * OAuthIdentityConflictEnvelope
 * 来源：POST /api/management/v1/oauth/accounts
 */
export interface OAuthIdentityConflictEnvelope {
    conflict: OAuthReplaceConflictData;
    error: ErrorDetailSchema;
  }

/**
 * OAuthImportCandidateData
 */
export interface OAuthImportCandidateData {
    candidateId: string;
    conflictAccountId?: string | null;
    displayName: string;
    identity: string;
    provider: OAuthProvider;
  }

/**
 * OAuthImportCommitData
 */
export interface OAuthImportCommitData {
    added: string[];
    replaced: string[];
    skipped: string[];
  }

/**
 * OAuthImportDecisionRequest
 */
export interface OAuthImportDecisionRequest {
    action: "keep" | "overwrite";
    candidateId: string;
  }

/**
 * OAuthImportPreviewData
 */
export interface OAuthImportPreviewData {
    candidates: OAuthImportCandidateData[];
    errors: OAuthImportProblemData[];
    expiresAt: string;
    importId: string;
    importSecret: string;
  }

/**
 * OAuthImportProblemData
 */
export interface OAuthImportProblemData {
    code: string;
    index?: number | null;
    message: string;
  }

/**
 * OAuthLocalStatsData
 */
export interface OAuthLocalStatsData {
    costUsd?: number | null;
    inputTokens: number;
    outputTokens: number;
    requestCount: number;
  }

/**
 * OAuthLoginFlowData
 */
export interface OAuthLoginFlowData {
    authUrl?: string | null;
    expiresAt: string;
    flowId: string;
    flowSecret: string;
    instruction?: string | null;
    provider: OAuthProvider;
  }

/**
 * OAuthLoginPollData
 */
export interface OAuthLoginPollData {
    accountId?: string | null;
    accountPreview?: Record<string, unknown> | null;
    expiresAt: string;
    flowId: string;
    revision?: string | null;
    saveStatus?: "created" | "replaced" | null;
    status: "pending" | "identity_pending" | "ready" | "completed" | "cancelled" | "expired";
  }

/**
 * OAuthModelData
 */
export interface OAuthModelData {
    contextWindow?: number | null;
    cooldownPermanent: boolean;
    cooldownUntil?: string | null;
    disabled: boolean;
    maxContextDefault?: boolean | null;
    maxContextWindow?: number | null;
    maxInputTokens?: number | null;
    maxOutputTokens?: number | null;
    metadataSource?: string | null;
    modelId: string;
    name: string;
    reasoningEfforts?: string[];
    serviceTier?: string | null;
  }

/**
 * OAuthModelListData
 */
export interface OAuthModelListData {
    items: OAuthModelData[];
    revision: string;
  }

/**
 * OAuthModelListEnvelope
 * 来源：GET /api/management/v1/oauth/accounts/{accountId}/models
 */
export interface OAuthModelListEnvelope {
    data: OAuthModelListData;
    meta: OAuthPageMeta;
  }

/**
 * OAuthMutationData
 */
export interface OAuthMutationData {
    accountId: string;
    revision: string;
    status: string;
  }

/**
 * OAuthOperationEnvelope
 * 来源：POST /api/management/v1/oauth/accounts/{accountId}/actions/refresh-usage
 */
export interface OAuthOperationEnvelope {
    data: ManagementOperationData;
    meta: OAuthRequestMeta;
  }

/**
 * OAuthPageMeta
 */
export interface OAuthPageMeta {
    hasNext: boolean;
    page: number;
    pageSize: number;
    requestId: string;
    total: number;
  }

/**
 * OAuthProvider
 * 来源：GET /api/management/v1/oauth/accounts
 */
export type OAuthProvider = "claude" | "cursor" | "openai" | "xai" | "antigravity" | "workbuddy";

/**
 * OAuthReplaceConflictData
 */
export interface OAuthReplaceConflictData {
    accountId: string;
    replacePlanToken: string;
  }

/**
 * OAuthRequestMeta
 */
export interface OAuthRequestMeta {
    requestId: string;
  }

/**
 * OAuthRuntimeErrorData
 */
export interface OAuthRuntimeErrorData {
    cooldownPermanent: boolean;
    cooldownUntil?: string | null;
    message?: string | null;
    modelId?: string | null;
  }

/**
 * OAuthSettingsData
 */
export interface OAuthSettingsData {
    antigravityTlsFingerprintEnabled: boolean;
    cchMode: CchMode;
    quotaMonitor: QuotaMonitorData;
    revision: string;
  }

/**
 * OAuthUsageWindowData
 */
export interface OAuthUsageWindowData {
    name: string;
    remainingPercent?: number | null;
    resetsAt?: string | null;
    usedPercent?: number | null;
  }

/**
 * OperationErrorData
 */
export interface OperationErrorData {
    code: ManagementErrorCode;
    message: string;
    retryable: boolean;
  }

/**
 * OperationProgressData
 */
export interface OperationProgressData {
    current: number;
    messageCode: string;
    total: number;
  }

/**
 * OperationStatus
 */
export type OperationStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/**
 * OverviewData
 */
export interface OverviewData {
    activeAlerts: Record<string, JsonValue>;
    counts: ResourceCounts;
    lifetime: Record<string, JsonValue>;
    listeners: ListenerSummary;
    revision: string;
    today: Record<string, JsonValue>;
    uptimeSeconds: number;
    version: string;
  }

/**
 * PagedEnvelope_RequestLogData_
 * 来源：GET /api/management/v1/logs
 */
export interface PagedEnvelope_RequestLogData_ {
    data: RequestLogData[];
    meta: PagedResponseMeta;
  }

/**
 * PagedResponseMeta
 */
export interface PagedResponseMeta {
    hasNext: boolean;
    page: number;
    pageSize: number;
    requestId: string;
    total: number;
  }

/**
 * PollOAuthLoginFlowRequest
 * 来源：POST /api/management/v1/oauth/login-flows/{flowId}/poll
 */
export interface PollOAuthLoginFlowRequest {
    flowSecret: string;
  }

/**
 * PresetChannelCreateRequest
 * 来源：POST /api/management/v1/channels
 */
export interface PresetChannelCreateRequest {
    apiKey: string;
    ccMimicry?: boolean | null;
    compatibility?: ChannelCompatibilityInput;
    enabled?: boolean;
    maxConcurrent?: number;
    mode: "preset";
    models: ChannelModelInput[];
    name: string;
    omitTemperature?: boolean;
    omitThinking?: boolean;
    protocol: ChannelProtocol;
    providerId: string;
    providerPresetId: string;
  }

/**
 * PreviewOAuthImportRequest
 * 来源：POST /api/management/v1/oauth/imports/preview
 */
export interface PreviewOAuthImportRequest {
    filename?: string | null;
    format: "openai" | "cpa" | "sub2api";
    payload: string;
    payloadEncoding?: "json" | "base64";
  }

/**
 * ProbeDraftRequest
 * 来源：POST /api/management/v1/channel-drafts/probes
 */
export interface ProbeDraftRequest {
    apiKey: string;
    apiPath?: string | null;
    baseUrl: string;
    ccMimicry?: boolean | null;
    model: string;
    name?: string;
    protocol: ChannelProtocol;
    providerId?: string | null;
    providerPresetId?: string | null;
  }

/**
 * ProbeExistingRequest
 * 来源：POST /api/management/v1/channels/{channelId}/diagnostic-probes
 */
export interface ProbeExistingRequest {
    model: string;
  }

/**
 * ProviderUsageData
 */
export interface ProviderUsageData {
    error?: string | null;
    errorAt?: string | null;
    fetchedAt?: string | null;
    partial: boolean;
    snapshot?: ProviderUsageSnapshotData | null;
    source?: string | null;
    stale: boolean;
    status: string;
    supported: boolean;
  }

/**
 * ProviderUsageMetricData
 */
export interface ProviderUsageMetricData {
    currency?: string | null;
    distributionTotal?: string | null;
    endAt?: string | null;
    group?: string | null;
    id?: string | null;
    kind?: string | null;
    label: string;
    remaining?: string | null;
    resetAt?: string | null;
    resetInSeconds?: number | null;
    startAt?: string | null;
    status?: string | null;
    total?: string | null;
    unit?: string | null;
    used?: string | null;
    usedPercent?: number | null;
    value?: string | null;
  }

/**
 * ProviderUsageSnapshotData
 */
export interface ProviderUsageSnapshotData {
    balances: ProviderUsageMetricData[];
    counters: ProviderUsageMetricData[];
    notices: string[];
    partial: boolean;
    source: string;
    version: number;
    windows: ProviderUsageMetricData[];
  }

/**
 * QuotaMetricData
 */
export interface QuotaMetricData {
    utilizationPercent: number;
    window: string;
  }

/**
 * QuotaMonitorData
 */
export interface QuotaMonitorData {
    enabled: boolean;
    intervalSeconds: number;
    thresholdPercent: number;
  }

/**
 * QuotaWarningData
 */
export interface QuotaWarningData {
    accountId: string;
    metrics: QuotaMetricData[];
    provider: string;
  }

/**
 * RawLogBodyData
 */
export interface RawLogBodyData {
    body: JsonValue;
    kind: "request" | "response";
    logId: string;
    revision: string;
  }

/**
 * RecentCallData
 */
export interface RecentCallData {
    channelId?: string | null;
    createdAt?: string | null;
    durationMilliseconds?: number | null;
    id: string;
    model?: string | null;
    revision: string;
    status: string;
  }

/**
 * RefreshTokenOAuthCredential
 */
export interface RefreshTokenOAuthCredential {
    emailHint?: string | null;
    kind: "refreshToken";
    provider: "claude" | "openai" | "xai" | "cursor" | "antigravity";
    refreshToken: string;
  }

/**
 * RequestLogBillingData
 */
export interface RequestLogBillingData {
    actualCostTicks: number;
    actualCostedSuccess: number;
    costTicks: number;
    costedSuccess: number;
    estimatedCostTicks: number;
    estimatedCostedSuccess: number;
    unpricedSuccess: number;
  }

/**
 * RequestLogData
 */
export interface RequestLogData {
    apiKeyName?: string | null;
    billing: RequestLogBillingData;
    channelId?: string | null;
    costTicks: number;
    createdAt?: string | null;
    durationMilliseconds?: number | null;
    error?: string | null;
    finalModel?: string | null;
    id: string;
    inputTokens: number;
    outputTokens: number;
    protocol?: string | null;
    requestedModel?: string | null;
    retryCount: number;
    revision: string;
    status: string;
    transport?: string | null;
  }

/**
 * RequestLogDetailData
 */
export interface RequestLogDetailData {
    attempts: Record<string, JsonValue>[];
    billingAttempts: Record<string, JsonValue>[];
    id: string;
    localWebRounds: Record<string, JsonValue>[];
    log: RequestLogData;
    requestBodyAvailable: boolean;
    requestHeadersAvailable: boolean;
    responseBodyAvailable: boolean;
    revision: string;
    stages: Record<string, JsonValue>[];
  }

/**
 * RequestLogFilterOptionsData
 */
export interface RequestLogFilterOptionsData {
    apiKeys: FilterOptionData[];
    channels: FilterOptionData[];
    models: FilterOptionData[];
    protocols: FilterOptionData[];
    revision: string;
    statuses: FilterOptionData[];
  }

/**
 * RequestLogSort
 * 来源：GET /api/management/v1/logs
 */
export type RequestLogSort = "createdAt" | "status" | "latency" | "model";

/**
 * RequestLogStatus
 * 来源：GET /api/management/v1/logs
 */
export type RequestLogStatus = "success" | "error" | "cancelled" | "pending";

/**
 * RequestProtocol
 * 来源：GET /api/management/v1/logs
 */
export type RequestProtocol = "anthropic" | "chat" | "responses" | "responses_ws";

/**
 * ResourceCounts
 */
export interface ResourceCounts {
    apiKeys: number;
    channels: number;
    oauthAccounts: number;
    quotaHot: number;
  }

/**
 * ResponseMeta
 */
export interface ResponseMeta {
    requestId: string;
  }

/**
 * RevisionedPagedEnvelope_BackgroundJobData_
 * 来源：GET /api/management/v1/runtime/background-jobs
 */
export interface RevisionedPagedEnvelope_BackgroundJobData_ {
    data: BackgroundJobData[];
    meta: RevisionedPagedResponseMeta;
  }

/**
 * RevisionedPagedEnvelope_CooldownData_
 * 来源：GET /api/management/v1/runtime/cooldowns
 */
export interface RevisionedPagedEnvelope_CooldownData_ {
    data: CooldownData[];
    meta: RevisionedPagedResponseMeta;
  }

/**
 * RevisionedPagedEnvelope_RecentCallData_
 * 来源：GET /api/management/v1/stats/recent-calls
 */
export interface RevisionedPagedEnvelope_RecentCallData_ {
    data: RecentCallData[];
    meta: RevisionedPagedResponseMeta;
  }

/**
 * RevisionedPagedEnvelope_StatsBreakdownData_
 * 来源：GET /api/management/v1/stats/breakdown
 */
export interface RevisionedPagedEnvelope_StatsBreakdownData_ {
    data: StatsBreakdownData[];
    meta: RevisionedPagedResponseMeta;
  }

/**
 * RevisionedPagedResponseMeta
 */
export interface RevisionedPagedResponseMeta {
    hasNext: boolean;
    page: number;
    pageSize: number;
    requestId: string;
    revision: string;
    total: number;
  }

/**
 * Role
 */
export type Role = "administrator";

/**
 * RuntimeStatusData
 */
export interface RuntimeStatusData {
    affinitySummary: Record<string, number>;
    channels: ChannelStatusData[];
    concurrency: ConcurrencyData;
    cooldownSummary: Record<string, number>;
    database: Record<string, JsonValue>;
    fastestByFamily: Record<string, FastestChannelData[]>;
    problemChannels: ChannelStatusData[];
    quotaWarnings: QuotaWarningData[];
    revision: string;
  }

/**
 * SessionCredentialData
 */
export interface SessionCredentialData {
    credential: string;
    session: SessionSummary;
  }

/**
 * SessionSummary
 */
export interface SessionSummary {
    authMethod: AuthMethod;
    capabilities: Capability[];
    expiresAt: string;
    idleExpiresAt: string;
    issuedAt: string;
    roles: Role[];
    sessionId: string;
    subjectId: string;
  }

/**
 * SortDirection
 * 来源：GET /api/management/v1/channels
 */
export type SortDirection = "asc" | "desc";

/**
 * StartOAuthLoginFlowRequest
 * 来源：POST /api/management/v1/oauth/login-flows
 */
export interface StartOAuthLoginFlowRequest {
    clientProfile?: "cli" | "ide" | null;
    provider: OAuthProvider;
    realm?: "cn" | "global" | null;
  }

/**
 * StatsBreakdownData
 */
export interface StatsBreakdownData {
    key: string;
    metrics: StatsMetricData;
    revision: string;
  }

/**
 * StatsDimension
 * 来源：GET /api/management/v1/stats/breakdown
 */
export type StatsDimension = "channel" | "model" | "apiKey";

/**
 * StatsMetricData
 */
export interface StatsMetricData {
    actualCostTicks?: number;
    actualCostedSuccess?: number;
    affinityHits?: number;
    averageConnectMilliseconds?: number | null;
    averageFirstTokenMilliseconds?: number | null;
    averageTokensPerSecond?: number | null;
    averageTotalMilliseconds?: number | null;
    cacheCreationTokens?: number;
    cacheHitRequests?: number;
    cacheReadTokens?: number;
    cacheWriteRequests?: number;
    costTicks?: number;
    costedSuccess?: number;
    errorCount?: number;
    estimatedCostTicks?: number;
    estimatedCostedSuccess?: number;
    inputTokens?: number;
    maximumTokensPerSecond?: number | null;
    minimumTokensPerSecond?: number | null;
    outputTokens?: number;
    pendingCount?: number;
    retriedRequests?: number;
    serviceTierCounts?: Record<string, number>;
    successCount?: number;
    total?: number;
    totalRetries?: number;
    unpricedSuccess?: number;
  }

/**
 * StatsPeriod
 * 来源：GET /api/management/v1/stats/summary
 */
export type StatsPeriod = "today" | "3d" | "7d" | "month" | "lifetime";

/**
 * StatsSort
 * 来源：GET /api/management/v1/stats/breakdown
 */
export type StatsSort = "total" | "success" | "tokens" | "cost" | "latency" | "tps" | "name";

/**
 * StatsSummaryData
 */
export interface StatsSummaryData {
    families: Record<string, StatsMetricData>;
    overall: StatsMetricData;
    period: "today" | "3d" | "7d" | "month" | "lifetime";
    revision: string;
  }

/**
 * TelegramApprovalGrant
 * 来源：POST /api/management/v1/auth/sessions
 */
export interface TelegramApprovalGrant {
    approvalId: string;
    exchangeSecret: string;
    grantType: "telegramApproval";
  }

/**
 * UpdateOAuthAccountModelSettingsRequest
 * 来源：PATCH /api/management/v1/oauth/accounts/{accountId}/models/settings
 */
export interface UpdateOAuthAccountModelSettingsRequest {
    maxContextDefault: boolean;
    modelId: string;
  }

/**
 * UpdateOAuthAccountModelsRequest
 * 来源：PATCH /api/management/v1/oauth/accounts/{accountId}/models
 */
export interface UpdateOAuthAccountModelsRequest {
    disabled: boolean;
    modelIds: string[];
  }

/**
 * UpdateOAuthAccountRequest
 * 来源：PATCH /api/management/v1/oauth/accounts/{accountId}
 */
export interface UpdateOAuthAccountRequest {
    displayName?: string | null;
    enabled?: boolean | null;
    maxConcurrent?: number | null;
  }

/**
 * UpdateOAuthSettingsRequest
 * 来源：PATCH /api/management/v1/oauth/settings
 */
export interface UpdateOAuthSettingsRequest {
    antigravityTlsFingerprintEnabled?: boolean | null;
    cchMode?: CchMode | null;
    quotaMonitor?: UpdateQuotaMonitorRequest | null;
  }

/**
 * UpdateQuotaMonitorRequest
 */
export interface UpdateQuotaMonitorRequest {
    enabled?: boolean | null;
    intervalSeconds?: number | null;
    thresholdPercent?: number | null;
  }


/** 允许清单内每个上游操作的契约摘要，便于前端与 BFF 共用同一份事实。 */
export interface UpstreamMvpOperations {
  /** Get Management Metadata */
  "GET /api/management/v1/meta": {
    method: "GET";
    path: "/api/management/v1/meta";
    successStatus: "200";
    successType: DataEnvelope_ManagementMetadataData_;
    requestType: never;
    parameterNames: [];
  };
  /** Get Management Capabilities */
  "GET /api/management/v1/capabilities": {
    method: "GET";
    path: "/api/management/v1/capabilities";
    successStatus: "200";
    successType: DataEnvelope_ManagementCapabilitiesData_;
    requestType: never;
    parameterNames: [];
  };
  /** Get Management Operation */
  "GET /api/management/v1/operations/{operationId}": {
    method: "GET";
    path: "/api/management/v1/operations/{operationId}";
    successStatus: "200";
    successType: DataEnvelope_ManagementOperationData_;
    requestType: never;
    parameterNames: ["operationId"];
  };
  /** Cancel Management Operation */
  "DELETE /api/management/v1/operations/{operationId}": {
    method: "DELETE";
    path: "/api/management/v1/operations/{operationId}";
    successStatus: "204";
    successType: void;
    requestType: never;
    parameterNames: ["operationId"];
  };
  /** Get Management Overview */
  "GET /api/management/v1/overview": {
    method: "GET";
    path: "/api/management/v1/overview";
    successStatus: "200";
    successType: DataEnvelope_OverviewData_;
    requestType: never;
    parameterNames: [];
  };
  /** Get Stats Summary */
  "GET /api/management/v1/stats/summary": {
    method: "GET";
    path: "/api/management/v1/stats/summary";
    successStatus: "200";
    successType: DataEnvelope_StatsSummaryData_;
    requestType: never;
    parameterNames: ["period"];
  };
  /** Get Stats Breakdown */
  "GET /api/management/v1/stats/breakdown": {
    method: "GET";
    path: "/api/management/v1/stats/breakdown";
    successStatus: "200";
    successType: RevisionedPagedEnvelope_StatsBreakdownData_;
    requestType: never;
    parameterNames: ["dimension","period","sort","descending","page","pageSize"];
  };
  /** List Recent Calls */
  "GET /api/management/v1/stats/recent-calls": {
    method: "GET";
    path: "/api/management/v1/stats/recent-calls";
    successStatus: "200";
    successType: RevisionedPagedEnvelope_RecentCallData_;
    requestType: never;
    parameterNames: ["page","pageSize"];
  };
  /** Get Model Stats */
  "GET /api/management/v1/stats/models/{modelId}": {
    method: "GET";
    path: "/api/management/v1/stats/models/{modelId}";
    successStatus: "200";
    successType: DataEnvelope_ModelStatsData_;
    requestType: never;
    parameterNames: ["modelId","period"];
  };
  /** Get Runtime Status */
  "GET /api/management/v1/runtime/status": {
    method: "GET";
    path: "/api/management/v1/runtime/status";
    successStatus: "200";
    successType: DataEnvelope_RuntimeStatusData_;
    requestType: never;
    parameterNames: [];
  };
  /** Get Concurrency Snapshot */
  "GET /api/management/v1/runtime/concurrency": {
    method: "GET";
    path: "/api/management/v1/runtime/concurrency";
    successStatus: "200";
    successType: DataEnvelope_ConcurrencyData_;
    requestType: never;
    parameterNames: [];
  };
  /** List Cooldowns */
  "GET /api/management/v1/runtime/cooldowns": {
    method: "GET";
    path: "/api/management/v1/runtime/cooldowns";
    successStatus: "200";
    successType: RevisionedPagedEnvelope_CooldownData_;
    requestType: never;
    parameterNames: ["page","pageSize"];
  };
  /** List Background Jobs */
  "GET /api/management/v1/runtime/background-jobs": {
    method: "GET";
    path: "/api/management/v1/runtime/background-jobs";
    successStatus: "200";
    successType: RevisionedPagedEnvelope_BackgroundJobData_;
    requestType: never;
    parameterNames: ["page","pageSize"];
  };
  /** List Channels */
  "GET /api/management/v1/channels": {
    method: "GET";
    path: "/api/management/v1/channels";
    successStatus: "200";
    successType: ChannelListEnvelope;
    requestType: never;
    parameterNames: ["page","pageSize","search","enabled","protocol","providerId","health","sort","direction"];
  };
  /** Create Channel */
  "POST /api/management/v1/channels": {
    method: "POST";
    path: "/api/management/v1/channels";
    successStatus: "201";
    successType: DataEnvelope_ChannelData_;
    requestType: ManualChannelCreateRequest | PresetChannelCreateRequest;
    parameterNames: [];
  };
  /** Get Channel */
  "GET /api/management/v1/channels/{channelId}": {
    method: "GET";
    path: "/api/management/v1/channels/{channelId}";
    successStatus: "200";
    successType: DataEnvelope_ChannelDetailData_;
    requestType: never;
    parameterNames: ["channelId"];
  };
  /** Update Channel */
  "PATCH /api/management/v1/channels/{channelId}": {
    method: "PATCH";
    path: "/api/management/v1/channels/{channelId}";
    successStatus: "200";
    successType: DataEnvelope_ChannelData_;
    requestType: ChannelUpdateRequest;
    parameterNames: ["channelId","If-Match"];
  };
  /** Delete Channel */
  "DELETE /api/management/v1/channels/{channelId}": {
    method: "DELETE";
    path: "/api/management/v1/channels/{channelId}";
    successStatus: "204";
    successType: void;
    requestType: never;
    parameterNames: ["channelId","If-Match"];
  };
  /** Reorder Channels */
  "PUT /api/management/v1/channels/order": {
    method: "PUT";
    path: "/api/management/v1/channels/order";
    successStatus: "200";
    successType: DataEnvelope_ChannelOrderData_;
    requestType: ChannelOrderRequest;
    parameterNames: ["If-Match"];
  };
  /** Get Channel Catalog */
  "GET /api/management/v1/channel-catalog": {
    method: "GET";
    path: "/api/management/v1/channel-catalog";
    successStatus: "200";
    successType: DataEnvelope_ChannelCatalogData_;
    requestType: never;
    parameterNames: [];
  };
  /** Probe Channel Draft */
  "POST /api/management/v1/channel-drafts/probes": {
    method: "POST";
    path: "/api/management/v1/channel-drafts/probes";
    successStatus: "202";
    successType: DataEnvelope_ManagementOperationData_;
    requestType: ProbeDraftRequest;
    parameterNames: [];
  };
  /** Discover Channel Models */
  "POST /api/management/v1/channel-model-discoveries": {
    method: "POST";
    path: "/api/management/v1/channel-model-discoveries";
    successStatus: "202";
    successType: DataEnvelope_ManagementOperationData_;
    requestType: ExistingChannelDiscoveryRequest | DraftChannelDiscoveryRequest;
    parameterNames: [];
  };
  /** Probe Existing Channel */
  "POST /api/management/v1/channels/{channelId}/diagnostic-probes": {
    method: "POST";
    path: "/api/management/v1/channels/{channelId}/diagnostic-probes";
    successStatus: "202";
    successType: DataEnvelope_ManagementOperationData_;
    requestType: ProbeExistingRequest;
    parameterNames: ["channelId"];
  };
  /** Refresh Channel Provider Usage */
  "POST /api/management/v1/channels/{channelId}/actions/refresh-usage": {
    method: "POST";
    path: "/api/management/v1/channels/{channelId}/actions/refresh-usage";
    successStatus: "202";
    successType: DataEnvelope_ManagementOperationData_;
    requestType: never;
    parameterNames: ["channelId"];
  };
  /** Clear Channel Errors */
  "POST /api/management/v1/channels/{channelId}/actions/clear-errors": {
    method: "POST";
    path: "/api/management/v1/channels/{channelId}/actions/clear-errors";
    successStatus: "200";
    successType: DataEnvelope_ActionResultData_;
    requestType: never;
    parameterNames: ["channelId"];
  };
  /** Clear Channel Affinity */
  "POST /api/management/v1/channels/{channelId}/actions/clear-affinity": {
    method: "POST";
    path: "/api/management/v1/channels/{channelId}/actions/clear-affinity";
    successStatus: "200";
    successType: DataEnvelope_ActionResultData_;
    requestType: never;
    parameterNames: ["channelId"];
  };
  /** Clear All Channel Errors */
  "POST /api/management/v1/channels/actions/clear-errors": {
    method: "POST";
    path: "/api/management/v1/channels/actions/clear-errors";
    successStatus: "200";
    successType: DataEnvelope_ActionResultData_;
    requestType: never;
    parameterNames: [];
  };
  /** Clear All Channel Affinity */
  "POST /api/management/v1/channels/actions/clear-affinity": {
    method: "POST";
    path: "/api/management/v1/channels/actions/clear-affinity";
    successStatus: "200";
    successType: DataEnvelope_ActionResultData_;
    requestType: never;
    parameterNames: [];
  };
  /** Get Channel Compatibility */
  "GET /api/management/v1/channels/{channelId}/compatibility": {
    method: "GET";
    path: "/api/management/v1/channels/{channelId}/compatibility";
    successStatus: "200";
    successType: DataEnvelope_ChannelCompatibilityData_;
    requestType: never;
    parameterNames: ["channelId"];
  };
  /** Update Channel Compatibility */
  "PATCH /api/management/v1/channels/{channelId}/compatibility": {
    method: "PATCH";
    path: "/api/management/v1/channels/{channelId}/compatibility";
    successStatus: "200";
    successType: DataEnvelope_ChannelCompatibilityData_;
    requestType: ChannelCompatibilityInput;
    parameterNames: ["channelId","If-Match"];
  };
  /** List Oauth Accounts */
  "GET /api/management/v1/oauth/accounts": {
    method: "GET";
    path: "/api/management/v1/oauth/accounts";
    successStatus: "200";
    successType: OAuthAccountListEnvelope;
    requestType: never;
    parameterNames: ["filter","provider","enabled","sort","page","pageSize"];
  };
  /** Create Oauth Account */
  "POST /api/management/v1/oauth/accounts": {
    method: "POST";
    path: "/api/management/v1/oauth/accounts";
    successStatus: "201";
    successType: DataEnvelope_OAuthMutationData_;
    requestType: CreateOAuthAccountRequest;
    parameterNames: [];
  };
  /** Get Oauth Account */
  "GET /api/management/v1/oauth/accounts/{accountId}": {
    method: "GET";
    path: "/api/management/v1/oauth/accounts/{accountId}";
    successStatus: "200";
    successType: DataEnvelope_OAuthAccountDetailData_;
    requestType: never;
    parameterNames: ["accountId"];
  };
  /** Update Oauth Account */
  "PATCH /api/management/v1/oauth/accounts/{accountId}": {
    method: "PATCH";
    path: "/api/management/v1/oauth/accounts/{accountId}";
    successStatus: "200";
    successType: DataEnvelope_OAuthAccountDetailData_;
    requestType: UpdateOAuthAccountRequest;
    parameterNames: ["accountId","If-Match"];
  };
  /** Delete Oauth Account */
  "DELETE /api/management/v1/oauth/accounts/{accountId}": {
    method: "DELETE";
    path: "/api/management/v1/oauth/accounts/{accountId}";
    successStatus: "204";
    successType: void;
    requestType: never;
    parameterNames: ["accountId","If-Match"];
  };
  /** Refresh Oauth Token */
  "POST /api/management/v1/oauth/accounts/{accountId}/actions/refresh-token": {
    method: "POST";
    path: "/api/management/v1/oauth/accounts/{accountId}/actions/refresh-token";
    successStatus: "200";
    successType: DataEnvelope_OAuthMutationData_;
    requestType: never;
    parameterNames: ["accountId"];
  };
  /** Refresh Oauth Usage */
  "POST /api/management/v1/oauth/accounts/{accountId}/actions/refresh-usage": {
    method: "POST";
    path: "/api/management/v1/oauth/accounts/{accountId}/actions/refresh-usage";
    successStatus: "202";
    successType: OAuthOperationEnvelope;
    requestType: never;
    parameterNames: ["accountId"];
  };
  /** Clear Oauth Account Errors */
  "POST /api/management/v1/oauth/accounts/{accountId}/actions/clear-errors": {
    method: "POST";
    path: "/api/management/v1/oauth/accounts/{accountId}/actions/clear-errors";
    successStatus: "204";
    successType: void;
    requestType: never;
    parameterNames: ["accountId"];
  };
  /** Clear Oauth Account Affinity */
  "POST /api/management/v1/oauth/accounts/{accountId}/actions/clear-affinity": {
    method: "POST";
    path: "/api/management/v1/oauth/accounts/{accountId}/actions/clear-affinity";
    successStatus: "204";
    successType: void;
    requestType: never;
    parameterNames: ["accountId"];
  };
  /** List Oauth Accountmodels */
  "GET /api/management/v1/oauth/accounts/{accountId}/models": {
    method: "GET";
    path: "/api/management/v1/oauth/accounts/{accountId}/models";
    successStatus: "200";
    successType: OAuthModelListEnvelope;
    requestType: never;
    parameterNames: ["accountId","page","pageSize"];
  };
  /** Update Oauth Accountmodels */
  "PATCH /api/management/v1/oauth/accounts/{accountId}/models": {
    method: "PATCH";
    path: "/api/management/v1/oauth/accounts/{accountId}/models";
    successStatus: "200";
    successType: OAuthModelListEnvelope;
    requestType: UpdateOAuthAccountModelsRequest;
    parameterNames: ["accountId","If-Match"];
  };
  /** Sync Oauth Accountmodels */
  "POST /api/management/v1/oauth/accounts/{accountId}/models/actions/sync": {
    method: "POST";
    path: "/api/management/v1/oauth/accounts/{accountId}/models/actions/sync";
    successStatus: "202";
    successType: OAuthOperationEnvelope;
    requestType: never;
    parameterNames: ["accountId"];
  };
  /** Update Oauth Account Model Settings */
  "PATCH /api/management/v1/oauth/accounts/{accountId}/models/settings": {
    method: "PATCH";
    path: "/api/management/v1/oauth/accounts/{accountId}/models/settings";
    successStatus: "200";
    successType: OAuthModelListEnvelope;
    requestType: UpdateOAuthAccountModelSettingsRequest;
    parameterNames: ["accountId","If-Match"];
  };
  /** Refresh All Oauth Usage */
  "POST /api/management/v1/oauth/actions/refresh-usage": {
    method: "POST";
    path: "/api/management/v1/oauth/actions/refresh-usage";
    successStatus: "202";
    successType: OAuthOperationEnvelope;
    requestType: never;
    parameterNames: [];
  };
  /** Clear All Oauth Errors */
  "POST /api/management/v1/oauth/actions/clear-errors": {
    method: "POST";
    path: "/api/management/v1/oauth/actions/clear-errors";
    successStatus: "200";
    successType: DataEnvelope_OAuthClearedCountData_;
    requestType: never;
    parameterNames: [];
  };
  /** List Invalid Oauth Accounts */
  "GET /api/management/v1/oauth/invalid-accounts": {
    method: "GET";
    path: "/api/management/v1/oauth/invalid-accounts";
    successStatus: "200";
    successType: OAuthAccountListEnvelope;
    requestType: never;
    parameterNames: ["page","pageSize"];
  };
  /** Get Oauth Settings */
  "GET /api/management/v1/oauth/settings": {
    method: "GET";
    path: "/api/management/v1/oauth/settings";
    successStatus: "200";
    successType: DataEnvelope_OAuthSettingsData_;
    requestType: never;
    parameterNames: [];
  };
  /** Update Oauth Settings */
  "PATCH /api/management/v1/oauth/settings": {
    method: "PATCH";
    path: "/api/management/v1/oauth/settings";
    successStatus: "200";
    successType: DataEnvelope_OAuthSettingsData_;
    requestType: UpdateOAuthSettingsRequest;
    parameterNames: ["If-Match"];
  };
  /** Start Oauth Login Flow */
  "POST /api/management/v1/oauth/login-flows": {
    method: "POST";
    path: "/api/management/v1/oauth/login-flows";
    successStatus: "201";
    successType: DataEnvelope_OAuthLoginFlowData_;
    requestType: StartOAuthLoginFlowRequest;
    parameterNames: [];
  };
  /** Poll Oauth Login Flow */
  "POST /api/management/v1/oauth/login-flows/{flowId}/poll": {
    method: "POST";
    path: "/api/management/v1/oauth/login-flows/{flowId}/poll";
    successStatus: "200";
    successType: DataEnvelope_OAuthLoginPollData_;
    requestType: PollOAuthLoginFlowRequest;
    parameterNames: ["flowId"];
  };
  /** Complete Oauth Login Flow */
  "POST /api/management/v1/oauth/login-flows/{flowId}/complete": {
    method: "POST";
    path: "/api/management/v1/oauth/login-flows/{flowId}/complete";
    successStatus: "200";
    successType: DataEnvelope_OAuthMutationData_;
    requestType: CompleteOAuthLoginFlowRequest;
    parameterNames: ["flowId"];
  };
  /** Cancel Oauth Login Flow */
  "POST /api/management/v1/oauth/login-flows/{flowId}/cancel": {
    method: "POST";
    path: "/api/management/v1/oauth/login-flows/{flowId}/cancel";
    successStatus: "204";
    successType: void;
    requestType: PollOAuthLoginFlowRequest;
    parameterNames: ["flowId"];
  };
  /** Preview Oauth Import */
  "POST /api/management/v1/oauth/imports/preview": {
    method: "POST";
    path: "/api/management/v1/oauth/imports/preview";
    successStatus: "200";
    successType: DataEnvelope_OAuthImportPreviewData_;
    requestType: PreviewOAuthImportRequest;
    parameterNames: [];
  };
  /** Commit Oauth Import */
  "POST /api/management/v1/oauth/imports/{importId}/commit": {
    method: "POST";
    path: "/api/management/v1/oauth/imports/{importId}/commit";
    successStatus: "200";
    successType: DataEnvelope_OAuthImportCommitData_;
    requestType: CommitOAuthImportRequest;
    parameterNames: ["importId"];
  };
  /** List Models */
  "GET /api/management/v1/models": {
    method: "GET";
    path: "/api/management/v1/models";
    successStatus: "200";
    successType: ModelListEnvelope;
    requestType: never;
    parameterNames: ["type","text","sourceType","sourceId","status","page","pageSize"];
  };
  /** Get Model */
  "GET /api/management/v1/models/{resource_key}": {
    method: "GET";
    path: "/api/management/v1/models/{resource_key}";
    successStatus: "200";
    successType: ModelEnvelope;
    requestType: never;
    parameterNames: ["resource_key"];
  };
  /** Set Model State */
  "PATCH /api/management/v1/models/actions/state": {
    method: "PATCH";
    path: "/api/management/v1/models/actions/state";
    successStatus: "200";
    successType: ModelStateEnvelope;
    requestType: ModelStateRequest;
    parameterNames: ["If-Match"];
  };
  /** List Api Keys */
  "GET /api/management/v1/api-keys": {
    method: "GET";
    path: "/api/management/v1/api-keys";
    successStatus: "200";
    successType: ApiKeyListEnvelope;
    requestType: never;
    parameterNames: ["page","pageSize","enabled","source","name","sort"];
  };
  /** Create Api Key */
  "POST /api/management/v1/api-keys": {
    method: "POST";
    path: "/api/management/v1/api-keys";
    successStatus: "201";
    successType: ApiKeySecretEnvelope;
    requestType: ApiKeyCreateRequest;
    parameterNames: [];
  };
  /** Get Api Key */
  "GET /api/management/v1/api-keys/{keyId}": {
    method: "GET";
    path: "/api/management/v1/api-keys/{keyId}";
    successStatus: "200";
    successType: ApiKeyEnvelope;
    requestType: never;
    parameterNames: ["keyId"];
  };
  /** Update Api Key */
  "PATCH /api/management/v1/api-keys/{keyId}": {
    method: "PATCH";
    path: "/api/management/v1/api-keys/{keyId}";
    successStatus: "200";
    successType: ApiKeyEnvelope;
    requestType: ApiKeyUpdateRequest;
    parameterNames: ["keyId","If-Match"];
  };
  /** Delete Api Key */
  "DELETE /api/management/v1/api-keys/{keyId}": {
    method: "DELETE";
    path: "/api/management/v1/api-keys/{keyId}";
    successStatus: "204";
    successType: void;
    requestType: never;
    parameterNames: ["keyId","If-Match"];
  };
  /** Replace Api Key Secret */
  "PUT /api/management/v1/api-keys/{keyId}/secret": {
    method: "PUT";
    path: "/api/management/v1/api-keys/{keyId}/secret";
    successStatus: "200";
    successType: ApiKeySecretEnvelope;
    requestType: ApiKeyReplaceSecretRequest;
    parameterNames: ["keyId","If-Match"];
  };
  /** Reset Api Key Limiter */
  "POST /api/management/v1/api-keys/{keyId}/actions/reset-limiter": {
    method: "POST";
    path: "/api/management/v1/api-keys/{keyId}/actions/reset-limiter";
    successStatus: "200";
    successType: ApiKeyLimiterEnvelope;
    requestType: never;
    parameterNames: ["keyId"];
  };
  /** Plan Api Key Regeneration */
  "POST /api/management/v1/api-keys/{keyId}/actions/generate-replacement-plan": {
    method: "POST";
    path: "/api/management/v1/api-keys/{keyId}/actions/generate-replacement-plan";
    successStatus: "200";
    successType: ApiKeyReplacementPlanEnvelope;
    requestType: never;
    parameterNames: ["keyId"];
  };
  /** Get Api Key Stats */
  "GET /api/management/v1/api-keys/{keyId}/stats": {
    method: "GET";
    path: "/api/management/v1/api-keys/{keyId}/stats";
    successStatus: "200";
    successType: ApiKeyStatsEnvelope;
    requestType: never;
    parameterNames: ["keyId"];
  };
  /** Reorder Api Keys */
  "PUT /api/management/v1/api-keys/order": {
    method: "PUT";
    path: "/api/management/v1/api-keys/order";
    successStatus: "200";
    successType: ApiKeyOrderEnvelope;
    requestType: ApiKeyOrderRequest;
    parameterNames: ["If-Match"];
  };
  /** List Request Logs */
  "GET /api/management/v1/logs": {
    method: "GET";
    path: "/api/management/v1/logs";
    successStatus: "200";
    successType: PagedEnvelope_RequestLogData_;
    requestType: never;
    parameterNames: ["status","apiKey","model","channel","protocol","query","startedAt","endedAt","sort","descending","page","pageSize"];
  };
  /** Get Request Log Filter Options */
  "GET /api/management/v1/logs/filter-options": {
    method: "GET";
    path: "/api/management/v1/logs/filter-options";
    successStatus: "200";
    successType: DataEnvelope_RequestLogFilterOptionsData_;
    requestType: never;
    parameterNames: [];
  };
  /** Get Request Log */
  "GET /api/management/v1/logs/{logId}": {
    method: "GET";
    path: "/api/management/v1/logs/{logId}";
    successStatus: "200";
    successType: DataEnvelope_RequestLogDetailData_;
    requestType: never;
    parameterNames: ["logId"];
  };
  /** Get Request Log Body */
  "GET /api/management/v1/logs/{logId}/body": {
    method: "GET";
    path: "/api/management/v1/logs/{logId}/body";
    successStatus: "200";
    successType: LogBodyPagedEnvelope;
    requestType: never;
    parameterNames: ["logId","kind","query","sort","itemKind","page","pageSize"];
  };
  /** Get Request Log Body Item */
  "GET /api/management/v1/logs/{logId}/body/items/{itemId}": {
    method: "GET";
    path: "/api/management/v1/logs/{logId}/body/items/{itemId}";
    successStatus: "200";
    successType: DataEnvelope_LogBodyItemData_;
    requestType: never;
    parameterNames: ["logId","itemId","kind"];
  };
  /** Get Request Log Raw Body */
  "GET /api/management/v1/logs/{logId}/raw-body": {
    method: "GET";
    path: "/api/management/v1/logs/{logId}/raw-body";
    successStatus: "200";
    successType: DataEnvelope_RawLogBodyData_;
    requestType: never;
    parameterNames: ["logId","kind"];
  };
  /** Create Management Session */
  "POST /api/management/v1/auth/sessions": {
    method: "POST";
    path: "/api/management/v1/auth/sessions";
    successStatus: "201";
    successType: DataEnvelope_SessionCredentialData_;
    requestType: ManagementKeyGrant | TelegramApprovalGrant;
    parameterNames: [];
  };
  /** Get Current Management Session */
  "GET /api/management/v1/auth/session": {
    method: "GET";
    path: "/api/management/v1/auth/session";
    successStatus: "200";
    successType: DataEnvelope_SessionSummary_;
    requestType: never;
    parameterNames: [];
  };
  /** Revoke Current Management Session */
  "DELETE /api/management/v1/auth/session": {
    method: "DELETE";
    path: "/api/management/v1/auth/session";
    successStatus: "204";
    successType: void;
    requestType: never;
    parameterNames: [];
  };
}

export type UpstreamMvpOperationKey = keyof UpstreamMvpOperations;
