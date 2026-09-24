# 兼容性说明

本文件说明：**怎么判断当前 Parrot 实例与本 WebUI 是否兼容**、缺少管理 API 时会看到什么、
以及哪些能力本版**明确没有实现**（避免被误认为"坏掉了"）。

本文件中所有路径与字段都可在仓库内核对；没有实际执行过的判断结论一律标注「待现场确认」。

## 1. 兼容性判断方法（三层，从强到弱）

### 1.1 构建时冻结的契约（最强）

- 本 WebUI 只针对一个固定的上游版本构建：仓库 `https://github.com/danger-dream/Parrot`，
  提交 `9b73d058635470d59eef7a10876e6532649435d9`（`v0.33.1`），
  OpenAPI `3.1.0`，237 个管理操作；BFF 只代理其中冻结的 76 条路由。
- 依据文件：`packages/contracts/upstream-meta.json`、`packages/contracts/mvp-routes.json`、
  `packages/contracts/generated/*`。生成与校验见 [contracts.md](./contracts.md)。
- 含义：上游版本如果差异较大（路由重命名、字段改名、删除），即使页面能打开，也可能出现
  局部功能报错。这时必须按 `docs/contracts.md` 重做基线，而不是改快照或改允许清单硬凑。

### 1.2 登录后读上游自述（最可靠的在运行期判断）

- `GET /webui/bff/management/meta`（映射上游 `GET /api/management/v1/meta`）：上游版本/元信息。
- `GET /webui/bff/management/capabilities`（映射上游 `GET /api/management/v1/capabilities`）：能力矩阵。
- 前端把 capabilities 放进登录后的会话摘要里（`AuthProvider`），用于决定部分模块是否可用
  （例如日志页按 capabilities 判断可用性）；前端对未知 capabilities 结构采取保守策略，不会因为
  能力字符串没匹配上就假装功能可用。
- 这两个接口都在允许清单里，因此**没有代理循环或绕过白名单**的风险。

### 1.3 BFF 自述诊断（排障用）

- `GET /webui/bff/diagnostics`（需要已登录）返回：
  `webui`（版本、Node 版本、basePath、publicOrigin、cookieSecure）、
  `upstream`（`reachable`、`managementApiDetected`、`status`、`errorCode`、`latencyMs`，原始地址默认不外显）、
  `contract`（冻结契约摘要）、`allowlist`（代理路由数、auth 路由数）、`session` 与 `sessions`（有界容量）。
- `GET /webui/health/ready` 也给出最小上游状态（`upstream.reachable`、`upstream.managementApiDetected`），
  不含任何凭据或内部地址，且不对公网转发。

> 未完成/待确认：前端的「版本与诊断」页面目前只是占位组件
> （`apps/web/src/features/about/AboutPage.tsx` 只渲染"尚未实现"），
> 所以上面 1.2/1.3 的信息现在需要直接用 curl（配合已登录 Cookie）或浏览器网络面板查看。
> 页面上线后应能直接展示。是否要为本版补齐该页面由主流程决定。

## 2. 缺少管理 API 时的表现

- **上游不可达**：`/webui/health/live` 仍然 200（进程存活，容器不会因此重启循环）；
  `/webui/health/ready` 返回 503 / `not-ready`，并给出 `upstream.reachable=false`。
  登录页提示连接失败（例如 `WEBUI_UPSTREAM_UNREACHABLE`），并给出上游侧错误码；**不会**退回演示数据，
  也不会显示"成功"。
- **上游存在但没有管理 API**：`managementApiDetected=false`；登录会失败在换票这一步，
  页面提示这是传输/兼容问题而不是密码错误（错误码区分 `WEBUI_*` 与上游业务错误）。
- **上游版本过新/过旧导致个别接口不存在**：BFF 不会把它伪装成 200；未在白名单中的路径会被 404
  `WEBUI_ROUTE_NOT_ALLOWED`，白名单内但上游 404/422 的路径按上游错误原样呈现，并保留 requestId。
