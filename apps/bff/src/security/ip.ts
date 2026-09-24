/**
 * 客户端来源解析与 IP/CIDR 匹配。
 *
 * 明确不信任任意来源的 X-Forwarded-For：只有直连地址落在 WEBUI_TRUST_PROXY 配置内时才向后读 XFF，
 * 并且从右向左跳过可信代理，取第一个不可信地址作为客户端来源（实施文档 5.1）。
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function normalizeIp(value: string): string {
  let ip = value.trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice('::ffff:'.length);
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  return ip.toLowerCase();
}

/** 去除 IPv6 的 zone id（如 fe80::1%eth0）。 */
function stripZone(ip: string): string {
  const zoneIndex = ip.indexOf('%');
  return zoneIndex === -1 ? ip : ip.slice(0, zoneIndex);
}

function ipv4ToLong(ip: string): number | null {
  const match = IPV4.exec(ip);
  if (!match) return null;
  let result = 0;
  for (let index = 1; index <= 4; index += 1) {
    const part = Number(match[index]);
    if (part < 0 || part > 255) return null;
    result = result * 256 + part;
  }
  return result;
}

function ipv6ToBytes(ip: string): number[] | null {
  const source = stripZone(ip);
  if (!source.includes(':')) return null;
  const [headPart, tailPart] = source.split('::') as [string, string?];
  const head = headPart ? headPart.split(':').filter((item) => item !== '') : [];
  const tail = tailPart !== undefined && tailPart !== '' ? tailPart.split(':').filter((item) => item !== '') : [];
  const expand = (groups: string[]): number[] | null => {
    const bytes: number[] = [];
    for (const group of groups) {
      if (group.includes('.')) {
        const long = ipv4ToLong(group);
        if (long === null) return null;
        bytes.push((long >>> 24) & 0xff, (long >>> 16) & 0xff, (long >>> 8) & 0xff, long & 0xff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      const value = Number.parseInt(group, 16);
      bytes.push((value >>> 8) & 0xff, value & 0xff);
    }
    return bytes;
  };
  const headBytes = expand(head);
  const tailBytes = expand(tail);
  if (!headBytes || !tailBytes) return null;
  if (tailPart === undefined) {
    return headBytes.length === 16 ? headBytes : null;
  }
  const fill = 16 - headBytes.length - tailBytes.length;
  if (fill < 0) return null;
  return [...headBytes, ...new Array(fill).fill(0), ...tailBytes];
}

/** 判断 ip 是否落在 cidr（支持单个 IPv4/IPv6 地址、IPv4 CIDR、IPv6 CIDR）。 */
export function ipMatchesCidr(ip: string, cidr: string): boolean {
  const target = normalizeIp(ip);
  let network = cidr.trim();
  let prefixLength: number | null = null;
  const slash = network.lastIndexOf('/');
  if (slash !== -1) {
    prefixLength = Number(network.slice(slash + 1));
    network = network.slice(0, slash);
    if (!Number.isInteger(prefixLength)) return false;
  }
  network = normalizeIp(network);

  const targetV4 = ipv4ToLong(target);
  const networkV4 = ipv4ToLong(network);
  if (targetV4 !== null || networkV4 !== null) {
    if (targetV4 === null || networkV4 === null) return false;
    const bits = prefixLength ?? 32;
    if (bits < 0 || bits > 32) return false;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
    return ((targetV4 & mask) >>> 0) === ((networkV4 & mask) >>> 0);
  }

  const targetBytes = ipv6ToBytes(target);
  const networkBytes = ipv6ToBytes(network);
  if (!targetBytes || !networkBytes) return false;
  const bits = prefixLength ?? 128;
  if (bits < 0 || bits > 128) return false;
  let remaining = bits;
  for (let index = 0; index < 16; index += 1) {
    if (remaining <= 0) return true;
    const take = Math.min(8, remaining);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if ((targetBytes[index]! & mask) !== (networkBytes[index]! & mask)) return false;
    remaining -= take;
  }
  return true;
}

export function isTrustedAddress(ip: string, trusted: readonly string[]): boolean {
  return trusted.some((entry) => ipMatchesCidr(ip, entry));
}

export interface ClientIpSources {
  readonly remoteAddress: string;
  readonly forwardedFor?: string | string[] | undefined;
}

/**
 * 解析真实客户端来源：
 * - 直连地址不可信时，忽略 XFF，直接使用直连地址；
 * - 直连地址可信时，从 XFF 右侧开始跳过可信代理，取第一个不可信地址；
 * - 全部可信时退化为最左侧条目。
 */
export function resolveClientIp(sources: ClientIpSources, trusted: readonly string[]): string {
  const remote = normalizeIp(sources.remoteAddress || 'unknown');
  if (!isTrustedAddress(remote, trusted)) return remote;

  const raw = sources.forwardedFor;
  const header = Array.isArray(raw) ? raw.join(',') : raw;
  if (!header) return remote;

  const chain = header
    .split(',')
    .map((item) => normalizeIp(item))
    .filter((item) => item && item !== 'unknown');
  if (!chain.length) return remote;

  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const candidate = chain[index]!;
    if (!isTrustedAddress(candidate, trusted)) return candidate;
  }
  return chain[0]!;
}
