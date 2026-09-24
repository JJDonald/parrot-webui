# Parrot WebUI 独立容器开发实施文档

> 用途：将本文完整交给其他编程模型，作为独立项目的实现任务书、接口接入指南和验收依据。
>
> 用户核心要求：独立 WebUI 必须安装在 Parrot 同一台机器；唯一公开入口为 Parrot 现有 HTTPS 域名下的 `/webui/`。不修改原 Parrot 容器、镜像、代码或应用部署配置；允许为此在现有入口反向代理增加路径规则。禁止独立公网 IP＋端口、独立域名或子域名入口。
>
> 本文交付的是实施设计，不代表 WebUI 已实现。上游事实来自源码静态核查，未对真实 Parrot 实例运行联调或完整测试。

## 1. 项目目标与不可改变的边界

### 1.1 目标

开发独立项目 `parrot-webui`，交付独立 Docker 镜像和独立 Compose 文件，与 Parrot 同机安装。通过现有 Parrot 域名的 `/webui/` 路径管理已有实例，BFF 只连接本机 Parrot 的既有内部入口。

WebUI 是 Parrot Management API 的客户端，不是注入原容器的插件，也不是重新实现 Parrot 后端。

必须达成：

1. 原 Parrot 保持原样运行。
2. WebUI 可单独安装、升级、重启、卸载。
3. WebUI 停止或损坏时，不影响原 Parrot 推理 API 和 Telegram 管理。
4. 浏览器操作通过原管理 API 生效，与 Telegram 共用原有业务状态。
5. 所有持久业务数据仍由原 Parrot 管理。
6. 默认支持一个目标 Parrot 实例；暂不实现多实例切换。
7. 正式部署只允许同机，不能部署到另一台服务器连接 Parrot。
8. 公网只通过现有域名的 `/webui/` 进入；禁止新增公网监听端口、独立域名和子域名。
9. 可以修改现有入口反向代理的路径分流配置，但不能修改原 Parrot 容器和应用部署。若入口配置只存在原容器内且不可在外部管理，应报告阻塞，不能擅自进容器修改。

### 1.2 明确禁止

- 修改、替换或重新构建原 Parrot 镜像。
- `docker exec` 进入原容器安装前端、写代码或修改配置。
- 修改原 Compose、环境变量、启动命令、端口或网络附件。
- 要求修改原 `management.allowedOrigins` 才能使用。
- 将原 Parrot 数据目录挂载到 WebUI，或直接读写其 JSON/SQLite。
- 挂载 Docker socket，获取容器控制权限。
- 使用自动升级接口、修改上游配置或重启原容器来绕过兼容问题。
- 在 WebUI 中复制 OAuth 刷新、渠道调度、额度计算、模型路由等业务逻辑。
- 把推理 API Key 当作管理登录凭据。
- 向未登录浏览器自动附加固定管理密钥或公共管理员 Session。
- 将页面上演示数据当成真实接入成果。

用户通过页面主动修改渠道、Key、模型等业务资源，属于正常 API 管理；不属于安装过程修改原容器。安装与兼容检查阶段不得自动修改这些资源。

### 1.3 原实例必须满足的前提


允许的入口改动仅限现有 Parrot 域名的反向代理：新增 `/webui` 跳转和 `/webui/` 路由，完成配置校验与平滑 reload。原 `/v1/*`、`/api/management/v1/*`、`/mcp` 等已有路径和转发行为必须保持。安装程序不得创建新的公网 WebUI 端口。

- 已具有 `/api/management/v1` 管理 API，管理运行时初始化成功。
- WebUI 容器可以通过已存在的网络路径访问该 API。
- 用户能取得已有的管理密钥，或实例已支持可用的 Telegram 管理批准流程。

若前提不满足，显示明确的兼容/连接诊断。不得承诺仅通过网页就能补出不存在的管理 API，也不得偷偷改动原容器。

## 2. 上游基线与已核实事实

### 2.1 评估基线

- 仓库：<https://github.com/danger-dream/Parrot>
- 分支：`main`
- 核查提交：`9b73d058635470d59eef7a10876e6532649435d9`
- 该提交信息：`chore: 发布 v0.33.1`
- 实施时应优先以该提交和用户实际运行实例建立契约；不要默认未来 main 与本文一致。

### 2.2 源码事实

1. 原项目为 Python/FastAPI 服务，当前 Docker 基础为 Python 3.11。
2. 正式应用在 `server.py` 挂载管理 API。
3. 管理路由位于 `src/management_api/routers/`，schema 位于 `src/management_api/schemas/`。
4. Management API 和 Telegram 共用 `src/management_control/`。
5. 仓库没有现成网页前端或 SPA 静态托管；名字含 `webui` 的测试主要验证后端契约。
6. 路由组合测试断言 237 个管理操作、24 个 router；这是源码中的测试定义，不表示本次已运行通过。
7. 原管理 API 用 Bearer Session 认证。管理密钥仅用于换取 Session。
8. 管理 Origin 中间件：请求携带 Origin 且不在白名单时拒绝；服务端请求没有 Origin 时不走这项浏览器来源拒绝条件，仍必须通过正常鉴权。
9. `allowedOrigins` 默认空，且不接受 `*`。
10. 管理接口具有错误码、requestId、revision、异步 operation 等现成语义。
11. 部分后台任务状态为进程内状态，原实例重启后不保证继续可查。
12. 项目使用 MIT 许可；如复制受许可源码，应保留相应声明。

### 2.3 本文中的三种信息

- **上游事实**：标注为原 Parrot 已有接口、行为或源码。
- **新项目约定**：本文为 WebUI/BFF 定义的目录、接口、环境变量和默认值。
- **待联调确认**：仅靠源码不能确认的生产版本、网络、供应商行为。

实现时不允许把“新项目约定”误认为上游已实现的接口。

## 3. 总体架构

```text
浏览器 https://原Parrot域名/webui/
  │ 原有 HTTPS 入口 / 同机反向代理
  ├── /webui/ → 独立 WebUI 容器（仅回环端口或内部容器网络）
  │                 ├── React 静态页面
  │                 └── Node.js / Fastify BFF
  │                       ├── Cookie、CSRF、Origin、限流
  │                       └── 服务端保存原管理 Session
  │                              │ 无浏览器 Origin/Cookie
  │                              │ Bearer Session
  │                              ▼
  │                      本机原 Parrot 管理 API
  └── 其余已有路径 → 原 Parrot（原规则保持）
```

### 3.1 为什么使用 BFF

BFF 是本项目自己的轻量浏览器适配服务。它有三个职责：

1. 将浏览器 Cookie 会话安全地转换成原管理 API 的 Bearer Session。
2. 在不修改原 Origin 白名单的情况下完成服务端到服务端访问。
3. 托管前端，并统一提供连接诊断与少量适配错误。

它不维护另一套账号库、渠道库、日志库，不改写原业务规则。

原项目文档曾将 BFF 排除在当时的管理层重构范围之外；那是该次上游改造的范围约束。本独立项目增加自己的 BFF，不要求原项目接受 BFF 代码或私有接口。

### 3.2 推荐技术栈

| 部分 | 固定建议 | 目的 |
| --- | --- | --- |
| 前端 | React + TypeScript + Vite | 静态 SPA，类型安全 |
| 组件 | Ant Design | 表格、表单、抽屉、分页、中文界面 |
| 路由 | React Router | 页面导航、深链接 |
| 数据请求 | TanStack Query | 查询缓存、失效、受控轮询 |
| 类型生成 | openapi-typescript 或等价工具 | 从核实过的 OpenAPI 生成类型 |
| BFF | Node.js 24 LTS + Fastify + TypeScript | 同一容器托管静态页面和 API |
| 测试 | Vitest、Fastify inject、Playwright | 契约、安全和核心浏览器流程 |
| 包管理 | pnpm workspace + 锁文件 | 单仓库、可复现构建 |
| 交付 | 多阶段 Docker 构建 + 独立 Compose | 不增加原项目依赖 |