- **任何情况下都不修改原 Parrot 容器、镜像、配置或数据**；也不会自动"修复"或重试写操作。
  写操作超时后只提示刷新确认结果，不自动重发。

错误码一览（区分"上游业务错误"与"WebUI 到上游的传输错误"）：

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `WEBUI_UPSTREAM_UNREACHABLE` | 502 | BFF 连不上 `PARROT_BASE_URL` |
| `WEBUI_UPSTREAM_TIMEOUT` | 504 | 超过 `PARROT_REQUEST_TIMEOUT_MS` |
| `WEBUI_UPSTREAM_UNEXPECTED_CONTENT` | 502 | 上游返回非预期的内容类型/JSON |
| `WEBUI_UPSTREAM_REDIRECT_BLOCKED` | 502 | 上游要求重定向（BFF 不跟随重定向，避免泄露 Authorization） |
| `WEBUI_RESPONSE_TOO_LARGE` | 502 | 超过 `WEBUI_MAX_UPSTREAM_RESPONSE_BYTES`（默认 10MiB） |
| `WEBUI_SESSION_REQUIRED` / `WEBUI_SESSION_EXPIRED` | 401 | 需要重新登录 |
| `WEBUI_CSRF_REJECTED` / `WEBUI_ORIGIN_REJECTED` | 403 | CSRF/Origin 校验失败 |
| `WEBUI_HOST_REJECTED` | 421 | Host 与部署域名不一致 |
| `WEBUI_ROUTE_NOT_ALLOWED` | 404 | 不在冻结白名单内 |
| `WEBUI_RATE_LIMITED` / `WEBUI_CAPACITY_EXCEEDED` | 429 | 触发限流或容量上限 |
| `WEBUI_NOT_READY` | 503 | 尚未就绪（静态资源缺失等） |

## 3. 本版明确未实现的范围（第二阶段）

以下能力**不在**第一版范围内，未实现就是未实现，不要用假按钮、假数据或"暂时返回空列表"来伪装：

- **Telegram 批准登录**（登录管理台的 Telegram 审批流程）。注意这与"给 Parrot 添加供应商 OAuth 账号"不是一回事。
  第一版只交付管理密钥登录；未实现的登录方式不显示可点击的假按钮。
- **其他 OAuth 供应商**（新增/适配除已支持供应商以外的授权流程）。
- **高级模型元数据**（更完整的模型属性/来源语义；模型中心第二阶段的 revision、部分成功、重载未确认等语义）。
- **负载均衡**相关配置与可视化。
- **网络诊断 / 网络配置**（`network/*`）。
- **MCP / 搜索配置**（`mcp/*`）。
- **多媒体日志与预览**（图片/音频等正文的可视化）；第一版日志只覆盖已列入白名单的文本类接口，
  且默认不加载日志正文，需要用户主动展开。
- **日志留存（retention）策略**（`retention/*`）。
- **更新 / 重启类操作**（`updates/*`、`system/*`）：默认不开放，本项目也不以这些动作作为安装、
  兼容或正常使用的前提。

以上部分对应 `packages/contracts/mvp-routes.json` 的 `excluded.phase2` 列表与
`reason` 字段，可逐条核对。

此外，以下内容同样不在第一版范围：聊天工作台、多租户注册、商业计费、团队角色管理、
持久会话集群、多实例聚合。

## 4. 上游升级 / 降级时的处理流程

1. 记录当前上游版本与 `GET /webui/bff/management/meta`、`/capabilities` 的实际返回（留档）。
2. 按 [contracts.md](./contracts.md) 重做快照基线并跑 `pnpm contracts:generate` + `pnpm typecheck` + `pnpm test`。
3. 若出现路由/字段差异：优先调整本项目的类型与页面；**不要**为了兼容而修改原 Parrot 容器或配置。
4. 升级 WebUI 镜像后按 [deployment.md](./deployment.md) 第 5 节重新验收。
5. 若上游缺少本项目依赖的管理 API：报告不兼容并给出证据（`/meta`、`/capabilities`、诊断接口输出、
   脱敏日志中的 requestId），不要用改快照或伪造数据的方式"通过"。
