/**
 * 应用入口：Provider 装配 + 路由（basename 固定 /webui）。
 *
 * 路由与深链接要求（实施文档 9.7）：/webui/channels 等深链接刷新必须返回 SPA；
 * 未登录访问任何管理页面都跳转 /login，而不是域名根下的另一套入口。
 *
 * 页面全部按路由懒加载（React.lazy + Suspense）：11 个页面加上全量 antd 曾经
 * 打进同一个 1.6 MB chunk，首屏必须下载完才能显示任何内容。现在每个页面独立成包，
 * 首屏只加载登录页/外壳与当前路由。
 */

import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ConfigProvider, App as AntdApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { applyThemeAttribute, buildAntdTheme, readStoredTheme, storeTheme, type ThemeName } from './antdTheme';
import { AuthProvider, useAuth } from './AuthProvider';
import { AppShell } from './AppShell';
import { OperationProvider } from '@/api/operations';
import { LoadingBlock } from '@/components/state';
import { ErrorNotice } from '@/components/feedback';
import { ErrorBoundary } from '@/components/ErrorBoundary';

const LoginPage = lazy(() => import('@/features/auth/LoginPage').then((module) => ({ default: module.LoginPage })));
const OverviewPage = lazy(() =>
  import('@/features/overview/OverviewPage').then((module) => ({ default: module.OverviewPage })),
);
const AnalysisPage = lazy(() =>
  import('@/features/analysis/AnalysisPage').then((module) => ({ default: module.AnalysisPage })),
);
const RealtimePage = lazy(() =>
  import('@/features/realtime/RealtimePage').then((module) => ({ default: module.RealtimePage })),
);
const ChannelsPage = lazy(() =>
  import('@/features/channels/ChannelsPage').then((module) => ({ default: module.ChannelsPage })),
);
const AccountsPage = lazy(() =>
  import('@/features/accounts/AccountsPage').then((module) => ({ default: module.AccountsPage })),
);
const ModelsPage = lazy(() => import('@/features/models/ModelsPage').then((module) => ({ default: module.ModelsPage })));
const ApiKeysPage = lazy(() =>
  import('@/features/api-keys/ApiKeysPage').then((module) => ({ default: module.ApiKeysPage })),
);
const LogsPage = lazy(() => import('@/features/logs/LogsPage').then((module) => ({ default: module.LogsPage })));
const TasksPage = lazy(() => import('@/features/tasks/TasksPage').then((module) => ({ default: module.TasksPage })));
const AboutPage = lazy(() => import('@/features/about/AboutPage').then((module) => ({ default: module.AboutPage })));
const NotFoundPage = lazy(() =>
  import('@/features/NotFoundPage').then((module) => ({ default: module.NotFoundPage })),
);

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

/** 路由级懒加载的挂起占位：保持整页高度，避免加载时布局跳动。 */
function RouteFallback() {
  return (
    <div style={{ minHeight: '50vh', display: 'grid', placeItems: 'center' }}>
      <LoadingBlock label="正在加载页面…" />
    </div>
  );
}

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
                {/* 路由边界：某个页面渲染崩溃时只替换内容区，外壳与导航仍可用 */}
                <ContentErrorBoundary>
                  <Routes>
                    <Route
                      path="/login"
                      element={
                        <Suspense fallback={<RouteFallback />}>
                          <LoginPage />
                        </Suspense>
                      }
                    />
                    <Route element={<RequireAuth theme={theme} onThemeChange={handleThemeChange} />}>
                      <Route index element={<LazyPage page="概览" element={<OverviewPage />} />} />
                      <Route path="analysis" element={<LazyPage page="用量分析" element={<AnalysisPage />} />} />
                      <Route path="realtime" element={<LazyPage page="实时运行" element={<RealtimePage />} />} />
                      <Route path="channels" element={<LazyPage page="API 渠道" element={<ChannelsPage />} />} />
                      <Route path="accounts" element={<LazyPage page="OAuth 账号" element={<AccountsPage />} />} />
                      <Route path="models" element={<LazyPage page="模型中心" element={<ModelsPage />} />} />
                      <Route path="api-keys" element={<LazyPage page="下游 API Key" element={<ApiKeysPage />} />} />
                      <Route path="logs" element={<LazyPage page="请求日志" element={<LogsPage />} />} />
                      <Route path="tasks" element={<LazyPage page="管理任务" element={<TasksPage />} />} />
                      <Route path="about" element={<LazyPage page="版本与诊断" element={<AboutPage />} />} />
                      <Route path="*" element={<LazyPage page="页面" element={<NotFoundPage />} />} />
                    </Route>
                  </Routes>
                </ContentErrorBoundary>
              </BrowserRouter>
            </OperationProvider>
          </AuthProvider>
        </AntdApp>
      </ConfigProvider>
    </QueryClientProvider>
  );
}

/** 单个懒加载路由：错误边界按路由路径重置，切页后不再残留上一页的崩溃状态。 */
function LazyPage({ page, element }: { page: string; element: React.ReactNode }) {
  const location = useLocation();
  return (
    <ErrorBoundary scope={page} resetKey={location.pathname}>
      <Suspense fallback={<RouteFallback />}>{element}</Suspense>
    </ErrorBoundary>
  );
}

/** 包裹整个路由表：连 RequireAuth / AppShell 崩溃时也有兜底。 */
function ContentErrorBoundary({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  return (
    <ErrorBoundary scope="页面" resetKey={location.pathname}>
      {children}
    </ErrorBoundary>
  );
}
