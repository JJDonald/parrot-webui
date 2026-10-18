# 双仓交叉核对：契约快照 / 允许清单 / 前端字段用法 vs Parrot v0.33.1 真实实现

> 报告人：crosscheck-reviewer（task-4）。审查对象：`F:\workspace\parrot-webui`。
> 上游只读参考：`F:\tmp\parrot-upstream\Parrot`（v0.33.1，commit `9b73d058635470d59eef7a10876e6532649435d9`）。
> 结论标记：**【已核实】**＝实际执行脚本/逐行读源码得到；**【推断】**＝由静态证据推导但未运行端到端；**【无法验证】**＝仓库内缺少可验证材料。

## 0. 范围与方法

### 读过的文件（全路径）

webui 侧（全部为读取，未修改任何文件）：

- `F:\workspace\parrot-webui\review\00-context.md`（评审上下文与报告格式）
- `F:\workspace\parrot-webui\packages\contracts\upstream.openapi.json`（契约快照，2,533,037 B）
- `F:\workspace\parrot-webui\packages\contracts\mvp-routes.json`（76 条允许清单 + 14 条 phase2 排除）
- `F:\workspace\parrot-webui\packages\contracts\upstream-meta.json`（快照元数据）
- `F:\workspace\parrot-webui\packages\contracts\generated\management-routes.ts`（18,237 B）
- `F:\workspace\parrot-webui\packages\contracts\generated\upstream-mvp.d.ts`（78,637 B）
- `F:\workspace\parrot-webui\packages\contracts\package.json`、`packages\contracts\src\index.ts`
- `F:\workspace\parrot-webui\scripts\generate-contracts.mjs`、`scripts\check-frontend-paths.mjs`
- `F:\workspace\parrot-webui\docs\contracts.md`、`docs\frontend-contract.md`、`docs\acceptance.md`
- 前端实现：`apps\web\src\api\client.ts`、`api\hooks.ts`、`api\operations.tsx`、`app\AuthProvider.tsx`、`components\OperationTrackerPanel.tsx`，以及 features 下 `overview\`、`realtime\`、`analysis\`、`logs\`、`api-keys\`、`channels\`、`accounts\`、`models\` 各页与 API 层
- BFF：`apps\bff\src\security\route-allowlist.ts`、`apps\bff\src\upstream\client.ts`、`apps\bff\src\auth\controller.ts`、`apps\bff\src\management-proxy.ts`

上游侧（只读）：

- `src\management_api\router.py`、`src\management_api\routers\*.py`（25 个路由文件全量扫描）
- `src\management_api\schemas\*.py`（`channels.py`、`models.py`、`oauth.py`、`oauth_settings.py`、`oauth_models.py`、`observability.py`、`operations.py`、`metadata.py`、`apikey.py`、`mcp.py`、`base.py`）
- `src\management_api\routers\_strict_query.py`
- `src\management_control\**` 能力归属（`apikey\control.py`、`oauth\control.py`、`oauth\account_mutations.py`、`channels\service.py`、`models\common.py`、`models\control.py`、`operations.py`、`observability\stats.py`）
- `src\management_auth\principal.py`、`policy.py`、`sessions.py`
- `src\model_pricing.py`
- 上游测试：`src\tests\test_management_stats_delivery_regressions.py`、`test_management_delivery_regressions.py` 等

### 跑过的命令（全部只读）

仓库内 sanctioned 只读命令：

```
node scripts/generate-contracts.mjs --check
→ [contracts] 校验通过：76 条允许路由全部存在于快照；快照哈希匹配。

