#!/usr/bin/env node
/**
 * 生成物漂移校验（`pnpm contracts:verify`）。
 *
 * 背景：`scripts/generate-contracts.mjs --check` 只校验"快照哈希 + 允许清单里 76 条是否都在快照中"，
 * **不校验** `packages/contracts/generated/` 里的产物是否仍与 `mvp-routes.json` 同步。
 * 于是"改了允许清单却忘了重新生成"这种漂移在 CI/Docker 构建里完全看不出来。
 *
 * 做法：把生成物写到一个临时目录，与仓库中已提交的产物逐字节比对，有差异即失败。
 * 只读仓库、不修改任何已提交文件；不连接任何 Parrot 实例。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const contractsDir = join(root, 'packages', 'contracts');

/** 需要逐字节比对的已提交产物（相对仓库根）。 */
const ARTIFACTS = [
  { relative: join('packages', 'contracts', 'generated', 'management-routes.ts'), tempName: 'management-routes.ts' },
  { relative: join('packages', 'contracts', 'generated', 'upstream-mvp.d.ts'), tempName: 'upstream-mvp.d.ts' },
  { relative: join('packages', 'contracts', 'upstream-meta.json'), tempName: 'upstream-meta.json' },
];

/** 统一换行再比对：本机 core.autocrlf 与仓库存储形态可能不同，但内容必须一致。 */
function normalize(buffer) {
  return buffer.toString('utf8').replace(/\r\n/g, '\n');
}

const tempDir = mkdtempSync(join(tmpdir(), 'parrot-contracts-verify-'));
let failed = false;

try {
  execFileSync(process.execPath, [join(here, 'generate-contracts.mjs'), '--out-dir', tempDir], {
    cwd: root,
    stdio: 'inherit',
  });

  for (const { relative, tempName } of ARTIFACTS) {
    const committedPath = join(root, relative);
    const generatedPath = join(tempDir, tempName);
    let committed;
    let generated;
    try {
      committed = normalize(readFileSync(committedPath));
    } catch {
      console.error(`[contracts:verify][错误] 仓库中缺少已提交的产物：${relative}`);
      failed = true;
      continue;
    }
    try {
      generated = normalize(readFileSync(generatedPath));
    } catch {
      console.error(`[contracts:verify][错误] 重新生成时没有产出：${relative}`);
      failed = true;
      continue;
    }
    if (committed !== generated) {
      failed = true;
      console.error(`[contracts:verify][错误] 生成物已漂移：${relative}`);
      console.error('  仓库中的产物与 mvp-routes.json / 快照重新生成的结果不一致。');
      console.error('  修复：执行 `pnpm contracts:generate` 并把生成物一并提交。');
      const committedLines = committed.split('\n');
      const generatedLines = generated.split('\n');
      const limit = Math.max(committedLines.length, generatedLines.length);
      for (let index = 0; index < limit; index += 1) {
        if (committedLines[index] !== generatedLines[index]) {
          console.error(`  首个差异在第 ${index + 1} 行：`);
          console.error(`    仓库： ${JSON.stringify(committedLines[index] ?? '<EOF>').slice(0, 200)}`);
          console.error(`    重新生成：${JSON.stringify(generatedLines[index] ?? '<EOF>').slice(0, 200)}`);
          break;
        }
      }
    } else {
      console.log(`[contracts:verify] 一致：${relative}`);
    }
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

if (failed) {
  process.exit(1);
}
console.log('[contracts:verify] 通过：生成物与允许清单/快照完全同步。');
