/**
 * OAuth 账号页面。
 *
 * 使用的接口（全部在 BFF 允许清单内，实施文档 6.5）：
 * - GET    /oauth/accounts                        账号列表（filter / provider / enabled / sort / page / pageSize）
 * - GET    /oauth/accounts/{accountId}            账号详情（抽屉）
 * - PATCH  /oauth/accounts/{accountId}            编辑（If-Match）
 * - DELETE /oauth/accounts/{accountId}            删除（If-Match 必填，204）
 * - POST   /oauth/accounts/{accountId}/actions/{refresh-token|refresh-usage|clear-errors|clear-affinity}
 * - POST   /oauth/actions/{refresh-usage|clear-errors}   批量（作用范围是全部账号，不是选中集合）
 * - GET/PATCH /oauth/accounts/{accountId}/models 与 .../models/actions/sync、.../models/settings
 * - POST   /oauth/login-flows（+ poll / complete / cancel）
 * - POST   /oauth/imports/preview 与 /oauth/imports/{importId}/commit
 * - GET    /oauth/invalid-accounts
 * - GET/PATCH /oauth/settings
 *
 * 不调用（本版允许清单之外，也不显示按钮）：reset-quota、workbuddy/*、invalid-accounts/delete*。
 */

import { useState } from 'react';
import { Table, Tabs, type TableColumnsType } from 'antd';
import type { ApiError } from '@/api/client';
import { useLastSuccessAt, usePollingInterval } from '@/api/hooks';
import { useOperations } from '@/api/operations';
import { useWriteCapability } from '@/app/AuthProvider';
import { MonoText, Pill, RelativeTime, TimeText } from '@/components/bits';
import { ErrorNotice } from '@/components/feedback';
import { AsyncState } from '@/components/state';
import { AccountDetailDrawer } from './AccountDetailDrawer';
import { ImportPanel } from './ImportPanel';
import { InvalidAccountsPanel } from './InvalidAccountsPanel';
import { LoginFlowPanel } from './LoginFlowPanel';
import { OAuthSettingsPanel } from './OAuthSettingsPanel';
import {
  accountInvalidationKeys,
  useAccountsListQuery,
  useBatchClearErrorsMutation,
  useBatchRefreshUsageMutation,
  useClearAccountErrorsMutation,
  useRefreshUsageMutation,
  useUpdateAccountMutation,
  type AccountsListParams,
} from './accountsApi';
import { toApiError } from './errors';
import {
  ACCOUNT_FILTER_LABEL,
  ACCOUNT_SORT_LABEL,
  OAUTH_PROVIDERS,
  PROVIDER_LABEL,
  accountAvailabilityLabel,
  formatBoolean,
  formatCount,
  operationIdFrom,
  providerLabel,
  readPageMeta,
  type OAuthAccountFilter,
  type OAuthAccountSort,
  type OAuthAccountListData,
  type OAuthAccountSummaryData,
  type OAuthProvider,
} from './oauthTypes';
import styles from './accounts.module.scss';

type TabKey = 'accounts' | 'login' | 'import' | 'invalid' | 'settings';

const TAB_LABELS: Record<TabKey, string> = {
  accounts: '账号列表',
  login: '登录账号',
  import: '批量导入',
  invalid: '无效账号',
  settings: '相关设置',
};