具体依赖版本应在实施时选择相互兼容的稳定版本并锁定；不要混用多个包管理器。第一版不引入 SSR、Redis、外部数据库、插件市场或消息总线。

### 3.3 部署粒度

一个镜像，一个 WebUI 服务进程，容器内默认监听 `3000`；这个端口绝不直接对公网发布。

- 正式公开前缀固定为 `/webui/`；前端、BFF 和反向代理统一保留该前缀，不使用剥除前缀的另一套规则。
- Vite `base='/webui/'`；React Router `basename='/webui'`；所有静态资源、登录跳转、请求 URL 都通过统一 base helper 生成。
- 正式 BFF 路径为 `/webui/bff/*`，健康检查为 `/webui/health/live`、`/webui/health/ready`，健康检查不对公网转发。
- 后文为简洁书写的 `/bff/*`、`/health/*` 以及页面路径，均是相对 WebUI 挂载点的逻辑路径；浏览器和容器实际请求必须加 `/webui`。原 Parrot `/api/management/v1` 不加此网页前缀。
- SPA fallback 仅处理 `/webui/` 下的页面导航，不能吞掉 BFF、健康检查、缺失静态资源或 Parrot 原路径；根 `/` 不提供另一套管理入口。
- 第一版 BFF 仅运行单进程、单副本；会话保存在有界内存中。
- 容器重启后要求用户重新登录，这是明确支持的行为。

## 4. 浏览器会话与登录设计

本节定义的是新 WebUI 的实现要求。不要将原 Parrot Session 直接返回给浏览器。

### 4.1 本地会话数据

登录成功后生成至少 32 字节密码学随机会话 ID。Cookie 仅携带这个随机值，不携带原管理密钥、Parrot Session credential 或完整用户资料。

服务端内存映射建议：

```ts
interface WebSession {
  // 可将随机 Cookie 值的哈希作为 Map key；不得用可预测 ID。
  upstreamCredential: string;
  upstreamSessionSummary: unknown; // 用生成类型替换。
  csrfToken: string;
  createdAt: number;
  lastSeenAt: number;
  absoluteExpiresAt: number;
  upstreamAbsoluteExpiresAt: number;
  upstreamIdleExpiresAt: number;
}
```

约束：

- 每个浏览器登录使用独立的上游 Session，不共享固定管理员凭据。
- 管理主密钥只在用户提交登录的那次请求内短暂使用，不写磁盘、日志或环境变量。
- 不在 localStorage/sessionStorage/IndexedDB 中保存任何管理凭据。
- 本地 Session 默认空闲 30 分钟、绝对 8 小时；不得超出上游已知有效期。
- 创建会话时，本地绝对截止时间取“创建时刻+8小时”与上游 expiresAt 的较小值；请求前检查本地空闲期和上游已知有效期。需要延续上游空闲期时，用真实 `/auth/session` 摘要刷新 idleExpiresAt，不假定成功读取自动提供新截止时间，也不把 stale idleExpiresAt 当永久截止时间。无法确认续期时保守要求重新登录。
- 原上游校验仍然权威；任何上游会话失效响应都必须清理本地会话。
- 有过期清理和容量限制，默认最多 100 个已登录会话、200 个短期预登录会话。
- 预登录会话 TTL 固定为5分钟；bootstrap 复用尚有效的预登录会话，不每次刷新都新建。bootstrap 本身也按可信来源限流（建议每来源20次/分钟、全局100次/分钟），且限制创建并发。容量满时先清理过期项，再对新增请求返回429；不能驱逐尚有效的登录流程或已登录会话。
- 新登录轮换会话 ID 与 CSRF Token，防止会话固定。
- 不加入“记住管理主密钥”。

### 4.2 Cookie 要求

生产 HTTPS：

```text
__Secure-parrot_webui_session=<opaque random id>;
Path=/webui/; HttpOnly; Secure; SameSite=Lax
```

不设置 Domain。预登录 Cookie 使用独立名称 `__Secure-parrot_webui_prelogin`，同样要求 Path=/webui/、HttpOnly、Secure、SameSite=Lax，Max-Age=300。清除 Cookie 时必须使用相同名称和 Path。滚动刷新不得延长绝对会话寿命。

不能使用要求 Path=/ 的 `__Host-` 前缀；本项目使用 `__Secure-` 与 `/webui/` Path 限定，避免 Cookie 默认发送到原推理路径。Cookie Path 不是同源脚本隔离边界：原域名下的内容必须可信，仍要防 XSS 并验证 CSRF。

正式部署只支持原域名 HTTPS，不提供公网或局域网 HTTP 登录开关。纯代码开发测试可使用仅绑定127.0.0.1的开发服务器和专用非Secure测试Cookie；此模式不打包为正式部署入口，仍验证 `/webui/` 前缀。

### 4.3 原 Parrot 管理密钥登录契约：已核实

```http
POST /api/management/v1/auth/sessions
Content-Type: application/json

{"grantType":"managementKey","managementKey":"用户输入的管理密钥"}
```

成功返回 HTTP 201，结构如下；字段值由真实上游返回，不要复制占位值：

```json
{
  "data": {
    "credential": "只交给BFF保存的上游Session凭证",
    "session": {
      "sessionId": "...",
      "subjectId": "...",
      "authMethod": "...",
      "roles": [],
      "capabilities": [],
      "issuedAt": "ISO时间",
      "expiresAt": "ISO时间",
      "idleExpiresAt": "ISO时间"
    }
  },
  "meta": {"requestId": "..."}
}
```

后续 BFF 调用使用 `Authorization: Bearer <credential>`。

- 原会话查询：`GET /api/management/v1/auth/session`。
- 原当前会话注销：`DELETE /api/management/v1/auth/session`，成功 204。
- 原 schema 拒绝多余字段；不要自行加 `username/password/rememberMe` 给上游。
- 原源码要求管理密钥至少 48 字节；网页无需自行修补或生成替代密钥。

### 4.4 新 WebUI 登录流程

1. 浏览器访问 `GET /bff/bootstrap`，取得不含目标内部地址的公共配置、登录方式描述和短期预登录 CSRF Token，同时建立预登录 HttpOnly Cookie。
2. 用户在密码输入框填入现有管理密钥。
3. 浏览器提交 `POST /bff/auth/login`，带正确 Origin、预登录 Cookie、`X-CSRF-Token`，body 为 `{managementKey}`。
4. BFF 验证来源、CSRF、Content-Type、请求大小和登录限流。
5. BFF 用固定上游地址调用原 `auth/sessions`。
6. BFF 保存 credential，轮换为已登录会话，返回可展示的 Session 摘要与新的 CSRF Token。
7. 浏览器立即清空管理密钥输入和相关内存状态。
8. 登录成功后读取 meta/capabilities 和总览。

浏览器刷新通过 `GET /bff/auth/session` 恢复自己的登录状态和 CSRF Token。该接口不得返回 upstreamCredential。

失败登录显示明确状态，不回显输入的密钥。上游不可达与认证失败要区分。

### 4.5 注销与过期

- `POST /bff/auth/logout` 必须通过来源和 CSRF 验证。
- 使用当前本地 Session 对应凭证调用原 `DELETE /auth/session`。
- 无论上游是否可达，本地必须销毁会话并清除 Cookie。
- 若上游注销失败，提示“本地已退出，上游会话注销未确认”，记录不含凭证的诊断。
- 可进行有界、短期的服务端注销重试；不能因此恢复浏览器会话。
- BFF 重启会丢失上游凭证；原 Session 可能暂时仍在上游有效直到超时，不可声称重启已经远程吊销全部会话。
- 多标签页可用 BroadcastChannel 通知退出；不得广播 credential 或密钥。

