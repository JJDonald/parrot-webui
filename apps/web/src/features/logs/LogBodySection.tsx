/**
 * 日志正文（请求/响应）区块——本页最核心的懒加载与安全展示逻辑。
 *
 * 接口（全部来自上游契约，见 packages/contracts/generated/upstream-mvp.d.ts）：
 *   GET /logs/{logId}/body?kind=&query=&sort=&itemKind=&page=&pageSize=   -> LogBodyPagedEnvelope
 *   GET /logs/{logId}/body/items/{itemId}?kind=                          -> LogBodyItemData
 *   GET /logs/{logId}/raw-body?kind=                                     -> RawLogBodyData
 *
 * 规则：
 * - 正文默认不加载：只有用户点击「加载正文」/展开某条/加载原始正文时才发请求，且不自动轮询；
 * - 大正文按页查看（page/pageSize，上游上限 200），单条内容按条请求；
 * - 所有内容只经 JsonBlock 以纯文本/受控 JSON 渲染，禁止 dangerouslySetInnerHTML；
 * - 命中体积上限（413 WEBUI_PAYLOAD_TOO_LARGE / 502 WEBUI_RESPONSE_TOO_LARGE）明确提示"未完整展示"。
 */

import { useState } from 'react';
import { Button, Collapse, Input, Pagination, Select } from 'antd';
import type { CollapseProps } from 'antd';
import { encodeSegment } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { JsonBlock, MonoText, Pill } from '@/components/bits';
import { AsyncState } from '@/components/state';
import { BodyErrorNotice, CapabilityNotice, TruncationNotice } from './LogNotices';
import {
  BODY_PAGE_SIZE_OPTIONS,
  BODY_SORT_OPTIONS,
  asDisplayText,
  formatBytes,
  formatCount,
  readBodyMeta,
  type BodySort,
  type LogBodyItemData,
  type LogBodyKind,
  type RawLogBodyData,
} from './logTypes';
import styles from './logs.module.scss';

export interface LogBodySectionProps {
  logId: string;
  kind: LogBodyKind;
  /** 上游摘要里的 requestBodyAvailable / responseBodyAvailable */
  available: boolean;
  capability: { allowed: boolean; reason: string | null };
}

/** 单条内容视图：text（可解析 JSON 时结构化）/ raw（纯文本）/ meta，全部不受信任，只做文本渲染。 */
function BodyItemContentView({ item }: { item: LogBodyItemData }) {
  const textIsEmpty = !item.text || !item.text.length;
  const rawIsEmpty = !item.raw || !item.raw.length;
  const sizedButEmpty = item.size > 0 && textIsEmpty && rawIsEmpty;

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className={`text-sm ${styles.itemMeta}`}>
        <span>
          序号 seq：<MonoText>{formatCount(item.seq)}</MonoText>
        </span>
        <span>
          条目类型 kind：<MonoText>{item.kind || '未知'}</MonoText>
        </span>
        <span>
          标题 title：<MonoText>{item.title || '未提供'}</MonoText>
        </span>
        <span>
          大小 size：<MonoText>{formatBytes(item.size)}</MonoText>
        </span>
        <span>
          revision：<MonoText>{item.revision || '未提供'}</MonoText>
        </span>
      </div>

      {sizedButEmpty ? (
        <TruncationNotice
          title="未完整展示：条目内容为空"
          reason={`上游标记该条目大小为 ${formatBytes(item.size)}，但返回的 text/raw 为空，可能被体积上限截断；这里不假设该条目真的没有内容。`}
        />
      ) : null}

      <div className="field">
        <span className="field__label">文本内容（text，纯文本或受控 JSON）</span>
        <JsonBlock value={asDisplayText(item.text)} maxHeight={300} />
        <span className="field__hint">
          该内容按文本渲染：其中形如 <code>&lt;script&gt;</code> 的片段只会显示为文字，不会被当作 HTML 执行。
        </span>
      </div>

      {rawIsEmpty ? null : (
        <div className="field">
          <span className="field__label">原始内容（raw，纯文本）</span>
          <JsonBlock value={item.raw} maxHeight={300} />
        </div>
      )}

      <div className="field">
        <span className="field__label">元数据（meta，受控 JSON）</span>
        <JsonBlock value={item.meta} maxHeight={200} />
      </div>
    </div>
  );
}

/** 按条懒加载：只有该条被展开时才请求 /body/items/{itemId}。 */
function BodyItemDetail({ logId, kind, item }: { logId: string; kind: LogBodyKind; item: LogBodyItemData }) {
  const itemId = item.id ?? null;
  const detail = useApiQuery<LogBodyItemData>({
    key: ['logs', 'body-item', logId, kind, itemId],
    path: `/logs/${encodeSegment(logId)}/body/items/${encodeSegment(itemId ?? '')}`,
    query: { kind },
    enabled: Boolean(itemId),
    staleTimeMs: 60_000,
  });

  if (!itemId) {
    return (
      <div className="stack" style={{ gap: 10 }}>
        <div className="notice-box" role="status">
          上游未返回该条目的 id（LogBodyItemData.id 可为 null），无法按条请求；以下内容来自列表响应中的该条目，
          可能不是完整内容，因此不作为"完整展示"。
        </div>
        <BodyItemContentView item={item} />
      </div>
    );
  }

  return (
    <AsyncState<LogBodyItemData>
      isLoading={detail.isLoading}
      error={detail.error}
      data={detail.data?.data ?? undefined}
      loadingLabel="正在按条读取内容…"
      onRetry={() => void detail.refetch()}
    >
      {(data) => <BodyItemContentView item={data} />}
    </AsyncState>
  );
}

