# React 前端评审（apps/web）

## 0. 范围与方法

**读过的文件（全路径）**

- 基础设施层（全文读）：`apps/web/src/api/client.ts`、`apps/web/src/api/hooks.ts`、`apps/web/src/api/operations.tsx`、`apps/web/src/api/error-codes.ts`、`apps/web/src/app/App.tsx`、`apps/web/src/app/AppShell.tsx`、`apps/web/src/app/AuthProvider.tsx`、`apps/web/src/components/bits.tsx`、`apps/web/src/components/feedback.tsx`、`apps/web/src/components/state.tsx`、`apps/web/src/components/OperationTrackerPanel.tsx`
- 页面层（按行段精读 + grep 定位，未全文通读大文件）：`apps/web/src/features/overview/OverviewPage.tsx`(937 行)、`features/realtime/RealtimePage.tsx`(843)、`features/analysis/AnalysisPage.tsx`、`features/channels/ChannelsPage.tsx`(549)、`features/channels/ChannelDetailDrawer.tsx`(1031)、`features/channels/CreateChannelModal.tsx`(593)、`features/channels/channelsApi.ts`、`features/accounts/AccountsPage.tsx`(562)、`features/accounts/AccountDetailDrawer.tsx`(533)、`features/accounts/LoginFlowPanel.tsx`(523)、`features/accounts/useLoginFlow.ts`(437)、`features/accounts/accountsApi.ts`、`features/accounts/oauthTypes.ts`、`features/accounts/OAuthSettingsPanel.tsx`、`features/accounts/ImportPanel.tsx`、`features/accounts/InvalidAccountsPanel.tsx`、`features/models/ModelsPage.tsx`(997)、`features/api-keys/ApiKeysPage.tsx`(1466)、`features/logs/*`（LogsPage/LogsTable/LogFilter/LogDetailDrawer/LogBodySection/logTypes）、`features/tasks/TasksPage.tsx`、`features/about/AboutPage.tsx`、`features/auth/LoginPage.tsx`、`features/NotFoundPage.tsx`、`styles/global.scss`
- 测试（4 个文件全文）：`apps/web/src/api/client.test.ts`、`features/accounts/oauthSafety.test.ts`、`features/analysis/currency.test.ts`、`features/logs/logsSafety.test.tsx`
- 配置/契约：`apps/web/vite.config.ts`、`apps/web/package.json`、`packages/contracts/generated/upstream-mvp.d.ts`、`packages/contracts/generated/management-routes.ts`、`packages/contracts/package.json`、`docs/frontend-contract.md`、`README.md`
- 交叉证据（只读）：`apps/bff/src/errors.ts`、`apps/bff/src/config.ts`、`apps/bff/src/routes/health.ts`、`apps/bff/src/routes/management-proxy.ts`、`apps/bff/src/server.ts`、`apps/bff/src/upstream/client.ts`、`Dockerfile`
- 上游对照（只读）：`F:\tmp\parrot-upstream\Parrot\src\management_auth\principal.py`、`src/management_api/schemas/{operations,observability,channels,apikey,oauth,oauth_settings}.py`、`src/management_control/{oauth/control.py,apikey/control.py,errors.py}`、`src/model_pricing.py`、`src/management_api/dependencies.py`、`src/management_api/routers/{apikey,oauth}.py`

**跑过的命令（均为只读）**

```
node scripts/check-frontend-paths.mjs
  [check] 允许清单模板 76 条；前端出现的上游路径 56 条
  [check] 通过：前端只调用允许清单内的管理路径，且管理前缀只由 managementRequest() 拼。
  exit=0

# 静态检索（grep 等价，统计口径）
dangerouslySetInnerHTML|innerHTML|outerHTML|document.write|eval(|new Function  → 0 处实际使用（仅 5 处注释声明禁止）
localStorage|sessionStorage|document.cookie                                  → 唯一实际写入 app/antdTheme.ts:34,50（主题名）
React.lazy|lazy(|Suspense|import(                                          → 0 处
onMutate|setQueryData|rollback                                              → 0 处（无乐观更新）
ErrorBoundary|componentDidCatch|getDerivedStateFromError|errorElement        → 0 处
it( 计数：client.test.ts 9 / oauthSafety.test.ts 12 / currency.test.ts 1 / logsSafety.test.tsx 8 = 30
```

**核实方式说明**：本报告「已核实」= 已读源码/契约/上游 Python 并交叉比对；「推断」= 有证据链但未在真实实例上执行；「无法验证」见 §4。

---

## 1. 事实清单（已核实）

### 1.1 传输层与错误语义

- `apps/web/src/api/client.ts:215-286` `performRequest`：`credentials: 'same-origin'`；写操作缺 CSRF 时**本地直接抛** `WEBUI_CSRF_REJECTED`(403)，不发出网络请求（:222-229）；写操作带 `x-csrf-token`(:230)、`if-match`(:232)、`idempotency-key`(:233)。
- 2xx 但非 JSON 时**显式抛** `WEBUI_UPSTREAM_UNEXPECTED_CONTENT`（:264-271），不会把失败静默成空数据；`data: 'data' in record ? record.data : null`（:281）。
- `apps/web/src/api/client.ts:62-70` `isSessionLost`：code 命中 4 个会话失效码或 `status===401` 时返回 true，`toApiError` 在 :210 触发全局 `onSessionLost`（`suppressSessionLost` 可抑制，登录请求用它，见 :419-420）。
- `apps/web/src/api/hooks.ts:96` `useApiMutation` `retry: false` —— **写操作永不自动重试**，符合 `docs/frontend-contract.md` 要求。
- `apps/web/src/api/hooks.ts:69-73` 读请求重试条件 = `failureCount<2 && TRANSPORT_ERROR_CODES.includes(code) && error.retryable`。与 BFF `apps/bff/src/errors.ts:54-60` 的 `RETRYABLE_BY_CODE` 交集后，**实际只会重试** `UPSTREAM_UNREACHABLE` / `UPSTREAM_TIMEOUT` / `NOT_READY` / `NETWORK_ERROR` 四类；429/容量不足虽 `retryable=true` 但不自动重试（偏保守，是可接受的设计）。
- **`RequestOptions.timeoutMs` 是死声明**：定义在 `apps/web/src/api/client.ts:95`，注释称可覆盖默认超时，但全 `apps/web/src` 仅此一处出现 `timeoutMs`（另有 `AboutPage.tsx:25-26` 是展示 BFF 配置的文案），`performRequest` 从不使用它，fetch 也没有 `AbortSignal.timeout`。**实际不构成无限挂起**：BFF 侧 `apps/bff/src/upstream/client.ts:112-124` 用 `AbortSignal.timeout(timeoutMs)` 硬超时（默认 `PARROT_REQUEST_TIMEOUT_MS=30000`，`apps/bff/src/config.ts:197`），超时映射为 504 `WEBUI_UPSTREAM_TIMEOUT`。缺陷仅剩「浏览器↔BFF 这一段无超时」。
- `apps/web/src/api/client.ts:160-163` `parseRetryAfter` 只接受秒数，不解析 HTTP-date 形式；`buildQueryString`(:137-146) 会丢弃空串参数。二者均为保守实现，未找到用户可见后果。

