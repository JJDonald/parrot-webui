# 代码评审共享上下文（所有评审员必读）

## 任务

用户要求：**审阅 `F:\workspace\parrot-webui` 这个项目的代码，并参考上游 Parrot 项目一起看。**

目标产出：一份有证据（文件:行号、实际命令输出）的评审结论，覆盖
1. 这个项目实际做了什么、架构是否自洽；
2. 与上游 Parrot 的契约/语义是否真正对得上（不是只看 README 自述）；
3. 真实缺陷、风险、与文档不符之处；
4. 值得改进的点（按优先级）。

## 两个代码库

| 代号 | 路径 | 说明 |
| --- | --- | --- |
| **webui** | `F:\workspace\parrot-webui` | 被评审对象：React SPA + Fastify BFF + 契约包，独立容器 |
| **upstream** | `F:\tmp\parrot-upstream\Parrot` | 上游 Parrot v0.33.1，commit `9b73d05`，Python/FastAPI，**只读参考** |

webui 冻结的上游基线记录在 `packages/contracts/upstream-meta.json`：
仓库 `https://github.com/danger-dream/Parrot`，commit `9b73d058635470d59eef7a10876e6532649435d9`（v0.33.1），
OpenAPI 3.1.0，237 operation / 175 path / 495 schema / 24 router，允许清单 76 条。
本地已 clone 的 upstream HEAD 就是同一个 commit（`9b73d05 chore: 发布 v0.33.1`），可直接逐行对照。

## 硬性规则（务必遵守）

1. **只读**：不要修改 webui 或 upstream 的任何现有源码/配置/生成物。你唯一可写的文件是分配给你的报告文件。
2. **每个结论必须有证据**：给出 `相对路径:行号` 或实际命令输出片段。禁止凭印象、凭 README 自述下结论。
   区分三种状态：**已核实** / **推断（未执行）** / **无法验证**。
3. **不重复他人的范围**：只看分配给你的部分，交叉问题写到报告的"交接给其他人"小节。
4. **不要 install/构建/改锁文件**。质量门禁由 Lead 统一跑，避免并发写 `node_modules`、`packages/contracts/generated`。
5. 语言：中文。代码/路径/字段名保持原文。

## 报告格式（务必遵守，便于汇总）

写入你被分配的 `review/*.md`，结构：

```markdown
# <主题>

## 0. 范围与方法
读了哪些文件（列全路径），跑了哪些命令。

## 1. 事实清单（已核实）
- 事实 + 证据（file:line 或命令输出）

## 2. 发现（按严重度）
### [P0] 标题
- 位置：`path/file.ts:123`
- 证据：代码片段 / 命令输出
- 影响：…
- 建议：…
（P0=会导致功能错误/安全缺陷；P1=显著风险或与文档不符；P2=可维护性/一致性；P3=风格）

## 3. 与文档自述的偏差
README/docs 声称 X，实际是 Y（附两边证据）。

## 4. 无法验证的事项
需要真实实例/真实凭据/浏览器才能确认的，逐条列出并说明原因。

## 5. 交接给其他人
本范围外但发现的问题。
```

## 项目速览（Lead 已核实）

- 单仓 pnpm workspace：`apps/web`（React+TS+Vite+AntD）、`apps/bff`（Fastify）、
  `packages/contracts`（OpenAPI 快照 + 生成物）、`tests/e2e`、`scripts/`、`deploy/`、`docs/`。
- 入口固定 `/webui/`；BFF 只代理冻结的 76 条管理路由；凭据只在登录时出现一次，Session 存 BFF 内存，
  浏览器只有 HttpOnly Cookie。
- 文档自述"已完成"十一个页面、契约自动化、容器化、真机验收（`docs/acceptance-vps-20260922.md`）。
- 已知自述缺口：lint 为占位实现；前端主包 1.6MB 超阈值；`packages/contracts/upstream.openapi.json`
  的**重抽取流程未交付**（`docs/contracts.md` 已自认"待现场确认"）；AboutPage 可能仍是占位。
