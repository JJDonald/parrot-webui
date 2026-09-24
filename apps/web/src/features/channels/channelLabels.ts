/**
 * 渠道相关枚举的中文文案与色调。
 *
 * 取值只来自生成类型：
 * - `ChannelProtocol`、`ChannelHealth`（`packages/contracts/generated/upstream-mvp.d.ts`）。
 * 上游返回自由字符串的字段（例如 `ProviderUsageData.status`）不做映射，原样展示。
 */

import type { Tone } from '@/components/bits';
import type { ChannelHealth, ChannelProtocol } from './upstream-types';

export const PROTOCOL_LABEL: Record<ChannelProtocol, string> = {
  anthropic: 'Anthropic Messages',
  'openai-chat': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
};

export const PROTOCOL_OPTIONS: Array<{ value: ChannelProtocol; label: string }> = (
  Object.keys(PROTOCOL_LABEL) as ChannelProtocol[]
).map((value) => ({ value, label: `${PROTOCOL_LABEL[value]}（${value}）` }));

/** 运行时健康状态：与"配置是否启用"是两个维度，必须分开展示。 */
export const HEALTH_LABEL: Record<ChannelHealth, string> = {
  healthy: '正常',
  degraded: '性能下降',
  unhealthy: '异常',
  cooldown: '临时冷却',
  quotaCooldown: '配额冷却',
  permanentCooldown: '永久冷却',
  disabled: '已停用',
  unknown: '未知',
};

export function healthTone(health: ChannelHealth): Tone {
  switch (health) {
    case 'healthy':
      return 'success';
    case 'degraded':
    case 'cooldown':
    case 'quotaCooldown':
      return 'warning';
    case 'unhealthy':
    case 'permanentCooldown':
      return 'danger';
    default:
      return 'muted';
  }
}

export const HEALTH_OPTIONS: Array<{ value: ChannelHealth; label: string }> = (
  Object.keys(HEALTH_LABEL) as ChannelHealth[]
).map((value) => ({ value, label: `${HEALTH_LABEL[value]}（${value}）` }));

/** 运行时模型冷却类型（ChannelRuntimeModelData.cooldownKind）。 */
export const COOLDOWN_KIND_LABEL: Record<'permanent' | 'quota' | 'temporary', string> = {
  permanent: '永久冷却',
  quota: '配额冷却',
  temporary: '临时冷却',
};

/** 兼容性模式（CompatibilityMode）。 */
export const COMPATIBILITY_MODE_LABEL: Record<'auto' | 'force', string> = {
  auto: '自动判断（auto）',
  force: '强制启用（force）',
};

/** 相对时间/数字：上游没给值就是"未知"，不用 0 或当前时间冒充（前端契约 §5）。 */
export function rawNumberText(value: number | null | undefined, digits = 4): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未知';
  return Number(value.toFixed(digits)).toString();
}

export function countText(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '未知';
}