### 1.2 认证与能力可见性

- `apps/web/src/app/AuthProvider.tsx:216-250` 初始化 = bootstrap → session；401 全局处理在 :206-213；多标签页注销用 BroadcastChannel(`parrot-webui:auth`, :237-250) 同步。
- `apps/web/src/app/AuthProvider.tsx:185-204` `logout` 无论成败都 `clearLocalSession()`（清 CSRF + `queryClient.clear()`）并广播，不留上一个会话的缓存。
- `apps/web/src/app/AuthProvider.tsx:119-156` `refreshSession` 在未登录时**故意不清空 CSRF**（有注释说明：未登录 session 返回 `csrfToken: null` 会挡住登录按钮）。
- `apps/web/src/app/AuthProvider.tsx:279-285` `useWriteCapability` 见 §2 [P1-1]。
- 对照实现：`apps/web/src/features/logs/logTypes.ts:201-208` `readCapability` 用 `capabilities.includes(code)` **精确匹配**，`LogsPage.tsx:89` 用它控制日志正文可见性。同一仓库两种能力判定风格。

### 1.3 异步任务（202 / operation）

- `apps/web/src/api/operations.tsx` 全局任务面板：`POLL_SEQUENCE=[1000,2000,5000]`，非终态继续轮询；终态后 `stop` 并 `invalidate` 业务键（:116-130）；404 → `unavailable` + `OPERATION_NOT_FOUND` + 刷新业务资源（:133-153）；其他错误 `attempt<6` 有界退避（封顶 30s），否则转 `unavailable`（:156-192）；`track` 只保留 30 条（:227）；`status==='anonymous'` 时清空全部任务与定时器（:263-278）。
- `apps/web/src/api/operations.tsx:102` 与 `apps/web/src/components/OperationTrackerPanel.tsx:19-22` 见 §2 [P1-2]。
- `apps/web/src/api/operations.tsx:46-58` `normalizeStatus` 对未知状态兜底返回 `'running'`（见 §2 [P2-5]）。

### 1.4 安全面（XSS / 秘密 / 存储 / 外链）

- `dangerouslySetInnerHTML|innerHTML|outerHTML|document.write|eval(|new Function` 在 `apps/web/src` **零实际使用**，仅 5 处注释声明禁止（`components/bits.tsx:4`、`features/logs/logTypes.ts:8`、`LogDetailDrawer.tsx:7`、`LogBodySection.tsx:12`、`LogsPage.tsx:14`）。
- `apps/web/src/components/bits.tsx:151-167` `JsonBlock`：`JSON.stringify(value,null,2)`（try/catch 兜底 `String`）后写进 `<pre>{text}</pre>` 纯文本节点。**日志正文/任务结果/原始 body 全走它**（21 处调用），XSS 面为零。`apps/web/src/features/logs/LogBodySection.tsx:81,90,96,404` 的正文渲染同样只经 JsonBlock。
- `apps/web/src/features/logs/logsSafety.test.tsx:19-40` 用 `renderToStaticMarkup` 静态断言 `<script>`、`<img onerror>`、`<b>` 都输出为转义文本，无标签注入。
- 唯一外链：`apps/web/src/features/accounts/LoginFlowPanel.tsx:284-302` 只允许 http/https，`target="_blank" rel="noopener noreferrer"`，非法协议显示「已拒绝打开该授权链接」；`oauthSafety.test.ts:67-80` 覆盖 `javascript:`/`data:`/相对地址拒绝。
- 秘密值：`apps/web/src/components/bits.tsx:105-148` `SecretReveal` 默认掩码、按需显示/复制；`apps/web/src/features/api-keys/ApiKeysPage.tsx:1506-1520` 一次性密钥弹窗明确「只存在于当前页面内存，关闭后无法再展示」；`apps/web/src/features/accounts/useLoginFlow.ts:106` flowSecret 存 ref，卸载清空(:273-281)；`ApiKeysPage.tsx:1354-1370` replacement planToken 用 SecretReveal。
- `apps/web/src/features/accounts/oauthSafety.test.ts:151-175` **源码级静态断言**：扫描本目录非测试源码，不得出现 `localStorage.`/`sessionStorage.`/`document.cookie`/`console.`，也不得出现 `[?&](flowSecret|importSecret)=`。这是「秘密不进持久化/URL/日志」的硬证据。
- `apps/web/src/app/antdTheme.ts:34,50` 是唯一 localStorage 写入（主题名，无敏感信息）。
- BFF 侧第二道防线（交叉，属 bff 范围）：`apps/bff/src/server.ts:26-37` CSP `Script-src 'self'`（无 `unsafe-inline`）、`object-src 'none'`、`frame-ancestors 'none'`。

### 1.5 空/错/载态（本项目强项，已核实）

