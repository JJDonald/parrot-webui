# 工程与交付面评审（文档可信度、容器化、反向代理、脚本、测试体系）

> 评审员：infra-reviewer。范围 = 交付面，不重复 `review/01-bff.md`（BFF 源码语义）与前端源码评审。交叉处标注"与 01-bff 交叉"。
> 用户核心疑问：**这个项目是不是真的像文档说的那样做完了**。因此本报告的重点是"文档声称 vs 代码/实跑事实"。

## 0. 范围与方法

**读过的文件（全路径）**

- 根：`README.md`、`package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`（仅查 importer）、`tsconfig.base.json`、`Dockerfile`、`compose.yaml`、`.env.example`、`.dockerignore`、`.gitignore`、`Parrot-WebUI-独立容器开发实施文档.md`（grep 定向）
- 文档：`docs/acceptance.md`、`docs/acceptance-current-20260925.md`、`docs/acceptance-vps-20260922.md`、`docs/deployment.md`、`docs/compatibility.md`、`docs/contracts.md`、`docs/security-model.md`、`docs/frontend-contract.md`
- 部署片段：`deploy/nginx-webui.conf`、`deploy/Caddyfile.example`
- 脚本：`scripts/generate-contracts.mjs`、`scripts/check-frontend-paths.mjs`
- 测试：`tests/e2e/management-flow.test.ts`、`tests/e2e/smoke-built.mjs`、`tests/e2e/package.json`、`tests/e2e/vitest.config.ts`、`apps/bff/test/{config,ip,security,session}.test.ts` + `helpers.ts`、`apps/web/src/**/*.test.{ts,tsx}`
- 各包 `package.json`（root / apps/bff / apps/web / packages/contracts / tests/e2e）、`apps/bff/tsconfig.build.json`、`apps/web/vite.config.ts`
- 交叉参考：`review/00-context.md`、`review/01-bff.md`

**跑过的命令（全部只读，未 install / 未 docker build / 未写任何仓库文件）**

| 命令 | 结果 |
| --- | --- |
| `node scripts/generate-contracts.mjs --check` | 退出码 0，`[contracts] 校验通过：76 条允许路由全部存在于快照；快照哈希匹配。` |
| `node scripts/check-frontend-paths.mjs` | 退出码 0，`允许清单模板 76 条；前端出现的上游路径 56 条` + `通过` |
| `node tests/e2e/smoke-built.mjs`（PORT=4357） | 退出码 0，**15/15 PASS** |
| `node -e` 起 `buildServer()` + `app.inject()`，注入 `PARROT_BASE_URL=http://127.0.0.1:1` | `/webui/health/ready` → **200**（上游不可达），`/webui/assets/index-VdWscvgz.js.map` → **200 / 7,283,343 B / cache-control: public, max-age=31536000, immutable / content-type: application/json** |
| 自行计算快照 | `bytes=2533037`、`sha256=ab552e2f3c80…a5e2`，与 `packages/contracts/upstream-meta.json` 完全一致 |
| `node -e` zlib 计算主包体积 | raw 1,624,926 B / gzip-9 494,955 B / brotli 398,308 B |
| `docker info` / `docker images` | **退出码 1**，daemon 不可用 → 见 §4 |
| 质量门禁（由 Lead 统一执行，我未重复跑） | `pnpm typecheck` 四包全部 0 错误；`pnpm test` **81 例全绿**（BFF 43 / Web 30 / E2E 8，与 §1-13 的 HEAD 计数一致）；`pnpm build` 成功（仅主 chunk > 1200 kB 警告）→ 门禁结论支持"能构建、测试能过"，**但不覆盖 §2 的任何 P0/P1**（全部是门禁测不到的部署面/文档面问题） |
| `git ls-files`、`git log`、`git show`、`git diff 41c17f4 HEAD`、`git ls-tree origin/main`、GitHub REST API | 用于追溯每份验收文档的真实基线 |
| 全仓 grep（密钥形态、压缩、sourcemap、SSE/WebSocket、CDN） | 见下 |

## 1. 事实清单（已核实）

1. **契约基线完全真实**：快照 2,533,037 字节、sha256 `ab552e2f…a5e2`、237 operation / 175 path / 495 schema / 24 router / 76 条允许清单（73 proxy + 3 auth），与 `docs/acceptance.md:11-14` 逐项一致；`generate-contracts.mjs --check` 本地可复现（退出码 0）。
2. **前端路径检查真实**：`check-frontend-paths.mjs` 实测"76 条模板 / 56 条前端路径 / 全部命中"，退出码 0，脚本无任何写文件操作。
3. **冒烟测试真实且可复现**：`tests/e2e/smoke-built.mjs` 实测 15/15，退出码 0；用假上游（`smoke-built.mjs:64-82`），不依赖真实 Parrot。
4. **单元/集成测试可离线复现**：`apps/bff/test/*` 43 例、`apps/web/src/**/*.test.*` 30 例、`tests/e2e/management-flow.test.ts` 8 例，全部使用假上游（`management-flow.test.ts:48` `startUpstreamStub()`），不依赖真实实例。
5. **镜像里不含 `review/`、`docs/`、`deploy/`、`tests/`**：`.dockerignore:1` 先 `**` 全排除、只白名单 4 个 package.json + 4 个源码目录 + 1 个脚本（`:2-10`），`:11-19` 又显式排除 `tests/ docs/ deploy/ .git`；Dockerfile 全程**没有 `COPY . .`**（`Dockerfile:44-48`、`:92-102` 都是逐路径 COPY）→ 用户担心的"review/ 打进镜像"**不成立（已核实）**。
6. **镜像加固真实**：`Dockerfile:110` `USER node`、`compose.yaml:82` `read_only: true`、`:83-84` `tmpfs /tmp:size=32m,mode=1777`、`:85-86` `cap_drop: ALL`、`:87-88` `no-new-privileges:true`、`:40` `init: true`、`:43` `user: "node"`、`:98` `stop_grace_period: 20s`、`:99-103` 日志 10m×3。
7. **端口默认只回环**：`compose.yaml:47-48` 仅 `"127.0.0.1:3000:3000"`；`docker compose --env-file .env.example config` 实跑通过（退出码 0），渲染结果 `published: "3000"` + `host_ip: 127.0.0.1`。
8. **健康检查不对外**：`deploy/nginx-webui.conf:40-41` 与 `deploy/Caddyfile.example:35-36` 都把 `/webui/health`、`/webui/health/*` 直接 404；BFF 侧 `health.ts:17-22` live 用 `assertHost(..., true)`。
9. **反代片段保留 `/webui/` 前缀**：`nginx-webui.conf:48-49` 注释明写"proxy_pass 末尾没有 URI"且实际 `proxy_pass http://127.0.0.1:3000;`（无 URI → nginx 原样透传原 URI）；`Caddyfile.example:39-40` 用 `handle /webui/*` 而非 `handle_path`，`reverse_proxy` 本身不剥前缀 → `docs/deployment.md:105-106` 的说法属实。
10. **`X-Forwarded-For` 覆盖而非追加**：`nginx-webui.conf:57` `proxy_set_header X-Forwarded-For $remote_addr;`（不是 `$proxy_add_x_forwarded_for`）→ 客户端伪造的 XFF 被丢弃；与 `apps/bff/src/security/ip.ts:122-141`（仅可信对端才读 XFF、从右往左取第一个不可信）配合正确。`security-model.md:57-58` 描述与此一致。
11. **`.env.example` 无真实秘密**：全仓 tracked 文件 grep `pmk_[A-Za-z0-9]{8,}` / `sk-…` / `Bearer …` / `password=` **零命中**；`.env.example:4` 自述"本文件本身不含任何真实秘密"；`compose.yaml:80` 明确注释"这里绝不能出现共享管理密钥"。
12. **compose 无默认弱配置**：三个必填项用 `${X:?...}` 强制（`compose.yaml:65/67/69`），无默认口令/密钥，`cap_drop: ALL` 已实测渲染正确。
13. **测试数字的真实基线（逐个 commit 追溯）**：
    - `41c17f4`（首个提交）：BFF 43 + Web **29**（client 9 / oauthSafety 12 / logsSafety 8，`currency.test.ts` 尚不存在）+ e2e 8 = **80**。
    - `41f79cb`（当前 HEAD）：新增 `currency.test.ts` 1 例 → BFF 43 + Web **30** + e2e 8 = **81**。
