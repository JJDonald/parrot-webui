# BFF 层评审（apps/bff）

## 0. 范围与方法

**范围**：`apps/bff/src` 全部 17 个源文件（config/context/errors/index/server/auth×3/routes×2/security×4/upstream/util×2，约 2400 行），`apps/bff/test`（43 用例），以及与之直接耦合的根 `package.json`、`Dockerfile`、`compose.yaml`、`.env.example`、`deploy/`、`docs/security-model.md`、`docs/compatibility.md`、`packages/contracts/`。

**方法**（均为只读，未修改仓库任何现有文件、未执行 install/build/格式化）：
1. 通读源码 + 与上游 Parrot v0.33.1（`F:\tmp\parrot-upstream\Parrot`，commit 9b73d05）的 Python 源码逐条核对语义。
2. 用 `node --input-type=module` 起**真实的 `buildServer()`**（引用 `apps/bff/dist/server.js`，即仓库已构建的产物与其 src 一致），下游挂一个用 `node:http` 写的假 Parrot，用 `app.inject()` 打全流程：bootstrap → login → 代理 GET/PATCH → 各类畸形请求。下文标注「实跑」的结论全部来自该探测。
3. 契约核对脚本：把 `packages/contracts/mvp-routes.json`（76 条冻结清单）逐条对 `upstream.openapi.json` 校验 path+method、query 参数名、响应 content-type。
4. 直接读依赖源码（fastify 5.12.5 的 `lib/errors.js`、`lib/content-type-parser.js`、`@fastify/static` 8.3.0）并用探针确认错误码与解析器行为。

**证据分级**：`已核实` = 读源码或实跑确认；`推断` = 依据明确的实现路径/依赖行为推出但未在真实环境跑通；`无法验证` = 见 §4。

**一个前置判断**：这个 BFF 的整体安全设计是**认真的、且基本正确的**——固定上游 origin、构建期冻结的 76 条 method+path 允许清单、路径逐段重编码、Origin/Host/CSRF/Sec-Fetch-Site 四重校验、Cookie `__Secure-`+HttpOnly+SameSite=Lax+Path=/webui/ 无 Domain、不开放 CORS、日志只记 5 个字段且 redact 敏感头、容器 read_only + cap_drop ALL + 非 root。下面列的缺陷是**实现层的具体错误**，不是架构推翻。

---

## 1. 事实清单（已核实）

### 1.1 配置与启动
- 固定前缀 `FIXED_BASE_PATH='/webui/'`（`config.ts:10`），不匹配即启动失败（`config.ts:131-137`）。
- 生产强制 https 来源（`config.ts:142-146`，`WEBUI_ALLOW_INSECURE_PUBLIC_ORIGIN` 默认 false，`:139`）；`PARROT_BASE_URL` 必填（`:148`）且不得等于 publicOrigin（`:149-153`）。
- 生产 `WEBUI_TRUST_PROXY` 为空即抛（`config.ts:162-163`），禁 `*`/`true`（`:120-122`）。
- 会话空闲默认 1800s（60..86400，`config.ts:168`）、绝对默认 28800s（300..604800，`:169`），`max<idle` 启动失败（`:170`）。
- 开发不安全 Cookie：`!isProduction && readBool(env,'WEBUI_DEV_INSECURE_COOKIES', true)`（`config.ts:174-175`），`cookiePrefix` 相应去掉 `__Secure-`（`:176`）。
- 全局 bodyLimit = `oauthImportBodyLimitBytes` = 5 MiB（`server.ts:63`）；代理通配路由再单独声明同一值（`management-proxy.ts:55`）。
- `trustProxy: false` 交给自研 `resolveClientIp`（`server.ts:64`，`ip.ts:122-141`）。
- Fastify `logController: new LogController({disableRequestLogging:true})`（`server.ts:62`）；实跑确认该选项确实抑制了 `incoming request`/`request completed` 两条默认日志（不设置时二者都会出现），请求日志只由 `onResponse` 输出 5 字段（`server.ts:89-101`）。
- `void app.register(cookie)` 未 await（`server.ts:70`）——实跑确认 `inject()`/`listen()` 都会先 await ready，插件照常生效（见 §2 的「非缺陷」）。
- 启动即校验：`ConfigError` → `console.error` + `exit(1)`（`index.ts:11-19`）；`setInterval(sweep,60_000).unref()`（`:24-27`）；SIGTERM/SIGINT 优雅退出（`:29-42`）。

