# 评审问题修复清单

本文件记录 `review/00-评审结论.md` 提出的问题及其修复状态。凡标「已修复」的条目都在本机真实执行过验证；标「未修复/需决策」的条目附原因。

**最终门禁（本机实跑，2026-10-18）**

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过（contracts / bff / e2e / web 四包，无 `error TS`） |
| `pnpm lint` | 通过（`scripts/lint.mjs` 真实检查，不再是 `process.exit(0)` 占位） |
| `pnpm test` | 通过：**116 例**（BFF 78 + Web 30 + E2E 8） |
| `pnpm build` | 通过：`✓ built in 2.99s`，预压缩 28 个文件，节省 1217.9 KB |
| `pnpm --filter @parrot-webui/e2e test:smoke` | 通过：**18/18** |
| `pnpm --filter @parrot-webui/e2e test:smoke:prod` | 通过：**31/31**（生产模式，此前无任何自动化覆盖） |
| `pnpm contracts:verify` | 通过：生成物与允许清单/快照完全同步 |
| `apps/web/dist` + `apps/bff/dist` 的 `*.map` | **0 个** |

---

## P0

### P0-1 sourcemap 随镜像发布，完整前端源码可公开下载

- **原状**：`apps/web/dist/assets/index-*.js.map` 7,283,343 B（占 dist 81.3%），被 `routes/health.ts` 标为 `public, max-age=31536000, immutable`；实名验证过 `GET /webui/assets/index-VdWscvgz.js.map` 返回 200 与 990 个 `sourcesContent`。`apps/bff/dist` 另有 17 个 `.map`。
- **修复**（四层，任一层独立即可阻断）：
  1. `apps/web/vite.config.ts` — `build.sourcemap: true` → `false`
  2. `apps/bff/tsconfig.build.json` — 显式 `sourceMap: false`、`declarationMap: false`（原来继承 `tsconfig.base.json:19` 的 `true`）
  3. `apps/bff/src/routes/health.ts` — `fastifyStatic` 加 `allowedPath(pathname) { return !pathname.endsWith('.map'); }`（静态层兜底）
  4. `Dockerfile` — 构建后硬断言：`find apps/web/dist apps/bff/dist -name '*.map'` 有任一命中即 `exit 1`
- **附带**：`apps/bff/package.json` 的 build 先 `rmSync('dist')`（tsc 不删历史遗留 `.map`）；`.dockerignore` 加 `**/*.map`。
- **验证**：`apps/web/dist` 与 `apps/bff/dist` 的 `.map` 计数为 0；生产冒烟第 21 项断言 `.map` 返回 404；`transport.test.ts` 有一条用例专门"map 文件真实存在仍返回 404"。

### P0-2 公开仓库泄露真实基础设施拓扑

- **原状**：`docs/acceptance-vps-20260922.md` 含 25 处真实基础设施标识——真实公网 IP、真实对外域名、真实内网网段、宿主 hostname 与部署路径，且该仓库 `https://github.com/JJDonald/parrot-webui.git` 为公开（`private=false`）。（本文件刻意不复述原始值。）
- **修复**：全部替换为文档保留值 —— 公网 IP → `203.0.113.10`（TEST-NET-3，RFC 5737 专用于文档）、域名 → `parrot.example.com`、内网段 → `172.17.0.0/16` / `10.30.0.0/24`、宿主 hostname → 占位说明。`README.md` 该条目改「海外 VPS」并注明已脱敏。
- **验证**：全仓 grep 原始 IP / 域名 / 内网段 **零命中**（不在此复述被搜的字符串本身，以免又一次写回）。
- **⚠ 未完成（需你决策）**：工作区文件已干净，但 **git 历史的三个提交（`41c17f4` / `1ef66c5` / `41f79cb`）里都仍有原始内容**，远端 `origin/main` 也在其中。要真正消除需 `git filter-repo` 重写历史 + 强制推送（并视情况轮换曾在该机器上用过的凭据）。这会改写公开历史，属于不可逆操作，我没有擅自执行。

---

## P1