14. **`--check` 确实不写文件**：`scripts/generate-contracts.mjs:119-122` 在 `checkOnly` 时 `report(); process.exit()` 提前返回，所有 `writeFileSync`（`:167`、`:347`、`:350-353`）位于其后。
15. **`.env.example` 与 `config.ts` 变量对账一致**：`apps/bff/src/config.ts` 读 28 个变量，`.env.example` 全覆盖（15 个生效 + 13 个注释态），取值区间注释与 `config.ts:168-207` 逐项一致。
16. **无 SSE/WebSocket 需求**：`apps/bff/src` 与 `apps/web/src` grep `event-stream|EventSource|WebSocket|upgrade` **零命中**（`client.ts` 只把 `upgrade` 当不可转发头）；前端用 React Query 轮询（`apps/web/src/api/hooks.ts:30-38` `usePollingInterval` 按 `document.visibilityState` 降频，`apps/web/src/features/realtime/RealtimePage.tsx:38` `POLL_MS = 15_000`）+ `bits.tsx:60` 30s 定时器 → **反代片段缺 `proxy_buffering off` / `Upgrade` 头不是缺陷（已核实）**。README:131 "每 15 秒刷新" 属实。
17. **两个片段对 `/webui`（无尾斜杠）的行为一致**：nginx `:34-37` 带 `$host` 校验 + 308；Caddy `:32` `redir /webui /webui/ 308`（Caddy 默认 `redir` 保留查询串，nginx 的 `return 308 /webui/` 也会保留）。
18. **`deploy/nginx-webui.conf` 片段本身语义正确**：`location ^~ /webui/` 优先级高于正则 location（`:44`），`Connection ""` 清空 hop-by-hop 头（`:59`），`client_max_body_size 5m` 与 BFF `oauthImportBodyLimitBytes` 对齐（`:66`），`access_log off` 防止 OAuth 回填 URL 里的临时秘密进日志（`:68-69`）。

## 2. 发现（按严重度）

### [P0] 生产镜像通过公网 `/webui/assets/*.map` 泄露前端与 BFF 全部源码
- **位置**：`apps/web/vite.config.ts:29`、`tsconfig.base.json:19`、`Dockerfile:97-98`、`.dockerignore:11-19`、`deploy/nginx-webui.conf:44-72`
- **证据（已核实，实跑）**：用 `buildServer()` + `app.inject()` 请求 `/webui/assets/index-VdWscvgz.js.map` → **200，7,283,343 字节，`content-type: application/json`，`cache-control: public, max-age=31536000, immutable`**；JSON 内含 `sourcesContent`（真实源码全文，990 个 source 条目、内容总计 4,586,166 字符，其中含 `../../src/app/AuthProvider.tsx` 等应用源码）。落盘实证：`apps/web/dist/assets/index-VdWscvgz.js.map` = 7,283,343 B，占整个 `dist`（8,958,370 B）的 **81.3%**；`apps/bff/dist` 另有 **17 个 `.map`**。根因三处叠加：① `vite.config.ts:29` `sourcemap: true`；② `tsconfig.base.json:19` `"sourceMap": true` 被 `apps/bff/tsconfig.build.json` 继承且未覆盖；③ `Dockerfile:97-98` 整目录 `COPY --from=build /app/apps/web/dist` 与 `/app/apps/bff/dist`，`.dockerignore` 无 `.map` 规则，`nginx-webui.conf` 也未拦 `*.map`。`apps/bff/src/routes/health.ts:57-78` 的静态托管还会给 `/assets/*` 打上 `immutable` 长期缓存头。
- **影响**：任何能访问 `/webui/` 的人（含未登录）都能一条 curl 下载完整前端源码（React 组件、API 层、页面逻辑），是源码级信息泄露；同时 7.2 MB 死重进入镜像与发布物。**这与 `docs/security-model.md` 全篇"最小暴露面"的定位相悖，而文档全篇未提 sourcemap**。
- **建议**：`vite.config.ts:29` 改为 `sourcemap: false`（或 `'hidden'` + 只在 CI 上传）；`tsconfig.base.json` 保持 `sourceMap: true` 供调试但 `apps/bff/tsconfig.build.json` 显式 `"sourceMap": false`；`Dockerfile` 在 COPY 前 `RUN rm -f apps/web/dist/assets/*.map apps/bff/dist/**/*.map`（或用 `find ... -delete`）；`.dockerignore` 加 `**/*.map`；反向代理片段加 `location ~* \.map$ { return 404; }` 作为兜底。**与 01-bff.md §2 P0 的 sourcemap 项交叉，本条从构建/部署侧补充了体积与缓存头证据。**
- **附**：`review/01-bff.md` 与我独立测得的字节数不同（它记 7,215,020，我记 7,283,343），差异来自 build 时点/是否含 `sourcesContent`，不影响结论。

