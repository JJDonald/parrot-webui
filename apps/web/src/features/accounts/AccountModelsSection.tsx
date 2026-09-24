/**
 * 账号模型面板（真实接口）：
 * - GET   /oauth/accounts/{accountId}/models
 * - PATCH /oauth/accounts/{accountId}/models               （启用/禁用，需要 If-Match）
 * - POST  /oauth/accounts/{accountId}/models/actions/sync   （202 + operation）
 * - PATCH /oauth/accounts/{accountId}/models/settings       （maxContextDefault，需要 If-Match）
 *
 * 说明：上游没有“跨页全选”语义，这里只对当前页选中的模型提交显式目标状态，
 * 不做盲目 toggle，也不假装支持全部筛选结果。
 */

import { useState, type Key } from 'react';
import { Table, type TableColumnsType } from 'antd';
import type { ApiError } from '@/api/client';
import { useOperations } from '@/api/operations';
import { Pill, TimeText } from '@/components/bits';
import { ErrorNotice } from '@/components/feedback';
import { AsyncState } from '@/components/state';
import {
  accountInvalidationKeys,
  useAccountModelsQuery,
  useSyncAccountModelsMutation,
  useUpdateAccountModelSettingsMutation,
  useUpdateAccountModelsMutation,
} from './accountsApi';
import { toApiError } from './errors';
import {
  formatCount,
  operationIdFrom,
  readPageMeta,
  type OAuthModelData,
  type OAuthModelListData,
} from './oauthTypes';
import styles from './accounts.module.scss';