export function AccountsPage() {
  const [tab, setTab] = useState<TabKey>('accounts');
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [filter, setFilter] = useState<OAuthAccountFilter>('all');
  const [provider, setProvider] = useState<OAuthProvider | null>(null);
  const [enabledFilter, setEnabledFilter] = useState<boolean | null>(null);
  const [sort, setSort] = useState<OAuthAccountSort>('configured');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [rowPendingId, setRowPendingId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);

  const { canWrite, reason: writeReason } = useWriteCapability();
  const { track } = useOperations();

  const listInterval = usePollingInterval(30_000);
  const params: AccountsListParams = { filter, provider, enabled: enabledFilter, sort, page, pageSize };
  const list = useAccountsListQuery(params, listInterval);
  const lastSuccessAt = useLastSuccessAt(list);

  const updateAccount = useUpdateAccountMutation();
  const refreshUsage = useRefreshUsageMutation();
  const clearErrors = useClearAccountErrorsMutation();
  const batchRefreshUsage = useBatchRefreshUsageMutation();
  const batchClearErrors = useBatchClearErrorsMutation();

  const data = list.data?.data;
  const meta = readPageMeta(list.data?.meta);

  const resetFilters = () => {
    setFilter('all');
    setProvider(null);
    setEnabledFilter(null);
    setSort('configured');
    setPage(1);
  };

  const runRowAction = async (accountId: string, label: string, action: () => Promise<void>) => {
    setActionError(null);
    setActionMessage(null);
    setRowPendingId(accountId);
    try {
      await action();
    } catch (caught) {
      setActionError(toApiError(caught, `${label}请求失败`));
    } finally {
      setRowPendingId(null);
    }
  };

  const columns: TableColumnsType<OAuthAccountSummaryData> = [
    {
      title: '账号',
      key: 'displayName',
      render: (_value, account) => (
        <div className={styles.accountCell}>
          <span className={styles.accountName}>{account.displayName}</span>
          <span className={styles.accountIdentity} title={account.identity}>
            {account.identity}
          </span>
          <span className={styles.hint}>账号 ID：{account.accountId}</span>
        </div>
      ),
    },
    {
      title: '供应商',
      key: 'provider',
      width: 110,
      render: (_value, account) => providerLabel(account.provider),
    },
    {
      title: '状态',
      key: 'status',
      width: 190,
      render: (_value, account) => {
        const availability = accountAvailabilityLabel(account);
        return (
          <div className={styles.accountCell}>
            <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <Pill tone={availability.tone}>{availability.label}</Pill>
              {account.invalid ? <Pill tone="danger">invalid</Pill> : null}
              {account.quotaLimited ? <Pill tone="warning">额度受限</Pill> : null}
            </span>
            {account.disabledReason ? <span className={styles.hint}>{account.disabledReason}</span> : null}
            {account.disabledUntil ? (
              <span className={styles.hint}>
                冷却至 <TimeText value={account.disabledUntil} />
              </span>
            ) : null}
          </div>
        );
      },
    },
    {
      title: '额度 / 用量',
      key: 'quota',
      width: 200,
      render: (_value, account) => (
        <div className={styles.accountCell}>
          <span className={styles.hint}>额度受限（quotaLimited）：{formatBoolean(account.quotaLimited)}</span>
          <span className={styles.hint}>可用（available）：{formatBoolean(account.available)}</span>
          <span className={styles.hint}>
            列表接口不返回额度数值：具体用量窗口与本地统计请打开详情查看（未知不会显示成 0 或无限）。
          </span>
        </div>
      ),
    },
    {
      title: '模型',
      key: 'modelCount',
      width: 120,
      render: (_value, account) => (
        <span className={styles.hint}>
          共 {formatCount(account.modelCount) ?? '未知'} 个
          <br />
          禁用 {formatCount(account.disabledModelCount) ?? '未知'} 个
        </span>
      ),
    },
    {
      title: '并发',
      key: 'maxConcurrent',
      width: 90,
      render: (_value, account) => formatCount(account.maxConcurrent) ?? '未知',
    },
    {
      title: '凭据',
      key: 'credentialConfigured',
      width: 110,
      render: (_value, account) =>
        account.credentialConfigured === true ? (
          <Pill tone="success">已配置</Pill>
        ) : (
          <span className="text-tertiary">未知</span>
        ),
    },
    {
      title: '启用',
      key: 'enabled',
      width: 90,
      render: (_value, account) => (
        <label
          className={styles.inlineSwitch}
          onClick={(event) => event.stopPropagation()}
          title={canWrite ? '切换启用状态（PATCH /oauth/accounts/{accountId}）' : '当前会话只读'}
        >
          <input
            type="checkbox"
            checked={account.enabled}
            disabled={!canWrite || (rowPendingId === account.accountId && updateAccount.isPending)}
            aria-label={`切换 ${account.displayName} 的启用状态`}
            onChange={(event) => {
              const nextEnabled = event.target.checked;
              void runRowAction(account.accountId, '切换启用状态', async () => {
                const response = await updateAccount.mutateAsync({
                  accountId: account.accountId,
                  body: { enabled: nextEnabled },
                  ifMatch: account.revision,
                });
                setActionMessage(
                  `账号 ${account.displayName} 已${nextEnabled ? '启用' : '禁用'}（HTTP ${response.status}）。`,
                );
              });
            }}
          />
        </label>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 240,
      render: (_value, account) => (
        <div className={styles.rowActions} onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="btn btn--sm btn--secondary"
            onClick={() => setSelectedAccountId(account.accountId)}
          >
            详情
          </button>
          <button
            type="button"
            className="btn btn--sm btn--secondary"
            disabled={!canWrite || (rowPendingId === account.accountId && refreshUsage.isPending)}
            onClick={() =>
              void runRowAction(account.accountId, '刷新用量', async () => {
                const response = await refreshUsage.mutateAsync({ accountId: account.accountId });
                const operationId = operationIdFrom(response);
                if (operationId) {
                  track({
                    operationId,
                    origin: `账号刷新用量（${account.displayName}）`,
                    invalidate: accountInvalidationKeys,
                  });
                  setActionMessage('刷新用量已受理（202），进度见任务中心；受理不等于完成。');
                  return;
                }
                setActionMessage(`刷新用量直接返回（HTTP ${response.status}），请稍后刷新查看。`);
              })
            }
          >
            刷新用量
          </button>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            disabled={!canWrite || (rowPendingId === account.accountId && clearErrors.isPending)}
            onClick={() =>
              void runRowAction(account.accountId, '清除错误', async () => {
                await clearErrors.mutateAsync({ accountId: account.accountId });
                setActionMessage(`账号 ${account.displayName} 的运行时错误记录已清除（204）。`);
              })
            }
          >
            清除错误
          </button>
        </div>
      ),
    },
  ];

  const accountsTab = (
    <div className={styles.section}>
      <div className="keeper-card">
        <div className={styles.cardHeader}>
          <div className={styles.cardHeaderText}>
            <h2 className="keeper-card__title">OAuth 账号</h2>
            <p className="keeper-card__subtitle">
              账号列表与详情来自上游 OAuth 账号接口；额度/用量只展示上游真实返回值，缺失即“未知”。
              点击任意一行打开详情抽屉。
            </p>
          </div>
          <div className={styles.toolbarEnd}>
            <span className={styles.hint}>
              最近成功刷新：
              {lastSuccessAt ? <RelativeTime value={lastSuccessAt.toISOString()} /> : <span>尚未成功读取</span>}
              {list.isError && data ? '（当前刷新失败，下面是上次快照）' : ''}
            </span>
            <button type="button" className="btn btn--sm btn--secondary" onClick={() => void list.refetch()}>
              {list.isFetching ? '刷新中…' : '刷新列表'}
            </button>
          </div>
        </div>

        {!canWrite ? (
          <div className="notice-box notice-box--warning" role="status" style={{ marginTop: 12 }}>
            当前会话不具备写能力{writeReason ? `（${writeReason}）` : ''}：写按钮已禁用并说明原因；
            上游仍会对每个写请求独立校验权限。
          </div>
        ) : null}

        <div className={styles.filters} style={{ marginTop: 12 }}>
          <label className={styles.filterField}>
            <span className={styles.filterLabel}>状态筛选</span>
            <select
              className="input"
              value={filter}
              aria-label="状态筛选"
              onChange={(event) => {
                setFilter(event.target.value as OAuthAccountFilter);
                setPage(1);
              }}
            >
              {(Object.keys(ACCOUNT_FILTER_LABEL) as OAuthAccountFilter[]).map((item) => (
                <option key={item} value={item}>
                  {ACCOUNT_FILTER_LABEL[item]}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.filterField}>
            <span className={styles.filterLabel}>供应商</span>
            <select
              className="input"
              value={provider ?? ''}
              aria-label="供应商筛选"
              onChange={(event) => {
                const value = event.target.value;
                setProvider(value === '' ? null : (value as OAuthProvider));
                setPage(1);
              }}
            >
              <option value="">全部供应商</option>
              {OAUTH_PROVIDERS.map((item) => (
                <option key={item} value={item}>
                  {PROVIDER_LABEL[item]}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.filterField}>
            <span className={styles.filterLabel}>启用状态</span>
            <select
              className="input"
              value={enabledFilter === null ? '' : enabledFilter ? 'true' : 'false'}
              aria-label="启用状态筛选"
              onChange={(event) => {
                const value = event.target.value;
                setEnabledFilter(value === '' ? null : value === 'true');
                setPage(1);
              }}
            >
              <option value="">全部</option>
              <option value="true">已启用</option>
              <option value="false">已禁用</option>
            </select>
          </label>
          <label className={styles.filterField}>
            <span className={styles.filterLabel}>排序</span>
            <select
              className="input"
              value={sort}
              aria-label="排序方式"
              onChange={(event) => {
                setSort(event.target.value as OAuthAccountSort);
                setPage(1);
              }}
            >
              {(Object.keys(ACCOUNT_SORT_LABEL) as OAuthAccountSort[]).map((item) => (
                <option key={item} value={item}>
                  {ACCOUNT_SORT_LABEL[item]}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn--sm btn--ghost" onClick={resetFilters}>
            重置筛选
          </button>
        </div>

        <div className={styles.filters} style={{ marginTop: 12 }}>
          <span className={styles.filterLabel}>批量动作（作用范围：全部账号，上游没有按选中集合的批量接口）</span>
          <button
            type="button"
            className="btn btn--sm btn--secondary"
            disabled={!canWrite || batchRefreshUsage.isPending}
            onClick={async () => {
              setActionError(null);
              setActionMessage(null);
              try {
                const response = await batchRefreshUsage.mutateAsync({});
                const operationId = operationIdFrom(response);
                if (operationId) {
                  track({
                    operationId,
                    origin: 'OAuth 批量刷新用量（全部账号）',
                    invalidate: accountInvalidationKeys,
                  });
                  setActionMessage('批量刷新用量已受理（202）；这是异步任务，不代表已完成。');
                } else {
                  setActionMessage(`批量刷新用量直接返回（HTTP ${response.status}）。`);
                }
              } catch (caught) {
                setActionError(toApiError(caught, '批量刷新用量失败'));
              }
            }}
          >
            {batchRefreshUsage.isPending ? '提交中…' : '刷新全部账号用量（202）'}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--secondary"
            disabled={!canWrite || batchClearErrors.isPending}
            onClick={async () => {
              setActionError(null);
              setActionMessage(null);
              try {
                const response = await batchClearErrors.mutateAsync({});
                const cleared = response.data?.cleared;
                setActionMessage(
                  typeof cleared === 'number'
                    ? `上游已清除 ${cleared} 条错误记录（HTTP ${response.status}）。`
                    : `批量清除错误已返回（HTTP ${response.status}），但上游未返回 cleared 计数。`,
                );
              } catch (caught) {
                setActionError(toApiError(caught, '批量清除错误失败'));
              }
            }}
          >
            {batchClearErrors.isPending ? '提交中…' : '清除全部账号错误'}
          </button>
        </div>

        {actionMessage ? (
          <div className="notice-box" role="status" style={{ marginTop: 12 }}>
            {actionMessage}
          </div>
        ) : null}
        {actionError ? (
          <div style={{ marginTop: 12 }}>
            <ErrorNotice error={actionError} />
          </div>
        ) : null}
      </div>

      <AsyncState<OAuthAccountListData>
        isLoading={list.isLoading}
        error={list.error}
        data={data ?? undefined}
        isEmpty={(value) => value.items.length === 0}
        emptyTitle="没有符合条件的账号"
        emptyDescription="上游返回空列表：可以调整筛选条件，或到“登录账号 / 批量导入”标签页添加账号。"
        onRetry={() => void list.refetch()}
        isStale={list.isError && Boolean(data)}
        loadingLabel="加载 OAuth 账号…"
      >
        {(value) => (
          <div className={styles.tableWrap}>
            <Table<OAuthAccountSummaryData>
              columns={columns}
              dataSource={value.items}
              rowKey="accountId"
              size="small"
              scroll={{ x: 'max-content' }}
              onRow={(account) => ({
                onClick: () => setSelectedAccountId(account.accountId),
                style: { cursor: 'pointer' },
                title: '点击打开账号详情',
              })}
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
                showTotal: (total) => `共 ${total} 个账号`,
              }}
            />
          </div>
        )}
      </AsyncState>

      <div className={styles.rowActions}>
        <span className={styles.hint}>
          revision（列表级，写入时按账号自身的 revision 回传 If-Match）：{' '}
          <MonoText>{data?.revision ?? '未知'}</MonoText>
        </span>
      </div>
    </div>
  );

  return (
    <div className={styles.section}>
      <Tabs
        activeKey={tab}
        onChange={(key) => setTab(key as TabKey)}
        destroyOnHidden
        items={(Object.keys(TAB_LABELS) as TabKey[]).map((key) => ({
          key,
          label: TAB_LABELS[key],
          children: (
            <div className={styles.tabPanel}>
              {key === 'accounts' ? accountsTab : null}
              {key === 'login' ? (
                <LoginFlowPanel
                  canWrite={canWrite}
                  writeReason={writeReason}
                  onOpenAccount={(accountId) => {
                    setSelectedAccountId(accountId);
                    void list.refetch();
                  }}
                />
              ) : null}
              {key === 'import' ? <ImportPanel canWrite={canWrite} writeReason={writeReason} /> : null}
              {key === 'invalid' ? <InvalidAccountsPanel onOpenAccount={setSelectedAccountId} /> : null}
              {key === 'settings' ? <OAuthSettingsPanel canWrite={canWrite} writeReason={writeReason} /> : null}
            </div>
          ),
        }))}
      />

      <AccountDetailDrawer
        accountId={selectedAccountId}
        onClose={() => setSelectedAccountId(null)}
        onDeleted={(accountId) => {
          setActionMessage(`账号 ${accountId} 已删除（上游 204）。`);
          void list.refetch();
        }}
        canWrite={canWrite}
        writeReason={writeReason}
      />
    </div>
  );
}
