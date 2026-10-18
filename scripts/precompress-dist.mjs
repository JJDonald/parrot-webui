/**
 * 构建期预压缩静态资源（Brotli + gzip）。
 *
 * 背景：反向代理片段（deploy/nginx-webui.conf、deploy/Caddyfile.example）与 BFF
 * 都没有开启压缩，主包 1.6 MB 会原样上公网。这里在构建完成后生成同目录的
 * `.br` / `.gz` 兄弟文件，由 BFF 的 @fastify/static `preCompressed` 直接下发：
 * - 运行时零 CPU 开销，也不需要给运行镜像装压缩依赖；
 * - 只压缩文本类资源（js/css/html/svg/json/map），跳过图片与已有压缩格式。
 *
 * 用法：node scripts/precompress-dist.mjs [--dir apps/web/dist]
 */

import { createBrotliCompress, createGzip, constants as zlibConstants } from 'node:zlib';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.txt', '.xml', '.map']);
/** 小于 1 KB 的文件压了也没意义，反而多一次 IO。 */
const MIN_BYTES = 1024;

function parseArgs(argv) {
  const index = argv.indexOf('--dir');
  return index >= 0 && argv[index + 1] ? argv[index + 1] : 'apps/web/dist';
}

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
      continue;
    }
    if (entry.isFile()) yield full;
  }
}

async function compressFile(file, encoding) {
  const target = `${file}.${encoding === 'br' ? 'br' : 'gz'}`;
  const stream =
    encoding === 'br'
      ? createBrotliCompress({
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
            [zlibConstants.BROTLI_PARAM_SIZE_HINT]: 1,
          },
        })
      : createGzip({ level: 9 });
  await pipeline(createReadStream(file), stream, createWriteStream(target));
  return target;
}

async function main() {
  const dir = path.resolve(parseArgs(process.argv.slice(2)));
  if (!existsSync(dir)) {
    console.error(`[precompress] 目录不存在：${dir}`);
    process.exit(1);
  }

  let count = 0;
  let saved = 0;
  for await (const file of walk(dir)) {
    // 不重复压缩自己的产物
    if (file.endsWith('.br') || file.endsWith('.gz')) continue;
    if (!COMPRESSIBLE.has(path.extname(file).toLowerCase())) continue;
    const info = await stat(file);
    if (info.size < MIN_BYTES) continue;
    const brTarget = await compressFile(file, 'br');
    const gzTarget = await compressFile(file, 'gzip');
    const brSize = (await stat(brTarget)).size;
    const gzSize = (await stat(gzTarget)).size;
    const best = Math.min(brSize, gzSize);
    count += 1;
    saved += info.size - best;
    console.log(
      `[precompress] ${path.relative(dir, file)} ${info.size} → br ${brSize} / gz ${gzSize}`,
    );
  }
  console.log(`[precompress] 完成：${count} 个文件，最佳编码累计节省 ${(saved / 1024).toFixed(1)} KB`);
}

await main();
