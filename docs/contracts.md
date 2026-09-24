# 上游契约：快照、生成与校验

本文件说明本项目的契约事实从哪里来、怎么校验、允许清单怎么冻结和扩展，以及出错时**不能**做什么。
所有数值都来自仓库内的实际文件，不要凭印象改写。

## 1. 事实来源（唯一）

| 文件 | 作用 |
| --- | --- |
| `packages/contracts/upstream.openapi.json` | 上游 Parrot 管理 API 的 OpenAPI 快照（唯一事实来源） |
| `packages/contracts/upstream-meta.json` | 快照的来源记录：仓库、提交、版本、哈希、字节数、统计数字 |
| `packages/contracts/mvp-routes.json` | MVP 路由允许清单（BFF 允许代理的 method + path 模板） |
| `packages/contracts/generated/management-routes.ts` | 生成物：冻结路由表，BFF 的 `@parrot-webui/contracts/routes` 唯一来源 |
| `packages/contracts/generated/upstream-mvp.d.ts` | 生成物：允许清单真正触及的上游 schema 闭包的 TypeScript 类型 |
| `scripts/generate-contracts.mjs` | 校验 + 生成脚本（只读仓库内文件，从不连接任何 Parrot 实例） |

当前基线（`packages/contracts/upstream-meta.json` 原文）：

- 仓库：`https://github.com/danger-dream/Parrot`，分支 `main`
- 提交：`9b73d058635470d59eef7a10876e6532649435d9`（`chore: 发布 v0.33.1`），发布版本 `v0.33.1`
- 快照：`upstream.openapi.json`，OpenAPI `3.1.0`，2533037 字节
- 快照 sha256：`ab552e2f3c80f6db368297ef50240b95a34ee3150687d6c3f161280ef870a5e2`
- 统计：237 个 operation、175 条 path、495 个 schema、24 个 router
- 允许清单：`mvp-routes.json`，冻结 76 条路由
- 抽取方式（meta 中 `isolation`）：对固定提交做隔离检出后用 Python 3.14 组合 management router 导出 schema；
  **未启动 uvicorn、未连接任何真实 Parrot 实例、未读取用户凭据**。

> 待现场确认：把快照从上述提交重新抽出来的完整可复现步骤没有随本仓库交付（`scripts/` 下只有校验/生成脚本）。
> 重做基线前需要先补齐该抽取流程并记录命令与产出哈希。

## 2. 命令

```bash
# 校验 + 生成（默认）：校验快照哈希与允许清单，然后重写 generated/ 下的两个文件
pnpm contracts:generate

# 只校验，不写任何文件（CI/构建阶段用；失败时退出码非 0）
pnpm contracts:generate --check

# 在默认行为之外，额外提示如何生成"全量类型"（体积较大，默认不生成）
pnpm contracts:generate --full
```

等价于直接调用脚本：

```bash
node scripts/generate-contracts.mjs            # 校验 + 生成
node scripts/generate-contracts.mjs --check    # 只校验
node scripts/generate-contracts.mjs --full     # 校验 + 生成 + 全量类型提示
```

`--check` 与默认行为的差别（脚本实际逻辑）：

- 默认：先做全部校验，通过后写入 `packages/contracts/generated/management-routes.ts`、
  `packages/contracts/generated/upstream-mvp.d.ts`，并用实际条数刷新 `upstream-meta.json` 的 `allowlistRouteCount`。
- `--check`：只做校验并打印结论，**不写文件**（因此不会因为校验"顺带"修改生成物）。
- `--full`：本身不生成全量类型，只在输出中提示执行
  `pnpm exec openapi-typescript packages/contracts/upstream.openapi.json -o packages/contracts/generated/upstream.full.d.ts`。
  该文件体积大，默认不生成、也不必纳入版本控制（按团队约定决定）。

成功输出形如：

```
[contracts] 校验通过：76 条允许路由全部存在于快照；快照哈希匹配。
```

## 3. 校验规则（失败即中断构建/CI）

