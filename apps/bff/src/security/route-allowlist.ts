/**
 * 冻结的上游路由允许清单匹配器。
 *
 * 规则（实施文档 5.2）：
 * - 目标 origin 只来自部署配置；浏览器提供的任何 url/target 参数一律无效。
 * - 只匹配构建时冻结的 method + path 模板，未列入清单的管理操作直接拒绝。
 * - `/auth/*` 属于 class=auth，不进入通用业务代理。
 * - 路径必须拒绝越界规范化、`..`、反斜杠、绝对 URL、编码斜杠与双重解码绕过。
 */

import {
  FROZEN_UPSTREAM_ROUTES,
  UPSTREAM_MANAGEMENT_PREFIX,
  type FrozenUpstreamRoute,
} from '@parrot-webui/contracts/routes';
import { WebuiError } from '../errors.js';

interface CompiledRoute {
  readonly route: FrozenUpstreamRoute;
  /** 相对代理前缀的分段模板，例如 ['channels', '{channelId}'] */
  readonly segments: readonly string[];
  readonly staticSegments: number;
}

export interface RouteMatch {
  readonly route: FrozenUpstreamRoute;
  readonly params: Readonly<Record<string, string>>;
  /** 重新编码后的上游绝对路径（不含 query）。 */
  readonly upstreamPath: string;
}

const PARAM_PATTERN = /^\{([A-Za-z0-9_]+)\}$/;

function compileRoute(route: FrozenUpstreamRoute): CompiledRoute {
  if (!route.path.startsWith(`${UPSTREAM_MANAGEMENT_PREFIX}/`)) {
    throw new Error(`允许清单路由必须位于管理前缀内：${route.path}`);
  }
  const relative = route.path.slice(UPSTREAM_MANAGEMENT_PREFIX.length);
  const segments = relative.split('/').filter((segment) => segment !== '');
  return {
    route,
    segments,
    staticSegments: segments.filter((segment) => !PARAM_PATTERN.test(segment)).length,
  };
}

const PROXY_ROUTES: readonly CompiledRoute[] = FROZEN_UPSTREAM_ROUTES.filter(
  (route) => route.routeClass === 'proxy',
).map(compileRoute);

const AUTH_ROUTES: readonly CompiledRoute[] = FROZEN_UPSTREAM_ROUTES.filter(
  (route) => route.routeClass === 'auth',
).map(compileRoute);

export function proxyRouteCount(): number {
  return PROXY_ROUTES.length;
}

export function frozenRouteTable(): readonly FrozenUpstreamRoute[] {
  return FROZEN_UPSTREAM_ROUTES;
}

/** 代理前缀之内的原始路径（仍保持百分号编码），失败即拒绝。 */
export function assertSafeRequestPath(rawPath: string): string[] {
  if (!rawPath.startsWith('/')) {
    throw new WebuiError('WEBUI_INVALID_REQUEST', { message: '路径必须以 / 开头' });
  }
  if (rawPath.length > 2048) {
    throw new WebuiError('WEBUI_INVALID_REQUEST', { message: '路径过长' });
  }
  if (rawPath.includes('\\') || rawPath.includes('\0')) {
    throw new WebuiError('WEBUI_INVALID_REQUEST', { message: '路径包含非法字符' });
  }
  if (rawPath.startsWith('//')) {
    throw new WebuiError('WEBUI_INVALID_REQUEST', { message: '拒绝协议相对路径' });
  }
  const segments = rawPath.split('/').slice(1);
  return segments.map((segment) => {
    if (segment === '') {
      throw new WebuiError('WEBUI_INVALID_REQUEST', { message: '路径包含空分段' });
    }
    if (segment === '.' || segment === '..') {
      throw new WebuiError('WEBUI_INVALID_REQUEST', { message: '路径包含越界分段' });
    }
    if (/%2f|%5c/i.test(segment)) {
      throw new WebuiError('WEBUI_INVALID_REQUEST', { message: '资源标识中不允许出现编码斜杠' });
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new WebuiError('WEBUI_INVALID_REQUEST', { message: '路径分段不是合法百分号编码' });
    }
    if (decoded === '.' || decoded === '..') {
      throw new WebuiError('WEBUI_INVALID_REQUEST', { message: '路径包含编码后的越界分段' });
    }
    if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) {
      throw new WebuiError('WEBUI_INVALID_REQUEST', { message: '路径分段解码后包含分隔符' });
    }
    if (/[\u0000-\u001f\u007f]/.test(decoded)) {
      throw new WebuiError('WEBUI_INVALID_REQUEST', { message: '路径分段包含控制字符' });
    }
    return decoded;
  });
}