| 编号 | 问题 | 位置 | 修复 | 验证 |
| --- | --- | --- | --- | --- |
| P1-1 | 畸形 JSON → 500 `WEBUI_INTERNAL`（未认证即可触发） | `apps/bff/src/server.ts` errorHandler 漏映射 `FST_ERR_CTP_INVALID_JSON_BODY` | 并入 `FST_ERR_CTP_EMPTY_JSON_BODY` 分支 → 400 `WEBUI_INVALID_REQUEST`；顺带给 413/415/400 分支补 `cache-control: no-store` | `transport.test.ts` 用例；生产冒烟第 7 项 |
| P1-2 | 会话绝对 8h 上限被上游刷新滑动重置 | `apps/bff/src/auth/session-store.ts:199` 用 `now +` 而非 `createdAt +` | `const localAbsolute = session.createdAt + sessionMaxSeconds*1000; absoluteExpiresAt = Math.min(localAbsolute, absolute)` | `fixes.test.ts`：创建=8.00h，T+7h 刷新后仍 ≤8h |
| P1-3 | query 净化正则误伤合法值（`a..b`、URL 形态全部 400） | `apps/bff/src/security/route-allowlist.ts` | 子串黑名单换成只拦真相对路径形状 `/(^\|[\\/])\.\.([\\/]\|$)/` + 单值 1024 上限 + 解码后控制字符拦截（保留 `DENIED_QUERY_KEYS`、`#`） | `fixes.test.ts` 放行/拦截边界；生产冒烟 `query=nginx/1.2.3` 200、`../../etc/passwd` 400 |
| P1-4 | `/stats/models/{modelId:path}` 含斜杠模型不可达 | `route-allowlist.ts` 不认识 Starlette `:path` 转换器 | 新增 `PATH_CONVERTER_ROUTES`，该路由允许尾部多段 join 成参数（≤256）；前端 `client.ts` 新增 `encodePathSegments`，`ModelStatsDrawer.tsx` 改用 | `fixes.test.ts` 3 条；上游 `test_management_stats_delivery_regressions.py` 同样场景 |
| P1-5 | 登录路由无 route 级 bodyLimit（2~5 MiB 先吃满再拒） | `apps/bff/src/server.ts` | `app.post(..., { bodyLimit: 16*1024 })` | `transport.test.ts` 超 16 KiB → 413 且上游零触达；生产冒烟第 9 项 20,500 B → 413 |
| P1-6 | `WEBUI_TRUST_PROXY` 配错静默降级为"所有用户共用限流键" | `.env.example`、`handleDiagnostics` | `.env.example` 重写说明（填 BFF 看到的直连对端、不是浏览器地址；给 Docker 网桥网关取法两种方案 + 验证法）；`controller.ts` 新增 `describeRequestSource()`，诊断接口输出 `{remoteAddress, forwardedFor, remoteTrusted, clientIp, trustProxy, warning}`，不可信时给明确 warning | 生产冒烟第 17 项实测 `remoteTrusted:true, clientIp:203.0.113.7, warning:null` |
| P1-7 | 单 chunk 1.62 MB + 全线无压缩 | `apps/web/vite.config.ts`、`health.ts`、根 `package.json` | `manualChunks` 按依赖族拆包 + `App.tsx` 12 个页面 `React.lazy` + 每页 `ErrorBoundary`；新增 `scripts/precompress-dist.mjs` 产 `.br`/`.gz`；`fastifyStatic` 开 `preCompressed` | 主入口 40,744 B（原 1,624,926）；br 12,270 / gz 14,463；生产冒烟第 22 项 `content-encoding: br` |
| P1-8 | `useWriteCapability` 正则失效，`canWrite` 恒 true | `apps/web/src/app/AuthProvider.tsx` | 改为已知能力白名单：只读集合 `{management.read, management.logs.body.read}`，写集合 `{write, secrets.write, destructive, update}`，未知能力保守放行交上游兜底 | typecheck + 现有用例 |
| P1-9 | 无 ErrorBoundary，任一页渲染异常整站白屏 | 新建 `apps/web/src/components/ErrorBoundary.tsx` | 组件 + `App.tsx` 每路由包裹（`scope` = 页面名，`resetKey` = pathname） | `global.scss` 配套样式；构建通过 |
| P1-10 | `progress` 字段类型误读（上游是 `{current,total,messageCode}`，前端当 `number`） | `apps/web/src/api/operations.tsx`、`OperationTrackerPanel.tsx` | `OperationRecord.progress` 改结构化类型 + `normalizeProgress()`；展示改按 current/total 计数 | typecheck（潜伏缺陷，无被允许的 operation 会上报 progress） |
| P1-11 | `normalizeStatus` 未知状态兜底 `'running'` → 永久轮询 | `apps/web/src/api/operations.tsx` | 兜底改 `'unavailable'`（`isTerminal` 已含该值） | 现有用例 |
| P1-12 | idempotency-key 放行 200 vs 上游上限 128 | `apps/bff/src/routes/management-proxy.ts:43` | 透传条件改 `>=1 && <=128`；`channelsApi.ts:110` 注释同步 | `fixes.test.ts` 上限用例 |
| P1-13 | `staticDir` 用 URL.pathname，Windows 得到 `/F:/...` | `apps/bff/src/config.ts:209` | 改 `fileURLToPath(new URL(...))` | 不设 `WEBUI_STATIC_DIR` 时 `/webui/health/ready` 由 503 变 200 |
| P1-14 | 四份验收文档互相矛盾（测试数 71/80/81、ready 语义、AboutPage 占位、导航形态） | `README.md`、`docs/acceptance*.md`、`docs/compatibility.md` | 逐条按实现与实测更正；`acceptance-current-20260925.md` 顶部加「历史记录，非当前状态」声明 | 见下「文档口径」 |
| P1-15 | 测试体系对生产态/畸形输入零覆盖 | `apps/bff/test/`、`tests/e2e/` | 新增 `transport.test.ts`(14)、`fixes.test.ts`(21)、`tests/e2e/smoke-production.mjs`(31) | 见门禁表 |

