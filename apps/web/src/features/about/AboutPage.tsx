/**
 * 版本与诊断页（实施文档 6.1 / 8.1 的系统信息部分）。
 *
 * 数据来源只有 BFF 自带的 GET /bff/diagnostics（经 @/api/client 的 bff.diagnostics()）：
 * 这里不拼接 URL、不自己 fetch，也不读取原 Parrot 容器的配置或数据目录。
 * 页面只展示 BFF 已经脱敏的信息（诊断响应里不含管理密钥、上游凭证与 Cookie）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, bff, type DiagnosticsResponse } from '@/api/client';
import { useAuth } from '@/app/AuthProvider';
import { KeyValueList, MonoText, Pill, RelativeTime, StatCard, TimeText } from '@/components/bits';
import { AsyncState } from '@/components/state';
import styles from './AboutPage.module.scss';

/** BFF 限流/超时配置的中文标签；未知键保留 BFF 原样键名。 */
const LIMIT_LABELS: Record<string, string> = {
  loginPerSourcePerMinute: '登录：单来源每分钟上限',
  loginGlobalPerMinute: '登录：全局每分钟上限',
  bootstrapPerSourcePerMinute: 'bootstrap：单来源每分钟上限',
  bootstrapGlobalPerMinute: 'bootstrap：全局每分钟上限',
  defaultBodyLimitBytes: '默认请求体上限（字节）',
  oauthImportBodyLimitBytes: 'OAuth 导入请求体上限（字节）',
  maxUpstreamResponseBytes: '上游响应体上限（字节）',
  connectTimeoutMs: '连接上游超时（毫秒）',
  requestTimeoutMs: '上游请求超时（毫秒）',
};

function formatCount(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未知';
  return value.toLocaleString('zh-CN');
}