### 4.6 Telegram 管理登录：第二阶段

注意：这里是“登录管理台的 Telegram 批准”，不同于“向 Parrot 添加供应商 OAuth 账号”。

原接口：

1. `POST /auth/telegram-approvals`：body 为 `{clientName, deviceSummary?}`。
2. 返回 `approvalId`、`exchangeSecret`、`expiresAt`、`pollAfterSeconds`。
3. `GET /auth/telegram-approvals/{approvalId}` 使用 `Authorization: Approval <exchangeSecret>`，不是 Bearer。
4. 返回状态 `pending | approved | denied | expired | consumed`。
5. approved 后调用原 `POST /auth/sessions`：

```json
{"grantType":"telegramApproval","approvalId":"...","exchangeSecret":"..."}
```

BFF 保存 exchangeSecret，将批准流程绑定到发起它的预登录浏览器会话，按 pollAfterSeconds 查询。不得把批准结果交换到其他浏览器会话，也不得每次轮询都重新创建批准请求。

首版可只交付管理密钥登录；未实现的登录方式不要显示可点击的假按钮。

## 5. BFF 安全边界与代理规则

这是“不修改原 Origin 配置”方案的必要组成部分，不得用一个无鉴权的任意 URL 转发接口替代。

### 5.1 Origin、CSRF 和 Host

- 以部署配置 `WEBUI_PUBLIC_ORIGIN` 为唯一合法浏览器 Origin，精确匹配协议、主机、端口。
- 所有写操作，包括登录、注销、OAuth 轮询 POST，均要求正确 Origin 和 CSRF Token。
- Origin 缺失、`null`、错误或 CSRF 缺失时拒绝浏览器写请求，不因 Cookie 有效就放行。
- 预登录 CSRF 与预登录 Cookie 绑定；登录后重新生成。
- 不开放跨域 CORS，不返回 `Access-Control-Allow-Origin: *`。
- 可用 Fetch Metadata 作为补充校验，不能替代 Origin/CSRF。
- 校验 Host，防止任意主机名访问；不要盲目信任 X-Forwarded-Host/Proto。
- 反向代理场景只信任显式配置的代理地址；判断合法浏览器来源以固定 PUBLIC_ORIGIN 为准。
- 生产安装必须将实际反向代理地址/CIDR列入 WEBUI_TRUST_PROXY，并保证代理覆盖伪造的客户端来源头；不要信任任意来源的 X-Forwarded-For。验证两个不同客户端的限流键不同，防止所有用户误共享BFF的单来源额度。原Parrot对BFF的上游来源限流仍保持，不绕过。
- 健康检查可允许内部 Host，但仅允许在健康检查路径例外，不扩展到 `/bff/*`。

### 5.2 固定目标与路由允许清单

- 上游 URL 只从部署环境 `PARROT_BASE_URL` 读取，不允许浏览器传入任意 upstream/target/url。
- 只允许 http/https URL；拒绝用户名密码、query、fragment。
- 第一版 `PARROT_BASE_URL` 定义为本机原服务的origin，例如 `http://host.docker.internal:22122`，不包含 `/api/management/v1`。此项只约束BFF访问原API；WebUI自身必须支持 `/webui/` 挂载，不可混淆两种路径。
- 浏览器业务入口固定为 `/webui/bff/management/*`，映射到上游 `/api/management/v1/*`，不得映射回原域名的 `/webui/` 形成代理循环。
- 业务代理仅允许构建时冻结的 method + route 模板集合，不开放整个任意路径空间。
- 原 `/auth/*` 不进入通用代理；只能由专门登录/会话控制器调用。
- `/openapi.json` 只用于开发时获取契约或受控诊断，不能成为任意代理入口。
- 不代理 `/v1/*` 推理入口，不将该服务做成公共 AI 网关。
- 未实施的管理操作默认不在白名单中，尤其是更新、重启、删除全量日志等操作。

路径处理必须拒绝越界规范化、`..`、反斜杠、绝对 URL、双重解码绕过和协议相对 URL。业务资源 ID 可能包含特殊字符，必须按已验证的路由参数正确编码；不要把所有 `%2F` 一概拒绝，先区分正常标识和路径逃逸。

禁用自动跟随上游重定向，避免把 Authorization 带到其他主机。目标私网地址是正常用例，不应被通用 SSRF 库误拦；关键是目标只能由部署者配置且不可由请求改变。

### 5.3 请求头转发

BFF 对上游请求重新构建头部，不复制整个浏览器 header 集合。

允许按业务需要传递：

- `Accept`、合法 `Content-Type`。
- `If-Match`，保持读取到的 opaque revision 值，不自行改写。
- `Idempotency-Key`，仅对已确认支持的操作使用；保留合法原值。
- `X-Request-Id`，校验后传递，否则生成。
- 必要的条件请求头，只有在确实支持的接口中加入允许清单。

由 BFF 自己设置：`Authorization: Bearer <该浏览器Session对应credential>`。

不得转发浏览器的：Authorization、Cookie、Origin、Referer、Host、X-Forwarded-*、Proxy-*、Connection 等 hop-by-hop 头。

原管理 API 在无 Origin 的服务端请求中仍校验 Bearer Session。BFF 去掉 Origin 的前提是自己完成了来源和 CSRF 校验；不能做成任何人都可调用的认证绕过代理。

### 5.4 响应与错误

- 尽量保留上游业务 JSON、HTTP 状态、requestId、revision、operationId。
- 204 响应不能强行 JSON.parse。
- 不将失败统一变为 HTTP 200。
- 不透传上游 Set-Cookie、CORS、hop-by-hop 头。
- 所有认证、业务、日志、密钥响应使用 `Cache-Control: no-store`。
- 仅对静态带 hash 资源启用长期缓存；index.html 使用重新验证策略。
- 上游 HTML 错误页不能按 HTML 插入前端；转为本地结构化错误。
- BFF 错误使用独立 `WEBUI_*` code，例如 `WEBUI_UPSTREAM_UNREACHABLE`、`WEBUI_UPSTREAM_TIMEOUT`、`WEBUI_SESSION_REQUIRED`、`WEBUI_CSRF_REJECTED`、`WEBUI_RESPONSE_TOO_LARGE`。
- UI 区分“Parrot 返回的业务错误”和“WebUI 到 Parrot 的传输错误”。

### 5.5 超时、体积、日志

建议初始默认值，必须环境化或按路由明确配置：

| 项目 | 默认建议 |
| --- | --- |
| 普通 JSON body | 1 MiB |
| OAuth 导入 body | 5 MiB，单独路由限额 |
| 上游 JSON 响应 | 10 MiB；超过时结构化提示，不静默截断 |
| 连接超时 | 5 秒 |
| 普通请求总超时 | 30 秒 |
| 已核实需要同步等待的少数操作 | 独立设置更长时间；不能无限等待 |
| 登录限流 | 每来源每分钟 5 次、全局每分钟 30 次，另加并发上限 |

原上游还会按 BFF 网络来源独立限流；多用户可能共享同一来源配额。保留 429 和 Retry-After；不要通过伪造来源头来规避原限流。

只记录请求方法、允许清单中的路由模板、状态、耗时、requestId 和脱敏错误码。不记录完整 URL query、请求/响应 body、Cookie、Authorization、密钥、OAuth token 或原始日志正文。

浏览器断开时可中止不再需要的只读传输，但不能把中止解释为“写操作未执行”。创建/修改请求超时后提示刷新确认结果，不自动重发。

## 6. 第一版功能与页面规格

### 6.1 页面结构

```text
/login                     管理密钥登录与连接状态
/                          已登录后进入总览
/channels                  第三方 API 渠道
/accounts                  OAuth 账号
/models                    模型中心
/api-keys                  下游 API Key
/logs                      请求日志
/tasks                     当前管理任务
/about                     版本、连接诊断、兼容状态
```