### 1.2 请求校验
- `assertHost`：精确等于 `publicHost`，或（仅 health）内部主机/`bindHost`（`request-guard.ts:26-37`）。
- `assertOrigin`：写方法缺 Origin 抛；`null`/空抛；必须 trim+lowercase 精确等于 `publicOrigin`；再校验 `Sec-Fetch-Site ∈ {same-origin,none}`（`request-guard.ts:44-66`）。
- `assertCsrf`：`x-csrf-token` 与预期值 `timingSafeEqual`（`request-guard.ts:68-77`，`crypto.ts:18-23`）。
- `assertJsonContentType`：非写方法直接 return；缺 content-type return；mime 非 `application/json` 抛 415（`request-guard.ts:80-91`）。
- 来源解析：直连对端不可信 → 忽略 XFF；可信 → 从右向左取第一个不可信；全可信退 `chain[0]`（`ip.ts:122-141`）；支持 v4/v6 与 `::ffff:` 映射（`ip.ts:10-15,68-105`）。
- 允许清单：76 条（73 proxy + 3 auth，`route-allowlist.ts:47-53`）；逐段 `encodeURIComponent` 重拼上游路径（`:138-143`），拒绝 `.`/`..`/`//`/`%2f`/`%5c`/控制字符/解码失败（`:64-105`）；未命中先查 auth 路由（`WEBUI_ROUTE_NOT_ALLOWED`），再 405，再 404（`:146-165`）。
- query 净化：>4096 拒、禁 NUL/`#`、禁 9 个危险键、逐值匹配 `/(https?:|\/\/|\\|\.\.)/i` 拒绝、`URLSearchParams` 重编码（`route-allowlist.ts:168-206`）。
- 契约脚本核对（已核实）：76 条全部能在上游 openapi 找到对应 path+method（missing=[]）；清单内**没有**任何 query 参数名撞上 `DENIED_QUERY_KEYS`；清单内所有响应声明为 JSON 或 204，故代理层「非 JSON 即 502」不会误伤正常响应；`logs/{logId}/body`、`body/items`、`raw-body` 上游均返回 JSON（`logs.py:96-152`），不是二进制。

### 1.3 会话
- 内存 Map，键 = Cookie 值的 sha256（`session-store.ts:74-75,91,116`）；预登录 TTL 硬编码 300s（`config.ts:196`）。
- 创建：`absoluteExpiresAt = min(now+8h, 上游 expiresAt)`（`session-store.ts:159`）。
- 取用：过期即删，否则 `lastSeenAt = now`（`session-store.ts:172-183`）；`isExpired` 判绝对/空闲/上游三项（`:185-190`）。
- 刷新：`applyUpstreamSessionSummary` 把 `absoluteExpiresAt` 重算为 `min(now+8h, 上游 expiresAt)`（`session-store.ts:193-201`），由 `handleSession` 在距上次刷新 >60s 时调用（`controller.ts:326-339`）。
- 容量有界，满则 429 拒绝、不驱逐有效会话（`session-store.ts:96-101,140-145`）；`clientIp` 存了但从不参与判定。
- Cookie：`Path=/webui/`、HttpOnly、SameSite=Lax、Secure=prod、无 Domain（`cookies.ts:23-30`）。

### 1.4 上游客户端
- 只允许 5 类可转发头（`client.ts:64`），`Authorization` 由 BFF 设置（`:109`），`maxRedirections` 未开、3xx 一律拒绝（`:136-142`）；content-length 与流式累计双重体积上限（`:144-163`）；超时用 `AbortSignal.timeout`（`:123`）。
- `assertForwardableHeader`（`client.ts:66-71`）与 `FORBIDDEN_FORWARD_HEADERS`（`:46-61`）**从未被调用**——实际防线是 `buildForwardHeaders` 的白名单构造（`management-proxy.ts:36-48`），两者等价，只是死代码。

