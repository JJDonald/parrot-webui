#!/usr/bin/env node
/**
 * 契约生成器（M0 产物）
 *
 * 1. 校验 packages/contracts/upstream.openapi.json 的 sha256 与 upstream-meta.json 记录一致，
 *    防止快照被无意替换后类型与允许清单悄悄漂移。
 * 2. 校验 mvp-routes.json 中的每条 method+path 都真实存在于快照中；缺失即失败退出。
 * 3. 生成 packages/contracts/generated/management-routes.ts（冻结的路由表，BFF 唯一来源）。
 * 4. 生成 packages/contracts/generated/upstream-mvp.d.ts（MVP 触及的上游 schema 闭包的 TS 类型）。
 *
 * 用法：
 *   node scripts/generate-contracts.mjs              # 校验 + 生成（默认）
 *   node scripts/generate-contracts.mjs --full       # 额外用 openapi-typescript 生成全量类型
 *   node scripts/generate-contracts.mjs --check      # 只校验，不写文件
 *
 * 说明：脚本从不连接任何 Parrot 实例，只读取仓库内的快照文件。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const contractsDir = join(root, 'packages', 'contracts');
const generatedDir = join(contractsDir, 'generated');
const snapshotPath = join(contractsDir, 'upstream.openapi.json');
const metaPath = join(contractsDir, 'upstream-meta.json');
const allowlistPath = join(contractsDir, 'mvp-routes.json');

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const withFullTypes = args.has('--full');

const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// ---------------------------------------------------------------- 1. 快照校验

if (!existsSync(snapshotPath)) {
  fail(`缺少上游快照：${snapshotPath}。请参考 docs/contracts.md 生成后重试。`);
}
if (!existsSync(metaPath)) {
  fail(`缺少来源记录：${metaPath}`);
}
if (problems.length) {
  report();
  process.exit(1);
}

const snapshotBuffer = readFileSync(snapshotPath);
const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'));

const actualHash = sha256(snapshotBuffer);
if (actualHash !== meta.snapshotSha256) {
  fail(
    `快照哈希不一致：文件 ${actualHash} != upstream-meta.json 记录 ${meta.snapshotSha256}。` +
      '若确实要更换基线提交，请重跑快照生成流程并同时更新 upstream-meta.json。',
  );
}
if (snapshotBuffer.byteLength !== meta.snapshotBytes) {
  notes.push(`快照字节数记录为 ${meta.snapshotBytes}，实际 ${snapshotBuffer.byteLength}（哈希一致时以哈希为准）`);
}

const snapshot = JSON.parse(snapshotBuffer.toString('utf8'));
const paths = snapshot.paths ?? {};
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

const operationIndex = new Map();
for (const [path, item] of Object.entries(paths)) {
  for (const method of HTTP_METHODS) {
    if (item[method]) {
      operationIndex.set(`${method.toUpperCase()} ${path}`, { path, method: method.toUpperCase(), op: item[method] });
    }
  }
}

const countedOperations = operationIndex.size;
if (meta.operationCount && countedOperations !== meta.operationCount) {
  notes.push(`快照操作数 ${countedOperations} 与来源记录 ${meta.operationCount} 不一致（文档基线为 237，请核对）`);
}

// ---------------------------------------------------- 2. 允许清单逐条核对

const routeSpecs = [];
for (const route of allowlist.routes ?? []) {
  const key = `${route.method.toUpperCase()} ${route.path}`;
  const found = operationIndex.get(key);
  if (!found) {
    fail(`允许清单中的路由在上游快照中不存在：${key}`);
    continue;
  }
  routeSpecs.push({
    method: found.method,
    path: found.path,
    routeClass: route.class === 'auth' ? 'auth' : 'proxy',
    bodyLimit: route.bodyLimit ?? null,
    note: route.note ?? null,
    upstreamOperationId: found.op.operationId ?? null,
  });
}

for (const excluded of allowlist.excluded?.phase2 ?? []) {
  const hit = [...operationIndex.keys()].find((key) => key.endsWith(` ${excluded}`));
  if (!hit) {
    notes.push(`excluded 列表中的路径未在快照中匹配到：${excluded}`);
  }
}

if (checkOnly) {
  report();
  process.exit(problems.length ? 1 : 0);
}

// ------------------------------------------- 3. 生成冻结路由表（BFF 唯一来源）

mkdirSync(generatedDir, { recursive: true });

const originHint = '/* eslint-disable */\n// 本文件由 scripts/generate-contracts.mjs 生成，请勿手改。\n';