### [P0] `/webui/health/ready` 永不返回 not-ready，与 `docs/compatibility.md:46` 直接矛盾
- **位置**：`apps/bff/src/routes/health.ts:24-37`（关键 `:28`）
- **证据（已核实，实跑）**：`PARROT_BASE_URL=http://127.0.0.1:1`（必定不可达）+ `app.inject('GET','/webui/health/ready')` → **status 200**，body `{"status":"ready","staticAssetsPresent":true,"upstream":{"reachable":false,"managementApiDetected":false},"webui":{"basePath":"/webui/"}}`。读码证实根因：`:26` 只把 `probeManagement()` 的结果填进响应体，`:27` `staticReady`，**`:28` `const ready = staticReady;`** —— 上游可达性完全不参与就绪判定。
- **影响**：① 任何依赖 `ready` 的编排（k8s readinessProbe、负载均衡摘除、`docker compose` 外部探针）在上游挂掉时仍认为实例"就绪"，用户会一直被接到一个必然 500/502 的实例；② 文档层面更严重：`docs/compatibility.md:45-46` 明写"上游不可达 → `/webui/health/ready` 返回 503 / not-ready"，而 `docs/acceptance-vps-20260922.md:56` 又把"200 + `upstream.reachable:false`"称为"无 Parrot 时的**正确表现**"——**两份文档对同一行为给出相反期望**。③ 若按 `compatibility.md:46` 把它改真，则 `compose.yaml:90-96` 用 live 而非 ready 做 healthcheck 的设计（避免上游抖动触发重启循环）恰好说明作者想的是"ready 不参与容器存活"，但没写清 ready 的消费者是谁。
- **建议**：二选一并写清语义。若 ready 表示"能服务"/就绪：`:28` 改为 `const ready = staticReady && probe.reachable && probe.managementApiDetected;`，不可达时 503。若 ready 只表示"静态产物已就绪"：把 `docs/compatibility.md:45-46` 改成与 VPS 记录一致的描述，并在 `deployment.md:97` 明确"ready 不反映上游状态，上游状态只作观测字段"。**无论选哪条，必须补一条单测**（当前 `apps/bff/test/*` 对 `health` 零覆盖，见 P1）。
- **交叉**：`review/01-bff.md:142-155` 已从代码侧记录同一根因，本条补充"注入式实测 200"与"文档互相矛盾"两处证据。

### [P1] `WEBUI_TRUST_PROXY` 在"宿主反代 + compose 回环发布"场景下几乎没有正确示例，填错会静默让限流退化
- **位置**：`.env.example:46-49`（示例值 `127.0.0.1`）、`docs/deployment.md:61`、`docs/deployment.md:231`、`compose.yaml:47-48`、`apps/bff/src/security/ip.ts:122-141`
- **证据**：`.env.example:46-49` 示例值写 `WEBUI_TRUST_PROXY=127.0.0.1`（注释为"例如 `127.0.0.1` 或 `172.18.0.0/16`"）；`deployment.md:61` 只说"必须与真实入口网络一致，填错会导致来源判定与限流键失真"，全文没有给出"容器部署时该填什么"的可操作指引；`deployment.md:231` 把它列入"待现场确认"。代码侧 `ip.ts:122-141`：直连对端不在 `trustProxy` 内 → **直接返回直连地址、完全忽略 XFF**。
- **结论（推断，未在真实 Docker 中复现）**：`compose.yaml:47-48` 发布的是 `127.0.0.1:3000:3000`。宿主 Nginx/Caddy 连 `127.0.0.1:3000` 时，经 Docker 的 DNAT 后，**容器内看到的直连对端是网桥网关地址，不是 `127.0.0.1`**（默认 bridge 为 `172.17.0.1`，自建网络为该网络网关，如 `172.18.0.1`）。因此照抄 `127.0.0.1` 时：
  - 直连对端 `172.x.0.1` 不在可信列表 → `resolveClientIp` 返回 `172.x.0.1`；
  - 所有浏览器用户被识别成**同一个来源** → `loginPerSource`（5 次/分钟）、`bootstrapPerSource`（20 次/分钟）全局共享一个桶；
  - **不会报错、不会打日志、只会静默降级**，`docs/security-model.md:74-75` 自己就写了这个后果（"来源限流会退化成共享桶"），但文档没有把它与 `.env.example` 的示例值联系起来。
- **正确填法（按优先级）**：
  1. **推荐**：把 WebUI 加入入口代理（Nginx Proxy Manager / Caddy 容器）所在的**用户自定义网络**，用服务名访问（方案 B，`compose.yaml` 顶部注释与 `deployment.md:108-112` 已给改法），`WEBUI_TRUST_PROXY` 填该网络网段（如 `10.30.0.0/24`）。**`docs/acceptance-vps-20260922.md:103-105,144,378` 的真机记录用的正是这条路径**，说明团队实际知道正确做法，只是没回写到 `.env.example`。
  2. 方案 A（宿主反代 + 回环发布）下：先取真实网关地址 —— `docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'`（自定义网络换成网络名），把该地址写进 `WEBUI_TRUST_PROXY`；或临时开 `LOG_LEVEL=debug` + 发一次请求，从 BFF 日志确认直连来源。
- **验证方法（明确可执行）**：从两台不同客户端（如手机热点 + 本机）各触发一次登录失败，第二次应拿到 **不同的 `Retry-After` 计数**，而不是第二个客户端立刻 429；或者用 `X-Forwarded-For` 不同的两个请求打 `/webui/bff/auth/login`，比较 429 的触发次序。
- **建议**：`.env.example:49` 改为注释态，并分场景写明两种填法；`deployment.md:61` 附近加一段"如何取到真实网关地址"；`deployment.md:126-166` 验收清单加一条"两个不同客户端限流键必须不同"。**与 01-bff.md §4 第 2 条一致，本条从交付文档侧给实例值与验证步骤。**

### [P1] 反向代理与 BFF 都**不做任何压缩**，1.62 MB 主包以未压缩形式上线
- **位置**：`deploy/nginx-webui.conf:44-72`、`deploy/Caddyfile.example:39-50`、`apps/bff/src/server.ts`、`apps/bff/src/routes/health.ts`
- **证据（已核实）**：`deploy/nginx-webui.conf` 与 `deploy/Caddyfile.example` grep `gzip|brotli|encode|compress` **零命中**；`apps/bff/src` 全部 grep 同样零命中（唯一命中是 `upstream/client.ts:58` 的黑名单头 `transfer-encoding`）。实测主包 raw **1,624,926 B**、gzip-9 **494,955 B**、brotli **398,308 B**。
- **影响**：`docs/acceptance-current-20260925.md:33` 里"gzip 495.53 kB"只是构建统计数字，**线上并不会发生 gzip**——首屏实际传输 1.62 MB。文档从未说明"压缩由谁负责"，使用者按 `deployment.md:104-106` 装上片段后会以为已经优化过。
- **建议**：`nginx-webui.conf` 在 `location ^~ /webui/` 内加 `gzip on; gzip_types application/javascript text/css application/json image/svg+xml; gzip_min_length 1024; gzip_vary on;`（片段是增量片段，需注意 gzip 必须在 http/server 级才生效——在 location 级写 `gzip on` 是允许的）；Caddy 加 `encode zstd gzip`（放在 site 块级）；`docs/deployment.md` 加一句"压缩由入口代理负责，BFF 不做压缩"。