---

## P2 / P3

| 编号 | 问题 | 修复 |
| --- | --- | --- |
| P2-1 | 四包 `lint` 全是 `node -e "process.exit(0)"` | 新建 `scripts/lint.mjs`：XSS 面、`as any`/`@ts-*`、前端越界存储、裸日志、产物 sourcemap 五类真检查；四包与 root 接线；`packages/contracts` 的 `test` 从空转改为 `verify-contracts.mjs`。负向注入验证过能报错 |
| P2-2 | 无 CI、无 `.gitattributes`（CRLF 混乱） | 新增 `.github/workflows/ci.yml`（14 步，含两轮冒烟与产物断言）；新增 `.gitattributes`（`* text=auto eol=lf`、Dockerfile/conf/sh 强制 LF、二进制声明） |
| P2-3 | `--check` 不校验生成物漂移 | 新增 `scripts/verify-contracts.mjs`（生成到临时目录逐字节比对，归一化 CRLF），接 `pnpm contracts:verify` 与 Dockerfile；手动注入 `// drift-test` 实测能检出 |
| P2-4 | 限流器名实不符（`SlidingWindowRateLimiter` 实为固定窗口）+ 全局限流键可能被容量淘汰 | 改名 `FixedWindowRateLimiter`、头注释说明边界最多 2×limit；新增 `pinnedKeys`，`'global'` 固定键不可淘汰 |
| P2-5 | `DangerConfirmButton` 无 try/catch，失败后弹窗卡「执行中…」 | 加 `handleConfirm` try/catch + 失败提示（弹窗保留） |
| P2-6 | `UPSTREAM_CODE` 只覆盖 18/22 上游错误码 | 补齐 `ManagementErrorCode` 全部 22 项 |
| P2-7 | 模块级可变状态 `idleSecondsForPayload` 污染多实例 | `sessionPayload(session, idleSeconds)` 显式传参，删除 `configureSessionPayload` |
| P2-8 | 死代码：`FORBIDDEN_FORWARD_HEADERS`、`assertForwardableHeader`、`UpstreamResponse.revision`、`refund()`、`/session-summary` 影子端点、`RequestOptions.timeoutMs` | 全部删除（`fixes.test.ts` 有「影子端点确已不可达」用例） |
| P2-9 | 版本号硬编码 `'0.1.0'` | 新增 `apps/bff/src/version.ts` 从 `package.json` 读；Dockerfile 补 COPY |
| P2-10 | 13 个 `.env.example` 变量在 compose 下不生效 | `compose.yaml` 显式转发 12 个（并注释说明刻意不转发两个 dev-only 开关）；`.env.example` 取消注释并给默认值 |
| P2-11 | Caddy 片段缺 body 上限（Nginx 有 5m） | `deploy/Caddyfile.example` 加 `request_body { max_size 5MB }`（Caddy 2.10+，保留注释说明版本要求）；`docs/deployment.md` 记为两片段唯一能力差异 |
| P2-12 | 契约类型用 15 处相对路径穿透 workspace 边界，注释还说错 exports | 9 个文件统一改 `from '@parrot-webui/contracts/upstream'`（有效导入 + 故意无效导入双向验证过解析真实生效）；`upstream-types.ts` 过时注释更正 |
| P2-13 | `parseRetryAfter` 不解析 HTTP-date | 支持秒数与 `Date.parse` 两种形式 |
| P2-14 | 分页 `meta.total === null` 显示「共 0 条」 | 三处统一改为隐藏服务端计数 |
| P2-15 | `errors.ts` 超时文案对 GET 也写「写操作结果未知」 | 改「若为写操作则结果未知」；同步修正 `security.test.ts` 的 `toContain` 断言 |
| P3-1 | `WEBUI_SESSION_EXPIRED` 定义了却从不抛出 | 区分语义：无 Cookie → `REQUIRED`，持失效 Cookie → `EXPIRED` 并清 Cookie（两者同为 401，前端并入同一转登录流程）；新增 2 条用例 |
| P3-2 | 生产镜像含约 88 MB 无用前端依赖 | **未修复**：实测 `pnpm install --prod --filter @parrot-webui/bff...` 可把 node_modules 从 117.6 MB 降到 17.4 MB（省 ~100 MB），但当前 Dockerfile 后续阶段依赖 `apps/bff/node_modules` 路径，改动面大于收益，记为后续优化项 |

