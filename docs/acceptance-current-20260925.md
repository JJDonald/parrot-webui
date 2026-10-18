# 当前工作区验收报告（2026-09-25）

> **历史记录，非当前状态。** 本报告固定的是提交 `41c17f4` 加当轮未提交改动的快照，其后仓库已引入大量修复（详见 `docs/acceptance.md` §3.5）。其中"前端主包 1,624.25 kB"与"80 个测试"两项已过期：当前主入口 chunk 为 40 kB 量级（已按依赖族拆包 + 路由级懒加载 + 预压缩），测试总数为 116 例。其余结论（容器加固、临时容器健康、预登录 Cookie 属性）当时为真，本报告未复验。

## 结论

本地工程与容器基础验收通过；完整业务验收待完成。本轮执行的检查未发现阻断构建、测试或容器启动的缺陷，不能据此认定全部页面和真实业务流程已经验收通过。

验收基线为提交 `41c17f4` 加工作区原有 9 个未提交文件改动。原有改动全部保留，本轮未修改业务代码。环境：Windows、Node v24.15.0、pnpm 12.5.1、Docker Engine 29.8.0。shell 未提供 pnpm 命令，使用 `npm exec --yes --package=pnpm@12.5.1 -- pnpm ...` 执行项目脚本。

## 实际执行结果

| 检查 | 结果 |
| --- | --- |
| `pnpm contracts:generate --check` | 通过：快照哈希匹配，76 条允许路由均存在 |
| `pnpm check:frontend-paths` | 通过：前端 56 条路径全部匹配 76 条允许模板 |
| `pnpm typecheck` | contracts、web、bff、e2e 四个包全部通过 |
| `pnpm test` | 80/80 通过：BFF 43、Web 29、HTTP 集成流程 8 |
| `pnpm build` | contracts、Web、BFF 全部构建成功，有大包警告 |
| `node tests/e2e/smoke-built.mjs` | 15/15 通过：静态资源、缓存、安全响应头、深链接、bootstrap、未登录访问、Origin/Host 拒绝等 |
| `docker compose --env-file .env.example config --quiet` | 通过 |
| `docker build -t parrot-webui:acceptance .` | 成功，容器内 contracts 的 76 条路由解析检查通过 |
| 生产模式临时容器 | 正常运行且 Docker 健康状态为 healthy；用户 node、只读根文件系统、tmpfs /tmp、cap-drop ALL、no-new-privileges，端口仅绑定回环地址 |
| 生产容器 HTTP 探测 | 健康检查、带正确 Host 的首页与 bootstrap 均返回 200；测试上游不存在时报告 WEBUI_UPSTREAM_UNREACHABLE |
| 生产预登录 Cookie | 响应包含 `__Secure-parrot_webui_prelogin`，Max-Age=300、Path=/webui/、HttpOnly、Secure、SameSite=Lax；没有记录 Cookie 值 |
| 浏览器基础检查 | 开发模式临时容器：访问 `/webui/channels` 跳转 `/webui/login`，页面加载且正确显示上游不可达原因 |
| 登录页 DOM 逻辑 | 使用页面脚本触发按钮：显示/隐藏切换 input 类型 text/password；空密钥时登录按钮禁用。浏览器存储仅看到主题 localStorage 键，sessionStorage 为空（仅限未登录状态） |
| 浏览器控制台 | 本轮读取时无消息 |

测试与浏览器使用本地测试上游或明确不可达的回环地址，没有使用真实管理密钥，没有连接或修改真实 Parrot 实例。HTTP 集成流程测试不是完整浏览器端到端交互测试。

## 发现的问题与建议

