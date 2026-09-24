/**
 * 渠道编辑表单的数据转换与校验。
 *
 * 约束（实施文档 6.4 / 7.2）：
 * - 提交时只发送用户实际改动的字段（PATCH 语义），避免把并发修改过的字段一起覆盖。
 * - 秘密字段（apiKey）只在用户重新填写时发送；空输入不等于清除，也不写入任何持久化存储。
 * - 校验只依据上游 schema 里真实存在的约束（minLength/maxItems 等）。
 */

import type {
  ChannelData,
  ChannelDetailData,
  ChannelModelInput,
  ChannelProtocol,
  ChannelUpdateRequest,
} from './upstream-types';

export interface ChannelEditDraft {
  name: string;
  baseUrl: string;
  apiPath: string;
  protocol: ChannelProtocol;
  enabled: boolean;
  /** 以字符串保存，便于区分"留空＝不修改"和 0。 */
  maxConcurrent: string;
  ccMimicry: boolean;
  omitTemperature: boolean;
  omitThinking: boolean;
  models: ChannelModelInput[];
  /**
   * 秘密字段：只存在于当前视图内存中（不写 localStorage/sessionStorage/URL）。
   * 空字符串表示"不修改上游已设置的密钥"。
   */
  apiKey: string;
}

export function toEditDraft(channel: ChannelDetailData | ChannelData): ChannelEditDraft {
  return {
    name: channel.name,
    baseUrl: channel.baseUrl,
    apiPath: channel.apiPath ?? '',
    protocol: channel.protocol,
    enabled: channel.enabled,
    maxConcurrent: String(channel.maxConcurrent),
    ccMimicry: channel.ccMimicry,
    omitTemperature: channel.omitTemperature,
    omitThinking: channel.omitThinking,
    models: channel.models.map((model) => ({ alias: model.alias, real: model.real })),
    apiKey: '',
  };
}

// ------------------------------------------------------------------ 模型列表编辑

/** 每行一个：`别名=真实模型 ID`；只写一个值时别名与真实 ID 相同。 */
export function modelsToText(models: ChannelModelInput[]): string {
  return models.map((model) => `${model.alias}=${model.real}`).join('\n');
}

export interface ParsedModels {
  models: ChannelModelInput[];
  /** 行号 → 错误说明（行号从 1 开始）。 */
  lineErrors: Array<{ line: number; message: string }>;
}

export function parseModelsText(text: string): ParsedModels {
  const models: ChannelModelInput[] = [];
  const lineErrors: ParsedModels['lineErrors'] = [];
  const lines = text.split('\n');
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    const separator = line.indexOf('=');
    const aliasRaw = separator >= 0 ? line.slice(0, separator).trim() : line;
    const realRaw = separator >= 0 ? line.slice(separator + 1).trim() : line;
    if (!aliasRaw || !realRaw) {
      lineErrors.push({ line: index + 1, message: '需要写成「别名=真实模型 ID」，两项都不能为空' });
      return;
    }
    models.push({ alias: aliasRaw, real: realRaw });
  });
  return { models, lineErrors };
}

