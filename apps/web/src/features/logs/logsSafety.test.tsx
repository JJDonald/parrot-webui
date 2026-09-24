/**
 * 请求日志页自测（实施文档 11.2）：
 * - 任意日志字符串（如 `<script>alert(1)</script>`）只作为文本展示，绝不渲染为 HTML；
 * - 受控 JSON 展示不会把内容当作标签执行；
 * - 413 WEBUI_PAYLOAD_TOO_LARGE / 502 WEBUI_RESPONSE_TOO_LARGE 必须识别为"未完整展示"；
 * - 分页 meta 缺字段时保持"未知"，不伪造 0。

 * 说明：这里只用 react-dom/server 做字符串渲染断言，不引入额外测试依赖。
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import { JsonBlock } from '@/components/bits';
import { LogListStateNotice } from './LogNotices';
import { asDisplayText, isSizeLimitError, readListMeta, sizeLimitReason } from './logTypes';

describe('日志正文的 XSS 安全性', () => {
  it('日志字符串里的 <script> 只作为文本展示', () => {
    const dangerous = '<script>alert(1)</script>';
    expect(asDisplayText(dangerous)).toBe(dangerous);

    const html = renderToStaticMarkup(<JsonBlock value={asDisplayText(dangerous)} />);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('受控 JSON 里的 HTML 片段不会被当作标签执行', () => {
    const raw = JSON.stringify({
      headers: { 'x-note': '<img src=x onerror="alert(1)">' },
      content: '<b>bold</b>',
    });
    const parsed = asDisplayText(raw);
    expect(typeof parsed).toBe('object');

    const html = renderToStaticMarkup(<JsonBlock value={parsed} />);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });
});

describe('体积上限提示', () => {
  it('识别 502 WEBUI_RESPONSE_TOO_LARGE 与 413 WEBUI_PAYLOAD_TOO_LARGE', () => {
    const tooLarge = new ApiError({
      status: 502,
      code: 'WEBUI_RESPONSE_TOO_LARGE',
      source: 'webui',
      message: '上游响应超过 WebUI 允许的体积上限',
    });
    const payloadTooLarge = new ApiError({
      status: 413,
      code: 'WEBUI_PAYLOAD_TOO_LARGE',
      source: 'webui',
      message: '请求体超过限制',
    });

    expect(isSizeLimitError(tooLarge)).toBe(true);
    expect(isSizeLimitError(payloadTooLarge)).toBe(true);
    expect(sizeLimitReason(tooLarge)).toContain('未完整返回');
    expect(isSizeLimitError(new ApiError({ status: 500, code: 'WEBUI_INTERNAL', source: 'webui', message: 'x' }))).toBe(false);
  });
});

describe('分页 meta 不伪造数值', () => {
  it('缺失字段保持 null（未知），而不是 0', () => {
    const meta = readListMeta({});
    expect(meta.total).toBeNull();
    expect(meta.page).toBeNull();
    expect(meta.pageSize).toBeNull();
    expect(meta.hasNext).toBeNull();
  });

  it('按真实字段读取', () => {
    const meta = readListMeta({ total: 12, page: 2, pageSize: 50, hasNext: false, requestId: 'req-1' });
    expect(meta.total).toBe(12);
    expect(meta.hasNext).toBe(false);
    expect(meta.requestId).toBe('req-1');
  });
});

describe('权限不足与连接中断可区分', () => {
  it('CAPABILITY_DENIED 显示权限不足', () => {
    const html = renderToStaticMarkup(
      <LogListStateNotice
        error={new ApiError({ status: 403, code: 'CAPABILITY_DENIED', source: 'upstream', message: '缺少能力' })}
      />,
    );
    expect(html).toContain('权限不足');
  });

  it('传输错误显示连接中断', () => {
    const html = renderToStaticMarkup(
      <LogListStateNotice
        error={new ApiError({ status: 0, code: 'WEBUI_NETWORK_ERROR', source: 'network', message: '无法连接' })}
      />,
    );
    expect(html).toContain('连接中断');
  });

  it('普通业务失败不伪装成连接问题', () => {
    const html = renderToStaticMarkup(
      <LogListStateNotice
        error={new ApiError({ status: 400, code: 'VALIDATION_FAILED', source: 'upstream', message: '参数不合法' })}
      />,
    );
    expect(html).toBe('');
  });
});
