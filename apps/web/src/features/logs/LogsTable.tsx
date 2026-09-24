/**
 * 请求日志列表（AntD Table）。
 *
 * 要求（实施文档 6.8 / 8.x）：
 * - 字段全部来自 RequestLogData（生成契约），不臆造列；
 * - 行点击打开详情抽屉，同时提供可聚焦的「详情」按钮以支持键盘操作；
 * - 表格 scroll={{ x: 'max-content' }}，移动端不出现无法提交的遮挡；
 * - 上游字符串（模型名、错误信息等）只作为 React 文本节点渲染，不做 HTML 解析。
 */

import { Button, Table } from 'antd';
import type { TableProps } from 'antd';
import { MonoText, Pill, RelativeTime, TimeText } from '@/components/bits';
import {
  COST_TICKS_HINT,
  formatCount,
  formatDuration,
  modelSummary,
  statusLabel,
  statusTone,
  type RequestLogData,
} from './logTypes';
import styles from './logs.module.scss';

export interface LogsTableProps {
  rows: RequestLogData[];
  onOpenDetail: (logId: string) => void;
}

export function LogsTable({ rows, onOpenDetail }: LogsTableProps) {
  const columns: TableProps<RequestLogData>['columns'] = [
    {
      title: '时间',
      key: 'createdAt',
      width: 190,
      render: (_value, row) => (
        <span className={styles.timeCell}>
          <TimeText value={row.createdAt} />
          <span className="text-sm text-tertiary">
            <RelativeTime value={row.createdAt} />
          </span>
        </span>
      ),
    },
    {
      title: '状态',
      key: 'status',
      width: 110,
      render: (_value, row) => <Pill tone={statusTone(row.status)}>{statusLabel(row.status)}</Pill>,
    },
    {
      title: '渠道',
      dataIndex: 'channelId',
      key: 'channelId',
      width: 170,
      render: (value: string | null | undefined) => (value ? <MonoText truncate>{value}</MonoText> : <span className="text-tertiary">未知</span>),
    },
    {
      title: '模型',
      key: 'model',
      width: 220,
      render: (_value, row) => {
        const model = modelSummary(row);
        if (!model.requested && !model.final) return <span className="text-tertiary">未知</span>;
        return (
          <span className={styles.modelCell}>
            <MonoText truncate>{model.requested ?? '未知（请求模型）'}</MonoText>
            {model.changed ? (
              <span className="text-sm text-tertiary">
                最终：<MonoText>{model.final ?? '未知'}</MonoText>
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      title: 'API Key',
      dataIndex: 'apiKeyName',
      key: 'apiKeyName',
      width: 150,
      render: (value: string | null | undefined) => (value ? <MonoText truncate>{value}</MonoText> : <span className="text-tertiary">未提供</span>),
    },
    {
      title: '协议',
      dataIndex: 'protocol',
      key: 'protocol',
      width: 130,
      render: (value: string | null | undefined) => (value ? <Pill mono>{value}</Pill> : <span className="text-tertiary">未知</span>),
    },
    {
      title: '耗时',
      key: 'latency',
      width: 100,
      render: (_value, row) => <span>{formatDuration(row.durationMilliseconds)}</span>,
    },
    {
      title: 'Tokens（输入/输出）',
      key: 'tokens',
      width: 150,
      render: (_value, row) => (
        <span className="mono">
          {formatCount(row.inputTokens)} / {formatCount(row.outputTokens)}
        </span>
      ),
    },
    {
      title: '重试',
      key: 'retryCount',
      width: 80,
      render: (_value, row) => <span className="mono">{formatCount(row.retryCount)}</span>,
    },
    {
      title: '成本（costTicks）',
      key: 'costTicks',
      width: 140,
      render: (_value, row) => (
        <span className="mono" title={COST_TICKS_HINT}>
          {formatCount(row.costTicks)}
        </span>
      ),
    },
    {
      title: '错误',
      key: 'error',
      width: 220,
      render: (_value, row) =>
        row.error ? (
          <span className={styles.errorCell} title={row.error}>
            {row.error}
          </span>
        ) : (
          <span className="text-tertiary">无</span>
        ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 90,
      fixed: 'right',
      render: (_value, row) => (
        <Button
          size="small"
          aria-label={`查看日志 ${row.id} 详情`}
          onClick={(event) => {
            event.stopPropagation();
            onOpenDetail(row.id);
          }}
        >
          详情
        </Button>
      ),
    },
  ];

  return (
    <Table<RequestLogData>
      className={styles.table}
      columns={columns}
      dataSource={rows}
      rowKey="id"
      size="small"
      pagination={false}
      scroll={{ x: 'max-content' }}
      onRow={(row) => ({
        className: styles.tableRow,
        tabIndex: 0,
        'aria-label': `日志 ${row.id}，状态 ${statusLabel(row.status)}，点击查看详情`,
        onClick: () => onOpenDetail(row.id),
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpenDetail(row.id);
          }
        },
      })}
    />
  );
}