### 1.5 上游语义核对（Parrot v0.33.1）
- `POST /auth/sessions` 201 返回 `{credential, session}`（`foundation.py:209-261`）；`GET /auth/session` 200 DataEnvelope；`DELETE /auth/session` **204**；三处均 `Cache-Control: no-store`。
- BFF 发的 `{grantType:'managementKey', managementKey}` 与 `schemas/auth.py:18-35` 的 discriminated union 一致。
- 上游 `SessionSummary.expiresAt` 来自 `expires_at`，`idleExpiresAt` 来自 `idle_expires_at`（`foundation.py:195-206`）；上游 session 的 `expiresAt` 是**长期**的绝对期限（30 天量级），`idle` 才随验证滑动（`src/management_auth/sessions.py:178,321`）。
- 上游 origin 中间件**只拒绝"带了 Origin 但不在白名单"的请求**，不拒绝缺失 Origin（`origin.py:52-64`）——所以 BFF「以无 Origin 的服务端请求访问上游」的方案成立。
- 上游 request-id 正则与 BFF `sanitizeRequestId` 完全一致（`dependencies.py:36` vs `crypto.ts:29`）。
- 上游 `idempotency-key` 长度必须 1..128，否则 400 `INVALID_REQUEST`（`dependencies.py:169-171`）；BFF 放行到 200（见 P2-3）。
- 上游错误码→状态码映射（`error_mapping.py:27-50`）：401 只可能是 SESSION_REQUIRED/SESSION_EXPIRED/AUTHENTICATION_FAILED，所以 BFF 的「401 即清会话」不会误伤（已核实）。
- 上游对大量写操作强制 `If-Match`（如 `routers/search.py:97-98` min 8 max 128）；BFF 会转发（`management-proxy.ts:40-41`），链路成立。

---

## 2. 发现（按严重度）

### P0-1 畸形 JSON 请求体被打成 500 `WEBUI_INTERNAL`，而不是 400
- **位置**：`apps/bff/src/server.ts:117-144`
- **证据（已核实，实跑）**：`setErrorHandler` 只映射了 `FST_ERR_CTP_BODY_TOO_LARGE` / `FST_ERR_CTP_INVALID_MEDIA_TYPE` / `FST_ERR_CTP_EMPTY_JSON_BODY` / `FST_ERR_VALIDATION` 四个 code，**漏了 `FST_ERR_CTP_INVALID_JSON_BODY`**（fastify 5.12.5 `lib/errors.js:127-131` 是独立 code，status 400）。用真实 `buildServer()` 实跑：
  - `POST /webui/bff/auth/login`，`content-type: application/json`，body `{bad json` → `500 {"error":{"code":"WEBUI_INTERNAL","message":"WebUI 内部错误",...}}`
  - 对照：空 JSON body → 400（已映射）、`text/plain` → 415、无 content-type 带 body → 415，均正确。
- **影响**：(a) 任何客户端只要发一个语法错误的 JSON 就能让 BFF 返回 500，前端显示"WebUI 内部错误"而非"请求格式不合法"，故障定位方向被带偏；(b) 该路径会走 `server.ts:147-150` 的 `app.log.error('unhandled error')`，**未认证即可触发 error 级日志**，是低成本的日志污染面；(c) 全部写接口（login、logout、73 条代理写路由）同受影响。
- **建议**：在 switch 里把 `FST_ERR_CTP_INVALID_JSON_BODY` 并入 `FST_ERR_CTP_EMPTY_JSON_BODY` 分支（→400 `WEBUI_INVALID_REQUEST`）；并补一条单测（当前 `apps/bff/test` 43 个用例里**没有任何**畸形 JSON 用例）。
- **补充（Lead 独立复核）**：Lead 用真实 `apps/bff/dist/index.js`（development，3905 端口）复现同一现象：`POST /webui/bff/auth/login`（正确 Host/Origin/x-csrf-token）+ body `{bad json` → **500** `WEBUI_INTERNAL`。同时确认响应带 `"source":"webui"`，说明前端能正确判定"这是 WebUI 自身错误"——所以缺陷**只在状态码/错误码映射**，不在来源归因。