node scripts/check-frontend-paths.mjs
→ [check] 允许清单模板 76 条；前端出现的上游路径 56 条
→ [check] 通过：前端只调用允许清单内的管理路径，且管理前缀只由 managementRequest() 拼。
```

运行前已确认两者在 `--check` 分支只读：`scripts\generate-contracts.mjs:31-32,119` 解析 `--check`，`writeFileSync` 调用点 `:167,347,351-352`，其中 `:351 if (!checkOnly)` 守卫生成写入。

自写的临时分析脚本（全部位于 `F:\tmp\`，只读快照与上游源码，不写两仓）：

| 脚本 | 作用 |
|---|---|
| `F:\tmp\cc-dec-count.js` | 统计上游路由装饰器与 operation_id 数量（237） |
| `F:\tmp\cc-prefix-recon.js` | 解析 `APIRouter(prefix=...)` + `/api/management/v1`，重建全部 path，与快照双向差集 |
| `F:\tmp\cc-param-names.js` | 逐路由比对 method+path、路径参数名、operationId |
| `F:\tmp\cc-snap-audit.js` | 快照自洽性（operationId 缺失、悬空 `$ref`、snake_case 属性泄漏、顶层结构） |
| `F:\tmp\cc-reach.js` | 495 个 schema 从 paths 的传递闭包可达性 |
| `F:\tmp\cc-schema-vs-py.js` | 快照 schema 名 vs 上游 Python `class` 名匹配 |
| `F:\tmp\cc-shadow.js` | 76 条模板的精确/遮蔽匹配检查 |
| `F:\tmp\cc-coverage.js`、`cc-coverage2.js` | 前端路径 → 76 条白名单的 method-aware 覆盖 |
| `F:\tmp\cc-gen-verify.js` | 生成物 76 条 operationId 与快照逐条比对 |
| `F:\tmp\cc-spot10.js`、`cc-spot2.js` | 12 条路径的 requestBody/parameters/response schema 抽查 |
| `F:\tmp\cc-header3.js` | 76 条白名单的 Header 名称与必填性比对（默认值/别名感知） |
| `F:\tmp\cc-cap2.js` | 76 条白名单的能力归属解析 |
| `F:\tmp\cc-fields.js`、`cc-raw-schema.js`、`cc-iface-diff.js`、`cc-name-collide.js` | 字段与可空性、前端 interface vs 生成物 interface 差异、同名类型碰撞 |
| `F:\tmp\cc-flowid.js` | `login-flows` / `imports` 路径参数约束 |
| `F:\tmp\cc-print-allow.js` | 76 条白名单全文打印 |

零漂移验证：把 `packages\` 与 `scripts\` 复制到 `F:\tmp\cc-drift\` 后在该副本内执行 `node scripts\generate-contracts.mjs`（**不在原仓执行**），再与仓内文件做行尾归一化逐字节比较。

---

## 1. 事实清单（已核实）

### 1.1 快照真实性：**237 / 175 / 495 / 24 四个数字全部逐条重建成立**【已核实】

| 口径 | 声称值 | 实测值 | 证据 |
|---|---|---|---|
| operation 数 | 237 | **237** | `F:\tmp\cc-dec-count.js` 扫 `src\management_api\routers\*.py` 25 个文件，`@router.(get|post|put|patch|delete)` 装饰器 237 个，其中带 `operation_id=` 的也是 237 个；扫描全仓 `src\**\*.py`（769 个 py 文件）仍为 237，无散落 |
| distinct path 数 | 175 | **175** | `F:\tmp\cc-prefix-recon.js` 重建后与快照比对：`only-in-snapshot=[]`、`only-in-upstream=[]`、`method-set diffs=0` |
| schema 数 | 495 | **495** | 快照 `components.schemas` 长度 495；同层 `responses=0 params=0 headers=0`，无注水 |
| router 数 | 24 | **24** | `src\management_api\router.py:41-65` `_BUILTIN_DOMAIN_ROUTERS` 23 个 + `:35 foundation_router` = 24；routers 目录 25 个 `.py` 中 `oauth_workbuddy.py` 由 `routers\oauth.py:799-800` 嵌套 include，故 24 = 25 − 1 |

**路径前缀重建**：`src\management_api\router.py:38 _PREFIX = "/api/management/v1"`；带非空前缀的 router 只有 4 个——`routers\logs.py:35 prefix="/logs"`（6 条）、`routers\media.py:36 prefix="/media-logs"`（4 条）、`routers\retention.py:18 prefix="/logs/retention"`（5 条）、`routers\status.py:25 prefix="/runtime"`（4 条），其余 21 个 prefix 为空。逐文件分布：apikey 11、channels 17、content_blacklist 5、foundation 9、load_balancing 10、logs 6、mapping 10、mcp 5、media 4、media_settings 13、model_metadata 9、models 3、network 13、oauth 31、oauth_workbuddy 7、overview 1、proxy 14、retention 5、search 10、stats 6、status 4、status_alerts 6、system_settings 22、translation 6、updates 10。

**结论：快照不存在伪造、缺漏或取材不符，237 个 operation 与 175 个 path 可以逐条从 v0.33.1 源码重建出来。**

### 1.2 参数名与 operationId：与上游**零不一致**【已核实】

`F:\tmp\cc-param-names.js` 逐路由比较：

```
routes not present in snapshot by method+path: 0
snapshot routes with no upstream decorator: 0
param-name mismatches: 0
operationId mismatches: 0
```

- 快照路径参数名一律 camelCase，与上游装饰器路径里写的占位符**逐字相同**。distinct 路径参数全集 25 个：`accountId, alias, approvalId, artifactId, backendId, channelId, family, flowId, groupId, importId, incidentId, ingress, itemId, keyId, kind, logId, mediaLogId, modelId, operationId, planId, proxyId, resource_key, sourceId, term, version`。
- 唯一 snake_case 占位符 `resource_key` 是上游路由自己就这么写的，快照照抄，非转换错误。
- 关键抽样：`{logId}`（不是 `{log_id}`）、`{keyId}`、`{flowId}`、`{importId}` 全部一致。

### 1.3 快照自洽、无悬空引用、无 schema 注水【已核实】

- 237 个 operation 全部有 `operationId`（缺失 0）。
- 495 个 schema 从 paths 出发的传递闭包**全部可达**（`unreachable=0`），`dangling $ref = 0`。
- 响应状态码分布：`{"200":179,"201":12,"202":21,"204":25,"400":94,"401":236,"403":237,"404":154,"409":161,"422":237,"429":65,"502":39,"503":237,"504":2}`，与上游"认证前统一 401/403/422/503 枚举"的写法吻合。
- 顶层键只有 `components / info / openapi / paths`；`servers`、顶层 `tags` 均不存在；`info = {"title":"Parrot Management API (baseline snapshot)","version":"0.1.0"}`——符合"只组合管理 router 的隔离导出"特征（上游 `portal\server.py:666 app = FastAPI(lifespan=lifespan)` 未传 title/version，FastAPI 默认 `0.1.0`）。
- 属性级 snake_case 泄漏仅 6 处：`components.schemas.McpToolSwitches.{image_edit, image_generate, video_generate, video_status, web_fetch, web_search}` ↔ 上游 `src\management_api\schemas\mcp.py:18-25` 字段名原样就是 snake_case。**不是快照缺陷。**
- 全仓 `src\management_api\schemas\*.py` 里 `alias=` 命中 **0**；`schemas\base.py:13 model_config = ConfigDict(extra="forbid", populate_by_name=True)`。→ 上游直接以 camelCase 声明字段名，**运行时 JSON 无需 snake→camel 转换**，前端也无需做转换。
- 495 个 schema 名与上游 Python `class` 名匹配 **494/495**，唯一未匹配者为 `JsonValue`（类型别名，非 class）→ schema 集合确实源自上游代码。

### 1.4 生成物与快照/允许清单**零漂移**【已核实】

在 `F:\tmp\cc-drift\` 副本内跑 `node scripts\generate-contracts.mjs`：

```
[contracts] 已生成 management-routes.ts：76 条允许路由（上游共 237 个操作）
[contracts] 已生成 upstream-mvp.d.ts：222 个 schema 类型 + 76 条操作摘要
[contracts] 校验通过：76 条允许路由全部存在于快照；快照哈希匹配。
```

与仓内文件比较：`management-routes.ts` repo 18,237 B / regen 17,593 B；`upstream-mvp.d.ts` repo 78,637 B / regen 75,609 B；`upstream-meta.json` repo 1,238 B / regen 1,213 B。**差异全部是行尾符**（repo CRLF、regen LF）；CRLF 归一化后三者**逐字节相同（SAME=True）**。`git status --porcelain packages/contracts` 为空。→ 生成物与 `mvp-routes.json` + 快照在本次快照时点 100% 同步（差异源于本机 `core.autocrlf=true` 且仓库无 `.gitattributes`，属环境问题而非仓库缺陷）。

生成路由表内容：76 条，每条 `upstreamOperationId` 与快照对应操作的 `operationId` **76/76 相等**、`null=0`、76 个 opId 互不相同；`routeClass` 分布 `{"proxy":73,"auth":3}`；`bodyLimit` 仅 7 条有值（`"1mb"`×5、`"5mb"`×2）。

### 1.5 允许清单 76 条的构成与风险面【已核实】

- 76 条**全部存在于快照且 operationId 可解析**（缺失 0）。
- 方法分布：`{"GET":33,"POST":27,"PATCH":8,"PUT":3,"DELETE":5}` → **写操作 43 条**。
- `class` 分布：`{"proxy":73,"auth":3}`；3 条 auth 为 `POST/GET/DELETE /api/management/v1/auth/session{,s}`。
- 5 条 DELETE 全部是高价值但受控的：`DELETE /operations/{operationId}`、`DELETE /channels/{channelId}`、`DELETE /oauth/accounts/{accountId}`、`DELETE /api-keys/{keyId}`、`DELETE /auth/session`。
- `excluded.phase2` 14 条与允许清单**交集 0**，且 14 条**全部真实存在于快照**（`not-in-snapshot 0`）。
- **未开放 161 条**（=237−76），按族：`affinity 2、api-keys 1、auth 2、compression-model 3、content-blacklist 5、images 4、ingress-default-models 3、load-balancing 8、logs/retention 5、mcp 5、media-logs 4、media 2、model-catalog 1、model-mappings 4、model-metadata 7、models 1、network 13、oauth 12、preferences 4、proxies 6、proxy-groups 6、proxy-routing 2、search 10、settings 22、status-alerts 6、translation 6、updates 10、videos 2、xai 5`；其中**写操作 99 条**。
- 高风险族 `updates(10)`、`system_settings(22)`、`network(13)`、`mcp(5)`、`proxy(14)`、`search(10)`、`logs/retention(5)`、`translation(6)`、`status_alerts(6)` **整体未进白名单**。

**能力归属（`F:\tmp\cc-cap2.js` 解析模块级别名后的结果）**：76 条分布 `{READ:24, WRITE:14, SECRETS_WRITE:10, DESTRUCTIVE:3, LOG_BODY_READ:3, UNRESOLVED:19, NONE:3}`。

- `DESTRUCTIVE` 3 条：`DELETE /api-keys/{keyId}`、`DELETE /oauth/accounts/{accountId}`、`POST /oauth/actions/clear-errors`。
- `SECRETS_WRITE` 10 条：api-keys 的创建/换密/再生成计划，oauth 的账号创建、`login-flows` 四件套、`imports` 两件套。
- `WRITE` 14 条：含 `PATCH /models/actions/state`、oauth 账号 PATCH、账号模型 PATCH、refresh、clear-errors、api-keys PATCH/order/reset-limiter、渠道兼容性 PATCH 等。
- `UNRESOLVED` 19 条全部在 `routers\channels.py`：该文件用 `context: Annotated[ManagementContext, Depends(get_management_context)]`，能力在控制层断言（`src\management_control\channels\service.py` 内 `self._require(...)`），已逐项人工核对：`:530-534 create WRITE+SECRETS_WRITE`、`:597-608 update WRITE+SECRETS_WRITE`、`:632-635 delete DESTRUCTIVE`、`:648 reorder WRITE`、`:675/711 clear errors WRITE`、`:718/733 clear affinity WRITE`、`:853/869/888/898 probe/discovery WRITE/SECRETS_WRITE`。
- `NONE` 3 条是 `routers\foundation.py` 的会话三接口（`create_management_session` L226、`get_current_management_session` L281、`revoke_current_management_session` L307），认证前可调用，无 `require_capability`，**合理**。

**结论：白名单没有偷偷放行危险写操作。** 43 条写操作的能力归属全部落在 READ/WRITE/SECRETS_WRITE/DESTRUCTIVE/LOG_BODY_READ 五档内；不存在"需要 `management.update`（重启/更新类）或系统级/网络级能力的操作被放进来"。系统设置、更新重启、网络诊断、代理、搜索、MCP、保留策略等 99 条写操作全部被挡在外面，与 `README` 自述一致。

### 1.6 前端 56 条路径 → 76 条白名单：无孤儿、无语义错位【已核实】

- 前端 `apps\web\src` 出现 **26 个 distinct 管理路径**；method-aware 匹配后 **66/76 条被引用**。
- 未引用 10 条，且每条都有明确归属：`#1 GET /meta`（BFF 探活，`apps\bff\src\upstream\client.ts:183,196`）、`#2 GET /capabilities`（无使用）、`#3/#4 GET/DELETE /operations/{operationId}`（实际由 `apps\web\src\api\operations.tsx:91` 以模板字符串调用，非 `path:` 字面量形式故脚本漏计）、`#19 PUT /channels/order` 与 `#67 PUT /api-keys/order`（前端明确不实现拖拽排序，`apps\web\src\features\channels\ChannelsPage.tsx:11`）、`#66 GET /api-keys/{keyId}/stats`（`apps\web\src\features\api-keys\ApiKeysPage.tsx:428-431`）、`#74/75/76`（auth 类，BFF 认证控制器专用）。
- 反向：**前端没有出现任何一条不在白名单模板内的上游路径**（unmatched=0）。
- 路由遮蔽：76 条做"同 method、同段数、前路由静态段是否吃掉后路由"的保守匹配 → `shadowed=0`，无重复参数名。BFF 线性匹配（`apps\bff\src\security\route-allowlist.ts:116-144`）不会因顺序误配。
- 语义错位检查：列表接口只喂列表组件；详情接口都带单段 `encodeSegment(id)`；`/channels/{id}/compatibility` 单独建缓存 key（`channelsApi.ts:98-104`，注释明确"兼容性 revision 与渠道 revision 是不同资源"）；`/oauth/accounts/{id}/models` 与 `/models/settings` 分开（`accountsApi.ts:250,264`）；`/logs/{logId}/body`、`/raw-body`、`/body/items/{itemId}` 三接口分别对应三种 UI（`LogBodySection.tsx:107,154,163`）。**未发现"把 list 当 detail 用"的错位。**

