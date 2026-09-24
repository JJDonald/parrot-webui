/**
 * OAuth 相关设置（GET /oauth/settings → PATCH /oauth/settings）。
 *
 * 字段全部来自 OAuthSettingsData / UpdateOAuthSettingsRequest：
 * cchMode、quotaMonitor{enabled,intervalSeconds,thresholdPercent}、antigravityTlsFingerprintEnabled。
 * 写入带 If-Match（读到的 revision）；409 冲突不自动覆盖。
 */

import { useEffect, useState } from 'react';
import { Select } from 'antd';
import type { ApiError } from '@/api/client';
import { MonoText, Pill } from '@/components/bits';
import { ErrorNotice } from '@/components/feedback';
import { AsyncState } from '@/components/state';
import { useOAuthSettingsQuery, useUpdateOAuthSettingsMutation } from './accountsApi';
import { toApiError } from './errors';
import { CCH_MODE_LABEL, formatBoolean, type CchMode, type OAuthSettingsData } from './oauthTypes';
import styles from './accounts.module.scss';

interface SettingsForm {
  cchMode: CchMode;
  quotaEnabled: boolean;
  quotaIntervalSeconds: string;
  quotaThresholdPercent: string;
  antigravityTlsFingerprintEnabled: boolean;
}

function toForm(settings: OAuthSettingsData): SettingsForm {
  return {
    cchMode: settings.cchMode,
    quotaEnabled: settings.quotaMonitor.enabled,
    quotaIntervalSeconds: String(settings.quotaMonitor.intervalSeconds),
    quotaThresholdPercent: String(settings.quotaMonitor.thresholdPercent),
    antigravityTlsFingerprintEnabled: settings.antigravityTlsFingerprintEnabled,
  };
}

