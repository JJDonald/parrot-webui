/**
 * 浏览器请求安全校验：Host、Origin、Fetch Metadata、CSRF。
 *
 * 这些校验是"不修改原 Origin 白名单"方案的前提：BFF 自己完成来源与 CSRF 校验后，
 * 才以无 Origin 的服务端请求访问上游（实施文档 5.1 / 5.3）。
 */

import type { FastifyRequest } from 'fastify';
import type { WebuiConfig } from '../config.js';
import { WebuiError } from '../errors.js';
import { timingSafeEqualStrings } from '../util/crypto.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const INTERNAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isWriteMethod(method: string): boolean {
  return WRITE_METHODS.has(method.toUpperCase());
}

function hostHeader(request: FastifyRequest): string {
  const value = request.headers.host;
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Host 校验：默认只接受部署域名；健康检查可额外接受内部主机名。 */
export function assertHost(request: FastifyRequest, config: WebuiConfig, allowInternalHost = false): void {
  const host = hostHeader(request);
  if (!host) throw new WebuiError('WEBUI_HOST_REJECTED', { message: '缺少 Host 头' });
  if (host === config.publicHost.toLowerCase()) return;
  if (allowInternalHost) {
    const bare = host.replace(/:\d+$/, '');
    if (INTERNAL_HOSTS.has(bare) || bare === config.bindHost.toLowerCase()) return;
  }
  throw new WebuiError('WEBUI_HOST_REJECTED', {
    message: `Host 与部署域名不一致（期望 ${config.publicHost}）`,
  });
}

/**
 * 写请求的 Origin 校验：必须精确等于 WEBUI_PUBLIC_ORIGIN。
 * 缺失、null、错误一律拒绝，不因为 Cookie 有效而放行。
 * 非写请求携带了错误 Origin 同样拒绝（防御性）。
 */
export function assertOrigin(request: FastifyRequest, config: WebuiConfig): void {
  const raw = request.headers.origin;
  const write = isWriteMethod(request.method);
  if (raw === undefined) {
    if (write) {
      throw new WebuiError('WEBUI_ORIGIN_REJECTED', { message: '写请求必须携带 Origin' });
    }
    return;
  }
  if (typeof raw !== 'string' || raw === 'null' || raw.trim() === '') {
    throw new WebuiError('WEBUI_ORIGIN_REJECTED', { message: 'Origin 为空或 null' });
  }
  if (raw.trim().toLowerCase() !== config.publicOrigin.toLowerCase()) {
    throw new WebuiError('WEBUI_ORIGIN_REJECTED', {
      message: `Origin 不被信任（期望 ${config.publicOrigin}）`,
    });
  }
  // Fetch Metadata 作为补充校验，不能替代 Origin/CSRF。
  const site = request.headers['sec-fetch-site'];
  if (typeof site === 'string' && !['same-origin', 'none'].includes(site.toLowerCase())) {
    throw new WebuiError('WEBUI_ORIGIN_REJECTED', { message: `Sec-Fetch-Site=${site} 不被信任` });
  }
}

export function assertCsrf(request: FastifyRequest, expectedToken: string | undefined): void {
  const header = request.headers['x-csrf-token'];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!expectedToken) {
    throw new WebuiError('WEBUI_CSRF_REJECTED', { message: '当前会话没有可用的 CSRF Token' });
  }
  if (!provided || !timingSafeEqualStrings(provided, expectedToken)) {
    throw new WebuiError('WEBUI_CSRF_REJECTED');
  }
}

/** 只允许 JSON（或空）请求体，避免把任意内容类型转发给上游。 */
export function assertJsonContentType(request: FastifyRequest): void {
  if (!isWriteMethod(request.method)) return;
  const raw = request.headers['content-type'];
  if (raw === undefined) return;
  const value = (Array.isArray(raw) ? raw[0] : raw) ?? '';
  const mime = value.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mime !== '' && mime !== 'application/json') {
    throw new WebuiError('WEBUI_UNSUPPORTED_CONTENT_TYPE', {
      message: `只支持 application/json，收到 ${mime}`,
    });
  }
}
