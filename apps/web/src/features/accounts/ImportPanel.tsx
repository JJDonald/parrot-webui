/**
 * OAuth 账号导入面板（真实接口：POST /oauth/imports/preview → POST /oauth/imports/{importId}/commit）。
 *
 * 要求（实施文档 6.5）：
 * - 预览结果包含 importId / importSecret / candidates / errors / expiresAt；
 * - 同身份已存在（conflictAccountId）必须逐个由用户选择保留或替换，禁止静默覆盖；
 * - 部分导入失败要有明确结果，不能吞掉错误；
 * - 导入内容只在内存中（粘贴文本或读取本地文件到内存），不落本地磁盘、不发第三方；
 * - importSecret 只保存在当前页面内存（不写 URL / localStorage / sessionStorage / 日志）。
 */

import { useRef, useState, type ChangeEvent } from 'react';
import { Select } from 'antd';
import { ApiError } from '@/api/client';
import { MonoText, Pill, TimeText } from '@/components/bits';
import { ErrorNotice } from '@/components/feedback';
import { useCommitImportMutation, usePreviewImportMutation } from './accountsApi';
import { toApiError } from './errors';
import {
  IMPORT_FORMAT_LABEL,
  isExpiredAt,
  type CommitOAuthImportRequest,
  type OAuthImportCommitData,
  type OAuthImportDecisionRequest,
  type OAuthImportPreviewData,
  type PreviewOAuthImportRequest,
} from './oauthTypes';
import styles from './accounts.module.scss';

/** 与 BFF 路由清单里的 oauthImportBodyLimitBytes 默认值一致（5 MB）。 */
const IMPORT_BODY_LIMIT_BYTES = 5 * 1024 * 1024;

type ImportPreviewView = Omit<OAuthImportPreviewData, 'importSecret'>;
type Decision = OAuthImportDecisionRequest['action'];