### 1.7 12 条路径的 requestBody / parameters / response schema 抽查【已核实】

| 路径 | 快照中的请求 schema / 参数 | 上游对应 | 一致 |
|---|---|---|---|
| `POST /channels` | `anyOf[ManualChannelCreateRequest, PresetChannelCreateRequest]`，201 `DataEnvelope_ChannelData_` | `schemas\channels.py:60-75` | ✅ |
| `PATCH /channels/{channelId}` | `ChannelUpdateRequest` + path `channelId*` + header `If-Match`（可选） | `schemas\channels.py:78-103` + `routers\channels.py:758` | ✅ |
| `POST /oauth/login-flows` | `StartOAuthLoginFlowRequest{provider*, realm:cn|global?, clientProfile:cli|ide?}`，201 | `schemas\oauth.py:173-176` | ✅ |
| `PATCH /models/actions/state` | `ModelStateRequest{scope*, selection*, target*}` + header `If-Match`（可选） | `schemas\models.py:136-139` + `routers\models.py:206-211` | ✅ |
| `PUT /api-keys/{keyId}/secret` | `ApiKeyReplaceSecretRequest{customSecret* writeOnly, min 8 max 256}` + path `keyId*` + header `If-Match` | `schemas\apikey.py` + `routers\apikey.py` | ✅ |
| `GET /logs` | 12 个 query 参数 = `status,apiKey,model,channel,protocol,query,startedAt,endedAt,sort,descending,page,pageSize` | `routers\logs.py:55-66`（含 `reject_unknown_query` 白名单 `:68`） | ✅ |
| `POST /oauth/imports/preview` | `PreviewOAuthImportRequest{format*:openai|cpa|sub2api, payload* writeOnly max 2000000, payloadEncoding, filename?}` | `schemas\oauth.py` | ✅ |
| `PATCH /oauth/settings` | `UpdateOAuthSettingsRequest{quotaMonitor?{enabled?,intervalSeconds:10..86400?,thresholdPercent:1..100?}, cchMode?, antigravityTlsFingerprintEnabled?}` + header `If-Match` | `schemas\oauth_settings.py:12-21` | ✅ |
| `POST /channels/{channelId}/diagnostic-probes` | `ProbeExistingRequest{model* min1 max256}` | `routers\channels.py:800-802` 202 | ✅ |
| `GET /stats/models/{modelId}` | 仅 `period` query | `routers\stats.py:106-118` | ✅（但见 P1-A：`:path` 语义丢失） |
| `PATCH /oauth/accounts/{id}/models` | `UpdateOAuthAccountModelsRequest{modelIds* min1 max10000, disabled*}` | `schemas\oauth_models.py:39-41` | ✅ |
| `PATCH /oauth/accounts/{id}/models/settings` | `{modelId* min1 max500, maxContextDefault*}` | `schemas\oauth_models.py:44-46` | ✅ |

