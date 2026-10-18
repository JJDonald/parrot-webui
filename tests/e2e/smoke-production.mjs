/**
 * 生产模式冒烟测试：用**真实构建产物**（apps/bff/dist + apps/web/dist）以
 * `NODE_ENV=production` 启动 BFF，验证只在生产模式才存在的约束。
 *
 * 为什么单独一个脚本：`smoke-built.mjs` 跑的是 `NODE_ENV=development` + 明文 HTTP，
 * 因此 `__Secure-` Cookie 前缀、`Secure` 属性、HSTS 全都不生效——那几条路径在
 * 修复评审前是**零测试覆盖**的。
 *
 * 为什么不用 `fetch`：`Host` 是 forbidden header，`fetch` 无法设置，所有请求会被
 * `assertHost` 挡成 421。必须用 `node:http` 才能精确控制 Host / Origin / XFF。
 *
 * 上游使用本地假服务器模拟——**不会连接任何真实 Parrot 实例**。
 *
 * 用法（先执行 pnpm build）：
 *   pnpm --filter @parrot-webui/e2e test:smoke:prod
 */
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 3299);
const PUBLIC_ORIGIN = 'https://webui.example.com';
const PUBLIC_HOST = 'webui.example.com';
/** 假上游泄露标记：任何响应/日志里出现它就算凭据泄露。 */
const LEAK_MARKER = 'cred-SECRET-DO-NOT-LEAK';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

for (const required of ['apps/bff/dist/index.js', 'apps/web/dist/index.html']) {
  if (!existsSync(resolve(ROOT, required))) {
    console.error(`缺少构建产物 ${required}；请先运行 pnpm build`);
    process.exit(2);
  }
}

function call(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: PORT, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolvePromise({ status: res.statusCode, headers: res.headers, raw, text: raw.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// --------------------------------------------------------------- 假上游
const upstreamRequests = [];
const upstream = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  upstreamRequests.push({ method: req.method, path, headers: req.headers });
  res.setHeader('content-type', 'application/json; charset=utf-8');

  if (path === '/api/management/v1/meta') {
    // 未认证探测：401 既证明可达，也不泄露内容
    res.statusCode = 401;
    res.end(JSON.stringify({ error: { code: 'SESSION_REQUIRED', message: 'need session' } }));
    return;
  }
  if (path === '/api/management/v1/auth/sessions') {
    res.statusCode = 201;
    // 上游自己的 Set-Cookie 绝不能被透传给浏览器
    res.setHeader('set-cookie', 'upstream-should-not-leak=1; Path=/');
    res.end(
      JSON.stringify({
        data: {
          credential: LEAK_MARKER,
          session: {
            sessionId: 'sess-1',
            subjectId: 'subject-1',
            authMethod: 'managementKey',
            roles: ['administrator'],
            capabilities: ['management.read', 'management.write', 'management.logs.body.read'],
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
            idleExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          },
        },
        meta: { requestId: 'up-1' },
      }),
    );
    return;
  }
  if (path === '/api/management/v1/auth/session') {
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        data: {
          sessionId: 'sess-1',
          subjectId: 'subject-1',
          authMethod: 'managementKey',
          roles: ['administrator'],
          capabilities: ['management.read', 'management.write', 'management.logs.body.read'],
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
          idleExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        },
        meta: { requestId: 'up-2' },
      }),
    );
    return;
  }
  res.statusCode = 200;
  res.end(JSON.stringify({ data: { echoed: path }, meta: { requestId: 'up-3' } }));
});

await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;

