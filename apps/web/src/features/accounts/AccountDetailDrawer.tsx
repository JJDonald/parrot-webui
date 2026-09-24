/**
 * OAuth 账号详情抽屉。
 *
 * 接口：
 * - GET    /oauth/accounts/{accountId}
 * - PATCH  /oauth/accounts/{accountId}                                 （displayName / enabled / maxConcurrent，If-Match）
 * - DELETE /oauth/accounts/{accountId}                                 （If-Match 必填，成功 204）
 * - POST   .../actions/refresh-token                                   （200，展示上游返回的 status）
 * - POST   .../actions/refresh-usage                                   （202 → 任务面板）
 * - POST   .../actions/clear-errors / .../actions/clear-affinity        （204）
 *
 * 额度与用量只展示上游真实返回的字段：null / 缺失一律显示“未知”，绝不折算成 0 或无限。
 */

import { useEffect, useState } from 'react';
import { Drawer } from 'antd';
import type { ApiError, ManagementResponse } from '@/api/client';
import { useOperations } from '@/api/operations';
import { DangerConfirmButton, JsonBlock, KeyValueList, MonoText, Pill, StatCard, TimeText } from '@/components/bits';
import { ErrorNotice } from '@/components/feedback';
import { AsyncState } from '@/components/state';
import { AccountModelsSection } from './AccountModelsSection';
import {
  accountInvalidationKeys,
  useAccountDetailQuery,
  useClearAccountErrorsMutation,
  useClearAffinityMutation,
  useDeleteAccountMutation,
  useRefreshTokenMutation,
  useRefreshUsageMutation,
  useUpdateAccountMutation,
} from './accountsApi';
import { toApiError } from './errors';
import {
  accountAvailabilityLabel,
  formatBoolean,
  formatCount,
  formatPercent,
  formatUsd,
  operationIdFrom,
  providerLabel,
  type OAuthAccountDetailData,
  type OAuthUsageWindowData,
} from './oauthTypes';
import styles from './accounts.module.scss';

export interface AccountDetailDrawerProps {
  accountId: string | null;
  onClose: () => void;
  onDeleted: (accountId: string) => void;
  canWrite: boolean;
  writeReason: string | null;
}

interface EditForm {
  displayName: string;
  maxConcurrent: string;
  enabled: boolean;
}

