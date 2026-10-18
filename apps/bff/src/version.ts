/**
 * WebUI 自身版本号。
 *
 * 早前诊断接口里硬编码了 `version: '0.1.0'`，发版时必然忘记同步。这里从
 * `apps/bff/package.json` 读取——`src/version.ts` 与构建产物 `dist/version.js`
 * 都位于 `apps/bff/` 的下一级，所以 `../package.json` 在源码态与产物态都成立。
 *
 * 读不到时回退为 `unknown`：版本号只用于诊断展示，绝不能因此让进程起不来。
 */

import { readFileSync } from 'node:fs';

const FALLBACK_VERSION = 'unknown';

function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'version' in parsed) {
      const value = (parsed as { version?: unknown }).version;
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  } catch {
    // 产物被裁剪掉 package.json 时退化为未知版本，不影响任何功能
  }
  return FALLBACK_VERSION;
}

export const WEBUI_VERSION = readVersion();
