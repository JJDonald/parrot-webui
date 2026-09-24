/**
 * 登录页。
 *
 * 要求（实施文档 6.2）：展示实例名（不泄露内部地址）；明确说明需要"管理密钥"而不是推理 API Key；
 * 提供显示/隐藏、提交中锁定、认证失败提示；上游未就绪时给出原因并允许手动重试；
 * 管理密钥只在该请求的内存中存在，登录后立即清空。
 */

import { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { ApiError } from '@/api/client';
import { useAuth } from '@/app/AuthProvider';
import { ErrorNotice } from '@/components/feedback';
import { Pill } from '@/components/bits';
import styles from './LoginPage.module.scss';

export function LoginPage() {
  const { status, bootstrap, upstream, login, refreshBootstrap, error, sessionLostReason } = useAuth();
  const location = useLocation();
  const requestedPath = (location.state as { from?: unknown } | null)?.from;
  const returnPath = typeof requestedPath === 'string' && /^\/(?:realtime|analysis|channels|accounts|models|api-keys|logs|tasks|about)?$/.test(requestedPath) ? requestedPath : '/';
  const [managementKey, setManagementKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loginError, setLoginError] = useState<ApiError | null>(null);
  const [probePending, setProbePending] = useState(false);

  // 离开登录页或登录成功后，立即清空输入框中的密钥
  useEffect(
    () => () => {
      setManagementKey('');
    },
    [],
  );

  if (status === 'authenticated') return <Navigate to={returnPath} replace />;

  const upstreamUnreachable = upstream ? !upstream.reachable : false;
  const managementMissing = upstream ? upstream.reachable && !upstream.managementApiDetected : false;

  return (
    <div className={styles.loginPage}>
      <div className={`stack ${styles.loginFrame}`}>
        <div className={`keeper-card ${styles.loginCard}`} style={{ borderRadius: 'var(--keeper-login-card-radius)' }}>
          <div className="keeper-card__heading" style={{ marginBottom: 16 }}>
            <span className="app-topbar__eyebrow">Parrot Management</span>
            <h1 className="keeper-card__title" style={{ fontSize: 26 }}>
              {bootstrap?.instanceName ?? 'Parrot'} 管理台
            </h1>
            <p className="keeper-card__subtitle">
              独立 WebUI，通过已有管理 API 操作同一实例；与 Telegram 管理共用业务状态。
            </p>
          </div>

          <div className="row" style={{ gap: 8, marginBottom: 16 }}>
            {bootstrap ? <Pill mono>契约 {bootstrap.contract.release}</Pill> : null}
            {bootstrap ? <Pill mono>{bootstrap.contract.operationCount} 个上游操作</Pill> : null}
            {upstream === null ? <Pill tone="muted">正在检测上游</Pill> : upstream.reachable ? <Pill tone="success">上游可达</Pill> : <Pill tone="danger">上游不可达</Pill>}
          </div>

          {upstreamUnreachable ? (
            <div className="error-box" role="alert" style={{ marginBottom: 16 }}>
              <div className="stack" style={{ gap: 6 }}>
                <strong>无法连接本机 Parrot 管理 API</strong>
                <span>
                  错误码：{upstream?.errorCode ?? 'WEBUI_UPSTREAM_UNREACHABLE'}。
                  请确认 WebUI 与 Parrot 在同一台机器、PARROT_BASE_URL 指向既有内部入口，且原实例正在运行。
                </span>
                <div>
                  <button
                    type="button"
                    className="btn btn--sm btn--secondary"
                    disabled={probePending}
                    onClick={async () => {
                      setProbePending(true);
                      try {
                        await refreshBootstrap();
                      } catch {
                        // 错误已经通过状态展示
                      } finally {
                        setProbePending(false);
                      }
                    }}
                  >
                    {probePending ? '检测中…' : '重新检测'}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {managementMissing ? (
            <div className="notice-box notice-box--warning" role="alert" style={{ marginBottom: 16 }}>
              上游可达，但没有检测到可用的管理 API（/api/management/v1）。
              当前 Parrot 版本可能未启用管理运行时，请先在原实例侧启用后再使用本管理台；WebUI 不会修改原容器。
            </div>
          ) : null}

          {sessionLostReason ? (
            <div className="notice-box notice-box--warning" role="status" style={{ marginBottom: 16 }}>
              {sessionLostReason}
            </div>
          ) : null}

          {loginError ? (
            <div style={{ marginBottom: 16 }}>
              <ErrorNotice error={loginError} />
            </div>
          ) : null}
          {error && !loginError && status === 'error' ? (
            <div style={{ marginBottom: 16 }}>
              <ErrorNotice error={error} onRetry={() => void refreshBootstrap()} />
            </div>
          ) : null}

          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (!managementKey.trim() || submitting) return;
              setSubmitting(true);
              setLoginError(null);
              try {
                await login(managementKey);
                setManagementKey('');
              } catch (caught) {
                setLoginError(
                  caught instanceof ApiError
                    ? caught
                    : new ApiError({
                        status: 0,
                        code: 'WEBUI_NETWORK_ERROR',
                        source: 'network',
                        message: '登录请求失败',
                      }),
                );
              } finally {
                setSubmitting(false);
              }
            }}
          >
            <label className="field" style={{ marginBottom: 12 }}>
              <span className="field__label">管理密钥（Management Key）</span>
              <span className="field__hint">
                这里需要 Parrot 的<strong>管理密钥</strong>，不是推理用的 API Key。密钥只用于本次登录换票，不会被 WebUI 保存。
              </span>
              <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                <input
                  className="input"
                  type={showKey ? 'text' : 'password'}
                  value={managementKey}
                  autoComplete="off"
                  autoFocus
                  spellCheck={false}
                  disabled={submitting}
                  placeholder="输入管理密钥"
                  onChange={(event) => setManagementKey(event.target.value)}
                />
                <button
                  type="button"
                  className="btn btn--sm btn--secondary"
                  onClick={() => setShowKey((value) => !value)}
                  disabled={submitting}
                  aria-pressed={showKey}
                >
                  {showKey ? '隐藏' : '显示'}
                </button>
              </div>
            </label>

            <div className="row row--between">
              <button
                type="submit"
                className="btn btn--primary"
                disabled={submitting || !managementKey.trim()}
                style={{ minWidth: 120 }}
              >
                {submitting ? '登录中…' : '登录'}
              </button>
              <span className="text-sm text-secondary">
                {bootstrap ? `本地会话空闲超时 ${Math.round(bootstrap.sessionPolicy.idleSeconds / 60)} 分钟` : ''}
              </span>
            </div>
          </form>
        </div>

        <div className={`notice-box ${styles.loginInfo}`}>
          <div className="stack" style={{ gap: 6 }}>
            <strong>关于这个管理台</strong>
            <span>
              它是 Parrot 管理 API 的独立客户端：不修改原容器与镜像，不读取原数据目录，
              上游会话凭证只保存在 WebUI 后端内存中，浏览器只持有 HttpOnly Cookie。
            </span>
            <span>
              尚未实现的登录方式：Telegram 批准登录（第二阶段）。因此这里不显示任何无法使用的登录按钮。
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