function formatSeconds(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '未知';
  const days = Math.floor(value / 86_400);
  const hours = Math.floor((value % 86_400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = Math.floor(value % 60);
  const parts: string[] = [];
  if (days) parts.push(`${days} 天`);
  if (hours) parts.push(`${hours} 小时`);
  if (minutes) parts.push(`${minutes} 分钟`);
  parts.push(`${seconds} 秒`);
  return parts.join(' ');
}

function formatMilliseconds(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未提供';
  return `${value.toLocaleString('zh-CN')} ms`;
}

/** 诊断里的 checkedAt 是毫秒时间戳；缺失时返回 null，由调用方显示“未知”。 */
function isoFromMilliseconds(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value).toISOString();
}

export function AboutPage() {
  const { capabilities } = useAuth();
  const [payload, setPayload] = useState<DiagnosticsResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await bff.diagnostics(controller.signal);
      if (controllerRef.current !== controller) return;
      if (!response.data) {
        throw new ApiError({
          status: 500,
          code: 'WEBUI_INTERNAL',
          source: 'webui',
          message: '诊断接口返回了空数据',
        });
      }
      setPayload(response.data);
      setLoadedAt(new Date());
    } catch (caught) {
      if (controllerRef.current !== controller) return;
      if (caught instanceof Error && caught.name === 'AbortError') return;
      setError(
        caught instanceof ApiError
          ? caught
          : new ApiError({
              status: 0,
              code: 'WEBUI_NETWORK_ERROR',
              source: 'network',
              message: '读取诊断信息失败',
            }),
      );
    } finally {
      if (controllerRef.current === controller) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => controllerRef.current?.abort();
    // 进入页面读取一次；之后的刷新由“重新检测”按钮手动触发（诊断本身会触发一次上游探测）
  }, [load]);

  const loadedIso = loadedAt ? loadedAt.toISOString() : null;

  return (
    <div className={styles.page}>
      <section className="keeper-card">
        <div className="keeper-card__header">
          <div className="keeper-card__heading">
            <span className="app-topbar__eyebrow">About</span>
            <h2 className="keeper-card__title">版本与诊断</h2>
            <p className="keeper-card__subtitle">
              全部信息来自 WebUI 后端（BFF）的脱敏诊断接口 <span className="mono">GET /bff/diagnostics</span>；
              该接口只做只读探测，不写任何配置。
            </p>
          </div>
          <div className={styles.headActions}>
            <button type="button" className="btn btn--sm btn--secondary" onClick={() => void load()} disabled={loading}>
              {loading ? '检测中…' : '重新检测'}
            </button>
          </div>
        </div>
        <div className="keeper-card__body">
          <div className={styles.sectionBody}>
            <div className="notice-box" role="note">
              <div className={styles.sectionBody}>
                <strong>WebUI 不修改原 Parrot 容器</strong>
                <span>
                  这个管理台是独立的旁路客户端：不写入、不重启、不更新原 Parrot 容器与镜像，不读取原数据目录，
                  也不代取原实例的管理密钥。它只在获得授权后调用原实例既有管理 API 中已冻结的操作，
                  且允许清单外的能力（更新、重启、系统/网络/MCP 配置等）不会被调用。
                  “重新检测”只是让 BFF 再探测一次上游可达性，不会改变上游状态。
                </span>
              </div>
            </div>
            <div className={styles.note}>
              最近一次读取诊断的时间：
              {loadedIso ? (
                <>
                  {' '}
                  <RelativeTime value={loadedIso} /> <TimeText value={loadedIso} withSeconds />
                </>
              ) : (
                ' 尚未成功读取'
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="keeper-card">
        <div className="keeper-card__header">
          <div className="keeper-card__heading">
            <h3 className="keeper-card__title">诊断结果</h3>
            <p className="keeper-card__subtitle">
              加载中 / 加载失败 / 权限不足 / 连接中断都会在这里明确区分；刷新失败会保留上次成功快照并标注“数据可能已过期”。
            </p>
          </div>
        </div>
        <div className="keeper-card__body">
          <AsyncState<DiagnosticsResponse>
            isLoading={loading}
            error={error}
            data={payload ?? undefined}
            isStale={Boolean(error) && Boolean(payload)}
            onRetry={() => void load()}
            loadingLabel="正在读取脱敏诊断信息…"
          >
            {(data) => {
              const checkedIso = isoFromMilliseconds(data.upstream.checkedAt);
              const limitEntries = Object.entries(data.limits ?? {});
              return (
                <div className={styles.sectionBody}>
                  <div>
                    <div className="field__label">WebUI 实例</div>
                    <div className="stat-grid">
                      <StatCard label="WebUI 版本" value={data.webui.version || '未知'} hint="BFF 构建版本" />
                      <StatCard label="运行时长" value={formatSeconds(data.webui.uptimeSeconds)} hint="自 BFF 进程启动" />
                      <StatCard label="base path" value={data.webui.basePath || '未知'} hint="部署子路径（与静态资源、Cookie Path 一致）" />
                      <StatCard label="对外地址" value={data.webui.publicOrigin || '未知'} hint="反向代理对外 origin" />
                      <StatCard label="实例名称" value={data.webui.instanceName || '未知'} hint="WEBUI_INSTANCE_NAME" />
                      <StatCard label="Node 运行时" value={data.webui.nodeVersion || '未知'} hint="BFF 所在进程的 Node 版本" />
                      <StatCard
                        label="安全 Cookie"
                        value={data.webui.cookieSecure ? '已启用' : '未启用'}
                        tone={data.webui.cookieSecure ? 'success' : 'warning'}
                        hint="未启用表示当前通过明文 HTTP 访问"
                      />
                    </div>
                    <KeyValueList
                      items={[
                        { label: '启动时间', value: <TimeText value={data.webui.startedAt} withSeconds /> },
                        { label: '启动距今', value: <RelativeTime value={data.webui.startedAt} /> },
                      ]}
                    />
                  </div>

                  <div>
                    <div className="field__label">上游 Parrot 可达性与探测结果</div>
                    <div className="stat-grid">
                      <StatCard
                        label="上游可达"
                        value={data.upstream.reachable ? '可达' : '不可达'}
                        tone={data.upstream.reachable ? 'success' : 'danger'}
                        hint="BFF 对上游管理 API 的最近探测"
                      />
                      <StatCard
                        label="管理 API"
                        value={data.upstream.managementApiDetected ? '已检测到' : '未检测到'}
                        tone={data.upstream.managementApiDetected ? 'success' : 'warning'}
                        hint="是否在预期路径发现管理运行时"
                      />
                      <StatCard label="上游状态码" value={formatCount(data.upstream.status)} hint="最近一次探测的 HTTP 状态" />
                      <StatCard label="探测延迟" value={formatMilliseconds(data.upstream.latencyMs)} hint="BFF → 上游管理 API" />
                    </div>
                    <KeyValueList
                      items={[
                        { label: '上游地址（展示用）', value: <MonoText truncate>{data.upstream.origin || '未提供'}</MonoText> },
                        {
                          label: '上游错误码',
                          value: data.upstream.errorCode ? <MonoText>{data.upstream.errorCode}</MonoText> : '无',
                        },
                        {
                          label: '探测时间',
                          value: checkedIso ? (
                            <>
                              <RelativeTime value={checkedIso} /> <TimeText value={checkedIso} withSeconds />
                            </>
                          ) : (
                            '未知'
                          ),
                        },
                      ]}
                    />
                    <p className={styles.note}>
                      WebUI 自身进程存活状态不在这里判断：容器健康检查请用 <span className="mono">/health/live</span> 与{' '}
                      <span className="mono">/health/ready</span>。
                    </p>
                  </div>

                  <div>
                    <div className="field__label">上游契约来源</div>
                    <KeyValueList
                      items={[
                        { label: '仓库', value: <MonoText>{data.contract.repository || '未知'}</MonoText> },
                        { label: '提交', value: <MonoText>{data.contract.commit || '未知'}</MonoText> },
                        { label: '发布版本', value: data.contract.release || '未知' },
                        {
                          label: '管理操作数',
                          value: formatCount(data.contract.operationCount),
                          hint: '冻结允许清单来自同一份 OpenAPI 快照',
                        },
                        { label: '路径数', value: formatCount(data.contract.pathCount) },
                        { label: '路由数', value: formatCount(data.contract.routerCount) },
                        {
                          label: '快照哈希',
                          value: <MonoText truncate>{data.contract.snapshotSha256 || '未知'}</MonoText>,
                          hint: 'OpenAPI 快照 SHA-256',
                        },
                      ]}
                    />
                    <p className={styles.note}>
                      这里展示的是构建时冻结的契约事实，不是运行时从上游抓取的版本；不把“操作数相等”当作启动条件，
                      缺失的字段会显示未知。
                    </p>
                  </div>

                  <div>
                    <div className="field__label">允许清单路由</div>
                    <div className="stat-grid">
                      <StatCard
                        label="可代理路由"
                        value={formatCount(data.allowlist.routeCount)}
                        hint="BFF 唯一允许转发的管理路由数，其余一律拒绝"
                      />
                      <StatCard
                        label="认证专用路由"
                        value={formatCount(data.allowlist.authRouteCount)}
                        hint="仅 BFF 认证控制器可调用，不进入通用业务代理"
                      />
                    </div>
                    <p className={styles.note}>
                      未列入冻结清单的管理操作会被 BFF 直接拒绝（<span className="mono">WEBUI_ROUTE_NOT_ALLOWED</span>），
                      因此本管理台不会调用更新、重启、系统/网络/MCP 配置等高风险能力。
                    </p>
                    {data.allowlist.notes.length ? (
                      <div className={styles.scroll}>
                        <div className={`keeper-table ${styles.table}`}>
                          <div className={`keeper-table__header ${styles.colsAllowlist}`}>
                            <span>方法</span>
                            <span>路径</span>
                            <span>说明</span>
                          </div>
                          {data.allowlist.notes.map((entry) => (
                            <div
                              key={`${entry.method} ${entry.path}`}
                              className={`keeper-table__row ${styles.colsAllowlist}`}
                              style={{ cursor: 'default' }}
                            >
                              <span className="cell">
                                <Pill mono>{entry.method}</Pill>
                              </span>
                              <span className="cell">
                                <MonoText truncate>{entry.path}</MonoText>
                              </span>
                              <span className="cell">{entry.note ?? '—'}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <p className={styles.note}>BFF 未返回带说明的允许清单条目。</p>
                    )}
                    <p className={styles.note}>
                      上表只是清单中带备注的部分条目（BFF 最多返回 40 条），完整清单以构建时的冻结路由表为准。
                    </p>
                  </div>

                  <div>
                    <div className="field__label">当前会话摘要</div>
                    {data.session ? (
                      <>
                        <KeyValueList
                          items={[
                            {
                              label: '会话 ID',
                              value: <MonoText truncate>{data.session.summary.sessionId ?? '未提供'}</MonoText>,
                            },
                            {
                              label: '主体 ID',
                              value: <MonoText truncate>{data.session.summary.subjectId ?? '未提供'}</MonoText>,
                            },
                            { label: '认证方式', value: data.session.summary.authMethod ?? '未提供' },
                            {
                              label: '上游角色',
                              value: data.session.summary.roles?.length ? data.session.summary.roles.join('、') : '未提供',
                            },
                            {
                              label: '上游会话签发',
                              value: <TimeText value={data.session.summary.issuedAt} withSeconds />,
                            },
                            {
                              label: '上游会话过期',
                              value: <TimeText value={data.session.summary.expiresAt} withSeconds />,
                            },
                            {
                              label: '上游空闲过期',
                              value: <TimeText value={data.session.summary.idleExpiresAt} withSeconds />,
                            },
                            { label: '本地会话创建', value: <TimeText value={data.session.createdAt} withSeconds /> },
                            { label: '本地会话过期', value: <TimeText value={data.session.localExpiresAt} withSeconds /> },
                            { label: '本地空闲过期', value: <TimeText value={data.session.localIdleExpiresAt} withSeconds /> },
                            {
                              label: '上游空闲过期（BFF 已知）',
                              value: <TimeText value={data.session.upstreamIdleExpiresAt} withSeconds />,
                            },
                            {
                              label: '最近一次上游会话刷新',
                              value: <RelativeTime value={data.session.lastUpstreamRefreshAt} />,
                            },
                          ]}
                        />
                        <div className={styles.sectionBody}>
                          <span className="field__label">上游会话 capabilities（来自上游会话摘要）</span>
                          {data.session.summary.capabilities?.length ? (
                            <div className={styles.capabilities}>
                              {data.session.summary.capabilities.map((capability) => (
                                <Pill key={capability} mono>
                                  {capability}
                                </Pill>
                              ))}
                            </div>
                          ) : (
                            <span className="text-tertiary">上游未返回能力列表</span>
                          )}
                          <span className="field__label">BFF 判定 capabilities（本地会话）</span>
                          {capabilities.length ? (
                            <div className={styles.capabilities}>
                              {capabilities.map((capability) => (
                                <Pill key={capability} mono>
                                  {capability}
                                </Pill>
                              ))}
                            </div>
                          ) : (
                            <span className="text-tertiary">本地会话未拿到能力列表（可能刚过期，或上游未返回）</span>
                          )}
                          <span className={styles.note}>
                            能力列表按上游真实结构展示，不映射成角色矩阵；界面隐藏按钮只是体验优化，实际权限仍由上游再次校验。
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="notice-box notice-box--warning" role="status">
                        诊断没有返回会话摘要（会话可能刚刚过期或已被判定失效）。请重新登录后再检测。
                      </div>
                    )}
                  </div>

                  <div>
                    <div className="field__label">会话与限流配置（BFF 进程配置）</div>
                    <div className="stat-grid">
                      <StatCard
                        label="活跃本地会话"
                        value={formatCount(data.sessions.active)}
                        hint={`上限 ${formatCount(data.sessions.maxSessions)}`}
                      />
                      <StatCard
                        label="预登录会话"
                        value={formatCount(data.sessions.prelogin)}
                        hint={`上限 ${formatCount(data.sessions.maxPrelogin)}`}
                      />
                    </div>
                    {limitEntries.length ? (
                      <KeyValueList
                        items={limitEntries.map(([key, value]) => ({
                          label: LIMIT_LABELS[key] ?? `${key}（BFF 未命名项）`,
                          value: formatCount(value),
                        }))}
                      />
                    ) : (
                      <p className={styles.note}>BFF 未返回限流配置。</p>
                    )}
                    <p className={styles.note}>
                      这些是 WebUI 进程自身的限流与超时配置，不是 Parrot 的运行参数；调整它们需要修改部署配置并重启
                      WebUI 容器，本页面不提供修改入口。
                    </p>
                  </div>

                  <div className="notice-box" role="note">
                    诊断信息已脱敏：不包含管理密钥、上游会话凭证、Cookie 内容与任何秘密值；上游地址只是展示用的 origin。
                  </div>
                </div>
              );
            }}
          </AsyncState>
        </div>
      </section>
    </div>
  );
}
