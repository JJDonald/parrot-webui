/**
 * OAuth 账号页自测（实施文档 11.2 相关条目）：
 * - 未知额度不显示成 0 或无限：null/undefined 一律返回 null，由界面显示“未知”；
 * - 外链只接受 http/https；
 * - 409 同身份冲突的替换令牌只在明确确认时使用（解析函数本身不做任何自动覆盖）；
 * - 202 才提取 operationId；
 * - 状态/分页 meta 缺字段时保持未知，不伪造 0；
 * - 秘密值（flowSecret / importSecret）不进入 localStorage / sessionStorage / document.cookie / console。
 *
 * 只用 vitest + node:fs 做源码级断言，不引入额外测试依赖。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import {
  accountAvailabilityLabel,
  externalHttpUrl,
  formatCount,
  formatPercent,
  formatUsd,
  operationIdFrom,
  readPageMeta,
  readReplacePlan,
  type OAuthAccountSummaryData,
} from './oauthTypes';

const here = dirname(fileURLToPath(import.meta.url));

function baseAccount(overrides: Partial<OAuthAccountSummaryData> = {}): OAuthAccountSummaryData {
  return {
    accountId: 'openai:user@example.invalid:ws',
    available: true,
    disabledModelCount: 0,
    displayName: '示例账号',
    enabled: true,
    identity: 'user@example.invalid',
    invalid: false,
    maxConcurrent: 3,
    modelCount: 5,
    provider: 'openai',
    quotaLimited: false,
    revision: 'rev-1',
    ...overrides,
  };
}

describe('未知额度/用量不折算成 0 或无限', () => {
  it('null / undefined 百分比返回 null', () => {
    expect(formatPercent(null)).toBeNull();
    expect(formatPercent(undefined)).toBeNull();
    expect(formatPercent(Number.NaN)).toBeNull();
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(12.34)).toBe('12.3%');
  });

  it('计数与成本同样区分“未知”与 0', () => {
    expect(formatCount(null)).toBeNull();
    expect(formatCount(0)).toBe('0');
    expect(formatUsd(undefined)).toBeNull();
    expect(formatUsd(0)).toBe('$0.0000');
  });
});

describe('外部授权链接只接受 http/https', () => {
  it('接受 http/https', () => {
    expect(externalHttpUrl('https://example.invalid/login?x=1')).toBe('https://example.invalid/login?x=1');
    expect(externalHttpUrl('http://127.0.0.1:1455/callback')).toBe('http://127.0.0.1:1455/callback');
  });

  it('拒绝 javascript:/data:/相对地址与非字符串', () => {
    expect(externalHttpUrl('javascript:alert(1)')).toBeNull();
    expect(externalHttpUrl('data:text/html,<b>1</b>')).toBeNull();
    expect(externalHttpUrl('/oauth/callback')).toBeNull();
    expect(externalHttpUrl(null)).toBeNull();
    expect(externalHttpUrl(123)).toBeNull();
  });
});

describe('同身份冲突只解析、不自动覆盖', () => {
  it('从 409 载荷里读出一次性替换令牌', () => {
    const error = new ApiError({
      status: 409,
      code: 'IDENTITY_CONFLICT',
      source: 'upstream',
      message: 'identity conflict',
      payload: { conflict: { accountId: 'openai:user@example.invalid', replacePlanToken: 'one-time-token' } },
    });
    expect(readReplacePlan(error)).toEqual({
      accountId: 'openai:user@example.invalid',
      replacePlanToken: 'one-time-token',
    });
  });

  it('载荷不完整或没有冲突时返回 null（调用方必须继续等待用户决定）', () => {
    expect(readReplacePlan(null)).toBeNull();
    expect(
      readReplacePlan(
        new ApiError({ status: 409, code: 'IDENTITY_CONFLICT', source: 'upstream', message: 'x', payload: {} }),
      ),
    ).toBeNull();
    expect(
      readReplacePlan(
        new ApiError({
          status: 409,
          code: 'IDENTITY_CONFLICT',
          source: 'upstream',
          message: 'x',
          payload: { conflict: { accountId: 'a', replacePlanToken: '' } },
        }),
      ),
    ).toBeNull();
  });
});

describe('202 才提取 operationId', () => {
  it('202 + data.id 返回 operationId', () => {
    expect(operationIdFrom({ status: 202, data: { id: 'op-1' } })).toBe('op-1');
  });

  it('200 或缺少 id 时返回 null（不把同步结果当任务）', () => {
    expect(operationIdFrom({ status: 200, data: { id: 'op-1' } })).toBeNull();
    expect(operationIdFrom({ status: 202, data: null })).toBeNull();
  });
});

describe('账号状态与分页 meta 只反映上游真实字段', () => {
  it('invalid / quotaLimited / available 分别给出状态', () => {
    expect(accountAvailabilityLabel(baseAccount({ invalid: true })).label).toBe('凭据失效');
    expect(accountAvailabilityLabel(baseAccount({ quotaLimited: true })).label).toBe('额度受限');
    expect(accountAvailabilityLabel(baseAccount({ available: false, disabledUntil: '2030-01-01T00:00:00Z' })).label).toBe(
      '冷却中',
    );
    expect(accountAvailabilityLabel(baseAccount({ available: false })).label).toBe('暂不可用');
    expect(accountAvailabilityLabel(baseAccount()).label).toBe('可用');
  });

  it('meta 缺 total/page 时保持未知', () => {
    expect(readPageMeta(undefined)).toEqual({ page: null, pageSize: null, total: null, hasNext: null });
    expect(readPageMeta({ page: 2, pageSize: 20, total: 41, hasNext: true })).toEqual({
      page: 2,
      pageSize: 20,
      total: 41,
      hasNext: true,
    });
  });
});

describe('秘密值不进持久化存储、不打日志', () => {
  // 只扫描本目录的生产代码，跳过测试文件自身（它包含这些模式的正则字面量）。
  const files = readdirSync(here).filter(
    (name) => (name.endsWith('.ts') || name.endsWith('.tsx')) && !/\.test\.tsx?$/.test(name),
  );

  it('本目录源码不引用 localStorage / sessionStorage / document.cookie / console', () => {
    for (const name of files) {
      const source = readFileSync(join(here, name), 'utf8');
      expect(source, `${name} 不应写入本地存储`).not.toMatch(/localStorage\s*\./);
      expect(source, `${name} 不应写入会话存储`).not.toMatch(/sessionStorage\s*\./);
      expect(source, `${name} 不应读取或写入 Cookie`).not.toMatch(/document\s*\.\s*cookie/);
      expect(source, `${name} 不应把秘密值写进日志`).not.toMatch(/console\s*\./);
    }
  });

  it('flowSecret / importSecret 只作为请求体字段与内存引用出现，不进入 URL 查询串', () => {
    for (const name of files) {
      const source = readFileSync(join(here, name), 'utf8');
      // 形如 `?flowSecret=` / `&importSecret=` 的查询串拼接：一旦出现就是泄漏。
      expect(source, `${name} 不应把秘密值放进 URL`).not.toMatch(/[?&](flowSecret|importSecret)=/);
    }
  });
});
