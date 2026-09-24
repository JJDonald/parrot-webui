/**
 * 渠道兼容性配置区块（GET / PATCH `/channels/{channelId}/compatibility`）。
 *
 * 事实约束：
 * - `ChannelCompatibilityData` 有**自己的** revision，与渠道 revision 不是同一个值；
 *   PATCH 的 If-Match 必须回传兼容性资源读到的 revision（实施文档 7.2）。
 * - 该区块包含重数据，默认不读取；用户点击后才发起 GET，且不做自动轮询。
 * - 409 REVISION_CONFLICT 时不自动覆盖：保留用户已选内容，由用户显式选择是否采用服务端最新版本。
 */

import { useEffect, useState } from 'react';
import { Select } from 'antd';
import { ApiError } from '@/api/client';
import { UPSTREAM_CODE } from '@/api/error-codes';
import { ConflictNotice, ErrorNotice } from '@/components/feedback';
import { Pill } from '@/components/bits';
import { useChannelCompatibility, useUpdateChannelCompatibility } from './channelsApi';
import { COMPATIBILITY_MODE_LABEL } from './channelLabels';
import { ChannelNoticeBox, type ChannelNotice } from './ChannelNotice';
import type { ChannelCompatibilityData, CompatibilityMode } from './upstream-types';
import styles from './ChannelsPage.module.scss';

interface FeatureDraft {
  mode: CompatibilityMode;
  models: string[];
}

interface CompatibilityDraft {
  context1m: FeatureDraft;
  fast: FeatureDraft;
}

function toDraft(data: ChannelCompatibilityData): CompatibilityDraft {
  return {
    context1m: { mode: data.context1m.mode, models: [...data.context1m.models] },
    fast: { mode: data.fast.mode, models: [...data.fast.models] },
  };
}

const MODE_OPTIONS: Array<{ value: CompatibilityMode; label: string }> = [
  { value: 'auto', label: COMPATIBILITY_MODE_LABEL.auto },
  { value: 'force', label: COMPATIBILITY_MODE_LABEL.force },
];

export interface ChannelCompatibilitySectionProps {
  channelId: string;
  canWrite: boolean;
  writeBlockReason: string | null;
}

/**
 * 兼容性区块。换渠道时请通过 `key={channelId}` 重新挂载，避免把上一个渠道的草稿带过来。
 */