### P1-1 会话"绝对 8 小时上限"被上游刷新滑动重置，实际可无限续期
- **位置**：`apps/bff/src/auth/session-store.ts:193-201`（`applyUpstreamSessionSummary`），调用点 `apps/bff/src/auth/controller.ts:326-339`
- **证据（已核实，实跑 + 读码）**：创建时 `absoluteExpiresAt = min(now+8h, 上游 expiresAt)`（`session-store.ts:159`，正确），但 `applyUpstreamSessionSummary` 每次刷新都执行 `session.absoluteExpiresAt = Math.min(now + this.config.sessionMaxSeconds*1000, absolute)`（`:199`）——用的是**当前时刻**，不是 `createdAt`。实跑：登录后 `localExpiresAt = T+8h`；把时钟推到 `T+7h` 调一次刷新（上游 expiresAt 是远期 30 天）→ `absoluteExpiresAt` 变成 `T+15h`，超过 `createdAt+8h`。
- **影响**：只要用户页面开着（前端 overview/realtime 有 5s~30s 轮询，每次 `/auth/session` 间隔 >60s 就会触发刷新），会话可被无限延长，`WEBUI_SESSION_MAX_SECONDS` 这个"硬上限"形同虚设。这与 `session-store.ts:7` 文件头自述「本地空闲 30 分钟、绝对 8 小时」和 `docs/security-model.md` 的会话模型不符。共享电脑/管理密钥泄露场景下，绝对上限是唯一能强制重新认证的机制，现在没有了。
- **建议**：`:199` 改为以 `session.createdAt` 为基准：`Math.min(session.createdAt + this.config.sessionMaxSeconds*1000, absolute)`，且不允许调大（取 `Math.min(旧值, 新值)`）。补一条"跨 8 小时刷新后仍过期"的单测。

### P1-2 query 净化按值黑名单误伤正常搜索词，日志页关键词搜索会 400
- **位置**：`apps/bff/src/security/route-allowlist.ts:197`（`if (/(https?:|\/\/|\\|\.\.)/i.test(value))`）
- **证据（已核实，实跑）**：规则对**任何** query 参数值做"含 `http:` / `//` / `\` / `..` 即拒绝"。实跑：
  - `GET /webui/bff/management/logs?query=a..b` → `400 WEBUI_INVALID_REQUEST "query 参数 query 包含疑似目标地址或越界内容"`
  - `GET /webui/bff/management/logs?query=https%3A%2F%2Fapi.example.com%2Fv1` → 同上 400
  - 对照：`startedAt=2026-01-01T00%3A00%3A00Z`、`query=nginx%2F1.2`、`filter=%2Fapi%2Fv1` 正常放行。
- **影响**：允许清单里**有 6 条路由带自由文本 query**（已核实）：`/logs`、`/logs/{logId}/body` 的 `query`（≤256 字符），`/models` 的 `text`，`/api-keys` 的 `name`，`/channels` 的 `search`，`/oauth/accounts` 的 `filter`。前端 `apps/web/src/features/logs/LogFilters.tsx:221-228` 和 `LogBodySection.tsx:145-155` 正是把用户输入原样接到 `query` 参数上。请求日志搜索"搜 URL / 搜上游地址"是核心用法，含 `//` 或 `http:` 太常见；含两个连续点的版本号、文件名也常见。→ 用户输入合法关键词得到 `400`，且错误文案说的是"疑似目标地址"，完全无法理解。
- **重要限定（已核实）**：这个缺陷**只在登录后才暴露**——未登录请求会先被代理层 `webui/bff/management/*` 的会话检查挡成 401（`management-proxy.ts:60-65`），根本走不到 `sanitizeUpstreamQuery`。所以匿名冒烟测试/健康检查全绿也发现不了它，必须带真实会话才会复现。Lead 已用独立探针（真实 bootstrap→login 拿会话后打 `/management/logs?query=...`）复现同一结论：`a..b`、`https://api.example.com/v1` 均 400，而 `nginx/1.2`、`2026-01-01T00:00:00Z`、`v1.2.3` 正常 200 且确证触达上游。
- **建议**：这条规则的目标（防 SSRF）在 BFF 侧已经由"固定 origin + 冻结路径 + 参数重编码"实现，query 值不可能改变目标主机，这里是**过度防御**。建议：仅对**路径参数**保留该检查，query 值改为长度/字符集白名单（如去掉控制字符即可），或把 `..` 规则限制为 `^\.\./` / `/\.\.(/|$)` 这类真正的路径穿越形态。无论改不改，都要给 6 条自由文本路由补用例。