const routeTable =
  originHint +
  `\n/** 上游管理 API 前缀（BFF 只在此前缀内工作）。 */\nexport const UPSTREAM_MANAGEMENT_PREFIX = '/api/management/v1' as const;\n\n` +
  `export type UpstreamRouteClass = 'proxy' | 'auth';\n\n` +
  `export interface FrozenUpstreamRoute {\n  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';\n  readonly path: string;\n  readonly routeClass: UpstreamRouteClass;\n  readonly bodyLimit: string | null;\n  readonly note: string | null;\n  readonly upstreamOperationId: string | null;\n}\n\n` +
  `export const FROZEN_UPSTREAM_ROUTES: readonly FrozenUpstreamRoute[] = ${JSON.stringify(
    routeSpecs.map((route) => ({
      method: route.method,
      path: route.path,
      routeClass: route.routeClass,
      bodyLimit: route.bodyLimit,
      note: route.note,
      upstreamOperationId: route.upstreamOperationId,
    })),
    null,
    2,
  )} as const;\n\n` +
  `/** 允许清单内的上游路径模板集合，供 BFF 构建匹配器使用。 */\n` +
  `export const FROZEN_ROUTE_COUNT = ${routeSpecs.length} as const;\n\n` +
  `/** 上游契约来源（冻结在构建产物中，随 /webui/bff/diagnostics 返回脱敏摘要）。 */\n` +
  `export const UPSTREAM_CONTRACT_SOURCE = ${JSON.stringify(
    {
      repository: meta.repository,
      commit: meta.commit,
      commitSubject: meta.commitSubject,
      release: meta.release,
      snapshotSha256: meta.snapshotSha256,
      operationCount: meta.operationCount,
      pathCount: meta.pathCount,
      schemaCount: meta.schemaCount,
      routerCount: meta.routerCount,
      openapiVersion: meta.openapiVersion,
    },
    null,
    2,
  )} as const;\n`;

writeFileSync(join(generatedDir, 'management-routes.ts'), routeTable, 'utf8');
notes.push(`已生成 management-routes.ts：${routeSpecs.length} 条允许路由（上游共 ${countedOperations} 个操作）`);

// ------------------------------------- 4. 生成 MVP 触及的 schema 闭包 TS 类型

const schemas = snapshot.components?.schemas ?? {};
const REF_PREFIX = '#/components/schemas/';

function schemaNameOfRef(ref) {
  return ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : null;
}

function collectRefs(node, sink) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, sink);
    return;
  }
  if (typeof node.$ref === 'string') {
    const name = schemaNameOfRef(node.$ref);
    if (name) sink.add(name);
  }
  for (const value of Object.values(node)) collectRefs(value, sink);
}

const roots = new Map(); // schemaName -> 为什么被引入（注释用）
const reachable = new Set();

for (const route of routeSpecs) {
  const found = operationIndex.get(`${route.method} ${route.path}`);
  if (!found) continue;
  const { op } = found;
  const label = `${route.method} ${route.path}`;
  const add = (node) => {
    const refs = new Set();
    collectRefs(node, refs);
    for (const name of refs) {
      if (!roots.has(name)) roots.set(name, label);
      reachable.add(name);
    }
  };
  add(op.requestBody);
  add(op.parameters);
  for (const [status, response] of Object.entries(op.responses ?? {})) {
    if (status.startsWith('2') || status === 'default') add(response);
  }
  // 错误 envelope 也纳入，前端要按 code/fields 分支
  for (const [status, response] of Object.entries(op.responses ?? {})) {
    if (status.startsWith('4') || status.startsWith('5')) add(response);
  }
}

const queue = [...reachable];
while (queue.length) {
  const name = queue.pop();
  const schema = schemas[name];
  if (!schema) continue;
  const refs = new Set();
  collectRefs(schema, refs);
  for (const ref of refs) {
    if (!reachable.has(ref)) {
      reachable.add(ref);
      queue.push(ref);
    }
  }
}

function tsType(node, indent = '  ') {
  if (node === true || node === undefined || node === null) return 'unknown';
  if (typeof node !== 'object') return 'unknown';
  if (typeof node.$ref === 'string') {
    const name = schemaNameOfRef(node.$ref);
    return name ? name : 'unknown';
  }
  if (Array.isArray(node.enum)) {
    return node.enum.map((value) => JSON.stringify(value)).join(' | ') || 'never';
  }
  if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf)) {
    const variants = (node.anyOf ?? node.oneOf).map((variant) => {
      if (variant && typeof variant === 'object' && variant.type === 'null') return 'null';
      return tsType(variant, indent);
    });
    return [...new Set(variants)].join(' | ') || 'unknown';
  }
  if (Array.isArray(node.allOf)) {
    return node.allOf.map((part) => `(${tsType(part, indent)})`).join(' & ') || 'unknown';
  }
  if (node.const !== undefined) return JSON.stringify(node.const);
  const type = Array.isArray(node.type) ? node.type.find((t) => t !== 'null') : node.type;
  const nullable = (Array.isArray(node.type) && node.type.includes('null')) || node.nullable === true;

  let base;
  switch (type) {
    case 'string':
      base = 'string';
      break;
    case 'integer':
    case 'number':
      base = 'number';
      break;
    case 'boolean':
      base = 'boolean';
      break;
    case 'null':
      return 'null';
    case 'array': {
      const items = node.items;
      if (Array.isArray(items)) {
        base = `[${items.map((i) => tsType(i, indent)).join(', ')}]`;
      } else {
        base = `${tsType(items, indent)}[]`;
      }
      break;
    }
    case 'object':
    default: {
      const properties = node.properties;
      if (properties && Object.keys(properties).length) {
        const required = new Set(node.required ?? []);
        const lines = Object.entries(properties).map(([key, value]) => {
          const optional = required.has(key) ? '' : '?';
          const keyText = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
          return `${indent}  ${keyText}${optional}: ${tsType(value, indent + '  ')};`;
        });
        base = `{\n${lines.join('\n')}\n${indent}}`;
      } else if (node.additionalProperties && typeof node.additionalProperties === 'object') {
        base = `Record<string, ${tsType(node.additionalProperties, indent)}>`;
      } else {
        base = 'Record<string, unknown>';
      }
    }
  }
  return nullable ? `${base} | null` : base;
}

