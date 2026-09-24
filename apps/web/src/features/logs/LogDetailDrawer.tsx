/**
 * 日志详情抽屉。
 *
 * - GET /logs/{logId} 只读取摘要：日志字段、上游可用性标记、执行阶段/尝试记录（受控 JSON）；
 * - 请求/响应正文默认不加载，由 LogBodySection 在用户主动展开时才请求；
 * - 抽屉不做自动轮询（摘要 staleTime 放长，正文区块完全不自动轮询）；
 * - 所有上游字符串与原始内容只作为文本渲染（JsonBlock / React 文本节点），不使用 dangerouslySetInnerHTML。
 */

import { Collapse, Drawer, Tabs } from 'antd';
import { encodeSegment } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { CopyableText, JsonBlock, KeyValueList, MonoText, Pill, TimeText } from '@/components/bits';
import { AsyncState } from '@/components/state';
import { LogBodySection } from './LogBodySection';
import { SensitiveBodyNotice } from './LogNotices';
import {
  COST_TICKS_HINT,
  formatCount,
  formatDuration,
  modelSummary,
  statusLabel,
  statusTone,
  type RequestLogDetailData,
} from './logTypes';
import styles from './logs.module.scss';

export interface LogDetailDrawerProps {
  logId: string | null;
  open: boolean;
  onClose: () => void;
  /** management.logs.body.read 能力判定（缺失能力时不发正文请求） */
  bodyCapability: { allowed: boolean; reason: string | null };
}

