/**
 * BFF 运行配置：只从环境变量读取，并在启动时严格校验。
 *
 * 设计约束（来自实施文档 5.x / 9.2）：
 * - 上游地址只能来自 PARROT_BASE_URL，浏览器永远不能提供目标地址。
 * - 正式模式必须是 HTTPS 公开来源、固定 /webui/ 前缀、非空可信代理。
 * - 本文件不读取任何管理密钥；管理主密钥只在登录请求内短暂存在。
 */

export const FIXED_BASE_PATH = '/webui/';

export interface WebuiConfig {
  readonly nodeEnv: string;
  readonly isProduction: boolean;
  readonly port: number;
  readonly bindHost: string;
  readonly basePath: typeof FIXED_BASE_PATH;
  /** 唯一合法浏览器来源，例如 https://parrot.example.com（不含路径）。 */
  readonly publicOrigin: string;
  /** publicOrigin 的 host[:port]，用于 Host 校验。 */
  readonly publicHost: string;
  /** 本机 Parrot 的既有 origin，例如 http://host.docker.internal:22122。 */
  readonly upstreamOrigin: string;
  readonly upstreamOriginDisplay: string;
  readonly instanceName: string;
  readonly trustProxy: string[];
  readonly sessionIdleSeconds: number;
  readonly sessionMaxSeconds: number;
  readonly maxSessions: number;
  readonly maxPreloginSessions: number;
  readonly bootstrapTtlSeconds: number;
  readonly connectTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly maxUpstreamResponseBytes: number;
  readonly defaultBodyLimitBytes: number;
  readonly oauthImportBodyLimitBytes: number;
  readonly loginPerSourcePerMinute: number;
  readonly loginGlobalPerMinute: number;
  readonly bootstrapPerSourcePerMinute: number;
  readonly bootstrapGlobalPerMinute: number;
  readonly maxConcurrentLogin: number;
  readonly maxConcurrentBootstrap: number;
  readonly logLevel: string;
  readonly staticDir: string;
  readonly cookieSecure: boolean;
  readonly cookiePrefix: string;
  readonly exposeUpstreamOrigin: boolean;
  readonly allowInsecurePublicOrigin: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

function readString(env: Env, name: string, fallback?: string): string {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    if (fallback === undefined) throw new ConfigError(`缺少必填环境变量 ${name}`);
    return fallback;
  }
  return raw;
}

function readInt(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`环境变量 ${name} 必须是 ${min} 到 ${max} 之间的整数，当前为 ${raw}`);
  }
  return value;
}

function readBool(env: Env, name: string, fallback = false): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(raw.toLowerCase())) return false;
  throw new ConfigError(`环境变量 ${name} 必须是布尔值，当前为 ${raw}`);
}

/** 解析并校验一个"只作为 origin 使用"的 URL：禁止凭据、路径、query、fragment。 */
export function parseOrigin(value: string, envName: string): { origin: string; host: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`环境变量 ${envName} 不是合法 URL：${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`环境变量 ${envName} 只允许 http/https，当前为 ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new ConfigError(`环境变量 ${envName} 不得包含用户名或密码`);
  }
  if (url.search || url.hash) {
    throw new ConfigError(`环境变量 ${envName} 不得包含 query 或 fragment`);
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new ConfigError(
      `环境变量 ${envName} 只接受 origin，不得包含路径（当前为 ${url.pathname}）。管理前缀由 BFF 自行拼接。`,
    );
  }
  const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
  return { origin: `${url.protocol}//${host}`, host };
}

function parseTrustProxy(value: string): string[] {
  const entries = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!entries.length) throw new ConfigError('WEBUI_TRUST_PROXY 不得为空');
  for (const entry of entries) {
    if (entry === '*' || entry === 'true') {
      throw new ConfigError('WEBUI_TRUST_PROXY 不允许通配或全信任，请填写实际入口代理地址/CIDR');
    }
  }
  return entries;
}

