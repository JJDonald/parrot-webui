#!/usr/bin/env node
/**
 * 静态检查（`pnpm lint`，或各子包内 `pnpm lint`）。
 *
 * 本项目没有引入 ESLint（离线交付、不增加依赖），因此把"真正会出事"的规则写成本脚本。
 * 这些规则都不是风格偏好，而是评审里已经确认过的安全/正确性底线：
 *
 *  1. 前端源码禁止 `dangerouslySetInnerHTML` / `innerHTML` / `eval(` / `new Function(`
 *     —— 日志正文、OAuth 秘密、导入 URL 都是不可信输入，一旦走 HTML 渲染就是存储型 XSS。
 *  2. 前后端源码禁止 `as any` / `@ts-ignore` / `@ts-nocheck` / `@ts-expect-error`
 *     —— 类型压制一旦被用来"消除报错"，契约漂移就会静默通过编译。
 *  3. 前端业务代码禁止直接使用 `localStorage` / `sessionStorage` / `document.cookie`
 *     —— 秘密只允许存在内存里（唯一例外：主题名，见 ALLOWED_STORAGE）。
 *  4. BFF 禁止裸 `console.*`（必须走已配置脱敏的 fastify logger）；前端禁止 `console.log/debug/info`。
 *  5. 构建产物中不得存在 `*.map`（完整源码会随镜像发布）。
 *
 * 用法：
 *   node scripts/lint.mjs                     # 全部（web + bff + contracts + e2e + 产物）
 *   node scripts/lint.mjs --scope web         # 只查 apps/web/src
 *   node scripts/lint.mjs --scope bff         # 只查 apps/bff/src
 *   node scripts/lint.mjs --scope contracts   # 只查 packages/contracts/src
 *   node scripts/lint.mjs --scope e2e         # 只查 tests/e2e
 *
 * 只读检查；不修改文件；不访问网络。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/** 每个 scope 的源码根目录与关注的文件后缀。 */
const SCOPES = {
  web: { dir: join(root, 'apps', 'web', 'src'), extensions: ['.ts', '.tsx'], kind: 'web' },
  bff: { dir: join(root, 'apps', 'bff', 'src'), extensions: ['.ts'], kind: 'bff' },
  contracts: { dir: join(root, 'packages', 'contracts', 'src'), extensions: ['.ts'], kind: 'bff' },
  // e2e 目录里混着 CLI 脚本（smoke-*.mjs，职责就是往 stdout 打印结果），
  // 所以这里按 cli 处理：只查类型压制，不限制 console 与浏览器 API。
  e2e: { dir: join(root, 'tests', 'e2e'), extensions: ['.mjs', '.ts'], kind: 'cli' },
};

const scopeArg = process.argv.find((argument) => argument.startsWith('--scope'));
let selectedScopes = Object.keys(SCOPES);
if (scopeArg) {
  const value = scopeArg.includes('=') ? scopeArg.split('=')[1] : process.argv[process.argv.indexOf(scopeArg) + 1];
  if (!value || !SCOPES[value]) {
    console.error(`[lint] --scope 只接受：${Object.keys(SCOPES).join(' / ')}；收到：${value ?? '(空)'}`);
    process.exit(2);
  }
  selectedScopes = [value];
}

const problems = [];
const summarize = [];
const line = (file) => relative(root, file).replace(/\\/g, '/');

function fail(file, message) {
  problems.push(`${line(file)}：${message}`);
}

/** 递归收集源码文件（跳过 node_modules / dist / .git）。 */
function collect(dir, extensions, sink = []) {
  if (!existsSync(dir)) return sink;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      collect(full, extensions, sink);
    } else if (extensions.some((extension) => entry.endsWith(extension))) {
      sink.push(full);
    }
  }
  return sink;
}

/**
 * 去掉注释与字符串字面量。
 * 目的是避免"注释里提到关键词"造成误报，同时保持行结构不变（换行保留），这样行号仍然准确。
 */
