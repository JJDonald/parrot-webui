/**
 * 渠道页面使用的上游管理 API 类型（只做类型转发，不重复声明字段）。
 *
 * 事实来源：`packages/contracts/generated/upstream-mvp.d.ts`，
 * 由 `pnpm contracts:generate` 从 `packages/contracts/upstream.openapi.json`（Parrot v0.33.1）生成。
 * 业务代码不得修改生成文件，也不得臆造字段（实施文档 7.1 / 前端契约 §0）。
 *
 * 为什么从包名导入：`@parrot-webui/contracts` 的 `exports` 里 `./upstream` 直接指向
 * `./generated/upstream-mvp.d.ts`（纯类型入口，没有运行期代码），因此 `import type`
 * 既不会打包进任何代码，也不需要跨越 workspace 边界写相对路径。
 * 早期版本的注释声称"exports 指向不存在的 ./src/index.ts 与 ./generated/upstream.d.ts"，
 * 与 package.json 事实不符，已更正。
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
} from '@parrot-webui/contracts/upstream';
