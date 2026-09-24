/** 体积限制的解析与判断（支持 1mb / 512kb / 1024 这样的写法）。 */

export function parseByteSize(value: string | number | null | undefined, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : fallback;
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(value.trim());
  if (!match) return fallback;
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'b').toLowerCase();
  const multiplier = unit === 'gb' ? 1024 ** 3 : unit === 'mb' ? 1024 ** 2 : unit === 'kb' ? 1024 : 1;
  const bytes = Math.floor(amount * multiplier);
  return bytes > 0 ? bytes : fallback;
}

/** 计算已解析请求体的近似字节数，用于按路由判定体积上限。 */
export function approximateBodyBytes(body: unknown): number {
  if (body === undefined || body === null) return 0;
  if (typeof body === 'string') return Buffer.byteLength(body, 'utf8');
  if (Buffer.isBuffer(body)) return body.byteLength;
  try {
    return Buffer.byteLength(JSON.stringify(body) ?? '', 'utf8');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}