桌面布局使用左侧导航、顶部连接/会话状态、主内容区。中文优先。主要表格配合详情抽屉，避免所有操作都跳转页面。移动端至少支持登录、状态查看、详情和基本启停操作。

所有列表必须有：加载、正常、空数据、加载失败、权限不足、连接中断六类状态。空数据不能伪装成零统计；失败不能被吞成空数组。

### 6.2 登录页

- 实例展示名称由 `WEBUI_INSTANCE_NAME` 提供，不向未登录用户泄露内部 URL。
- 管理密钥输入、显示/隐藏、提交中锁定、认证失败提示。
- 明确说明这里需要管理密钥，不是推理 API Key。
- 不提供“自动读取容器配置”“重置上游管理密钥”功能。
- 如果上游 API 不存在或未就绪，显示对应原因，保留手动重试。
- 用户取得凭据的方式由实例部署者决定；WebUI 不挂载原数据目录代取。

### 6.3 总览

- 渠道/账号概况、请求量、成功率、用量、冷却与并发概况，以实际 API 字段为准。
- 默认每 15 秒刷新当前可见页面，页面进入后台暂停或显著降低频率。
- 显示最近成功刷新时间；刷新失败保留上次快照并标注过期。
- 不自己推算不存在的余额、TPS、成本或全部历史累计。
- 别名可能共享同一路由累计，不可重复求和。
- 无真实时间序列 API 时，不为了图表外观伪造趋势线。

### 6.4 API 渠道管理

- 列表、详情、新增、编辑、启停、删除。
- 名称、供应商/协议、地址、认证、模型等字段按真实 schema 生成。
- 配置是否启用、运行时健康/冷却状态分别展示。
- 编辑已有秘密字段时，显示“已设置”；空输入不默认等于清除，遵循上游 update schema。
- 新渠道诊断与已有渠道诊断使用各自正式 API，不能混用副作用不同的动作。
- 支持模型发现/同步和对应 task 进度。
- 删除确认中展示资源名和实际已知影响，不自行模拟级联删除。
- 提交中禁用重复操作，但不得长期锁住整个页面。

### 6.5 OAuth 账号

MVP 默认覆盖账号列表/详情、状态/额度展示、启停/删除，并优先实现 OpenAI、Claude 的真实可用登录或导入路径。若某供应商在部署版本不可用，应标明，不假造通用登录。

已核实的通用接口（均加管理前缀）：

| 方法与路径 | 用途 | 注意 |
| --- | --- | --- |
| `POST /oauth/login-flows` | 发起登录 | 返回 flowId、flowSecret、authUrl、instruction、expiresAt 等 |
| `POST /oauth/login-flows/{flowId}/poll` | 轮询支持该模式的供应商 | body 按 schema 包含 flowSecret；不是普通 GET |
| `POST /oauth/login-flows/{flowId}/complete` | 完成指定供应商流程 | code/state/callbackUrl/completed 等按供应商实际契约填写 |
| `POST /oauth/login-flows/{flowId}/cancel` | 取消 | 成功 204 |
| `POST /oauth/imports/preview` | 导入预览 | 返回 importId、importSecret、candidates、errors、expiresAt |

导入 commit 的准确路径、字段及覆盖确认 token 从 `oauth.py` 和 OpenAPI 核对，不按本文省略信息猜测。

交互要求：

1. 发起、等待授权、需要用户回填、保存成功、超时、取消、失败分别显示。
2. 支持打开上游返回的官方授权链接；外链仅接受 http/https，使用 noopener/noreferrer。
3. 不能假设每家供应商都自动跳回 WebUI；回填模式显示上游指引。
4. 登录成功后的模型同步失败不能被误报为授权失败。
5. 同身份已存在、替换确认、部分导入失败都有明确结果，不能静默覆盖。
6. 离开页面后停止不再需要的浏览器轮询；是否取消原流程由真实接口和用户操作决定。
7. flowSecret/importSecret 只保存在当前流程内存，不进入 URL、持久浏览器存储或日志；刷新丢失时提示重新发起，不能偷偷从其他账号流程复用。
8. 用户主动导入的 token、JSON 文件内容只在上传和上游处理期间使用，不落本地磁盘，不发第三方分析服务。

### 6.6 模型中心

- 按 chat/image/video 类型、查询词、来源、状态筛选；仅提供上游支持的查询条件。
- 模型详情展示各来源及生效状态，不挑一个来源冒充全局状态。
- 使用服务端 `resourceKey`，不自己拼接或解析它。
- 区分 `enabled` 与 `visible`：隐藏只影响发现，不等于不能显式调用。
- 全局状态与来源状态分别操作；批量操作提交明确目标状态，不使用盲目 toggle。
- 明确区分“当前页已选”与“全部筛选结果”。只有接口支持时才提供跨页全选。
- 基础别名新增、修改、删除；高级元数据覆盖放到第二阶段。
- 第一期可限制复杂批量选择范围，但不得显示已支持却只处理当前页的假全选。

已核实示例：

```http
GET /api/management/v1/models?type=chat&page=1&pageSize=50

PATCH /api/management/v1/models/actions/state
If-Match: <从列表meta.revision读取的原值>
Content-Type: application/json

{
  "scope": {"type":"global"},
  "selection": {"mode":"ids","modelIds":["实际存在的模型ID"]},
  "target": {"enabled":false}
}
```

### 6.7 API Key

- 列表、详情、创建、权限/限额配置、启停、吊销。
- 新创建时允许展示和复制实际返回的秘密值；这是用户主动管理的推理 Key，不能与 BFF 管理 Session 的保密规则混淆。
- 默认列表使用掩码。秘密值仅在当前操作视图内存中存在，不记录到日志。
- 重置/替换接口如需要 plan/commit 或确认 token，必须按真实流程实现；可安排第二阶段。
- 不将“未知额度”显示为 0 或无限额度；0、null、未提供的语义由 schema 决定。

### 6.8 日志

- 分页、实际支持的时间/状态/渠道/模型/Key 筛选、详情抽屉。
- 过滤选项尽量使用原 `/logs/filter-options`。
- 默认读取摘要；用户主动打开才加载请求/响应正文。
- 原 raw-body 可能包含敏感字段，不可宣称后端全部自动脱敏。
- 原始内容以纯文本或受控 JSON 树显示，禁止直接渲染 HTML。
- 大正文使用分页/条目查看；达到体积限制时提示，不假称已完整展示。
- 不用自动全量导出替代分页；导出在确有需求和真实接口时再做。

### 6.9 任务中心

- 展示当前浏览器已发起或已获知 ID 的任务，并按需查询。
- 未发现任务列表接口前，不显示“全局所有历史任务”。
- 本地可存非秘密 task ID 和展示元数据，但必须按实例/会话隔离、退出时清理。
- 用户切换页面不重复创建任务。
- 只在 `cancellable=true` 时允许取消；发出取消请求后继续读取真实终态。

### 6.10 第二阶段范围

Telegram 管理登录、其他 OAuth 供应商、高级模型元数据、负载均衡、网络诊断/配置、MCP/搜索配置、多媒体日志与预览、日志留存。

更新/重启类功能默认不开放。本项目不以这些动作作为安装、兼容或正常使用的前提。

不在本项目第一版范围：聊天工作台、多租户注册、商业计费、团队角色管理、持久会话集群、多实例聚合。

## 7. 数据契约与状态处理

### 7.1 类型来源

实施第一步获取并保存可追溯的 OpenAPI 快照，记录来源版本和哈希。TypeScript 类型从快照生成，业务代码不得修改生成文件。

