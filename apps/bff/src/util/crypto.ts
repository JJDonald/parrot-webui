/**
 * 生成与管理随机会话标识的工具。
 *
 * 浏览器只持有随机值本身；BFF 内部一律以该值的 sha256 作为存储键，
 * 内存转储或日志泄露不会直接给出可用 Cookie 值。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sessionKeyFromToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function timingSafeEqualStrings(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

/** 校验来自浏览器的 X-Request-Id：只接受安全字符集与合理长度，否则由 BFF 生成。 */
export function sanitizeRequestId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(trimmed)) return null;
  return trimmed;
}

export function newRequestId(): string {
  return randomBytes(12).toString('hex');
}