/**
 * 匹配一条代理路由。命中后返回的参数会被重新编码后再拼到固定上游 origin 上，
 * 因此浏览器无法通过参数改变目标主机、路径层级或方法。
 */
export function matchProxyRoute(method: string, rawPath: string): RouteMatch {
  const upperMethod = method.toUpperCase();
  const segments = assertSafeRequestPath(rawPath);

  let methodMatched = false;
  for (const compiled of PROXY_ROUTES) {
    if (compiled.segments.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let index = 0; index < compiled.segments.length; index += 1) {
      const template = compiled.segments[index]!;
      const actual = segments[index]!;
      const paramMatch = PARAM_PATTERN.exec(template);
      if (paramMatch) {
        params[paramMatch[1]!] = actual;
        continue;
      }
      if (template !== actual) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    if (compiled.route.method !== upperMethod) {
      methodMatched = true;
      continue;
    }
    const encoded = segments.map((segment) => encodeURIComponent(segment)).join('/');
    return {
      route: compiled.route,
      params,
      upstreamPath: `${UPSTREAM_MANAGEMENT_PREFIX}/${encoded}`,
    };
  }

  // 路径存在但方法不允许时给出 405，便于前端区分"操作不存在"和"方法不支持"。
  for (const compiled of AUTH_ROUTES) {
    if (compiled.segments.length !== segments.length) continue;
    const pathEquals = compiled.segments.every((template, index) => {
      const paramMatch = PARAM_PATTERN.exec(template);
      return paramMatch ? true : template === segments[index];
    });
    if (pathEquals) {
      throw new WebuiError('WEBUI_ROUTE_NOT_ALLOWED', {
        message: '登录相关接口只能由 WebUI 认证控制器调用，不进入业务代理',
      });
    }
  }
  if (methodMatched) {
    throw new WebuiError('WEBUI_METHOD_NOT_ALLOWED', {
      message: `该管理操作不支持 ${upperMethod}`,
    });
  }
  throw new WebuiError('WEBUI_ROUTE_NOT_ALLOWED', { message: `未在允许清单中：${upperMethod} ${rawPath}` });
}

/** 校验并规范化转发给上游的 query：只保留原始字符串，禁止危险键与超长内容。 */
const DENIED_QUERY_KEYS = new Set([
  'url',
  'target',
  'upstream',
  'endpoint',
  'host',
  'base',
  'redirect',
  'proxy',
  'next',
]);

export function sanitizeUpstreamQuery(rawQuery: string): string {
  if (!rawQuery) return '';
  if (rawQuery.length > 4096) {
    throw new WebuiError('WEBUI_INVALID_REQUEST', { message: 'query 过长' });
  }
  if (rawQuery.includes('\0') || rawQuery.includes('#')) {
    throw new WebuiError('WEBUI_INVALID_REQUEST', { message: 'query 包含非法字符' });
  }
  const params = new URLSearchParams(rawQuery);
  const forwarded = new URLSearchParams();
  for (const [key, value] of params) {
    const lowered = key.toLowerCase();
    if (DENIED_QUERY_KEYS.has(lowered)) {
      throw new WebuiError('WEBUI_INVALID_REQUEST', {
        message: `query 参数 ${key} 不被允许`,
      });
    }
    if (/(https?:|\/\/|\\|\.\.)/i.test(value)) {
      throw new WebuiError('WEBUI_INVALID_REQUEST', {
        message: `query 参数 ${key} 包含疑似目标地址或越界内容`,
      });
    }
    forwarded.append(key, value);
  }
  const encoded = forwarded.toString();
  return encoded ? `?${encoded}` : '';
}