---

## 文档口径已对齐

- `README.md`：Node 前置改「Node 22+（engines >=22；Dockerfile 用 24）」，与实际 `engines` 一致；测试数、冒烟数（18/18 + 31/31）、拆包与预压缩现状、`pnpm lint` 不再是占位。
- `docs/acceptance.md`：测试总数 116（BFF 78 / Web 30 / E2E 8）+ 历史基线 81；冒烟 18/18；新增生产模式冒烟 31/31 整节；「验证过程中发现并修复的真实缺陷」由 2 条扩到 9 条；导航形态按实际顶部胶囊导航更正（全仓无 `<aside>`）。
- `docs/compatibility.md`：AboutPage「占位组件」断言删除（实际 448 行、真实调 `GET /webui/bff/diagnostics`）；`/health/ready` 语义改为「上游不可达仍 200，静态产物缺失才 503」，与实现和真机记录一致。
- `docs/security-model.md`：`maxRedirections: 0` 改为「undici `request()` 默认不跟随 + 代码把 3xx 转 `WEBUI_UPSTREAM_REDIRECT_BLOCKED`」；CSRF 例外改为「无本地会话时的 logout」；补 `requestSource` 与全局限流键说明。
- `docs/contracts.md`：生成物零漂移校验方法改为 `pnpm contracts:verify`，写明实现原理与已接入 Dockerfile。
- `docs/deployment.md`：TRUST_PROXY 正确填法 + 验证法、两片段能力差异、代码侧验收清单、修复一处被误删换行的排版错误。
- `docs/acceptance-current-20260925.md`：顶部加「历史记录，非当前状态」声明；末尾新增「本轮四个问题的后续处理状态」节。

---

## 仍需你决策 / 无法在本机验证

1. **git 历史脱敏**（P0-2 残留）：是否 `git filter-repo` 重写三个提交并强推 `origin/main`。仓库是公开的，我未擅自改写历史。
2. **`review/` 目录去留**：评审产物（含内部拓扑分析）目前未跟踪，`.dockerignore` 已排除、不会进镜像。可提交、移出仓库或删除。
3. **Docker 构建与容器运行**：本机 Docker daemon 不可用（`docker info` → `npipe:////./pipe/dockerDesktopLinuxEngine` 连接失败），镜像构建、容器健康检查、`docker compose up` 均未在本机验证。Dockerfile 里新增的 `.map` 断言与 `contracts:verify` 步骤只做了语法与等价命令验证。
4. **真实 Parrot 实例端到端**：全部测试都用 `node:http` 假上游；真实管理密钥、真实供应商 OAuth、真实反向代理 reload 需现场确认。
