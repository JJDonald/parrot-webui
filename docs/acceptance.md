# 验收与边界报告（已完成 / 未完成 / 未验证）

本文件是 parrot-webui 的自我核查记录。所有结论都对应真实执行过的命令或明确标注为未执行。

## 1. 基线事实

| 项目 | 值 |
| --- | --- |
| 上游仓库 | https://github.com/danger-dream/Parrot |
| 基线提交 | `9b73d058635470d59eef7a10876e6532649435d9`（`chore: 发布 v0.33.1`） |
| 契约快照 | `packages/contracts/upstream.openapi.json`（sha256 `ab552e2f…a5e2`，2 533 037 字节） |
| 快照来源 | 在隔离检出上执行 `app.openapi()`，**未启动 uvicorn、未连接任何真实 Parrot 实例、未读取用户配置或凭据** |
| 上游操作数 | 237 个（175 条 path、24 个 router、495 个 schema） |
| 允许清单 | 76 条路由（73 条业务代理 + 3 条 auth 类），由 `pnpm contracts:generate` 逐条核对存在性 |

## 2. 已完成

### 2.1 契约层（M0）

- 快照 + 来源记录（`packages/contracts/upstream-meta.json`）：提交号、发布号、字节数、sha256、操作数。
- `scripts/generate-contracts.mjs`：校验快照哈希；逐条核对允许清单是否真实存在于快照；生成
  `generated/management-routes.ts`（冻结路由表 + 契约来源常量）与 `generated/upstream-mvp.d.ts`（222 个 schema 类型 + 76 条操作摘要）。
- 允许清单显式排除项记录在 `packages/contracts/mvp-routes.json`（`updates/*`、`system/*`、`network/*`、`mcp/*`、`retention/*`、`proxy/*` 等高风险或非 MVP 能力整体不进入，Telegram 批准登录与部分 OAuth 高级能力列为第二阶段）。
- 执行记录：`pnpm contracts:generate` → `校验通过：76 条允许路由全部存在于快照；快照哈希匹配。`

### 2.2 BFF（M1）

- 本地会话：32 字节随机会话 ID（内存键为 sha256）、每浏览器独立上游凭证、空闲 30 分钟 / 绝对 8 小时（并受上游 `expiresAt` 约束）、容量上限 100/200 且过期自动清理、容量满先清理再 429（不驱逐有效会话）。
- 预登录：固定 5 分钟 TTL、`GET /bff/bootstrap` 复用有效预登录会话且不延长绝对寿命、bootstrap 与登录分别有 每来源/全局 限流与并发闸门。
- Cookie：生产 `__Secure-parrot_webui_session` / `__Secure-parrot_webui_prelogin`，`Path=/webui/`、HttpOnly、Secure、SameSite=Lax、不设 Domain；开发模式使用非 Secure 的测试 Cookie 名。
- 安全校验：Host 精确匹配（健康检查例外且仅限健康检查路径）、写请求强制 Origin 精确匹配 + Fetch Metadata 补充校验、CSRF 常量时间比较、JSON 内容类型限制。
- 代理：固定 `PARROT_BASE_URL`、冻结 method+path 模板、拒绝 `..`/反斜杠/编码斜杠/协议相对路径/双重解码、query 键拒绝清单、请求头白名单（Accept/Content-Type/If-Match/Idempotency-Key/X-Request-Id）、Bearer 由 BFF 设置、**不跟随重定向**（3xx 转结构化错误）、体积上限（普通 1 MiB / OAuth 导入 5 MiB / 上游响应 10 MiB）、连接与总超时分离。
- 错误语义：BFF 自有 `WEBUI_*` 错误带 `source: "webui"` 与 `x-webui-error-source` 头；上游业务错误、状态码、`Retry-After`、requestId 原样透传；204 不强行 JSON.parse；非 JSON 上游响应转结构化错误。
- 日志：只记录方法、路由模板、状态、耗时、requestId；不记录 query、body、Cookie、Authorization 与密钥。
- 会话失效处理：上游 401/`SESSION_EXPIRED` 一律清理本地会话；注销无论上游是否可达都销毁本地会话，未确认时返回 `upstreamRevocation: "unconfirmed"` 且不声称已远程吊销。
- 静态托管：`/webui/` 前缀、SPA fallback 只覆盖页面导航、`/webui` → `/webui/` 308、index.html 重新验证、`assets/*` 长期缓存、`/webui/bff/*` 与 `/webui/health/*` 保持 JSON 404、CSP（`script-src 'self'`，仅为兼容 Ant Design 放开 `style-src 'unsafe-inline'`）。
- 上游不可达时仍可启动并给出诊断：`/webui/health/live` 不依赖上游，登录页展示可达性探测结果与原因。