### P1-3 登录路由未设独立 bodyLimit，未认证请求可让 BFF 缓冲并解析 5 MiB 请求体
- **位置**：`apps/bff/src/server.ts:63`（全局 5 MiB）+ `:162`（login 注册时**未**传 bodyLimit）+ `apps/bff/src/auth/controller.ts:200-224`
- **证据（已核实，实跑）**：Fastify 在**进入 handler 之前**完成 body 读取与 JSON 解析；`app.post('/webui/bff/auth/login', ...)` 没有任何 route 级 `bodyLimit`，因此继承 5 MiB。而 `LOGIN_BODY_LIMIT_BYTES = 16*1024` 的检查（`controller.ts:222`）发生在 handler 内、且排在限流（`:200-209`）和预登录校验（`:212-218`）之后——也就是说，一个未认证请求可以让 BFF 完整缓冲 + `JSON.parse` 最多 5 MiB，之后才被拒绝。实跑确认这个顺序：未认证、无 prelogin/CSRF 时发 **2 MiB** JSON body → `403 WEBUI_CSRF_REJECTED`（证明 body 已被完整缓冲并解析，之后才走到预登录校验），发 **6 MiB** → `413 WEBUI_PAYLOAD_TOO_LARGE`（全局 bodyLimit 生效）。即 2 MiB～5 MiB 区间是"先吃满再拒绝"。
- **影响**：本项目的 BFF 与 Parrot 同机、单进程，且容器 `read_only` 只留 32 MiB `tmpfs`；未认证的并发大 body 请求是稳定的内存放大点（5 MiB/请求），比"登录限流 5/min/来源"能约束的范围大得多。属于**低成本 DoS**，不是数据泄露。
- **建议**：`server.ts:162` 改为 `app.post('/webui/bff/auth/login', { bodyLimit: 16*1024 }, ...)`（logout 同类处理），把 16 KiB 的限额前移到解析层；`bootstrap`/`session`/`diagnostics` 是 GET，可忽略。

### P2-1 `idempotency-key` 允许到 200 字符，上游只接受 128
- **位置**：`apps/bff/src/routes/management-proxy.ts:43`
- **证据（已核实）**：BFF 条件 `trim().length <= 200` 后原样转发；上游 `dependencies.py:169-171` 要求 `1..128`，否则 400 `INVALID_REQUEST`。实跑：150 字符的 key 被原样转发（`idem len: 150`）。
- **影响**：`>128` 的 key 会被上游以 400 拒绝，前端看到的是 Parrot 业务错误而非参数错误。现实影响小（前端 `newIdempotencyKey()` 用 `crypto.randomUUID()`，36 字符，`apps/web/src/features/channels/channelsApi.ts:333-336`），但这是**两套契约不一致**，且 `channelsApi.ts:110` 的注释写的是"≤200 字符，由 BFF 原样转发"——注释即错误来源。
- **建议**：BFF 改为 `<= 128`（与上游一致），或超长直接丢弃而不是转发；同步修 `channelsApi.ts:110` 注释。

### P2-2 `WEBUI_STATIC_DIR` 默认值在 Windows 上是坏路径（开发态）
- **位置**：`apps/bff/src/config.ts:209`
- **证据（已核实，实跑）**：`new URL('../../web/dist', import.meta.url).pathname` 在 Windows 上得到 `/F:/workspace/parrot-webui/apps/web/dist`（前导斜杠 + 盘符），`existsSync` 为 false。实跑确认：不设 `WEBUI_STATIC_DIR` 时 `/webui/health/ready` = 503 not-ready，`/webui/nope`（Accept: text/html）→ 503 `WEBUI_NOT_READY`。设正确路径后 = 200 ready。
- **影响**：仅影响 Windows 本地开发（`pnpm dev:bff` 或 `pnpm start`）；生产 `Dockerfile:83-87` 与 `compose.yaml:62` 都显式设置了 `/app/apps/web/dist`，不受影响。但本项目 README 明确写了本机开发流程（`README.md:50-63`），Windows 开发者会在"页面打不开"上浪费时间，且日志里只有一条 warn。
- **建议**：改用 `fileURLToPath(new URL('../../web/dist', import.meta.url))`（`apps/bff/test/helpers.ts:32` 已经这么写了，说明作者知道正确写法）；或把该 warn 提升为启动时的显式提示并打印 `staticDir` 绝对值。

### P2-3 限流器是固定窗口（非滑动），且"最旧淘汰"可被伪造来源冲刷
- **位置**：`apps/bff/src/security/rate-limit.ts:18-81`（类名 `SlidingWindowRateLimiter`，`:33` 用 `windowStartedAt` 重置整个计数）
- **证据（已核实，读码）**：窗口边界处允许最多 2×limit；`maxKeys` 默认 4096（`:27`），超限按最旧淘汰（`:61-80`）；`refund()`（`:46-51`）从未被调用。
- **影响**：(a) 类名与文档（`docs/security-model.md:60-70` 的"每分钟"限流表）暗示滑动语义，实际是固定窗口，边界突发是最多 2 倍；影响可接受但属于**名实不符**。(b) 更实际的是淘汰策略：`loginPerSource` 以客户端 IP 为键，能伪造/轮换来源（IPv6 单机可用 /64 段）的客户端可以灌 4096 个键把真实计数挤掉，让自己（以及别人）的每来源计数清零。**但全局限流器用的是常量键 `'global'`（`controller.ts:200`），不会被挤掉**，所以暴力破解仍被"全局 30 次/分钟"兜住——这就是我把它评为 P2 而不是 P1 的原因。
- **建议**：改名或在注释里写明是固定窗口；键表淘汰禁止淘汰"当前窗口内仍有计数"的键（或对全局键加保护标记）；把 `refund()` 删掉或真正使用。

