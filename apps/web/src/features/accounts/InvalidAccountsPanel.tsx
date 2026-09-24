/**
 * 无效账号列表（GET /oauth/invalid-accounts）。
 *
 * 本版允许清单里没有 invalid-accounts/delete*，因此这里只读展示，
 * 不显示任何“点了会失败”的按钮；需要处理时请到账号详情里操作（详情允许 PATCH/DELETE）。
 */

import { useState } from 'react';
import { Table, type TableColumnsType } from 'antd';
import { Pill, TimeText } from '@/components/bits';
import { AsyncState } from '@/components/state';
import { useInvalidAccountsQuery } from './accountsApi';
import {
  formatBoolean,
  formatCount,
  providerLabel,
  readPageMeta,
  type OAuthAccountListData,
  type OAuthAccountSummaryData,
} from './oauthTypes';
import styles from './accounts.module.scss';

export function InvalidAccountsPanel({
  onOpenAccount,
}: {
  onOpenAccount: (accountId: string) => void;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const query = useInvalidAccountsQuery(page, pageSize);
  const data = query.data?.data;
  const meta = readPageMeta(query.data?.meta);

  const columns: TableColumnsType<OAuthAccountSummaryData> = [
    {
      title: '账号',
      key: 'displayName',
      render: (_value, account) => (
        <div className={styles.accountCell}>
          <span className={styles.accountName}>{account.displayName}</span>
          <span className={styles.accountIdentity}>{account.identity}</span>
        </div>
      ),
    },
    {
      title: '供应商',
      key: 'provider',
      width: 120,
      render: (_value, account) => providerLabel(account.provider),
    },
    {
      title: '失效标记',
      key: 'invalid',
      width: 110,
      render: (_value, account) => <Pill tone="danger">{formatBoolean(account.invalid)}</Pill>,
    },
    {
      title: '可用 / 额度受限',
      key: 'available',
      width: 150,
      render: (_value, account) => (
        <span className={styles.hint}>
          可用：{formatBoolean(account.available)} · 额度受限：{formatBoolean(account.quotaLimited)}
        </span>
      ),
    },
    {
      title: '冷却至',
      key: 'disabledUntil',
      width: 160,
      render: (_value, account) => <TimeText value={account.disabledUntil} />,
    },
    {
      title: '原因',
      key: 'disabledReason',
      render: (_value, account) =>
        account.disabledReason ?? <span className="text-tertiary">上游未提供</span>,
    },
    {
      title: '模型',
      key: 'modelCount',
      width: 110,
      render: (_value, account) =>
        `${formatCount(account.modelCount) ?? '未知'} / 禁用 ${formatCount(account.disabledModelCount) ?? '未知'}`,
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      render: (_value, account) => (
        <button
          type="button"
          className="btn btn--sm btn--secondary"
          onClick={() => onOpenAccount(account.accountId)}
        >
          查看详情
        </button>
      ),
    },
  ];

  return (
    <div className={styles.section}>
      <div className="notice-box" role="status">
        <div className="stack" style={{ gap: 6 }}>
          <span>
            这里列出上游判定为无效（invalid）的账号。本版<strong>不开放</strong>
            /oauth/invalid-accounts/delete 与 delete-plan 接口，所以没有删除按钮；
            需要处理时可打开账号详情执行允许清单内的动作（刷新令牌 / 清除错误 / PATCH / DELETE）。
          </span>
          <span>空列表表示上游当前没有无效账号；加载失败不会被当作空列表。</span>
        </div>
      </div>

      <AsyncState<OAuthAccountListData>
        isLoading={query.isLoading}
        error={query.error}
        data={data ?? undefined}
        isEmpty={(value) => value.items.length === 0}
        emptyTitle="没有无效账号"
        emptyDescription="上游返回的无效账号列表为空。"
        onRetry={() => void query.refetch()}
        isStale={query.isError && Boolean(data)}
        loadingLabel="加载无效账号…"
      >
        {(value) => (
          <div className={styles.tableWrap}>
            <Table<OAuthAccountSummaryData>
              columns={columns}
              dataSource={value.items}
              rowKey="accountId"
              size="small"
              scroll={{ x: 'max-content' }}
              pagination={{
                current: meta.page ?? page,
                pageSize: meta.pageSize ?? pageSize,
                total: meta.total ?? undefined,
                showSizeChanger: true,
                pageSizeOptions: [20, 50, 100, 200],
                onChange: (nextPage, nextPageSize) => {
                  setPage(nextPage);
                  setPageSize(nextPageSize);
                },
                showTotal: (total) => `共 ${total} 个无效账号`,
              }}
            />
          </div>
        )}
      </AsyncState>
    </div>
  );
}
