/**
 * 渠道页面使用的上游管理 API 类型（只做类型转发，不重复声明字段）。
 *
 * 事实来源：`packages/contracts/generated/upstream-mvp.d.ts`，
 * 由 `pnpm contracts:generate` 从 `packages/contracts/upstream.openapi.json`（Parrot v0.33.1）生成。
 * 业务代码不得修改生成文件，也不得臆造字段（实施文档 7.1 / 前端契约 §0）。
 *
 * 为什么用相对路径而不是包名：
 * `@parrot-webui/contracts` 的 package.json exports 指向 `./src/index.ts` 与
 * `./generated/upstream.d.ts`，这两个文件当前都不存在（实际文件名是 `upstream-mvp.d.ts`），
 * 从包名导入会解析失败。为保持本目录外零改动，这里按相对路径转发生成文件里的同名类型。
 */
export type {
  ActionResultData,
  CatalogProtocolEndpointData,
  ChannelCatalogData,
  ChannelCompatibilityData,
  ChannelCompatibilityInput,
  ChannelData,
  ChannelDetailData,
  ChannelHealth,
  ChannelModelData,
  ChannelModelInput,
  ChannelModelStatsData,
  ChannelMonthStatsData,
  ChannelPageMeta,
  ChannelPresetData,
  ChannelProtocol,
  ChannelProviderData,
  ChannelRuntimeModelData,
  ChannelUpdateRequest,
  CompatibilityFeatureData,
  CompatibilityFeatureInput,
  CompatibilityMode,
  DraftChannelDiscoveryRequest,
  ExistingChannelDiscoveryRequest,
  ManagementOperationData,
  ManagementErrorCode,
  ManualChannelCreateRequest,
  OperationStatus,
  PresetChannelCreateRequest,
  ProbeDraftRequest,
  ProbeExistingRequest,
  ProviderUsageData,
  ProviderUsageMetricData,
  ProviderUsageSnapshotData,
} from '../../../../../packages/contracts/generated/upstream-mvp';
