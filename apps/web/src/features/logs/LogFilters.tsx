/**
 * 请求日志筛选条（实施文档 6.8）。
 *
 * 只使用上游真实支持的查询参数：
 *   status / apiKey / model / channel / protocol / query / startedAt / endedAt / sort / descending /
 *   page / pageSize（见 packages/contracts 中 GET /api/management/v1/logs 的 parameterNames）。
 *
 * 选项来源优先级：
 *   1. GET /logs/filter-options（channels / models / apiKeys / protocols / statuses）——上游真实数据；
 *   2. 选项接口不可用时：状态/协议退回契约枚举（RequestLogStatus / RequestProtocol，类型来自生成文件，
 *      schema 变化会在编译期报错），渠道/模型/Key 退回手输精确值——不编造任何候选列表。
 *
 * 多选说明：上游把 status/apiKey/model/channel/protocol 声明为数组（repeated query 参数），
 * 而共享客户端 buildQueryString 目前只序列化标量值（features/logs 之外的文件不可修改），
 * 因此这里使用"单选精确值"，语义与上游的单元素数组一致；不做拼接伪造。
 */

import { Button, DatePicker, Input, Select, Switch } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import type { ApiError } from '@/api/client';
import {
  LOG_PAGE_SIZE_OPTIONS,
  LOG_SORT_OPTIONS,
  filterOptionList,
  statusLabel,
  type LogListFilters,
  type RequestLogFilterOptionsData,
  type RequestLogSort,
  type RequestLogStatus,
  type RequestProtocol,
} from './logTypes';
import styles from './logs.module.scss';

/** 契约枚举回退值（类型绑定生成文件，防止与 schema 漂移）。 */
const STATUS_VALUES: RequestLogStatus[] = ['success', 'error', 'cancelled', 'pending'];
const PROTOCOL_VALUES: RequestProtocol[] = ['anthropic', 'chat', 'responses', 'responses_ws'];

interface SelectOption {
  value: string;
  label: string;
}

function statusOptions(options: RequestLogFilterOptionsData | undefined): SelectOption[] {
  const list = filterOptionList(options?.statuses);
  if (list.length) return list.map((entry) => ({ value: entry.value, label: `${statusLabel(entry.value)}（${entry.count}）` }));
  return STATUS_VALUES.map((value) => ({ value, label: statusLabel(value) }));
}

function protocolOptions(options: RequestLogFilterOptionsData | undefined): SelectOption[] {
  const list = filterOptionList(options?.protocols);
  if (list.length) return list.map((entry) => ({ value: entry.value, label: `${entry.value}（${entry.count}）` }));
  return PROTOCOL_VALUES.map((value) => ({ value, label: value }));
}

function valueOptions(options: RequestLogFilterOptionsData | undefined, field: 'channels' | 'models' | 'apiKeys'): SelectOption[] {
  return filterOptionList(options?.[field]).map((entry) => ({ value: entry.value, label: `${entry.value}（${entry.count}）` }));
}

export interface LogFiltersProps {
  draft: LogListFilters;
  dirty: boolean;
  options: RequestLogFilterOptionsData | undefined;
  optionsLoading: boolean;
  optionsError: ApiError | null | undefined;
  pageSize: number;
  onDraftChange: (next: LogListFilters) => void;
  onApply: () => void;
  onReset: () => void;
  onPageSizeChange: (size: number) => void;
}

function TextOrSelect({
  label,
  placeholder,
  value,
  options,
  optionsResolved,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string | undefined;
  options: SelectOption[];
  /** false 表示筛选选项接口不可用（此时才是"降级为手输"） */
  optionsResolved: boolean;
  onChange: (next: string | undefined) => void;
}) {
  if (options.length) {
    return (
      <div className="field">
        <span className="field__label">{label}</span>
        <Select
          aria-label={label}
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder={placeholder}
          value={value}
          options={options}
          onChange={(next) => onChange(next ?? undefined)}
        />
      </div>
    );
  }
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <Input
        aria-label={label}
        allowClear
        placeholder={optionsResolved ? '上游未返回候选项，请输入精确值' : '选项接口不可用，请输入精确值'}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value ? event.target.value : undefined)}
      />
    </div>
  );
}