- `apps/web/src/components/state.tsx:76-125` `AsyncState` 六态：加载无数据 / 错误无数据 / 无数据 / 空 / 有数据+错误（顶部 compact ErrorNotice + isStale 提示）/ 权限不足；:62-74 `isEmptyData` 只在明确识别容器字段后才判空。
- `apps/web/src/components/feedback.tsx:27-94` `ErrorNotice` 五档 heading，`sourceLabel` 区分「WebUI 传输错误 / 上游权限判定 / WebUI 自身校验 / Parrot 业务错误」，fields 只显示前 8 条(:65)，`reloadUnconfirmed` 时**隐藏重试按钮**并提示不要重放（:76,:79）。
- 缺失值不伪造 0：`apps/web/src/features/overview/OverviewPage.tsx:89-98`（`formatCount`→「未提供」、`formatRate` 分母缺失→「未知」）；`apps/web/src/features/realtime/RealtimePage.tsx:107-116`（unlimited 或上限未知→「无法计算」）；`apps/web/src/features/realtime/RealtimePage.tsx:196-198`（total 未提供时明说）；`apps/web/src/features/logs/LogsPage.tsx:164-170`（空态明确「不等于没有日志，不用 0 统计冒充」）；`apps/web/src/features/logs/logTypes.ts` `readListMeta` 全字段可 null。
- 分页诚实降级：`apps/web/src/features/logs/LogsPage.tsx:177-203` total 为 null 时退化为「上一页/下一页」并写明「上游未返回总数」；`LogBodySection.tsx:333-342` 同策略。

### 1.6 假数据 / 占位页核查（任务重点，结论：无）

- 全 `apps/web/src` grep `const (DEMO|MOCK|SAMPLE|FAKE|dummy|mock|demo)|示例数据|模拟数据|假数据|placeholderData` → **零命中**。
- 11 个页面均为真实实现：`features/overview`、`realtime`、`analysis`、`channels`、`accounts`、`models`、`api-keys`、`logs`、`tasks`、`about`、`auth/LoginPage`；`NotFoundPage.tsx:3-9` 也在。
- `apps/web/src/features/tasks/TasksPage.tsx` **不是占位**：真实使用 `OperationTrackerPanel`，并明确解释上游只有 `GET /operations/{operationId}` 无列表接口，所以只展示本浏览器已知任务，刷新即清空，不写 localStorage。
- `apps/web/src/features/about/AboutPage.tsx:67-108` 真实调用 `bff.diagnostics()`，`data` 为空时主动抛 `WEBUI_INTERNAL`「诊断接口返回了空数据」(:76-83)。
- `apps/web/src/features/accounts/InvalidAccountsPanel.tsx:4-5,108-109` 明说允许清单里没有 invalid-accounts 删除接口，因此**只读展示、不摆点了会失败的按钮**。

### 1.7 轮询与性能

- 全部轮询经 `apps/web/src/api/hooks.ts:30-45` `usePollingInterval`（可见时 activeMs，后台固定 300_000ms）。命中 18 处 `refetchInterval`：`OverviewPage.tsx:176-216`（8 个 × 15s）、`RealtimePage.tsx:250-267`（4 个 × 15s）、`AnalysisPage.tsx:73,77`（30s）、`ApiKeysPage.tsx:417`（30s）、`ModelsPage.tsx:159`（30s）、`channelsApi.ts:74`（20s）、`LogsPage.tsx:77`（30s，`enabled: autoRefresh`）、`AccountsPage.tsx:119`（30s）。无失控轮询。
- 详情/正文类重数据不自动轮询：`apps/web/src/features/accounts/accountsApi.ts:97-105`（账号详情 staleTime 5s 无 refetchInterval）、`LogBodySection.tsx:152-167`（正文/raw-body 只在用户点击后加载）。
- 表格分页 pageSize 上限 200（`logTypes.ts:49` `MAX_LOG_PAGE_SIZE=200`），无超大列表渲染；`scroll={{ x: 'max-content' }}` 覆盖全部业务表格（14 处），符合 `docs/frontend-contract.md` 移动端要求。
- **大 JSON 全量渲染**：`JsonBlock` 无截断/虚拟化，`maxHeight` 仅控 CSS 滚动高度（`styles/global.scss` `.raw-block`）；共 21 处调用，其中 3 处未传 maxHeight（`ChannelDetailDrawer.tsx:370`、`ChannelsPage.tsx:493`、`ModelsPage.tsx:1034`）但 CSS 默认 320px 兜底。上游单条正文受 BFF `maxUpstreamResponseBytes=10MB`（`apps/bff/src/config.ts:199`）约束，**存在极端情况下一次 stringify+渲染 10MB 文本的风险**，但需真实大日志才能触发。
- 无乐观更新（`onMutate`/`setQueryData`/`rollback` 零命中），所有写操作成功后靠 `invalidate` 重取，语义上最保守也最不易出错。

### 1.8 表单校验（与上游 schema 逐条对上，已核实）

- `apps/web/src/features/api-keys/ApiKeysPage.tsx:1432-1455` name 必填/≤64/`^[A-Za-z0-9_.-]+$`、secret 8–256 —— 与上游 `src/management_api/schemas/apikey.py:21` `Name = Annotated[str, StringConstraints(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")]`、`:24` `SecretInput = Annotated[SecretStr, StringConstraints(min_length=8, max_length=256)]` **完全一致**。
- `apps/web/src/features/channels/CreateChannelModal.tsx:151-166` name ≤64、apiKey ≥5、models ≥1、baseUrl ≥8 —— 与上游 `src/management_api/schemas/channels.py:44-52`（`name` 1–64、`apiKey` 5–4096、`models` min 1）、`:23` `Field(min_length=8, max_length=4096)`（ChannelInputUrl）一致。
- `apps/web/src/features/accounts/OAuthSettingsPanel.tsx:61-70` intervalSeconds 10–86400 整数、thresholdPercent 1–100 —— 与上游 `src/management_api/schemas/oauth_settings.py:27-28` `Field(ge=10, le=86_400)` / `Field(ge=1, le=100)` 一致，且 PATCH 带 `ifMatch: settings.revision`(:82)。