上游 `/openapi.json` 在基线 FastAPI 应用中有默认入口，但实际部署可能被反向代理屏蔽。拿不到时，在隔离的源码基线环境生成契约；不要更改生产应用来开放文档。

不要直接导入并启动原生产实例来生成 schema：其生命周期可能初始化配置、网络、数据库或后台任务。

基础 envelope：

```ts
type DataEnvelope<T> = {
  data: T;
  meta: { requestId: string };
};

type UpstreamErrorEnvelope = {
  error: {
    code: string;
    message: string;
    fields: Array<{ path: string; code: string; message: string }>;
    retryable: boolean;
    requestId: string;
    operationId?: string | null;
  };
};
```

分页、revision、日期、Secret 字段使用各端点生成的类型，不把所有响应都强制转换成一个“大而全”的 envelope。不能猜分页统一是 offset/limit；已核实的模型接口是 page/pageSize，页码从 1 开始。

### 7.2 版本冲突

- 编辑前读取资源对应 revision。
- 写入按端点要求发送 `If-Match`；不是每个接口都能通用套用。
- 409 `REVISION_CONFLICT`：保留用户非秘密编辑内容，展示“已被其他管理端修改”，允许刷新并重新确认。
- 不能静默取得新 revision 然后把旧表单自动提交一次。
- 在秘密字段冲突处理中不把秘密值持久缓存。
- 业务 mutation 成功后刷新相关查询，如账号、渠道、模型、总览，避免全站无差别刷新。

### 7.3 异步 operation

原接口：`GET /operations/{operationId}` 查询，`DELETE /operations/{operationId}` 申请取消。

基线状态枚举：`queued | running | succeeded | failed | cancelled`。

字段包括 `id/kind/status/progress/createdAt/startedAt/finishedAt/result/error/cancellable`。progress 可为 null；没有进度不要制造百分比。

- 原创建接口可能返回 201、202 或自身规定的状态，以 schema 为准。
- 202 只表示已受理；不得立即 toast“操作成功”。
- 轮询建议 1秒→2秒→最多5秒，遵循上游明确的轮询提示和 429/Retry-After。
- 中间失败采用有界退避；终态或会话结束后停止。
- `succeeded` 的 result 仍可能包含逐来源失败，解析领域结果显示“部分成功”；不要自造第六个 operation status。
- 查询变成 404 时提示任务记录不可用/可能已过期或实例重启，随后刷新业务资源；不自动重做任务。
- operation 信息可能因原实例重启消失，不能把 BFF 本地缓存当作可靠任务持久化。

### 7.4 必须区分的错误

| 场景 | UI 行为 |
| --- | --- |
| 会话失效 / 401 | 清本地会话，转登录；不要错误显示为密码输错 |
| 权限不足 / CAPABILITY_DENIED | 保留登录，禁用相应功能并解释 |
| REVISION_CONFLICT | 进入冲突处理，禁止自动覆盖 |
| VALIDATION_FAILED / 422 | 将 fields 映射到表单；保留其他有效输入 |
| RATE_LIMITED / 429 | 显示等待时间，停止高频重试 |
| SERVICE_NOT_READY | 显示管理服务未就绪；不据此自动重启原容器 |
| 原业务 UPSTREAM_ERROR | 呈现供应商业务失败；不要冒充 WebUI 网络断开 |
| BFF 连接/超时错误 | 显示传输问题及 requestId；写结果可能未知 |
| HTTP 503 且 field code 为 SAVED_RELOAD_UNCONFIRMED | 提示“配置已保存，运行时重载未确认”，刷新状态，禁止重放旧操作 |

以完整业务 code/fields 判断语义，不只按 HTTP 503 一概重试。TanStack Query 必须关闭 mutation 自动重试；查询重试仅限短暂传输错误或明确可重试的读取，且有次数上限。

### 7.5 兼容性判断

- 登录后读取 `/meta`、`/capabilities`，结合构建时契约清单决定模块可用性。
- 不假设 `/meta` 一定包含语义化发布版本；缺失时显示未知，并展示实际可获得的 API 信息。
- 不把 237 作为所有版本必须相等的启动条件。
- 缺少非核心功能时局部禁用；缺少认证/核心管理接口时显示不支持。
- UI 隐藏按钮只是体验，实际权限必须由上游再次校验。
- capabilities 返回什么结构就按真实 schema 使用，不自己把它等同于 RBAC 角色矩阵。

## 8. 新 WebUI 的接口与工程结构

### 8.1 本项目自定义接口

| 方法/路径 | 鉴权 | 用途 |
| --- | --- | --- |
| `GET /health/live` | 无 | 进程存活，最小信息 |
| `GET /health/ready` | 无 | 必要配置/静态资源就绪，附最小上游可达状态 |
| `GET /bff/bootstrap` | 预登录 | 公共展示配置、预登录 CSRF，不返回管理秘密 |
| `POST /bff/auth/login` | 预登录 Cookie + CSRF + Origin | 管理密钥换本地会话 |
| `GET /bff/auth/session` | 本地 Cookie | 当前摘要、CSRF、已知会话有效期 |
| `POST /bff/auth/logout` | 本地 Cookie + CSRF + Origin | 本地退出、尝试原 Session 吊销 |
| `GET /bff/diagnostics` | 本地 Cookie | 脱敏连接/契约信息 |
| `/bff/management/*` | 本地 Cookie；写操作加 CSRF/Origin | 允许清单内的管理业务转发 |

上游不可达时应继续提供登录/诊断页面，不反复崩溃启动。健康状态不得泄露原管理密钥或内部拓扑；Docker 存活检查优先使用 live，避免上游暂时故障造成 WebUI 重启循环。

### 8.2 推荐目录

```text
parrot-webui/
  apps/
    web/
      src/
        app/                 路由、布局、Provider
        api/                 BFF client、业务调用封装
        features/
          auth/ overview/ channels/ accounts/
          models/ api-keys/ logs/ tasks/ about/
        components/          通用表格、错误、确认、任务组件
        hooks/
        styles/
      index.html
      vite.config.ts
    bff/
      src/
        server.ts
        config.ts
        auth/                会话、预登录、CSRF、登录限流
        upstream/            固定client、超时、header策略
        routes/              auth、业务proxy、health、diagnostics
        security/            Origin/Host、路由允许清单
        errors/
      test/
  packages/
    contracts/
      upstream.openapi.json
      upstream-meta.json     源提交/快照哈希/生成方式
      generated/             自动生成，禁止手改
      bff.ts                 本项目独有契约
  tests/
    fixtures/                全部为虚构、脱敏数据
    integration/
    e2e/
  scripts/
    generate-contracts.mjs
  docs/
    deployment.md
    compatibility.md
    security-model.md
    acceptance.md
  Dockerfile
  compose.yaml
  .env.example
  .dockerignore
  .gitignore
  package.json
  pnpm-workspace.yaml
  pnpm-lock.yaml
  README.md
```

所有请求集中走一个 BFF client。页面不要散落手写 fetch 和 token 注入。领域组件只关心业务接口，避免把全部页面写进一个 App.tsx。

Mock 必须由测试或显式开发开关启用，生产默认永远调用真实 BFF。无法连接上游时显示错误，不自动退回演示数据。

## 9. 同机、同域名路径部署与网络

### 9.1 正式部署唯一入口

```text
https://原Parrot域名/webui/
```

必须与 Parrot 同一台主机部署，不提供异机安装模式。不得创建新域名、子域名或单独公网IP＋端口访问方式。仅在原有 HTTPS 入口新增 `/webui/` 分流；外部浏览器不直接访问容器3000端口。

该约束通过 Compose/监听地址、网络和入口规则实现，不声称仅靠应用能够可靠证明上游在同一台机器，也不声称 Host 检查能够代替关闭公网端口。

### 9.2 环境变量：新项目约定