### 1.8 Header 契约：76 条中 Header 名称与必填性**全部一致**【已核实】

`F:\tmp\cc-header3.js`（默认值与别名感知）结果：**唯一"不一致"是假阳性**——`PATCH /models/actions/state` 因上游用模块级别名 `src\management_api\routers\models.py:53 IfMatch = Annotated[str | None, Header(alias="If-Match")]` 无法被脚本解析，手动核对 `:211 if_match: IfMatch = None` 确认两边都是可选。其余 13 条带 `If-Match` 的路由两边名称与必填性完全一致（`DELETE /channels/{id}`、`PUT /channels/order`、`DELETE /oauth/accounts/{id}` 为 required，其余 10 条 optional）。唯一 header 是幂等键的 `idempotency-key`（`dependencies.py:169-171`，长度 1..128），上游无路由强制要求。

### 1.9 字段语义逐项对照（lead 指定的最高价值产出）

对照方法：前端 TS 类型/用例（含 `import type` 自 `packages\contracts\generated\upstream-mvp.d.ts` 的部分）→ 生成物 interface → 上游 pydantic schema，逐字段比对**类型、必填性、可空性、枚举值、单位/时间格式**。

#### (1) overview / realtime

上游 `src\management_api\schemas\observability.py`：

- `:83-91 OverviewData{version, uptimeSeconds:float ge0, listeners:ListenerSummary{host,port ge0 le65535}, counts:ResourceCounts{channels,oauthAccounts,apiKeys,quotaHot}, today:dict[str,JsonValue], lifetime:dict[str,JsonValue], activeAlerts:dict[str,JsonValue], revision}`
- `:110-125 ChannelStatusData{..., health:Literal 8 值, recentSuccessRate:float|None ge0 le100, **0~100**}`、`:128-133 FastestChannelData{..., successRate:float ge0 le1, **0~1**}`、`:183-188 ConcurrencyData`、`:191-200 RuntimeStatusData`、`:214-221 BackgroundJobData{status:running|succeeded|failed|unknown|disabled}`、`:229-236 CooldownData{state:active|permanent}`

前端 `apps\web\src\features\overview\OverviewPage.tsx:314-357` 只渲染 `counts.{channels,oauthAccounts,apiKeys,quotaHot}`、`version`、`uptimeSeconds`、`listeners.host`:`port`，并对 `today/lifetime/activeAlerts` **显式注明"无固定 schema，语义与聚合口径由上游定义，本页不做推算与求和"**。对 `recentSuccessRate`（0~100）按百分比渲染，未渲染 `fastestByFamily[*].successRate`（0~1）。

**结论：无类型不匹配、无单位混淆、无枚举臆造。【已核实】**

#### (2) logs

上游 `schemas\observability.py:362-392 RequestLogData`：`id, revision, status, costTicks(min 0), inputTokens, outputTokens, retryCount(必填 int), createdAt?:string|None(date-time), durationMilliseconds?:number|None, apiKeyName?, channelId?, finalModel?, requestedModel?, protocol?, transport?, error?, billing:RequestLogBillingData(必填)`；`RequestLogBillingData`（`:352-359`）含 `costTicks/actualCostTicks/estimatedCostTicks/actualCostedSuccess/estimatedCostedSuccess/costedSuccess/unpricedSuccess`。

前端 `apps\web\src\features\logs\logTypes.ts`：

- `:263-267 modelSummary` 把 `requestedModel` 与 `finalModel` **分别展示、不互相冒充**；
- `:239-243 formatDuration` 对 `durationMilliseconds === null` 显示"未知"而非 0；
- `:143-153 readListMeta` 只读 `meta.total/page/pageSize/hasNext`，缺失为 `null` 而**不伪造 0**；
- `:156-170 readBodyMeta` 读 `revision` + `kindCounts[{kind,count}]`，对应 `:433-442 LogBodyKindCountData` 与 `LogBodyPagedResponseMeta`；
- `:210-215 STATUS_LABELS` 与 `:54-67 BODY_SORT_OPTIONS`/`LOG_SORT_OPTIONS` 与上游 `:33-56` 的 5 个枚举**逐值一致**（`LogBodyKind{request,response}`、`RequestLogStatus{success,error,cancelled,pending}`、`RequestProtocol{anthropic,chat,responses,responses_ws}`、`RequestLogSort{createdAt,status,latency,model}`、`BodySort{original,reverse,size,type}`）。

枚举无臆造、单位正确（`apps\web\src\features\analysis\currency.ts:1-2` `TICKS_PER_USD = 10_000_000_000`，注释引 `Parrot src/model_pricing.py`；上游 `src\model_pricing.py:31 TICKS_PER_USD = 10_000_000_000`）。**【已核实】**

能力门禁也是真读了上游语义：`apps\web\src\features\logs\logTypes.ts:44 LOG_BODY_CAPABILITY='management.logs.body.read'`、`:46 LOG_LIST_CAPABILITY='management.read'`，`LogsPage.tsx:46,89`、`LogBodySection.tsx:43,149,198-199`、`LogDetailDrawer.tsx:33-34,196,208` 按能力码禁用，对应上游 `routers\logs.py:102,130,146` 三正文接口需 `LOG_BODY_READ`。**【已核实】**

#### (3) stats

上游 `schemas\observability.py:244-271 StatsMetricData` 27 个字段**全部 optional**，含 `averageTotalMilliseconds?:number|null` 等 4 个平均项；`:274-278 StatsSummaryData{period, overall, families:dict[str,StatsMetricData], revision}`。

前端 `apps\web\src\features\analysis\AnalysisPage.tsx:43-61`：`metricRows` 每个字段都先 `typeof x === 'number'` 判定，缺失显示"未提供"；`:38-42 rate()` 仅在 `total > 0` 时计算成功率，否则"未知"。`AnalysisPage.tsx:83` 用 `Object.entries(summary.data?.data?.families ?? {})`，与 `families: dict` 一致。**必填可选/可空性处理正确。【已核实】**

#### (4) api-keys