### 1.9 字段语义核对（与上游 Python 逐字段比对，均正确）

- **USD 计费**：`apps/web/src/features/analysis/currency.ts:1-11` `formatCostUsd(ticks)` 按 `TICKS_PER_USD=10_000_000_000` 换算，与上游 `src/model_pricing.py:31` 完全一致；`currency.test.ts` 5 条断言覆盖（`100_000_000`→`$0.0100` 等）。另一套 `apps/web/src/features/accounts/oauthTypes.ts:265-268` `formatUsd(value)` 直接 `$`+toFixed，用于 `AccountDetailDrawer.tsx:292` 的 `stats.costUsd`——上游 `src/management_control/oauth/control.py:361` 那里返回的是 `cost_ticks/TICKS_PER_USD` 已是美元浮点，**用法正确，两套格式各有其源，不是重复实现错误**。
- **缓存 token**：`apps/web/src/features/api-keys/ApiKeysPage.tsx:218-250` `UsageList` 分列展示 `inputTokens/outputTokens/cacheReadTokens/cacheCreationTokens`，各字段独立命名，未把 cache token 混入 input。
- **OAuth 配额窗口**：`apps/web/src/features/accounts/oauthTypes.ts:253-258` `usageWindowLabel`（fiveHour→5H、sevenDay→7D、其余原样）；`AccountsPage.tsx:79-95`、`AccountDetailDrawer.tsx:63-83` 都先 `typeof remainingPercent === 'number' && Number.isFinite(...)` 再渲染，进度条用 `Math.max(0, Math.min(100, remainingPercent))` 与 `aria-valuenow`，`usedPercent` 另用 `formatPercent` 显示、`resetsAt` 用 `<TimeText>`。上游 `src/management_api/schemas/oauth.py:58-62` + `src/management_control/oauth/control.py:321`（`remaining_percent = max(0.0, 100.0 - used_float)`）证明剩余/已用是 0–100 百分数，**前端语义正确**。
- **总览配额预警**：`apps/web/src/features/overview/OverviewPage.tsx:464,478` 列标题「使用率」+ `utilizationPercent.toFixed(1)%` —— 上游 `src/management_api/schemas/observability.py:136-138` `QuotaMetricData{window, utilizationPercent: float}` 必填非空，且 `status.py:482` 只在 `>=80` 时入预警，**语义正确**（缺 typeof 守卫见 §2 [P2-6]）。
- **并发利用率**：`apps/web/src/features/realtime/RealtimePage.tsx:107-116` `inFlight / maxConcurrent`，unlimited / maxConcurrent<=0 / 非有限 → null →「无法计算」，口径正确。
- **ApiKey 排序枚举**：`apps/web/src/features/api-keys/ApiKeysPage.tsx:94-100` 五个值与上游 `src/management_control/apikey/models.py:25` `ApiKeySort`（orderAsc/orderDesc/nameAsc/nameDesc/monthCallsDesc）**一一对应**。
- **幂等键**：全仓只有渠道创建带 Idempotency-Key（`apps/web/src/features/channels/channelsApi.ts:110-119`、`:334-339` `channels-${crypto.randomUUID()}`，45 字符 ≤ 上游 `src/management_api/dependencies.py:169-170` 的 128 上限；`CreateChannelModal.tsx:207` 每次提交重新生成）。上游只有 `POST /channels` 声明需要它，其余写操作非强制（见 §2 [P2-3]）。

### 1.10 允许清单覆盖（实测 76 条 vs 前端使用面）

- `packages/contracts/generated/management-routes.ts:18-` 冻结 76 条（GET 33 / POST 27 / PATCH 8 / DELETE 5 / PUT 3）。前端实际出现 56 条路径模板。
- **前端未实现的允许清单路由（3 条）**：`PUT /channels/order`、`PUT /api-keys/order`、`POST /oauth/accounts`。前两条无拖拽排序 UI；`POST /oauth/accounts` 无「直接新建账号」入口（账号只能经 OAuth 登录流程或导入产生）。
- `GET /meta`、`GET /capabilities` 前端不调用（`/meta` 由 BFF 用于可达性探测，`apps/bff/src/upstream/client.ts:196`）。
- `apps/web/src/features/channels/ChannelsPage.tsx:11` 显式声明「排序（PUT /channels/order）本页不实现，因此也不提供任何排序/拖拽入口」——**诚实实现**；对照 `ApiKeysPage.tsx` 未做同等声明（见 §2 [P3-3]）。

### 1.11 测试与工具链

- `apps/web` 只有 4 个测试文件、**30 个 it**（client.test.ts 9 / oauthSafety.test.ts 12 / currency.test.ts 1 / logsSafety.test.tsx 8），全部为纯函数、字符串渲染与源码静态断言；**零组件交互测试、零 React Query hook 测试、零路由测试**。
- `apps/web/package.json:11` `"lint": "node -e \"process.exit(0)\""` —— 占位实现（已知自述缺口，此处确认属实）。
- `node scripts/check-frontend-paths.mjs` 实跑通过 exit=0（见 §0），脚本纯静态扫描（`readFileSync`/`readdirSync`），只读。

---

## 2. 发现（按严重度）

### [P1-1] `useWriteCapability` 的能力正则对上游客能力码恒为 true，只读保护整体失效

- 位置：`apps/web/src/app/AuthProvider.tsx:279-285`
- 证据：
  ```ts
  if (!capabilities.length) return { canWrite: true, reason: null };
  const hasWrite = capabilities.some((capability) => /write|manage|admin/i.test(capability));
  ```
  上游能力码（`F:\tmp\parrot-upstream\Parrot\src\management_auth\principal.py:21-27`）：`management.read`、`management.write`、`management.secrets.write`、`management.destructive`、`management.update`、`management.logs.body.read` —— **6 个全部含子串 `management`**，正则必然命中。已用 node 实测 `['management.read'].some(c => /write|manage|admin/i.test(c)) === true`。