### 2.3 前端（M2/M3 页面）

- 路由与布局：`/webui/` 前缀、`BrowserRouter basename=/webui`、左侧导航 + 玻璃顶栏 + 主内容区、移动端抽屉侧栏、三套主题（纸感米色 / 纯白 / 暖炭黑，令牌取自参考项目 cpa-usage-keeper）。
- 统一数据层：`apps/web/src/api/client.ts` 是唯一 BFF 客户端（自动附加 CSRF、统一归一化错误、区分上游/传输错误）；`hooks.ts` 固化「mutation 不重试、query 仅对传输类错误有限重试、后台标签页降频」；`operations.tsx` 实现 202 任务跟踪（1s→2s→5s 轮询、仅 `cancellable` 可取消、终态停止、404 视为记录不可用并刷新业务资源、部分成功提示）。
- 通用组件：六态展示（加载/正常/空数据/失败/权限不足/连接中断）、错误与冲突提示（409 不自动覆盖、`SAVED_RELOAD_UNCONFIRMED` 禁止重放、429 显示等待时间）、徽标/时间/秘密值/原始内容（纯文本）/危险操作确认。
- 页面：登录、总览、渠道、OAuth 账号、模型中心、下游 API Key、请求日志、管理任务、版本与诊断。
- 安全约定：管理密钥只在登录请求内存中，不入 localStorage/sessionStorage；OAuth `flowSecret`/`importSecret` 只在当前流程内存中；日志正文等原始内容仅以纯文本渲染。

### 2.4 交付与部署

见 `Dockerfile`、`compose.yaml`、`.env.example`、`deploy/nginx-webui.conf`、`deploy/Caddyfile.example` 与 `docs/deployment.md`、`docs/security-model.md`、`docs/compatibility.md`、`docs/contracts.md`。

## 3. 已执行的验证

全部命令在仓库根目录执行，结果为本次交付的真实输出。

| 命令 | 结果 |
| --- | --- |
| `pnpm contracts:generate` | 通过：`校验通过：76 条允许路由全部存在于快照；快照哈希匹配`；生成 76 条冻结路由 + 222 个 schema 类型 |
| `pnpm typecheck`（contracts / bff / e2e / web 四个包） | 全部通过（`typecheck: Done` × 4，无 `error TS`） |
| `pnpm test` | 通过：**71 个用例全绿**。BFF 4 个文件 43 例；Web 2 个文件 20 例；E2E 1 个文件 8 例 |
| `pnpm build` | 通过：`packages/contracts` 编译为 ES 模块 + d.ts；Vite 构建 `apps/web/dist`（`✓ built in 6.82s`）；`tsc` 构建 `apps/bff/dist` |
| `pnpm --filter @parrot-webui/e2e test:smoke` | 通过：**14/14**，见下方"构建产物冒烟测试" |
| `docker compose config`（以 `.env.example` 为 env-file） | 通过：`name: parrot-webui`，端口仅 `host_ip: 127.0.0.1, published: 3000`；缺少 `.env` 时按设计报必填变量缺失 |
| Docker 上下文依赖安装（模拟 Dockerfile 阶段） | 通过：`pnpm install --frozen-lockfile`（320 包）与 `pnpm install --prod --frozen-lockfile`（167 包）均在只含 Dockerfile 所 COPY 文件的目录中成功 |
| `docker build` / `docker compose up -d --build` | **未执行**：本机 Docker 守护进程不可用；镜像构建与容器运行未验证 |

### 3.1 BFF 安全用例（43 例，`pnpm --filter @parrot-webui/bff test`）