### P2-4 未认证的 `POST /webui/bff/auth/logout` 不校验 CSRF
- **位置**：`apps/bff/src/auth/controller.ts:402-411`
- **证据（已核实，读码）**：无本地会话时直接清 Cookie 并返回 200，`assertCsrf`（`:413`）在其后。
- **影响**：`docs/security-model.md:38` 明确写"无 CSRF 的例外：无。包括登录、登出、OAuth 轮询 POST"——实现与之不符。实际危害≈0（无会话时该请求本来什么也破坏不了，有会话时 CSRF 仍然强制），属于**文档与实现的口径偏差**，但评审会抓到，建议要么改文档，要么把 `assertCsrf` 提到分支之前（代价是失去幂等性，不推荐）。
- **建议**：改文档措辞为"除'无会话时的幂等登出'外无例外"，并在代码里加一行注释。

### P3（可维护性/风格，仅列事实，不展开）
- **死代码**：`client.ts:46-61,66-71`（`FORBIDDEN_FORWARD_HEADERS` / `assertForwardableHeader` 从未调用）；`rate-limit.ts:46-51`（`refund` 未调用）；`management-proxy.ts:76-78`（`!pathname.startsWith(PROXY_PREFIX)` 分支在 Fastify 按前缀路由后不可达）；`errors.ts:11,33,93` 的 `WEBUI_SESSION_EXPIRED` 从未被抛出（实际都用 `WEBUI_SESSION_REQUIRED`）。实跑确认 `/webui/bff/management/session-summary` 被静态路由优先匹配（返回 401 本地会话错误，不会代理出去），前端零调用——影子接口。
- **模块级可变状态**：`controller.ts:98-104` 的 `idleSecondsForPayload` + `configureSessionPayload()`，多实例/测试并行时会串味。
- **生产镜像带 7.2 MB sourcemap**：`apps/web/vite.config.ts:29` `sourcemap: true`，`apps/web/dist` 整个进镜像并由 BFF 静态托管（`.map` 可被直接下载）。不泄露秘密（前端源码本就在仓库里），但属于无必要的暴露与体积。
- **`WEBUI_UPSTREAM_TIMEOUT` 的默认文案**"写操作结果未知，请刷新确认"（`errors.ts:117-118`）对 GET 也生效，读操作超时的提示会误导。
- **`handleDiagnostics` 硬编码 `version: '0.1.0'`**（`controller.ts:460`），与 `package.json` 重复且会漂移。
- **413 / 400 两个错误分支漏设 `cache-control: no-store`**（`server.ts:118-128`、`:135-141`）。实跑逐分支核对响应头：

  | 分支 | 状态码 | `cache-control` |
  | --- | --- | --- |
  | WebuiError（`:106-113`） | 403 | `no-store` ✅ |
  | `FST_ERR_CTP_BODY_TOO_LARGE`（`:118-128`） | 413 | **undefined** ❌ |
  | `FST_ERR_CTP_INVALID_MEDIA_TYPE`（`:129-134`） | 415 | `no-store` ✅ |
  | `FST_ERR_CTP_EMPTY_JSON_BODY`（`:135-141`） | 400 | **undefined** ❌ |
  | 未知错误 default（`:151-155`） | 500 | `no-store` ✅ |

  与 `docs/security-model.md:53`「认证/业务/日志/密钥响应统一 no-store」及同类分支不一致。实际泄露风险≈0（这些响应体只有错误码与 requestId），属一致性缺陷。

