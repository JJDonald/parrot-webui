/**
 * OAuth 登录流程的状态机（真实接口：POST /oauth/login-flows → poll → complete → cancel）。
 *
 * 交互要求（实施文档 6.5 / 11.2）：
 * - 发起、等待授权、需要回填、保存成功、超时、取消、失败分别呈现；
 * - 轮询是 POST + body.flowSecret（不是 GET），频率由 usePollingInterval 控制，卸载即停止；
 * - flowSecret 只保存在本 hook 的内存 ref 中：不进 URL、不进 localStorage/sessionStorage、不打日志；
 *   组件卸载即丢弃，因此刷新后必须重新发起（不会复用其他账号的流程）；
 * - 登录成功后模型同步是独立动作，失败不会被报成授权失败（见 LoginFlowPanel）；
 * - 同身份冲突（409 IDENTITY_CONFLICT）只展示冲突，必须由用户点击确认后才带上一次性替换令牌重试。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/api/client';
import { usePollingInterval } from '@/api/hooks';
import { UPSTREAM_CODE } from '@/api/error-codes';
import { toApiError } from './errors';
import {
  accountInvalidationKeys,
  useCancelLoginFlowMutation,
  useCompleteLoginFlowMutation,
  usePollLoginFlowMutation,
  useStartLoginFlowMutation,
} from './accountsApi';
import {
  readReplacePlan,
  type CompleteOAuthLoginFlowRequest,
  type LoginFlowStage,
  type OAuthLoginFlowData,
  type OAuthLoginPollData,
  type ReplacePlan,
  type StartOAuthLoginFlowRequest,
} from './oauthTypes';

/** 等待授权时的轮询间隔（页面进入后台时 usePollingInterval 会自动降频）。 */
const POLL_ACTIVE_MS = 3_000;
/** 连续读取失败上限：超过后停止轮询并允许手动继续，避免无限打上游。 */
const MAX_CONSECUTIVE_POLL_FAILURES = 4;

export interface LoginFlowState {
  stage: LoginFlowStage;
  /** 不含 flowSecret 的流程信息：密钥单独放在 ref 里，避免被序列化。 */
  flow: Omit<OAuthLoginFlowData, 'flowSecret'> | null;
  poll: OAuthLoginPollData | null;
  error: ApiError | null;
  pollError: ApiError | null;
  pollFailures: number;
  lastPolledAt: number | null;
  replacePlan: ReplacePlan | null;
  /** complete 返回的 status（created / replaced 等），原样展示。 */
  mutationStatus: string | null;
  savedAccountId: string | null;
  saveStatus: OAuthLoginPollData['saveStatus'];
  notice: string | null;
}

const INITIAL_STATE: LoginFlowState = {
  stage: 'idle',
  flow: null,
  poll: null,
  error: null,
  pollError: null,
  pollFailures: 0,
  lastPolledAt: null,
  replacePlan: null,
  mutationStatus: null,
  savedAccountId: null,
  saveStatus: null,
  notice: null,
};

const ACTIVE_STAGES: readonly LoginFlowStage[] = ['waiting', 'needs-input', 'ready'];

export interface LoginFlowCompleteInput {
  code?: string | null;
  state?: string | null;
  callbackUrl?: string | null;
  completed?: boolean | null;
  /** 同身份冲突后由用户确认才带上的一次性替换令牌（只走请求体）。 */
  replacePlanToken?: string | null;
}

export interface UseLoginFlowResult {
  state: LoginFlowState;
  /** 是否存在当前流程的内存密钥（刷新/切换标签页后为 false）。 */
  hasFlowSecret: boolean;
  /** 是否正在按间隔轮询。 */
  isPolling: boolean;
  pollIntervalMs: number | null;
  /** 各动作的提交中状态：用按钮禁用防止重复发起。 */
  pending: { start: boolean; poll: boolean; complete: boolean; cancel: boolean };
  start: (input: StartOAuthLoginFlowRequest) => Promise<void>;
  complete: (input: LoginFlowCompleteInput) => Promise<void>;
  confirmReplace: () => Promise<void>;
  declineReplace: () => void;
  cancel: () => Promise<void>;
  resumePolling: () => void;
  reset: () => void;
}

