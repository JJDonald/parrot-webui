/**
 * 通用展示组件：徽标、状态点、时间、可复制文本、秘密值、原始内容。
 *
 * 安全约定：秘密值只在当前视图内存中存在；原始内容一律按纯文本渲染（禁止 dangerouslySetInnerHTML）。
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';

export type Tone = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'muted';

export function Pill({
  children,
  tone = 'default',
  mono,
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  mono?: boolean;
  title?: string;
}) {
  const className = ['pill', tone !== 'default' ? `pill--${tone}` : '', mono ? 'pill--mono' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <span className={className} title={title}>
      {children}
    </span>
  );
}

export function StatusDot({ tone, label }: { tone: 'running' | 'success' | 'danger' | 'idle'; label?: string }) {
  const suffix = tone === 'idle' ? '' : ` status-dot--${tone}`;
  return (
    <span className="row" style={{ gap: 6 }}>
      <span className={`status-dot${suffix}`} aria-hidden="true" />
      {label ? <span className="text-sm">{label}</span> : null}
    </span>
  );
}

export function MonoText({ children, truncate }: { children: ReactNode; truncate?: boolean }) {
  return <span className={truncate ? 'mono cell--truncate' : 'mono'}>{children}</span>;
}

/** 显示时间；null/undefined 显示“未知”，绝不显示为 0 或当前时间。 */
export function TimeText({ value, withSeconds = false }: { value: unknown; withSeconds?: boolean }) {
  if (typeof value !== 'string' || !value) return <span className="text-tertiary">未知</span>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <span className="text-tertiary">未知</span>;
  const text = withSeconds
    ? date.toLocaleString('zh-CN', { hour12: false })
    : date.toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return <span title={date.toISOString()}>{text}</span>;
}

export function RelativeTime({ value }: { value: unknown }) {
  const [, force] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => force((tick) => tick + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  if (typeof value !== 'string' || !value) return <span className="text-tertiary">未知</span>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <span className="text-tertiary">未知</span>;
  const deltaSeconds = Math.round((Date.now() - date.getTime()) / 1000);
  const text =
    deltaSeconds < 60
      ? `${Math.max(0, deltaSeconds)} 秒前`
      : deltaSeconds < 3600
        ? `${Math.round(deltaSeconds / 60)} 分钟前`
        : deltaSeconds < 86400
          ? `${Math.round(deltaSeconds / 3600)} 小时前`
          : `${Math.round(deltaSeconds / 86400)} 天前`;
  return <span title={date.toISOString()}>{text}</span>;
}

export function CopyableText({ value, label, mask }: { value: string | null | undefined; label?: string; mask?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(!mask);
  if (value === null || value === undefined || value === '') {
    return <span className="text-tertiary">未提供</span>;
  }
  const display = revealed ? value : `${value.slice(0, 4)}••••${value.slice(-4)}`;
  return (
    <span className="row" style={{ gap: 6, minWidth: 0 }}>
      <MonoText truncate>{display}</MonoText>
      {mask ? (
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => setRevealed((current) => !current)}>
          {revealed ? '隐藏' : '显示'}
        </button>
      ) : null}
      <button
        type="button"
        className="btn btn--sm btn--ghost"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? '已复制' : '复制'}
      </button>
      {label ? <span className="text-tertiary text-sm">{label}</span> : null}
    </span>
  );
}

/**
 * 秘密值展示：默认掩码，仅在用户主动展开时显示，并提示"离开页面后不再可见"。
 * 不做任何持久化（不写 localStorage/sessionStorage）。
 */
export function SecretReveal({
  value,
  description = '该值只在本视图内可见，刷新或离开后不会再显示。',
}: {
  value: string | null | undefined;
  description?: string;
}) {
  const [visible, setVisible] = useState(false);
  if (!value) {
    return <span className="text-tertiary">上游未返回秘密值</span>;
  }
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row">
        <MonoText truncate>{visible ? value : '••••••••••••••••••••••••'}</MonoText>
        <button type="button" className="btn btn--sm btn--secondary" onClick={() => setVisible((current) => !current)}>
          {visible ? '隐藏' : '显示'}
        </button>
        <button
          type="button"
          className="btn btn--sm btn--secondary"
          onClick={() => {
            void navigator.clipboard.writeText(value);
          }}
        >
          复制
        </button>
      </div>
      <span className="text-sm text-secondary">{description}</span>
    </div>
  );
}

/** 原始内容（日志正文、任务结果）：只读纯文本或受控 JSON，绝不渲染 HTML。 */
export function JsonBlock({ value, maxHeight = 320 }: { value: unknown; maxHeight?: number }) {
  const text = useMemo(() => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);
  if (!text) return <span className="text-tertiary">无内容</span>;
  return (
    <pre className="raw-block" style={{ maxHeight }} tabIndex={0}>
      {text}
    </pre>
  );
}

export function KeyValueList({
  items,
  columns = 2,
}: {
  items: Array<{ label: string; value: ReactNode; hint?: ReactNode }>;
  columns?: number;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fit, minmax(${columns >= 2 ? 220 : 320}px, 1fr))`,
        gap: 12,
      }}
    >
      {items.map((item) => (
        <div key={item.label} className="field">
          <span className="field__label">{item.label}</span>
          <span>{item.value}</span>
          {item.hint ? <span className="field__hint">{item.hint}</span> : null}
        </div>
      ))}
    </div>
  );
}

export function StatCard({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone }) {
  const color =
    tone === 'danger'
      ? 'var(--danger-color)'
      : tone === 'success'
        ? 'var(--success-color)'
        : tone === 'warning'
          ? 'var(--warning-color)'
          : undefined;
  return (
    <div className="stat-card">
      <span className="stat-card__label">{label}</span>
      <span className="stat-card__value" style={color ? { color } : undefined}>
        {value}
      </span>
      {hint ? <span className="stat-card__hint">{hint}</span> : null}
    </div>
  );
}

/**
 * 危险操作（删除、吊销、清空）前的确认：展示资源名与实际已知影响。
 * 不模拟级联删除，只陈述上游已知语义。
 */
export function DangerConfirmButton({
  label,
  resourceName,
  impact,
  confirmLabel = '确认执行',
  onConfirm,
  pending,
  disabled,
  requiresTyping,
  className = 'btn btn--sm btn--danger',
}: {
  label: string;
  resourceName: string;
  impact: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  pending?: boolean;
  disabled?: boolean;
  requiresTyping?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const locked = Boolean(requiresTyping) && typed !== requiresTyping;

  return (
    <>
      <button type="button" className={className} disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </button>
      {open ? (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal" style={{ maxWidth: 480 }}>
            <div className="modal-header">
              <strong>{label}</strong>
            </div>
            <div className="modal-body stack">
              <div>
                目标：<strong>{resourceName}</strong>
              </div>
              <div className="notice-box notice-box--warning">{impact}</div>
              {requiresTyping ? (
                <label className="field">
                  <span className="field__label">请输入 {requiresTyping} 以确认</span>
                  <input className="input" value={typed} onChange={(event) => setTyped(event.target.value)} />
                </label>
              ) : null}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn--ghost" onClick={() => setOpen(false)} disabled={pending}>
                取消
              </button>
              <button
                type="button"
                className="btn btn--danger"
                disabled={pending || locked}
                onClick={async () => {
                  await onConfirm();
                  setOpen(false);
                  setTyped('');
                }}
              >
                {pending ? '执行中…' : confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