| 名称 | 必填/默认 | 含义 |
| --- | --- | --- |
| `PARROT_BASE_URL` | 必填 | 本机原Parrot的既有内部origin，不含管理前缀、不指向 `/webui/` |
| `WEBUI_PUBLIC_ORIGIN` | 必填 | 现有Parrot HTTPS origin，如 `https://parrot.example.com`；不含路径 |
| `WEBUI_BASE_PATH` | `/webui/` | 首版固定值，不支持随意修改；构建产物与运行时必须一致 |
| `WEBUI_INSTANCE_NAME` | `Parrot` | 展示名称 |
| `WEBUI_BIND_HOST` | `0.0.0.0` | 仅容器内部监听；宿主发布必须限回环或完全不发布 |
| `PORT` | `3000` | 容器内部端口 |
| `WEBUI_SESSION_IDLE_SECONDS` | `1800` | 本地空闲有效期 |
| `WEBUI_SESSION_MAX_SECONDS` | `28800` | 本地绝对有效期，另受上游截止时间限制 |
| `PARROT_CONNECT_TIMEOUT_MS` | `5000` | 上游连接超时 |
| `PARROT_REQUEST_TIMEOUT_MS` | `30000` | 普通请求总超时 |
| `WEBUI_TRUST_PROXY` | 必填 | 实际入口代理地址/CIDR，禁止全信任 |
| `LOG_LEVEL` | `info` | 脱敏日志级别 |

启动时严格校验。正式模式拒绝非HTTPS PUBLIC_ORIGIN、错误base path、空代理信任配置。域名必须由安装者确认等于原Parrot域名，不任意生成。

不得设置共享 `PARROT_ADMIN_KEY`；不将服务端环境变量全部打进前端。构建时不写死用户域名，资源base固定 `/webui/`，公开配置由bootstrap返回。

### 9.3 方案A：现有反向代理运行在宿主机

独立Compose只将新WebUI端口发布到宿主机127.0.0.1。以下为待实现模板，不代表镜像已存在：

```yaml
name: parrot-webui
services:
  webui:
    build:
      context: .
    image: parrot-webui:local
    restart: unless-stopped
    init: true
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      NODE_ENV: production
      PORT: "3000"
      WEBUI_BIND_HOST: "0.0.0.0"
      WEBUI_BASE_PATH: "/webui/"
      PARROT_BASE_URL: "${PARROT_BASE_URL:?set local Parrot origin}"
      WEBUI_PUBLIC_ORIGIN: "${WEBUI_PUBLIC_ORIGIN:?set existing Parrot HTTPS origin}"
      WEBUI_TRUST_PROXY: "${WEBUI_TRUST_PROXY:?set actual ingress proxy addresses}"
      WEBUI_INSTANCE_NAME: "${WEBUI_INSTANCE_NAME:-Parrot}"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    read_only: true
    tmpfs:
      - /tmp:size=32m,mode=1777
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/webui/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      start_period: 15s
      retries: 3
```

`.env.example`（代理地址需现场确认，不能照抄占位值）：

```dotenv
PARROT_BASE_URL=http://host.docker.internal:22122
WEBUI_PUBLIC_ORIGIN=https://parrot.example.com
WEBUI_INSTANCE_NAME=My Parrot
WEBUI_TRUST_PROXY=REPLACE_WITH_ACTUAL_PROXY_IP_OR_CIDR
```

启动后，3000只是同机反向代理的内部目标，不是提供给用户的访问网址。禁止将 ports 改成 `3000:3000`、`0.0.0.0:3000:3000` 或 `[::]:3000:3000`。

### 9.4 现有Nginx路径规则示例

在原Parrot域名已有的HTTPS server块中增加以下location，不替换整个server块，不改原 `/`、`/v1`、管理API和MCP规则。示例域名必须换为用户已有域名：

```nginx
location = /webui {
    if ($host != parrot.example.com) { return 404; }
    return 308 /webui/;
}

# 容器健康检查不对公网开放。
location = /webui/health { return 404; }
location ^~ /webui/health/ { return 404; }

location ^~ /webui/ {
    if ($host != parrot.example.com) { return 404; }
    # 不在proxy_pass后加URI尾斜杠：保留/webui/前缀。
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host parrot.example.com;
    proxy_set_header X-Forwarded-Host parrot.example.com;
    proxy_set_header X-Forwarded-Proto https;
    # 单层公网入口示例：覆盖客户端伪造值，不直接信任其XFF。
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Connection "";
    proxy_connect_timeout 5s;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
    client_max_body_size 5m;
    proxy_cache off;
    # 防止OAuth回填URL/查询秘密写入默认URI访问日志。
    access_log off;
}
```

重要说明：

- 这是添加到已有域名server的片段，不是开一个新listen端口或新server_name。
- 保留原全局/默认站点策略。对本项目 `/webui/` 路径，必须拒绝不属于现有域名的Host；当原域名server恰好为default_server时也要验证，不能让IP:443路径落入本项目。具体按现有入口软件配置，不能为此破坏原API的IP访问策略。
- 若前面还有CDN/代理，先在现有入口配置准确可信real-IP来源，再传递已验证客户端IP；禁止直接信任用户传入的XFF。
- BFF不能只信任客户端自带的转发头；其可信来源必须与实际入口网络一致。
- OAuth原始回填链接不自动变成WebUI callback；仍按原供应商API流程处理，不能擅自更改上游redirect_uri。
- Nginx只能在现有入口部署中校验配置通过后平滑reload；检查原推理流式接口和已有路径没有回归。
- 使用Caddy/Traefik时交付对应的保留前缀规则；不要同时应用剥前缀与保留前缀两种方式。
- 若用户没有可修改的现有路径入口，或TLS入口仅在不可修改的原容器内，报告阻塞。不能以另开公网端口作为后备方案。

### 9.5 方案B：现有反向代理也是容器

新WebUI加入入口代理已在使用的内部Docker网络，**完整删除方案A的ports字段**。入口代理通过WebUI服务名访问容器3000，Nginx示例仅将proxy_pass目标改为 `http://webui:3000`，仍不加尾斜杠。

```yaml
# 独立Compose中的附加配置；使用本方案时必须删掉原ports字段。
services:
  webui:
    expose:
      - "3000"
    networks:
      - existing-ingress
networks:
  existing-ingress:
    external: true
    name: "实际已存在的入口Docker网络名"
```

`expose`不发布宿主端口，也不是防火墙；网络上其他容器的信任边界需记录。不要用Compose override简单省略ports并误以为原ports已被删除，必须检查合并后的 `docker compose config`。

本项目只新增WebUI容器的网络附件；不修改原Parrot容器网络。若BFF到原Parrot需另一已有网络，可给WebUI加入该网络，仍不改变原容器。确认服务别名不冲突。

### 9.6 BFF到本机Parrot的连接

- 优先利用原Parrot已有用户自定义网络和服务别名，或可从宿主网关访问的已发布端口。
- 容器localhost指WebUI自身；不能用它默认访问宿主或原Parrot。
- Linux host-gateway不保证可访问宿主只绑定127.0.0.1的端口，必须实测。
- 若只能通过宿主loopback访问，可作为现场特定方案仅给新WebUI采用Linux host network，同时将BFF bind设为127.0.0.1并删除ports；不得绑定0.0.0.0。这不是跨平台默认模板。
- 不增加异机目标、不通过另一台服务器中转。不能仅凭“域名可访问”就声称符合物理同机要求；部署记录应证明位置。
- 不修改原端口绑定、网络或证书来迁就WebUI；没有既有可达路径则报告前提不满足。

### 9.7 Cookie、静态资源与路径验收