1. **快照哈希**：`upstream.openapi.json` 的 sha256 必须等于 `upstream-meta.json` 的 `snapshotSha256`。
   不一致时报错：`快照哈希不一致：文件 <actual> != upstream-meta.json 记录 <expected>`。
2. **来源文件存在**：缺少快照或 `upstream-meta.json` 直接失败。
3. **允许清单逐条核对**：`mvp-routes.json` 中每条 `method + path` 模板都必须原文出现在快照里，
   否则报错 `允许清单中的路由在上游快照中不存在：<METHOD> <PATH>` 并以非 0 退出。
4. **非致命提示（notes，不影响退出码）**：
   - 快照字节数与 `snapshotBytes` 不一致（哈希一致时以哈希为准）；
   - 快照 operation 数与 `operationCount` 不一致；
   - `excluded.phase2` 中列出的路径在快照里找不到匹配。

注意：`--check` **不校验** `generated/` 下的生成物是否与当前允许清单同步（它只校验快照与允许清单）。
需要“生成物零漂移”的检查请用：

```bash
pnpm contracts:generate && git diff --exit-code packages/contracts   # 期望无差异
```

## 4. 允许清单如何冻结与扩展

冻结的含义：BFF 只代理 `mvp-routes.json` 里列出的 `method + path` 模板，其他任何管理路径一律拒绝
（`WEBUI_ROUTE_NOT_ALLOWED`，HTTP 404）。路由模板是字面量匹配，不是前缀放行。

`mvp-routes.json` 的结构：

- `routes[]`：每条含 `method`、`path`（与快照完全一致的模板，含 `{param}` 占位）、可选 `class`
  （缺省为通用代理；`class: "auth"` 表示只允许 BFF 认证控制器调用，浏览器无法直接代理）、可选
  `bodyLimit`（如 `1mb`、`5mb`）、可选 `note`。当前共 76 条，其中 3 条为 `class: "auth"`。
- `excluded.phase2[]`：本版明确不开放的上游能力（例如 Telegram 批准登录、`updates/*`、`system/*`、
  `network/*`、`mcp/*` 等），用于避免被误认为遗漏。
- 说明性字段 `$comment`。

扩展步骤（缺一不可）：

1. 在 `mvp-routes.json` 的 `routes[]` 里新增条目，`path` 必须与快照逐字一致（含参数占位写法）。
2. `pnpm contracts:generate`（重新生成冻结路由表与类型，并刷新 `allowlistRouteCount`）。
3. `pnpm typecheck`、`pnpm test`；BFF 侧同步更新对应用法的实现与测试。
4. 代码评审时确认：这条路由确实属于 MVP 范围，写操作有对应的鉴权/CSRF/体积/幂等处理。

缩小或调整范围同理：删除条目后重新生成并跑测试。`excluded.phase2` 的条目本身不参与放行。

## 5. 不要为了通过校验而修改快照

以下做法都是违规（会掩盖真实的不兼容，属于伪造结论）：

- 为了让 `pnpm contracts:generate` 通过而编辑 `upstream.openapi.json`（例如手写补一条上游不存在的路由）；
- 直接把 `upstream-meta.json` 的 `snapshotSha256` / `snapshotBytes` / 统计数字改成"算出什么就填什么"；
- 手改 `packages/contracts/generated/*`（文件头已注明"由脚本生成，请勿手改"）；
- 把允许清单里的路由删掉以回避"路由不存在"的失败，但页面上仍然调用它。

正确做法：

- **基线升级**（上游换版本）：走完整的快照重抽流程 → 更新 `upstream-meta.json` 的 `commit`、`commitSubject`、
  `release`、`snapshotSha256`、`snapshotBytes`、`openapiVersion`、各统计数字 → `pnpm contracts:generate` →
  处理新增/删除/重命名路由引起的类型与页面改动 → 在交付记录里写清差异与影响范围。
- **确实需要新能力**：按第 4 节扩展允许清单，不要靠改快照"造"接口。
- **只是本地想试**：用隔离实例或 fake server，不要动仓库内的快照与允许清单。