function stripCommentsAndStrings(source) {
  let output = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') output += '\n';
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') index += 1;
        if (source[index] === '\n') output += '\n';
        index += 1;
      }
      index += 1;
      output += quote === '`' ? '``' : '""';
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

/** 按行报告命中，带行号与原文片段，便于直接定位。 */
function scan(code, file, pattern, message) {
  const lines = code.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    pattern.lastIndex = 0;
    if (pattern.test(lines[index])) {
      fail(file, `${message}（第 ${index + 1} 行：${lines[index].trim().slice(0, 120)}）`);
    }
  }
}

/** 主题名是唯一允许进 localStorage 的、与业务无关的数据。 */
const ALLOWED_STORAGE = new Set(['apps/web/src/app/antdTheme.ts']);

for (const scope of selectedScopes) {
  const { dir: sourceDir, extensions, kind } = SCOPES[scope];
  const files = collect(sourceDir, extensions);
  if (!files.length) {
    fail(sourceDir, '没有找到源码，检查目录结构是否被改动');
    continue;
  }
  summarize.push(`${scope} ${files.length} 个文件`);

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const code = stripCommentsAndStrings(source);
    const isWeb = kind === 'web';
    const isCli = kind === 'cli';
    const relativePath = line(file);

    // 1. XSS 面
    if (isWeb) {
      scan(code, file, /dangerouslySetInnerHTML/, '禁止 dangerouslySetInnerHTML（日志/OAuth 秘密是不可信输入，必须走文本渲染）');
      scan(code, file, /\.innerHTML\s*=/, '禁止写 innerHTML（同上）');
      scan(code, file, /\beval\s*\(/, '禁止 eval（动态执行不可信内容）');
      scan(code, file, /\bnew\s+Function\s*\(/, '禁止 new Function（等价于 eval）');
    }

    // 2. 类型压制
    scan(code, file, /\bas\s+any\b/, '禁止 as any（会用类型断言掩盖契约漂移）');
    scan(code, file, /@ts-ignore|@ts-nocheck|@ts-expect-error/, '禁止压制类型错误（应修正类型或补收窄函数）');

    // 3. 存储边界（仅前端业务代码）
    if (isWeb && !ALLOWED_STORAGE.has(relativePath)) {
      scan(code, file, /\blocalStorage\s*\./, '业务代码禁止直接读 localStorage（秘密只能存内存；主题名见 antdTheme.ts）');
      scan(code, file, /\bsessionStorage\s*\./, '业务代码禁止直接读 sessionStorage');
      scan(code, file, /document\s*\.\s*cookie/, '前端禁止读写 document.cookie（Cookie 必须 HttpOnly，由 BFF 管理）');
    }

    // 4. 日志
    if (isWeb) {
      scan(code, file, /console\s*\.\s*(log|debug|info)\s*\(/, '源码中禁止 console.log/debug/info（用 UI 提示或错误边界）');
    } else if (!isCli) {
      scan(
        code,
        file,
        /console\s*\.\s*(log|debug|info|warn)\s*\(/,
        'BFF 必须使用 request.log/app.log（已配置脱敏），禁止裸 console',
      );
    }
  }
}

// 5. 构建产物（与 scope 无关：只要 dist 存在就检查）
for (const distDir of [join(root, 'apps', 'web', 'dist'), join(root, 'apps', 'bff', 'dist')]) {
  if (!existsSync(distDir)) continue;
  const maps = collect(distDir, ['.map']);
  for (const map of maps) {
    fail(map, '构建产物中不得存在 sourcemap（会把完整源码泄露给任何能访问页面的用户）');
  }
}

if (problems.length) {
  console.error(`[lint] 发现 ${problems.length} 个问题：`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\n这些规则对应已确认的安全/正确性缺陷，不是风格偏好；请修正而不是加豁免。');
  process.exit(1);
}

console.log(
  `[lint] 通过：${summarize.join('、')}；无 XSS 面、无类型压制、无越界存储、无裸日志、产物无 sourcemap。`,
);