- 未登录访问业务代理 → 401 `WEBUI_SESSION_REQUIRED`，且假上游**零请求**；
- Host 不符 → 421；Origin 缺失 / `null` / 错误 / 协议不符 → 403；CSRF 缺失 / 错误 → 403（含正向对照：正确请求确实被转发）；
- 登录接口与业务写接口受同一套 Origin + CSRF 保护，失败时不触达上游；
- 14 条路径攻击（`..`、`%2f`、`%5C`、原始反斜杠、`//`、协议相对绝对 URL、双重解码、`updates/*`、`system/*`）全部 400/404 且零上游请求；`/auth/*` 经业务代理被拒；
- 上游 302 → 502 `WEBUI_UPSTREAM_REDIRECT_BLOCKED` 且不跟随；上游 HTML → 502 `WEBUI_UPSTREAM_UNEXPECTED_CONTENT`；连接被拒 → 502 `WEBUI_UPSTREAM_UNREACHABLE`；超时 → 504 且不重放；超体积（content-length 与 chunked 两条路径）→ 502 `WEBUI_RESPONSE_TOO_LARGE`；
- 204 空体、409 `REVISION_CONFLICT` 信封与 requestId、429 + `Retry-After` 均原样保留；query 保真；
- 转发头白名单：上游只收到白名单头 + BFF 设置的 `Authorization: Bearer <上游凭证>`，**没有**浏览器 Cookie / Origin / Referer / XFF，Host 为上游地址；
- 会话：登录后 Cookie 属性正确且响应体/头部/Cookie 中无 credential；会话 ID 与 CSRF 轮换、预登录不可复用；注销吊销上游并让旧 Cookie 立即失效（缺 CSRF/Origin 时拒绝且保留会话）；上游不可达时注销仍销毁本地会话（`unconfirmed`）；两个浏览器凭证独立、注销不串会话；`maxSessions=1` 时第二个登录 429 且不驱逐已有会话；上游 401 与业务请求 401 均清理会话；
- 配置校验：缺 `PARROT_BASE_URL`、base path 非 `/webui/`、生产 http 来源、上游 URL 带路径/凭据、等于 `WEBUI_PUBLIC_ORIGIN`、生产 trust proxy 为空或 `*` 全部失败；
- 限流与来源：bootstrap 单来源限流 429 + `retry-after`，不同来源互不影响；伪造 XFF 在直连不可信时被忽略。

### 3.2 端到端链路（8 例，`pnpm --filter @parrot-webui/e2e test`）

真实 HTTP + 真实 Cookie/CSRF：bootstrap → 登录（管理密钥换票）→ 读取渠道 → 409 冲突 → 允许清单外路径与编码绕过 → 注销 → 健康检查。关键断言见 3.1 与 3.3。

### 3.3 构建产物冒烟测试（14 例，`pnpm --filter @parrot-webui/e2e test:smoke`）

直接启动 `apps/bff/dist/index.js` 并用 `apps/web/dist` 提供页面，验证交付形态（非源码形态）：

1. 进程启动并就绪（`/webui/health/live` 不依赖上游）；
2. `GET /webui/` 返回 SPA 首页；`index.html` 使用 `no-cache, must-revalidate`；
3. `assets/*` 使用 `public, max-age=31536000, immutable`；
4. CSP 含 `script-src 'self'`、`frame-ancestors 'none'`，并带 `nosniff`、`no-referrer`；
5. 深链接 `/webui/channels` 走 SPA fallback；
6. bootstrap 返回实例名、`["managementKey"]` 与预登录 CSRF，且**不包含**上游内部地址；
7. 未登录业务请求 401 `WEBUI_SESSION_REQUIRED`；
8. 登录缺 Origin/CSRF → 403 `WEBUI_ORIGIN_REJECTED`；
9. 未知 `/webui/bff/*` → JSON 404（带 `WEBUI_` code）；
10. 域名根下的 `/api/...` → 404（不提供第二套入口）；
11. 错误 Host → 421 `WEBUI_HOST_REJECTED`；健康检查同样校验 Host。

### 3.4 前端与允许清单一致性（`pnpm check:frontend-paths`）

扫描前端源码中出现的每个上游管理路径，与冻结允许清单逐条比对：**76 条模板 vs 55 条前端路径，全部命中**，不存在“页面调用了未开放接口”的运行时 404 风险。

### 3.5 验证过程中发现并修复的真实缺陷