上游 `schemas\apikey.py`：`ApiKeyData` 16 字段（`monthStats:ApiKeyUsageData` 必填、`limitOverride:ApiKeyLimitOverrideData|null`、`limiter:ApiKeyLimiterData` 必填、`revision`、`maskedHint`、`modelStats` 数组）；`ApiKeyLimitOverridePatch{enabled?, maxConcurrent?:ge0, maxQueue?:ge0, queueWaitSeconds?:ge0}`（`:142-146`）；`ApiKeyUpdateRequest` 有 `require_change` 校验（`:149-170`）`if not self.model_fields_set: raise ValueError("at least one field is required")`；枚举 `src\management_control\apikey\models.py:10-36`：`ApiKeySource{generated,custom}`、`ApiKeyProvenance{generated,custom,unknown}`、`ApiKeySort{orderAsc,orderDesc,nameAsc,nameDesc,monthCallsDesc}`、`ApiKeyEnabledFilter{all,enabled,disabled}`。

前端 `apps\web\src\features\api-keys\ApiKeysPage.tsx`：`:89-100 SORT_LABEL` 5 值逐字一致；`:377-380` 默认 `enabledFilter='all'`、`sort='orderAsc'` 与上游默认一致；`:759-764` 用 `record.monthStats.total/successCount/errorCount` 且有空值兜底；`:331-368 buildUpdateRequest` 明确 keep/clear/set 三态（`:347-352` clear 发 `[]`、keep 不发 key；`:355-366` limitOverride clear 发 `null`）；`:558 if (!Object.keys(body).length)` 空 PATCH 前置拦截对应上游 `require_change`。**字段与枚举一致，语义对齐。【已核实】**

#### (5) channels

上游 `schemas\channels.py:179-205 ChannelData`（26 字段）、`:243-246 ChannelDetailData(ChannelData){monthStats,modelStats,runtimeModels}`、`:249-254 ChannelPageMeta{page,pageSize,total,hasNext,orderRevision}`；`ChannelInputUrl`（`:21-25`，min 8 / max 4096 + 禁止 userinfo）；`ChannelUpdateRequest`（`:78-103`）有 `require_patch`。

前端 `apps\web\src\features\channels\channelForm.ts:112-165 buildChannelPatch` 只发改动字段、`:122-126` 校验 min 8、`:103-110 parseMaxConcurrent` 校验 0–100000、`:156-162` apiKey 留空=不修改；`channelsApi.ts:6-8` 注释正确区分三类 revision（渠道 / 兼容性 / `meta.orderRevision`），对应上游 `service.py:648-658 reorder_channels` 用 `self._order_revision()` 独立比对；`:143` DELETE 注释"If-Match 是必填头"。**一致。【已核实】**

#### (6) models

上游 `schemas\models.py`：`ModelData`（`:41-52`）、`ModelListMeta{page,pageSize,total,hasNext,revision}`（`:55-60`）、`ModelSelectionRequest`（`:104-122`，mode=ids 必带 modelIds 且禁 filter）、`ModelStateTargetRequest`（`:125-133`，`enabled`/`visible` **恰好一个**）、`ModelStateRequest`（`:136-139`）、`ModelStateItemData.status:"updated"|"unchanged"`（`:142-144`）。

前端 `apps\web\src\features\models\ModelsPage.tsx:142-160` 下发 7 个 query 参数与上游 `routers\models.py:159-196` 逐字一致；`:203-208 buildScope`、`:210-215 buildTarget`（unchanged 不发）、`:217-240 buildSelection`（filter 模式需用户显式确认）**严格对齐上游校验**。`resourceKey` 实测是安全单段字符串（上游 `src\management_control\models\control.py:157-168 _resource_key` = `"mdl_" + base64.urlsafe_b64encode(sha256(...))`，无斜杠），故 `encodeSegment` 对 resourceKey 安全——**这与 `/stats/models/{modelId}` 的斜杠问题不是同一类，不可混谈**。【已核实】

#### (7) oauth

上游 `schemas\oauth.py`：`OAuthPageMeta{requestId,page,pageSize,total,hasNext}`（`:22-27`，**含 requestId**）、`OAuthAccountSummaryData`（`:30-45`）、`OAuthAccountDetailData`（`:79-90`，12 字段）、`OAuthLoginPollData.status` 六值 `pending|identity_pending|ready|completed|cancelled|expired`（`:198-205`）、`OAuthIdentityConflictEnvelope{error,conflict}` + `OAuthReplaceConflictData{accountId,replacePlanToken}`（`:163-170`）；枚举 `src\management_control\oauth\models.py:11-31`：`OAuthProvider{claude,cursor,openai,xai,antigravity,workbuddy}`、`OAuthAccountFilter{all,available,quota,invalid}`、`OAuthAccountSort{configured,displayName,provider,status}`。

前端 `apps\web\src\features\accounts\oauthTypes.ts:86-136` 三个枚举**集合完全一致**；`:193-204 POLL_STATUS_LABEL` 六值逐值对应且 `isTerminalPollStatus` 语义正确；`:222-231 readReplacePlan` 从 `payload.conflict.{accountId,replacePlanToken}` 读取，与上游 envelope **结构完全一致**；`useLoginFlow.ts:163-170,292-301,322-338` 把 `flowSecret` 只放内存 ref、只走请求体（`:338` `{ flowId, flowSecret }`），`accountsApi.ts:285-290` 注释"轮询是 POST + body.flowSecret（不是 GET）"，对应上游 `routers\oauth.py:267-278` `body: Annotated[PollOAuthLoginFlowRequest, Body()]`。`AccountDetailDrawer.tsx:62-76` 对 `remainingPercent` 过滤有限值、`:291-292` 对 `costUsd` 判空。**一致。【已核实】**

#### (8) 通用：camelCase / 时间 / 金额

- 上游直接以 camelCase 声明字段名（`alias=` 全仓 0 处），快照与生成物字段名即运行时 JSON 字段名，**前端无需做任何 key 转换**——不存在"该转未转"。
- 时间统一 `format: date-time` 的 ISO 字符串，可空字段为 `anyOf[{type:string,format:date-time},{type:null}]`，前端按 `string | null` 判空渲染，未做本地格式硬编码解析。
- 金额：`costTicks`（1e10 ticks = 1 USD）换算正确，单位注释与上游 `src\model_pricing.py:31` 一致。

### 1.10 前端类型断言审计【已核实】

全仓 `as unknown as` / `as X[]` / `) as ` 共 17 处：