const usedNames = [...reachable].filter((name) => schemas[name]).sort();
const schemaBlocks = usedNames.map((name) => {
  const schema = schemas[name];
  const doc = schema.description ? `/** ${String(schema.description).replace(/\*\//g, '*\\/')} */\n` : '';
  const origin = roots.get(name) ? ` * 来源：${roots.get(name)}\n` : '';
  const header = `/**\n * ${name}\n${origin} */\n`;
  if (schema.type === 'object' || schema.properties) {
    return `${doc}${header}export interface ${name} ${tsType(schema)}\n`;
  }
  return `${doc}${header}export type ${name} = ${tsType(schema)};\n`;
});

const operationTypes = routeSpecs.map((route) => {
  const found = operationIndex.get(`${route.method} ${route.path}`);
  if (!found) return '';
  const { op } = found;
  const success = Object.entries(op.responses ?? {}).find(([status]) => status.startsWith('2'));
  const bodySchema = op.requestBody?.content?.['application/json']?.schema;
  const successSchema = success?.[1]?.content?.['application/json']?.schema;
  const params = (op.parameters ?? []).map((p) => p.name).filter(Boolean);
  return [
    `  /** ${op.summary ?? route.path} */`,
    `  ${JSON.stringify(`${route.method} ${route.path}`)}: {`,
    `    method: ${JSON.stringify(route.method)};`,
    `    path: ${JSON.stringify(route.path)};`,
    `    successStatus: ${JSON.stringify(success?.[0] ?? '200')};`,
    `    successType: ${successSchema ? tsType(successSchema) : 'void'};`,
    bodySchema ? `    requestType: ${tsType(bodySchema)};` : `    requestType: never;`,
    `    parameterNames: ${JSON.stringify(params)};`,
    `  };`,
  ].join('\n');
});

const mvpTypes =
  originHint +
  `\n// 覆盖上游 schema 闭包中的 ${usedNames.length} 个模型（基线共 ${Object.keys(schemas).length} 个）。\n` +
  `// 这里只生成 MVP 允许清单真正触及的类型；全量类型见 --full 模式。\n\n` +
  `export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };\n\n` +
  `/** 所有管理接口共用的成功信封。 */\nexport interface DataEnvelope<T> {\n  data: T;\n  meta: { requestId: string; [key: string]: unknown };\n}\n\n` +
  `/** 上游业务错误信封（HTTP 4xx/5xx）。 */\nexport interface UpstreamErrorEnvelope {\n  error: {\n    code: string;\n    message: string;\n    fields: Array<{ path: string; code: string; message: string }>;\n    retryable: boolean;\n    requestId: string;\n    operationId?: string | null;\n  };\n}\n\n` +
  schemaBlocks.join('\n') +
  `\n\n/** 允许清单内每个上游操作的契约摘要，便于前端与 BFF 共用同一份事实。 */\n` +
  `export interface UpstreamMvpOperations {\n${operationTypes.join('\n')}\n}\n\n` +
  `export type UpstreamMvpOperationKey = keyof UpstreamMvpOperations;\n`;

writeFileSync(join(generatedDir, 'upstream-mvp.d.ts'), mvpTypes, 'utf8');
notes.push(`已生成 upstream-mvp.d.ts：${usedNames.length} 个 schema 类型 + ${routeSpecs.length} 条操作摘要`);

meta.allowlistRouteCount = routeSpecs.length;
if (!checkOnly) {
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

if (withFullTypes) {
  notes.push('--full 模式：请执行 `pnpm exec openapi-typescript packages/contracts/upstream.openapi.json -o packages/contracts/generated/upstream.full.d.ts`（全量类型体积较大，默认不生成）。');
}

report();
process.exit(problems.length ? 1 : 0);

function report() {
  for (const note of notes) console.log(`[contracts] ${note}`);
  for (const problem of problems) console.error(`[contracts][错误] ${problem}`);
  if (!problems.length) {
    console.log(`[contracts] 校验通过：${routeSpecs.length} 条允许路由全部存在于快照；快照哈希匹配。`);
  }
}