export function LogBodySection({ logId, kind, available, capability }: LogBodySectionProps) {
  const [bodyRequested, setBodyRequested] = useState(false);
  const [rawRequested, setRawRequested] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(BODY_PAGE_SIZE_OPTIONS[1] ?? 20);
  const [itemKind, setItemKind] = useState<string | undefined>(undefined);
  const [sort, setSort] = useState<BodySort>('original');
  const [queryDraft, setQueryDraft] = useState('');
  const [query, setQuery] = useState('');
  const [activeItems, setActiveItems] = useState<string[]>([]);

  const enabled = capability.allowed && available;

  // 正文列表：只有用户主动请求后才加载，且不设置 refetchInterval（正文不自动轮询）。
  const body = useApiQuery<LogBodyItemData[]>({
    key: ['logs', 'body', logId, kind, { page, pageSize, itemKind, query, sort }],
    path: `/logs/${encodeSegment(logId)}/body`,
    query: { kind, page, pageSize, itemKind, query: query || undefined, sort },
    enabled: enabled && bodyRequested,
    staleTimeMs: 60_000,
  });

  // 原始正文：同样按需，独立于条目列表。
  const raw = useApiQuery<RawLogBodyData>({
    key: ['logs', 'raw-body', logId, kind],
    path: `/logs/${encodeSegment(logId)}/raw-body`,
    query: { kind },
    enabled: enabled && rawRequested,
    staleTimeMs: 60_000,
  });

  const items = body.data?.data ?? [];
  const meta = readBodyMeta(body.data?.meta);
  const total = meta.total;
  const notFullyShown = meta.hasNext === true || (total !== null && items.length < total);

  const collapseItems: CollapseProps['items'] = items.map((item, index) => {
    const key = item.id ?? `seq-${item.seq}-${index}`;
    const open = activeItems.includes(key);
    return {
      key,
      label: (
        <span className={styles.itemHeader}>
          <MonoText>#{formatCount(item.seq)}</MonoText>
          <Pill tone="muted" mono>
            {item.kind || '未知类型'}
          </Pill>
          <span className={styles.itemHeader__title}>{item.title || '（无标题）'}</span>
          {item.summary ? <span className={`text-sm ${styles.itemHeader__summary}`}>{item.summary}</span> : null}
          <span className="text-sm text-tertiary">大小 {formatBytes(item.size)}</span>
        </span>
      ),
      children: open ? (
        <BodyItemDetail logId={logId} kind={kind} item={item} />
      ) : (
        <span className="text-sm text-tertiary">展开后才会按条读取完整内容（GET /logs/…/body/items/…）。</span>
      ),
    };
  });

  if (!capability.allowed) {
    return <CapabilityNotice reason={capability.reason ?? ''} />;
  }

  if (!available) {
    return (
      <div className="notice-box" role="status">
        <div className="stack" style={{ gap: 4 }}>
          <strong>上游标记该正文不可用</strong>
          <span>
            该日志{kind === 'request' ? '请求' : '响应'}正文在摘要中标记为不可用（
            {kind === 'request' ? 'requestBodyAvailable' : 'responseBodyAvailable'} = false），
            因此本页不提供加载入口，也不推测内容。
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 12 }}>
      {!bodyRequested ? (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Button type="primary" onClick={() => setBodyRequested(true)}>
              加载{kind === 'request' ? '请求' : '响应'}正文（默认不加载）
            </Button>
            <span className="text-sm text-secondary">
              主动展开才会请求 GET /logs/{'{logId}'}/body；大正文按页查看，单条按需加载。
            </span>
          </div>
        </div>
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          <div className={styles.bodyToolbar}>
            <div className="field">
              <span className="field__label">条目类型（itemKind）</span>
              <Select
                aria-label="条目类型"
                allowClear
                placeholder="全部类型"
                value={itemKind}
                options={meta.kindCounts.map((entry) => ({ value: entry.kind, label: `${entry.kind}（${entry.count}）` }))}
                onChange={(next) => {
                  setItemKind(next ?? undefined);
                  setPage(1);
                }}
              />
            </div>
            <div className="field">
              <span className="field__label">排序（sort）</span>
              <Select
                aria-label="正文排序"
                value={sort}
                options={BODY_SORT_OPTIONS}
                onChange={(next) => {
                  setSort(next as BodySort);
                  setPage(1);
                }}
              />
            </div>
            <div className="field">
              <span className="field__label">条目内搜索（query，≤256 字符）</span>
              <Input
                aria-label="条目内搜索"
                allowClear
                maxLength={256}
                placeholder="按上游 query 参数过滤条目"
                value={queryDraft}
                onChange={(event) => setQueryDraft(event.target.value)}
                onPressEnter={() => {
                  setQuery(queryDraft);
                  setPage(1);
                }}
              />
            </div>
            <div className="field">
              <span className="field__label">每页条目数（pageSize，≤200）</span>
              <Select
                aria-label="每页条目数"
                value={pageSize}
                options={BODY_PAGE_SIZE_OPTIONS.map((size) => ({ value: size, label: `${size} 条` }))}
                onChange={(next) => {
                  setPageSize(next);
                  setPage(1);
                }}
              />
            </div>
            <div className="row" style={{ gap: 8 }}>
              <Button onClick={() => void body.refetch()}>刷新本页</Button>
            </div>
          </div>

          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Pill mono>kind={kind}</Pill>
            <span className="text-sm text-secondary">
              共 {total === null ? '未知' : formatCount(total)} 条 · 第 {meta.page ?? page} 页 · 每页{' '}
              {meta.pageSize ?? pageSize} 条
              {meta.hasNext === true ? ' · 还有下一页' : meta.hasNext === false ? ' · 已到最后一页' : ''}
            </span>
          </div>

          {notFullyShown ? (
            <TruncationNotice
              title="未完整展示"
              reason={`当前只返回了第 ${meta.page ?? page} 页的 ${items.length} 条，共 ${
                total === null ? '未知' : formatCount(total)
              } 条。整份正文未在此页展示，请翻页或按条目查看。`}
            />
          ) : null}

          {body.error && !body.data ? (
            <BodyErrorNotice error={body.error} onRetry={() => void body.refetch()} />
          ) : (
            <AsyncState<LogBodyItemData[]>
              isLoading={body.isLoading}
              error={body.error}
              data={body.data?.data ?? undefined}
              isEmpty={(data) => data.length === 0}
              emptyTitle="该正文没有可展示的条目"
              emptyDescription="上游返回 0 条。空结果不代表正文被截断，但也不代表请求没有内容。"
              loadingLabel="正在读取正文条目…"
              onRetry={() => void body.refetch()}
            >
              {(data) => (
                <div className="stack" style={{ gap: 12 }}>
                  <Collapse
                    items={collapseItems}
                    activeKey={activeItems}
                    onChange={(keys) =>
                      setActiveItems(Array.isArray(keys) ? keys.map((key) => String(key)) : [String(keys)])
                    }
                    destroyInactivePanel
                  />
                  <div className={styles.pager}>
                    {total === null ? (
                      <div className="row" style={{ gap: 8 }}>
                        <span className="text-sm text-tertiary">上游未返回总数，仅支持逐页前后翻页。</span>
                        <Button disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
                          上一页
                        </Button>
                        <Button disabled={meta.hasNext !== true} onClick={() => setPage((current) => current + 1)}>
                          下一页
                        </Button>
                      </div>
                    ) : (
                      <Pagination
                        current={page}
                        pageSize={pageSize}
                        total={total}
                        showSizeChanger={false}
                        onChange={(next) => setPage(next)}
                      />
                    )}
                    <span className="text-sm text-tertiary">当前页 {data.length} 条</span>
                  </div>
                </div>
              )}
            </AsyncState>
          )}
        </div>
      )}

      <div className={styles.subsection}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {!rawRequested ? (
            <Button onClick={() => setRawRequested(true)}>加载原始正文（raw-body，可能含敏感字段）</Button>
          ) : (
            <Button onClick={() => void raw.refetch()}>刷新原始正文</Button>
          )}
          <span className="text-sm text-secondary">
            原始正文按受控 JSON/纯文本展示：不执行其中的 HTML 或脚本，也不做自动全量导出。
          </span>
        </div>

        {rawRequested ? (
          <div className="stack" style={{ gap: 10 }}>
            {raw.error ? (
              <BodyErrorNotice error={raw.error} onRetry={() => void raw.refetch()} />
            ) : (
              <AsyncState<RawLogBodyData>
                isLoading={raw.isLoading}
                error={raw.error}
                data={raw.data?.data ?? undefined}
                isEmpty={() => false}
                loadingLabel="正在读取原始正文…"
              >
                {(data) => (
                  <div className="stack" style={{ gap: 10 }}>
                    <div className={`text-sm ${styles.itemMeta}`}>
                      <span>
                        kind：<MonoText>{data.kind}</MonoText>
                      </span>
                      <span>
                        logId：<MonoText>{data.logId}</MonoText>
                      </span>
                      <span>
                        revision：<MonoText>{data.revision}</MonoText>
                      </span>
                    </div>
                    <div className="notice-box" role="note">
                      原始正文由上游原样返回，可能包含 Authorization、API Key、提示词等敏感字段；
                      WebUI 不保证上游已全部脱敏，请谨慎查看与转发。
                    </div>
                    <div className="field">
                      <span className="field__label">body（受控 JSON / 纯文本）</span>
                      <JsonBlock value={data.body} maxHeight={420} />
                    </div>
                  </div>
                )}
              </AsyncState>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
