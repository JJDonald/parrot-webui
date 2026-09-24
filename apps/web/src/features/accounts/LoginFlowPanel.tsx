/**
 * OAuth 登录流程面板（真实接口驱动）。
 *
 * 覆盖的交互状态：发起 / 等待授权 / 需要回填 / 保存成功 / 超时 / 取消 / 失败。
 * 关键要求：
 * - 外链只接受 http/https，且使用 target="_blank" rel="noopener noreferrer"；
 * - 不假设所有供应商都会跳回 WebUI：没有 authUrl 时展示上游 instruction 文本，并允许回填；
 * - flowSecret 只在内存里（见 useLoginFlow），刷新即丢失，这里只提示重新发起；
 * - 保存成功与模型同步是两个独立结果，同步失败不会被报成授权失败；
 * - 同身份冲突必须由用户明确确认替换，禁止静默覆盖。
 */

import { useState } from 'react';
import { Select } from 'antd';
import { ApiError } from '@/api/client';
import { useOperations } from '@/api/operations';
import { CopyableText, MonoText, Pill, RelativeTime, TimeText } from '@/components/bits';
import { ErrorNotice } from '@/components/feedback';
import { accountInvalidationKeys, useSyncAccountModelsMutation } from './accountsApi';
import { toApiError } from './errors';
import {
  CLIENT_PROFILE_LABEL,
  LOGIN_FLOW_STAGE_LABEL,
  LOGIN_FLOW_STAGE_TONE,
  OAUTH_PROVIDERS,
  POLL_STATUS_LABEL,
  PROVIDER_LABEL,
  REALM_LABEL,
  externalHttpUrl,
  operationIdFrom,
  providerLabel,
  saveStatusLabel,
  type OAuthProvider,
} from './oauthTypes';
import { useLoginFlow } from './useLoginFlow';
import styles from './accounts.module.scss';

export interface LoginFlowPanelProps {
  canWrite: boolean;
  writeReason: string | null;
  onOpenAccount: (accountId: string) => void;
}

/** 登录成功后的模型同步：独立动作，失败绝不表述为授权失败。 */
function AccountModelSync({ accountId }: { accountId: string }) {
  const sync = useSyncAccountModelsMutation();
  const { track } = useOperations();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  return (
    <div className={styles.stageNotice}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn btn--sm btn--secondary"
          disabled={sync.isPending}
          onClick={async () => {
            setError(null);
            setMessage(null);
            try {
              const response = await sync.mutateAsync({ accountId });
              const operationId = operationIdFrom(response);
              if (operationId) {
                // 202：只代表已受理，交给任务面板跟踪，不立即报成功。
                track({
                  operationId,
                  origin: `OAuth 登录后模型同步（${accountId}）`,
                  invalidate: accountInvalidationKeys,
                });
                setMessage('模型同步任务已受理（202），进度见任务中心；同步结果与授权结果相互独立。');
              } else {
                setMessage(`模型同步已直接返回（HTTP ${response.status}），请以该账号的模型列表为准。`);
              }
            } catch (caught) {
              setError(toApiError(caught, '模型同步请求失败（授权状态不受影响）'));
            }
          }}
        >
          {sync.isPending ? '同步中…' : '同步该账号的模型'}
        </button>
        {message ? <span className={styles.hint}>{message}</span> : null}
      </div>
      {error ? <ErrorNotice error={error} /> : null}
      <span className={styles.hint}>
        账号已经保存成功；模型同步是<strong>独立任务</strong>：同步失败只表示模型列表未刷新，
        不代表本次授权失败，也不代表凭据无效。
      </span>
    </div>
  );
}