### 不是缺陷、但容易被误判为缺陷的（已核实）
1. **`void app.register(cookie)` 未 await（`server.ts:70`）**：Fastify 的 `register` 是延迟加载，`inject()`/`listen()` 前都会 `ready()`，实跑确认 `req.cookies` 正常可用、Cookie 正常读写。属于风格问题（应 await/catch），不是 bug。
2. **`webui/bff/bootstrap` 与 `auth/session` 不做 Origin 校验**：两者是 GET，与"Origin 强制仅针对写方法"的设计一致（`request-guard.ts:46-52`）；而且 bootstrap 可能被跨站 top-level 导航触发，但它返回的 CSRF token 因同源策略读不到，Cookie 又是 HttpOnly，不构成 CSRF/固定攻击面。
3. **`getSession` 每次命中都刷新 `lastSeenAt`（`session-store.ts:181`）**：这就是 idle timeout 的正确语义（"无请求 30 分钟后过期"），不是 bug。真正让会话永久存活的是 P1-1 的绝对期限重置，两者不要混为一谈。

---

## 3. 与文档自述的偏差

| 文档自述 | 实际实现 | 位置 | 判定 |
| --- | --- | --- | --- |
| "本地空闲 30 分钟、**绝对 8 小时**"（`session-store.ts:7` 头注释、`docs/security-model.md` 会话节） | 绝对期限被上游刷新重置，可持续延长 | `session-store.ts:193-201` + `controller.ts:326-339` | **偏差（P1-1）** |
| "无 CSRF 的例外：无。包括登录、登出…"（`docs/security-model.md:38`） | 无会话时的幂等登出不走 CSRF | `controller.ts:402-413` | 偏差（P2-4，无实际危害） |
| "`/webui/health/ready` 返回 503 / not-ready"（上游不可达时，`docs/compatibility.md:46`） | ready 只看静态资源：`ready = staticAssetsPresent`（`health.ts:27-28`），上游不可达仍返回 **200**，upstream 仅作为信息字段 | `health.ts:24-37` | **文档自相矛盾**：`docs/acceptance-vps-20260922.md:56` 又写"200 …（无 Parrot 时的正确表现）"，与后者一致。判定实现是对的、`compatibility.md:46` 该改 |
| "`WEBUI_TRUST_PROXY` 必须等于真实入口代理地址/CIDR"（`docs/deployment.md:61`） | 实现一致 | `ip.ts:122-141` | 一致，但见 §4 的部署风险 |
| "限流：每来源每分钟 N 次"（`docs/security-model.md:62-70`） | 固定窗口，边界 2×；类名叫 Sliding | `rate-limit.ts:18-81` | 名实不符（P2-3） |
| "请求头只传 Accept/Content-Type/If-Match/Idempotency-Key/X-Request-Id"（`security-model.md:50-52`） | 一致 | `management-proxy.ts:36-48` | 一致 |
| "不开放 CORS" | 一致（全仓无 CORS 头） | `server.ts:73-86` | 一致 |
| "日志只记 5 字段 + redact 4 项" | 一致，且实跑确认默认日志被关闭 | `server.ts:89-101,51-59,62` | 一致 |
| "允许清单 76 条" | 76 条（73 proxy + 3 auth） | `route-allowlist.ts:47-53` | 一致 |
| "认证/业务/日志/密钥响应统一 `no-store`"（`docs/security-model.md:53`） | 413 与 400（空 JSON body）两个分支没有该头，其余分支都有 | `server.ts:118-141` | 偏差（P3，实跑逐分支确认） |
| "BFF 只代理冻结的 76 条管理路由"（`README.md:129`、`00-context.md`） | `/webui/bff/management/*` 下实际有 **77** 个可路由端点：76 条清单经通配 handler + 1 个静态注册的 `session-summary` | `management-proxy.ts:148-155` | 口径偏差：`session-summary` 无凭据泄露、前端零调用，但"76"这个数字严格说不涵盖全部端点 |

---

## 4. 无法验证的事项