- 影响：`canWrite` 恒为 true，`'当前会话只具备只读能力'` 分支不可达。13 个消费方的 `disabled={!canWrite}`（`OverviewPage`/`ModelsPage`/`ChannelsPage`/`AccountsPage`/`ApiKeysPage`/各 Drawer 与 Modal）**从不生效**。`apps/web/src/features/channels/ChannelsPage.tsx:9` 声明「只读会话：useWriteCapability 预先禁用写按钮并说明原因」与实现不符。安全上仍由上游 403 `CAPABILITY_DENIED` 兜底（`ErrorNotice` 正确展示），所以不是越权漏洞，而是**功能失效 + 文档不符**。
- 建议：改成精确集合判断，例如 `const WRITE_CAPABILITIES = ['management.write','management.secrets.write','management.destructive','management.update'];` 再 `capabilities.some(c => WRITE_CAPABILITIES.includes(c))`；或至少用 `/(^|\.)(write|destructive|update|secrets\.write)$/`。并统一到 `logTypes.readCapability` 那套 `includes` 风格。

### [P1-2] 操作进度字段语义误读：`progress` 恒为 null，面板永远宣称「无进度上报」

- 位置：`apps/web/src/api/operations.tsx:102`、`apps/web/src/components/OperationTrackerPanel.tsx:19-22`
- 证据：
  ```ts
  progress: typeof data.progress === 'number' ? data.progress : null,   // operations.tsx:102
  ```
  ```ts
  function progressText(operation: OperationRecord): string {
    if (operation.progress === null) return '无进度上报';
    return `${Math.round(operation.progress * 100)}%`;                 // OperationTrackerPanel.tsx:19-22
  }
  ```
  契约 `packages/contracts/generated/upstream-mvp.d.ts:1787-1791`：
  ```ts
  export interface OperationProgressData { current: number; messageCode: string; total: number; }
  ```
  上游 `src/management_api/schemas/operations.py:14-17` 同形，`ManagementOperationData.progress: OperationProgressData | None`。
- 影响：`data.progress` 永远是对象或 null，`typeof === 'number'` 恒 false → `progress` 恒 null → **即使上游确实上报 `current/total`，UI 也只显示「无进度上报」**，等于向用户断言「上游没上报」。这是任务重点里的「字段语义误读」，且是**静默失效**（没有任何报错，只有误导性文案）。
- 建议：`progress` 类型改为 `{ current: number; total: number } | null`（或直接存 `current/total` 两个数），面板改成 `total > 0 ? Math.round(current/total*100) + '%' : '无进度上报'`。另外顺手修正 `Math.round(operation.progress * 100)` 这个「假定 0..1 小数」的写法。

### [P1-3] 生产 sourcemap 随镜像发布，源码全量可下载

- 位置：`apps/web/vite.config.ts:27-31`
- 证据：`build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 1200 }`；产物 `apps/web/dist/assets/index-VdWscvgz.js.map` = **7,283,343 B**（主 JS `index-VdWscvgz.js` = 1,624,926 B）；`apps/bff/src/routes/health.ts:57-78` 用 `@fastify/static` 以 `/webui/` 前缀托管整个 `dist`（`setHeaders` 对 `/assets/` 设 `cache-control: public, max-age=31536000, immutable`，对 `.map` 无任何拦截）；`Dockerfile:98` 把整个 `apps/web/dist` COPY 进运行镜像。
- 影响：任何能访问 `/webui/` 的人（未登录也行）可 `GET /webui/assets/index-VdWscvgz.js.map` 拿到带完整注释的源码。**不含密钥**，属源码与内部逻辑结构泄露 + 7MB 带宽浪费。
- 建议：`sourcemap: 'hidden'`（不影响本地调试）或在 `vite build` 后删除 `**/*.map`；若要保留，BFF 侧对 `.map` 返回 404。**本条已由 Lead 实测确认 200 下载 7,215,020 字节**，此处补充配置与托管链路证据。

### [P1-4] 单 chunk 1.6MB：11 个页面全静态 import，零路由级 code-split

- 位置：`apps/web/src/app/App.tsx:1-28`（11 个页面 import）、`apps/web/vite.config.ts:27-31`（无 `manualChunks`/`rollupOptions`）
- 证据：全仓 grep `React.lazy|lazy(|Suspense|import(` **零命中**；`App.tsx:110-125` 路由表用静态组件；产物主 JS 1,624,926 B / gzip ≈ 495.9 kB。
- 影响：首屏必须下载全部 11 个页面 + 全量 antd + `@ant-design/icons`。`README.md:133` 与 `docs/acceptance-current-20260925.md:33` 均已自认超 1200 kB 阈值。
- 建议：`React.lazy` + `Suspense` 拆到路由级；`manualChunks` 至少把 `antd`/`@ant-design/icons`/`@tanstack/react-query` 分出来；`@ant-design/icons` 逐个导入而非整包。

### [P2-1] 无 ErrorBoundary：任一页面渲染抛错会白屏整站

- 位置：`apps/web/src/app/App.tsx:100-133`（Providers 与 Routes 之间无边界）
- 证据：全仓 grep `ErrorBoundary|componentDidCatch|getDerivedStateFromError|errorElement` **零命中**；React Router 也未配置 `errorElement`。
- 影响：任何一个 `.toFixed()`/`Object.entries()` 收到非预期值（例如 `apps/web/src/features/overview/OverviewPage.tsx:478` 的 `metric.utilizationPercent.toFixed(1)` 无 typeof 守卫）都会让整站变成空白页，用户丢失所有上下文且无恢复入口。
- 建议：在 `AppShell` 内层与路由外层各加一个 ErrorBoundary，fallback 用现有 `ErrorNotice` 风格 + `reset` 按钮。

### [P2-2] `DangerConfirmButton` 无 try/catch：确认回调抛错时弹窗卡在「执行中…」

- 位置：`apps/web/src/components/bits.tsx:286-290`
- 证据：
  ```ts
  onClick={async () => {
    await onConfirm();   // 抛错则后面两行不执行
    setOpen(false);
    setTyped('');
  }}
  ```