export function ChannelCompatibilitySection({ channelId, canWrite, writeBlockReason }: ChannelCompatibilitySectionProps) {
  const [loaded, setLoaded] = useState(false);
  const query = useChannelCompatibility(channelId, loaded);
  const update = useUpdateChannelCompatibility();

  const [draft, setDraft] = useState<CompatibilityDraft | null>(null);
  const [baseRevision, setBaseRevision] = useState<string | null>(null);
  const [notice, setNotice] = useState<ChannelNotice | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [conflict, setConflict] = useState(false);

  const data = query.data?.data ?? null;

  useEffect(() => {
    // 只做首次填充：冲突后刷新不得覆盖用户已经选好的内容。
    if (data && draft === null) {
      setDraft(toDraft(data));
      setBaseRevision(data.revision);
    }
  }, [data, draft]);

  const latestRevision = data?.revision ?? null;

  const patchFeature = (key: 'context1m' | 'fast', next: Partial<FeatureDraft>) => {
    setDraft((previous) => {
      if (!previous) return previous;
      if (key === 'context1m') return { ...previous, context1m: { ...previous.context1m, ...next } };
      return { ...previous, fast: { ...previous.fast, ...next } };
    });
  };

  const submit = async () => {
    if (!draft || !baseRevision) return;
    setActionError(null);
    setNotice(null);
    setConflict(false);
    try {
      const response = await update.mutateAsync({
        channelId,
        body: {
          context1m: { mode: draft.context1m.mode, models: draft.context1m.models },
          fast: { mode: draft.fast.mode, models: draft.fast.models },
        },
        ifMatch: baseRevision,
      });
      const saved = response.data;
      if (saved) {
        setBaseRevision(saved.revision);
        setDraft(toDraft(saved));
      }
      setNotice({
        tone: 'success',
        text: `兼容性配置已保存（HTTP ${response.status}）；服务端返回的新 revision：${saved?.revision ?? '未知'}。`,
      });
    } catch (caught) {
      const apiError = caught instanceof ApiError ? caught : null;
      if (apiError?.code === UPSTREAM_CODE.REVISION_CONFLICT) {
        setConflict(true);
        void query.refetch();
        return;
      }
      setActionError(apiError);
    }
  };

  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>
        <span>兼容性配置</span>
        <span className={styles.sectionHint}>
          上游字段 compatibility.context1m / compatibility.fast（GET·PATCH /channels/&#123;channelId&#125;/compatibility）
        </span>
      </h3>

      {!loaded ? (
        <div className="row row--between">
          <span className="text-sm text-secondary">
            该区块包含重数据，默认不读取；需要时手动加载，且不会自动轮询。
          </span>
          <button type="button" className="btn btn--sm btn--secondary" onClick={() => setLoaded(true)}>
            读取兼容性配置
          </button>
        </div>
      ) : null}

      {loaded && query.isLoading && !data ? <span className="text-sm text-secondary">读取中…</span> : null}

      {loaded && query.error && !data ? (
        <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />
      ) : null}

      {notice ? <ChannelNoticeBox notice={notice} /> : null}
      {actionError ? <ErrorNotice error={actionError} /> : null}
      {conflict ? (
        <ConflictNotice
          currentRevision={latestRevision}
          onReload={() => {
            setConflict(false);
            void query.refetch();
          }}
          message="兼容性配置已被其他管理端修改（REVISION_CONFLICT）：你选择的内容仍然保留，不会被自动覆盖。"
        />
      ) : null}

      {data && draft ? (
        <div className="stack" style={{ gap: 12 }}>
          <div className="row" style={{ gap: 8 }}>
            <Pill mono title="兼容性资源自己的 revision，PATCH 时作为 If-Match 回传">
              读取时 revision：{baseRevision ?? '未知'}
            </Pill>
            {latestRevision && latestRevision !== baseRevision ? (
              <Pill tone="warning" mono>
                服务端最新 revision：{latestRevision}
              </Pill>
            ) : null}
            {latestRevision && latestRevision !== baseRevision ? (
              <button
                type="button"
                className="btn btn--sm btn--secondary"
                disabled={!canWrite}
                title={canWrite ? undefined : writeBlockReason ?? '当前会话不可写'}
                onClick={() => {
                  // 显式采用服务端最新版本：由用户点击触发，不静默覆盖、不自动重新提交。
                  setBaseRevision(latestRevision);
                  setConflict(false);
                  setNotice({
                    tone: 'warning',
                    text: '已采用服务端最新 revision；请确认下方内容后再次点击保存。',
                  });
                }}
              >
                采用最新 revision（保留已选内容）
              </button>
            ) : null}
          </div>

          {(['context1m', 'fast'] as const).map((featureKey) => {
            const feature = draft[featureKey];
            const upstreamFeature = data[featureKey];
            return (
              <div key={featureKey} className={styles.fieldGrid}>
                <label className="field">
                  <span className="field__label">{featureKey === 'context1m' ? 'context1m 模式' : 'fast 模式'}</span>
                  <Select<CompatibilityMode>
                    value={feature.mode}
                    options={MODE_OPTIONS}
                    disabled={!canWrite}
                    aria-label={`${featureKey} 兼容性模式`}
                    onChange={(value) => patchFeature(featureKey, { mode: value })}
                  />
                  <span className="field__hint">
                    上游判定 allModels：{upstreamFeature.allModels ? '适用于全部模型' : '仅限指定模型'}
                  </span>
                </label>
                <label className="field">
                  <span className="field__label">{featureKey === 'context1m' ? 'context1m 模型' : 'fast 模型'}</span>
                  <Select
                    mode="tags"
                    value={feature.models}
                    disabled={!canWrite}
                    placeholder="输入模型 ID 后回车；留空表示不指定"
                    aria-label={`${featureKey} 兼容性模型列表`}
                    onChange={(values: string[]) => patchFeature(featureKey, { models: values })}
                    options={feature.models.map((model) => ({ value: model, label: model }))}
                  />
                  <span className="field__hint">对应上游 compatibility.{featureKey}.models，最多 2000 项。</span>
                </label>
              </div>
            );
          })}

          <div className={styles.formActions}>
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={!canWrite || update.isPending || !baseRevision}
              onClick={() => void submit()}
            >
              {update.isPending ? '保存中…' : '保存兼容性配置'}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--secondary"
              disabled={!canWrite || update.isPending}
              onClick={() => void query.refetch()}
            >
              重新读取
            </button>
            {!canWrite ? <span className="text-sm text-secondary">{writeBlockReason ?? '当前会话不可写'}</span> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