### [P1] 四份验收文档对同一批事实给出**互相矛盾或已过期**的结论，且只有 `acceptance-current` 标注了基线
- **位置**：见下表
- **证据**：见 §3 的矛盾清单（每条给两侧 `file:line`）。
- **影响**：这正是用户"项目是不是真做完了"疑问的直接来源。`docs/acceptance-current-20260925.md:35` 已经自认"验收文档状态不一致，建议统一标注基线和日期"，但**该问题至今未修**，且 README 的文档索引（`README.md:115-125`）**根本不指向 `acceptance-current-20260925.md`**，读者只会看到最旧的那份。
- **建议**：① 给 `docs/acceptance.md` 与 `README.md` 的"本次验证"数字全部重跑一遍并附基线 commit + 日期；② 在 `docs/acceptance.md` 顶部加"历史记录，最新见 acceptance-current-YYYYMMDD.md"；③ `README.md:115-125` 索引补上 `acceptance-current-20260925.md`；④ 把 `acceptance.md:41`、`acceptance.md:101`、`acceptance.md:59`、`acceptance.md:61` 的过期内容删掉（见 §3）。

### [P1] `docs/acceptance-vps-20260922.md` 把真实生产拓扑写进了**公开** GitHub 仓库
- **位置**：`docs/acceptance-vps-20260922.md`（L10/42/351/383 等）
- **证据（已核实）**：`git remote -v` = `https://github.com/JJDonald/parrot-webui.git`；GitHub REST API 实测 `private:false` / `visibility:"public"` / `license:null`。该文件含**真实公网 IP（4 次）**、**真实对外域名（14 次）**、**真实内网网段**、宿主 hostname、同机其它站点域名（`:125,282-283`）、部署绝对路径与 NPM 配置路径。`git show 41c17f4:docs/acceptance-vps-20260922.md` 确认**首个提交就已包含**，`git ls-tree -r origin/main -- docs/` 确认**已推送**（origin/main 版本与本地 HEAD 相同）。原始值不在此复述。
- **影响**：真实公网 IP + 真实域名 + 内网网段 + 同机其它站点域名同时公开，可直接被用于资产测绘与横向攻击面定位；同机站点名暴露更放大了社会工程价值。**没有发现真实管理密钥/API Key**（密钥类 grep 零命中），所以不是凭据泄露，而是**基础设施拓扑泄露**。
- **建议**：把 IP/域名/内网段/hostname/同机站点名全部替换为占位符（`<host-ip>`、`example.com`、文档保留网段）后重写该文件；由于已进 git 历史与 GitHub，需评估是否需要 `git filter-repo` 清理历史 + 强制推送（或至少删除远程历史并重建仓库）。同时 `docs/deployment.md:46` 已有"未允许对外发布镜像时不要推送镜像仓库"的纪律，但**没有"验收记录不得含真实基础设施标识"的纪律**，建议补一条。

### [P1] 测试体系对 7 类关键路径零覆盖（这正是上面两个 P0/P1 没被测出的原因）
- **位置**：`apps/bff/test/*.test.ts`、`tests/e2e/smoke-built.mjs`、`apps/bff/test/helpers.ts`
- **证据（已核实，grep 全量）**：

  | 关键路径 | 覆盖情况 | 证据 |
  | --- | --- | --- |
  | **健康检查语义**（ready 是否正确降级） | **零覆盖** | `grep health/ready|health/live` 在 `apps/bff/test/*.ts` 零命中；`smoke-built.mjs` 只测 live 200，不测 ready |
  | **畸形 JSON 请求体**（`FST_ERR_CTP_INVALID_JSON_BODY`） | **零覆盖** | `grep malformed|invalid json|bad json|语法错误` 在 `apps/bff/test/*.ts` 零命中（01-bff P0-1 即此缺陷） |
  | **生产模式 Cookie 属性**（`__Secure-` 前缀 / `Secure` / 完整属性） | 仅 config 层，**HTTP 层零覆盖** | `config.test.ts:74-78` 断言 `cookieSecure=true/cookiePrefix='__Secure-'`；但 `helpers.ts:73-74` 固定 `cookieSecure:false/cookiePrefix:''`，`session.test.ts:78-79` 明确 `expect(cookie?.secure ?? false).toBe(false)` |
  | **生产模式 HSTS 与全部安全响应头** | **零覆盖** | `grep strict-transport-security|content-security-policy|x-frame-options` 在 `apps/bff/test/*.ts` 零命中；`smoke-built.mjs:115-122` 只断 CSP 两项 + nosniff + no-referrer，**未断 HSTS / x-frame-options / COOP/CORP / permissions-policy**，且 smoke 跑在 `NODE_ENV=development`（`:67-82`），HSTS 根本不发 |
  | **`WEBUI_TRUST_PROXY` 生效性**（可信 XFF 生效 / 不可信 XFF 被忽略的端到端断言） | **零覆盖** | `trustProxy` 只出现在 `config.test.ts:20,46,102-112`（解析层）与 `helpers.ts:54`；`security.test.ts`/`session.test.ts` 无任何限流键断言 |
  | **并发登录闸门**（`maxConcurrentLogin`） | **零覆盖** | `maxConcurrentLogin` 只作为配置值出现在 `helpers.ts:69`，无用例 |
  | **真实反代头组合**（完整 nginx 头集） | **零覆盖** | `smoke-built.mjs` 的 15 项里只有一条"错误 Host 421"（`:175`）；没有"Host + XFF + X-Forwarded-Proto 全套"的集成断言 |

- **影响**：43 个 BFF 用例 + 30 个前端用例 + 8 个 e2e 用例数量看起来不少，但**全部跑在开发态（非 Secure Cookie、无 HSTS）和单进程假上游**，对"生产容器怎么表现"这一层几乎没有断言。`docs/acceptance-current-20260925.md:21` 声称"生产模式临时容器 healthy + Cookie 属性核验"，但这是**手工一次性验证**，不可回归——一旦有人改 `helpers.ts` 或 `config.ts`，测试不会红。
- **建议**：把 smoke 跑两遍（development + production，production 下加断 `__Secure-` 前缀、`Secure`、HSTS）；`helpers.ts` 增加 `PROD` 变体；补 5 条针对性用例：ready 降级、畸形 JSON 400、可信/不可信 XFF 限流键不同、并发登录第 N+1 个被拒、完整反代头组合。