- Vite base、路由basename、fetch base、跳转地址、Cookie Path统一为 `/webui/`。
- 重定向 `/webui` 到 `/webui/`，所有深链接刷新正确；不能跳到域名根 `/login`。
- 健康检查仅内部访问；BFF与静态资源不能泄漏成根路径 `/bff`、`/assets` 的另一套入口。
- 不给Cookie添加Domain；不将Path改为 `/` 解决登录问题。TLS由现有入口终止不影响BFF设置Secure Cookie。
- CSP使用同源脚本、`frame-ancestors 'none'`、nosniff、no-referrer；兼容Ant Design样式时不能放宽script-src。
- 同域路径并不构成安全隔离；现有域名不能托管不可信可执行HTML，否则必须先解决同源XSS风险。

### 9.8 Dockerfile与运维

1. 锁定Node24和pnpm；使用frozen lockfile，多阶段构建WebUI与BFF。
2. runtime仅含生产依赖、静态产物、BFF；非root、只读根目录、无Docker socket、无原数据volume。
3. 支持SIGTERM，不在启动时安装依赖或生成必须写入源码目录的文件。
4. 提供独立镜像版本，升级/回滚只影响WebUI。
5. 安装步骤：核实同机和域名→构建独立容器→验证内部可达→新增路径规则→配置测试→平滑reload→域名路径验收及公网端口拒绝验证。
6. 卸载：移除新增的 `/webui/` 路由并校验reload，再停止独立WebUI；不删除原Parrot配置和数据。
7. 不以开放3000、公网IP直连、独立域名作为排障后备手段。

## 10. 开发顺序与可验收里程碑

### M0：确认接口契约

产物：`upstream.openapi.json`、生成类型、来源记录、最小路由允许清单、兼容性表。

动作：核对上游登录/注销、meta、overview、渠道列表与一个写操作、operation 以及模型 revision。开发和测试使用隔离实例或 fake server，不连接生产写接口。

完成标准：字段来自真实 schema；能够明确指出每个待开发页面对应的上游 operationId；所有未确认部分列为待验证，不编造接口。

### M1：BFF、登录和部署骨架

产物：会话、Origin/CSRF、受控代理、健康检查、静态托管、Docker 骨架。

完成标准：能登录并读取真实总览；刷新保持本地会话；注销后不能访问；未登录与错误来源不能调用管理资源；浏览器见不到 Parrot credential；原容器未修改。

### M2：总览与渠道完整闭环

产物：导航、状态页面、渠道增删改查、诊断/模型发现及 task 组件。

完成标准：从创建渠道到查看同步结果可操作；失败/冲突/加载状态完整。不能只交付表格截图和 mock。

### M3：账号、模型、API Key、日志

产物：第6章定义的 MVP 页面，常用 OAuth 路径，任务中心。

完成标准：新增常用账号、模型配置、创建测试 Key、从外部测试客户端调用原实例、在网页查看对应日志。推理测试由独立测试客户端执行，不给 BFF 增加推理代理。

### M4：异常与打包验收

产物：E2E 测试、Docker 运行验证、HTTPS说明、兼容性报告和未完成清单。

完成标准：第11章必需用例通过；所有未测真实供应商标明；停止 WebUI 后原实例仍正常。

### 可并行拆分

- 开发者/模型 A：BFF、认证、网络与容器。
- 开发者/模型 B：前端布局、总览、渠道、任务。
- 开发者/模型 C：OAuth、模型、API Key、日志。
- 测试者：独立检查接口契约、异常与不改动原容器约束。

并行前必须冻结 BFF 会话契约、错误格式、生成类型和路由清单。不让多个模型分别发明登录机制或修改同一个生成文件。

工作量仅作为规划：单名熟悉 React/Python/Node 的开发者，限定两家 OAuth 的可用 MVP 约 10–15 个工作日；覆盖更多领域约 4–6 周。真实账号可用性、网络与供应商兼容会影响估算。

## 11. 测试与验收清单

### 11.1 BFF 必需测试

- [ ] 未登录业务请求返回 401，不能触达上游业务写接口。
- [ ] 错误 Origin、缺 Origin、Origin:null、缺/错误 CSRF 的写请求被拒绝。
- [ ] 登录也受 CSRF/来源与限流保护；不能仅保护登录后的写接口。
- [ ] 正确登录：原 credential 只存在 BFF 内存，不出现在浏览器响应、Cookie 或日志中。
- [ ] 会话 ID 登录后轮换；过期、注销、BFF 重启均正确拒绝旧 Cookie。
- [ ] 同时登录两个浏览器，各自使用独立上游凭据；注销不串会话。
- [ ] 上游请求没有浏览器 Cookie/Origin/Authorization；Bearer 由 BFF 设置。
- [ ] 路径穿越、编码绕过、任意目标 URL、未知 method/route、原 auth 通用代理均被拒绝。
- [ ] 上游 302 不被带凭据跟随到其他主机。
- [ ] 204、401、403、409、422、429、503、非JSON错误、超时、超大响应都正确处理。
- [ ] If-Match、合法 Idempotency-Key、requestId、Retry-After 不丢失。
- [ ] 上游写超时不会被 BFF 自动重复发送。
- [ ] 会话/预登录容量和过期清理有界，不随匿名访问无限增长。
- [ ] bootstrap限流、5分钟TTL和满容量拒绝正确；匿名新请求不会驱逐尚有效的登录流程。
- [ ] 预登录Cookie与正式Cookie均有Secure/HttpOnly/SameSite及Path=/webui/；吊销清理相同Path。
- [ ] 可信代理正确提取来源；伪造XFF无效，不把全部用户误识别成同一个BFF限流来源。

### 11.2 前端与浏览器必需测试

- [ ] 登录→总览→渠道→任务→模型→Key→日志→注销可走通。
- [ ] 深链接刷新如 `/channels`、`/logs` 返回 SPA，未知 BFF 路径仍返回 API 404。
- [ ] 列表分页、筛选、空数据、失败、权限不足状态可区分。
- [ ] 409 不自动覆盖；保留非秘密草稿并提供重新读取。
- [ ] 202 不报完成；轮询遇到终态停止；部分失败结果正确展示。
- [ ] SAVED_RELOAD_UNCONFIRMED 显示“已保存但未确认重载”，不自动重放。
- [ ] 注销/失效清理所有查询缓存、秘密视图和任务关联；多标签页状态合理。
- [ ] 任意日志字符串如 `<script>` 只作为文本展示。
- [ ] 页面刷新不把管理主密钥从浏览器存储恢复出来。
- [ ] 关键操作支持键盘和可辨识标签，移动端不出现无法提交的遮挡。
- [ ] OAuth 的过期、取消、重复身份、导入部分失败有对应测试。
- [ ] 后台标签页停止高频轮询，不反复创建同一任务。

### 11.3 独立容器集成验收

- [ ] 新 WebUI Compose 可独立启动，不将原 Parrot 定义为本项目需要重建的 service。
- [ ] Docker 只读根文件系统、非 root、无 Docker socket、无原数据 volume 下运行成功。
- [ ] 真实管理 API 可读写测试资源；所有写测试只针对隔离实例或明确专用资源。
- [ ] 网页修改在 Telegram 中可见；TG 修改后网页刷新可见。
- [ ] 未修改原镜像、原部署文件、原启动参数与原网络附件。
- [ ] 原实例重启或短暂不可达时，WebUI 清晰提示，不假造成功、不触发自动修复。
- [ ] WebUI 重启后可重新登录；停止/卸载 WebUI 不影响原推理和 TG 服务。
- [ ] 上游缺少管理 API 时显示不兼容，并且没有修改原容器。

