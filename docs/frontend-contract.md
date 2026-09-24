# 前端实现契约（页面开发者必读）

本文件固定 WebUI 前端的共享接口。页面代码只能通过这里的接口访问后端，不要自己写 `fetch`、
不要把请求逻辑散落在组件里，不要引入新的状态库。

上游事实来自 `packages/contracts/upstream.openapi.json`（Parrot v0.33.1，提交 9b73d058635470d59eef7a10876e6532649435d9，
237 个管理操作）。**字段名必须与 `packages/contracts/generated/upstream-mvp.d.ts` 一致，不得臆造。**

## 1. 目录与命名

```
apps/web/src/
  api/            client.ts（唯一 BFF 客户端）、hooks.ts（查询/变更）、operations.tsx（异步任务）、error-codes.ts
  app/            App.tsx（路由）、AppShell.tsx（布局）、AuthProvider.tsx、antdTheme.ts
  components/     state.tsx（六态）、feedback.tsx（错误/冲突）、bits.tsx（展示件）、OperationTrackerPanel.tsx
  features/<域>/  每个域一个目录，例如 features/channels/ChannelsPage.tsx
  styles/         theme.scss（唯一颜色来源）、global.scss（结构样式）
```

组件命名用中文文案、英文标识符；页面组件必须具名导出 `XxxPage` 并与 `app/App.tsx` 的导入一致。

## 2. 访问后端

```ts
import { useApiQuery, useApiMutation, usePollingInterval, DEFAULT_LIST_PAGE_SIZE } from '@/api/hooks';
import { encodeSegment, type ManagementResponse } from '@/api/client';

// 读：path 是相对 /bff/management 的管理路径
const list = useApiQuery<ChannelListData>({
  key: ['channels', { page, pageSize, keyword }],
  path: '/channels',
  query: { page, pageSize, keyword },
  refetchInterval: usePollingInterval(15_000), // 后台标签页自动降频
});

// 写：mutation 永不自动重试
const update = useApiMutation<{ channelId: string; body: ChannelUpdateRequest; ifMatch?: string }, ChannelData>({
  method: 'PATCH',
  path: (input) => `/channels/${encodeSegment(input.channelId)}`,
  body: (input) => input.body,
  ifMatch: (input) => input.ifMatch,
  invalidate: [['channels'], ['overview']],
});
```

规则：
- 资源 ID 一律 `encodeSegment()`，不要拼接多个分段，不要整体编码斜杠。
- 分页/筛选参数必须来自生成的类型（例如 models 用 `page`/`pageSize`，页码从 1 开始）。
- 写操作前若资源有 revision，必须把读到的原始值作为 `If-Match` 原样回传（`ManagementResponse.revision` 或列表 `meta.revision`）。
- 变更成功后只失效相关查询键，不要整站刷新。
- 管理读写只走 `useApiQuery` / `useApiMutation`（内部会经 `managementRequest()` 拼上 `/bff/management` 前缀）。
  不要用 `requestJson()` 传管理路径：它只拼 Vite base，请求会落到 `/webui/<管理路径>`，
  被 BFF 的 SPA fallback 以 404 `WEBUI_NOT_FOUND` 拒绝（永远到不了 Parrot）。
  `pnpm check:frontend-paths` 会静态拦住这种写法。

## 3. 页面必须实现的六类状态

用 `AsyncState`（`@/components/state`）：

```tsx
<AsyncState
  isLoading={list.isLoading}
  error={list.error}
  data={list.data?.data}
  isEmpty={(data) => data.items.length === 0}
  emptyTitle="还没有渠道"
  emptyDescription="点击右上角新增一个第三方 API 渠道。"
  onRetry={() => void list.refetch()}
  isStale={list.isError && Boolean(list.data)}
>
  {(data) => <YourTable data={data} />}
</AsyncState>
```

- 加载 / 正常 / 空数据 / 加载失败 / 权限不足 / 连接中断六种情况必须可区分；
  空数据不能显示成 0 统计，失败不能吞成空数组。
- 错误展示统一交给 `ErrorNotice`（`@/components/feedback`）：它会区分「Parrot 业务错误」与「WebUI 传输错误」，
  并处理 409 `REVISION_CONFLICT`、429+`Retry-After`、`SAVED_RELOAD_UNCONFIRMED`、`CAPABILITY_DENIED`。
