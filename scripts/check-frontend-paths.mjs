#!/usr/bin/env node
/**
 * 一致性检查（静态，不发网络请求、不连接任何 Parrot 实例）：
 *
 * 1) 前端源码里出现的每个上游管理路径，是否都能命中冻结允许清单；
 * 2) 管理路径是否走了 managementRequest()（相对 /bff/management），
 *    而不是 requestJson()（只拼 Vite base）——后者会落到 /webui/<管理路径>，
 *    被 BFF 的 SPA fallback 以 404 WEBUI_NOT_FOUND 拒绝，前端显示
 *    「WebUI 拒绝了该请求（未到达 Parrot）」，也就是请求根本没到 Parrot；
 * 3) 管理路径是否被手工带上了 /bff 或 /webui 前缀（会拼成双前缀地址）。
 *
 * 用法：pnpm check:frontend-paths
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const routesPath = join(root, 'packages/contracts/generated/management-routes.ts');
const webSrc = join(root, 'apps/web/src');

if (!existsSync(routesPath)) {
  console.error('缺少 packages/contracts/generated/management-routes.ts；请先运行 pnpm contracts:generate');
  process.exit(2);
}

const UPSTREAM_PREFIX = '/api/management/v1';
const MANAGEMENT_PREFIXES = ['/bff', '/webui'];

// 1) 冻结允许清单中的 path 模板 → 正则
const templates = [...readFileSync(routesPath, 'utf8').matchAll(/"path": "([^"]+)"/g)].map((m) => m[1]);
const regexes = templates.map(
  (template) =>
    new RegExp(
      '^' +
        template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{[A-Za-z0-9_]+\\\}/g, '[^/]+') +
        '$',
    ),
);

// 2) 扫描前端源码里出现的请求路径（相对 /bff/management）；测试文件里的假路径不参与校验
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(ts|tsx)$/.test(full) && !/\.test\.(ts|tsx)$/.test(full)) files.push(full);
  }
})(webSrc);

/** 管理路径字面量：page/mutation 的 path，以及 managementRequest()/managementUrl() 的首参。 */
const patterns = [
  /path:\s*'(\/[^']*)'/g,
  /path:\s*`(\/[^`]*)`/g,
  /path:\s*\([^)]*\)\s*=>\s*[`'](\/[^`']*)/g,
  /(?:managementRequest|managementUrl)\s*(?:<[^()]*>)?\(\s*[`'](\/[^`']*)/g,
];

/**
 * requestJson() 只能用于 BFF 自带接口（/bff/*）。这里捕获任意首参（含变量、模板串）：
 * 泛型里可能含 >（例如 <Record<string, unknown>>），所以用 [^()]* 而不是 [^>]*，
 * 否则 requestJson<T>(`/operations/${id}`) 这种最危险的写法会被漏检。
 */
const requestJsonCall = /(?:^|[^.\w])requestJson\s*(?:<[^()]*>)?\(\s*([^\s,)]*)/g;

const found = new Map();
const misplacedRequestJson = [];
const handPrefixed = [];
const relative = (file) => file.slice(root.length + 1).split('\\').join('/');

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const where = relative(file);

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const raw = match[1];
      if (MANAGEMENT_PREFIXES.some((prefix) => raw.startsWith(prefix))) {
        // 管理路径必须相对 /bff/management，前缀由 client.ts 拼一次
        handPrefixed.push([raw, where]);
        continue;
      }
      const normalized = raw.replace(/\$\{[^}]*\}/g, 'PARAM');
      if (!found.has(normalized)) found.set(normalized, new Set());
      found.get(normalized).add(where);
    }
  }
  for (const match of source.matchAll(requestJsonCall)) {
    const lineStart = source.lastIndexOf('\n', match.index) + 1;
    const lineEnd = source.indexOf('\n', match.index);
    const line = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    // 跳过 client.ts 里 requestJson 的定义行与注释/文档里的提及（如 requestJson()）
    if (/function\s+requestJson/.test(line)) continue;
    if (/^\s*(\*|\/\/)/.test(line)) continue;
    const arg = match[1] ?? '';
    if (arg === '') continue;
    if (!/^(['"`])\/bff/.test(arg)) misplacedRequestJson.push([arg, where]);
  }
}

// 3) 前置校验：先报「请求根本到不了 Parrot」这类必然失败，再报允许清单
let failed = false;

if (handPrefixed.length) {
  failed = true;
  console.error('[check] 以下管理路径自己带了 /bff 或 /webui 前缀（会拼成 /webui/bff/management/bff/... 这类双前缀地址）：');
  for (const [path, where] of handPrefixed) console.error(`  ${path}   <- ${where}；请去掉前缀，只写相对 /bff/management 的管理路径`);
}

if (misplacedRequestJson.length) {
  failed = true;
  console.error('[check] 以下调用用 requestJson() 取管理路径（会落到 /webui/<管理路径> 而不是 /webui/bff/management/<管理路径>）：');
  for (const [arg, where] of misplacedRequestJson) {
    console.error(`  requestJson(${arg})   <- ${where}；管理接口请改用 managementRequest()`);
  }
}

if (failed) process.exit(1);

// 4) 允许清单校验
const unknown = [];
for (const [path, where] of found) {
  const candidate = `${UPSTREAM_PREFIX}${path}`.replace(/PARAM/g, 'x');
  if (!regexes.some((regex) => regex.test(candidate))) unknown.push([path, [...where]]);
}

console.log(`[check] 允许清单模板 ${templates.length} 条；前端出现的上游路径 ${found.size} 条`);
if (unknown.length) {
  console.error('[check] 以下路径不在允许清单内（会在运行时被 BFF 拒绝）：');
  for (const [path, where] of unknown) console.error(`  ${path}   <- ${where.join(', ')}`);
  process.exit(1);
}
console.log('[check] 通过：前端只调用允许清单内的管理路径，且管理前缀只由 managementRequest() 拼。');
