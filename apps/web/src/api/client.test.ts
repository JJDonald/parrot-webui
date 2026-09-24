/**
 * BFF 客户端 URL 回归测试（对应线上报错 WEBUI_NOT_FOUND：未找到 /webui/channels）。
 *
 * 事实约束：
 * - BFF 的管理代理只挂在 /webui/bff/management/*（apps/bff/src/routes/management-proxy.ts）；
 * - SPA fallback 对带 accept: application/json 的 /webui/<管理路径> 一律抛
 *   WEBUI_NOT_FOUND（apps/bff/src/routes/health.ts），前端就会显示
 *   「WebUI 拒绝了该请求（未到达 Parrot）」；
 * - 因此页面层的管理路径必须由 managementRequest() 补上 /bff/management 前缀，
 *   绝不能让 requestJson()（只拼 Vite base）拿到管理路径。
 *
 * 只用 vitest + 全局 fetch 打桩，不引入额外测试依赖。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  MANAGEMENT_PREFIX,
  managementRequest,
  managementUrl,
  requestJson,
  setCsrfToken,
  webuiUrl,
} from './client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  setCsrfToken(null);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('URL 拼接', () => {
  it('webuiUrl 只拼 Vite base（用于 /bff/* 自带接口）', () => {
    expect(webuiUrl('/bff/bootstrap')).toBe('/webui/bff/bootstrap');
  });

  it('managementUrl 拼出 /webui/bff/management/<管理路径>', () => {
    expect(MANAGEMENT_PREFIX).toBe('/bff/management');
    expect(managementUrl('/channels')).toBe('/webui/bff/management/channels');
    expect(managementUrl('channels')).toBe('/webui/bff/management/channels');
    expect(managementUrl('/channels/ch-1/compatibility')).toBe(
      '/webui/bff/management/channels/ch-1/compatibility',
    );
  });
});

/** 断言请求以 ApiError 失败，并把它取出来（顺带验证"确实失败了"）。 */
async function expectApiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (caught) {
    if (caught instanceof ApiError) return caught;
    throw caught;
  }
  throw new Error('期望请求失败，但请求成功了');
}

describe('requestJson：BFF 自带接口', () => {
  it('请求 /webui/bff/bootstrap，不重复前缀', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { ok: true }, meta: {} }));
    await requestJson('/bff/bootstrap');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/webui/bff/bootstrap');
  });
});

describe('managementRequest：管理接口必须带 /bff/management', () => {
  it('GET 管理列表落到 /webui/bff/management/channels（不是 /webui/channels）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { items: [] }, meta: {} }));

    await managementRequest('/channels', { query: { page: 1, pageSize: 20 } });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe('/webui/bff/management/channels?page=1&pageSize=20');
    // 回归点：曾经拼成 /webui/channels，被 BFF 以 WEBUI_NOT_FOUND 拒绝
    expect(url.startsWith('/webui/channels')).toBe(false);
  });

  it('写操作（PATCH + If-Match）同样带前缀，且不重复拼前缀', async () => {
    setCsrfToken('csrf-token-1');
    fetchMock.mockResolvedValue(jsonResponse({ data: { id: 'ch-1' }, meta: { revision: 'rev-2' } }, 200));

    await managementRequest('/channels/ch-1', {
      method: 'PATCH',
      body: { name: 'x' },
      ifMatch: 'rev-1',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/webui/bff/management/channels/ch-1');
    expect(String(url).includes('/webui/webui/')).toBe(false);
    expect((init.headers as Record<string, string>)['if-match']).toBe('rev-1');
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-token-1');
  });

  it('手工带前缀的管理路径会立刻报错，不发请求（防止双前缀地址）', () => {
    expect(() => managementRequest('/bff/management/channels')).toThrow(/相对 \/bff\/management/);
    expect(() => managementRequest('/webui/bff/management/channels')).toThrow(/相对 \/bff\/management/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('异步任务轮询路径 /operations/{id} 落在管理前缀下', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { status: 'running' }, meta: {} }));
    await managementRequest('/operations/op-1');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/webui/bff/management/operations/op-1');
  });

});

describe('错误归一化', () => {
  it('BFF 自身拒绝（404 WEBUI_NOT_FOUND）标记为 webui 来源且不可到达 Parrot', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'WEBUI_NOT_FOUND',
            message: '未找到 /webui/channels',
            retryable: false,
            requestId: '78f286d171ca8930769bcb89',
            source: 'webui',
          },
        },
        404,
      ),
    );

    const error = await expectApiError(managementRequest('/channels'));
    expect(error.code).toBe('WEBUI_NOT_FOUND');
    expect(error.source).toBe('webui');
    expect(error.requestId).toBe('78f286d171ca8930769bcb89');
  });

  it('上游业务错误（Parrot 返回）标记为 upstream 来源', async () => {
    // 写操作需要 CSRF；缺 token 时客户端会在发起请求前就抛 WEBUI_CSRF_REJECTED
    setCsrfToken('csrf-token-upstream');
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'REVISION_CONFLICT',
            message: '版本冲突',
            retryable: false,
            requestId: 'req-upstream-1',
            source: 'upstream',
          },
        },
        409,
      ),
    );

    const error = await expectApiError(managementRequest('/channels/ch-1', { method: 'PATCH' }));
    expect(error.code).toBe('REVISION_CONFLICT');
    expect(error.source).toBe('upstream');
    expect(error.isUpstreamBusinessError).toBe(true);
  });
});
