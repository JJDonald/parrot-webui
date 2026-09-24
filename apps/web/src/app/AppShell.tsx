import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { OperationIndicator } from '@/components/OperationTrackerPanel';
import { Pill } from '@/components/bits';
import { THEME_OPTIONS, type ThemeName } from './antdTheme';

export interface NavEntry {
  to: string;
  label: string;
  icon: string;
  group: '概览' | '资源' | '运行' | '系统';
  title: string;
  eyebrow: string;
}

export const NAV_ENTRIES: NavEntry[] = [
  { to: '/', label: '总览', icon: '◎', group: '概览', title: '总览', eyebrow: 'Overview' },
  { to: '/realtime', label: '实时运行', icon: '◉', group: '概览', title: '实时运行', eyebrow: 'Realtime' },
  { to: '/analysis', label: '用量分析', icon: '◴', group: '概览', title: '用量分析', eyebrow: 'Analysis' },
  { to: '/channels', label: 'API 渠道', icon: '⇄', group: '资源', title: '第三方 API 渠道', eyebrow: 'Channels' },
  { to: '/accounts', label: 'OAuth 账号', icon: '☺', group: '资源', title: 'OAuth 账号', eyebrow: 'Accounts' },
  { to: '/models', label: '模型中心', icon: '◈', group: '资源', title: '模型中心', eyebrow: 'Models' },
  { to: '/api-keys', label: '下游 API Key', icon: '⚿', group: '资源', title: '下游 API Key', eyebrow: 'Keys' },
  { to: '/logs', label: '请求日志', icon: '≡', group: '运行', title: '请求日志', eyebrow: 'Logs' },
  { to: '/tasks', label: '管理任务', icon: '↻', group: '运行', title: '管理任务', eyebrow: 'Tasks' },
  { to: '/about', label: '版本与诊断', icon: 'ⓘ', group: '系统', title: '版本与诊断', eyebrow: 'About' },
];

export function AppShell({ theme, onThemeChange, children }: {
  theme: ThemeName;
  onThemeChange: (theme: ThemeName) => void;
  children?: ReactNode;
}) {
  const { session, upstream, bootstrap, logout, refreshSession, sessionLostReason } = useAuth();
  const location = useLocation();
  const navScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scroll = navScrollRef.current;
    const activeLink = scroll?.querySelector<HTMLElement>('[aria-current="page"]');
    if (scroll && activeLink) scroll.scrollLeft = activeLink.offsetLeft - (scroll.clientWidth - activeLink.offsetWidth) / 2;
  }, [location.pathname]);
  const [loggingOut, setLoggingOut] = useState(false);
  const active = NAV_ENTRIES.find((entry) => entry.to === '/' ? location.pathname === '/' : location.pathname.startsWith(entry.to));

  return <div className="app-shell keeper-layout">
    <div className="app-main keeper-layout__main">
      <header className="app-topbar keeper-header">
        <div className="keeper-header__brand">
          <span className="sidebar-brand__mark" aria-hidden="true">P</span>
          <span className="keeper-header__brand-text">
            <strong>{bootstrap?.instanceName ?? 'Parrot'}</strong>
            <span>Management · {active?.eyebrow ?? 'WebUI'}</span>
          </span>
        </div>
        <div className="app-topbar__actions keeper-header__actions">
          <OperationIndicator />
          {upstream && !upstream.reachable ? <Pill tone="danger">上游不可达</Pill>
            : upstream && upstream.managementApiDetected === false ? <Pill tone="warning">管理 API 未就绪</Pill>
              : <Pill tone="success">上游正常</Pill>}
          <label className="keeper-header__theme">
            <span className="visually-hidden">主题</span>
            <select className="input" value={theme} onChange={(event) => onThemeChange(event.target.value as ThemeName)} aria-label="主题">
              {THEME_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <button type="button" className="btn btn--sm btn--secondary" onClick={() => void refreshSession()}>刷新会话</button>
          <button type="button" className="btn btn--sm btn--ghost" disabled={loggingOut} onClick={async () => {
            setLoggingOut(true);
            try { await logout(); } finally { setLoggingOut(false); }
          }}>{loggingOut ? '退出中…' : '退出登录'}</button>
        </div>
      </header>

      <nav className="keeper-dock" aria-label="主导航">
        <div className="keeper-dock__scroll" ref={navScrollRef}>
          {NAV_ENTRIES.map((entry) => <NavLink key={entry.to} to={entry.to} end={entry.to === '/'} className="keeper-dock__link" title={`${entry.group} · ${entry.label}`}>
            <span className="keeper-dock__icon" aria-hidden="true">{entry.icon}</span><span>{entry.label}</span>
          </NavLink>)}
        </div>
      </nav>

      {sessionLostReason ? <div className="notice-box notice-box--warning keeper-layout__notice" role="status">{sessionLostReason}</div> : null}
      <main className="app-content keeper-layout__content">{children ?? <Outlet />}</main>
      <footer className="keeper-layout__footer">
        <span>Parrot WebUI</span><span>会话：{session?.summary?.subjectId ?? '未知'}</span>
      </footer>
    </div>
  </div>;
}