- 影响：`onConfirm` 抛错时 promise 变 rejected 灭有 catch，`open` 保持 true、`typed` 不清空、按钮停在「执行中…」（`pending` 由父组件控制，实际可能已复位，但弹窗不会关）。已核实**多数调用点自行 try/catch**（`AccountDetailDrawer.tsx:533-544`、`ChannelDetailDrawer.tsx:1038-1055`、`ChannelsPage.tsx:141-162` 的 `runBatchAction`），错误能展示；但 `apps/web/src/features/api-keys/ApiKeysPage.tsx:1394-1396` 的 `onConfirm={async () => { await handleRemove(key); }}` 外层只靠 `handleRemove` 内部空 catch（:606-608），**该路径没有可见错误**，只靠列表里的 `removeMutation.error` ErrorNotice(:1290-1291) 兜。
- 建议：`DangerConfirmButton` 内部 `try { await onConfirm(); setOpen(false); setTyped(''); } catch { /* 交由调用方展示，至少保证不卡死 */ }`，或给组件加 `onError` 回调。

### [P2-3] 写操作普遍不做幂等保护：只有 `POST /channels` 带 Idempotency-Key

- 位置：`apps/web/src/features/api-keys/ApiKeysPage.tsx:435-493`（7 个 mutation 全部无 `idempotencyKey`）；对照 `apps/web/src/features/channels/channelsApi.ts:110-119`
- 证据：`ApiKeyCreateRequest` 的创建走 `createMutation`（`:435-440`，只有 method/path/body/invalidate）。上游 `src/management_api/dependencies.py:169-170` 接受 `idempotency-key`（长度 1..128），但只有 `POST /channels` 在路由层声明需要它。
- 影响：`POST /api-keys` 在网络超时/响应丢失后由用户重试，会在上游产生**两条同名 Key**（上游无去重）。因为 `useApiMutation` `retry: false`，**不会自动重复**，风险仅限用户手动重试，故为 P2 非 P1。
- 建议：给 `POST /api-keys`、`POST /oauth/login-flows`、`POST /oauth/imports/{id}/commit`、各 `actions/*` 这类非幂等且可能重复生效的写操作加上 `idempotencyKey`，生成规则复用 `channelsApi.ts:334-339`。

### [P2-4] 分页 total 兜底策略三页不一致，`meta.total ?? 0` 会显示「共 0 条」

- 位置：`apps/web/src/features/channels/ChannelsPage.tsx:518-527`
- 证据：
  ```ts
  current: page,
  pageSize,
  total: meta.total ?? 0,            // 缺 meta 时变成 0
  showTotal: (total) => meta.total === null ? '总数未知（上游 meta 未提供 total）' : `共 ${total} 条…`,
  ```
  对照 `apps/web/src/features/realtime/RealtimePage.tsx:196-198,212`（`hasNext !== true` 保守禁用下一页 + 明说「上游未返回翻页标记」）、`apps/web/src/features/logs/LogsPage.tsx:177-203`（total null 时退化为前后翻页）。
- 影响：正常上游总返回 `total`（`src/management_api/schemas/observability.py:14-18` `PagedResponseMeta{page,pageSize,total,hasNext}` 与 `routers/_observability.py:45-52` `paged_meta()` 必给 total），所以**这是异常路径下的降级**；但一旦触发，antd 分页会显示「共 0 条」且 `showTotal` 文案与 `total` 自相矛盾。
- 建议：与另两页统一，`total: meta.total ?? undefined`，分页器在 total 缺失时隐藏或用「逐页翻」模式。

### [P2-5] `normalizeStatus` 把未知任务状态当成 `running`，会永久轮询

- 位置：`apps/web/src/api/operations.tsx:46-58`
- 证据：`default: return 'running';`
- 影响：当前上游 `OperationStatus` 与前端 5 态一致（已核对），所以**现在不是 bug**；但上游新增状态（如 `paused`）或字段缺失时，任务会被当成永远运行，`stop()` 永不触发，定时器无限续期（后台标签页 300s 一次，可接受但不正确），且面板永远显示「执行中」。
- 建议：未知值兜底为 `'unavailable'`（已有该终态）或新增 `'unknown'`，并把原始值打进 `lastError` 便于排查。

### [P2-6] `OverviewPage.tsx:478` 缺 typeof 守卫，与同文件风格不一致

- 位置：`apps/web/src/features/overview/OverviewPage.tsx:478`
- 证据：`{metric.utilizationPercent.toFixed(1)}%`；同文件 `:442-443` 对 `recentSuccessRate` 做了 `typeof === 'number'` 判断。
- 影响：契约保证 `QuotaMetricData.utilizationPercent: number` 非可选（`observability.py:136-138`），**当前不会 NPE**；但一旦上游放宽为 nullable，整块渲染抛 TypeError，叠加 [P2-1] 无 ErrorBoundary → 白屏。
- 建议：与 `:442` 统一加守卫，缺失显示「未提供」。

### [P2-7] `UPSTREAM_CODE` 只覆盖 18/23 个上游错误码

- 位置：`apps/web/src/api/error-codes.ts:37-56`
- 证据：只有 18 个（注释 :36 自认「不是全部枚举」）。上游 `src/management_control/errors.py:10-32` `ManagementErrorCode` 共 23 个，缺 `RESOURCE_CONFLICT`、`UNSUPPORTED_VALUE`、`INVALID_REQUEST`、`UPSTREAM_TIMEOUT`。
- 影响：不影响展示（`ErrorNotice` 对未知 code 走「Parrot 业务错误」兜底分支）；但任何按 code 精确匹配的逻辑（`isSizeLimitError`、`isPermissionDenied` 等）对这些码不生效。属覆盖率缺口。
- 建议：由 `scripts/generate-contracts.mjs` 从 OpenAPI 自动生成 `UPSTREAM_CODE` 常量，避免手写漏项。

### [P2-8] 3 个导出函数从未被使用（死代码）

