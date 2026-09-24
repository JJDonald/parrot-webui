import { Drawer, Table } from 'antd';
import type { ModelStatsData, StatsPeriod } from '../../../../../packages/contracts/generated/upstream-mvp';
import { encodeSegment } from '@/api/client';
import { useApiQuery } from '@/api/hooks';
import { AsyncState } from '@/components/state';
import { MonoText } from '@/components/bits';
import styles from './AnalysisPage.module.scss';

function count(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '未提供';
}

export function ModelStatsDrawer({ modelId, period, onClose }: { modelId: string | null; period: StatsPeriod; onClose: () => void }) {
  const stats = useApiQuery<ModelStatsData>({
    key: ['stats', 'model', modelId, period],
    path: `/stats/models/${encodeSegment(modelId ?? '')}`,
    query: { period },
    enabled: Boolean(modelId),
  });
  return <Drawer title={modelId ? `模型统计 · ${modelId}` : '模型统计'} open={Boolean(modelId)} onClose={onClose} width={600} destroyOnHidden>
    <AsyncState<ModelStatsData> isLoading={stats.isLoading} error={stats.error} data={stats.data?.data ?? undefined} onRetry={() => void stats.refetch()} isStale={stats.isError && Boolean(stats.data)}>
      {(data) => <div className={styles.drawerContent}>
        <p>统计周期：{data.period}。数值由 Parrot 模型统计接口直接返回。</p>
        <div className={styles.drawerMetrics}>
          <div><span>请求数</span><strong>{count(data.metrics.total)}</strong></div>
          <div><span>成功数</span><strong>{count(data.metrics.successCount)}</strong></div>
          <div><span>输入 Token</span><strong>{count(data.metrics.inputTokens)}</strong></div>
          <div><span>输出 Token</span><strong>{count(data.metrics.outputTokens)}</strong></div>
          <div><span>平均响应</span><strong>{typeof data.metrics.averageTotalMilliseconds === 'number' ? `${count(data.metrics.averageTotalMilliseconds)} ms` : '未提供'}</strong></div>
          <div><span>计费 ticks</span><strong>{count(data.metrics.costTicks)}</strong></div>
        </div>
        <h3>渠道分布</h3>
        {data.channels.length ? <Table rowKey="key" dataSource={data.channels} pagination={false} scroll={{ x: 'max-content' }} size="small" columns={[
          { title: '渠道', dataIndex: 'key', render: (value: string) => <MonoText truncate>{value}</MonoText> },
          { title: '请求数', dataIndex: 'count', align: 'right', render: (value: number) => count(value) },
          { title: '类型', dataIndex: 'type', render: (value: string | null) => value || '未提供' },
        ]} /> : <p className="text-secondary">该模型没有渠道明细。</p>}
      </div>}
    </AsyncState>
  </Drawer>;
}