export function AccountModelsSection({ accountId, canWrite }: { accountId: string; canWrite: boolean }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const models = useAccountModelsQuery(accountId, page, pageSize);
  const updateModels = useUpdateAccountModelsMutation();
  const syncModels = useSyncAccountModelsMutation();
  const updateSettings = useUpdateAccountModelSettingsMutation();
  const { track } = useOperations();
  const [selectedKeys, setSelectedKeys] = useState<Key[]>([]);

  const data = models.data?.data;
  const meta = readPageMeta(models.data?.meta);
  const revision = data?.revision;
  const selectedModelIds = selectedKeys.map((key) => String(key));

  const applyState = async (disabled: boolean) => {
    setActionError(null);
    setActionMessage(null);
    if (selectedModelIds.length === 0) return;
    try {
      const response = await updateModels.mutateAsync({
        accountId,
        body: { modelIds: selectedModelIds, disabled },
        ifMatch: revision,
      });
      setActionMessage(
        `上游已确认：${selectedModelIds.length} 个模型已${disabled ? '禁用' : '启用'}（HTTP ${response.status}）。`,
      );
      setSelectedKeys([]);
    } catch (caught) {
      setActionError(toApiError(caught, '模型状态提交失败'));
    }
  };

  const runSync = async () => {
    setActionError(null);
    setActionMessage(null);
    try {
      const response = await syncModels.mutateAsync({ accountId });
      const operationId = operationIdFrom(response);
      if (operationId) {
        track({
          operationId,
          origin: `账号模型同步（${accountId}）`,
          invalidate: accountInvalidationKeys,
        });
        setActionMessage('模型同步已受理（202），进度与结果见任务中心；同步失败只影响模型列表。');
      } else {
        setActionMessage(`模型同步直接返回（HTTP ${response.status}），请以模型列表为准。`);
      }
    } catch (caught) {
      setActionError(toApiError(caught, '模型同步请求失败（不代表账号授权失败）'));
    }
  };

  const toggleMaxContextDefault = async (model: OAuthModelData) => {
    setActionError(null);
    setActionMessage(null);
    try {
      const next = !(model.maxContextDefault === true);
      await updateSettings.mutateAsync({
        accountId,
        body: { modelId: model.modelId, maxContextDefault: next },
        ifMatch: revision,
      });
      setActionMessage(`模型 ${model.modelId} 的 maxContextDefault 已设为 ${next ? '是' : '否'}。`);
    } catch (caught) {
      setActionError(toApiError(caught, '模型设置提交失败'));
    }
  };

  const columns: TableColumnsType<OAuthModelData> = [
    {
      title: '模型',
      dataIndex: 'name',
      key: 'name',
      render: (_value, model) => (
        <div className={styles.accountCell}>
          <span className={styles.accountName}>{model.name}</span>
          <span className={styles.mono}>{model.modelId}</span>
        </div>
      ),
    },
    {
      title: '状态',
      key: 'disabled',
      width: 110,
      render: (_value, model) =>
        model.disabled ? <Pill tone="danger">已禁用</Pill> : <Pill tone="success">已启用</Pill>,
    },
    {
      title: '默认上下文',
      key: 'maxContextDefault',
      width: 120,
      render: (_value, model) =>
        model.maxContextDefault === true ? (
          <Pill tone="primary">是</Pill>
        ) : model.maxContextDefault === false ? (
          <Pill tone="muted">否</Pill>
        ) : (
          <span className="text-tertiary">未知</span>
        ),
    },
    {
      title: '上下文窗口',
      key: 'contextWindow',
      width: 150,
      render: (_value, model) => {
        const window = formatCount(model.contextWindow);
        const maxWindow = formatCount(model.maxContextWindow);
        return (
          <div className={styles.accountCell}>
            <span>{window ?? <span className="text-tertiary">未知</span>}</span>
            <span className={styles.hint}>
              上游最大：{maxWindow ?? '未知'}
              {model.maxInputTokens ? ` · 输入 ${formatCount(model.maxInputTokens)}` : ''}
              {model.maxOutputTokens ? ` · 输出 ${formatCount(model.maxOutputTokens)}` : ''}
            </span>
          </div>
        );
      },
    },
    {
      title: '冷却',
      key: 'cooldown',
      width: 150,
      render: (_value, model) => {
        if (model.cooldownPermanent) return <Pill tone="danger">永久冷却</Pill>;
        if (model.cooldownUntil) return <TimeText value={model.cooldownUntil} />;
        return <span className="text-tertiary">无</span>;
      },
    },
    {
      title: '推理强度',
      key: 'reasoningEfforts',
      width: 160,
      render: (_value, model) =>
        model.reasoningEfforts && model.reasoningEfforts.length > 0 ? (
          <span className={styles.hint}>{model.reasoningEfforts.join('、')}</span>
        ) : (
          <span className="text-tertiary">未知</span>
        ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 170,
      render: (_value, model) => (
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          disabled={!canWrite || updateSettings.isPending}
          onClick={() => void toggleMaxContextDefault(model)}
        >
          {model.maxContextDefault === true ? '取消默认上下文' : '设为默认上下文'}
        </button>
      ),
    },
  ];

  return (
    <div className={styles.section}>
      <div className={styles.modelToolbar}>
        <div className={styles.toolbar}>
          <button
            type="button"
            className="btn btn--sm btn--secondary"
            disabled={!canWrite || syncModels.isPending}
            onClick={() => void runSync()}
          >
            {syncModels.isPending ? '发起同步中…' : '同步模型（202 任务）'}
          </button>
          <span className={styles.hint}>
            同步是独立任务：失败只表示模型列表未刷新，不代表账号授权失败。
          </span>
        </div>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          disabled={models.isFetching}
          onClick={() => void models.refetch()}
        >
          {models.isFetching ? '刷新中…' : '刷新模型列表'}
        </button>
      </div>

      {actionMessage ? (
        <div className="notice-box" role="status">
          {actionMessage}
        </div>
      ) : null}
      {actionError ? <ErrorNotice error={actionError} /> : null}

      {selectedModelIds.length > 0 ? (
        <div className={styles.modelSelection}>
          <span>
            当前页已选 <strong>{selectedModelIds.length}</strong> 个模型
          </span>
          <button
            type="button"
            className="btn btn--sm btn--secondary"
            disabled={!canWrite || updateModels.isPending || !revision}
            onClick={() => void applyState(false)}
          >
            启用选中
          </button>
          <button
            type="button"
            className="btn btn--sm btn--secondary"
            disabled={!canWrite || updateModels.isPending || !revision}
            onClick={() => void applyState(true)}
          >
            禁用选中
          </button>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => setSelectedKeys([])}
          >
            清空选择
          </button>
          {!revision ? <span className={styles.hint}>缺少 revision，无法安全提交（需要 If-Match）。</span> : null}
        </div>
      ) : null}

      <AsyncState<OAuthModelListData>
        isLoading={models.isLoading}
        error={models.error}
        data={data ?? undefined}
        isEmpty={(value) => value.items.length === 0}
        emptyTitle="该账号没有可用模型"
        emptyDescription="上游返回的模型列表为空；可以先执行“同步模型”，或确认该账号的供应商是否支持模型发现。"
        onRetry={() => void models.refetch()}
        isStale={models.isError && Boolean(data)}
        loadingLabel="加载账号模型…"
      >
        {(value) => (
          <div className={styles.tableWrap}>
            <Table<OAuthModelData>
              columns={columns}
              dataSource={value.items}
              rowKey="modelId"
              size="small"
              scroll={{ x: 'max-content' }}
              rowSelection={{
                selectedRowKeys: selectedKeys,
                onChange: (keys) => setSelectedKeys(keys),
              }}
              pagination={{
                current: meta.page ?? page,
                pageSize: meta.pageSize ?? pageSize,
                total: meta.total ?? undefined,
                showSizeChanger: true,
                pageSizeOptions: [20, 50, 100, 200],
                onChange: (nextPage, nextPageSize) => {
                  setPage(nextPage);
                  setPageSize(nextPageSize);
                  setSelectedKeys([]);
                },
                showTotal: (total) => `共 ${total} 个模型`,
              }}
            />
          </div>
        )}
      </AsyncState>
    </div>
  );
}