// ----------------------------------------------------------- 启动生产态 BFF
const child = spawn(process.execPath, [resolve(ROOT, 'apps/bff/dist/index.js')], {
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    WEBUI_BIND_HOST: '127.0.0.1',
    WEBUI_BASE_PATH: '/webui/',
    PARROT_BASE_URL: upstreamOrigin,
    WEBUI_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    WEBUI_TRUST_PROXY: '127.0.0.1',
    WEBUI_STATIC_DIR: resolve(ROOT, 'apps/web/dist'),
    WEBUI_INSTANCE_NAME: '生产冒烟实例',
    LOG_LEVEL: 'error',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (chunk) => (serverLog += chunk));
child.stderr.on('data', (chunk) => (serverLog += chunk));

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const probe = await call('/webui/health/live', { headers: { host: PUBLIC_HOST } });
      if (probe.status === 200) {
        ready = true;
        break;
      }
    } catch {
      // 进程还在启动
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  check('生产模式进程启动并就绪', ready, ready ? '' : serverLog.slice(0, 400));
  if (!ready) throw new Error('BFF 未就绪（生产模式启动失败）');

  // ---------------------------------------------------------- 1. Cookie 属性
  const bootstrap = await call('/webui/bff/bootstrap', { headers: { host: PUBLIC_HOST } });
  const cookies = [].concat(bootstrap.headers['set-cookie'] ?? []).join(' | ');
  check(
    'bootstrap 200 且不泄露上游内部地址',
    bootstrap.status === 200 && !bootstrap.text.includes('127.0.0.1') && !bootstrap.text.includes(String(upstream.address().port)),
    `status=${bootstrap.status}`,
  );
  check(
    '生产 Cookie：__Secure- 前缀 + Secure + HttpOnly + SameSite=Lax + Path=/webui/ + 无 Domain',
    /__Secure-parrot_webui_prelogin=/.test(cookies) &&
      /Secure/.test(cookies) &&
      /HttpOnly/.test(cookies) &&
      /SameSite=Lax/.test(cookies) &&
      /Path=\/webui\//.test(cookies) &&
      !/Domain=/.test(cookies),
    cookies.slice(0, 160),
  );

  // ---------------------------------------------------------- 2. 生产安全头
  const headers = bootstrap.headers;
  check('HSTS 一年且含 includeSubDomains', String(headers['strict-transport-security'] ?? '') === 'max-age=31536000; includeSubDomains', String(headers['strict-transport-security']));
  const csp = String(headers['content-security-policy'] ?? '');
  check('CSP 含 script-src self 与 frame-ancestors none', csp.includes("script-src 'self'") && csp.includes("frame-ancestors 'none'"));
  check('X-Frame-Options DENY', headers['x-frame-options'] === 'DENY');
  check('X-Content-Type-Options nosniff', headers['x-content-type-options'] === 'nosniff');
  check('Referrer-Policy no-referrer', headers['referrer-policy'] === 'no-referrer');

  const bootstrapBody = JSON.parse(bootstrap.text);
  const preloginCookie = (bootstrap.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).join('; ');
  const preloginCsrf = bootstrapBody.data.csrfToken;

  // ------------------------------------------------------ 3. 写请求的校验
  const badOrigin = await call('/webui/bff/auth/login', {
    method: 'POST',
    headers: {
      host: PUBLIC_HOST,
      origin: 'https://evil.example.com',
      'content-type': 'application/json',
      'x-csrf-token': preloginCsrf,
      cookie: preloginCookie,
    },
    body: JSON.stringify({ managementKey: 'x'.repeat(32) }),
  });
  check('错误 Origin → 403 WEBUI_ORIGIN_REJECTED', badOrigin.status === 403 && badOrigin.text.includes('WEBUI_ORIGIN_REJECTED'), `status=${badOrigin.status}`);

  const badJson = await call('/webui/bff/auth/login', {
    method: 'POST',
    headers: {
      host: PUBLIC_HOST,
      origin: PUBLIC_ORIGIN,
      'content-type': 'application/json',
      'x-csrf-token': preloginCsrf,
      cookie: preloginCookie,
    },
    body: '{"managementKey": ',
  });
  check(
    '畸形 JSON → 400 WEBUI_INVALID_REQUEST（不得是 500）',
    badJson.status === 400 && badJson.text.includes('WEBUI_INVALID_REQUEST'),
    `status=${badJson.status}`,
  );
  check('错误响应带 cache-control: no-store', String(badJson.headers['cache-control'] ?? '') === 'no-store');

  const oversized = JSON.stringify({ managementKey: 'x'.repeat(20 * 1024) });
  const oversizedLogin = await call('/webui/bff/auth/login', {
    method: 'POST',
    headers: {
      host: PUBLIC_HOST,
      origin: PUBLIC_ORIGIN,
      'content-type': 'application/json',
      'x-csrf-token': preloginCsrf,
      cookie: preloginCookie,
      'content-length': Buffer.byteLength(oversized),
    },
    body: oversized,
  });
  check('登录请求体超 16 KiB → 413（路由级上限）', oversizedLogin.status === 413, `status=${oversizedLogin.status} bytes=${Buffer.byteLength(oversized)}`);

  // ------------------------------------------------------------ 4. 正常登录
  const login = await call('/webui/bff/auth/login', {
    method: 'POST',
    headers: {
      host: PUBLIC_HOST,
      origin: PUBLIC_ORIGIN,
      'content-type': 'application/json',
      'x-csrf-token': preloginCsrf,
      cookie: preloginCookie,
    },
    body: JSON.stringify({ managementKey: 'x'.repeat(32) }),
  });
  check('正常登录 200', login.status === 200, `status=${login.status} ${login.text.slice(0, 160)}`);
  check('登录响应不含上游 credential', !login.text.includes(LEAK_MARKER));
  check('上游 Set-Cookie 未被透传给浏览器', !JSON.stringify(login.headers['set-cookie'] ?? []).includes('upstream-should-not-leak'));

  const loginBody = JSON.parse(login.text);
  const sessionCookie = (login.headers['set-cookie'] ?? [])
    .map((c) => c.split(';')[0])
    .filter((c) => c.startsWith('__Secure-parrot_webui_session'))
    .join('; ');
  check(
    '登录后签发独立的新 CSRF（预登录 Token 不复用）',
    Boolean(loginBody.data?.csrfToken) && loginBody.data.csrfToken !== preloginCsrf,
  );

  // -------------------------------------------- 5. 会话摘要与 capabilities
  const session = await call('/webui/bff/auth/session', { headers: { host: PUBLIC_HOST, cookie: sessionCookie } });
  const sessionBody = JSON.parse(session.text);
  check(
    'session 暴露上游 capabilities（前端 canWrite 判定依据）',
    Array.isArray(sessionBody.data?.capabilities) && sessionBody.data.capabilities.includes('management.write'),
    JSON.stringify(sessionBody.data?.capabilities),
  );
  check('session 响应不含 credential', !session.text.includes(LEAK_MARKER));

  // ------------------------------------ 6. 诊断：requestSource 与版本号
  const diagnostics = await call('/webui/bff/diagnostics', {
    headers: { host: PUBLIC_HOST, cookie: sessionCookie, 'x-forwarded-for': '203.0.113.7' },
  });
  const diagnosticsBody = JSON.parse(diagnostics.text);
  check('诊断接口 200', diagnostics.status === 200, `status=${diagnostics.status}`);
  check(
    '诊断暴露 requestSource：可信代理生效、clientIp 取自 XFF',
    diagnosticsBody.data?.requestSource?.remoteTrusted === true &&
      diagnosticsBody.data?.requestSource?.clientIp === '203.0.113.7',
    JSON.stringify(diagnosticsBody.data?.requestSource ?? null),
  );
  check(
    '诊断版本号取自 apps/bff/package.json（不是硬编码）',
    typeof diagnosticsBody.data?.webui?.version === 'string' && diagnosticsBody.data.webui.version !== 'unknown',
    String(diagnosticsBody.data?.webui?.version),
  );

  // ------------------------------------------- 7. 静态产物与源码保护
  const index = await call('/webui/', { headers: { accept: 'text/html', host: PUBLIC_HOST } });
  check(
    'SPA 首页 200 + no-cache',
    index.status === 200 && String(index.headers['cache-control'] ?? '').includes('no-cache'),
    `status=${index.status} cache=${index.headers['cache-control']}`,
  );

  const assetPath = index.text.match(/\/webui\/assets\/[^"']+\.js/)?.[0];
  if (!assetPath) {
    check('index.html 引用了 assets 主包', false, '未匹配到 /webui/assets/*.js');
  } else {
    check('index.html 引用了 assets 主包', true, assetPath);
    const map = await call(`${assetPath}.map`, { headers: { host: PUBLIC_HOST } });
    check('生产态不托管 sourcemap', map.status === 404, `status=${map.status}`);
    const compressed = await call(assetPath, { headers: { host: PUBLIC_HOST, 'accept-encoding': 'br' } });
    const identity = await call(assetPath, { headers: { host: PUBLIC_HOST } });
    check(
      '生产态 Brotli 预压缩生效（比 identity 小）',
      compressed.status === 200 &&
        compressed.headers['content-encoding'] === 'br' &&
        compressed.raw.length < identity.raw.length,
      `br=${compressed.raw.length} identity=${identity.raw.length}`,
    );
  }

  // ------------------------------------------------ 8. 允许清单与路径攻击
  const notAllowed = await call('/webui/bff/management/updates/check', { headers: { host: PUBLIC_HOST, cookie: sessionCookie } });
  check('允许清单外路由被拒', notAllowed.status === 404, `status=${notAllowed.status}`);

  const traversal = await call('/webui/bff/management/channels/%2e%2e/meta', { headers: { host: PUBLIC_HOST, cookie: sessionCookie } });
  check('路径穿越被拒', traversal.status === 404 || traversal.status === 400, `status=${traversal.status}`);

  const shadowEndpoint = await call('/webui/bff/management/session-summary', { headers: { host: PUBLIC_HOST, cookie: sessionCookie } });
  check('已删除的 session-summary 影子端点不可达', shadowEndpoint.status === 404, `status=${shadowEndpoint.status}`);

  // ------------------------------------------------- 9. query 净化的边界
  const hitsBefore = upstreamRequests.length;
  const legalQuery = await call('/webui/bff/management/logs?query=nginx%2F1.2.3&page=1', { headers: { host: PUBLIC_HOST, cookie: sessionCookie } });
  check(
    '合法 query（版本号含斜杠）放行并真的触达上游',
    legalQuery.status === 200 && upstreamRequests.length > hitsBefore,
    `status=${legalQuery.status} upstreamHits=${upstreamRequests.length - hitsBefore}`,
  );
  const illegalQuery = await call('/webui/bff/management/logs?query=..%2F..%2Fetc%2Fpasswd', { headers: { host: PUBLIC_HOST, cookie: sessionCookie } });
  check('真实相对路径 query 被拒', illegalQuery.status === 400, `status=${illegalQuery.status}`);

  // ------------------------------------------------------- 10. 日志不泄露
  check('BFF 日志不含上游 credential', !serverLog.includes(LEAK_MARKER), serverLog.slice(0, 200));
} finally {
  child.kill('SIGTERM');
  upstream.close();
}

let failed = 0;
for (const result of results) {
  if (!result.ok) failed += 1;
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? `  — ${result.detail}` : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