export function modelsEqual(a: ChannelModelInput[], b: ChannelModelInput[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((model, index) => {
    const other = b[index];
    return Boolean(other) && model.alias === other?.alias && model.real === other?.real;
  });
}

// ------------------------------------------------------------------ 校验与 patch

export interface PatchResult {
  body: ChannelUpdateRequest;
  /** 校验不通过时的原因（同时用于禁用提交按钮）。 */
  invalid: string | null;
  /** 因为"不修改"语义而被忽略的字段说明。 */
  notes: string[];
}

export function parseMaxConcurrent(input: string): { ok: true; value: number | null } | { ok: false; message: string } {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (!/^\d+$/.test(trimmed)) return { ok: false, message: '请输入 0–100000 之间的整数（上游字段 maxConcurrent）' };
  const value = Number.parseInt(trimmed, 10);
  if (value < 0 || value > 100000) return { ok: false, message: '上游允许的范围是 0–100000' };
  return { ok: true, value };
}

export function buildChannelPatch(baseline: ChannelEditDraft, draft: ChannelEditDraft): PatchResult {
  const body: ChannelUpdateRequest = {};
  const notes: string[] = [];

  if (draft.name !== baseline.name) {
    const name = draft.name.trim();
    if (!name) return { body, invalid: '渠道名称不能为空', notes };
    body.name = name;
  }

  if (draft.baseUrl !== baseline.baseUrl) {
    const baseUrl = draft.baseUrl.trim();
    if (baseUrl.length < 8) return { body, invalid: '上游要求 baseUrl 至少 8 个字符', notes };
    body.baseUrl = baseUrl;
  }

  if (draft.apiPath !== baseline.apiPath) {
    const apiPath = draft.apiPath.trim();
    body.apiPath = apiPath === '' ? null : apiPath;
  }

  if (draft.protocol !== baseline.protocol) body.protocol = draft.protocol;
  if (draft.enabled !== baseline.enabled) body.enabled = draft.enabled;
  if (draft.ccMimicry !== baseline.ccMimicry) body.ccMimicry = draft.ccMimicry;
  if (draft.omitTemperature !== baseline.omitTemperature) body.omitTemperature = draft.omitTemperature;
  if (draft.omitThinking !== baseline.omitThinking) body.omitThinking = draft.omitThinking;

  if (draft.maxConcurrent !== baseline.maxConcurrent) {
    const parsed = parseMaxConcurrent(draft.maxConcurrent);
    if (!parsed.ok) return { body, invalid: parsed.message, notes };
    if (parsed.value === null) {
      // 上游 update schema 允许 null，但"清空并发上限"的实际语义（是否等于默认值）无法在本项目确认，
      // 因此这里不发送该字段，并明确告知用户留空等于不修改。
      notes.push('并发上限留空视为不修改（没有单独的清空操作）。');
    } else {
      body.maxConcurrent = parsed.value;
    }
  }

  if (!modelsEqual(draft.models, baseline.models)) {
    if (!draft.models.length) return { body, invalid: '上游要求至少配置 1 个模型', notes };
    body.models = draft.models;
  }

  const apiKey = draft.apiKey.trim();
  if (apiKey) {
    if (apiKey.length < 5) return { body, invalid: '上游要求 API Key 至少 5 个字符', notes };
    body.apiKey = apiKey;
  } else if (draft.apiKey !== baseline.apiKey) {
    notes.push('API Key 留空表示保持上游现有密钥不变（空输入不等于清除）。');
  }

  return { body, invalid: null, notes };
}

/** 表单未修改任何字段时不允许提交（PATCH 空 body 没有意义）。 */
export function hasChanges(baseline: ChannelEditDraft, draft: ChannelEditDraft): boolean {
  return (
    draft.name !== baseline.name ||
    draft.baseUrl !== baseline.baseUrl ||
    draft.apiPath !== baseline.apiPath ||
    draft.protocol !== baseline.protocol ||
    draft.enabled !== baseline.enabled ||
    draft.maxConcurrent !== baseline.maxConcurrent ||
    draft.ccMimicry !== baseline.ccMimicry ||
    draft.omitTemperature !== baseline.omitTemperature ||
    draft.omitThinking !== baseline.omitThinking ||
    Boolean(draft.apiKey.trim()) ||
    !modelsEqual(draft.models, baseline.models)
  );
}

/**
 * 把上游 fields[].path 映射到表单字段。
 * 上游可能给 `name`、`body.name`、`models.0.real` 等形式，这里做保守匹配。
 */
export function fieldMessage(map: Record<string, string>, key: string): string | undefined {
  const direct = map[key];
  if (direct) return direct;
  for (const [path, message] of Object.entries(map)) {
    if (path === `body.${key}` || path.endsWith(`.${key}`) || path.endsWith(`[${key}]`)) return message;
  }
  return undefined;
}

/** 表单字段错误汇总：只展示前 6 条，避免刷屏（完整信息仍在 ErrorNotice 里）。 */
export function summarizeFieldErrors(map: Record<string, string>): string[] {
  return Object.entries(map)
    .slice(0, 6)
    .map(([path, message]) => `${path || '(整体)'}：${message}`);
}