export function loadConfig(env: Env = process.env): WebuiConfig {
  const nodeEnv = readString(env, 'NODE_ENV', 'development');
  const isProduction = nodeEnv === 'production';

  const basePathRaw = readString(env, 'WEBUI_BASE_PATH', FIXED_BASE_PATH);
  const normalizedBase = basePathRaw.endsWith('/') ? basePathRaw : `${basePathRaw}/`;
  if (normalizedBase !== FIXED_BASE_PATH) {
    throw new ConfigError(
      `WEBUI_BASE_PATH 首版固定为 ${FIXED_BASE_PATH}（当前为 ${basePathRaw}）；前端 base、BFF 路径与 Cookie Path 必须一致。`,
    );
  }

  const allowInsecurePublicOrigin = readBool(env, 'WEBUI_ALLOW_INSECURE_PUBLIC_ORIGIN', false);
  const publicOriginValue = readString(env, 'WEBUI_PUBLIC_ORIGIN', isProduction ? undefined : 'http://127.0.0.1:5173');
  const publicOriginInfo = parseOrigin(publicOriginValue, 'WEBUI_PUBLIC_ORIGIN');
  if (isProduction && publicOriginInfo.origin.startsWith('http://') && !allowInsecurePublicOrigin) {
    throw new ConfigError(
      '正式模式要求 WEBUI_PUBLIC_ORIGIN 为 https；本地纯代码调试请设置 NODE_ENV=development 或显式 WEBUI_ALLOW_INSECURE_PUBLIC_ORIGIN=1',
    );
  }

  const upstreamOriginInfo = parseOrigin(readString(env, 'PARROT_BASE_URL'), 'PARROT_BASE_URL');
  if (upstreamOriginInfo.origin === publicOriginInfo.origin) {
    throw new ConfigError(
      'PARROT_BASE_URL 不能等于 WEBUI_PUBLIC_ORIGIN，否则会通过 /webui/ 形成代理循环；请指向本机 Parrot 的内部入口。',
    );
  }
  if (new URL(upstreamOriginInfo.origin).pathname !== '/') {
    throw new ConfigError('PARROT_BASE_URL 不得包含路径（不要带 /api/management/v1）');
  }

  const trustProxyRaw = env.WEBUI_TRUST_PROXY ?? '';
  let trustProxy: string[] = [];
  if (trustProxyRaw.trim()) {
    trustProxy = parseTrustProxy(trustProxyRaw);
  } else if (isProduction) {
    throw new ConfigError('正式模式必须设置 WEBUI_TRUST_PROXY，列出实际反向代理地址/CIDR；禁止全信任');
  } else {
    trustProxy = ['127.0.0.1', '::1'];
  }

  const sessionIdleSeconds = readInt(env, 'WEBUI_SESSION_IDLE_SECONDS', 1800, 60, 86400);
  const sessionMaxSeconds = readInt(env, 'WEBUI_SESSION_MAX_SECONDS', 28800, 300, 604800);
  if (sessionMaxSeconds < sessionIdleSeconds) {
    throw new ConfigError('WEBUI_SESSION_MAX_SECONDS 不得小于 WEBUI_SESSION_IDLE_SECONDS');
  }

  const insecureDevCookies = !isProduction && readBool(env, 'WEBUI_DEV_INSECURE_COOKIES', true);
  const cookieSecure = !insecureDevCookies;
  const cookiePrefix = cookieSecure ? '__Secure-' : '';

  return {
    nodeEnv,
    isProduction,
    port: readInt(env, 'PORT', 3000, 1, 65535),
    bindHost: readString(env, 'WEBUI_BIND_HOST', '0.0.0.0'),
    basePath: FIXED_BASE_PATH,
    publicOrigin: publicOriginInfo.origin,
    publicHost: publicOriginInfo.host,
    upstreamOrigin: upstreamOriginInfo.origin,
    upstreamOriginDisplay: isProduction && !readBool(env, 'WEBUI_DIAGNOSTICS_EXPOSE_UPSTREAM', false)
      ? '已配置（默认不外显，设置 WEBUI_DIAGNOSTICS_EXPOSE_UPSTREAM=1 可显示）'
      : upstreamOriginInfo.origin,
    instanceName: readString(env, 'WEBUI_INSTANCE_NAME', 'Parrot'),
    trustProxy,
    sessionIdleSeconds,
    sessionMaxSeconds,
    maxSessions: readInt(env, 'WEBUI_MAX_SESSIONS', 100, 1, 10000),
    maxPreloginSessions: readInt(env, 'WEBUI_MAX_PRELOGIN_SESSIONS', 200, 1, 10000),
    bootstrapTtlSeconds: 300,
    connectTimeoutMs: readInt(env, 'PARROT_CONNECT_TIMEOUT_MS', 5000, 200, 120000),
    requestTimeoutMs: readInt(env, 'PARROT_REQUEST_TIMEOUT_MS', 30000, 1000, 600000),
    maxUpstreamResponseBytes: readInt(env, 'WEBUI_MAX_UPSTREAM_RESPONSE_BYTES', 10 * 1024 * 1024, 1024, 200 * 1024 * 1024),
    defaultBodyLimitBytes: readInt(env, 'WEBUI_BODY_LIMIT_BYTES', 1024 * 1024, 1024, 50 * 1024 * 1024),
    oauthImportBodyLimitBytes: readInt(env, 'WEBUI_OAUTH_IMPORT_BODY_LIMIT_BYTES', 5 * 1024 * 1024, 1024, 200 * 1024 * 1024),
    loginPerSourcePerMinute: readInt(env, 'WEBUI_LOGIN_PER_SOURCE_PER_MINUTE', 5, 1, 1000),
    loginGlobalPerMinute: readInt(env, 'WEBUI_LOGIN_GLOBAL_PER_MINUTE', 30, 1, 10000),
    bootstrapPerSourcePerMinute: readInt(env, 'WEBUI_BOOTSTRAP_PER_SOURCE_PER_MINUTE', 20, 1, 1000),
    bootstrapGlobalPerMinute: readInt(env, 'WEBUI_BOOTSTRAP_GLOBAL_PER_MINUTE', 100, 1, 10000),
    maxConcurrentLogin: readInt(env, 'WEBUI_MAX_CONCURRENT_LOGIN', 4, 1, 100),
    maxConcurrentBootstrap: readInt(env, 'WEBUI_MAX_CONCURRENT_BOOTSTRAP', 8, 1, 200),
    logLevel: readString(env, 'LOG_LEVEL', 'info'),
    staticDir: readString(env, 'WEBUI_STATIC_DIR', new URL('../../web/dist', import.meta.url).pathname),
    cookieSecure,
    cookiePrefix,
    exposeUpstreamOrigin: readBool(env, 'WEBUI_DIAGNOSTICS_EXPOSE_UPSTREAM', false),
    allowInsecurePublicOrigin,
  };
}

/** 启动时打印的脱敏配置摘要（不含任何凭据）。 */
export function describeConfig(config: WebuiConfig): Record<string, unknown> {
  return {
    nodeEnv: config.nodeEnv,
    basePath: config.basePath,
    publicOrigin: config.publicOrigin,
    instanceName: config.instanceName,
    upstreamOrigin: config.nodeEnv === 'production' ? '(已配置，默认不外显)' : config.upstreamOrigin,
    trustProxyEntries: config.trustProxy.length,
    sessionIdleSeconds: config.sessionIdleSeconds,
    sessionMaxSeconds: config.sessionMaxSeconds,
    cookieSecure: config.cookieSecure,
    logLevel: config.logLevel,
  };
}