- 安全收窄（收窄为 `Record<string, unknown>` 或 `unknown`）：`apps\web\src\api\client.ts:176-177,275-276`、`api\operations.tsx:66,92`、`channelsApi.ts:312`、`logTypes.ts:279`。
- 枚举键遍历（`Record` 已穷举全部键）：`channelLabels.ts:19,51`、`ApiKeysPage.tsx:932`、`AccountsPage.tsx:360,415,548`。
- **唯一双断言**：`apps\web\src\features\api-keys\ApiKeysPage.tsx:350` `body.mcpTools = [] as unknown as ApiKeyUpdateRequest['mcpTools']`、`:352` 同类。上游 `ApiKeyUpdateRequest.mcpTools` 在快照里是 `anyOf[{items:{enum:[六值],type:string},type:array},{type:null}]`，本地 `McpTool` 六值与上游 `schemas\mcp.py:11-15` 完全一致，双断言**可能是多余的**（未逐字验证 tsc 究竟在哪种展开形式上报错，标记【推断】）；`:162 (value as unknown as string[]).filter((item): item is McpTool => ...)` 是运行时白名单过滤，属安全兜底。
- **未发现**用 `as` 绕过联合类型判别、也未发现对"上游可能新增/重命名字段"的静默兜底——`logTypes.ts:143-153`、`AnalysisPage.tsx:38-61`、`AccountDetailDrawer.tsx:62-76` 的兜底都是"缺字段显示未知"，不是"强行当成某个类型"。

---

## 2. 发现（按严重度）

### P1-A｜`/stats/models/{modelId:path}` 的 path-converter 语义在快照中丢失，导致含斜杠模型（如 `provider/model-a`）的模型统计在 WebUI 内不可达

- **位置**：`apps\web\src\features\analysis\ModelStatsDrawer.tsx:17`、`apps\web\src\api\client.ts:133-135`、`apps\bff\src\security\route-allowlist.ts:85-87,97-99`；快照 `packages\contracts\upstream.openapi.json` 中该路径记为 `/api/management/v1/stats/models/{modelId}`。
- **webui 证据**：`ModelStatsDrawer.tsx:17` `path: \`/stats/models/${encodeSegment(modelId ?? '')}\``；`client.ts:133-135 encodeSegment = encodeURIComponent` → `provider/model-a` 变 `provider%2Fmodel-a`；`route-allowlist.ts:85-87 if (/%2f|%5c/i.test(segment)) throw ... '资源标识中不允许出现编码斜杠'`、`:97-99` 解码后再拒 `/`。触发点 `apps\web\src\features\analysis\AnalysisPage.tsx:55` 把 breakdown 的 `key` 直接 `onOpenModel(value)`（`:70 selectedModel`）。
- **上游证据**：`src\management_api\routers\stats.py:106-114` 路由 `"/stats/models/{modelId:path}"` + `model_id: Annotated[str, Path(alias="modelId", min_length=1, max_length=256)]`；`src\tests\test_management_stats_delivery_regressions.py:78-93` fixture 全部用 `provider/model-a`，`:106` `"model": {"provider/model-a": a, "provider/model-b": b}`，`:114 _data(client, "/stats/models/" + quote("provider/model-a", safe=""), period=period)`——**斜杠模型是上游的核心被测场景**。
- **定性**：根因是 **OpenAPI 无法表达 Starlette 的 `:path` 转换器**，导出快照只能写 `{modelId}`，BFF 因此按"单段资源标识"实现并拒绝编码斜杠。所以这是**交叉契约的真实信息损失**，不是任一侧的"写错"。但后果是真实的：`analysis` 页点开任何 `provider/model` 形态的模型统计都会 4xx。
- **建议**：在 `mvp-routes.json` 给该路由加显式标记（例如 `pathParamStyle: "path"`），BFF 对该模板允许编码斜杠并整体解码一次；或前端改用 `GET /stats/breakdown?dimension=model` 的既有数据本地下钻，放弃调用该接口。同时把 `docs\acceptance.md:32,71` 的"拒绝编码斜杠"从普遍安全特性改为"除白名单显式声明 path 型参数外"。

### P1-B｜`useWriteCapability` 的能力判据恒为真，与代码注释和文档自述相反

- **位置**：`apps\web\src\app\AuthProvider.tsx:279-285`。
- **证据**：`:283 const hasWrite = capabilities.some((capability) => /write|manage|admin/i.test(capability))`，上游 6 个能力码 `management.read / management.write / management.secrets.write / management.destructive / management.update / management.logs.body.read`（`src\management_auth\principal.py:21-27`）**全部以 `management.` 开头**，故正则恒命中（实测 6/6 为 true）。注释 `:274-278` 写的是"只有明确拿到能力列表且其中没有任何写能力时才判定为只读，列表缺失一律不限制"——`manage` 这半个词把 `management.read` 也算成了写能力，实现与注释相反。另 `:282 if (!capabilities.length) return { canWrite: true, reason: null }`：匿名态（BFF `apps\bff\src\auth\controller.ts:316,350,367` 对未登录返回 `capabilities: []`）也被判为可写。
- **影响降级依据（重要，勿夸大）**：上游生产路径**只会签发全 6 项能力**——`src\management_auth\sessions.py:219`（管理密钥登录）与 `:258`（Telegram 批准）都签发 `ADMINISTRATOR_CAPABILITIES`（`principal.py:30 ADMINISTRATOR_CAPABILITIES = frozenset(Capability)`）；能签发受限能力的 `issue_for_principal`（`sessions.py:230-245`）**全仓调用者只有测试**（`src\tests\test_management_api_foundation.py:377`、`test_management_apikey_api.py:201`、`test_management_mapping_support.py:120`、`test_s4_management_logs_cross_month.py:397` 等）。→ 实际运行中所有会话都是全能力，该 bug **当前不可达**，不会造成越权（上游仍会返回 `CAPABILITY_DENIED`）。
- **但仍是 P1**：它是"预先禁用写按钮并说明原因"这一文档承诺（`docs\frontend-contract.md:80`、`apps\web\src\features\channels\ChannelsPage.tsx:9`）的唯一实现，一旦上游将来启用受限会话（`issue_for_principal` 已有实现，只是没接生产），前端会**静默放行按钮然后吃 403**，且"只读会话"提示永远不会出现。可测试性上也无法断言该函数正确。
- **建议**：改成 `const WRITE_CAPABILITIES = new Set(['management.write','management.secrets.write','management.destructive','management.update'])` 精确匹配；`capabilities.length === 0` 时返回不可写（或至少给出"未知"三态）。同时补一条单测。

### P1-C｜`operation.progress` 被当成小数，进度功能恒失效（前端手写类型与生成契约冲突）

- **位置**：`apps\web\src\components\OperationTrackerPanel.tsx:19-22`、`apps\web\src\api\operations.tsx:20,102`。
- **webui 证据**：`OperationTrackerPanel.tsx:19-22` `if (operation.progress === null) return '无进度上报'; return \`${Math.round(operation.progress * 100)}%\`;`（按 0~1 小数处理）；`operations.tsx:20 progress: number | null`、`:102 progress: typeof data.progress === 'number' ? data.progress : null`（**对象被丢弃成 null**）。
- **上游证据**：`src\management_api\schemas\operations.py:14-17 OperationProgressData{current:int, total:int, messageCode:str}`、`:26-36 ManagementOperationData{..., progress: OperationProgressData|None, ...}`；`src\management_api\routers\_operations.py:14-22 progress = OperationProgressData(current=operation.progress.current, total=..., messageCode=operation.progress.message_code)`——**progress 是对象**。
- **生成物其实是对的**：`packages\contracts\generated\upstream-mvp.d.ts:1252-1263`（`ManagementOperationData.progress: OperationProgressData | null`）与 `:1789-1793`（`OperationProgressData{current, messageCode, total}`）。
- **影响**：凡是有进度上报的长任务（`POST /channels/{id}/diagnostic-probes`、`discover-models`、`oauth` 同步、`api-keys` 换密计划等 202 操作）UI 永远显示"无进度上报"。不写错数据，只是功能白瞎。
- **建议**：改用生成物类型，渲染 `${current}/${total}`（配合 `messageCode` 走 i18n）；`:102` 删掉 number 收窄分支。

