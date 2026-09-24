/**
 * @parrot-webui/contracts 的统一入口。
 *
 * 这里只做再导出，不含业务逻辑：
 * - 冻结的上游路由允许清单（构建产物，禁止手改）
 * - 从上游 OpenAPI 快照生成的 MVP 类型
 */

export {
  FROZEN_UPSTREAM_ROUTES,
  FROZEN_ROUTE_COUNT,
  UPSTREAM_MANAGEMENT_PREFIX,
  UPSTREAM_CONTRACT_SOURCE,
  type FrozenUpstreamRoute,
  type UpstreamRouteClass,
} from '../generated/management-routes.js';

export type {
  DataEnvelope,
  JsonValue,
  UpstreamErrorEnvelope,
  UpstreamMvpOperationKey,
  UpstreamMvpOperations,
} from '../generated/upstream-mvp.js';
