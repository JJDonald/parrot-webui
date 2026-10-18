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

/**
 * 上游用 Starlette 的 `{param:path}` 转换器声明的路由。
 *
 * OpenAPI 无法表达 path 转换器，快照里这类参数退化成单段参数（`{modelId}`），
 * 因此 `provider/model-a` 这种带斜杠的合法取值会被 BFF 单段匹配挡下。
 * 处理方式：仍然对每一段做与普通路径完全相同的安全校验，只在重拼上游路径时
 * 保留分段结构——上游路径前缀固定为 `/stats/models/`，逐段拒绝 `.`/`..`/编码斜杠/
 * 控制字符，所以不可能借助斜杠越界到其他前缀下。
 */
const PATH_CONVERTER_ROUTES = new Set<string>(['/api/management/v1/stats/models/{modelId}']);
/** 上游 `Path(alias="modelId", min_length=1, max_length=256)` 的上限。 */
const PATH_CONVERTER_MAX_LENGTH = 256;

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
    const usesPathConverter = PATH_CONVERTER_ROUTES.has(compiled.route.path);
    if (usesPathConverter ? segments.length < compiled.segments.length : compiled.segments.length !== segments.length) {
      continue;
    }
    const params: Record<string, string> = {};
    // path 转换器参数会吃掉剩余全部分段
    let consumed: string[] = segments;
    let matched = true;
    const paramIndex = usesPathConverter ? compiled.segments.length - 1 : -1;
    for (let index = 0; index < compiled.segments.length; index += 1) {
      const template = compiled.segments[index]!;
      const paramMatch = PARAM_PATTERN.exec(template);
      if (index === paramIndex) {
        const tail = segments.slice(index);
        const joined = tail.join('/');
        if (!joined || joined.length > PATH_CONVERTER_MAX_LENGTH) {
          matched = false;
          break;
        }
        params[paramMatch?.[1] ?? 'modelId'] = joined;
        consumed = segments.slice(0, index);
        break;
      }
      if (paramMatch) {
        params[paramMatch[1]!] = segments[index]!;
        continue;
      }
      if (template !== segments[index]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    if (compiled.route.method !== upperMethod) {
      methodMatched = true;
      continue;
    }
    const encoded =
      paramIndex >= 0
        ? `${consumed.map((segment) => encodeURIComponent(segment)).join('/')}/${segments
            .slice(paramIndex)
            .map((segment) => encodeURIComponent(segment))
            .join('/')}`
        : segments.map((segment) => encodeURIComponent(segment)).join('/');
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

/**
 * 路径穿越形状：`..` 必须构成独立的一段才算越界（`../`、`..\`、`a/../b`、整值 `..`）。
 * 注意不能简单匹配子串 `..`——日志搜索里的 `a..b`、版本号、文件名都会被误伤，
 * 而 query 值永远不参与请求目标的拼接（目标 origin 与 path 都是固定的），
 * 所以真正的越界风险只来自"看起来像一段相对路径"的形状。
 */
const TRAVERSAL_PATTERN = /(^|[\\/])\.\.([\\/]|$)/;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
const MAX_QUERY_VALUE_LENGTH = 1024;

export function sanitizeUpstreamQuery(rawQuery: string): string {
  if (!rawQuery) return '';
  if (rawQuery.length > 4096) {
    throw new WebuiError('WEBUI_INVALID_REQUEST', { message: 'query 过长' });
  }
  if (rawQuery.includes('#') || CONTROL_CHAR_PATTERN.test(rawQuery)) {
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
    // 原始串里不含控制字符不代表解码后没有：%00 / %0a 等编码形式必须一并拒绝
    if (CONTROL_CHAR_PATTERN.test(key) || CONTROL_CHAR_PATTERN.test(value)) {
      throw new WebuiError('WEBUI_INVALID_REQUEST', { message: `query 参数 ${key} 包含控制字符` });
    }
    if (value.length > MAX_QUERY_VALUE_LENGTH) {
      throw new WebuiError('WEBUI_INVALID_REQUEST', {
        message: `query 参数 ${key} 过长`,
      });
    }
    if (TRAVERSAL_PATTERN.test(value)) {
      throw new WebuiError('WEBUI_INVALID_REQUEST', {
        message: `query 参数 ${key} 包含疑似越界路径`,
      });
    }
    forwarded.append(key, value);
  }
  const encoded = forwarded.toString();
  return encoded ? `?${encoded}` : '';
}