### P1-D｜`PATCH /models/actions/state` 等 10+ 个路由的 `If-Match` 运行时必填，OpenAPI 只能标可选；契约无法表达必填语义

- **位置**：快照 `packages\contracts\upstream.openapi.json` 中这些路由的 `header If-Match` 为 `required: false`；根因在 `src\management_api\routers\models.py:206-211 if_match: IfMatch = None`。
- **上游运行时证据**：`src\management_control\models\control.py:637 self._check_revision(expected_revision, current_revision, required=True)` → `src\management_control\models\common.py:141-153`：`:147-151 if required and not expected: raise ManagementError(ManagementErrorCode.CONFIRMATION_REQUIRED, "If-Match is required for this mutation")`。同类：`src\management_control\apikey\control.py:413-424`（`delete_api_key`，`:423-424 if require_confirmation and not if_match: raise ... CONFIRMATION_REQUIRED`）、`:509-522`（`replace_api_key_secret`，`require_revision=True`）、`:536-549`（`reorder_api_keys`，`require_revision=True`）、`:442-489`（`plan_regeneration`，`require_plan=True`）。`DELETE /oauth/accounts/{id}` 反而是签名必填（`routers\oauth.py:210`）。
- **前端表现**：前端已按必填处理，**无功能故障**——`apps\web\src\features\api-keys\ApiKeysPage.tsx:567,591,604,617`、`apps\web\src\features\models\ModelsPage.tsx:282,505`（`:505 disabled = !canWrite || !detailRevision || !detailData || ...`）、`channelsApi.ts:143`（注释"If-Match 是必填头"）、`AccountModelsSection.tsx:62,102`、`OAuthSettingsPanel.tsx:82`、`ChannelDetailDrawer.tsx:283,316,1042`、`AccountsPage.tsx:253`、`AccountDetailDrawer.tsx:180,537` 全部带 `ifMatch`。
- **定性**：不是前端 bug，也不是快照伪造；是**快照忠实于上游 `app.openapi()`，而 FastAPI 无法表达"运行时断言必填"**。风险在未来的代码生成/第三方消费者会误以为可选。定 P1 是因为"契约保真度"是本项目自述的核心卖点，此处有实质性语义缺口。
- **建议**：在 `mvp-routes.json` 增加 `requireIfMatch: true` 元数据并在 BFF 侧断言（现在 BFF 只是透传），生成物里也标注出来；`docs\contracts.md` 的"已知局限"章节补一条。

### P2-A｜`packages/contracts` 的 exports 与 `upstream-types.ts` 注释描述的路径不符，且前端用相对路径穿透 workspace 边界（15 处）

- **位置**：`packages\contracts\package.json`（`"."`→`./dist/src/index.d.ts`、`"./routes"`→`./dist/generated/management-routes.{d.ts,js}`、`"./upstream"`→`./generated/upstream-mvp.d.ts`、`"./generated/upstream-mvp"`→同）、`apps\web\src\features\channels\upstream-types.ts:8-11,47`。
- **证据**：`upstream-types.ts:8-11` 注释称"package.json exports 指向 `./src/index.ts` 与 `./generated/upstream.d.ts`，这两个文件当前都不存在（实际文件名是 `upstream-mvp.d.ts`）"——**与 package.json 事实不符**：exports 指向的是 `./dist/...`（构建产物）与 `./generated/upstream-mvp.d.ts`（存在且已正确导出）。因此"从包名导入会解析失败"的前提不成立；真实的解析障碍是 `./dist/*` 未构建。
- **影响**：15 处相对路径 `from '../../../../../packages/contracts/generated/upstream-mvp'`（`RealtimePage.tsx:34`、`OverviewPage.tsx:35`、`ModelsPage.tsx:34`、`ApiKeysPage.tsx:64`、`logTypes.ts:26`、`AnalysisPage.tsx:4`、`ModelStatsDrawer.tsx:2`、`upstream-types.ts:47`、`oauthTypes.ts:45`，另 `LogBodySection.tsx:4`、`channelLabels.ts:5` 仅注释提及）绕过 package exports，`apps/web/tsconfig.json` 未把这些路径纳入 `paths`。当前能编译是因为 `tsconfig` 无 `rootDir` 限制且相对路径就在同一磁盘目录；一旦把 `apps/web` 单独发包/裁剪目录，类型立刻断裂。也让 `@parrot-webui/contracts` 的 exports 实际未被 web 端使用。
- **建议**：让 `upstream-types.ts` 等改为 `import type { ... } from '@parrot-webui/contracts/upstream'`（该 export 已指向真实文件），或在 `apps/web/tsconfig.json` 加 `paths` 映射并修正注释；同步更正 `upstream-types.ts:8-11` 的错误描述。

### P2-B｜BFF 读取 `etag` / `x-resource-revision` 是死代码（上游从不发 ETag）

- **位置**：`apps\bff\src\upstream\client.ts:178`。
- **证据**：上游 revision 只出现在响应体（`data.revision` / `meta.revision` / `meta.orderRevision`，见 `src\management_api\schemas\channels.py:249-254 ChannelPageMeta.orderRevision`、`apps\web\src\features\channels\channelsApi.ts:6-8` 的注释），全仓无 `ETag` 响应头设置。
- **说明**：这条 lead 已核实并给出，我复核后确认（属 P2/P3 之间的可清理项）。前端实际取 revision 走 `apps\web\src\api\client.ts:277` 的 `meta.revision ?? meta.etag`，`meta.revision` 存在时 `etag` 分支不触发，**无功能影响**。
- **建议**：删除该分支或加注释说明为兼容未来上游。

### P3-A｜`normalizeStatus` 对未知状态的兜底方向错误

- **位置**：`apps\web\src\api\operations.tsx:46-58 normalizeStatus`，`default: return 'running'`。
- **影响**：上游新增状态时会把"未知"当成"运行中"，任务追踪面板会一直转圈。应兜底为 `'unavailable'`（本地类型 `operations.tsx:14 OperationStatus` 已有该值）。
- **建议**：`default: return 'unavailable'`。

### P3-B｜`docs/contracts.md` 自述的两个局限（非现存缺陷，属流程建议）

