# Parrot WebUI（独立容器）

本仓库是 Parrot 的**独立 WebUI**：一个 React 单页应用 + 一个 Fastify BFF，打包成独立容器，
通过原 Parrot **既有的** `POST /api/management/v1/auth/sessions` 等管理 API 读写本机 Parrot 实例。
它不是 Parrot 的 Fork，也不修改原 Parrot 的容器、镜像、代码、Compose、端口或网络。

## 项目定位与硬约束

- **一个镜像、一个进程**：前端静态资源与 BFF 在同一个容器里，容器内监听 `3000`。
- **正式入口只有一个**：`https://<原Parrot域名>/webui/`。
  不新建域名/子域名，不使用独立公网 IP + 端口；3000 只作为同机反向代理的内部目标
  （Compose 默认只发布到 `127.0.0.1`）。
- **必须与原 Parrot 同机部署**。异机安装、通过第二台服务器中转为**不支持**的用法。
- **固定前缀 `/webui/`**：前端 base、BFF 路径、Cookie Path 三者必须一致，首版不支持改成别的值。
- **不修改原实例**：不挂载原数据目录、不挂 Docker socket、不直接读写原 JSON/SQLite；
  只通过既有管理 API 工作。
- **凭据不下浏览器**：Parrot 管理主密钥只在登录请求里出现（仅用于换票），
  上游 Session 只存在 BFF 内存，浏览器只有 HttpOnly Cookie。详见 [docs/security-model.md](docs/security-model.md)。
- **BFF 不是任意转发代理**：固定上游目标 + 构建时冻结的 method/path 允许清单（当前 76 条）
  + Origin/CSRF/Host 校验 + 限流 + 脱敏日志。不代理 `/v1/*` 推理入口。
- **不伪造**：无法连接上游时显示真实错误，不退回演示数据；无法验证的事项必须标为"未验证"。

## 目录结构

```text
apps/
  web/          React + TypeScript + Vite + Ant Design 前端（src/features/* 为各业务域页面）
  bff/          Fastify BFF（src/config.ts 配置校验、security/ 校验与限流、upstream/ 上游客户端、routes/ 路由）
packages/
  contracts/    上游 OpenAPI 快照 + upstream-meta.json + mvp-routes.json + generated/（自动生成，勿手改）
scripts/
  generate-contracts.mjs   契约校验与类型生成（只读仓库内文件，从不连接 Parrot）
tests/
  e2e/          端到端/集成测试（@parrot-webui/e2e，vitest；含 management-flow.test.ts）
deploy/
  nginx-webui.conf         现有 Nginx server 块的增量片段（保留 /webui/ 前缀）
  Caddyfile.example        等价的 Caddy 片段
docs/
  deployment.md            部署、反向代理、验收、升级、回滚、卸载
  security-model.md        凭据在哪、Origin/CSRF、限流、日志脱敏、重启后会话行为
  compatibility.md         兼容性判断方法、缺少管理 API 的表现、第二阶段范围
  contracts.md             上游快照的生成/校验、允许清单冻结与扩展
  frontend-contract.md     前端实现契约（页面开发者必读）
  acceptance.md            验收记录（由主流程在验收后填写）
Dockerfile                 多阶段构建（Node 24 + pnpm，非 root，只含生产依赖与产物）
compose.yaml               独立 Compose 项目 parrot-webui（默认只发布 127.0.0.1:3000）
.env.example               环境变量模板（无任何真实秘密）
```

## 本机开发

前置：Node 24、pnpm（`packageManager` 已锁定 `pnpm@12.5.1`）。

```bash
pnpm install             # 安装依赖（CI/交付请用 pnpm install --frozen-lockfile）
pnpm contracts:generate  # 校验上游快照 + 生成冻结路由表与类型
pnpm dev                 # 并行启动 BFF(3000) 与 Vite(5173)，Vite 把 /webui/bff 与 /webui/health 代理到 BFF
pnpm typecheck           # 全仓类型检查
pnpm lint                # 静态检查（当前为占位实现）
pnpm test                # 单元/契约测试（vitest）
pnpm test:e2e            # 端到端/集成测试（@parrot-webui/e2e，vitest）
pnpm build               # 构建 contracts → web(apps/web/dist) → bff(apps/bff/dist)
```

开发模式注意事项：

- 开发用 `NODE_ENV=development`：默认 `WEBUI_PUBLIC_ORIGIN=http://127.0.0.1:5173`，
  可信代理默认为 `127.0.0.1,::1`，并使用非 Secure 的开发 Cookie（`WEBUI_DEV_INSECURE_COOKIES`）。
- `PARROT_BASE_URL` 在**任何**环境都是必填项（BFF 启动时严格校验），例如 `http://127.0.0.1:22122`。
- Vite 只绑定 `127.0.0.1:5173`。**不要把 5173 或 3000 发布到公网**；正式交付必须走原域名的 `/webui/`。
- Mock 只能由测试或显式开发开关启用；默认永远调用真实 BFF。

## 容器构建与运行

```bash
cp .env.example .env      # 填写 PARROT_BASE_URL / WEBUI_PUBLIC_ORIGIN / WEBUI_TRUST_PROXY 等
docker compose config     # 检查合并后的配置：确认 ports 只有 127.0.0.1、没有 0.0.0.0/[::]
docker compose up -d --build
docker compose ps
docker compose logs -f webui
```