1. **真实 Parrot 实例端到端**：所有上游语义结论来自 Python 源码静态核对；没有真实管理密钥，未对真实 Parrot 跑过登录/代理链路。
2. **`WEBUI_TRUST_PROXY` 在容器部署方式下应填什么**（**推断，风险最高的一项部署事项**）：`compose.yaml:47-48` 发布 `127.0.0.1:3000:3000`，宿主 Nginx 连过来时，容器内看到的对端地址通常是 Docker 网桥网关（如 `172.17.0.1`）而**不是** `127.0.0.1`。若照抄 `.env.example:49` 的 `WEBUI_TRUST_PROXY=127.0.0.1`，`X-Forwarded-For` 会被判为不可信而忽略，来源退化成"所有用户同一个键"——`docs/security-model.md:74-75` 自己就警告了这个后果（每来源 5 次/分钟变成所有人共享）。文档要求"现场确认"（`deployment.md:231`），但示例值给了一个在这种部署下大概率是错的地址。**建议改成注释掉 + 明确写"容器部署时这里应填 Docker 网桥网关或改用 host 网络"**，或在验收清单里加一条"两个不同客户端限流键必须不同"的实测。
3. **上游 Session 的真实 `expiresAt` 量级**：`sessions.py:178,321` 显示是长期绝对期限，但具体时长取决于上游配置，未在真实实例上取到值。P1-1 的结论不依赖该值（只要它 > 8h 即可复现，实跑已用 30 天值确认）。
4. **管理密钥的轮换流程**：`docs/security-model.md:102` 自述"轮换方式待现场确认"，上游代码里也没找到明确的轮换 API，无法验证泄露后的处置链路。
5. **并发/压测数据**：P1-3 的内存放大未做压测，5 MiB/请求的数字来自配置，不是实测的 RSS 增长。
6. **快照哈希**：`scripts/generate-contracts.mjs` 的 `--check` 校验逻辑读过（`:63-66,119`），但未实际执行（属于构建步骤，按约束未运行 build）。

---

## 5. 交接给其他人

- **给前端评审**：① P1-2 修好之前，任何"把用户输入塞进 `query=`/`search=`/`text=`/`name=`/`filter=`" 的输入框都会周期性 400；前端目前**没有**对这些 400 做特殊提示。② `apps/web/vite.config.ts:29` 的 `sourcemap: true` 会让产物带 .map 进镜像。③ 前端用 `newIdempotencyKey()`（36 字符）没问题，但注释里写的"≤200"是错的。④ `LogFilters.tsx:13-14` 自述"共享客户端只序列化标量"，即上游声明为数组的 `status/apiKey/model/channel/protocol` 参数实际只发单值——这是前端能力缺口，不是 BFF 缺陷。
- **给部署/文档评审**：§4.2 的 `WEBUI_TRUST_PROXY` 是本项目**最容易踩且最不报错**的部署坑（配错不报错、只降级限流），建议在验收清单里加实测项。另：`docs/compatibility.md:46` 与 `docs/acceptance-vps-20260922.md:56` 对 `/health/ready` 的描述互相矛盾，需定稿。
- **给契约评审**：P2-1（idempotency-key 200 vs 128）是 BFF 与上游契约的**唯一**已知不一致点。建议把"上游对转发头的长度/格式约束"补进 `packages/contracts` 的核对脚本，避免以后再加头时重犯。
- **给主流程**：若只修 3 处，按此顺序——P0-1（5 行改动 + 1 个测试）、P1-1（1 行改动 + 1 个测试）、P1-2（放宽正则 + 6 条路由的用例）。这三处都只动 BFF 内部，不触碰契约快照与前端。
- **给主流程（交付口径提醒）**：`/webui/bff/management/session-summary`（`management-proxy.ts:148-155`）是**不受 76 条允许清单约束**的第 4 个 `/webui/bff/management/*` 端点（静态路由注册，不走 `matchProxyRoute`）。功能无害（只返回 `sessionPayload`，不含 credential，且 `sessionPayload` 本身已排除凭据），但这个事实值得在交付说明/评审对答里讲清楚，否则容易被误判为"绕过白名单"。Lead 已实跑确认它返回 401 本地会话错误（不会代理出去），前端全仓零调用 → 属影子/死代码，建议直接删掉以消除"白名单之外还有端点"的解释成本。
- **本案已验证为"非缺陷"、请勿在汇总中误判为漏洞的项**：① `void app.register(cookie)` 未 await（Fastify ready 语义）；② `GET /bff/bootstrap`、`GET /bff/auth/session` 不做 Origin 校验（Origin 强制仅针对写方法）；③ `getSession` 命中即刷新 `lastSeenAt`（这就是 idle timeout 的正确语义）；④ 代理层"上游 401 即清会话"（上游 401 只可能来自 SESSION_REQUIRED/SESSION_EXPIRED/AUTHENTICATION_FAILED，已对 `error_mapping.py:27-50` 逐条核实，不会误伤）；⑤ 路径规范化的 14 类攻击（`..`、`%2f`、`%5c`、`%2e%2e`、双重编码、`//`、反斜杠、控制字符、大小写）全部被拒且零上游请求（实跑逐条确认）。