export function OAuthSettingsPanel({ canWrite, writeReason }: { canWrite: boolean; writeReason: string | null }) {
  const query = useOAuthSettingsQuery();
  const update = useUpdateOAuthSettingsMutation();
  const settings = query.data?.data ?? null;

  const [form, setForm] = useState<SettingsForm | null>(null);
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) return;
    if (seededFor === settings.revision) return;
    setSeededFor(settings.revision);
    setForm(toForm(settings));
  }, [settings, seededFor]);

  const save = async () => {
    if (!settings || !form) return;
    setFormError(null);
    setError(null);
    setMessage(null);
    const intervalSeconds = Number(form.quotaIntervalSeconds);
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 10 || intervalSeconds > 86_400) {
      setFormError('额度监控间隔需要是 10–86400 之间的整数（上游 schema 约束）。');
      return;
    }
    const thresholdPercent = Number(form.quotaThresholdPercent);
    if (!Number.isFinite(thresholdPercent) || thresholdPercent < 1 || thresholdPercent > 100) {
      setFormError('额度监控阈值需要是 1–100 之间的数值（上游 schema 约束）。');
      return;
    }
    try {
      const response = await update.mutateAsync({
        body: {
          cchMode: form.cchMode,
          antigravityTlsFingerprintEnabled: form.antigravityTlsFingerprintEnabled,
          quotaMonitor: {
            enabled: form.quotaEnabled,
            intervalSeconds,
            thresholdPercent,
          },
        },
        ifMatch: settings.revision,
      });
      setMessage(`设置已保存（HTTP ${response.status}）。`);
    } catch (caught) {
      setError(toApiError(caught, '设置保存失败'));
    }
  };

  return (
    <div className={styles.section}>
      <div className="keeper-card">
        <div className={styles.cardHeader}>
          <div className={styles.cardHeaderText}>
            <h2 className="keeper-card__title">OAuth 相关设置</h2>
            <p className="keeper-card__subtitle">
              GET /oauth/settings 与 PATCH /oauth/settings（带 If-Match revision）。这里不包含 reset-quota、
              workbuddy/* 等本版未开放的接口。
            </p>
          </div>
          {settings ? <Pill tone="muted">revision {settings.revision}</Pill> : null}
        </div>

        {!canWrite ? (
          <div className="notice-box notice-box--warning" role="status" style={{ marginTop: 12 }}>
            当前会话不具备写能力{writeReason ? `（${writeReason}）` : ''}：可以查看设置，但不能保存。
          </div>
        ) : null}

        {message ? (
          <div className="notice-box" role="status" style={{ marginTop: 12 }}>
            {message}
          </div>
        ) : null}
        {error ? (
          <div style={{ marginTop: 12 }}>
            <ErrorNotice
              error={error}
              onResolveConflict={error.code === 'REVISION_CONFLICT' ? () => void query.refetch() : undefined}
            />
          </div>
        ) : null}
        {formError ? (
          <div className="error-box" role="alert" style={{ marginTop: 12 }}>
            {formError}
          </div>
        ) : null}

        <AsyncState
          isLoading={query.isLoading}
          error={query.error}
          data={settings ?? undefined}
          onRetry={() => void query.refetch()}
          isStale={query.isError && Boolean(settings)}
          loadingLabel="加载 OAuth 设置…"
        >
          {(value) => (
            <div className="stack" style={{ marginTop: 12, gap: 12 }}>
              <div className={styles.settingsForm}>
                <label className="field">
                  <span className="field__label">CCH 模式（cchMode）</span>
                  <Select<string>
                    value={form?.cchMode ?? value.cchMode}
                    onChange={(next) =>
                      setForm((previous) =>
                        previous ? { ...previous, cchMode: next === 'dynamic' ? 'dynamic' : 'disabled' } : previous,
                      )
                    }
                    options={[
                      { value: 'disabled', label: CCH_MODE_LABEL.disabled },
                      { value: 'dynamic', label: CCH_MODE_LABEL.dynamic },
                    ]}
                    aria-label="CCH 模式"
                    disabled={!canWrite}
                  />
                  <span className="field__hint">上游枚举只有 disabled / dynamic，不臆造其他取值。</span>
                </label>

                <label className="field">
                  <span className="field__label">额度监控（quotaMonitor.enabled）</span>
                  <span className={styles.inlineSwitch}>
                    <input
                      type="checkbox"
                      checked={form?.quotaEnabled ?? value.quotaMonitor.enabled}
                      disabled={!canWrite}
                      onChange={(event) =>
                        setForm((previous) =>
                          previous ? { ...previous, quotaEnabled: event.target.checked } : previous,
                        )
                      }
                    />
                    <span className={styles.hint}>
                      当前：{formatBoolean(value.quotaMonitor.enabled)}（上游返回区间 {value.quotaMonitor.intervalSeconds} 秒 /
                      阈值 {value.quotaMonitor.thresholdPercent}%）
                    </span>
                  </span>
                </label>

                <label className="field">
                  <span className="field__label">监控间隔（秒，10–86400）</span>
                  <input
                    className="input"
                    inputMode="numeric"
                    value={form?.quotaIntervalSeconds ?? String(value.quotaMonitor.intervalSeconds)}
                    disabled={!canWrite}
                    onChange={(event) =>
                      setForm((previous) =>
                        previous ? { ...previous, quotaIntervalSeconds: event.target.value } : previous,
                      )
                    }
                  />
                </label>

                <label className="field">
                  <span className="field__label">阈值百分比（1–100）</span>
                  <input
                    className="input"
                    inputMode="decimal"
                    value={form?.quotaThresholdPercent ?? String(value.quotaMonitor.thresholdPercent)}
                    disabled={!canWrite}
                    onChange={(event) =>
                      setForm((previous) =>
                        previous ? { ...previous, quotaThresholdPercent: event.target.value } : previous,
                      )
                    }
                  />
                </label>

                <label className="field">
                  <span className="field__label">Antigravity TLS 指纹（antigravityTlsFingerprintEnabled）</span>
                  <span className={styles.inlineSwitch}>
                    <input
                      type="checkbox"
                      checked={form?.antigravityTlsFingerprintEnabled ?? value.antigravityTlsFingerprintEnabled}
                      disabled={!canWrite}
                      onChange={(event) =>
                        setForm((previous) =>
                          previous ? { ...previous, antigravityTlsFingerprintEnabled: event.target.checked } : previous,
                        )
                      }
                    />
                    <span className={styles.hint}>
                      当前：{formatBoolean(value.antigravityTlsFingerprintEnabled)}
                    </span>
                  </span>
                </label>
              </div>

              <div className={styles.rowActions}>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={!canWrite || update.isPending || !form}
                  onClick={() => void save()}
                >
                  {update.isPending ? '保存中…' : '保存设置（PATCH）'}
                </button>
                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={query.isFetching}
                  onClick={() => void query.refetch()}
                >
                  {query.isFetching ? '重新读取中…' : '重新读取最新版本'}
                </button>
                <span className={styles.hint}>
                  服务端 revision：<MonoText>{value.revision}</MonoText>
                </span>
              </div>
            </div>
          )}
        </AsyncState>
      </div>
    </div>
  );
}