export function useLoginFlow(): UseLoginFlowResult {
  const [state, setState] = useState<LoginFlowState>(INITIAL_STATE);

  // 秘密值只在本内存 ref 中：不写 URL / localStorage / sessionStorage / 日志。
  const flowSecretRef = useRef<string | null>(null);
  const flowIdRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const stateRef = useRef(state);
  stateRef.current = state;

  const queryClient = useQueryClient();
  const startMutation = useStartLoginFlowMutation();
  const pollMutation = usePollLoginFlowMutation();
  const completeMutation = useCompleteLoginFlowMutation();
  const cancelMutation = useCancelLoginFlowMutation();

  // mutateAsync 的引用放进 ref，保证轮询回调与定时器稳定（不因渲染重建定时器）。
  const pollMutateRef = useRef(pollMutation.mutateAsync);
  pollMutateRef.current = pollMutation.mutateAsync;

  const isActive = ACTIVE_STAGES.includes(state.stage) && Boolean(state.flow);

  /** 覆盖式更新轮询结果；终态立即停止轮询。 */
  const applyPollData = useCallback((data: OAuthLoginPollData) => {
    setState((previous) => {
      const base: LoginFlowState = {
        ...previous,
        poll: data,
        pollError: null,
        pollFailures: 0,
        lastPolledAt: Date.now(),
      };
      switch (data.status) {
        case 'completed':
          return {
            ...base,
            stage: 'saved',
            savedAccountId: data.accountId ?? previous.savedAccountId,
            saveStatus: data.saveStatus ?? previous.saveStatus,
          };
        case 'cancelled':
          return { ...base, stage: 'cancelled', notice: '上游报告该登录流程已被取消。' };
        case 'expired':
          return { ...base, stage: 'expired', notice: '上游报告该登录流程已超时，请重新发起。' };
        case 'identity_pending':
          return { ...base, stage: 'needs-input', notice: data.accountId ? `已识别身份：${data.accountId}` : previous.notice };
        case 'ready':
          return { ...base, stage: 'ready' };
        case 'pending':
        default:
          return {
            ...base,
            stage: previous.stage === 'needs-input' ? 'needs-input' : 'waiting',
          };
      }
    });
  }, []);

  const pollOnce = useCallback(async () => {
    const flowId = flowIdRef.current;
    const flowSecret = flowSecretRef.current;
    if (!flowId || !flowSecret || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const response = await pollMutateRef.current({ flowId, flowSecret });
      if (!mountedRef.current) return;
      const data = response.data;
      if (!data || typeof data.status !== 'string') {
        setState((previous) => ({
          ...previous,
          pollError: new ApiError({
            status: response.status,
            code: 'WEBUI_UPSTREAM_UNEXPECTED_CONTENT',
            source: 'webui',
            message: '轮询成功但上游未返回可识别的流程状态',
          }),
        }));
        return;
      }
      applyPollData(data);
    } catch (error) {
      if (!mountedRef.current) return;
      const apiError = toApiError(error);
      // 400 / INVALID_OPERATION_STATE：上游判定该流程状态无效。可能已超时、已被使用，
      // 也可能只是该供应商不支持轮询。停止轮询，但不自动重做，也不篡改已有状态：
      // 只按已读到的上游状态回退到“需要回填 / 等待保存”，否则记为失败。
      const flowUnusable = apiError.status === 400 || apiError.code === UPSTREAM_CODE.INVALID_OPERATION_STATE;
      setState((previous) => {
        const pollFailures = previous.pollFailures + 1;
        const stop = flowUnusable || pollFailures >= MAX_CONSECUTIVE_POLL_FAILURES;
        const fallbackStage: LoginFlowStage =
          previous.poll?.status === 'identity_pending'
            ? 'needs-input'
            : previous.poll?.status === 'ready'
              ? 'ready'
              : 'failed';
        return {
          ...previous,
          pollError: apiError,
          pollFailures,
          stage: flowUnusable ? fallbackStage : stop ? 'failed' : previous.stage,
          error: flowUnusable ? apiError : previous.error,
          notice: flowUnusable
            ? '上游拒绝了本次流程查询（可能已过期 / 已被使用，或该供应商不支持轮询）。可以用下面的回填表单提交授权结果，或取消后重新发起；不会复用其他账号的流程。'
            : pollFailures >= MAX_CONSECUTIVE_POLL_FAILURES
              ? '多次读取流程状态失败，已停止轮询；可点击“继续轮询”或重新发起。'
              : previous.notice,
        };
      });
    } finally {
      inFlightRef.current = false;
    }
  }, [applyPollData]);

  // 频率交给 usePollingInterval：后台标签页自动降频；enabled=false 时返回 false。
  const pollInterval = usePollingInterval(POLL_ACTIVE_MS, { enabled: isActive });
  const retryAfterSeconds = state.pollError?.retryAfterSeconds ?? null;
  const effectiveInterval = useMemo(() => {
    if (typeof pollInterval !== 'number') return null;
    if (retryAfterSeconds && retryAfterSeconds > 0) {
      return Math.max(pollInterval, retryAfterSeconds * 1000);
    }
    return pollInterval;
  }, [pollInterval, retryAfterSeconds]);

  // 轮询循环：单飞 + 卸载停止（组件卸载后不再调度下一次）。
  useEffect(() => {
    if (!isActive || effectiveInterval === null) return undefined;
    let disposed = false;
    let timer: number | undefined;
    const tick = async () => {
      await pollOnce();
      if (disposed) return;
      timer = window.setTimeout(() => void tick(), effectiveInterval);
    };
    timer = window.setTimeout(() => void tick(), effectiveInterval);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [isActive, effectiveInterval, pollOnce]);

  // 本地兜底超时：上游 expiresAt 到期即显示超时并停止轮询。
  useEffect(() => {
    if (!isActive) return undefined;
    const expiresAt = state.poll?.expiresAt ?? state.flow?.expiresAt;
    if (!expiresAt) return undefined;
    const remaining = Date.parse(expiresAt) - Date.now();
    if (Number.isNaN(remaining)) return undefined;
    if (remaining <= 0) {
      setState((previous) => ({ ...previous, stage: 'expired', notice: '流程已超过上游给出的 expiresAt。' }));
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setState((previous) =>
        previous.stage === 'saved' || previous.stage === 'cancelled' || previous.stage === 'expired'
          ? previous
          : { ...previous, stage: 'expired', notice: '流程已超过上游给出的 expiresAt，请重新发起。' },
      );
    }, Math.min(remaining, 2_147_000_000));
    return () => window.clearTimeout(timer);
  }, [isActive, state.flow?.expiresAt, state.poll?.expiresAt]);

  // 登录保存成功后刷新账号相关查询（不整站刷新）。
  useEffect(() => {
    if (state.stage !== 'saved') return;
    void Promise.all(accountInvalidationKeys.map((key) => queryClient.invalidateQueries({ queryKey: key })));
  }, [state.stage, queryClient]);

  // 卸载：丢弃内存中的流程密钥与流程 ID，停止一切后续轮询。
  useEffect(
    () => () => {
      mountedRef.current = false;
      flowSecretRef.current = null;
      flowIdRef.current = null;
      inFlightRef.current = false;
    },
    [],
  );

  const start = useCallback(
    async (input: StartOAuthLoginFlowRequest) => {
      setState({ ...INITIAL_STATE, stage: 'starting' });
      flowSecretRef.current = null;
      flowIdRef.current = null;
      try {
        const response = await startMutation.mutateAsync(input);
        if (!mountedRef.current) return;
        const data = response.data;
        if (!data || typeof data.flowId !== 'string' || typeof data.flowSecret !== 'string') {
          throw new ApiError({
            status: response.status,
            code: 'WEBUI_UPSTREAM_UNEXPECTED_CONTENT',
            source: 'webui',
            message: '发起登录成功但上游未返回 flowId / flowSecret',
          });
        }
        const { flowSecret, ...flow } = data;
        flowSecretRef.current = flowSecret;
        flowIdRef.current = data.flowId;
        setState({
          ...INITIAL_STATE,
          stage: 'waiting',
          flow,
          notice: flow.authUrl
            ? '请在新打开的官方授权页面完成授权。'
            : '上游未返回授权链接：请按下面给出的上游指引操作，必要时使用回填表单。',
        });
      } catch (error) {
        if (!mountedRef.current) return;
        setState({ ...INITIAL_STATE, stage: 'failed', error: toApiError(error) });
      }
    },
    [startMutation],
  );

  const complete = useCallback(
    async (input: LoginFlowCompleteInput) => {
      const flowId = flowIdRef.current;
      const flowSecret = flowSecretRef.current;
      if (!flowId || !flowSecret) {
        setState((previous) => ({
          ...previous,
          stage: 'failed',
          error: new ApiError({
            status: 0,
            code: 'WEBUI_SESSION_REQUIRED',
            source: 'webui',
            message: '当前页面内存里已没有该流程的 flowSecret（可能已刷新或离开页面），请重新发起登录流程',
          }),
        }));
        return;
      }
      setState((previous) => ({ ...previous, error: null }));
      try {
        const payload: CompleteOAuthLoginFlowRequest & { flowId: string } = { flowId, flowSecret };
        if (input.code) payload.code = input.code;
        if (input.state) payload.state = input.state;
        if (input.callbackUrl) payload.callbackUrl = input.callbackUrl;
        if (input.completed !== undefined && input.completed !== null) payload.completed = input.completed;
        if (input.replacePlanToken) payload.replacePlanToken = input.replacePlanToken;
        const response = await completeMutation.mutateAsync(payload);
        if (!mountedRef.current) return;
        const data = response.data;
        setState((previous) => ({
          ...previous,
          stage: 'saved',
          savedAccountId: data?.accountId ?? previous.savedAccountId,
          mutationStatus: data?.status ?? null,
          replacePlan: null,
          error: null,
          notice: '上游已保存该账号。',
        }));
      } catch (error) {
        if (!mountedRef.current) return;
        const apiError = toApiError(error);
        const plan = readReplacePlan(apiError);
        if (plan) {
          // 同身份已存在：只展示冲突，等用户明确确认后才带一次性令牌重试。
          setState((previous) => ({
            ...previous,
            stage: 'needs-input',
            replacePlan: plan,
            error: apiError,
            notice: null,
          }));
          return;
        }
        const flowUnusable = apiError.code === UPSTREAM_CODE.INVALID_OPERATION_STATE;
        setState((previous) => ({
          ...previous,
          error: apiError,
          stage: flowUnusable ? 'failed' : previous.stage,
          notice: flowUnusable
            ? '上游判定该流程状态无效；请重新发起登录流程。'
            : '本次提交未被上游接受；请按提示修正后重试，或取消流程后重新发起。',
        }));
      }
    },
    [completeMutation],
  );

  const confirmReplace = useCallback(async () => {
    const plan = stateRef.current.replacePlan;
    if (!plan) return;
    await complete({ replacePlanToken: plan.replacePlanToken });
  }, [complete]);

  const declineReplace = useCallback(() => {
    setState((previous) => ({
      ...previous,
      replacePlan: null,
      error: null,
      stage: 'needs-input',
      notice: '已保留现有账号，未做替换。如需换用新凭据，请取消当前流程后重新发起。',
    }));
  }, []);

  const cancel = useCallback(async () => {
    const flowId = flowIdRef.current;
    const flowSecret = flowSecretRef.current;
    if (!flowId || !flowSecret) return;
    setState((previous) => ({ ...previous, error: null }));
    try {
      await cancelMutation.mutateAsync({ flowId, flowSecret });
      if (!mountedRef.current) return;
      flowSecretRef.current = null;
      setState((previous) => ({
        ...previous,
        stage: 'cancelled',
        error: null,
        pollError: null,
        replacePlan: null,
        notice: '上游已取消该登录流程（204）。',
      }));
    } catch (error) {
      if (!mountedRef.current) return;
      setState((previous) => ({
        ...previous,
        error: toApiError(error),
        notice: '取消请求未被上游接受；流程真实状态以轮询结果为准，不会自动重做。',
      }));
    }
  }, [cancelMutation]);

  const resumePolling = useCallback(() => {
    setState((previous) => ({
      ...previous,
      stage: previous.stage === 'needs-input' || previous.stage === 'ready' ? previous.stage : 'waiting',
      pollFailures: 0,
      pollError: null,
      notice: '已恢复轮询。',
    }));
  }, []);

  const reset = useCallback(() => {
    flowSecretRef.current = null;
    flowIdRef.current = null;
    inFlightRef.current = false;
    setState({ ...INITIAL_STATE });
  }, []);

  return {
    state,
    hasFlowSecret: Boolean(state.flow) && flowSecretRef.current !== null,
    isPolling: isActive && effectiveInterval !== null,
    pollIntervalMs: isActive ? effectiveInterval : null,
    pending: {
      start: startMutation.isPending,
      poll: pollMutation.isPending,
      complete: completeMutation.isPending,
      cancel: cancelMutation.isPending,
    },
    start,
    complete,
    confirmReplace,
    declineReplace,
    cancel,
    resumePolling,
    reset,
  };
}