export function LogDetailDrawer({ logId, open, onClose, bodyCapability }: LogDetailDrawerProps) {
  const detail = useApiQuery<RequestLogDetailData>({
    key: ['logs', 'detail', logId],
    path: `/logs/${encodeSegment(logId ?? '')}`,
    enabled: open && Boolean(logId),
    // 摘要不自动轮询：详情是历史记录，不随列表刷新
    staleTimeMs: 120_000,
  });

  const data = detail.data?.data ?? undefined;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width="min(760px, 100vw)"
      title={
        <span className="row" style={{ gap: 8 }}>
          <strong>日志详情</strong>
          {data ? <Pill tone={statusTone(data.log.status)}>{statusLabel(data.log.status)}</Pill> : null}
        </span>
      }
      destroyOnHidden
    >
      <div className={styles.drawerStack}>
        <SensitiveBodyNotice />

        <AsyncState<RequestLogDetailData>
          isLoading={detail.isLoading}
          error={detail.error}
          data={data}
          isEmpty={() => false}
          loadingLabel="正在读取日志摘要…"
          onRetry={() => void detail.refetch()}
        >
          {(log) => {
            const model = modelSummary(log.log);
            return (
              <div className="stack" style={{ gap: 'var(--keeper-section-gap)' }}>
                <section className="keeper-card keeper-card--flush">
                  <div className="keeper-card__header">
                    <div className="keeper-card__heading">
                      <span className="keeper-card__title">摘要（GET /logs/{'{logId}'}）</span>
                      <span className="keeper-card__subtitle">
                        仅摘要；请求/响应正文需你主动展开才会加载，大正文按页/按条查看。
                      </span>
                    </div>
                  </div>
                  <div className="keeper-card__body">
                    <KeyValueList
                      items={[
                        { label: '日志 ID', value: <CopyableText value={log.log.id} /> },
                        { label: '创建时间', value: <TimeText value={log.log.createdAt} withSeconds /> },
                        { label: '状态', value: <Pill tone={statusTone(log.log.status)}>{statusLabel(log.log.status)}</Pill> },
                        {
                          label: '渠道（channelId）',
                          value: log.log.channelId ? <MonoText>{log.log.channelId}</MonoText> : <span className="text-tertiary">未知</span>,
                        },
                        {
                          label: '请求模型（requestedModel）',
                          value: model.requested ? <MonoText>{model.requested}</MonoText> : <span className="text-tertiary">未知</span>,
                          hint: model.changed ? '与最终模型不同：上游发生过路由/别名替换。' : undefined,
                        },
                        {
                          label: '最终模型（finalModel）',
                          value: model.final ? <MonoText>{model.final}</MonoText> : <span className="text-tertiary">未知</span>,
                        },
                        {
                          label: 'API Key（apiKeyName）',
                          value: log.log.apiKeyName ? <MonoText>{log.log.apiKeyName}</MonoText> : <span className="text-tertiary">未提供</span>,
                        },
                        {
                          label: '协议 / 传输',
                          value: (
                            <span className="row" style={{ gap: 6 }}>
                              {log.log.protocol ? <Pill mono>{log.log.protocol}</Pill> : <span className="text-tertiary">未知</span>}
                              {log.log.transport ? <Pill mono tone="muted">{log.log.transport}</Pill> : null}
                            </span>
                          ),
                        },
                        { label: '耗时（durationMilliseconds）', value: formatDuration(log.log.durationMilliseconds) },
                        { label: '重试次数（retryCount）', value: formatCount(log.log.retryCount) },
                        {
                          label: 'Tokens（输入 / 输出）',
                          value: `${formatCount(log.log.inputTokens)} / ${formatCount(log.log.outputTokens)}`,
                        },
                        {
                          label: '成本（costTicks）',
                          value: formatCount(log.log.costTicks),
                          hint: COST_TICKS_HINT,
                        },
                        {
                          label: '计费明细（billing，ticks）',
                          value: (
                            <span className="text-sm">
                              costTicks {formatCount(log.log.billing.costTicks)} · actual {formatCount(log.log.billing.actualCostTicks)} ·
                              estimated {formatCount(log.log.billing.estimatedCostTicks)} · 未定价成功 {formatCount(log.log.billing.unpricedSuccess)}
                            </span>
                          ),
                          hint: COST_TICKS_HINT,
                        },
                        {
                          label: '错误（error）',
                          value: log.log.error ? <span className="text-danger">{log.log.error}</span> : <span className="text-tertiary">无</span>,
                        },
                        { label: 'revision', value: <MonoText>{log.revision}</MonoText> },
                      ]}
                      columns={2}
                    />
                  </div>
                </section>

                <section className="keeper-card keeper-card--flush">
                  <div className="keeper-card__header">
                    <div className="keeper-card__heading">
                      <span className="keeper-card__title">上游可用性标记</span>
                      <span className="keeper-card__subtitle">
                        由上游摘要决定是否提供正文；WebUI 不会假装正文可用，也不推测未提供的内容。
                      </span>
                    </div>
                  </div>
                  <div className="keeper-card__body stack" style={{ gap: 8 }}>
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <Pill tone={log.requestBodyAvailable ? 'success' : 'muted'}>
                        请求正文 requestBodyAvailable = {String(log.requestBodyAvailable)}
                      </Pill>
                      <Pill tone={log.responseBodyAvailable ? 'success' : 'muted'}>
                        响应正文 responseBodyAvailable = {String(log.responseBodyAvailable)}
                      </Pill>
                      <Pill tone={log.requestHeadersAvailable ? 'success' : 'muted'}>
                        请求头 requestHeadersAvailable = {String(log.requestHeadersAvailable)}
                      </Pill>
                    </div>
                    <span className="text-sm text-secondary">
                      请求头查看接口不在本版本 WebUI 的允许清单内，因此这里只展示标记，不提供请求头内容。
                    </span>
                  </div>
                </section>

                <section className="keeper-card keeper-card--flush">
                  <div className="keeper-card__header">
                    <div className="keeper-card__heading">
                      <span className="keeper-card__title">正文（按需加载）</span>
                      <span className="keeper-card__subtitle">
                        默认不请求；展开后按页查看条目，单条内容按条请求。命中体积上限时会明确提示"未完整展示"。
                      </span>
                    </div>
                  </div>
                  <div className="keeper-card__body">
                    <Tabs
                      items={[
                        {
                          key: 'request',
                          label: '请求正文',
                          children: (
                            <LogBodySection
                              logId={log.log.id}
                              kind="request"
                              available={log.requestBodyAvailable}
                              capability={bodyCapability}
                            />
                          ),
                        },
                        {
                          key: 'response',
                          label: '响应正文',
                          children: (
                            <LogBodySection
                              logId={log.log.id}
                              kind="response"
                              available={log.responseBodyAvailable}
                              capability={bodyCapability}
                            />
                          ),
                        },
                      ]}
                    />
                  </div>
                </section>

                <section className="keeper-card keeper-card--flush">
                  <div className="keeper-card__header">
                    <div className="keeper-card__heading">
                      <span className="keeper-card__title">执行记录（受控 JSON）</span>
                      <span className="keeper-card__subtitle">
                        attempts / billingAttempts / stages / localWebRounds 的原始结构按文本展示，不解析为 HTML。
                      </span>
                    </div>
                  </div>
                  <div className="keeper-card__body">
                    <Collapse
                      items={[
                        {
                          key: 'stages',
                          label: `stages（${log.stages.length} 项）`,
                          children: <JsonBlock value={log.stages} maxHeight={260} />,
                        },
                        {
                          key: 'attempts',
                          label: `attempts（${log.attempts.length} 项）`,
                          children: <JsonBlock value={log.attempts} maxHeight={260} />,
                        },
                        {
                          key: 'billingAttempts',
                          label: `billingAttempts（${log.billingAttempts.length} 项）`,
                          children: <JsonBlock value={log.billingAttempts} maxHeight={260} />,
                        },
                        {
                          key: 'localWebRounds',
                          label: `localWebRounds（${log.localWebRounds.length} 项）`,
                          children: <JsonBlock value={log.localWebRounds} maxHeight={260} />,
                        },
                      ]}
                    />
                  </div>
                </section>
              </div>
            );
          }}
        </AsyncState>
      </div>
    </Drawer>
  );
}
