/**
 * 客户端来源解析与 IP/CIDR 匹配测试（对应实施文档 5.1 与 11.1：
 * 可信代理正确提取来源、伪造 XFF 无效、不同用户不共享同一限流来源）。
 */

import { describe, expect, it } from 'vitest';
import { ipMatchesCidr, isTrustedAddress, normalizeIp, resolveClientIp } from '../src/security/ip.js';

const LOCAL_TRUST = ['127.0.0.1', '::1'];
const LAN_TRUST = ['10.0.0.0/8', '127.0.0.0/8'];

describe('resolveClientIp', () => {
  it('直连地址不可信时忽略 X-Forwarded-For（伪造 XFF 无效）', () => {
    expect(resolveClientIp({ remoteAddress: '203.0.113.7', forwardedFor: '198.51.100.4' }, LOCAL_TRUST)).toBe('203.0.113.7');
    expect(
      resolveClientIp({ remoteAddress: '203.0.113.7', forwardedFor: '198.51.100.4, 127.0.0.1' }, LOCAL_TRUST),
    ).toBe('203.0.113.7');
    expect(
      resolveClientIp({ remoteAddress: '203.0.113.7', forwardedFor: ['192.0.2.9, 198.51.100.4'] }, LAN_TRUST),
    ).toBe('203.0.113.7');
    // 伪造不同 XFF 的同一客户端仍然得到同一个键，不能借 XFF 绕过限流
    const first = resolveClientIp({ remoteAddress: '203.0.113.7', forwardedFor: '198.51.100.1' }, LOCAL_TRUST);
    const second = resolveClientIp({ remoteAddress: '203.0.113.7', forwardedFor: '192.0.2.222' }, LOCAL_TRUST);
    expect(first).toBe(second);
  });

  it('直连地址可信时取 XFF 中最右侧的不可信地址', () => {
    expect(resolveClientIp({ remoteAddress: '127.0.0.1', forwardedFor: '198.51.100.4' }, LOCAL_TRUST)).toBe('198.51.100.4');
    // 右侧是可信任的代理，继续向左找第一个不可信地址
    expect(
      resolveClientIp({ remoteAddress: '127.0.0.1', forwardedFor: '203.0.113.7, 198.51.100.4, 127.0.0.1' }, [
        '127.0.0.1',
        '10.0.0.0/8',
      ]),
    ).toBe('198.51.100.4');
    // 链路全部可信任时退化为最左侧条目
    expect(resolveClientIp({ remoteAddress: '127.0.0.1', forwardedFor: '127.0.0.2, 127.0.0.1' }, LAN_TRUST)).toBe(
      '127.0.0.2',
    );
    // IPv4-mapped IPv6 直连地址同样按可信代理处理
    expect(resolveClientIp({ remoteAddress: '::ffff:127.0.0.1', forwardedFor: '198.51.100.4' }, LOCAL_TRUST)).toBe(
      '198.51.100.4',
    );
    // 可信代理但缺少 XFF：使用直连地址而不是空值
    expect(resolveClientIp({ remoteAddress: '10.1.2.3', forwardedFor: undefined }, LAN_TRUST)).toBe('10.1.2.3');
    expect(resolveClientIp({ remoteAddress: '10.1.2.3', forwardedFor: '' }, LAN_TRUST)).toBe('10.1.2.3');
    expect(resolveClientIp({ remoteAddress: '10.1.2.3', forwardedFor: 'unknown' }, LAN_TRUST)).toBe('10.1.2.3');
  });

  it('两个不同客户端得到不同的限流键，同一客户端保持稳定', () => {
    const keyA = resolveClientIp({ remoteAddress: '127.0.0.1', forwardedFor: '198.51.100.4' }, LOCAL_TRUST);
    const keyB = resolveClientIp({ remoteAddress: '127.0.0.1', forwardedFor: '198.51.100.5' }, LOCAL_TRUST);
    const keyAAgain = resolveClientIp({ remoteAddress: '127.0.0.1', forwardedFor: '198.51.100.4' }, LOCAL_TRUST);
    expect(keyA).not.toBe(keyB);
    expect(keyAAgain).toBe(keyA);
    expect(new Set([keyA, keyB]).size).toBe(2);
  });
});

describe('ipMatchesCidr', () => {
  it('覆盖 IPv4 CIDR、单地址与非法前缀', () => {
    expect(ipMatchesCidr('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(ipMatchesCidr('11.1.2.3', '10.0.0.0/8')).toBe(false);
    expect(ipMatchesCidr('192.168.1.5', '192.168.1.5')).toBe(true);
    expect(ipMatchesCidr('192.168.1.6', '192.168.1.5')).toBe(false);
    expect(ipMatchesCidr('192.168.1.5', '192.168.1.5/32')).toBe(true);
    expect(ipMatchesCidr('192.168.1.5', '192.168.1.0/24')).toBe(true);
    expect(ipMatchesCidr('0.0.0.0', '0.0.0.0/0')).toBe(true);
    expect(ipMatchesCidr('10.0.0.1', '10.0.0.0/33')).toBe(false);
    expect(ipMatchesCidr('10.0.0.1', '10.0.0.256/24')).toBe(false);
    // IPv4-mapped IPv6 归一化后按 IPv4 处理
    expect(ipMatchesCidr('::ffff:192.168.1.5', '192.168.1.0/24')).toBe(true);
  });

  it('覆盖 IPv6 CIDR、单地址与跨地址族不匹配', () => {
    expect(ipMatchesCidr('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(ipMatchesCidr('2001:db9::1', '2001:db8::/32')).toBe(false);
    expect(ipMatchesCidr('::1', '::1')).toBe(true);
    expect(ipMatchesCidr('::1', '::1/128')).toBe(true);
    expect(ipMatchesCidr('fe80::1', 'fe80::/10')).toBe(true);
    expect(ipMatchesCidr('fe80::1', 'fe80::/129')).toBe(false);
    expect(ipMatchesCidr('[::1]', '::1/128')).toBe(true);
    expect(ipMatchesCidr('::1', '127.0.0.1')).toBe(false);
    expect(ipMatchesCidr('127.0.0.1', '::1')).toBe(false);
  });

  it('normalizeIp 与 isTrustedAddress 只接受配置内的地址', () => {
    expect(normalizeIp(' 127.0.0.1 ')).toBe('127.0.0.1');
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIp('[::1]')).toBe('::1');
    expect(normalizeIp('::1')).toBe('::1');

    expect(isTrustedAddress('10.5.5.5', ['127.0.0.1', '10.0.0.0/8'])).toBe(true);
    expect(isTrustedAddress('10.5.5.5', ['127.0.0.1'])).toBe(false);
    expect(isTrustedAddress('::1', ['::1'])).toBe(true);
    expect(isTrustedAddress('198.51.100.4', ['127.0.0.1', '::1'])).toBe(false);
    expect(isTrustedAddress('198.51.100.4', [])).toBe(false);
  });
});