镜像细节：多阶段构建；构建阶段用 `--frozen-lockfile` 安装依赖、执行 `pnpm contracts:generate --check`
（校验快照哈希与 76 条允许清单）、构建 web 与 bff；运行阶段只含生产依赖 + 静态产物（`apps/web/dist`）
+ BFF 产物（`apps/bff/dist`），以非 root 用户 `node` 运行，只读根文件系统 + `tmpfs /tmp`，
`cap_drop: ALL` + `no-new-privileges`，健康检查用 `/webui/health/live`，支持 SIGTERM 优雅退出。
不安装 Docker socket、不挂载原 Parrot 数据目录。

## 登录说明

- 打开 `https://<原Parrot域名>/webui/` 后，登录需要填写 **Parrot 管理主密钥**，
  **不是**推理用的 API Key（`sk-...`）。用错凭据只会得到上游的认证错误。
- 管理密钥只在这一次登录请求里出现：BFF 用它向本机 Parrot 换取上游 Session，票留在 BFF 内存，
  浏览器只拿到 HttpOnly Cookie。**不要**把管理密钥写进 `.env` 或 Compose。
- 退出登录会清除本地会话并尝试吊销上游 Session；容器重启后需要重新登录。
  这些行为与边界详见 [docs/security-model.md](docs/security-model.md) 第 7 节。
- 未实现第二阶段的 Telegram 批准登录等其它登录方式，界面上不会出现可点击的假按钮。

## 部署入口（唯一允许的访问方式）

```text
https://<原Parrot域名>/webui/
```

- 只在原域名现有的 HTTPS 反向代理中**新增** `/webui/` 分流，不改原有 `/`、`/v1`、
  `/api/management/v1`、`/mcp` 规则；反向代理必须保留 `/webui/` 前缀。
- 现成片段：[deploy/nginx-webui.conf](deploy/nginx-webui.conf)（Nginx）、
  [deploy/Caddyfile.example](deploy/Caddyfile.example)（Caddy）。
- 入口代理本身也是容器时，改用内部网络 + `expose`，并按 [compose.yaml](compose.yaml) 顶部注释
  **删除 `ports`**，用 `docker compose config` 复核。
- `/webui/health/*` 不对外开放（反向代理片段直接 404）。
- 完整步骤、验收清单（含"从另一台公网机器访问宿主 3000 应失败"的验证）、升级/回滚/卸载：
  见 [docs/deployment.md](docs/deployment.md)。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/deployment.md](docs/deployment.md) | 前提、构建、配置、反向代理、验收、升级、回滚、卸载、待现场确认项 |
| [docs/security-model.md](docs/security-model.md) | 凭据位置、Origin/CSRF/Host、限流、脱敏日志、重启与登出后的会话行为 |
| [docs/compatibility.md](docs/compatibility.md) | 兼容性判断（`/meta`、`/capabilities`、诊断接口）、缺少管理 API 的表现、第二阶段范围 |
| [docs/contracts.md](docs/contracts.md) | 上游快照生成/校验、基线提交与哈希、允许清单冻结与扩展、禁止改快照 |
| [docs/frontend-contract.md](docs/frontend-contract.md) | 前端与 BFF 的共享接口约定（页面开发者必读） |
| [docs/acceptance.md](docs/acceptance.md) | 验收记录：已完成 / 未完成 / 未验证、每条命令的真实输出、验证中发现并修复的缺陷 |
| [docs/acceptance-vmrack-20260922.md](docs/acceptance-vmrack-20260922.md) | 真机部署与验收记录（vmrack 美国机）：现场事实、方案 B 适配、逐条验收的真实输出、回滚与运维注意 |

## 已完成 / 未完成 / 未验证

**已完成**：上游契约快照与 76 条冻结允许清单；BFF 的会话、Origin/CSRF/Host 校验、限流、固定目标、路由白名单、脱敏日志与错误语义；静态托管与 SPA fallback；登录、总览、实时运行、用量分析、渠道、OAuth 账号、模型、下游 API Key、请求日志、管理任务、版本与诊断十一个页面；独立 Docker 镜像与 Compose、反向代理增量片段与中文运维文档。前端采用 CPA Usage Keeper 风格的顶部胶囊导航、暖灰卡片与响应式布局。

实时运行页使用 Parrot 的运行状态、并发、冷却与最近请求接口，每 15 秒刷新；用量分析页使用统计汇总、分组和模型统计接口，支持周期、维度、排序与模型明细。Parrot 当前管理契约没有 Keeper 的 SQLite 时序、社区排行、配额历史与刷新接口，因此不提供这些数据视图，也不推算货币金额或虚构趋势线。

**本次验证**：Web 类型检查、构建、29 个前端测试、8 个管理流程测试与前端路径检查通过；构建产物冒烟检查 15/15 通过。构建仍提示主 JavaScript chunk 超过 1200 kB。

**未完成**：Telegram 批准登录、真实供应商 OAuth 之外的登录方式、高级模型元数据、负载均衡、网络诊断、MCP/搜索、多媒体日志、更新/重启类操作（见 acceptance.md §4）。

**未验证（必须现场确认）**：与真实 Parrot 实例、真实管理密钥、真实供应商 OAuth、真实 Docker 构建与运行、真实 Nginx 校验与 reload、公网端口封闭，以及 HTTPS 域名下的 `__Secure-` Cookie 与浏览器行为（见 acceptance.md §5）。