- `docs\contracts.md:28-29` 承认"把快照从该提交重新抽出来的完整可复现步骤没有随仓库交付（`scripts/` 下只有校验/生成脚本）"；`:79-84` 承认"`--check` 不校验 generated/ 是否与允许清单同步，需要零漂移检查请用 `pnpm contracts:generate && git diff --exit-code packages/contracts`"。
- **我实测的结果对这两条都是好消息**：生成物当前**零漂移**（行尾归一化后逐字节相同）；快照可由上游源码逐条重建。但抽取脚本缺失意味着**下一次上游升级无法自证**，建议补一个 `scripts/snapshot-from-upstream.mjs`。
- **本机 `core.autocrlf=true` 且仓库无 `.gitattributes`**，会让 `generate` 与 `--check` 在不同机器上产生字节差异；建议加 `.gitattributes` 固定 `packages/contracts/generated/** text eol=lf`。

---

## 3. 与文档自述的偏差

| 自述 | 位置 | 实测 | 偏差 |
|---|---|---|---|
| "只读会话：`useWriteCapability` 预先禁用写按钮并说明原因" | `docs\frontend-contract.md:80`；`apps\web\src\features\channels\ChannelsPage.tsx:9` | 正则 `/write\|manage\|admin/i` 对所有 6 个能力码恒真，禁用逻辑永不触发；匿名态 `capabilities.length===0` 反而返回 `canWrite: true` | **是**（见 P1-B；注：生产恒为全能力，实际不误放行） |
| "拒绝编码斜杠"被列为安全特性 | `docs\acceptance.md:32,71` | 对绝大多数资源标识正确，但 `/stats/models/{modelId:path}` 需要斜杠，该策略使功能不可达 | **是**（见 P1-A；文档未意识到 path 型参数例外） |
| "资源 ID 一律 `encodeSegment()`，不要整体编码斜杠" | `docs\frontend-contract.md:47` | 规则本身与快照一致，但与上游 `:path` 通配语义冲突 | **部分**（规则缺 path 型参数例外） |
| "未完成：…负载均衡、网络诊断、MCP/搜索、多媒体日志、更新/重启类操作" | `README`（见 `mvp-routes.json` `excluded.phase2`） | 未开放 161 条、其中写操作 99 条；`updates/system_settings/network/mcp/proxy/search/retention/translation/status_alerts` 整体未进白名单 | **无偏差**（自述准确） |
| "29 个前端测试、8 个管理流程测试" | `README:133` | `apps\web\src` 4 个测试文件约 30 个 `it`；`apps\bff\test` 5 个文件 43 个；`tests\e2e\management-flow.test.ts` 8 个 | **无实质偏差**（口径略粗） |
| "契约由 Parrot v0.33.1 导出" | `packages\contracts\upstream-meta.json:5,19-22` | 237 op / 175 path / 495 schema / 24 router 全部逐条重建成立 | **无偏差** |
| `upstream-types.ts` 注释说 package exports 指向不存在文件 | `apps\web\src\features\channels\upstream-types.ts:8-11` | package.json 实际 exports 指向 `./dist/...` 与存在的 `./generated/upstream-mvp.d.ts` | **是**（见 P2-A） |

---

## 4. 无法验证的事项

1. **`upstream.openapi.json` 的抽取流程本身**：仓库只交付了快照与校验/生成脚本，没有从上游 checkout 重新导出的可复现脚本（`docs\contracts.md:28-29` 自认）。我能证明的是"内容与 v0.33.1 源码一致"（237/175/495/24 + 参数名 0 不一致 + 494/495 schema 名匹配 + 12 条路径 schema 抽查），**不能证明**它是通过某个特定 `app.openapi()` 调用一次性导出的（无法排除手工修补，但没有发现任何修补痕迹：悬空 ref 0、可达性 100%、无孤立 schema）。
2. **端到端运行时行为**：本轮只做静态与脚本核对，未起服务、未发真实请求。`/stats/models/{modelId:path}` 斜杠不可达是由"前端编码 → BFF 拒绝"的静态链条推出（P1-A），未用真实请求复现。
3. **受限能力会话下的前端行为**：上游生产路径不签发受限能力（只有测试调用 `issue_for_principal`），因此 P1-B 的实际 UI 表现无法在真实环境中验证，只能静态推断。
4. **`ApiKeysPage.tsx:350,352` 双断言是否确有必要**：未运行 `tsc` 观察在去掉 `as unknown as` 后的报错位置，标记【推断】。
5. **`.gitattributes`/行尾策略在不同平台的最终字节影响**：只在本机验证了 CRLF 归一化后一致，未在多平台复现。

---

## 5. 交接给其他人

- **给 BFF 评审（01-bff.md 作者）**：
  - P1-A 的修复点在 `apps\bff\src\security\route-allowlist.ts:85-99`（编码斜杠拒绝）与 `:116-144`（模板匹配）。建议在 `mvp-routes.json` 给 `/stats/models/{modelId}` 加 path 型标记，BFF 对该模板允许 `%2F` 并只解码一次（注意避免二次解码绕过）。请复核 BFF 是否有其他"单段资源标识"假设被同一问题击中（`/models/{resource_key}` 已确认安全，`resource_key` 不含斜杠）。
  - 建议顺带删除或注释 `apps\bff\src\upstream\client.ts:178` 的 `etag`/`x-resource-revision` 死分支（P2-B）。
- **给前端评审（02/03 页作者）**：
  - P1-B `apps\web\src\app\AuthProvider.tsx:279-285` 的能力判据请改为精确匹配集合，并补单测；注意 `capabilities.length === 0` 的分支语义。
  - P1-C `apps\web\src\api\operations.tsx:20,102` + `components\OperationTrackerPanel.tsx:19-22` 改用生成物 `OperationProgressData`，渲染 `current/total`。
  - P2-A `apps\web\src\features\channels\upstream-types.ts:8-11` 注释错误 + 15 处相对路径穿透，建议统一改 `@parrot-webui/contracts/upstream`。
  - P3-A `apps\web\src\api\operations.tsx:46-58` 兜底改 `'unavailable'`。
- **给基础设施/工具链评审（05-infra.md 作者）**：
  - 建议新增 `.gitattributes`：`packages/contracts/generated/** text eol=lf`，避免 `generate` 在不同 `core.autocrlf` 机器上产生字节差异（本次实测 repo 是 CRLF、regen 是 LF）。
  - 建议补 `scripts/snapshot-from-upstream.mjs`（可复现抽取），并在 CI 里跑 `pnpm contracts:generate && git diff --exit-code packages/contracts` 作为零漂移门禁（`--check` 本身不做这件事）。
- **给 Lead**：本报告 §1.1–1.5 可用来直接回答"项目是否真材实料"——**快照 237/175/495/24 全部可逐条重建，参数名与 operationId 零不一致，生成物零漂移，白名单没有偷放危险写操作**。真正的缺陷集中在"契约无法表达的上游运行时语义"（`:path` 通配、If-Match 运行时必填、progress 是对象）与"前端自写逻辑"（能力正则、progress 类型）。没有发现伪造快照或白名单越权的证据。