### [P2] README 的"已完成/本次验证"清单与实现有 3 处不实或过期
- **位置**：`README.md:129`、`README.md:133`、`README.md:52`
- **证据（已核实）**：
  1. `README.md:133` "29 个前端测试" —— **当前 HEAD 是 30 个**（`41f79cb` 新增 `apps/web/src/features/analysis/currency.test.ts` 1 例）；29 是 `41c17f4` 的数。
  2. `README.md:52` "前置：Node 24" —— `package.json:6-8` `engines.node` 是 `">=22"`，Dockerfile 又固定 `node:24-bookworm-slim`（`Dockerfile:18`）。三处口径不一。
  3. `README.md:129` "十一个页面" **属实**（`apps/web/src/app/App.tsx:111-123` 共 11 条路由）✓，但同一句里"前端采用 CPA Usage Keeper 风格的**顶部胶囊导航**"与 `docs/acceptance.md:41` 的"**左侧导航** + 玻璃顶栏 + 主内容区、**移动端抽屉侧栏**"冲突；实况是**顶部横向 dock**（`apps/web/src/app/AppShell.tsx:79-85` `<nav className="keeper-dock">`），全仓 `aside` 零命中、`theme.scss:105-106` 的 `--keeper-sidebar-width` **只有定义无引用**、无任何布局级侧栏 Drawer（`Drawer` 只用于业务抽屉）→ **`acceptance.md:41` 的"左侧导航 + 抽屉侧栏"是过期描述**。
- **影响**：用户第一眼看的 README 数字就是不准确的；`acceptance.md:41` 与代码相悖会让人怀疑整份验收的真实性。
- **建议**：README 数字改为"30 个前端测试"或直接不写具体数字（改为指向一次可复现的命令）；`package.json:6-8` 的 `engines` 与 README/Dockerfile 统一；删掉 `acceptance.md:41` 的"左侧导航 + 移动端抽屉侧栏"。

### [P2] `docs/compatibility.md` 关于 AboutPage 的描述已反向过期（代码早已远超文档）
- **位置**：`docs/compatibility.md:38-41`；实现 `apps/web/src/features/about/AboutPage.tsx`
- **证据（已核实）**：`compatibility.md:38-41` 写"前端的「版本与诊断」页面目前只是占位组件（`apps/web/src/features/about/AboutPage.tsx` 只渲染"尚未实现"）… 是否要为本版补齐该页面由主流程决定"。实际 `AboutPage.tsx` 是 **448 行完整实现**：`:10` import `bff, type DiagnosticsResponse`、`:61` `useState<DiagnosticsResponse|null>`、`:74` `await bff.diagnostics(controller.signal)`、`:120` 页面文案"全部信息来自 WebUI 后端（BFF）的脱敏诊断接口 `GET /bff/diagnostics`"、`:168` `<AsyncState<DiagnosticsResponse>`。**`review/00-context.md:73` 也把"AboutPage 可能仍是占位"列为已知缺口——该假设同样已过期。**
- **影响**：文档自我贬低到与事实不符，同样损害可信度（读者会以为功能缺失）。
- **建议**：删掉 `compatibility.md:38-41` 整个引用块。

### [P2] `.env.example` 里 11 个可运维变量在 compose 部署下**根本不生效**
- **位置**：`compose.yaml:55-80`（只有 15 个 `environment` 项）、`.env.example:66-68,78,81,84,88-95`
- **证据（已核实）**：`compose.yaml` 全文只有 `:55` 一个 `environment:` 块、15 个键，**没有 `env_file:`**（grep `env_file` 零命中）。`apps/bff/src/config.ts` 实际读 **28** 个环境变量；compose 转发了 15 个，剩下 13 个在容器里读不到。其中 11 个是**运维需要调的容量/限流/体积上限**：`WEBUI_MAX_SESSIONS`（`.env.example:67`）、`WEBUI_MAX_PRELOGIN_SESSIONS`（`:68`）、`WEBUI_MAX_UPSTREAM_RESPONSE_BYTES`（`:78`）、`WEBUI_BODY_LIMIT_BYTES`（`:81`）、`WEBUI_OAUTH_IMPORT_BODY_LIMIT_BYTES`（`:84`）、`WEBUI_LOGIN_PER_SOURCE_PER_MINUTE` / `WEBUI_LOGIN_GLOBAL_PER_MINUTE` / `WEBUI_MAX_CONCURRENT_LOGIN`（`:88-90`）、`WEBUI_BOOTSTRAP_PER_SOURCE_PER_MINUTE` / `WEBUI_BOOTSTRAP_GLOBAL_PER_MINUTE` / `WEBUI_MAX_CONCURRENT_BOOTSTRAP`（`:93-95`）。剩下 2 个是 `WEBUI_ALLOW_INSECURE_PUBLIC_ORIGIN`（`:103`）、`WEBUI_DEV_INSECURE_COOKIES`（`:106`），标注"仅开发用途"、不转发合理。
- **影响**：运维按 `.env.example:66-95` 的说明去调容量或限流，改完 `docker compose up -d` **毫无效果且无任何提示**——这是最典型的"文档说了但部署路径没接上"。
- **建议**：在 `compose.yaml` 的 `environment:` 里追加这 11 个变量的透传（`${X:-默认值}` 形式，默认值与 `config.ts:194-207` 对齐），或加 `env_file: .env` 并确认硬编码的 `NODE_ENV`/`PORT` 等优先级更高；同时在 `.env.example` 顶部注明哪些变量由 compose 透传。

### [P2] 镜像里装了约 86 MB 运行时完全不需要的前端依赖
- **位置**：`Dockerfile:68-79`、`apps/web/package.json:14-23`
- **证据（已核实）**：实测 `node_modules/.pnpm` 238.0 MB / 38,426 文件；其中 `apps/web` 的 `dependencies`（`apps/web/package.json:14-23`：antd 46.1 MB、@ant-design/icons 10.6 MB、@ant-design/icons-svg 3.5 MB、react-dom 7.7 MB、react-router 4.6 MB、@tanstack/react-query+query-core 4.7 MB、react 0.2 MB 等）**小计 86.3 MB**，会被 `pnpm install --prod` 装进运行镜像，而运行期只有 `node apps/bff/dist/index.js` 一个进程（`Dockerfile:119`），用不到任何 React 代码。`Dockerfile:74-75` 的注释已自认"apps/web 的 dependencies 不是运行时必需"，但仍为 `--frozen-lockfile` 兼容而安装。
- **影响**：镜像体积 / 攻击面（`node_modules` 里的多余包）双输；`README.md:45` 的"只含生产依赖与产物"字面上没错但会让人以为很精简。
- **建议**：把 UI 依赖从 `apps/web/package.json` 的 `dependencies` 移到 `devDependencies`（Vite 构建时能拿到，生产 install 就不装了）；或运行阶段只 COPY `apps/bff/node_modules` 与 `packages/contracts/node_modules`（Dockerfile:92-94 虽已单独 COPY 3 个路径，但 prod-deps 阶段 `pnpm install --prod` 仍装整棵树，COPY 的是同一棵树的子集）。

