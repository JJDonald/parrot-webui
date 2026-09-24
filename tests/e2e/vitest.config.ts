import { defineConfig } from 'vitest/config';

/**
 * 端到端测试会真实监听本地端口并启动假上游，串行执行避免端口与状态互相干扰。
 */
export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['**/*.test.ts'],
  },
});