export function LoginFlowPanel({ canWrite, writeReason, onOpenAccount }: LoginFlowPanelProps) {
  const loginFlow = useLoginFlow();
  const { state, pending, isPolling, pollIntervalMs, hasFlowSecret } = loginFlow;

  const [provider, setProvider] = useState<OAuthProvider>('openai');
  const [clientProfile, setClientProfile] = useState<string>('');
  const [realm, setRealm] = useState<string>('');
  const [code, setCode] = useState('');
  const [stateValue, setStateValue] = useState('');
  const [callbackUrl, setCallbackUrl] = useState('');

  const flow = state.flow;
  const authUrl = flow ? externalHttpUrl(flow.authUrl) : null;
  const rawAuthUrlPresent = Boolean(flow?.authUrl);
  const hasActiveFlow = state.stage === 'waiting' || state.stage === 'needs-input' || state.stage === 'ready';
  const canStart = canWrite && !hasActiveFlow && !pending.start;
  const inputDisabled = !canWrite || pending.complete;
  const hasBackfillInput = Boolean(code.trim() || stateValue.trim() || callbackUrl.trim());

  return (
    <div className={styles.section}>
      <div className="keeper-card">
        <div className={styles.cardHeader}>
          <div className={styles.cardHeaderText}>
            <h2 className="keeper-card__title">登录 OAuth 账号</h2>
            <p className="keeper-card__subtitle">
              通过上游真实登录流程发起：POST /oauth/login-flows → 需要轮询的供应商用
              POST /oauth/login-flows/{'{flowId}'}/poll（body 带 flowSecret）→ 需要回填时
              POST /oauth/login-flows/{'{flowId}'}/complete → 取消用 POST .../cancel（成功 204）。
            </p>
          </div>
          <Pill tone={LOGIN_FLOW_STAGE_TONE[state.stage]}>{LOGIN_FLOW_STAGE_LABEL[state.stage]}</Pill>
        </div>

        {!canWrite ? (
          <div className="notice-box notice-box--warning" role="status" style={{ marginTop: 12 }}>
            当前会话不具备写能力{writeReason ? `（${writeReason}）` : ''}：可以查看流程状态，但不能发起或提交流程。
            上游仍会再次校验权限。
          </div>
        ) : null}

        <div className={styles.formGrid} style={{ marginTop: 12 }}>
          <label className="field">
            <span className="field__label">供应商</span>
            <Select<string>
              value={provider}
              onChange={(value) => setProvider(value as OAuthProvider)}
              options={OAUTH_PROVIDERS.map((item) => ({ value: item, label: PROVIDER_LABEL[item] }))}
              aria-label="选择 OAuth 供应商"
              disabled={hasActiveFlow || pending.start}
            />
            <span className="field__hint">
              供应商是否可用取决于部署的上游版本；不可用时上游会直接返回错误，WebUI 不会假造登录路径。
            </span>
          </label>
          <label className="field">
            <span className="field__label">客户端形态（可选）</span>
            <Select<string>
              value={clientProfile}
              onChange={(value) => setClientProfile(value)}
              options={[
                { value: '', label: '不指定' },
                { value: 'cli', label: CLIENT_PROFILE_LABEL.cli },
                { value: 'ide', label: CLIENT_PROFILE_LABEL.ide },
              ]}
              aria-label="客户端形态"
              disabled={hasActiveFlow || pending.start}
            />
          </label>
          <label className="field">
            <span className="field__label">区域（可选）</span>
            <Select<string>
              value={realm}
              onChange={(value) => setRealm(value)}
              options={[
                { value: '', label: '不指定' },
                { value: 'cn', label: REALM_LABEL.cn },
                { value: 'global', label: REALM_LABEL.global },
              ]}
              aria-label="区域"
              disabled={hasActiveFlow || pending.start}
            />
          </label>
          <div className="field">
            <span className="field__label">发起</span>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canStart}
              onClick={async () => {
                await loginFlow.start({
                  provider,
                  clientProfile: clientProfile === 'cli' || clientProfile === 'ide' ? clientProfile : null,
                  realm: realm === 'cn' || realm === 'global' ? realm : null,
                });
              }}
            >
              {pending.start ? '发起中…' : '发起登录流程'}
            </button>
            <span className="field__hint">
              {hasActiveFlow
                ? '当前页面已有进行中的流程：请先完成或取消，避免重复创建登录流程。'
                : '同一页面不会重复创建流程；每次只保留一个流程的内存密钥。'}
            </span>
          </div>
        </div>

        <div className={styles.secretHint} style={{ marginTop: 12 }}>
          flowSecret 只保存在当前页面的内存里：不写入 URL、localStorage / sessionStorage，也不写日志。
          刷新或切换到其他标签页会丢失该流程，需要重新发起；不会复用其他账号的流程密钥。
        </div>
      </div>

      {state.error ? (
        <ErrorNotice
          error={state.error}
          onRetry={
            hasActiveFlow && state.error.code === 'WEBUI_NETWORK_ERROR'
              ? () => loginFlow.resumePolling()
              : undefined
          }
        />
      ) : null}

      {state.pollError && state.pollError !== state.error ? (
        <ErrorNotice
          error={state.pollError}
          compact
          onRetry={hasFlowSecret && !isPolling ? () => loginFlow.resumePolling() : undefined}
        />
      ) : null}

      {flow ? (
        <div className="keeper-card">
          <div className={styles.cardHeader}>
            <div className={styles.cardHeaderText}>
              <h3 className="keeper-card__title">
                当前流程：{providerLabel(flow.provider)}
              </h3>
              <span className="keeper-card__subtitle">
                {isPolling
                  ? `正在读取流程状态（间隔约 ${Math.round((pollIntervalMs ?? 0) / 1000)} 秒；页面进入后台自动降频）`
                  : '当前没有进行中的轮询'}
              </span>
            </div>
            <div className={styles.stageBar}>
              {state.poll ? (
                <Pill tone="primary">{POLL_STATUS_LABEL[state.poll.status]}</Pill>
              ) : (
                <Pill tone="muted">尚未轮询</Pill>
              )}
              <Pill tone={LOGIN_FLOW_STAGE_TONE[state.stage]}>{LOGIN_FLOW_STAGE_LABEL[state.stage]}</Pill>
            </div>
          </div>

          <div className={styles.flowGrid} style={{ marginTop: 12 }}>
            <div className={styles.flowField}>
              <span className={styles.flowFieldLabel}>flowId</span>
              <span className={styles.flowFieldValue}>
                <MonoText>{flow.flowId}</MonoText>
              </span>
            </div>
            <div className={styles.flowField}>
              <span className={styles.flowFieldLabel}>流程过期时间（expiresAt）</span>
              <span className={styles.flowFieldValue}>
                <TimeText value={flow.expiresAt} withSeconds />
              </span>
            </div>
            <div className={styles.flowField}>
              <span className={styles.flowFieldLabel}>最近一次轮询</span>
              <span className={styles.flowFieldValue}>
                {state.lastPolledAt ? (
                  <RelativeTime value={new Date(state.lastPolledAt).toISOString()} />
                ) : (
                  <span className="text-tertiary">尚未成功读取</span>
                )}
                {state.pollFailures > 0 ? (
                  <span className="text-sm text-secondary">（连续失败 {state.pollFailures} 次）</span>
                ) : null}
              </span>
            </div>
            {state.poll?.accountId ? (
              <div className={styles.flowField}>
                <span className={styles.flowFieldLabel}>上游识别的账号</span>
                <span className={styles.flowFieldValue}>
                  <CopyableText value={state.poll.accountId} />
                </span>
              </div>
            ) : null}
          </div>

          {rawAuthUrlPresent ? (
            <div style={{ marginTop: 12 }} className={styles.stageNotice}>
              {authUrl ? (
                <>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <a href={authUrl} target="_blank" rel="noopener noreferrer" className="btn btn--sm btn--primary">
                      在新标签页打开官方授权链接
                    </a>
                    <span className={styles.hint}>链接来自上游返回的 authUrl（仅接受 http/https）。</span>
                  </div>
                  <span className={styles.mono}>{authUrl}</span>
                </>
              ) : (
                <>
                  <strong>已拒绝打开该授权链接</strong>
                  <span>
                    上游返回的 authUrl 不是 http/https（可能被篡改或格式异常）。请按下方指引手动操作，或取消流程后重新发起。
                  </span>
                </>
              )}
            </div>
          ) : (
            <div className={`${styles.stageNotice} ${styles.stageNoticeWarning}`} style={{ marginTop: 12 }}>
              <strong>上游未返回授权链接</strong>
              <span>
                不要假设所有供应商都会自动跳回 WebUI。请按下面的“上游指引”在官方客户端/浏览器完成授权，
                然后用回填表单把 code/state/callbackUrl 提交回来。
              </span>
            </div>
          )}

          {flow.instruction ? (
            <div style={{ marginTop: 12 }} className={styles.flowField}>
              <span className={styles.flowFieldLabel}>上游指引（instruction，纯文本）</span>
              <pre className={styles.instruction} tabIndex={0}>
                {flow.instruction}
              </pre>
            </div>
          ) : (
            <div className={styles.hint} style={{ marginTop: 12 }}>
              上游没有返回额外的指引文本；请使用官方授权页面的标准流程。
            </div>
          )}

          {state.notice ? (
            <div
              className={`${styles.stageNotice} ${
                state.stage === 'saved'
                  ? styles.stageNoticeSuccess
                  : state.stage === 'expired' || state.stage === 'cancelled'
                    ? styles.stageNoticeWarning
                    : ''
              }`}
              style={{ marginTop: 12 }}
              role="status"
            >
              <span>{state.notice}</span>
            </div>
          ) : null}

          {state.replacePlan ? (
            <div className={`${styles.stageNotice} ${styles.stageNoticeWarning}`} style={{ marginTop: 12 }} role="alert">
              <strong>同身份账号已存在（409 IDENTITY_CONFLICT）</strong>
              <span>
                目标账号：<span className={styles.mono}>{state.replacePlan.accountId}</span>
              </span>
              <span>
                上游返回了一次性替换令牌（replacePlanToken，只在本页内存中，刷新即失效）。
                WebUI 不会自动覆盖：请明确选择下面两种处理之一。
              </span>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn--sm btn--danger"
                  disabled={!canWrite || pending.complete}
                  onClick={() => void loginFlow.confirmReplace()}
                >
                  用新凭据替换现有账号
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--secondary"
                  disabled={pending.complete}
                  onClick={() => loginFlow.declineReplace()}
                >
                  保留现有账号（不替换）
                </button>
              </div>
            </div>
          ) : null}

          {state.stage === 'saved' ? (
            <div className={`${styles.stageNotice} ${styles.stageNoticeSuccess}`} style={{ marginTop: 12 }}>
              <strong>保存成功</strong>
              <span>
                {state.saveStatus ? saveStatusLabel(state.saveStatus) : '上游已保存账号'}
                {state.mutationStatus ? `（上游 status：${state.mutationStatus}）` : ''}
              </span>
              {state.savedAccountId ? (
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <span>账号标识：</span>
                  <MonoText>{state.savedAccountId}</MonoText>
                  <button
                    type="button"
                    className="btn btn--sm btn--secondary"
                    onClick={() => onOpenAccount(state.savedAccountId as string)}
                  >
                    查看账号详情
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {state.stage === 'saved' && state.savedAccountId ? (
        <AccountModelSync accountId={state.savedAccountId} />
      ) : null}

      {hasActiveFlow ? (
        <div className="keeper-card">
          <div className={styles.cardHeaderText}>
            <h3 className="keeper-card__title">
              回填 / 完成
            </h3>
            <span className="keeper-card__subtitle">
              需要用户回填时（poll status 为 identity_pending 或 ready）在这里提交；字段按上游 schema 全部可选，
              只提交你实际提供的值。
            </span>
          </div>

          {state.stage === 'needs-input' ? (
            <div className={`${styles.stageNotice} ${styles.stageNoticeWarning}`} style={{ marginTop: 12 }} role="status">
              <strong>需要回填</strong>
              <span>请按上游指引把授权结果填到下面，然后点击“提交回填并保存”。</span>
            </div>
          ) : null}
          {state.stage === 'ready' ? (
            <div className={styles.stageNotice} style={{ marginTop: 12 }} role="status">
              <strong>等待保存（ready）</strong>
              <span>
                上游已认可本次授权。若供应商不需要额外回填，直接点击“保存账号（已完成授权）”即可；
                需要 code/state 的供应商请使用下面的回填表单。
              </span>
            </div>
          ) : null}

          <div className={styles.formGrid} style={{ marginTop: 12 }}>
            <label className="field">
              <span className="field__label">code</span>
              <input
                className="input"
                value={code}
                disabled={inputDisabled}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setCode(event.target.value)}
              />
            </label>
            <label className="field">
              <span className="field__label">state</span>
              <input
                className="input"
                value={stateValue}
                disabled={inputDisabled}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setStateValue(event.target.value)}
              />
            </label>
            <label className="field">
              <span className="field__label">callbackUrl</span>
              <input
                className="input"
                value={callbackUrl}
                disabled={inputDisabled}
                autoComplete="off"
                spellCheck={false}
                placeholder="https://…"
                onChange={(event) => setCallbackUrl(event.target.value)}
              />
              <span className="field__hint">
                这些值只在本次提交的请求体里使用，不写入浏览器存储。
              </span>
            </label>
          </div>

          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canWrite || pending.complete || (!hasBackfillInput && state.stage !== 'needs-input')}
              onClick={() =>
                void loginFlow.complete({
                  code: code.trim() || null,
                  state: stateValue.trim() || null,
                  callbackUrl: callbackUrl.trim() || null,
                })
              }
            >
              {pending.complete ? '提交中…' : '提交回填并保存'}
            </button>
            <button
              type="button"
              className="btn btn--secondary"
              disabled={!canWrite || pending.complete}
              onClick={() => void loginFlow.complete({ completed: true })}
            >
              保存账号（已完成授权）
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={!canWrite || pending.cancel}
              onClick={() => void loginFlow.cancel()}
            >
              {pending.cancel ? '取消中…' : '取消当前流程'}
            </button>
            {!isPolling && hasFlowSecret && state.pollError ? (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => loginFlow.resumePolling()}
              >
                继续轮询
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {state.stage === 'expired' || state.stage === 'cancelled' || state.stage === 'failed' || state.stage === 'saved' ? (
        <div className="keeper-card">
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn--sm btn--primary" onClick={() => loginFlow.reset()}>
              重新发起登录流程
            </button>
            {state.stage === 'failed' && hasFlowSecret ? (
              <button
                type="button"
                className="btn btn--sm btn--secondary"
                onClick={() => loginFlow.resumePolling()}
              >
                继续轮询
              </button>
            ) : null}
            {hasFlowSecret && state.stage !== 'saved' ? (
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                disabled={!canWrite || pending.cancel}
                onClick={() => void loginFlow.cancel()}
              >
                取消该流程
              </button>
            ) : null}
          </div>
          <span className={styles.hint} style={{ marginTop: 8, display: 'block' }}>
            重新发起会丢弃当前流程的内存密钥（flowSecret），这是刻意的：不会把上一个流程的密钥复用到新流程。
          </span>
        </div>
      ) : null}
    </div>
  );
}