### [P2] Caddy 片段缺少 nginx 片段具备的请求体上限，两个片段能力不对等
- **位置**：`deploy/nginx-webui.conf:66` vs `deploy/Caddyfile.example:39-50`
- **证据（已核实）**：nginx 有 `client_max_body_size 5m`；Caddy 文件 grep `max_size|request_body|encode|gzip` **零命中**。BFF 侧兜底仍然存在：`server.ts:63` `bodyLimit: config.oauthImportBodyLimitBytes`（默认 5 MiB，`config.ts:201`），代理路由再按 `management-proxy.ts:84` `parseByteSize(match.route.bodyLimit, ctx.config.defaultBodyLimitBytes)` 收到 1 MiB（`config.ts:200`），超限由 `server.ts` 映射为 413 `WEBUI_PAYLOAD_TOO_LARGE`。所以功能不坏，但入口层失去了 OAuth 导入 5 MiB 的纵深防御。
- **影响**：选 Caddy 方案的部署者会在入口层失去一层纵深防御；文档 `deployment.md:104-106` 把两个片段说成"等价"。
- **建议**：`Caddyfile.example` 加 `request_body { max_size 5MB }`（写在 `handle /webui/*` 内），并补 `encode gzip`（见 P1 压缩项）；`deployment.md:104-106` 标注两者差异。

### [P2] `scripts/generate-contracts.mjs --check` 不能发现"生成物与允许清单不同步"
- **位置**：`scripts/generate-contracts.mjs:119-122`、`Dockerfile:52`、`docs/contracts.md:79-84`
- **证据（已核实）**：`--check` 只校验①快照 sha256、②76 条允许清单在快照中存在；**不校验 `packages/contracts/generated/*` 是否与 `mvp-routes.json` 一致**（生成物写入在 `:167`、`:347`，`--check` 在 `:119-122` 就返回了）。`docs/contracts.md:79-84` 已自认这一点（"需要 `pnpm contracts:generate && git diff --exit-code`"），**但 `Dockerfile:52` 构建阶段只跑 `--check`**。
- **影响**：如果开发者改了 `packages/contracts/mvp-routes.json` 后忘记重跑 `contracts:generate`，或手改了 `generated/management-routes.ts`，**`--check` 会通过、镜像会构建成功**，而运行时 `FROZEN_ROUTE_COUNT`/路由表与允许清单不一致。
- **建议**：`Dockerfile:52` 改为 `RUN pnpm contracts:generate && git diff --exit-code packages/contracts/generated`（或加一个 `--verify-generated` 模式），并让 `pnpm test` 前置这一步。

### [P2] `docs/acceptance.md` 既不标日期也不标基线提交，是全部数字过期的根因
- **位置**：`docs/acceptance.md`（全文）
- **证据（已核实）**：`grep "202[0-9]-[0-9]" docs/acceptance.md` **零命中**；但 `:3` 声称"所有结论都对应真实执行过的命令或明确标注为未执行"，`:53` 声称"结果为本次交付的真实输出"。该文件里 `:59` 的"71 个用例（43/20/8）"**与任何 commit 都对不上**（41c17f4 是 80，HEAD 是 81），`:61` 的"14/14"实测是 15/15，`:101` 的"55 条前端路径"实测 56。
- **影响**：一份没有时间戳的"验收记录"无法判断是否过期，而它恰恰是 README 索引里唯一指向的验收文档（`README.md:124`）。
- **建议**：文件头加"生成时间 / 基线 commit / 环境"三行，并把易变数字（用例数、路径数、smoke 项数）改为"见 `pnpm test` 输出"而不是硬编码。

### [P2] 前端主包 1.62 MB 且无任何压缩/代码分割，但文档只把它当"警告"
- **位置**：`apps/web/vite.config.ts:30`、`docs/acceptance-current-20260925.md:33`
- **证据（已核实）**：`chunkSizeWarningLimit: 1200`、主包 1,624,926 B（gzip 494,955 / brotli 398,308）；`acceptance-current:33` 只写"超过阈值，建议按页面动态导入…本轮未测加载性能"，**未列为阻塞项**；配合上文的"无压缩"（P1），线上首屏实际是 1.62 MB。
- **影响**：移动端/弱网首屏体验差；这不是"警告"级别，是真实交付质量问题。
- **建议**：`App.tsx` 的 11 个页面改 `React.lazy` + `Suspense`（路由级分割天然适合），配合入口压缩后首屏可降到 200–300 kB 量级。

### [P2] `docs/deployment.md` 的"验收清单"是手工勾选，无任何自动化或交叉校验
- **位置**：`docs/deployment.md:126-166`
- **证据（已核实）**：13 条验收项全是 `- [ ]` 手工 checkbox（`:130-137`），其中 `:139-151` 明写"公网端口拒绝验证必须从另一台公网机器执行"（**这条纪律是对的**）。但没有任何一条能把结果回写到可核验的地方，且 `acceptance-current:37-42` 明确说当前构建的"完整业务验收待完成"——**清单的存在制造了"已验收"的错觉**。
- **影响**：`docs/deployment.md:4` 虽然诚实自述"本文件不包含任何已验证通过的结论"，但 `README.md:129` 的"已完成"清单包含"Compose、反向代理增量片段与中文运维文档"，两者并列会让读者误判。
- **建议**：在清单顶部加一行"本清单为待执行模板，执行结果记录在 `docs/acceptance-*.md`"；README 的"已完成"项只列代码能力，把"容器/反代"移到"已提供但未验证"。

### [P3] Dockerfile 注释与 pnpm 实际行为不符（**不是构建失败**）
- **位置**：`Dockerfile:34`、`Dockerfile:35-38`、`.dockerignore:16`、`pnpm-workspace.yaml:4`
- **证据（已核实）**：`Dockerfile:34` 注释"pnpm workspace 的每个 importer 都必须出现在这里，`--frozen-lockfile` 才能通过"，但 `:35-38` 只 COPY 4 个 `package.json`（不含 `tests/e2e`）。Lead 在 `F:\tmp\dockerctx-sim` / `sim2` 精确复刻该阶段实测：`pnpm install --frozen-lockfile` → **exit 0**（`Scope: all 4 workspace projects` / `Lockfile is up to date, resolution step is skipped` / `Packages: +320`）；`NODE_ENV=production pnpm install --prod --frozen-lockfile --ignore-scripts` → **exit 0**（`Packages: +167`）。原因：`pnpm-workspace.yaml:4` 的 `tests/e2e` 是 glob，被 `.dockerignore:16 tests/` 排除后匹配不到项目，pnpm 不要求第 5 个 importer。
- **影响**：**注释误导维护者**（会有人以为"漏 COPY 会失败"而困惑，或反过来以为"COPY 齐了才能过"）；且镜像构建阶段跑不了 e2e 测试。
- **建议**：把 `Dockerfile:34` 注释改成"tests/e2e 被 .dockerignore 排除，不参与容器内安装；e2e 需在宿主 CI 跑"。

