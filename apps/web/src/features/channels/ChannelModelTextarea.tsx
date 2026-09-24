/**
 * 渠道模型列表编辑器（新增与编辑共用）。
 *
 * 上游字段是 `models: ChannelModelInput[]`（alias → real）；
 * 这里用「每行一个 `别名=真实模型 ID`」的文本框编辑，避免为一次 MVP 引入额外依赖。
 * 文本本身只存在于表单内存中，不写入持久化存储。
 */

import { useEffect, useRef, useState } from 'react';
import { parseModelsText, modelsToText } from './channelForm';
import type { ChannelModelInput } from './upstream-types';
import styles from './ChannelsPage.module.scss';

export interface ChannelModelTextareaProps {
  id: string;
  /** 初始值；父组件通过 key 控制重置时机（换渠道/重置表单时重新挂载）。 */
  initialModels: ChannelModelInput[];
  onChange: (models: ChannelModelInput[]) => void;
  disabled?: boolean;
  error?: string | undefined;
}

export function ChannelModelTextarea({ id, initialModels, onChange, disabled, error }: ChannelModelTextareaProps) {
  const [text, setText] = useState(() => modelsToText(initialModels));
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const parsed = parseModelsText(text);

  useEffect(() => {
    onChangeRef.current(parseModelsText(text).models);
  }, [text]);

  return (
    <label className={`field ${styles.fieldWide}`}>
      <span className="field__label">模型列表</span>
      <span className="field__hint">
        每行一个：<span className="mono">别名=真实模型 ID</span>（上游字段 models[].alias / models[].real）。
        只写一个值时别名与真实模型 ID 相同。共 {parsed.models.length} 项。
      </span>
      <textarea
        id={id}
        className={`input textarea ${styles.modelsTextarea}`}
        value={text}
        spellCheck={false}
        disabled={disabled}
        aria-label="模型列表，每行一个「别名=真实模型 ID」"
        onChange={(event) => setText(event.target.value)}
      />
      {parsed.lineErrors.length ? (
        <span className={styles.fieldError}>
          {parsed.lineErrors
            .map((item) => `第 ${item.line} 行：${item.message}`)
            .join('；')}
        </span>
      ) : null}
      {error ? <span className={styles.fieldError}>{error}</span> : null}
    </label>
  );
}
