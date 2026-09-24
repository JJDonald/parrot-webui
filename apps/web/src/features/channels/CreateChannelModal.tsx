/**
 * 新增渠道弹窗：`GET /channel-catalog` 目录 → `POST /channels`。
 *
 * 关键区分（实施文档 6.4）：
 * - 新渠道草稿诊断 `POST /channel-drafts/probes`（202）与**既有渠道**诊断
 *   `POST /channels/{channelId}/diagnostic-probes` 是副作用不同的两个动作，只在本弹窗使用前者。
 * - 新渠道模型发现同样走 `POST /channel-model-discoveries` 的 `source: "draft"` 形态（202）。
 * - 202 只登记任务（useOperations().track），不提示成功。
 *
 * 秘密处理：apiKey 只存在于本弹窗内存；提交或关闭后即清除，不写入任何持久化存储。
 */

import { useMemo, useState } from 'react';
import { AutoComplete, Modal, Segmented, Select, Switch } from 'antd';
import { ApiError, type ManagementResponse } from '@/api/client';
import { useFieldErrorMap } from '@/api/hooks';
import { useOperations } from '@/api/operations';
import { JsonBlock, Pill } from '@/components/bits';
import { ErrorNotice } from '@/components/feedback';
import {
  acceptedOperation,
  newIdempotencyKey,
  useCreateChannel,
  useDiscoverChannelModels,
  useProbeChannelDraft,
} from './channelsApi';
import { PROTOCOL_LABEL } from './channelLabels';
import { fieldMessage, parseMaxConcurrent, summarizeFieldErrors } from './channelForm';
import { ChannelModelTextarea } from './ChannelModelTextarea';
import {
  ChannelNoticeBox,
  acceptedOperationNotice,
  unexpectedSyncResultNotice,
  type ChannelNotice,
} from './ChannelNotice';
import type {
  ChannelCatalogData,
  ChannelModelInput,
  ChannelProtocol,
  ManualChannelCreateRequest,
  ManagementOperationData,
  PresetChannelCreateRequest,
} from './upstream-types';
import styles from './ChannelsPage.module.scss';

type CreateMode = 'manual' | 'preset';

export interface CreateChannelModalProps {
  open: boolean;
  canWrite: boolean;
  writeBlockReason: string | null;
  catalog: ChannelCatalogData | null;
  catalogLoading: boolean;
  catalogError: ApiError | null;
  onRetryCatalog: () => void;
  onClose: () => void;
  onCreated: (channel: { id: string; name: string }) => void;
}

const ALL_PROTOCOLS: ChannelProtocol[] = ['anthropic', 'openai-chat', 'openai-responses'];

