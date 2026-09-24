/**
 * 构建产物冒烟测试：直接用 apps/web/dist + apps/bff/dist 启动 BFF，验证
 * 静态托管、SPA fallback、缓存策略、安全响应头、BFF 接口与「非 /webui 路径不外泄」。
 *
 * 上游使用本地假服务器模拟——**不会连接任何真实 Parrot 实例**。
 *
 * 用法（先执行 pnpm build）：
 *   pnpm --filter @parrot-webui/e2e test:smoke
 *   PORT=4199 node tests/e2e/smoke-built.mjs
 */
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const PORT = Number(process.env.PORT ?? 3199);

// 仓库根目录：从本脚本位置向上两级（tests/e2e → 仓库根），不受调用时的工作目录影响
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
      res.on('end', () =>
        resolvePromise({
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const upstream = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  const payload = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (path === '/api/management/v1/meta') {
    payload(401, {
      error: { code: 'SESSION_REQUIRED', message: 'no session', fields: [], retryable: false, requestId: 'probe' },
    });
    return;
  }
  payload(404, {
    error: { code: 'RESOURCE_NOT_FOUND', message: 'nope', fields: [], retryable: false, requestId: 'req' },
  });
});

await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
const upstreamPort = upstream.address().port;

const child = spawn(process.execPath, [resolve(ROOT, 'apps/bff/dist/index.js')], {
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(PORT),
    WEBUI_BIND_HOST: '127.0.0.1',
    WEBUI_BASE_PATH: '/webui/',
    PARROT_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    WEBUI_PUBLIC_ORIGIN: `http://127.0.0.1:${PORT}`,
    WEBUI_STATIC_DIR: resolve(ROOT, 'apps/web/dist'),
    WEBUI_DEV_INSECURE_COOKIES: '1',
    WEBUI_INSTANCE_NAME: '冒烟实例',
    LOG_LEVEL: 'error',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (chunk) => (serverLog += chunk));
child.stderr.on('data', (chunk) => (serverLog += chunk));

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });
const host = `127.0.0.1:${PORT}`;

try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const probe = await call('/webui/health/live');
      if (probe.status === 200) {
        ready = true;
        break;
      }
    } catch {
      // 进程还在启动
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  check('进程启动并就绪（/webui/health/live）', ready, ready ? '' : serverLog.slice(0, 400));
  if (!ready) throw new Error('BFF 未就绪');

  const index = await call('/webui/', { headers: { accept: 'text/html', host } });
  check('GET /webui/ 返回 SPA 首页', index.status === 200 && index.text.includes('<div id="root">'), `status=${index.status}`);
  check(
    'index.html 使用重新验证缓存策略',
    String(index.headers['cache-control'] ?? '').includes('no-cache'),
    `cache=${index.headers['cache-control']}`,
  );
  check(
    'CSP/安全头正确（script-src self、frame-ancestors none、nosniff、no-referrer）',
    String(index.headers['content-security-policy']).includes("script-src 'self'") &&
      String(index.headers['content-security-policy']).includes("frame-ancestors 'none'") &&
      index.headers['x-content-type-options'] === 'nosniff' &&
      index.headers['referrer-policy'] === 'no-referrer',
    '',
  );

  const deepLink = await call('/webui/channels', { headers: { accept: 'text/html', host } });
  check('深链接 /webui/channels 走 SPA fallback', deepLink.status === 200 && deepLink.text.includes('id="root"'), `status=${deepLink.status}`);

  const jsonDeepLink = await call('/webui/channels', { headers: { accept: 'application/json', host } });
  check(
    '管理路径缺 /bff/management 前缀时被 BFF 拒绝（前端不得拼出这种 URL）',
    jsonDeepLink.status === 404 && jsonDeepLink.text.includes('WEBUI_NOT_FOUND'),
    `status=${jsonDeepLink.status}`,
  );

  const assetPath = index.text.match(/\/webui\/assets\/[^"']+/)?.[0];
  if (assetPath) {
    const asset = await call(assetPath, { headers: { host } });
    check(
      '带 hash 的静态资源长期缓存',
      asset.status === 200 && String(asset.headers['cache-control'] ?? '').includes('immutable'),
      `status=${asset.status} cache=${asset.headers['cache-control']}`,
    );
  } else {
    check('带 hash 的静态资源长期缓存', false, 'index.html 未引用 /webui/assets/*');
  }

  const bootstrap = await call('/webui/bff/bootstrap', { headers: { host } });
  const bootstrapBody = JSON.parse(bootstrap.text);
  check(
    'bootstrap 返回实例名、登录方式与预登录 CSRF',
    bootstrap.status === 200 &&
      bootstrapBody.data.instanceName === '冒烟实例' &&
      JSON.stringify(bootstrapBody.data.loginMethods) === '["managementKey"]' &&
      typeof bootstrapBody.data.csrfToken === 'string',
    `status=${bootstrap.status}`,
  );
  check('bootstrap 不泄露上游内部地址', !bootstrap.text.includes(`127.0.0.1:${upstreamPort}`), '');

  const unauth = await call('/webui/bff/management/channels', { headers: { host } });
  check('未登录业务请求 401 WEBUI_SESSION_REQUIRED', unauth.status === 401 && unauth.text.includes('WEBUI_SESSION_REQUIRED'), `status=${unauth.status}`);

  const loginNoOrigin = await call('/webui/bff/auth/login', {
    method: 'POST',
    headers: { host, 'content-type': 'application/json' },
    body: JSON.stringify({ managementKey: 'x'.repeat(48) }),
  });
  check('登录缺 Origin/CSRF 被拒', loginNoOrigin.status === 403 && loginNoOrigin.text.includes('WEBUI_'), `status=${loginNoOrigin.status}`);

  const unknownBff = await call('/webui/bff/nope', { headers: { host } });
  check('未知 BFF 路径返回 JSON 404', unknownBff.status === 404 && unknownBff.text.includes('WEBUI_'), `status=${unknownBff.status}`);

  const outside = await call('/api/management/v1/channels', { headers: { accept: 'text/html', host } });
  check('域名根下的 /api/... 不提供服务', outside.status === 404, `status=${outside.status}`);

  const wrongHost = await call('/webui/bff/bootstrap', { headers: { host: 'evil.example.test' } });
  check('错误 Host 被拒（421 WEBUI_HOST_REJECTED）', wrongHost.status === 421 && wrongHost.text.includes('WEBUI_HOST_REJECTED'), `status=${wrongHost.status}`);

  const healthExternal = await call('/webui/health/live', { headers: { host: 'evil.example.test' } });
  check('健康检查同样校验 Host', healthExternal.status === 421, `status=${healthExternal.status}`);
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