- [ ] 安装记录确认WebUI和Parrot在同一主机；没有异机部署目标。
- [ ] 只能通过 `https://原Parrot域名/webui/` 访问，未新增域名/子域名入口。
- [ ] 从另一台公网机器测试宿主公网IPv4/IPv6的3000或实际内部端口，连接失败；不能只在本机测试或仅测试认证拒绝。
- [ ] `docker compose config`和实际Docker端口/监听状态确认仅127.0.0.1发布，或完全不发布；无0.0.0.0/[::]发布。
- [ ] `/webui`尾斜杠、`/webui/channels`深链接、静态资源、BFF请求与Cookie全部正确；没有域名根下的替代入口。
- [ ] IP:443或错误Host访问不能取得本项目页面/API；原Parrot既有路径策略保持。
- [ ] 路径规则校验和平滑reload后，原推理流式连接、管理API、MCP等已有入口不回归。

测试应分三层报告：fake server 契约测试、隔离真实 Parrot 集成测试、真实供应商 OAuth 测试。第一层通过不等于后两层通过。

### 11.4 推荐命令约定

在 package.json 中实现以下脚本，不要求接手者猜运行方式：

```bash
pnpm install --frozen-lockfile
pnpm contracts:generate
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
pnpm build
docker compose config
docker compose up -d --build
```

纯代码开发可使用仅绑定127.0.0.1的Vite5173，将 `/webui/bff` 代理到本地BFF，保留路径/Origin并使用专用开发Cookie。此项仅用于开发测试，正式交付必须按第9章通过原域名路径，不允许把5173或3000发布公网。

无 Docker 或无真实测试账号时，完成可运行代码和可执行测试，明确报告尚未验证的项目。不得把“无法验证”改写成“已通过”。

## 12. 最终交付物

1. 完整 `parrot-webui` 独立工程和锁文件。
2. 可构建的 Dockerfile、独立 compose.yaml、无秘密的 .env.example。
3. 可追溯的上游 OpenAPI 快照、生成工具、类型和兼容性记录。
4. 实际可操作的 MVP 页面和受控 BFF。
5. 自动化测试、执行结果、真实联调记录。
6. 中文 README：启动、登录、网络连接、HTTPS、升级、回滚、卸载。
7. 现有反向代理的最小增量路径配置、配置校验/平滑reload与回滚说明，以及公网直连端口关闭的验证记录。
8. 安全模型说明：凭据在哪里、Origin/CSRF怎样处理、重启后会话行为。
9. 已完成/未完成/未验证三份明确列表，不用模糊的“基本完成”。

未允许对外发布镜像时，交付本地可构建镜像及发布步骤，不擅自使用用户账号推送。

## 13. 源码阅读索引

以下路径相对原 Parrot 仓库。固定提交链接根：

<https://github.com/danger-dream/Parrot/tree/9b73d058635470d59eef7a10876e6532649435d9>

| 文件 | 为什么读 |
| --- | --- |
| `server.py`，约666行和956行 | 生产路由挂载、Origin 中间件顺序 |
| `src/management_api/router.py` | 管理前缀和领域路由集合 |
| `src/management_api/routers/foundation.py` | 登录、Session、Telegram批准、meta/capabilities、operation |
| `src/management_api/schemas/auth.py` | 真实登录请求/响应字段 |
| `src/management_api/schemas/base.py` | 严格schema、基本响应与错误结构 |
| `src/management_api/dependencies.py` | Bearer、权限、requestId、Idempotency-Key |
| `src/management_api/origin.py` | Origin白名单、预检和响应头 |
| `src/management_api/error_mapping.py` | 业务错误码与HTTP映射 |
| `src/config.py`，约480行 | 原管理默认配置与限制 |
| `src/management_api/routers/channels.py` | 渠道操作与revision、诊断动作 |
| `src/management_api/routers/oauth.py` | OAuth flow、导入与覆盖确认 |
| `src/management_api/routers/apikey.py` | Key管理、secret、plan流程 |
| `src/management_api/routers/models.py` | 模型来源与状态操作 |
| `src/management_api/routers/logs.py` | 日志、正文、分页及筛选 |
| `src/management_api/routers/stats.py` | 可用统计口径与查询参数 |
| `src/management_api/schemas/operations.py` | operation返回字段 |
| `src/management_control/operations.py` | operation状态枚举 |
| `docs/13-management-control-api-refactor.md` | 共享控制层目标、接口设计历史 |
| `docs/14-model-center.md` | 后续模型中心语义，revision、部分成功、重载未确认 |
| `src/tests/test_management_server_composition.py` | 生产管理路由组合契约 |
| `src/tests/test_webui_integration_wiring.py` | WebUI相关后端接线、原始日志等测试 |
| `src/tests/test_webui_oauth_import.py` | OAuth真实本地导入链回归 |

当历史设计文档与当前代码有差异时，以选定提交的真实 schema/实现和测试为准，记录差异；不要为了遵守旧文档而修改原项目。

## 14. 可直接交给编程模型的任务提示词

将本节与整个文档一起交给接手模型：

```text
请实现本文定义的独立项目 parrot-webui，交付能运行的代码和Docker部署，不要只输出建议或静态演示页。

硬约束：
1. 不修改原Parrot容器、镜像、代码、Compose、配置、端口或网络附件。
2. 不挂载原数据目录或Docker socket；不直接读写原JSON/SQLite。
3. 只通过既有 /api/management/v1 管理API工作。
4. React+TypeScript+Vite+Ant Design前端，Node/Fastify BFF，独立镜像。
5. 管理主密钥仅用于登录换票，原管理Session只保存在BFF内存；浏览器用HttpOnly Cookie。
6. BFF必须有Origin/CSRF、固定目标、method/path白名单、限流及脱敏日志；不是任意转发代理。
7. 不能伪造上游接口、数据或测试成功；无法接入时显示真实错误。
8. 必须安装在Parrot同一台机器，公开入口仅限原HTTPS域名的/webui/；禁止独立域名、子域名、异机安装和独立公网IP+端口。
9. 允许仅为新增/webui/调整现有入口反向代理，不修改原Parrot容器。保留路径前缀，端口仅回环或不发布；Cookie Path、前端base和BFF路径统一。

先做：
- 阅读文档和选定Parrot基线的schema，建立可追溯契约。
- 创建独立工程；按M0至M4顺序实现。
- 每个模块连通后再扩大功能，优先完成登录→渠道→模型→Key→日志闭环。
- 按需使用隔离实例和虚构测试数据，不对生产实例做写入测试。
- 缺少真实账号时完成可测代码，明确标记真实OAuth尚未验证。

页面：登录、总览、渠道、OAuth账号、模型、API Key、日志、任务、版本/诊断。
必须处理：401/403/409/422/429、202异步任务、部分成功、保存但重载未确认、上游断开、会话过期。
没有现成任务列表接口时不要假造“全部历史任务”。不要把unknown或null显示为确定的零值。

完成后提供：
- 工程和部署文件位置、启动命令；
- 真实已实现功能；
- 自动化测试与真实联调分别执行了什么；
- 未完成和未验证项；
- 证明没有改动原Parrot部署的检查记录。
- 同机、同域名路径、无独立公网端口的实测记录；反向代理只新增规定路径。

不要为了减少工作量把BFF改成存储管理密钥的浏览器直连，也不要为了绕过不兼容而改原容器。
```

## 15. 本文验证边界与待确认事项

已经完成：源码层面的管理API/鉴权/Origin/任务/模型契约核查，以及独立容器方案设计。

尚待实施者确认：

1. 用户实际 Parrot 版本、管理 API 就绪情况和网络拓扑。
2. 目标版本每个页面的准确字段、分页/排序/批量操作支持。
3. OpenAI、Claude等真实账号授权方式与运行环境兼容性。
4. Docker Desktop/Linux、HTTPS反代和真实浏览器Cookie行为。
5. 构建、测试、容器运行、性能和安全边界的实际结果。

本文没有创建WebUI代码、没有启动Parrot服务、没有读取用户凭据、没有修改原容器。文中的命令和Compose是实施模板，需由接手模型按真实工程完成并验证。