### [P3] 其它交付面小问题（已核实，仅记录）
- `deploy/nginx-webui.conf` 占位符 `parrot.example.com` 共 **11 处**（`:20,35,46,53,54,77,78,79,80,81,82`），`deployment.md:107` 只说"必须替换"未给清单 → 建议列出或改用变量。
- `docs/acceptance-vps-20260922.md:244`、`:342` 把片段路径写成 `docs/nginx-webui.conf`，实际在 `deploy/nginx-webui.conf`（`docs/` 下不存在该文件）。
- `Dockerfile:54` 注释"contracts（目前为占位 build）"过期：`packages/contracts/package.json:24` 已是真实 `tsc -p tsconfig.build.json`。
- `README.md:115-125` 文档索引漏列 `docs/acceptance-current-20260925.md` 与 `Parrot-WebUI-独立容器开发实施文档.md`。
- `package.json:24-27` 的 devDependency `openapi-typescript ^7.9.1` 在脚本中从未被 import（`generate-contracts.mjs:356` 只在 `--full` 时提示手动执行）→ 声明未使用。
- `apps/bff`、`apps/web`、`tests/e2e`、`packages/contracts` 四个包的 `lint` 全是 `node -e "process.exit(0)"`；`packages/contracts` 的 `test` 也是空转 → 被 `pnpm test` 计入"通过"（**README:59 与 acceptance-current:32 已诚实自认，不算过度声称**）。全仓无 ESLint/Prettier 配置、无 `.github/`（无 CI）。
- 公开仓库 **无 `LICENSE`**（GitHub API `license: null`）→ 他人无法合法使用。
- `bootstrapTtlSeconds` 硬编码 300s（`config.ts:196`），不可通过环境变量配置，文档未说明。
- `deploy/Caddyfile.example:40` `reverse_proxy 127.0.0.1:3000` 与 nginx 一致（宿主回环），但 Caddy 若跑在容器里则 127.0.0.1 指向 Caddy 自己 → 文档未区分"Caddy 在宿主"与"Caddy 在容器"两种形态。

## 3. 与文档自述的偏差

**§3.1 四份验收文档的矛盾清单（每条给两侧证据 + 判定）**

| # | 事实 | 文档 A | 文档 B | 实测/代码 | 判定 |
| --- | --- | --- | --- | --- | --- |
| 1 | 上游不可达时 `ready` 的状态码 | `docs/compatibility.md:45-46`：`/webui/health/ready` **返回 503 / not-ready** | `docs/acceptance-vps-20260922.md:56`：**200** … `upstream.reachable:false`（"无 Parrot 时的正确表现"） | `health.ts:28` `ready = staticReady` → **恒 200**；注入实测确认 200 | **B 对，A 错** |
| 2 | 测试用例总数 | `docs/acceptance.md:59`：**71**（BFF 43 + Web 20 + E2E 8） | `docs/acceptance-current-20260925.md:16`：**80/80**（43/29/8） | `41c17f4` = 80；HEAD = **81**（Web 30） | **都不对**；B 是 41c17f4 基线，A 与任何 commit 都对不上 |
| 3 | 前端测试数 | `docs/acceptance.md:59`：Web **20** | `README.md:133`：**29** | HEAD = **30** | 都过期；A 更离谱 |
| 4 | 冒烟项数 | `docs/acceptance.md:61`：**14/14** | `docs/acceptance-current-20260925.md:18`：**15/15** | 实跑 **15/15** | **B 对，A 过期** |
| 5 | 前端出现的上游路径数 | `docs/acceptance.md:101`：**55** 条 | `docs/acceptance-current-20260925.md:14`：**56** 条 | 实跑 `check-frontend-paths.mjs` **56** | **B 对，A 过期** |
| 6 | `docker build` 是否执行过 | `docs/acceptance.md:64`：**未执行**（daemon 不可用） | `docs/acceptance-current-20260925.md:20-21`：**成功**，容器 healthy | 本机 `docker info` exit 1 → 当前无法复现 | **两者都在各自时点为真**，但 A 无日期、B 未同步回 A → 读者无法判断；处置见 §4 |
| 7 | 是否存在真机部署 | `docs/acceptance.md:127`、`README.md:137`：真实 Docker/反代/浏览器**未验证** | `docs/acceptance-vps-20260922.md:§4`：真机实测 8 个小节（真实登录、Cookie、端口封闭、加固、原实例无回归） | 该记录有具体命令输出与 sha256，可信；但**其基线是 2026-09-22 的构建**，不等于当前 HEAD | **都是真的，但时间线被混淆**：`acceptance-current:44` 已声明"历史真机记录不作为本轮当前构建已上线的证据"，A/README 却没有这条限定 |
| 8 | AboutPage 是否占位 | `docs/compatibility.md:38-41`：**只是占位组件** | `apps/web/src/features/about/AboutPage.tsx`：**448 行完整实现**（`:10,61,74,120,168`） | 代码完整实现 | **文档错** |
| 9 | 前端导航形态 | `docs/acceptance.md:41`：**左侧导航 + 移动端抽屉侧栏** | `README.md:129`：**顶部胶囊导航** | `AppShell.tsx:79-85` 顶部横向 `keeper-dock`；`aside` 零命中；无布局级 Drawer | **README 对，acceptance 错** |
| 10 | `WEBUI_TRUST_PROXY` 填法 | `.env.example:49`：示例 `127.0.0.1` | `docs/acceptance-vps-20260922.md:144,378`：真机用 `10.30.0.0/24` | `ip.ts:122-141` 要求必须匹配真实直连对端 | **VPS 对**；`.env.example` 的示例在容器部署下大概率错（P1） |

**§3.2 README / docs 明确声称但实现不成立或未接上的**

| 文档自述 | 实际 | 位置 |
| --- | --- | --- |
| `README.md:45` "只含生产依赖与产物"；`docs/deployment.md:44` 同义表述 | 含 ~86 MB 运行期不需要的前端依赖（P2） | `Dockerfile:68-79` + `apps/web/package.json:14-23` |
| `README.md:52` "前置 Node 24" | `engines.node` 是 `">=22"`（P2） | `package.json:6-8` vs `Dockerfile:18` |
| `README.md:133` "29 个前端测试" | HEAD 是 30 | `apps/web/src/features/analysis/currency.test.ts` |
| `README.md:115-125` 文档索引 | 漏列 `acceptance-current-20260925.md`、实施文档 | `README.md:115-125` vs `docs/` 实际 8 个文件 |
| `.env.example:66-95` 文档化了 11 个可运维变量（容量/限流/体积上限） | compose 不转发 → 容器内不生效（P2） | `compose.yaml:55-80` |
| `docs/security-model.md` 全篇"最小暴露面" | 生产镜像泄露 sourcemap（P0） | `vite.config.ts:29` + `Dockerfile:97-98` |
| `docs/deployment.md:104-106` 两个片段"等价" | Caddy 缺 body 上限、两者都无压缩（P2/P1） | `nginx-webui.conf:66` vs `Caddyfile.example:39-50` |