- 冲突不得自动覆盖：用 `ConflictNotice` 或 `ErrorNotice` 的 `onResolveConflict`，保留用户已填的非秘密内容。
- 权限不足（`CAPABILITY_DENIED`）时保留登录状态、禁用写按钮并说明原因；同时用 `useWriteCapability()`（`@/app/AuthProvider`）预先禁用。

## 4. 异步任务（202 / operation）

```ts
const { track } = useOperations();
const response = await refreshUsage.mutateAsync({ channelId });
// 上游返回 202 时 data 里可能是 operationId；也可能直接返回 200 结果，必须按真实 schema 判断
const operationId = (response.data as { operationId?: string } | null)?.operationId;
if (response.status === 202 && operationId) {
  track({ operationId, origin: '渠道刷新用量', invalidate: [['channels']] });
}
```

- 202 只表示已受理，**不能**立即提示“成功”。
- 全局任务面板见 `/tasks` 页面（`OperationTrackerPanel`）；页面不要另建轮询实现。
- `succeeded` 仍可能包含部分来源失败：由 `OperationTrackerPanel` 展示 `partialNotice`；页面上如需内联展示结果，用 `JsonBlock`。
- 任务 404 表示记录不可用（可能实例重启）：提示并刷新业务资源，绝不自动重做任务。

## 5. 展示组件

来自 `@/components/bits`：`Pill`（tone: default/primary/success/warning/danger/muted）、`StatusDot`、`MonoText`、
`TimeText`、`RelativeTime`、`CopyableText`、`SecretReveal`、`JsonBlock`、`KeyValueList`、`StatCard`、`DangerConfirmButton`。

- 时间：未知就是「未知」，不要显示 0 或当前时间。
- 原始内容（日志正文、任务结果）只能经 `JsonBlock` 以纯文本渲染，**禁止** `dangerouslySetInnerHTML`。
- 秘密值：默认掩码，仅在用户主动展开时显示；不写入 localStorage / sessionStorage / URL。
- 危险操作（删除、吊销）用 `DangerConfirmButton`，展示资源名与实际已知影响，不要模拟级联删除。

## 6. 样式约定

只使用 `src/styles/theme.scss` 里的 CSS 变量，不要硬编码颜色/字号/圆角：

- 表面：`--bg-secondary`(页面) `--bg-primary`(卡片) `--bg-tertiary`(hover) `--floating-surface`
- 文本：`--text-primary` `--text-secondary` `--text-tertiary`
- 描边：`--border-color` `--border-primary`
- 品牌/语义：`--primary-color` `--success-color` `--warning-color` `--danger-color` `--quota-medium-color`
- 形状：`--keeper-card-radius`(24px) `--radius-md`(8px) `--radius-full`
- 组件类：`.keeper-card` `.keeper-card--flush` `.keeper-card__header/.keeper-card__heading/.keeper-card__title/.keeper-card__subtitle/.keeper-card__body`、
  `.btn/.btn--primary/.btn--secondary/.btn--ghost/.btn--danger/.btn--sm`、`.pill`、`.input`、`.field`、`.stat-grid/.stat-card`、
  `.empty-state`、`.loading-block`、`.raw-block`、`.stack`、`.row`、`.filters`、`.error-box`、`.notice-box`

视觉参考是 cpa-usage-keeper：暖色纸感、24px 圆角卡片、`--shadow-lg`、胶囊徽标、12px 正文。
Ant Design 组件（`Table`、`Drawer`、`Modal`、`Form`、`Select`、`DatePicker`、`Tooltip`、`Tabs`）可以直接用；
主题已在 `ConfigProvider` 里按 CSS 变量配置，无需再写 `theme` 属性，也不要覆盖 `algorithm`。

## 7. 轮询与后台标签页

- 定期刷新一律用 `usePollingInterval(毫秒)`；页面进入后台会自动降频（不要自己写 `setInterval`）。
- 总览页 15 秒刷新；其余列表按需 15–30 秒；详情抽屉里的正文等重数据不要自动轮询。
- 页面离开时停止不再需要的轮询（交给 Query 卸载即可），并停止不再需要的浏览器端流程。

## 8. 语言与可访问性

- 界面中文；按钮/输入要有可辨识标签（`aria-label` 或可见 label）。
- 移动端（≤768px）不出现无法提交的遮挡；表格用 `scroll={{ x: 'max-content' }}`。