export function LogFilters({
  draft,
  dirty,
  options,
  optionsLoading,
  optionsError,
  pageSize,
  onDraftChange,
  onApply,
  onReset,
  onPageSizeChange,
}: LogFiltersProps) {
  // 选项接口成功返回后才算"已解析"；否则 UI 明确说明是降级手输
  const optionsResolved = Boolean(options) && !optionsError;
  const channels = valueOptions(options, 'channels');
  const models = valueOptions(options, 'models');
  const apiKeys = valueOptions(options, 'apiKeys');
  const rangeValue: [Dayjs | null, Dayjs | null] | null =
    draft.startedAt || draft.endedAt
      ? [draft.startedAt ? dayjs(draft.startedAt) : null, draft.endedAt ? dayjs(draft.endedAt) : null]
      : null;

  const patch = (changes: Partial<LogListFilters>) => onDraftChange({ ...draft, ...changes });

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="filters">
        <div className="field" style={{ gridColumn: 'span 2' }}>
          <span className="field__label">时间范围（startedAt / endedAt）</span>
          <DatePicker.RangePicker
            aria-label="时间范围"
            showTime
            allowEmpty={[true, true]}
            value={rangeValue}
            presets={[
              { label: '最近 1 小时', value: [dayjs().subtract(1, 'hour'), dayjs()] },
              { label: '最近 24 小时', value: [dayjs().subtract(24, 'hour'), dayjs()] },
              { label: '最近 7 天', value: [dayjs().subtract(7, 'day'), dayjs()] },
            ]}
            onChange={(dates) => {
              const start = dates?.[0] ?? null;
              const end = dates?.[1] ?? null;
              patch({
                startedAt: start ? start.toISOString() : undefined,
                endedAt: end ? end.toISOString() : undefined,
              });
            }}
          />
        </div>

        <div className="field">
          <span className="field__label">状态</span>
          <Select
            aria-label="状态"
            allowClear
            placeholder="全部状态"
            value={draft.status}
            options={statusOptions(options)}
            onChange={(next) => patch({ status: next ?? undefined })}
          />
        </div>

        <TextOrSelect
          label="渠道（channel）"
          placeholder="全部渠道"
          value={draft.channel}
          options={channels}
          optionsResolved={optionsResolved}
          onChange={(next) => patch({ channel: next })}
        />

        <TextOrSelect
          label="模型（model）"
          placeholder="全部模型"
          value={draft.model}
          options={models}
          optionsResolved={optionsResolved}
          onChange={(next) => patch({ model: next })}
        />

        <TextOrSelect
          label="API Key（apiKey）"
          placeholder="全部 Key"
          value={draft.apiKey}
          options={apiKeys}
          optionsResolved={optionsResolved}
          onChange={(next) => patch({ apiKey: next })}
        />

        <div className="field">
          <span className="field__label">协议（protocol）</span>
          <Select
            aria-label="协议"
            allowClear
            placeholder="全部协议"
            value={draft.protocol}
            options={protocolOptions(options)}
            onChange={(next) => patch({ protocol: next ?? undefined })}
          />
        </div>

        <div className="field">
          <span className="field__label">关键词（query，≤256 字符）</span>
          <Input
            aria-label="关键词"
            allowClear
            maxLength={256}
            placeholder="按上游 query 参数搜索"
            value={draft.query ?? ''}
            onChange={(event) => patch({ query: event.target.value || undefined })}
            onPressEnter={onApply}
          />
        </div>

        <div className="field">
          <span className="field__label">排序（sort）</span>
          <Select
            aria-label="排序字段"
            value={draft.sort}
            options={LOG_SORT_OPTIONS}
            onChange={(next) => patch({ sort: next as RequestLogSort })}
          />
        </div>

        <div className="field">
          <span className="field__label">排序方向（descending）</span>
          <div className="row" style={{ gap: 8 }}>
            <Switch
              checked={draft.descending}
              onChange={(checked) => patch({ descending: checked })}
              aria-label="降序排列"
            />
            <span className="text-sm text-secondary">{draft.descending ? '降序（新→旧）' : '升序（旧→新）'}</span>
          </div>
        </div>

        <div className="field">
          <span className="field__label">每页条数（pageSize，≤200）</span>
          <Select
            aria-label="每页条数"
            value={pageSize}
            options={LOG_PAGE_SIZE_OPTIONS.map((size) => ({ value: size, label: `${size} 条` }))}
            onChange={(next) => onPageSizeChange(next)}
          />
        </div>

        <div className="field">
          <span className="field__label">应用筛选</span>
          <div className="row" style={{ gap: 8 }}>
            <Button type="primary" onClick={onApply} aria-label="应用筛选条件">
              查询
            </Button>
            <Button onClick={onReset} aria-label="重置筛选条件">
              重置
            </Button>
          </div>
        </div>
      </div>

      <div className={`row ${styles.filterMeta}`}>
        {dirty ? (
          <span className="text-sm text-secondary">筛选条件已修改但尚未应用，点击「查询」生效。</span>
        ) : (
          <span className="text-sm text-tertiary">筛选条件已应用。</span>
        )}
        {optionsError ? (
          <span className="text-sm text-tertiary">
            筛选选项接口不可用（{optionsError.code}）：渠道/模型/Key 已降级为手输精确值，状态/协议使用契约枚举；
            不伪造候选选项。
          </span>
        ) : optionsLoading ? (
          <span className="text-sm text-tertiary">正在读取上游筛选选项…</span>
        ) : null}
      </div>
    </div>
  );
}