1. **静态检查缺失**：各应用与 e2e 的 lint 脚本为 `node -e "process.exit(0)"`，不能作为质量门禁。本轮未将该脚本计为有效验收。建议配置真正的 ESLint 等检查。
2. **前端主包偏大**：生产 JS 为 1,624.25 kB，gzip 495.53 kB，超过项目 1200 kB 警告阈值。建议按页面做动态导入并评估首屏加载；本轮未测加载性能，不能从包体积推断具体延迟。
3. **pnpm 冗余配置告警**：Docker 安装日志提示 package.json 中 `pnpm.onlyBuiltDependencies` 被 pnpm 12 忽略。已核对 pnpm-workspace.yaml 存在相应 `allowBuilds` 新配置，因此不是允许清单失效；建议清理旧字段以消除误导。
4. **验收文档状态不一致**：docs/acceptance.md 仍记载 71 个测试和多项从未验证；README 记载较新的测试数量，而 docs/acceptance-vps-20260922.md 已有历史真机部署结果。建议统一标注各记录的基线和日期，避免历史事实被当作当前状态。本报告只证明当前工作区本轮执行的项目。

## 尚未完成的验收

- **桌面/移动端视觉与完整交互**：内置浏览器返回 innerWidth=0、innerHeight=0，且拒绝 Emulation.setDeviceMetricsOverride。可验证 DOM 与路由行为，但不能可靠验证排版、溢出、遮挡、响应式布局、真实点击命中与键盘操作。
- **真实登录后的业务闭环**：渠道、账号、模型、API Key、日志、实时运行、用量分析、任务页的真实读取、提交、冲突处理、注销等，本轮未通过浏览器完整走查。现有 80 个测试不能替代这些操作。
- **真实供应商 OAuth**：没有执行授权、导入或同步流程。
- **当前构建的线上验收**：未部署当前代码，未复验真实 HTTPS Cookie 行为、反向代理、公网端口封闭及与现有业务路由的兼容性。生产 Cookie 检查仅为响应属性核验。

本轮临时容器将在完成检查后清理；保留 `parrot-webui:acceptance` 镜像用于复查。历史真机部署记录不作为本轮当前构建已上线的证据。

## 本轮四个问题的后续处理状态

> 以下是后续修复轮补记的状态，不属于 2026-09-25 本轮实测结论。

1. **静态检查缺失 → 已修复**：新增 `scripts/lint.mjs`，根 `pnpm lint` 与四个子包的 `lint` 均改为真实检查。规则不是风格偏好，而是评审确认过的底线：前端禁止 `dangerouslySetInnerHTML`/`.innerHTML =`/`eval(`/`new Function(`；前后端禁止 `as any`/`@ts-ignore`/`@ts-nocheck`/`@ts-expect-error`；业务代码禁止 `localStorage`/`sessionStorage`/`document.cookie`（仅主题名豁免）；BFF 禁止裸 `console.*`（必须走已脱敏的 fastify logger）；构建产物不得含 `*.map`。因无 ESLint 依赖（离线交付），用脚本实现，覆盖 57 个前端源文件与 18 个 BFF 源文件。
2. **前端主包偏大 → 已修复**：`vite.config.ts` 按依赖族 `manualChunks` 拆包（`vendor-antd`/`vendor-react`/`vendor-icons`/`vendor-query`/`vendor-dayjs`/`vendor`）并对 11 个页面做路由级 `React.lazy` 懒加载。主入口降到 40 kB 量级，首访按需加载页面 chunk；单块最大的是 `vendor-antd` 907 kB（第三方库整体，未再细分）。
3. **pnpm 冗余配置告警 → 已修复**：已从根 `package.json` 删除被 pnpm 12 忽略的 `pnpm.onlyBuiltDependencies` 字段（`pnpm-workspace.yaml` 的 `allowBuilds` 是生效配置）。删除后 `pnpm install --frozen-lockfile` 复跑：`Scope: all 5 workspace projects`、`Lockfile is up to date`、退出码 0，且不再出现该 WARN。
4. **验收文档状态不一致 → 已修复**：`docs/acceptance.md` 的测试总数改为"最新 116 例（BFF 78、Web 30、E2E 8），历史基线 81"，并逐条补记本轮新增的传输层 14 例与修复项回归 21 例；冒烟数字改为 18/18 并新增生产态 31/31；前端路径改为 56 条；`README.md` 的 Node 版本口径、导航形态、测试数量同步更正；`docs/compatibility.md` 的 AboutPage 占位断言与 ready 语义（上游不可达仍 200）已按实现更正。
