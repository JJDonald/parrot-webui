import { EmptyState } from '@/components/state';

export function NotFoundPage() {
  return (
    <EmptyState
      title="页面不存在"
      description="请使用左侧导航进入管理功能；未知路径不会作为管理入口。"
    />
  );
}
