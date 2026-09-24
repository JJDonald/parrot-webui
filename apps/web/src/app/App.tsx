/**
 * 应用入口：Provider 装配 + 路由（basename 固定 /webui）。
 *
 * 路由与深链接要求（实施文档 9.7）：/webui/channels 等深链接刷新必须返回 SPA；
 * 未登录访问任何管理页面都跳转 /login，而不是域名根下的另一套入口。
 */

import { useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ConfigProvider, App as AntdApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { applyThemeAttribute, buildAntdTheme, readStoredTheme, storeTheme, type ThemeName } from './antdTheme';
import { AuthProvider, useAuth } from './AuthProvider';
import { AppShell } from './AppShell';
import { OperationProvider } from '@/api/operations';
import { LoginPage } from '@/features/auth/LoginPage';
import { OverviewPage } from '@/features/overview/OverviewPage';
import { AnalysisPage } from '@/features/analysis/AnalysisPage';
import { RealtimePage } from '@/features/realtime/RealtimePage';
import { ChannelsPage } from '@/features/channels/ChannelsPage';
import { AccountsPage } from '@/features/accounts/AccountsPage';
import { ModelsPage } from '@/features/models/ModelsPage';
import { ApiKeysPage } from '@/features/api-keys/ApiKeysPage';
import { LogsPage } from '@/features/logs/LogsPage';
import { TasksPage } from '@/features/tasks/TasksPage';
import { AboutPage } from '@/features/about/AboutPage';
import { NotFoundPage } from '@/features/NotFoundPage';
import { LoadingBlock } from '@/components/state';
import { ErrorNotice } from '@/components/feedback';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 只读请求保留缓存，避免切换页面时闪烁；具体重试策略在各 hook 内限定
      staleTime: 5_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      retry: false,
    },
    mutations: {
      // 写操作绝不自动重试：结果未知时由用户刷新确认
      retry: false,
    },
  },
});

function RequireAuth({ theme, onThemeChange }: { theme: ThemeName; onThemeChange: (theme: ThemeName) => void }) {
  const { status, error, refreshBootstrap } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
        <LoadingBlock label="正在连接 WebUI 后端…" />
      </div>
    );
  }

  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (status === 'error') {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
        <div style={{ maxWidth: 520, width: '100%' }}>
          {error ? (
            <ErrorNotice error={error} onRetry={() => void refreshBootstrap()} />
          ) : (
            <div className="error-box" role="alert">
              无法初始化 WebUI 会话状态，请重试。
            </div>
          )}
        </div>
      </div>
    );
  }

  return <AppShell theme={theme} onThemeChange={onThemeChange} />;
}

export function App() {
  const [theme, setTheme] = useState<ThemeName>(() => {
    const initial = readStoredTheme();
    applyThemeAttribute(initial);
    return initial;
  });

  useEffect(() => {
    applyThemeAttribute(theme);
    storeTheme(theme);
  }, [theme]);

  const handleThemeChange = (next: ThemeName) => {
    // 先落地 CSS 变量，再让 Ant Design 读取新值重建主题
    applyThemeAttribute(next);
    setTheme(next);
  };

  const themeConfig = useMemo(() => buildAntdTheme(theme), [theme]);

  return (
    <QueryClientProvider client={queryClient}>
      <ConfigProvider theme={themeConfig} locale={zhCN}>
        <AntdApp>
          <AuthProvider>
            <OperationProvider>
              <BrowserRouter basename="/webui">
                <Routes>
                  <Route path="/login" element={<LoginPage />} />
                  <Route element={<RequireAuth theme={theme} onThemeChange={handleThemeChange} />}>
                    <Route index element={<OverviewPage />} />
                    <Route path="analysis" element={<AnalysisPage />} />
                    <Route path="realtime" element={<RealtimePage />} />
                    <Route path="channels" element={<ChannelsPage />} />
                    <Route path="accounts" element={<AccountsPage />} />
                    <Route path="models" element={<ModelsPage />} />
                    <Route path="api-keys" element={<ApiKeysPage />} />
                    <Route path="logs" element={<LogsPage />} />
                    <Route path="tasks" element={<TasksPage />} />
                    <Route path="about" element={<AboutPage />} />
                    <Route path="*" element={<NotFoundPage />} />
                  </Route>
                </Routes>
              </BrowserRouter>
            </OperationProvider>
          </AuthProvider>
        </AntdApp>
      </ConfigProvider>
    </QueryClientProvider>
  );
}
