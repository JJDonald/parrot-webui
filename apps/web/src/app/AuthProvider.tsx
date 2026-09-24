/**
 * 会话状态管理。
 *
 * 约束（实施文档 4.x）：
 * - 管理主密钥只用于那次登录请求，登录后立即从组件状态中清除，绝不写入任何持久化存储。
 * - CSRF Token 与上游会话摘要只保存在内存；刷新页面通过 GET /bff/auth/session 恢复。
 * - 注销或会话失效时清理查询缓存、秘密视图与多标签页状态（BroadcastChannel）。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  bff,
  getCsrfToken,
  setCsrfToken,
  setSessionLostHandler,
  type BootstrapResponse,
  type SessionResponse,
} from '@/api/client';

export type AuthStatus = 'loading' | 'anonymous' | 'authenticated' | 'error';

interface AuthState {
  status: AuthStatus;
  bootstrap: BootstrapResponse | null;
  session: SessionResponse['session'];
  capabilities: string[];
  upstream: SessionResponse['upstream'] | BootstrapResponse['upstream'] | null;
  error: ApiError | null;
}

interface AuthContextValue extends AuthState {
  login: (managementKey: string) => Promise<void>;
  logout: () => Promise<{ upstreamRevocation: string; message?: string }>;
  refreshSession: () => Promise<void>;
  refreshBootstrap: (options?: { adoptCsrf?: boolean }) => Promise<void>;
  clearLocalSession: (reason?: string) => void;
  /** 会话失效原因（401 等），用于登录页提示 */
  sessionLostReason: string | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const AUTH_CHANNEL = 'parrot-webui:auth';

