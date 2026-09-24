/**
 * loadConfig 严格校验测试（对应实施文档 5.1 / 5.2 / 9.2 与 11.1）。
 *
 * 这些校验是"不安全配置必须让进程明确失败"的保证，全部使用虚构域名与端口。
 */

import { describe, expect, it } from 'vitest';
import { ConfigError, FIXED_BASE_PATH, loadConfig } from '../src/config.js';

const DEV_ENV: Record<string, string> = {
  NODE_ENV: 'development',
  WEBUI_PUBLIC_ORIGIN: 'http://webui.test',
  PARROT_BASE_URL: 'http://127.0.0.1:22122',
};

const PROD_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  WEBUI_PUBLIC_ORIGIN: 'https://webui.test',
  PARROT_BASE_URL: 'http://127.0.0.1:22122',
  WEBUI_TRUST_PROXY: '10.0.0.0/8, 127.0.0.1',
};

function expectConfigError(env: Record<string, string | undefined>, hint: string): ConfigError {
  let caught: unknown;
  try {
    loadConfig(env);
  } catch (error) {
    caught = error;
  }
  expect(caught, hint).toBeInstanceOf(ConfigError);
  return caught as ConfigError;
}

describe('loadConfig 严格校验', () => {
  it('开发环境基线配置可用，且基础字段被规范化', () => {
    const config = loadConfig({ ...DEV_ENV });
    expect(config.basePath).toBe(FIXED_BASE_PATH);
    expect(config.publicOrigin).toBe('http://webui.test');
    expect(config.publicHost).toBe('webui.test');
    expect(config.upstreamOrigin).toBe('http://127.0.0.1:22122');
    expect(config.isProduction).toBe(false);
    // 非生产默认允许本地调试 Cookie；生产必须 Secure（见下）
    expect(config.cookieSecure).toBe(false);
    expect(config.cookiePrefix).toBe('');
    // 未显式配置可信代理时，开发环境只信任本机
    expect(config.trustProxy).toEqual(['127.0.0.1', '::1']);
  });

  it('缺少 PARROT_BASE_URL 时启动失败', () => {
    const error = expectConfigError({ ...DEV_ENV, PARROT_BASE_URL: undefined }, '缺少上游地址必须失败');
    expect(error.message).toContain('PARROT_BASE_URL');
  });

  it('WEBUI_BASE_PATH 非 /webui/ 时启动失败', () => {
    for (const value of ['/app', '/webui/admin', '/', 'webui']) {
      const error = expectConfigError({ ...DEV_ENV, WEBUI_BASE_PATH: value }, `WEBUI_BASE_PATH=${value}`);
      expect(error.message).toContain('WEBUI_BASE_PATH');
    }
    // 只补尾斜杠的写法等价，仍然合法
    expect(loadConfig({ ...DEV_ENV, WEBUI_BASE_PATH: '/webui' }).basePath).toBe(FIXED_BASE_PATH);
  });

  it('生产环境禁止 http 公网来源，显式放行时才允许且必须使用 Secure Cookie', () => {
    expectConfigError({ ...DEV_ENV, NODE_ENV: 'production', WEBUI_PUBLIC_ORIGIN: 'http://webui.test' }, '生产 http 来源');

    const insecureAllowed = loadConfig({
      ...PROD_ENV,
      WEBUI_PUBLIC_ORIGIN: 'http://webui.test',
      WEBUI_ALLOW_INSECURE_PUBLIC_ORIGIN: '1',
    });
    expect(insecureAllowed.isProduction).toBe(true);
    expect(insecureAllowed.allowInsecurePublicOrigin).toBe(true);

    const secure = loadConfig({ ...PROD_ENV });
    expect(secure.cookieSecure).toBe(true);
    expect(secure.cookiePrefix).toBe('__Secure-');
    // 生产默认不外显上游地址
    expect(secure.upstreamOriginDisplay).not.toContain('127.0.0.1');
  });

  it('PARROT_BASE_URL 带路径、query 或凭据时启动失败', () => {
    for (const value of [
      'http://127.0.0.1:22122/api/management/v1',
      'http://127.0.0.1:22122/?token=test-token',
      'http://test-user:test-pass@127.0.0.1:22122',
      'ftp://127.0.0.1:22122',
      'not-a-url',
    ]) {
      const error = expectConfigError({ ...DEV_ENV, PARROT_BASE_URL: value }, `PARROT_BASE_URL=${value}`);
      expect(error.message).toContain('PARROT_BASE_URL');
    }
  });

  it('PARROT_BASE_URL 等于 WEBUI_PUBLIC_ORIGIN 时启动失败（避免 /webui/ 代理循环）', () => {
    const error = expectConfigError(
      { ...DEV_ENV, WEBUI_PUBLIC_ORIGIN: 'https://webui.test', PARROT_BASE_URL: 'https://webui.test' },
      '上游与公网来源相同',
    );
    expect(error.message).toContain('代理循环');
  });

  it('生产环境 WEBUI_TRUST_PROXY 为空、全信任或不合法时启动失败', () => {
    const empty = expectConfigError({ ...PROD_ENV, WEBUI_TRUST_PROXY: '' }, '空字符串');
    expect(empty.message).toContain('WEBUI_TRUST_PROXY');
    const blank = expectConfigError({ ...PROD_ENV, WEBUI_TRUST_PROXY: '   ' }, '仅空白');
    expect(blank.message).toContain('WEBUI_TRUST_PROXY');
    expectConfigError({ ...PROD_ENV, WEBUI_TRUST_PROXY: '*' }, '通配');
    expectConfigError({ ...PROD_ENV, WEBUI_TRUST_PROXY: 'true' }, '布尔全信任');
    expectConfigError({ ...PROD_ENV, WEBUI_TRUST_PROXY: '10.0.0.0/8, *' }, '混入通配');

    const ok = loadConfig({ ...PROD_ENV, WEBUI_TRUST_PROXY: '10.0.0.0/8, 127.0.0.1, ::1' });
    expect(ok.trustProxy).toEqual(['10.0.0.0/8', '127.0.0.1', '::1']);
  });

  it('会话与超时数值越界时启动失败', () => {
    expectConfigError({ ...DEV_ENV, WEBUI_SESSION_IDLE_SECONDS: '10' }, '空闲期过小');
    expectConfigError({ ...DEV_ENV, PARROT_REQUEST_TIMEOUT_MS: '0' }, '总超时为 0');
    expectConfigError(
      { ...DEV_ENV, WEBUI_SESSION_IDLE_SECONDS: '3600', WEBUI_SESSION_MAX_SECONDS: '600' },
      '绝对期小于空闲期',
    );
  });
});
