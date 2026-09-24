/**
 * 渠道详情抽屉：详情、编辑、启停、诊断、模型发现、刷新用量、清除错误/亲和、兼容性、删除。
 *
 * 契约要点：
 * - 详情读取 `GET /channels/{channelId}`（含月度统计与运行时模型数据，不自动轮询）。
 * - 编辑走 `PATCH /channels/{channelId}` 且必须带 `If-Match: 读到的 revision 原样值`；
 *   409 REVISION_CONFLICT 不自动覆盖，保留用户已填的非秘密内容。
 * - 既有渠道诊断 `POST /channels/{channelId}/diagnostic-probes` 与新渠道草稿诊断
 *   `POST /channel-drafts/probes` 是两个副作用不同的动作，这里只做前者（草稿诊断在新增弹窗里）。
 * - 秘密字段：只显示"已设置/未设置"与上游掩码提示；重新填写才会发送，空输入不等于清除。
 * - 202 只登记任务（useOperations().track），不在本组件里轮询，也不报告成功。
 */

import { useMemo, useState, type ReactNode } from 'react';
import { AutoComplete, Drawer, Select, Switch, Table, type TableColumnsType } from 'antd';
import { ApiError, type ManagementResponse } from '@/api/client';
import { UPSTREAM_CODE } from '@/api/error-codes';
import { useFieldErrorMap } from '@/api/hooks';
import { useOperations } from '@/api/operations';
import {
  DangerConfirmButton,
  JsonBlock,
  KeyValueList,
  MonoText,
  Pill,
  RelativeTime,
  TimeText,
} from '@/components/bits';
import { ConflictNotice, ErrorNotice } from '@/components/feedback';
import { AsyncState, EmptyState } from '@/components/state';
import {
  acceptedOperation,
  readActionResult,
  useChannelDetail,
  useClearChannelAffinity,
  useClearChannelErrors,
  useDeleteChannel,
  useDiscoverChannelModels,
  useProbeChannel,
  useRefreshChannelUsage,
  useUpdateChannel,
} from './channelsApi';
import {
  COMPATIBILITY_MODE_LABEL,
  COOLDOWN_KIND_LABEL,
  countText,
  HEALTH_LABEL,
  healthTone,
  PROTOCOL_LABEL,
  PROTOCOL_OPTIONS,
  rawNumberText,
} from './channelLabels';
import {
  buildChannelPatch,
  fieldMessage,
  hasChanges,
  summarizeFieldErrors,
  toEditDraft,
  type ChannelEditDraft,
} from './channelForm';
import { ChannelCompatibilitySection } from './ChannelCompatibilitySection';
import { ChannelModelTextarea } from './ChannelModelTextarea';
import {
  ChannelNoticeBox,
  acceptedOperationNotice,
  unexpectedSyncResultNotice,
  type ChannelNotice,
} from './ChannelNotice';
import type {
  ChannelDetailData,
  ChannelModelStatsData,
  ChannelRuntimeModelData,
  ManagementOperationData,
} from './upstream-types';
import styles from './ChannelsPage.module.scss';

interface FormSession {
  channelId: string;
  draft: ChannelEditDraft;
  baseline: ChannelEditDraft;
  /** 进入编辑时读到的渠道 revision，PATCH 时原样作为 If-Match。 */
  revision: string;
}

export interface ChannelDetailDrawerProps {
  /** 需要展示的渠道；null 表示关闭。换渠道时本组件由外层用 key 重新挂载。 */
  channelId: string | null;
  canWrite: boolean;
  writeBlockReason: string | null;
  onClose: () => void;
  onNotice: (notice: ChannelNotice) => void;
  onDeleted: (input: { channelId: string; name: string }) => void;
}

function DetailSection({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>
        <span>{title}</span>
        {hint ? <span className={styles.sectionHint}>{hint}</span> : null}
      </h3>
      {children}
    </section>
  );
}

function MetricItem({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className={styles.metricItem}>
      <span className={styles.metricItem__label}>{label}</span>
      <span className={styles.metricItem__value}>{value}</span>
      {hint ? <span className={styles.metricItem__hint}>{hint}</span> : null}
    </div>
  );
}

const RUNTIME_MODEL_COLUMNS: TableColumnsType<ChannelRuntimeModelData> = [
  {
    title: '别名 / 真实模型',
    key: 'model',
    render: (_, row) => (
      <div className={styles.nameCell}>
        <span className="mono">{row.alias}</span>
        <span className="mono text-tertiary text-sm">{row.real}</span>
      </div>
    ),
  },
  {
    title: '冷却',
    key: 'cooldown',
    render: (_, row) =>
      row.cooldownKind ? (
        <div className={styles.nameCell}>
          <Pill tone={row.cooldownKind === 'temporary' ? 'warning' : 'danger'}>
            {COOLDOWN_KIND_LABEL[row.cooldownKind]}
          </Pill>
          <span className="text-sm text-secondary">
            至 <TimeText value={row.cooldownUntil} />
          </span>
        </div>
      ) : (
        <Pill tone="muted">无冷却</Pill>
      ),
  },
  { title: '错误数', dataIndex: 'errorCount', key: 'errorCount', align: 'right' },
  { title: '近期请求', dataIndex: 'recentRequests', key: 'recentRequests', align: 'right' },
  {
    title: '近期成功率（上游原值）',
    key: 'recentSuccessRate',
    align: 'right',
    render: (_, row) => rawNumberText(row.recentSuccessRate),
  },
  {
    title: '平均首字节 (ms)',
    key: 'firstByte',
    align: 'right',
    render: (_, row) => rawNumberText(row.averageFirstByteMilliseconds, 1),
  },
];