export function CreateChannelModal({
  open,
  canWrite,
  writeBlockReason,
  catalog,
  catalogLoading,
  catalogError,
  onRetryCatalog,
  onClose,
  onCreated,
}: CreateChannelModalProps) {
  const { track } = useOperations();
  const create = useCreateChannel();
  const draftProbe = useProbeChannelDraft();
  const discovery = useDiscoverChannelModels();

  const [mode, setMode] = useState<CreateMode>('manual');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiPath, setApiPath] = useState('');
  const [protocol, setProtocol] = useState<ChannelProtocol>('anthropic');
  const [providerId, setProviderId] = useState<string | null>(null);
  const [providerPresetId, setProviderPresetId] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<ChannelModelInput[]>([]);
  const [modelsVersion, setModelsVersion] = useState(0);
  const [draftModel, setDraftModel] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [maxConcurrent, setMaxConcurrent] = useState('');
  const [ccMimicry, setCcMimicry] = useState(false);
  const [omitTemperature, setOmitTemperature] = useState(false);
  const [omitThinking, setOmitThinking] = useState(false);

  const [localError, setLocalError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ChannelNotice | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [createError, setCreateError] = useState<ApiError | null>(null);
  const [rawSyncResult, setRawSyncResult] = useState<unknown>(null);

  const createFieldErrors = useFieldErrorMap(createError);

  const provider = useMemo(
    () => catalog?.providers.find((item) => item.id === providerId) ?? null,
    [catalog, providerId],
  );
  const preset = useMemo(
    () => provider?.presets.find((item) => item.id === providerPresetId) ?? null,
    [provider, providerPresetId],
  );

  const manualProtocolOptions = useMemo(() => {
    const values = catalog?.protocols?.length ? catalog.protocols : ALL_PROTOCOLS;
    return values.map((value) => ({ value, label: `${PROTOCOL_LABEL[value]}（${value}）` }));
  }, [catalog]);

  const presetProtocolOptions = useMemo(
    () =>
      (preset?.protocols ?? []).map((item) => ({
        value: item.protocol,
        label: `${PROTOCOL_LABEL[item.protocol]}（${item.protocol}）→ ${item.endpoint}`,
      })),
    [preset],
  );

  /** 预设模式下，上游要求的 baseUrl 用目录里该预设声明的端点，而不是 WebUI 编造。 */
  const presetEndpoint = useMemo(
    () => preset?.protocols.find((item) => item.protocol === protocol)?.endpoint ?? null,
    [preset, protocol],
  );

  const busy = create.isPending || draftProbe.isPending || discovery.isPending;
  const effectiveBaseUrl = mode === 'manual' ? baseUrl.trim() : presetEndpoint ?? '';
  const diagnosticsModel = draftModel.trim() || models[0]?.real || '';

  const maxConcurrentParsed = parseMaxConcurrent(maxConcurrent);

  const resetSecretAndClose = () => {
    setApiKey('');
    onClose();
  };

  const clearFeedback = () => {
    setLocalError(null);
    setNotice(null);
    setActionError(null);
    setCreateError(null);
    setRawSyncResult(null);
  };

  const validate = (): string | null => {
    if (!name.trim()) return '请填写渠道名称（上游 name，1–64 字符）';
    if (name.trim().length > 64) return '渠道名称最长 64 个字符';
    if (apiKey.trim().length < 5) return '请填写 API Key（上游要求至少 5 个字符）';
    if (!models.length) return '至少需要 1 个模型（上游 models 至少 1 项）';
    if (mode === 'manual') {
      if (baseUrl.trim().length < 8) return 'baseUrl 至少 8 个字符（上游约束）';
    } else {
      if (!providerId) return '请选择供应商（providerId）';
      if (!providerPresetId) return '请选择供应商预设（providerPresetId）';
      if (!presetEndpoint) return '该预设没有声明所选协议的端点，无法用预设模式创建；请改用手动配置';
    }
    if (!maxConcurrentParsed.ok) return maxConcurrentParsed.message;
    return null;
  };

  const submitCreate = async () => {
    clearFeedback();
    const invalid = validate();
    if (invalid) {
      setLocalError(invalid);
      return;
    }
    const maxConcurrentValue = maxConcurrentParsed.ok ? maxConcurrentParsed.value : null;
    const body: ManualChannelCreateRequest | PresetChannelCreateRequest =
      mode === 'manual'
        ? {
            mode: 'manual',
            name: name.trim(),
            baseUrl: baseUrl.trim(),
            apiPath: apiPath.trim() === '' ? null : apiPath.trim(),
            protocol,
            apiKey: apiKey.trim(),
            models,
            enabled,
            ccMimicry,
            omitTemperature,
            omitThinking,
            ...(maxConcurrentValue === null ? {} : { maxConcurrent: maxConcurrentValue }),
          }
        : {
            mode: 'preset',
            providerId: providerId ?? '',
            providerPresetId: providerPresetId ?? '',
            name: name.trim(),
            protocol,
            apiKey: apiKey.trim(),
            models,
            enabled,
            ccMimicry,
            omitTemperature,
            omitThinking,
            ...(maxConcurrentValue === null ? {} : { maxConcurrent: maxConcurrentValue }),
          };

    try {
      const response = await create.mutateAsync({ body, idempotencyKey: newIdempotencyKey() });
      const accepted = acceptedOperation(response);
      if (accepted) {
        // 契约里 POST /channels 的成功状态是 201；这里仍然按 202 规则处理，避免把受理当成功。
        track({
          operationId: accepted.operationId,
          kind: accepted.kind,
          origin: `渠道创建：${name.trim()}`,
          invalidate: [['channels'], ['overview']],
        });
        setNotice(acceptedOperationNotice('创建渠道', accepted));
        return;
      }
      const created = response.data;
      setApiKey('');
      if (created) {
        onCreated({ id: created.id, name: created.name });
      } else {
        setNotice({
          tone: 'success',
          text: `上游返回 HTTP ${response.status} 但没有 data；请刷新列表确认创建结果（WebUI 不会自动重发该请求）。`,
        });
      }
    } catch (caught) {
      setCreateError(caught instanceof ApiError ? caught : null);
    }
  };

  const runDraftAction = async (
    label: string,
    run: () => Promise<ManagementResponse<ManagementOperationData>>,
  ) => {
    clearFeedback();
    if (mode === 'manual' && baseUrl.trim().length < 8) {
      setLocalError('草稿动作需要 baseUrl（至少 8 个字符）与 API Key');
      return;
    }
    if (apiKey.trim().length < 5) {
      setLocalError('草稿动作需要 API Key（至少 5 个字符），且该密钥只在本弹窗内存中使用');
      return;
    }
    if (mode === 'preset' && (!providerId || !providerPresetId || !presetEndpoint)) {
      setLocalError('预设模式下需要选择供应商、预设与协议端点后才能发起草稿动作');
      return;
    }
    try {
      const response = await run();
      const accepted = acceptedOperation(response);
      if (accepted) {
        track({
          operationId: accepted.operationId,
          kind: accepted.kind,
          origin: `渠道${label}：${name.trim() || '(未命名草稿)'}`,
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

  return (
    <Modal
      open={open}
      title="新增第三方 API 渠道"
      width="min(780px, calc(100vw - 32px))"
      destroyOnHidden
      onCancel={resetSecretAndClose}
      okText={create.isPending ? '创建中…' : '创建渠道'}
      cancelText="取消"
      okButtonProps={{ disabled: !canWrite || busy }}
      onOk={() => void submitCreate()}
    >
      <div className="stack" style={{ maxHeight: '65vh', overflowY: 'auto', paddingRight: 4 }}>
        {!canWrite ? (
          <div className="notice-box notice-box--warning" role="status">
            当前会话不具备写能力（{writeBlockReason ?? '只读'}）：创建与草稿诊断按钮已禁用。
          </div>
        ) : null}

        <div className={styles.noticeArea}>
          {notice ? <ChannelNoticeBox notice={notice} /> : null}
          {localError ? (
            <div className="error-box" role="alert">
              {localError}
            </div>
          ) : null}
          {actionError ? <ErrorNotice error={actionError} /> : null}
          {createError ? (
            <ErrorNotice
              error={createError}
              staleNotice={
                summarizeFieldErrors(createFieldErrors).length ? (
                  <ul style={{ margin: 0, paddingLeft: 16 }}>
                    {summarizeFieldErrors(createFieldErrors).map((text) => (
                      <li key={text}>{text}</li>
                    ))}
                  </ul>
                ) : null
              }
            />
          ) : null}
          {rawSyncResult ? <JsonBlock value={rawSyncResult} maxHeight={200} /> : null}
        </div>

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>
            <span>供应商 / 协议目录</span>
            <span className={styles.sectionHint}>GET /channel-catalog</span>
          </h3>
          {catalogLoading && !catalog ? <span className="text-sm text-secondary">正在读取目录…</span> : null}
          {catalogError && !catalog ? <ErrorNotice error={catalogError} onRetry={onRetryCatalog} /> : null}
          {catalog ? (
            <div className="row" style={{ gap: 8 }}>
              <Pill mono>providers {catalog.providers.length}</Pill>
              <Pill mono>protocols {catalog.protocols.join(' / ') || '未提供'}</Pill>
              <Pill mono>compatibilityModes {catalog.compatibilityModes.join(' / ') || '未提供'}</Pill>
              <Pill mono>features {catalog.features.join(' / ') || '未提供'}</Pill>
            </div>
          ) : null}
          {catalog && !catalog.providers.length ? (
            <span className="text-sm text-secondary">
              目录里没有供应商预设（providers 为空）：可以只使用「手动配置」模式。
            </span>
          ) : null}
        </section>

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>
            <span>创建方式</span>
            <span className={styles.sectionHint}>对应上游 ManualChannelCreateRequest / PresetChannelCreateRequest</span>
          </h3>
          <Segmented<CreateMode>
            value={mode}
            disabled={busy}
            onChange={(value) => {
              setMode(value);
              setProviderId(null);
              setProviderPresetId(null);
              clearFeedback();
            }}
            options={[
              { label: '手动配置（mode=manual）', value: 'manual' },
              { label: '供应商预设（mode=preset）', value: 'preset' },
            ]}
          />
        </section>

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>
            <span>基础字段</span>
            <span className={styles.sectionHint}>字段名与上游一致</span>
          </h3>
          <div className={styles.fieldGrid}>
            <label className="field">
              <span className="field__label">名称（name，必填）</span>
              <input
                className="input"
                value={name}
                disabled={busy}
                maxLength={64}
                onChange={(event) => setName(event.target.value)}
              />
              {fieldMessage(createFieldErrors, 'name') ? (
                <span className={styles.fieldError}>{fieldMessage(createFieldErrors, 'name')}</span>
              ) : null}
            </label>

            <label className="field">
              <span className="field__label">API Key（apiKey，必填，秘密字段）</span>
              <input
                className="input"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={apiKey}
                disabled={busy}
                placeholder="只在本弹窗内存中使用，提交后立即清除"
                onChange={(event) => setApiKey(event.target.value)}
              />
              <span className="field__hint">
                该值不会写入 localStorage/sessionStorage/URL；关闭弹窗即丢弃。上游只保存密钥本身，不回传明文。
              </span>
              {fieldMessage(createFieldErrors, 'apiKey') ? (
                <span className={styles.fieldError}>{fieldMessage(createFieldErrors, 'apiKey')}</span>
              ) : null}
            </label>

            {mode === 'manual' ? (
              <>
                <label className="field">
                  <span className="field__label">baseUrl（必填，≥8 字符）</span>
                  <input
                    className="input"
                    value={baseUrl}
                    disabled={busy}
                    placeholder="https://provider.example.com"
                    onChange={(event) => setBaseUrl(event.target.value)}
                  />
                  {fieldMessage(createFieldErrors, 'baseUrl') ? (
                    <span className={styles.fieldError}>{fieldMessage(createFieldErrors, 'baseUrl')}</span>
                  ) : null}
                </label>
                <label className="field">
                  <span className="field__label">apiPath（可选）</span>
                  <input
                    className="input"
                    value={apiPath}
                    disabled={busy}
                    placeholder="例如 /v1/messages"
                    onChange={(event) => setApiPath(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span className="field__label">协议（protocol，必填）</span>
                  <Select
                    value={protocol}
                    options={manualProtocolOptions}
                    disabled={busy}
                    aria-label="渠道协议"
                    onChange={(value) => setProtocol(value)}
                  />
                </label>
              </>
            ) : (
              <>
                <label className="field">
                  <span className="field__label">供应商（providerId，必填）</span>
                  <Select
                    value={providerId}
                    disabled={busy || !catalog?.providers.length}
                    placeholder={catalog?.providers.length ? '选择供应商' : '目录没有供应商预设'}
                    aria-label="供应商"
                    options={(catalog?.providers ?? []).map((item) => ({ value: item.id, label: `${item.name}（${item.id}）` }))}
                    onChange={(value) => {
                      setProviderId(value);
                      setProviderPresetId(null);
                    }}
                  />
                </label>
                <label className="field">
                  <span className="field__label">预设（providerPresetId，必填）</span>
                  <Select
                    value={providerPresetId}
                    disabled={busy || !provider}
                    placeholder={provider ? '选择预设' : '先选择供应商'}
                    aria-label="供应商预设"
                    options={(provider?.presets ?? []).map((item) => ({ value: item.id, label: `${item.name}（${item.id}）` }))}
                    onChange={(value) => {
                      setProviderPresetId(value);
                      const next = provider?.presets.find((item) => item.id === value) ?? null;
                      const firstProtocol = next?.protocols[0]?.protocol;
                      if (firstProtocol) setProtocol(firstProtocol);
                    }}
                  />
                </label>
                <label className="field">
                  <span className="field__label">协议（protocol，必填）</span>
                  <Select
                    value={presetEndpoint ? protocol : undefined}
                    options={presetProtocolOptions}
                    disabled={busy || !presetProtocolOptions.length}
                    placeholder={presetProtocolOptions.length ? '选择协议端点' : '该预设没有声明协议端点'}
                    aria-label="预设协议"
                    onChange={(value) => setProtocol(value)}
                  />
                  <span className="field__hint">
                    预设模式下 baseUrl 由上游预设决定；草稿动作会使用目录里声明的端点：
                    {presetEndpoint ? <span className="mono">{presetEndpoint}</span> : '未声明'}
                  </span>
                </label>
                {preset ? (
                  <div className={`${styles.fieldWide} row`} style={{ gap: 8 }}>
                    <Pill mono>modelsUrlConfigured={String(preset.modelsUrlConfigured)}</Pill>
                    <Pill mono>modelDiscoveryAuth={preset.modelDiscoveryAuth}</Pill>
                    <Pill mono>modelDiscoveryParser={preset.modelDiscoveryParser}</Pill>
                    <Pill mono>providerUsageSupported={String(preset.providerUsageSupported)}</Pill>
                    <Pill mono>staticModels {preset.staticModels.length}</Pill>
                    <button
                      type="button"
                      className="btn btn--sm btn--secondary"
                      disabled={busy || !preset.staticModels.length}
                      onClick={() => {
                        // 只把上游声明的 staticModels 原样填成 alias=real，供用户继续修改。
                        setModels(preset.staticModels.map((model) => ({ alias: model, real: model })));
                        setModelsVersion((value) => value + 1);
                      }}
                    >
                      用预设 staticModels 填充模型列表
                    </button>
                  </div>
                ) : null}
              </>
            )}

            <ChannelModelTextarea
              key={`create-models-${modelsVersion}`}
              id="channel-create-models"
              initialModels={models}
              disabled={busy}
              error={fieldMessage(createFieldErrors, 'models')}
              onChange={setModels}
            />

            <label className="field">
              <span className="field__label">最大并发（maxConcurrent，可选）</span>
              <input
                className="input"
                inputMode="numeric"
                value={maxConcurrent}
                disabled={busy}
                placeholder="留空则不发送该字段，由上游使用默认值"
                onChange={(event) => setMaxConcurrent(event.target.value)}
              />
              {!maxConcurrentParsed.ok ? <span className={styles.fieldError}>{maxConcurrentParsed.message}</span> : null}
            </label>

            <div className={`${styles.fieldWide} row`} style={{ gap: 16 }}>
              <label className="row" style={{ gap: 8 }}>
                <span className="field__label">创建后启用（enabled）</span>
                <Switch checked={enabled} disabled={busy} aria-label="创建后启用" onChange={setEnabled} />
              </label>
              <label className="row" style={{ gap: 8 }}>
                <span className="field__label">CC 伪装（ccMimicry）</span>
                <Switch checked={ccMimicry} disabled={busy} aria-label="CC 伪装" onChange={setCcMimicry} />
              </label>
              <label className="row" style={{ gap: 8 }}>
                <span className="field__label">省略 temperature</span>
                <Switch checked={omitTemperature} disabled={busy} aria-label="省略 temperature" onChange={setOmitTemperature} />
              </label>
              <label className="row" style={{ gap: 8 }}>
                <span className="field__label">省略 thinking</span>
                <Switch checked={omitThinking} disabled={busy} aria-label="省略 thinking" onChange={setOmitThinking} />
              </label>
            </div>
          </div>
          <span className="text-sm text-secondary">
            兼容性配置（compatibility）不在创建表单里设置：上游创建接口虽然接受该字段，但 WebUI 无法在此确认
            context1m / fast 的实际影响，创建后可在详情抽屉的「兼容性配置」区块中读取并修改。
          </span>
        </section>

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>
            <span>草稿诊断与模型发现</span>
            <span className={styles.sectionHint}>
              仅针对尚未创建的草稿：POST /channel-drafts/probes、POST /channel-model-discoveries（source=draft）
            </span>
          </h3>
          <div className={styles.fieldGrid}>
            <label className="field">
              <span className="field__label">草稿诊断模型（model，必填）</span>
              <AutoComplete
                value={draftModel}
                disabled={busy}
                placeholder="留空则使用模型列表的第一项"
                aria-label="草稿诊断模型"
                options={models.map((model) => ({ value: model.real, label: `${model.real}（别名 ${model.alias}）` }))}
                onChange={(value: string) => setDraftModel(value)}
              />
              <span className="field__hint">当前将使用：{diagnosticsModel ? <span className="mono">{diagnosticsModel}</span> : '尚未确定'}</span>
            </label>
          </div>
          <div className={styles.formActions}>
            <button
              type="button"
              className="btn btn--sm btn--secondary"
              disabled={!canWrite || busy || !diagnosticsModel}
              title={canWrite ? undefined : writeBlockReason ?? '当前会话不可写'}
              onClick={() =>
                void runDraftAction('草稿诊断', () =>
                  draftProbe.mutateAsync({
                    baseUrl: effectiveBaseUrl,
                    apiKey: apiKey.trim(),
                    protocol,
                    model: diagnosticsModel,
                    ...(name.trim() ? { name: name.trim() } : {}),
                    ...(mode === 'manual' ? { apiPath: apiPath.trim() === '' ? null : apiPath.trim(), ccMimicry } : {}),
                    ...(mode === 'preset' ? { providerId, providerPresetId } : {}),
                  }),
                )
              }
            >
              {draftProbe.isPending ? '提交中…' : '草稿诊断（202，异步）'}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--secondary"
              disabled={!canWrite || busy}
              title={canWrite ? undefined : writeBlockReason ?? '当前会话不可写'}
              onClick={() =>
                void runDraftAction('草稿模型发现', () =>
                  discovery.mutateAsync({
                    source: 'draft',
                    baseUrl: effectiveBaseUrl,
                    apiKey: apiKey.trim(),
                    protocol,
                    ...(mode === 'manual' ? { apiPath: apiPath.trim() === '' ? null : apiPath.trim() } : {}),
                    ...(mode === 'preset' ? { providerId, providerPresetId } : {}),
                  }),
                )
              }
            >
              {discovery.isPending ? '提交中…' : '草稿模型发现（202，异步）'}
            </button>
          </div>
          <span className="text-sm text-secondary">
            这两个动作只验证草稿连接、不创建渠道；已创建渠道的诊断请到渠道详情抽屉里发起（副作用不同，不能混用）。
          </span>
        </section>
      </div>
    </Modal>
  );
}