const initialUpstream: BootstrapResponse['upstream'] = {
  configured: true,
  reachable: false,
  managementApiDetected: false,
  status: null,
  errorCode: null,
  latencyMs: null,
  checkedAt: 0,
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>({
    status: 'loading',
    bootstrap: null,
    session: null,
    capabilities: [],
    upstream: null,
    error: null,
  });
  const [sessionLostReason, setSessionLostReason] = useState<string | null>(null);
  const channelRef = useRef<BroadcastChannel | null>(null);

  const clearLocalSession = useCallback(
    (reason?: string) => {
      setCsrfToken(null);
      queryClient.clear();
      setState((previous) => ({
        ...previous,
        status: 'anonymous',
        session: null,
        capabilities: [],
      }));
      if (reason) setSessionLostReason(reason);
    },
    [queryClient],
  );

  const refreshBootstrap = useCallback(async (options?: { adoptCsrf?: boolean }) => {
    try {
      const response = await bff.bootstrap();
      const payload = response.data;
      if (!payload) throw new ApiError({ status: 500, code: 'WEBUI_INTERNAL', source: 'webui', message: 'bootstrap 返回空数据' });
      setState((previous) => ({
        ...previous,
        bootstrap: payload,
        upstream: payload.upstream,
        error: null,
      }));
      // 预登录 CSRF：未登录时采用 bootstrap 的 Token；已登录会话的 Token 不被覆盖。
      // adoptCsrf 供登录前强制采用一份「新鲜」的预登录 Token（见 login）。
      if (options?.adoptCsrf || !getCsrfToken()) setCsrfToken(payload.csrfToken);
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      setState((previous) => ({
        ...previous,
        status: previous.status === 'authenticated' ? previous.status : 'error',
        error: apiError,
      }));
      throw error;
    }
  }, []);

  const refreshSession = useCallback(async () => {
    try {
      const response = await bff.session();
      const payload = response.data;
      if (!payload) throw new ApiError({ status: 500, code: 'WEBUI_INTERNAL', source: 'webui', message: 'session 返回空数据' });
      if (payload.authenticated && payload.session) {
        setCsrfToken(payload.csrfToken);
        setState((previous) => ({
          ...previous,
          status: 'authenticated',
          session: payload.session,
          capabilities: payload.capabilities,
          upstream: payload.upstream,
          error: null,
        }));
        setSessionLostReason(null);
      } else {
        // 未登录时不清理 CSRF：bootstrap 得到的预登录 Token 正是登录 POST 所需要的，
        // 而 /bff/auth/session 在未登录时返回 csrfToken: null；这里若写入 null，
        // 「登录」按钮的提交就会被 client.ts 的本地校验挡下，请求根本发不出去。
        setState((previous) => ({
          ...previous,
          status: 'anonymous',
          session: null,
          capabilities: [],
          upstream: payload.upstream,
        }));
      }
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      if (apiError?.isSessionLost) {
        clearLocalSession('会话已失效，请重新登录');
        return;
      }
      setState((previous) => ({ ...previous, error: apiError }));
      throw error;
    }
  }, [clearLocalSession]);

  const login = useCallback(
    async (managementKey: string) => {
      // 登录前先确保拿到一份「新鲜的预登录会话」（预登录 Cookie 与 CSRF 必须成对且未过期）：
      //  - 首次进入、注销后、会话失效后，本地可能根本没有预登录 CSRF；
      //  - bootstrap 的预登录会话 TTL 只有 5 分钟，登录页打开太久 Token 会过期；
      //  - 登录成功时 BFF 会清掉预登录 Cookie，所以每次登录都要重新取一份。
      // 缺了这一步，登录 POST 会被 client.ts 的本地校验或服务端 CSRF 校验挡下（请求根本发不出去）。
      await refreshBootstrap({ adoptCsrf: true });
      const response = await bff.login(managementKey);
      const payload = response.data;
      if (!payload?.session) {
        throw new ApiError({ status: 500, code: 'WEBUI_INTERNAL', source: 'webui', message: '登录响应缺少会话信息' });
      }
      setCsrfToken(payload.csrfToken);
      setSessionLostReason(null);
      setState((previous) => ({
        ...previous,
        status: 'authenticated',
        session: payload.session,
        capabilities: payload.session?.summary.capabilities ?? [],
        upstream: payload.upstream,
        error: null,
      }));
    },
    [refreshBootstrap],
  );

  const logout = useCallback(async () => {
    try {
      const response = await bff.logout();
      const payload = response.data;
      clearLocalSession();
      channelRef.current?.postMessage({ type: 'logout' });
      return {
        upstreamRevocation: payload?.upstreamRevocation ?? 'not-attempted',
        message: payload?.message,
      };
    } catch (error) {
      // 无论上游是否可达，本地必须销毁会话并清理 Cookie
      clearLocalSession();
      channelRef.current?.postMessage({ type: 'logout' });
      if (error instanceof ApiError) {
        return { upstreamRevocation: 'unconfirmed', message: error.message };
      }
      throw error;
    }
  }, [clearLocalSession]);

  // 会话失效统一处理：任何 401 都会走这里
  useEffect(() => {
    setSessionLostHandler(() => {
      setSessionLostReason('会话已失效（上游判定未登录或本地会话过期），请重新登录');
      clearLocalSession('会话已失效（上游判定未登录或本地会话过期），请重新登录');
    });
    return () => setSessionLostHandler(null);
  }, [clearLocalSession]);

  // 初始化：bootstrap（公共配置 + 预登录 CSRF）→ session（是否已登录）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await refreshBootstrap();
        await refreshSession();
      } catch {
        if (!cancelled) {
          setState((previous) =>
            previous.status === 'authenticated' ? previous : { ...previous, status: previous.bootstrap ? 'anonymous' : 'error' },
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 多标签页注销同步：只广播事件，不广播任何凭据
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return undefined;
    const channel = new BroadcastChannel(AUTH_CHANNEL);
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent) => {
      if ((event.data as { type?: string })?.type === 'logout') {
        clearLocalSession('已在另一个标签页退出登录');
      }
    };
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [clearLocalSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      sessionLostReason,
      login,
      logout,
      refreshSession,
      refreshBootstrap,
      clearLocalSession,
    }),
    [state, sessionLostReason, login, logout, refreshSession, refreshBootstrap, clearLocalSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return context;
}

/**
 * 能力判断。
 * 上游 capabilities 的实际结构以真实返回为准；这里只做保守判断：
 * 只有明确拿到能力列表且其中没有任何写能力时才判定为只读，列表缺失一律不限制（由上游再校验）。
 */
export function useWriteCapability(): { canWrite: boolean; reason: string | null } {
  const { capabilities, status } = useAuth();
  if (status !== 'authenticated') return { canWrite: false, reason: '未登录' };
  if (!capabilities.length) return { canWrite: true, reason: null };
  const hasWrite = capabilities.some((capability) => /write|manage|admin/i.test(capability));
  return hasWrite ? { canWrite: true, reason: null } : { canWrite: false, reason: '当前会话只具备只读能力' };
}

export { initialUpstream };