const MODEL_STATS_COLUMNS: TableColumnsType<ChannelModelStatsData> = [
  { title: '模型', dataIndex: 'finalModel', key: 'finalModel', render: (value: string) => <span className="mono">{value}</span> },
  { title: '总请求', dataIndex: 'total', key: 'total', align: 'right' },
  { title: '成功', dataIndex: 'successCount', key: 'successCount', align: 'right' },
  { title: '错误', dataIndex: 'errorCount', key: 'errorCount', align: 'right' },
  { title: '输入 tokens', dataIndex: 'inputTokens', key: 'inputTokens', align: 'right' },
  { title: '输出 tokens', dataIndex: 'outputTokens', key: 'outputTokens', align: 'right' },
];

export function ChannelDetailDrawer({
  channelId,
  canWrite,
  writeBlockReason,
  onClose,
  onNotice,
  onDeleted,
}: ChannelDetailDrawerProps) {
  const { track } = useOperations();
  const detail = useChannelDetail(channelId);

  const probe = useProbeChannel();
  const discovery = useDiscoverChannelModels();
  const refreshUsage = useRefreshChannelUsage();
  const clearErrors = useClearChannelErrors();
  const clearAffinity = useClearChannelAffinity();
  const update = useUpdateChannel();
  const remove = useDeleteChannel();

  const [notice, setNotice] = useState<ChannelNotice | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [probeModel, setProbeModel] = useState('');
  const [formSession, setFormSession] = useState<FormSession | null>(null);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [saveConflict, setSaveConflict] = useState(false);
  const [rawSyncResult, setRawSyncResult] = useState<unknown>(null);

  const saveFieldErrors = useFieldErrorMap(saveError);

  const channel: ChannelDetailData | null = detail.data?.data ?? null;
  const patch = useMemo(
    () => (formSession ? buildChannelPatch(formSession.baseline, formSession.draft) : null),
    [formSession],
  );
  const dirty = formSession ? hasChanges(formSession.baseline, formSession.draft) : false;

  const busy =
    probe.isPending ||
    discovery.isPending ||
    refreshUsage.isPending ||
    clearErrors.isPending ||
    clearAffinity.isPending ||
    update.isPending ||
    remove.isPending;

  const canSubmit = canWrite && !busy && dirty && Boolean(patch) && !patch?.invalid;

  /** 202 类动作：只登记任务，不宣布成功。 */
  const runOperation = async (
    label: string,
    run: () => Promise<ManagementResponse<ManagementOperationData>>,
    channelName: string,
  ) => {
    setNotice(null);
    setActionError(null);
    setRawSyncResult(null);
    try {
      const response = await run();
      const accepted = acceptedOperation(response);
      if (accepted) {
        track({
          operationId: accepted.operationId,
          kind: accepted.kind,
          origin: `渠道${label}：${channelName}`,
          invalidate: [['channels'], ['overview']],
        });
        setNotice(acceptedOperationNotice(label, accepted));
      } else {
        setRawSyncResult({ status: response.status, data: response.data, meta: response.meta });
        setNotice(unexpectedSyncResultNotice(label, response.status));
      }
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught : null);
    }
  };

  /** 同步动作（200 + ActionResultData）：按真实字段展示 affected。 */
  const runSimpleAction = async (label: string, run: () => Promise<ManagementResponse<{ affected: number; queued?: boolean | null }>>) => {
    setNotice(null);
    setActionError(null);
    setRawSyncResult(null);
    try {
      const response = await run();
      const { affected, queued } = readActionResult(response);
      setNotice({
        tone: queued ? 'warning' : 'success',
        text: (
          <>
            {label}：上游返回 HTTP {response.status}，affected={affected === null ? '未知' : affected}
            {queued === true ? (
              <>
                ，且 queued=true（上游未返回可跟踪的任务 ID，请稍后刷新列表确认实际状态）
              </>
            ) : (
              '。'
            )}
          </>
        ),
      });
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught : null);
    }
  };

  const submitEdit = async () => {
    if (!formSession || !patch || patch.invalid) return;
    setSaveError(null);
    setSaveConflict(false);
    setNotice(null);
    try {
      const response = await update.mutateAsync({
        channelId: formSession.channelId,
        body: patch.body,
        ifMatch: formSession.revision,
      });
      const saved = response.data;
      setFormSession(null);
      setNotice({
        tone: 'success',
        text: (
          <>
            渠道已保存（HTTP {response.status}）。服务端返回的新 revision：
            <span className="mono">{saved?.revision ?? '未知'}</span>；列表已失效并会重新读取。
            {patch.notes.length ? `（${patch.notes.join(' ')}）` : ''}
          </>
        ),
      });
    } catch (caught) {
      const apiError = caught instanceof ApiError ? caught : null;
      if (apiError?.code === UPSTREAM_CODE.REVISION_CONFLICT) {
        setSaveConflict(true);
        void detail.refetch();
        return;
      }
      setSaveError(apiError);
    }
  };

  const toggleEnabled = async (nextEnabled: boolean) => {
    if (!channel) return;
    setNotice(null);
    setActionError(null);
    try {
      const response = await update.mutateAsync({
        channelId: channel.id,
        body: { enabled: nextEnabled },
        ifMatch: channel.revision,
      });
      setNotice({
        tone: 'success',
        text: (
          <>
            渠道「{channel.name}」已{nextEnabled ? '启用' : '停用'}（HTTP {response.status}），
            新 revision：<span className="mono">{response.data?.revision ?? '未知'}</span>。
          </>
        ),
      });
    } catch (caught) {
      const apiError = caught instanceof ApiError ? caught : null;
      if (apiError?.code === UPSTREAM_CODE.REVISION_CONFLICT) {
        void detail.refetch();
      }
      setActionError(apiError);
    }
  };

  const latestRevision = channel?.revision ?? null;

  return (
    <Drawer
      open={Boolean(channelId)}
      onClose={onClose}
      width="min(780px, 100vw)"
      destroyOnHidden
      title={
        <div className="stack" style={{ gap: 2 }}>
          <span className="app-topbar__eyebrow">Channel</span>
          <span>{channel ? channel.name : '渠道详情'}</span>
        </div>
      }
    >
      <AsyncState
        isLoading={detail.isLoading}
        error={detail.error}
        data={detail.data}
        isEmpty={() => false}
        loadingLabel="加载渠道详情…"
        onRetry={() => void detail.refetch()}
      >
        {(response) => {
          if (!response) {
            return <div className="error-box" role="alert">上游没有返回可解析的渠道详情响应，请刷新重试。</div>;
          }
          const data = response.data;
          if (!data) {
            return (
              <div className="stack">
                <div className="error-box" role="alert">
                  上游返回了没有 data 字段的成功响应，无法展示渠道详情。以下是原始响应：
                </div>
                <JsonBlock value={response.raw} />
              </div>
            );
          }
          return (
            <div className="stack">
              {!canWrite ? (
                <div className="notice-box notice-box--warning" role="status">
                  当前会话不具备写能力（{writeBlockReason ?? '只读'}）：本页所有写操作按钮已禁用，但读取与诊断类信息仍然可见。
                </div>
              ) : null}

              <div className={styles.noticeArea}>
                {notice ? <ChannelNoticeBox notice={notice} /> : null}
                {actionError ? (
                  <ErrorNotice
                    error={actionError}
                    onResolveConflict={
                      actionError.code === UPSTREAM_CODE.REVISION_CONFLICT
                        ? () => {
                            setActionError(null);
                            void detail.refetch();
                          }
                        : undefined
                    }
                  />
                ) : null}
                {rawSyncResult ? <JsonBlock value={rawSyncResult} maxHeight={200} /> : null}
              </div>

              <div className="row" style={{ gap: 8 }}>
                {data.enabled ? <Pill tone="success">配置：已启用</Pill> : <Pill tone="muted">配置：已停用</Pill>}
                <Pill tone={healthTone(data.health)} title="上游运行时判定（channel.health）">
                  运行时：{HEALTH_LABEL[data.health]}
                </Pill>
                <Pill mono>{PROTOCOL_LABEL[data.protocol]}</Pill>
                {data.cooldownCount > 0 ? <Pill tone="warning">冷却/错误计数 {data.cooldownCount}</Pill> : null}
                <Pill mono title="渠道 revision，写操作作为 If-Match 回传">
                  revision {data.revision}
                </Pill>
              </div>

              <DetailSection title="基本配置" hint="GET /channels/{channelId} 真实字段">
                <KeyValueList
                  items={[
                    { label: '渠道 ID', value: <MonoText>{data.id}</MonoText> },
                    { label: '名称', value: data.name },
                    { label: '协议', value: `${PROTOCOL_LABEL[data.protocol]}（${data.protocol}）` },
                    {
                      label: '供应商 / 预设',
                      value: data.providerId
                        ? `${data.providerId}${data.providerPresetId ? ` / ${data.providerPresetId}` : ''}`
                        : '未使用预设（手动配置）',
                    },
                    { label: '地址（上游 url）', value: <MonoText>{data.url}</MonoText> },
                    { label: 'baseUrl', value: <MonoText>{data.baseUrl}</MonoText> },
                    { label: 'apiPath', value: data.apiPath ? <MonoText>{data.apiPath}</MonoText> : '未设置' },
                    { label: '最大并发', value: countText(data.maxConcurrent) },
                    { label: '模型数（modelCount）', value: countText(data.modelCount) },
                    { label: '亲和计数（affinityCount）', value: countText(data.affinityCount) },
                    { label: '客户端亲和（clientAffinityCount）', value: countText(data.clientAffinityCount) },
                    { label: '冷却/错误计数（cooldownCount）', value: countText(data.cooldownCount) },
                    {
                      label: '最近成功率（上游原值）',
                      value: rawNumberText(data.recentSuccessRate),
                      hint: '上游字段 recentSuccessRate 原值，WebUI 不做百分比换算',
                    },
                    { label: 'CC 伪装（ccMimicry）', value: data.ccMimicry ? '开启' : '关闭' },
                    { label: '省略 temperature', value: data.omitTemperature ? '是' : '否' },
                    { label: '省略 thinking', value: data.omitThinking ? '是' : '否' },
                    {
                      label: '停用原因',
                      value: data.disabledReason ? data.disabledReason : '上游未提供',
                    },
                  ]}
                />
              </DetailSection>

              <DetailSection title="认证" hint="上游只返回是否已设置与掩码提示，不返回明文">
                <div className="row" style={{ gap: 8 }}>
                  {data.apiKeyConfigured ? <Pill tone="success">API Key 已设置</Pill> : <Pill tone="muted">API Key 未设置</Pill>}
                  {data.apiKeyMaskedHint ? <MonoText>{data.apiKeyMaskedHint}</MonoText> : null}
                </div>
                <div className={styles.secretNote}>
                  <span>
                    WebUI 不读取、不缓存、不落盘存储秘密值：详情响应里只有
                    <span className="mono"> apiKeyConfigured / apiKeyMaskedHint</span>。
                  </span>
                  <span>
                    编辑时留空代表<strong>不修改</strong>现有密钥（空输入不等于清除）；只有重新填写才会发送
                    <span className="mono"> apiKey</span> 字段。
                  </span>
                </div>
              </DetailSection>

              <DetailSection
                title="运行时动作"
                hint="202 只代表已受理；这些动作不会在本页轮询，也不自动重做"
              >
                <div className={styles.fieldGrid}>
                  <label className="field">
                    <span className="field__label">诊断用模型（上游字段 model，必填）</span>
                    <AutoComplete
                      value={probeModel}
                      disabled={!canWrite}
                      placeholder="选择或输入模型 ID"
                      aria-label="诊断用模型"
                      options={data.models.map((model) => ({
                        value: model.real,
                        label: `${model.real}（别名 ${model.alias}）`,
                      }))}
                      onChange={(value: string) => setProbeModel(value)}
                    />
                    <span className="field__hint">
                      既有渠道诊断（POST /channels/&#123;channelId&#125;/diagnostic-probes）只做一次同步探测，
                      与新增渠道的草稿诊断是两个不同动作。
                    </span>
                  </label>
                </div>
                <div className={styles.formActions}>
                  <button
                    type="button"
                    className="btn btn--sm btn--secondary"
                    disabled={!canWrite || busy || !probeModel.trim()}
                    title={canWrite ? undefined : writeBlockReason ?? '当前会话不可写'}
                    onClick={() =>
                      void runOperation(
                        '诊断',
                        () => probe.mutateAsync({ channelId: data.id, body: { model: probeModel.trim() } }),
                        data.name,
                      )
                    }
                  >
                    {probe.isPending ? '提交中…' : '发起诊断（异步）'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--secondary"
                    disabled={!canWrite || busy}
                    title={canWrite ? undefined : writeBlockReason ?? '当前会话不可写'}
                    onClick={() =>
                      void runOperation(
                        '模型发现',
                        () => discovery.mutateAsync({ channelId: data.id, source: 'existing' }),
                        data.name,
                      )
                    }
                  >
                    {discovery.isPending ? '提交中…' : '发现模型（异步）'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--secondary"
                    disabled={!canWrite || busy || !data.providerUsage.supported}
                    title={
                      !data.providerUsage.supported
                        ? `上游标记该渠道的供应商用量为不支持（status=${data.providerUsage.status}）`
                        : canWrite
                          ? undefined
                          : writeBlockReason ?? '当前会话不可写'
                    }
                    onClick={() => void runOperation('刷新用量', () => refreshUsage.mutateAsync({ channelId: data.id }), data.name)}
                  >
                    {refreshUsage.isPending ? '提交中…' : '刷新供应商用量（异步）'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--secondary"
                    disabled={!canWrite || busy}
                    title={canWrite ? undefined : writeBlockReason ?? '当前会话不可写'}
                    onClick={() =>
                      void runSimpleAction('清除该渠道错误', () => clearErrors.mutateAsync({ channelId: data.id }))
                    }
                  >
                    {clearErrors.isPending ? '提交中…' : '清除该渠道错误'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--secondary"
                    disabled={!canWrite || busy}
                    title={canWrite ? undefined : writeBlockReason ?? '当前会话不可写'}
                    onClick={() =>
                      void runSimpleAction('清除该渠道客户端亲和', () => clearAffinity.mutateAsync({ channelId: data.id }))
                    }
                  >
                    {clearAffinity.isPending ? '提交中…' : '清除该渠道客户端亲和'}
                  </button>
                </div>
                {!canWrite ? <span className="text-sm text-secondary">{writeBlockReason ?? '当前会话不可写'}</span> : null}
              </DetailSection>

              <DetailSection
                title="运行时模型（runtimeModels）"
                hint="上游实时冷却与延迟数据"
              >
                {data.runtimeModels.length ? (
                  <Table<ChannelRuntimeModelData>
                    size="small"
                    rowKey={(row) => `${row.alias}::${row.real}`}
                    columns={RUNTIME_MODEL_COLUMNS}
                    dataSource={data.runtimeModels}
                    pagination={false}
                    scroll={{ x: 'max-content' }}
                  />
                ) : (
                  <EmptyState title="没有运行时模型记录" description="上游返回的 runtimeModels 为空数组。" />
                )}
              </DetailSection>

              <DetailSection title="本月统计（monthStats）" hint="字段名与上游一致，不做换算">
                <div className={styles.metricGrid}>
                  <MetricItem label="total" value={countText(data.monthStats.total)} />
                  <MetricItem label="successCount" value={countText(data.monthStats.successCount)} />
                  <MetricItem label="errorCount" value={countText(data.monthStats.errorCount)} />
                  <MetricItem label="inputTokens" value={countText(data.monthStats.inputTokens)} />
                  <MetricItem label="outputTokens" value={countText(data.monthStats.outputTokens)} />
                  <MetricItem label="cacheReadTokens" value={countText(data.monthStats.cacheReadTokens)} />
                  <MetricItem label="cacheCreationTokens" value={countText(data.monthStats.cacheCreationTokens)} />
                  <MetricItem
                    label="averageTokensPerSecond"
                    value={rawNumberText(data.monthStats.averageTokensPerSecond, 2)}
                    hint="上游可能为 null"
                  />
                  <MetricItem
                    label="cost"
                    value={data.monthStats.cost ? <MonoText>{data.monthStats.cost}</MonoText> : '未知'}
                    hint="上游字符串字段，WebUI 不做货币换算"
                  />
                </div>
              </DetailSection>

              <DetailSection title="模型统计（modelStats）" hint="按最终模型聚合的上游字段">
                {data.modelStats.length ? (
                  <Table<ChannelModelStatsData>
                    size="small"
                    rowKey={(row) => row.finalModel}
                    columns={MODEL_STATS_COLUMNS}
                    dataSource={data.modelStats}
                    pagination={false}
                    scroll={{ x: 'max-content' }}
                  />
                ) : (
                  <EmptyState title="没有模型统计" description="上游返回的 modelStats 为空数组。" />
                )}
              </DetailSection>

              <DetailSection title="供应商用量（providerUsage）" hint="上游字段原样展示">
                <KeyValueList
                  items={[
                    { label: 'supported', value: data.providerUsage.supported ? '支持' : '不支持' },
                    { label: 'status', value: <MonoText>{data.providerUsage.status}</MonoText> },
                    { label: 'stale', value: data.providerUsage.stale ? '已过期' : '未标记过期' },
                    { label: 'partial', value: data.providerUsage.partial ? '部分数据' : '非部分数据' },
                    { label: 'source', value: data.providerUsage.source ? <MonoText>{data.providerUsage.source}</MonoText> : '上游未提供' },
                    {
                      label: 'fetchedAt',
                      value: <TimeText value={data.providerUsage.fetchedAt} />,
                    },
                    {
                      label: 'error',
                      value: data.providerUsage.error ? (
                        <span className="text-danger">
                          {data.providerUsage.error}（<TimeText value={data.providerUsage.errorAt} />）
                        </span>
                      ) : (
                        '无'
                      ),
                    },
                  ]}
                />
                {data.providerUsage.snapshot ? (
                  <div className="stack" style={{ gap: 8 }}>
                    <span className="text-sm text-secondary">
                      快照 source=<span className="mono">{data.providerUsage.snapshot.source}</span>，version=
                      {data.providerUsage.snapshot.version}，partial={String(data.providerUsage.snapshot.partial)}；
                      快照时间 <RelativeTime value={data.providerUsage.fetchedAt} />
                    </span>
                    {data.providerUsage.snapshot.notices.length ? (
                      <ul className="notice-box" style={{ margin: 0, paddingLeft: 24 }}>
                        {data.providerUsage.snapshot.notices.map((text) => (
                          <li key={text}>{text}</li>
                        ))}
                      </ul>
                    ) : null}
                    <div className={styles.metricGrid}>
                      {[...data.providerUsage.snapshot.balances, ...data.providerUsage.snapshot.windows, ...data.providerUsage.snapshot.counters].map(
                        (metric, index) => (
                          <MetricItem
                            key={`${metric.label}-${index}`}
                            label={metric.kind ? `${metric.label}（${metric.kind}）` : metric.label}
                            value={
                              metric.value ?? metric.remaining ?? metric.used ?? metric.total ?? metric.usedPercent ?? '未知'
                            }
                            hint={
                              <>
                                {metric.unit ? `单位 ${metric.unit} ` : ''}
                                {metric.resetInSeconds === null || metric.resetInSeconds === undefined
                                  ? ''
                                  : `重置 ${metric.resetInSeconds}s `}
                                {metric.resetAt ? <TimeText value={metric.resetAt} /> : null}
                              </>
                            }
                          />
                        ),
                      )}
                    </div>
                  </div>
                ) : (
                  <span className="text-sm text-secondary">上游没有返回用量快照（snapshot 为 null）。</span>
                )}
              </DetailSection>

              <DetailSection title="模型列表" hint="上游字段 models[].alias / models[].real">
                {data.models.length ? (
                  <div className={styles.metricGrid}>
                    {data.models.slice(0, 60).map((model) => (
                      <MetricItem key={`${model.alias}::${model.real}`} label={model.alias} value={<MonoText>{model.real}</MonoText>} />
                    ))}
                  </div>
                ) : (
                  <EmptyState title="没有配置模型" description="上游返回的 models 为空数组。" />
                )}
                {data.models.length > 60 ? (
                  <span className="text-sm text-secondary">
                    仅显示前 60 项；该渠道共 {data.models.length} 个模型，完整数据可通过编辑表单或上游接口查看。
                  </span>
                ) : null}
              </DetailSection>

              <ChannelCompatibilitySection
                key={`compat-${data.id}`}
                channelId={data.id}
                canWrite={canWrite}
                writeBlockReason={writeBlockReason}
              />

              <DetailSection title="编辑渠道" hint="PATCH /channels/{channelId}，带读到的 revision 作为 If-Match">
                {!formSession ? (
                  <div className="row row--between">
                    <span className="text-sm text-secondary">
                      编辑会以上方展示的 revision 提交；如果期间被其他管理端修改，会收到 409 并保留你的输入。
                    </span>
                    <button
                      type="button"
                      className="btn btn--sm btn--secondary"
                      disabled={!canWrite || busy}
                      title={canWrite ? undefined : writeBlockReason ?? '当前会话不可写'}
                      onClick={() => {
                        setSaveError(null);
                        setSaveConflict(false);
                        setNotice(null);
                        const draft = toEditDraft(data);
                        setFormSession({
                          channelId: data.id,
                          draft,
                          baseline: toEditDraft(data),
                          revision: data.revision,
                        });
                      }}
                    >
                      编辑配置
                    </button>
                  </div>
                ) : (
                  <div className="stack" style={{ gap: 12 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <span className="text-sm text-secondary">
                        提交时使用的 If-Match revision：
                        <span className="mono">{formSession.revision}</span>
                      </span>
                      {data.revision !== formSession.revision ? (
                        <Pill tone="warning" mono>
                          服务端当前 revision：{data.revision}
                        </Pill>
                      ) : null}
                    </div>

                    {saveConflict ? (
                      <ConflictNotice
                        currentRevision={latestRevision}
                        message="该渠道已被其他管理端修改（409 REVISION_CONFLICT）：你的非秘密输入已保留，WebUI 不会自动覆盖。"
                        onReload={() => {
                          setSaveConflict(false);
                          void detail.refetch();
                        }}
                      />
                    ) : null}
                    {saveConflict && latestRevision ? (
                      <button
                        type="button"
                        className="btn btn--sm btn--secondary"
                        onClick={() => {
                          // 显式采用服务端 revision 后，仍需要用户自己再次点击保存（不自动重放）。
                          setFormSession((previous) => (previous ? { ...previous, revision: latestRevision } : previous));
                          setSaveConflict(false);
                          setNotice({
                            tone: 'warning',
                            text: '已把 If-Match 更新为服务端最新 revision；请核对下方内容后再次点击保存。',
                          });
                        }}
                      >
                        采用服务端最新 revision（保留已填写内容）
                      </button>
                    ) : null}

                    {patch?.invalid ? <div className="error-box">{patch.invalid}</div> : null}
                    {saveError ? (
                      <ErrorNotice
                        error={saveError}
                        staleNotice={
                          summarizeFieldErrors(saveFieldErrors).length ? (
                            <ul style={{ margin: 0, paddingLeft: 16 }}>
                              {summarizeFieldErrors(saveFieldErrors).map((text) => (
                                <li key={text}>{text}</li>
                              ))}
                            </ul>
                          ) : null
                        }
                      />
                    ) : null}

                    <div className={styles.fieldGrid}>
                      <label className="field">
                        <span className="field__label">名称</span>
                        <input
                          className="input"
                          value={formSession.draft.name}
                          disabled={update.isPending}
                          onChange={(event) =>
                            setFormSession((previous) =>
                              previous ? { ...previous, draft: { ...previous.draft, name: event.target.value } } : previous,
                            )
                          }
                        />
                        {fieldMessage(saveFieldErrors, 'name') ? (
                          <span className={styles.fieldError}>{fieldMessage(saveFieldErrors, 'name')}</span>
                        ) : null}
                      </label>

                      <label className="field">
                        <span className="field__label">协议</span>
                        <Select
                          value={formSession.draft.protocol}
                          options={PROTOCOL_OPTIONS}
                          disabled={update.isPending}
                          aria-label="渠道协议"
                          onChange={(value) =>
                            setFormSession((previous) =>
                              previous ? { ...previous, draft: { ...previous.draft, protocol: value } } : previous,
                            )
                          }
                        />
                      </label>

                      <label className="field">
                        <span className="field__label">baseUrl</span>
                        <input
                          className="input"
                          value={formSession.draft.baseUrl}
                          disabled={update.isPending}
                          onChange={(event) =>
                            setFormSession((previous) =>
                              previous ? { ...previous, draft: { ...previous.draft, baseUrl: event.target.value } } : previous,
                            )
                          }
                        />
                        {fieldMessage(saveFieldErrors, 'baseUrl') ? (
                          <span className={styles.fieldError}>{fieldMessage(saveFieldErrors, 'baseUrl')}</span>
                        ) : null}
                      </label>

                      <label className="field">
                        <span className="field__label">apiPath（留空提交 null）</span>
                        <input
                          className="input"
                          value={formSession.draft.apiPath}
                          disabled={update.isPending}
                          onChange={(event) =>
                            setFormSession((previous) =>
                              previous ? { ...previous, draft: { ...previous.draft, apiPath: event.target.value } } : previous,
                            )
                          }
                        />
                      </label>

                      <label className="field">
                        <span className="field__label">最大并发（maxConcurrent，0–100000；留空＝不修改）</span>
                        <input
                          className="input"
                          inputMode="numeric"
                          value={formSession.draft.maxConcurrent}
                          disabled={update.isPending}
                          onChange={(event) =>
                            setFormSession((previous) =>
                              previous ? { ...previous, draft: { ...previous.draft, maxConcurrent: event.target.value } } : previous,
                            )
                          }
                        />
                        {fieldMessage(saveFieldErrors, 'maxConcurrent') ? (
                          <span className={styles.fieldError}>{fieldMessage(saveFieldErrors, 'maxConcurrent')}</span>
                        ) : null}
                      </label>

                      <label className="field">
                        <span className="field__label">API Key（秘密字段）</span>
                        <input
                          className="input"
                          type="password"
                          autoComplete="new-password"
                          spellCheck={false}
                          value={formSession.draft.apiKey}
                          disabled={update.isPending}
                          placeholder={data.apiKeyConfigured ? '已设置：留空表示不修改' : '未设置：填写后可写入新密钥'}
                          onChange={(event) =>
                            setFormSession((previous) =>
                              previous ? { ...previous, draft: { ...previous.draft, apiKey: event.target.value } } : previous,
                            )
                          }
                        />
                        <span className="field__hint">
                          空输入<strong>不等于</strong>清除：留空时不会发送 apiKey 字段。密钥只在本视图内存中存在。
                        </span>
                        {fieldMessage(saveFieldErrors, 'apiKey') ? (
                          <span className={styles.fieldError}>{fieldMessage(saveFieldErrors, 'apiKey')}</span>
                        ) : null}
                      </label>

                      <ChannelModelTextarea
                        key={`models-${formSession.channelId}`}
                        id="channel-edit-models"
                        initialModels={formSession.draft.models}
                        disabled={update.isPending}
                        error={fieldMessage(saveFieldErrors, 'models')}
                        onChange={(models) =>
                          setFormSession((previous) =>
                            previous ? { ...previous, draft: { ...previous.draft, models } } : previous,
                          )
                        }
                      />

                      <div className={`${styles.fieldWide} row`} style={{ gap: 16 }}>
                        <label className="row" style={{ gap: 8 }}>
                          <span className="field__label">启用（enabled）</span>
                          <Switch
                            checked={formSession.draft.enabled}
                            disabled={update.isPending}
                            aria-label="启用该渠道"
                            onChange={(checked) =>
                              setFormSession((previous) =>
                                previous ? { ...previous, draft: { ...previous.draft, enabled: checked } } : previous,
                              )
                            }
                          />
                        </label>
                        <label className="row" style={{ gap: 8 }}>
                          <span className="field__label">CC 伪装</span>
                          <Switch
                            checked={formSession.draft.ccMimicry}
                            disabled={update.isPending}
                            aria-label="CC 伪装"
                            onChange={(checked) =>
                              setFormSession((previous) =>
                                previous ? { ...previous, draft: { ...previous.draft, ccMimicry: checked } } : previous,
                              )
                            }
                          />
                        </label>
                        <label className="row" style={{ gap: 8 }}>
                          <span className="field__label">省略 temperature</span>
                          <Switch
                            checked={formSession.draft.omitTemperature}
                            disabled={update.isPending}
                            aria-label="省略 temperature"
                            onChange={(checked) =>
                              setFormSession((previous) =>
                                previous ? { ...previous, draft: { ...previous.draft, omitTemperature: checked } } : previous,
                              )
                            }
                          />
                        </label>
                        <label className="row" style={{ gap: 8 }}>
                          <span className="field__label">省略 thinking</span>
                          <Switch
                            checked={formSession.draft.omitThinking}
                            disabled={update.isPending}
                            aria-label="省略 thinking"
                            onChange={(checked) =>
                              setFormSession((previous) =>
                                previous ? { ...previous, draft: { ...previous.draft, omitThinking: checked } } : previous,
                              )
                            }
                          />
                        </label>
                      </div>
                    </div>

                    <div className={styles.formActions}>
                      <button
                        type="button"
                        className="btn btn--sm btn--primary"
                        disabled={!canSubmit}
                        title={canWrite ? undefined : writeBlockReason ?? '当前会话不可写'}
                        onClick={() => void submitEdit()}
                      >
                        {update.isPending ? '保存中…' : '保存修改'}
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm btn--secondary"
                        disabled={update.isPending}
                        onClick={() => {
                          setFormSession(null);
                          setSaveError(null);
                          setSaveConflict(false);
                        }}
                      >
                        取消编辑
                      </button>
                      {!dirty ? <span className="text-sm text-secondary">尚未修改任何字段。</span> : null}
                      {formSession.draft.apiKey ? (
                        <span className="text-sm text-secondary">本次提交会写入新的 API Key（只在本视图内存中）。</span>
                      ) : null}
                    </div>
                  </div>
                )}
              </DetailSection>

              <DetailSection title="启用状态" hint="开关会以上方 revision 立即提交 PATCH">
                <div className="row row--between">
                  <span className="text-sm text-secondary">
                    当前配置状态：{data.enabled ? '已启用' : '已停用'}
                    {data.disabledReason ? `（上游停用原因：${data.disabledReason}）` : ''}
                  </span>
                  <Switch
                    checked={data.enabled}
                    disabled={!canWrite || busy}
                    aria-label="切换渠道启用状态"
                    onChange={(checked) => void toggleEnabled(checked)}
                  />
                </div>
                <span className="text-sm text-secondary">
                  注意：配置启用状态与上方"运行时健康（health）"是两个不同维度；停用不会删除渠道。
                </span>
              </DetailSection>

              <DetailSection title="危险操作" hint="删除前会展示资源名与已知影响">
                <DangerConfirmButton
                  label="删除该渠道"
                  resourceName={data.name}
                  requiresTyping={data.name}
                  pending={remove.isPending}
                  disabled={!canWrite || busy}
                  confirmLabel="确认删除渠道"
                  impact={
                    <div className="stack" style={{ gap: 6 }}>
                      <span>
                        将调用上游 <span className="mono">DELETE /channels/{'{channelId}'}</span> 删除渠道「{data.name}」
                        （id: <span className="mono">{data.id}</span>）。
                      </span>
                      <span>
                        请求会带 <span className="mono">If-Match: {data.revision}</span>；若期间被其他管理端修改，上游会返回
                        409，WebUI 不会覆盖或重试。
                      </span>
                      <span>
                        WebUI 无法确认上游是否同时清理该渠道的历史日志、统计与冷却记录，因此不做级联删除声明，也不会在本页模拟级联。
                      </span>
                    </div>
                  }
                  onConfirm={async () => {
                    setNotice(null);
                    setActionError(null);
                    try {
                      await remove.mutateAsync({ channelId: data.id, ifMatch: data.revision });
                      onNotice({
                        tone: 'success',
                        text: `渠道「${data.name}」已删除（HTTP 204，无响应体）；列表会重新读取上游真实状态。`,
                      });
                      onDeleted({ channelId: data.id, name: data.name });
                    } catch (caught) {
                      const apiError = caught instanceof ApiError ? caught : null;
                      if (apiError?.code === UPSTREAM_CODE.REVISION_CONFLICT) {
                        void detail.refetch();
                      }
                      setActionError(apiError);
                    }
                  }}
                />
                {!canWrite ? <span className="text-sm text-secondary">{writeBlockReason ?? '当前会话不可写'}</span> : null}
              </DetailSection>

              <DetailSection title="上游元信息" hint="排障用">
                <span className="text-sm text-secondary">
                  requestId：{typeof response.meta.requestId === 'string' ? response.meta.requestId : '未提供'}；
                  详情读取时间：<RelativeTime value={detail.dataUpdatedAt ? new Date(detail.dataUpdatedAt).toISOString() : null} />
                </span>
                <span className="text-sm text-secondary">
                  compatibility.mode 概览：context1m=<span className="mono">{COMPATIBILITY_MODE_LABEL[data.compatibility.context1m.mode]}</span>
                  ，fast=<span className="mono">{COMPATIBILITY_MODE_LABEL[data.compatibility.fast.mode]}</span>（兼容性 revision：
                  <span className="mono">{data.compatibility.revision}</span>）
                </span>
              </DetailSection>
            </div>
          );
        }}
      </AsyncState>
    </Drawer>
  );
}