export function ImportPanel({ canWrite, writeReason }: { canWrite: boolean; writeReason: string | null }) {
  const previewMutation = usePreviewImportMutation();
  const commitMutation = useCommitImportMutation();

  const [format, setFormat] = useState<PreviewOAuthImportRequest['format']>('openai');
  const [payloadEncoding, setPayloadEncoding] = useState<'json' | 'base64'>('json');
  const [filename, setFilename] = useState('');
  const [payload, setPayload] = useState('');
  const [preview, setPreview] = useState<ImportPreviewView | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [result, setResult] = useState<OAuthImportCommitData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  // importSecret 只在内存里，绝不进入 URL / 持久化存储 / 日志。
  const importSecretRef = useRef<string | null>(null);

  const conflicts = preview ? preview.candidates.filter((candidate) => Boolean(candidate.conflictAccountId)) : [];
  const undecidedConflicts = conflicts.filter((candidate) => !decisions[candidate.candidateId]);
  const payloadTooLarge = payload.length > IMPORT_BODY_LIMIT_BYTES;

  const resetPreviewState = () => {
    importSecretRef.current = null;
    setPreview(null);
    setDecisions({});
    setResult(null);
  };

  const runPreview = async () => {
    setError(null);
    resetPreviewState();
    try {
      const response = await previewMutation.mutateAsync({
        format,
        payload,
        payloadEncoding,
        filename: filename.trim() ? filename.trim() : null,
      });
      const data = response.data;
      if (!data) {
        throw new ApiError({
          status: response.status,
          code: 'WEBUI_UPSTREAM_UNEXPECTED_CONTENT',
          source: 'webui',
          message: '导入预览成功但上游未返回 data',
        });
      }
      const { importSecret, ...rest } = data;
      importSecretRef.current = importSecret;
      setPreview(rest);
      // 冲突候选不预选：必须由用户明确选择；无冲突候选默认写入。
      const next: Record<string, Decision> = {};
      for (const candidate of rest.candidates) {
        if (!candidate.conflictAccountId) next[candidate.candidateId] = 'overwrite';
      }
      setDecisions(next);
    } catch (caught) {
      setError(toApiError(caught, '导入预览失败'));
    }
  };
  const runCommit = async () => {
    if (!preview) return;
    const importSecret = importSecretRef.current;
    if (!importSecret) {
      setError(
        new ApiError({
          status: 0,
          code: 'WEBUI_SESSION_REQUIRED',
          source: 'webui',
          message: '当前页面内存里已没有该预览的 importSecret（可能已提交或页面刷新），请重新预览后再提交',
        }),
      );
      return;
    }
    // commit 的 schema 同时要求 decisions 与 importSecret；importSecret 只走请求体。
    const body: CommitOAuthImportRequest = {
      importSecret,
      decisions: preview.candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        // 未显式选择的（只可能是无冲突候选）按保守的 keep 处理，绝不静默覆盖。
        action: decisions[candidate.candidateId] ?? 'keep',
      })),
    };
    setError(null);
    setResult(null);
    try {
      const response = await commitMutation.mutateAsync({ importId: preview.importId, body });
      setResult(
        response.data ?? {
          added: [],
          replaced: [],
          skipped: [],
        },
      );
      // 提交完成后清理内存里的导入内容与导入密钥。
      setPayload('');
      importSecretRef.current = null;
    } catch (caught) {
      setError(toApiError(caught, '导入提交失败（结果可能未知，请刷新账号列表确认）'));
    }
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(null);
    resetPreviewState();
    if (file.size > IMPORT_BODY_LIMIT_BYTES) {
      setError(
        new ApiError({
          status: 413,
          code: 'WEBUI_PAYLOAD_TOO_LARGE',
          source: 'webui',
          message: `文件超过 ${Math.round(IMPORT_BODY_LIMIT_BYTES / 1024 / 1024)} MB，上游与本项目管理接口都不接受`,
        }),
      );
      return;
    }
    const text = await file.text();
    setPayload(text);
    setFilename(file.name);
    setPayloadEncoding('json');
  };

  const resultUnaccounted = preview && result
    ? preview.candidates.filter(
        (candidate) =>
          !result.added.includes(candidate.candidateId) &&
          !result.replaced.includes(candidate.candidateId) &&
          !result.skipped.includes(candidate.candidateId),
      )
    : [];

  return (
    <div className={styles.section}>
      <div className="keeper-card">
        <div className={styles.cardHeader}>
          <div className={styles.cardHeaderText}>
            <h2 className="keeper-card__title">批量导入 OAuth 账号</h2>
            <p className="keeper-card__subtitle">
              先预览（POST /oauth/imports/preview，返回 importId / importSecret / candidates / errors /
              expiresAt），再按候选逐条决定后提交（POST /oauth/imports/{'{importId}'}/commit）。
            </p>
          </div>
          {preview?.expiresAt ? (
            <Pill tone={isExpiredAt(preview.expiresAt) ? 'warning' : 'primary'}>
              {isExpiredAt(preview.expiresAt) ? '预览已过期' : '预览有效'}
            </Pill>
          ) : null}
        </div>

        {!canWrite ? (
          <div className="notice-box notice-box--warning" role="status" style={{ marginTop: 12 }}>
            当前会话不具备写能力{writeReason ? `（${writeReason}）` : ''}：可以查看已导入的预览结果，但不能提交导入。
          </div>
        ) : null}

        <div className={styles.formGrid} style={{ marginTop: 12 }}>
          <label className="field">
            <span className="field__label">导入格式（format）</span>
            <Select<string>
              value={format}
              onChange={(value) => setFormat(value as PreviewOAuthImportRequest['format'])}
              options={(['openai', 'cpa', 'sub2api'] as const).map((item) => ({
                value: item,
                label: IMPORT_FORMAT_LABEL[item],
              }))}
              aria-label="导入格式"
            />
          </label>
          <label className="field">
            <span className="field__label">内容编码（payloadEncoding）</span>
            <Select<string>
              value={payloadEncoding}
              onChange={(value) => setPayloadEncoding(value === 'base64' ? 'base64' : 'json')}
              options={[
                { value: 'json', label: 'JSON 文本（json）' },
                { value: 'base64', label: 'Base64（base64）' },
              ]}
              aria-label="内容编码"
            />
          </label>
          <label className="field">
            <span className="field__label">文件名（可选，filename）</span>
            <input
              className="input"
              value={filename}
              autoComplete="off"
              spellCheck={false}
              placeholder="例如 credentials.json"
              onChange={(event) => setFilename(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">从本地文件读取到内存（不落磁盘）</span>
            <input
              className="input"
              type="file"
              accept=".json,.txt,application/json,text/plain"
              onChange={(event) => void onFile(event)}
            />
            <span className="field__hint">
              文件内容只在本页面内存里用于本次预览与提交，不写入本地磁盘、不上传第三方分析服务。
            </span>
          </label>
        </div>

        <label className="field" style={{ marginTop: 12 }}>
          <span className="field__label">导入内容（payload，直接粘贴或由上面的文件读入）</span>
          <textarea
            className={`input ${styles.payloadArea}`}
            value={payload}
            spellCheck={false}
            autoComplete="off"
            placeholder='例如 {"tokens": [...]} 或 base64 字符串'
            onChange={(event) => setPayload(event.target.value)}
          />
          <span className={payloadTooLarge ? 'field__hint text-secondary' : 'field__hint'}>
            当前 {payload.length.toLocaleString('zh-CN')} 字符
            {payloadTooLarge ? `：超过 ${Math.round(IMPORT_BODY_LIMIT_BYTES / 1024 / 1024)} MB 上限，请拆分后再导入。` : ''}
          </span>
        </label>

        <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canWrite || previewMutation.isPending || payload.trim().length === 0 || payloadTooLarge}
            onClick={() => void runPreview()}
          >
            {previewMutation.isPending ? '预览中…' : '预览导入（preview）'}
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            disabled={!payload}
            onClick={() => {
              setPayload('');
              setFilename('');
              resetPreviewState();
              setError(null);
            }}
          >
            清空内容
          </button>
          <span className={styles.hint}>
            importSecret 只保留在当前页面内存中（不写入 URL、localStorage / sessionStorage）；提交时只作为请求体字段发送，
            刷新后需要重新预览。
          </span>
        </div>
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      {preview ? (
        <div className="keeper-card">
          <div className={styles.cardHeader}>
            <div className={styles.cardHeaderText}>
              <h3 className="keeper-card__title">
                预览结果
              </h3>
              <span className="keeper-card__subtitle">
                importId：<span className={styles.mono}>{preview.importId}</span>；有效期至{' '}
                <TimeText value={preview.expiresAt} withSeconds />
              </span>
            </div>
            <div className={styles.stageBar}>
              <Pill tone="primary">{preview.candidates.length} 个候选</Pill>
              {preview.errors.length > 0 ? <Pill tone="warning">{preview.errors.length} 项无法解析</Pill> : null}
              {conflicts.length > 0 ? <Pill tone="warning">{conflicts.length} 个同身份冲突</Pill> : null}
            </div>
          </div>

          {conflicts.length > 0 ? (
            <div className={`${styles.stageNotice} ${styles.stageNoticeWarning}`} style={{ marginTop: 12 }} role="alert">
              <strong>同身份账号已存在，必须逐条选择</strong>
              <span>
                下面 {conflicts.length} 个候选与现有账号身份相同。WebUI 不会静默覆盖：请对每个候选明确选择
                “保留现有账号”或“用导入内容替换”。未选择的冲突候选会阻止提交。
              </span>
            </div>
          ) : null}

          {preview.errors.length > 0 ? (
            <div className="notice-box notice-box--warning" style={{ marginTop: 12 }} role="status">
              <div className="stack" style={{ gap: 4 }}>
                <strong>以下条目无法解析，不会被导入（部分导入失败）</strong>
                {preview.errors.map((problem, index) => (
                  <span key={`${problem.code}-${problem.index ?? index}`}>
                    [{problem.code}
                    {typeof problem.index === 'number' ? ` · 第 ${problem.index + 1} 项` : ''}] {problem.message}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className={styles.candidateList} style={{ marginTop: 12 }}>
            {preview.candidates.length === 0 ? (
              <span className="text-tertiary">上游没有返回任何可导入候选（不要据此认为导入成功）。</span>
            ) : (
              preview.candidates.map((candidate) => {
                const conflict = Boolean(candidate.conflictAccountId);
                return (
                  <div
                    key={candidate.candidateId}
                    className={`${styles.candidate} ${conflict ? styles.candidateConflict : ''}`}
                  >
                    <div className={styles.candidateInfo}>
                      <span className={styles.candidateTitle}>{candidate.displayName}</span>
                      <span className={styles.mono}>{candidate.identity}</span>
                      <span className={styles.hint}>
                        候选 ID：{candidate.candidateId} · 供应商：{candidate.provider}
                        {conflict ? ` · 同身份已存在于账号 ${candidate.conflictAccountId}` : ' · 无同身份冲突'}
                      </span>
                    </div>
                    <div className={styles.decisionGroup}>
                      <label className={styles.decisionOption}>
                        <input
                          type="radio"
                          name={`decision-${candidate.candidateId}`}
                          checked={decisions[candidate.candidateId] === 'keep'}
                          onChange={() =>
                            setDecisions((previous) => ({ ...previous, [candidate.candidateId]: 'keep' }))
                          }
                        />
                        {conflict ? '保留现有账号（跳过导入）' : '跳过该候选'}
                      </label>
                      <label className={styles.decisionOption}>
                        <input
                          type="radio"
                          name={`decision-${candidate.candidateId}`}
                          checked={decisions[candidate.candidateId] === 'overwrite'}
                          onChange={() =>
                            setDecisions((previous) => ({ ...previous, [candidate.candidateId]: 'overwrite' }))
                          }
                        />
                        {conflict ? '用导入内容替换现有账号' : '导入为新账号'}
                      </label>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <button
              type="button"
              className="btn btn--primary"
              disabled={
                !canWrite ||
                commitMutation.isPending ||
                preview.candidates.length === 0 ||
                undecidedConflicts.length > 0 ||
                Boolean(result)
              }
              onClick={() => void runCommit()}
            >
              {commitMutation.isPending ? '提交中…' : '提交导入（commit）'}
            </button>
            {undecidedConflicts.length > 0 ? (
              <span className={styles.hint}>
                还有 {undecidedConflicts.length} 个同身份候选未选择（不会替你决定）。
              </span>
            ) : null}
            {result ? <span className={styles.hint}>本次预览已提交完成，如需再次导入请重新预览。</span> : null}
          </div>
        </div>
      ) : null}

      {result ? (
        <div className="keeper-card">
          <div className={styles.cardHeaderText}>
            <h3 className="keeper-card__title">
              导入结果
            </h3>
            <span className="keeper-card__subtitle">
              这些是上游实际返回的结果（added / replaced / skipped）；没有静默覆盖。
            </span>
          </div>
          <div className="stack" style={{ marginTop: 12, gap: 8 }}>
            <div className={styles.resultList}>
              <Pill tone="success">新增 {result.added.length}</Pill>
              <Pill tone="warning">替换 {result.replaced.length}</Pill>
              <Pill tone="muted">跳过 {result.skipped.length}</Pill>
            </div>
            {result.added.length > 0 ? (
              <span>
                新增账号：<span className={styles.mono}>{result.added.join('、')}</span>
              </span>
            ) : null}
            {result.replaced.length > 0 ? (
              <span>
                已替换账号：<span className={styles.mono}>{result.replaced.join('、')}</span>
              </span>
            ) : null}
            {result.skipped.length > 0 ? (
              <span>
                跳过（按你的选择保留现状）：<span className={styles.mono}>{result.skipped.join('、')}</span>
              </span>
            ) : null}
            {resultUnaccounted.length > 0 ? (
              <div className="notice-box notice-box--warning" role="status">
                有 {resultUnaccounted.length} 个候选没有出现在上游结果里（
                <span className={styles.mono}>
                  {resultUnaccounted.map((candidate) => candidate.candidateId).join('、')}
                </span>
                ）：请刷新账号列表确认实际状态，不要直接重复提交。
              </div>
            ) : null}
            {preview && preview.errors.length > 0 ? (
              <span className={styles.hint}>
                另有 {preview.errors.length} 项在预览阶段就无法解析，本次未导入（见上方错误列表）。
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