**§3.3 文档诚实、不构成过度声称的部分（需为项目正名）**

- `docs/deployment.md:4` 明确自述"本文件不包含任何已验证通过的结论"；`:126` "未执行不要写'通过'"。
- `docs/contracts.md:28-29` 自认上游快照"重抽取流程未随仓库交付"；`:79-84` 自认 `--check` 不校验生成物漂移。
- `docs/acceptance-current-20260925.md:35` 自认"验收文档状态不一致"；`:44` 自认"历史真机记录不作为当前构建已上线的证据"；`:37-42` 列出 4 项未完成。
- `README.md:59` 自认 lint 是占位；`README.md:135,137` 的未完成/未验证清单与代码实况大体一致。
- `Parrot-WebUI-独立容器开发实施文档.md`（61 KB）grep `已验证|已实测|验收通过|全部通过` 仅 2 处命中且都是技术约束描述，**无任何测试数量或验收声称** → 该文档没有过度声称。

## 4. 无法验证的事项

1. **`docker build` / `docker compose up` 全部无法执行**：本机 `docker info` → 退出码 1（`failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`）。因此：`docs/acceptance-current-20260925.md:20-21`（build 成功 + 容器 healthy + 加固生效）**在本环境无法复现，也无法证伪**——它写于 2026-09-25，当时 Docker Engine 29.8.0 可用。本报告对 Dockerfile 的判断全部基于静态读码 + Lead 在 `F:\tmp\dockerctx-sim` 对 install 阶段的复刻实验，**没有一次真实的镜像构建**。
2. **`WEBUI_TRUST_PROXY` 的真实取值**：结论（填 Docker 网桥网关或改用自定义网络）是**推断**，依据是 Docker 端口发布的 DNAT 语义 + `ip.ts:122-141` 的读码；未在真实 Docker 中抓过 `request.socket.remoteAddress`。
3. **反代片段能否通过 `nginx -t` / `caddy validate`**：本机无 nginx / caddy 二进制（`Get-Command` 无输出），**未做任何语法校验**；所有结论均为逐行读码。`deploy/nginx-webui.conf` 的 `if ($host != ...)` 在 location 内使用（`:35,46`）属 nginx 官方称之为 "if is evil" 的用法，但此处只做 `return`，是**公认的安全子集**，不构成缺陷。
4. **真实 Parrot 实例的端到端**：无真实管理密钥，未登录过真实上游；`docs/acceptance-vps-20260922.md` 的真机结论只能作为**历史事实**采信，不能复现。
5. **`.map` 文件是否真的在生产镜像里**：我实测的是**本地 `dist` 目录**（`apps/web/dist/assets/*.map` 与 `apps/bff/dist` 17 个 `.map` 存在）+ `Dockerfile:97-98` 整目录 COPY + `.dockerignore` 无排除规则，三处证据推定镜像内必然存在；**未在真实镜像中 `docker run ... ls` 验证**。
6. **pnpm 12 对 `onlyBuiltDependencies` 的忽略**：采信 `docs/acceptance-current-20260925.md:34` 的构建日志结论，未独立复现（需 install）。

## 5. 交接给其他人

**给 Lead（汇总时请优先采信这几条）**
1. **P0 sourcemap 泄露**：与 `review/01-bff.md` 的 P0 是同一问题，两条证据互补（bff 侧证明对外 200 + 字节数，我侧证明体积占比 81.3% + 缓存头 `immutable` + `.dockerignore` 无排除 + 反代无拦截）。**建议合并为一条 P0**。
2. **P0 ready 语义**：同样与 `01-bff.md:142-155` 交叉。**汇总时请写明"实现与 VPS 记录一致、`compatibility.md:46` 该改"**，避免被误判为"实现有 bug"。
3. **`WEBUI_TRUST_PROXY`**：`01-bff.md §4-2` 与我 §2 的 P1 是同一件事。我的补充是：**正确填法在 `docs/acceptance-vps-20260922.md:144` 里其实已经出现过（`10.30.0.0/24`），只是没回写到 `.env.example`**。
4. **公开仓库泄露真实基础设施**（我独有的 P1）：建议在最终结论里单列，因为这是**用户可立即行动的最高收益项**（改文档不够，已进 git 历史）。
5. **验收文档矛盾**（§3.1 表格 10 行）：建议直接用表格呈现给用户，它最直接回答"是不是真做完了"。

**给前端评审员**
- `docs/acceptance.md:41` 的"左侧导航 + 移动端抽屉侧栏"与 `AppShell.tsx:79-85` 的顶部 dock 不符，请确认前端侧是否还有其它文档重复此描述。
- `docs/frontend-contract.md:105` 禁止 `dangerouslySetInnerHTML`：交付面未覆盖，建议在前端评审中核实全仓是否存在该调用。

**给 BFF 评审员**
- `apps/bff/test/*` 对 `health`、畸形 JSON、生产 Cookie/HSTS、TRUST_PROXY 端到端、并发闸门**零覆盖**（§2 P1 表格），建议在你的报告里也记一笔，并给出"补哪 5 条用例"的具体建议。
- `scripts/generate-contracts.mjs --check` 不校验生成物漂移（`docs/contracts.md:79-84` 已自认），`Dockerfile:52` 只跑 `--check` → 构建不会发现漂移。

**给清理工作（Lead 执行）**
- `review/_tmp_b9.txt`（182,087 B）与 `review/_tmp_b10.txt`（204,361 B）是上下文转储、非交付物，**最终交付前需删除**。这两个文件不是我创建的，我未改动。
- 另：`review/` 目录本身不在 `.dockerignore` 白名单内（被 `**` 覆盖），**不会进镜像**（已核实），但也不应进入最终交付。

**未完成但建议补做的验证（超出本次只读约束）**
- `docker build` + `docker run --rm parrot-webui:acceptance ls -la /app/apps/web/dist/assets`（确认 `.map` 在不在镜像里）。
- 真实 nginx `-t` 校验 `deploy/nginx-webui.conf`（本机无 nginx）。
- 两个不同客户端各触发一次登录失败，验证限流键不同（验证 `WEBUI_TRUST_PROXY` 是否填对）。