- 位置/证据（grep 计数 = 1，即只有定义本身）：
  - `apps/web/src/api/hooks.ts:127-130` `useClearAllQueries`
  - `apps/web/src/api/hooks.ts:152-163` `useSubmitLock`
  - `apps/web/src/api/client.ts:427-429` `isWebuiCode`
- 影响：`useClearAllQueries` 的注释说「注销或会话失效时必须调用」，但实际 `AuthProvider.clearLocalSession`(:79-92) 是直接 `queryClient.clear()`——**注释与实现路径不符**，易误导后续维护者以为有统一出口。
- 建议：删除三个死导出，或把 `AuthProvider` 改为使用 `useClearAllQueries`。

### [P2-9] 单文件过大影响可维护性

- 位置/证据（行数 / 字节）：
  | 文件 | 行数 | 大小 |
  | --- | --- | --- |
  | `apps/web/src/features/api-keys/ApiKeysPage.tsx` | 1466 | 63.9 KB |
  | `apps/web/src/features/channels/ChannelDetailDrawer.tsx` | 1031 | 49.9 KB |
  | `apps/web/src/features/models/ModelsPage.tsx` | 997 | 44.0 KB |
  | `apps/web/src/features/overview/OverviewPage.tsx` | 937 | 47.0 KB |
  | `apps/web/src/features/realtime/RealtimePage.tsx` | 843 | 43.5 KB |
- 影响：`ApiKeysPage.tsx` 一个文件里同时有 7 个 mutation、列表/详情/统计三个 Tab、5 个 Modal、约 700 行 JSX，任一处改动都要在 1400 行里定位；`.test.tsx` 无法为它写组件测试（当前也确实没有）。
- 建议：按 Tab 拆成 `KeyListTab`/`KeyConfigTab`/`KeyStatsTab` + `useApiKeyMutations()` 自定义 hook（对齐 `features/channels/channelsApi.ts` 已有的「api 层单独成文件」约定）。

### [P2-10] `timeoutMs` 声明未实现（误导性 API）

- 位置：`apps/web/src/api/client.ts:95`（唯一出现处）
- 影响：见 §1.1。调用方若传入 `timeoutMs` 会静默无效。
- 建议：要么删掉该字段与注释，要么真的接上 `AbortSignal.timeout`（可经 `AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])`）。

### [P3-1] 手写 modal 缺键盘与语义支持

- 位置：`apps/web/src/components/bits.tsx:255-300`
- 证据：`<div className="modal-overlay" role="dialog" aria-modal="true">` —— **无 `aria-labelledby`/`aria-label`**，无 Escape 关闭，无焦点转移/焦点陷阱，无背景 `inert`；全文件 grep `Escape|keydown|focus` 零命中。
- 影响：这是全仓**唯一手写 modal**（其余用 antd `Modal`/`Drawer`，自带键盘支持）。屏幕阅读器读不到标题，键盘用户无法用 Esc 关闭、焦点可跑到背景。
- 建议：补 `aria-labelledby` 指向 `modal-header`、`useEffect` 监听 Escape、打开时 `autoFocus` 首个可聚焦元素。

### [P3-2] 可点击表格行的键盘可达性不一致

- 位置：
  - 已做对的：`apps/web/src/features/channels/ChannelsPage.tsx:505-516`（`tabIndex:0` + `role:'button'` + `aria-label` + Enter/Space）、`apps/web/src/features/logs/LogsTable.tsx:166-177`（同）
  - 缺的：`apps/web/src/features/accounts/AccountsPage.tsx:511-515`（只有 `onClick` + `title`，无 `tabIndex`/`role`/`onKeyDown`）
- 影响：账号列表只能鼠标点行打开详情；**但操作列有「详情」按钮**（`AccountsPage.tsx:270-276`）作为键盘可达替代，所以不是功能性阻断，只是同等页面间标准不一致。`apps/web/src/features/models/ModelsPage.tsx:711-713` 的 `onDoubleClick` 同样只有鼠标，不过 `:442-445` 也有「查看详情」按钮。
- 建议：统一抽一个 `clickableRowProps(onOpen, label)` 工具，三处共用。

### [P3-3] `PUT /api-keys/order` 未实现但未像渠道页那样声明

- 位置：`apps/web/src/features/api-keys/ApiKeysPage.tsx:94-100,380`
- 证据：排序只有 5 个**查询参数**排序（`orderAsc/orderDesc/nameAsc/nameDesc/monthCallsDesc`），没有拖拽重排 UI；`PUT /api-keys/order` 在允许清单内（`management-routes.ts`）但前端零引用。
- 对照：`apps/web/src/features/channels/ChannelsPage.tsx:11` 对 `PUT /channels/order` 做了明确「本页不实现」的声明并说明原因，API Key 页没有对应声明。
- 建议：补一行注释说明「顺序只能经上游 PUT /api-keys/order 调整，本页不提供」，避免被误读为遗漏。

### [P3-4] 过时注释：契约包 exports 指向不存在的文件

- 位置：`apps/web/src/features/overview/OverviewPage.tsx:15-17`、`apps/web/src/features/channels/upstream-types.ts:9`
- 证据：注释称 `packages/contracts` 的 `"./upstream"` exports 指向不存在的 `generated/upstream.d.ts`；实际 `packages/contracts/package.json:16-18` 指向 `generated/upstream-mvp.d.ts`，**文件存在**。真正现象是：9 处 web 文件都改用相对路径 `../../../../../packages/contracts/generated/upstream-mvp` 绕开 exports，导致 `"./upstream"` 成为无人使用的死配置。
- 建议：统一改用包名导入 `@parrot-webui/contracts/upstream`，并按正确导出名修正注释。

### [P3-5] `LogsPage` 默认开启 30 秒自动刷新

- 位置：`apps/web/src/features/logs/LogsPage.tsx:51` `const [autoRefresh, setAutoRefresh] = useState(true);`
- 影响：日志页一进来就每 30s 拉一次列表（后台 300s）。对本项目「管理界面」定位可接受，但属于有代价的默认值；`docs/frontend-contract.md:126-130` 只规定「列表按需 15–30 秒」，未规定默认开。
- 建议：默认关或记住用户上次选择（内存即可，不要 localStorage）。