function UsageWindows({ windows }: { windows: OAuthUsageWindowData[] }) {
  if (windows.length === 0) {
    return (
      <span className="text-tertiary">
        上游没有返回任何用量窗口（usageWindows 为空）；这不代表额度为 0 或无限。
      </span>
    );
  }
  return (
    <div className={styles.usageList}>
      {windows.map((window) => {
        const used = formatPercent(window.usedPercent);
        const remaining = formatPercent(window.remainingPercent);
        const usedValue = typeof window.usedPercent === 'number' ? window.usedPercent : null;
        const fillClass =
          usedValue === null
            ? ''
            : usedValue >= 90
              ? styles.usageFillHigh
              : usedValue >= 70
                ? styles.usageFillMedium
                : styles.usageFill;
        return (
          <div className={styles.usageRow} key={window.name}>
            <span className={styles.usageName}>{window.name}</span>
            {usedValue === null ? (
              <span className={styles.usageUnknownTrack} aria-label="已用比例未知" title="上游未返回 usedPercent" />
            ) : (
              <span className={styles.usageTrack} aria-label={`已用 ${used}`}>
                <span
                  className={`${styles.usageFill} ${fillClass === styles.usageFill ? '' : fillClass}`}
                  style={{ width: `${Math.max(0, Math.min(100, usedValue))}%` }}
                />
              </span>
            )}
            <span className={styles.usageValue}>
              {used ? `已用 ${used}` : '已用比例：未知'}
              <br />
              {remaining ? `剩余 ${remaining}` : '剩余额度：未知'}
              <br />
              <span className={styles.usageReset}>
                重置：<TimeText value={window.resetsAt} />
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function AccountDetailDrawer({
  accountId,
  onClose,
  onDeleted,
  canWrite,
  writeReason,
}: AccountDetailDrawerProps) {
  const detail = useAccountDetailQuery(accountId);
  const data = detail.data?.data;
  const account = data?.account ?? null;

  const updateAccount = useUpdateAccountMutation();
  const deleteAccount = useDeleteAccountMutation();
  const refreshToken = useRefreshTokenMutation();
  const refreshUsage = useRefreshUsageMutation();
  const clearErrors = useClearAccountErrorsMutation();
  const clearAffinity = useClearAffinityMutation();
  const { track } = useOperations();

  const [form, setForm] = useState<EditForm | null>(null);
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // 用上游读到的值初始化表单；revision 变化（含 409 冲突后重新读取）会重新对齐。
  useEffect(() => {
    if (!account) return;
    const key = `${account.accountId}:${account.revision}`;
    if (seededFor === key) return;
    setSeededFor(key);
    setForm({
      displayName: account.displayName,
      maxConcurrent: String(account.maxConcurrent),
      enabled: account.enabled,
    });
  }, [account, seededFor]);

  useEffect(() => {
    setActionMessage(null);
    setActionError(null);
    setFormError(null);
  }, [accountId]);

  const runAction = async (
    label: string,
    action: () => Promise<ManagementResponse<unknown>>,
    options: { trackOrigin?: string; successText?: (response: ManagementResponse<unknown>) => string } = {},
  ) => {
    setActionError(null);
    setActionMessage(null);
    try {
      const response = await action();
      const operationId = operationIdFrom(response);
      if (operationId && options.trackOrigin) {
        track({ operationId, origin: options.trackOrigin, invalidate: accountInvalidationKeys });
        setActionMessage(`${label}已受理（202），进度与结果见任务中心；不视为已完成。`);
        return;
      }
      setActionMessage(
        options.successText
          ? options.successText(response)
          : `${label}完成（HTTP ${response.status}${response.status === 204 ? '，上游无返回内容' : ''}）。`,
      );
    } catch (caught) {
      setActionError(toApiError(caught, `${label}请求失败`));
    }
  };

  const save = async () => {
    if (!account || !form) return;
    setFormError(null);
    setActionError(null);
    setActionMessage(null);
    const displayName = form.displayName.trim();
    if (displayName.length === 0 || displayName.length > 200) {
      setFormError('显示名需要 1–200 个字符（上游 schema 约束）。');
      return;
    }
    const maxConcurrent = Number(form.maxConcurrent);
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 0 || maxConcurrent > 10_000) {
      setFormError('最大并发需要是 0–10000 之间的整数（上游 schema 约束）。');
      return;
    }
    try {
      const response = await updateAccount.mutateAsync({
        accountId: account.accountId,
        body: { displayName, enabled: form.enabled, maxConcurrent },
        // 写入时回传读到的 revision（If-Match），避免覆盖其他管理端的修改。
        ifMatch: account.revision,
      });
      setActionMessage(`账号已保存（HTTP ${response.status}）。`);
    } catch (caught) {
      setActionError(toApiError(caught, '账号保存失败'));
    }
  };

  return (
    <Drawer
      open={Boolean(accountId)}
      onClose={onClose}
      width={760}
      destroyOnHidden
      title="OAuth 账号详情"
      styles={{ body: { paddingTop: 12 } }}
    >
      <div className={styles.drawerBody}>
        {!canWrite ? (
          <div className="notice-box notice-box--warning" role="status">
            当前会话不具备写能力{writeReason ? `（${writeReason}）` : ''}：详情可查看，写操作已被禁用；上游仍会二次校验。
          </div>
        ) : null}

        {actionMessage ? (
          <div className="notice-box" role="status">
            {actionMessage}
          </div>
        ) : null}
        {actionError ? (
          <ErrorNotice
            error={actionError}
            onResolveConflict={actionError.code === 'REVISION_CONFLICT' ? () => void detail.refetch() : undefined}
          />
        ) : null}

        <AsyncState<OAuthAccountDetailData>
          isLoading={detail.isLoading}
          error={detail.error}
          data={data ?? undefined}
          onRetry={() => void detail.refetch()}
          isStale={detail.isError && Boolean(data)}
          loadingLabel="加载账号详情…"
        >
          {(value) => {
            const summary = value.account;
            const status = accountAvailabilityLabel(summary);
            const stats = value.localStats;
            return (
              <div className={styles.drawerBody}>
                <div className={styles.detailHeader}>
                  <div className={styles.detailTitleRow}>
                    <h2 className="keeper-card__title">
                      {summary.displayName}
                    </h2>
                    <Pill tone={status.tone}>{status.label}</Pill>
                    <Pill tone="muted">{providerLabel(summary.provider)}</Pill>
                    {summary.enabled ? <Pill tone="success">已启用</Pill> : <Pill tone="warning">已禁用</Pill>}
                    {summary.invalid ? <Pill tone="danger">凭据失效</Pill> : null}
                  </div>
                  <span className={styles.mono}>{summary.identity}</span>
                </div>

                <KeyValueList
                  items={[
                    { label: '账号 ID', value: <MonoText>{summary.accountId}</MonoText> },
                    { label: '凭据已配置', value: formatBoolean(value.credentialConfigured) },
                    { label: '凭据过期时间', value: <TimeText value={value.expiresAt} withSeconds /> },
                    { label: '最近模型同步', value: <TimeText value={value.lastModelSync} withSeconds /> },
                    { label: '套餐（planType）', value: value.planType ?? <span className="text-tertiary">未知</span> },
                    {
                      label: '工作区',
                      value: value.workspaceName ?? value.workspaceId ?? <span className="text-tertiary">未知</span>,
                    },
                    {
                      label: '模型数量',
                      value: `${formatCount(summary.modelCount) ?? '未知'}（禁用 ${formatCount(summary.disabledModelCount) ?? '未知'}）`,
                    },
                    { label: '最大并发', value: formatCount(summary.maxConcurrent) ?? '未知' },
                    { label: '额度受限（quotaLimited）', value: formatBoolean(summary.quotaLimited) },
                    { label: '可用（available）', value: formatBoolean(summary.available) },
                    { label: '冷却至', value: <TimeText value={summary.disabledUntil} withSeconds /> },
                    {
                      label: '冷却原因',
                      value: summary.disabledReason ?? <span className="text-tertiary">上游未提供</span>,
                    },
                    { label: 'revision', value: <span className={styles.mono}>{summary.revision}</span> },
                  ]}
                />

                <div className="keeper-card keeper-card--flush">
                  <div className="keeper-card__header">
                    <div className="keeper-card__heading">
                      <span className="keeper-card__title">
                        额度与用量
                      </span>
                      <span className="keeper-card__subtitle">
                        只展示上游返回的 usageWindows / localStats；缺失即“未知”，不折算成 0 或无限额度。
                      </span>
                    </div>
                  </div>
                  <div className="keeper-card__body stack">
                    <UsageWindows windows={value.usageWindows} />
                    <div className="stat-grid">
                      <StatCard
                        label="请求次数"
                        value={formatCount(stats.requestCount) ?? '未知'}
                        hint="上游本地统计 localStats.requestCount"
                      />
                      <StatCard label="输入 Token" value={formatCount(stats.inputTokens) ?? '未知'} />
                      <StatCard label="输出 Token" value={formatCount(stats.outputTokens) ?? '未知'} />
                      <StatCard
                        label="成本（USD）"
                        value={formatUsd(stats.costUsd) ?? '未知'}
                        hint={stats.costUsd === null || stats.costUsd === undefined ? '上游未返回该项' : undefined}
                      />
                    </div>
                  </div>
                </div>

                <div className="keeper-card keeper-card--flush">
                  <div className="keeper-card__header">
                    <div className="keeper-card__heading">
                      <span className="keeper-card__title">
                        运行时错误（runtimeErrors）
                      </span>
                      <span className="keeper-card__subtitle">
                        上游返回 {value.runtimeErrors.length} 条；清空后只影响错误记录，不影响凭据。
                      </span>
                    </div>
                  </div>
                  <div className="keeper-card__body">
                    {value.runtimeErrors.length === 0 ? (
                      <span className="text-tertiary">上游当前没有返回运行时错误记录。</span>
                    ) : (
                      <div className="stack" style={{ gap: 8 }}>
                        {value.runtimeErrors.map((error, index) => (
                          <div
                            className="notice-box notice-box--warning"
                            key={`${error.modelId ?? 'unknown'}-${index}`}
                          >
                            <div className="stack" style={{ gap: 4 }}>
                              <span>
                                模型：{error.modelId ?? '（未指定）'} · 冷却：
                                {error.cooldownPermanent ? '永久' : <TimeText value={error.cooldownUntil} />}
                              </span>
                              <span>{error.message ?? '上游未提供错误文本'}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="keeper-card keeper-card--flush">
                  <div className="keeper-card__header">
                    <div className="keeper-card__heading">
                      <span className="keeper-card__title">
                        编辑与动作
                      </span>
                      <span className="keeper-card__subtitle">
                        写入会带上读到的 revision（If-Match）；409 冲突不会自动覆盖。
                      </span>
                    </div>
                  </div>
                  <div className="keeper-card__body stack">
                    {form ? (
                      <div className={styles.formGrid}>
                        <label className="field">
                          <span className="field__label">显示名（displayName）</span>
                          <input
                            className="input"
                            value={form.displayName}
                            disabled={!canWrite || updateAccount.isPending}
                            onChange={(event) =>
                              setForm((previous) =>
                                previous ? { ...previous, displayName: event.target.value } : previous,
                              )
                            }
                          />
                        </label>
                        <label className="field">
                          <span className="field__label">最大并发（maxConcurrent，0–10000）</span>
                          <input
                            className="input"
                            inputMode="numeric"
                            value={form.maxConcurrent}
                            disabled={!canWrite || updateAccount.isPending}
                            onChange={(event) =>
                              setForm((previous) =>
                                previous ? { ...previous, maxConcurrent: event.target.value } : previous,
                              )
                            }
                          />
                        </label>
                        <label className={`field ${styles.inlineSwitch}`}>
                          <span className="field__label">启用（enabled）</span>
                          <input
                            type="checkbox"
                            checked={form.enabled}
                            disabled={!canWrite || updateAccount.isPending}
                            onChange={(event) =>
                              setForm((previous) =>
                                previous ? { ...previous, enabled: event.target.checked } : previous,
                              )
                            }
                          />
                        </label>
                      </div>
                    ) : (
                      <span className="text-tertiary">正在读取可编辑字段…</span>
                    )}
                    {formError ? (
                      <div className="error-box" role="alert">
                        {formError}
                      </div>
                    ) : null}
                    <div className={styles.rowActions}>
                      <button
                        type="button"
                        className="btn btn--primary"
                        disabled={!canWrite || updateAccount.isPending || !form}
                        onClick={() => void save()}
                      >
                        {updateAccount.isPending ? '保存中…' : '保存修改（PATCH）'}
                      </button>
                      <button
                        type="button"
                        className="btn btn--secondary"
                        disabled={detail.isFetching}
                        onClick={() => void detail.refetch()}
                      >
                        {detail.isFetching ? '重新读取中…' : '重新读取最新版本'}
                      </button>
                    </div>

                    <div className={styles.rowActions}>
                      <button
                        type="button"
                        className="btn btn--sm btn--secondary"
                        disabled={!canWrite || refreshToken.isPending}
                        onClick={() =>
                          void runAction(
                            '刷新令牌',
                            () => refreshToken.mutateAsync({ accountId: summary.accountId }),
                            {
                              successText: (response) => {
                                const status = (response.data as { status?: string } | null)?.status;
                                return `刷新令牌已同步返回（HTTP ${response.status}）${status ? `，上游状态：${status}` : ''}。`;
                              },
                            },
                          )
                        }
                      >
                        {refreshToken.isPending ? '刷新中…' : '刷新令牌'}
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm btn--secondary"
                        disabled={!canWrite || refreshUsage.isPending}
                        onClick={() =>
                          void runAction('刷新用量', () => refreshUsage.mutateAsync({ accountId: summary.accountId }), {
                            trackOrigin: `账号刷新用量（${summary.displayName}）`,
                          })
                        }
                      >
                        {refreshUsage.isPending ? '提交中…' : '刷新用量（202）'}
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm btn--secondary"
                        disabled={!canWrite || clearErrors.isPending}
                        onClick={() =>
                          void runAction('清除运行时错误', () =>
                            clearErrors.mutateAsync({ accountId: summary.accountId }),
                          )
                        }
                      >
                        {clearErrors.isPending ? '清除中…' : '清除错误记录'}
                      </button>
                      <DangerConfirmButton
                        label="清除亲和性"
                        resourceName={`${summary.displayName}（${summary.accountId}）`}
                        impact={
                          <span>
                            将清除上游记录的账号/线路亲和性（affinity）。已知影响：后续请求不再沿用原亲和目标，
                            可能需要重新选择账号；不会删除账号或凭据。此动作不可撤销。
                          </span>
                        }
                        className="btn btn--sm btn--secondary"
                        disabled={!canWrite}
                        pending={clearAffinity.isPending}
                        onConfirm={() =>
                          runAction('清除亲和性', () => clearAffinity.mutateAsync({ accountId: summary.accountId }))
                        }
                      />
                    </div>

                    {value.workbuddy ? (
                      <div className="notice-box">
                        <div className="stack" style={{ gap: 6 }}>
                          <span>
                            上游在详情里返回了 workbuddy 附加信息；本版不开放 workbuddy/*
                            相关操作，因此这里只读展示。
                          </span>
                          <JsonBlock value={value.workbuddy} maxHeight={200} />
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="keeper-card keeper-card--flush">
                  <div className="keeper-card__header">
                    <div className="keeper-card__heading">
                      <span className="keeper-card__title">
                        账号模型
                      </span>
                      <span className="keeper-card__subtitle">
                        启用/禁用需要 If-Match；同步是独立的 202 任务，失败不代表授权失败。
                      </span>
                    </div>
                  </div>
                  <div className="keeper-card__body">
                    <AccountModelsSection accountId={summary.accountId} canWrite={canWrite} />
                  </div>
                </div>

                <div className="keeper-card keeper-card--flush">
                  <div className="keeper-card__header">
                    <div className="keeper-card__heading">
                      <span className="keeper-card__title">
                        危险操作
                      </span>
                      <span className="keeper-card__subtitle">
                        删除使用 DELETE（If-Match 必填，成功 204）；WebUI 不模拟级联删除。
                      </span>
                    </div>
                  </div>
                  <div className="keeper-card__body">
                    <DangerConfirmButton
                      label="删除该账号"
                      resourceName={`${summary.displayName}（${summary.accountId}）`}
                      confirmLabel="确认删除账号"
                      requiresTyping={summary.displayName}
                      disabled={!canWrite}
                      pending={deleteAccount.isPending}
                      impact={
                        <span>
                          已知影响：上游会删除该 OAuth 账号记录及其保存的凭据（DELETE 成功即 204）。
                          引用该账号的模型来源会因此失效，需要重新登录或导入；WebUI 不会级联删除其他资源，
                          也不会自动备份，删除后无法在本页面恢复。
                        </span>
                      }
                      onConfirm={async () => {
                        try {
                          await deleteAccount.mutateAsync({
                            accountId: summary.accountId,
                            ifMatch: summary.revision,
                          });
                          onDeleted(summary.accountId);
                          onClose();
                        } catch (caught) {
                          setActionError(toApiError(caught, '删除账号失败'));
                        }
                      }}
                    />
                  </div>
                </div>
              </div>
            );
          }}
        </AsyncState>
      </div>
    </Drawer>
  );
}