1. **上游丢弃响应体时的未捕获异常（可达拒绝服务）**：`upstream/client.ts` 在"拒绝跟随重定向"和"响应超体积"两条安全路径上直接调用 `response.body.destroy()`，undici 会因此抛出 AbortError，无人监听时成为进程级 uncaught exception —— 即上游返回 3xx 或超大响应就能让 BFF 崩溃。已改为先挂 `error` 监听再销毁（`discardResponseBody()`），状态码与安全语义不变。
2. **缓存策略被插件覆盖**：`@fastify/static` 自带的 `Cache-Control` 计算覆盖了自定义 `setHeaders`，导致 `index.html` 变成 `public, max-age=0`、带 hash 的资源也没有 `immutable`。已在该插件注册时关闭 `cacheControl`，由自有策略决定（缺陷由本次冒烟测试发现，已复测通过）。

## 4. 未完成（明确不在本版范围）

1. Telegram 批准登录（`/auth/telegram-approvals` 全流程）。
2. 其余 OAuth 供应商的登录/导入路径（本版仅实现通用 `login-flows` / `imports` 调用与状态处理，未逐家联调）。
3. 高级模型元数据覆盖、负载均衡、网络诊断/配置、MCP/搜索配置、多媒体日志与预览、日志留存。
4. 更新/重启类操作（`updates/*`）默认不开放，也不作为安装或兼容前提。
5. OAuth 账号 `reset-quota`、`workbuddy/*`、`invalid-accounts/delete*` 与 API Key `actions/generate-replacement`（仅提供 `generate-replacement-plan`）。
6. 多实例切换、持久会话集群、多租户、聊天工作台。
7. 跨页全选批量操作：仅在接口语义允许的范围内提供（模型中心按真实 selection 语义提交明确目标状态）。
8. **列表筛选只支持单值**：上游的列表筛选参数是 repeated query（同名多值），而共享的 `buildQueryString` 只序列化标量，因此日志/账号等页面的筛选目前是单值精确匹配，尚未提供多选；扩展点在 `apps/web/src/api/client.ts`，本次未改动。
9. **模型别名（alias）新增/修改/删除未实现**：允许清单里只有 `GET /models`、`GET /models/{resource_key}`、`PATCH /models/actions/state`，别名接口不在清单内，模型中心只提供状态与来源管理。
10. 前端组件级测试仍不完整：现有 20 个用例聚焦安全与纯函数（日志 XSS、体积上限、OAuth 秘密值不入存储/URL、未知额度不显示为 0），页面交互（抽屉、表单提交、冲突处理）尚无自动化测试。
11. 页面交互尚未在真实浏览器中人工走查（登录 → 总览 → 渠道 → 账号 → 模型 → Key → 日志 → 任务 → 注销）。

## 5. 未验证（必须现场确认）

1. **真实 Parrot 实例联调**：本仓库从未连接任何真实实例；所有网络行为都用本地假上游验证。
2. **真实管理密钥登录**：未使用真实密钥（源码要求至少 48 字节），登录换票仅在假上游上验证。
3. **真实供应商 OAuth**：未与 OpenAI / Claude 等真实授权端点联调，"授权成功但模型同步失败"等分支仅按代码路径处理。
4. **Docker 构建与运行**：`Dockerfile`、`compose.yaml` 未在本机构建/启动验证；只读根文件系统、非 root、tmpfs、健康检查均未实测。
5. **反向代理**：`deploy/nginx-webui.conf` 未在真实 Nginx 上做过 `nginx -t` 与平滑 reload；未验证原 `/v1`、`/api/management/v1`、`/mcp` 无回归。
6. **公网端口封闭**：未从另一台公网机器验证宿主 3000/内部端口不可达。
7. **浏览器行为**：未在真实 HTTPS 域名下验证 `__Secure-` Cookie、CSP（Ant Design CSS-in-JS）、深链接刷新与移动端布局；仅在构建/类型层面校验。
8. **上游版本差异**：允许清单、分页与 revision 语义均以基线提交为准；用户实例若为其他版本，需按 `docs/compatibility.md` 重新核对（登录后读 `/meta`、`/capabilities`，`scripts/generate-contracts.mjs --check` 校验快照）。

## 6. 未改动原 Parrot 的检查记录

- 只读操作：`git clone` + `git fetch` 上游仓库，在工作区外（会话 scratch 目录）检出；
- 生成契约时只导入管理路由并调用 `app.openapi()`，未启动服务、未读用户配置/数据目录、未连接任何实例；
- 本仓库不包含 Docker socket 挂载、不挂载原 Parrot 数据目录、不读写其 JSON/SQLite；
- 所有写入均针对本仓库文件；未修改原 Parrot 的镜像、Compose、环境变量、端口、网络附件与代码。