---

## 3. 与文档自述的偏差

| 文档声称 | 实际 | 证据 |
| --- | --- | --- |
| `README.md:129`「登录、总览…版本与诊断十一个页面」**已完成** | **属实**，11 个页面均为真实实现，无假数据/占位页 | §1.6；`apps/web/src/app/App.tsx:110-125` 路由表 + 逐页抽查 |
| `README.md:133`「29 个前端测试」 | **实测 30 个 `it`** | `api/client.test.ts` 9 + `features/accounts/oauthSafety.test.ts` 12 + `features/analysis/currency.test.ts` 1 + `features/logs/logsSafety.test.tsx` 8 |
| `apps/web/src/features/channels/ChannelsPage.tsx:9`「只读会话：`useWriteCapability` 预先禁用写按钮并说明原因」 | **不生效**，`canWrite` 恒 true | `apps/web/src/app/AuthProvider.tsx:282-284` 正则对 `management.*` 全命中（§2 [P1-1]） |
| `apps/web/src/api/operations.tsx` 的任务面板「展示进度」 | **永不显示进度**，恒显示「无进度上报」 | `operations.tsx:102` + `OperationTrackerPanel.tsx:20` vs `upstream-mvp.d.ts:1787-1791`（§2 [P1-2]） |
| `apps/web/package.json:11` `lint` | 占位 `node -e "process.exit(0)"`，不检查任何代码 | 同左 |
| `README.md:133`「主 JavaScript chunk 超过 1200 kB」 | **属实**：1,624,926 B / gzip ≈495.9 kB | 产物统计（§2 [P1-4]） |
| `docs/frontend-contract.md:76`「空数据不能显示成 0 统计，失败不能吞成空数组」 | **基本做到**（见 §1.5），仅 `ChannelsPage.tsx:521` `total: meta.total ?? 0` 是异常路径例外 | §2 [P2-4] |
| `docs/frontend-contract.md:104`「时间未知就是『未知』」 | **做到**（`TimeText`/`RelativeTime` 未知显示「未知」） | `apps/web/src/components/bits.tsx` |
| `docs/frontend-contract.md:105`「原始内容只能经 `JsonBlock` 纯文本渲染」 | **做到**，21 处调用全部经 JsonBlock | §1.4 |
| `docs/frontend-contract.md:94`「202 只表示已受理，不能立即提示成功」 | **做到**，`operationIdFrom` 只在 `status===202` 时返回 id，页面文案写明「受理不等于完成」 | `apps/web/src/features/accounts/oauthSafety.test.ts:118-127`、`AccountsPage.tsx:291`、`ModelsPage.tsx:288` |
| `apps/web/src/features/overview/OverviewPage.tsx:15-17` 注释「contracts exports 的 ./upstream 指向不存在的 generated/upstream.d.ts」 | **注释过时**，exports 指向存在的 `upstream-mvp.d.ts` | `packages/contracts/package.json:16-18`（§2 [P3-4]） |

---

## 4. 无法验证的事项

1. **`OperationProgressData` 是否真被上游填充**：契约与上游 schema 都定义了 `current/total/messageCode`，但我没有真实运行实例证据表明上游在任务执行中实际赋值（可能长期为 null）。无论哪种情况 [P1-2] 都成立（前端读法一定错），但「修好后能否真看到进度」需实例确认。
2. **`capabilities` 的真实返回内容**：需要一次真实登录会话才能看到 `session.upstreamSessionSummary.capabilities`。§2 [P1-1] 的后果依赖「只读管理密钥」真实存在；若部署环境只发全权密钥，则当前无用户可见影响，但代码仍然错。
3. **sourcemap 是否在生产镜像真实可达**：已核实 `vite.config.ts` 生成、`health.ts` 托管、`Dockerfile` COPY 三个环节，但未启动容器实测 HTTP 200（Lead 已实测，结论为可下载）。
4. **`SAVED_RELOAD_UNCONFIRMED` 的来源**：`apps/web/src/api/error-codes.ts:62` 定义、`components/feedback.tsx:23-25` 消费，但上游 Python 源码 grep 不到该字串。可能是上游放在 `fields[].code` 里下发，我无法在不发请求的情况下确认。
5. **`GET /logs/{logId}/raw-body` 大正文的实际渲染表现**：需要一条真实的大日志（受 BFF 10MB 上限约束）才能测量 JsonBlock 一次 stringify+渲染 10MB 文本的卡顿程度。
6. **无障碍实测**：本报告只做静态检查（aria 属性、tabIndex、role 的存在性），未用 axe/lighthouse 或屏幕阅读器实测。

---

## 5. 交接给其他人

- **给 BFF / 部署负责人**：`apps/bff/src/routes/health.ts:57-78` 静态托管对 `.map` 无拦截，配合 `vite.config.ts` 的 `sourcemap: true` 与 `Dockerfile:98` 把 7.28MB sourcemap 发布到公网（§2 [P1-3]）。修复点在构建配置或静态托管任一侧。
- **给契约负责人（packages/contracts）**：`package.json:16-18` 的 `"./upstream"` exports 实际无人使用（9 处 web 文件都用相对路径绕开），且 `OverviewPage.tsx:15-17`/`upstream-types.ts:9` 的注释与实际不符（§2 [P3-4]）。建议统一导入方式；同时 `UPSTREAM_CODE`（`api/error-codes.ts:37-56`）缺 4 个上游错误码，最好由 `scripts/generate-contracts.mjs` 自动生成（§2 [P2-7]）。
- **给文档负责人**：`README.md:133` 的「29 个前端测试」应改为 30；`README.md:129` 的页面完成度声明经核实属实，无需修改。另外 `apps/web/package.json:11` 的 lint 占位建议在 README「未完成」清单里显式列出。
- **给上游 Parrot 侧（如能反馈）**：`GET /operations/{id}` 的 `progress` 若长期不填充，建议要么置 null 要么在契约里注明；WebUI 侧按对象读取是正确的方向。
