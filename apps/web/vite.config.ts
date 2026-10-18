import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 正式部署前缀固定为 /webui/：静态资源、路由 basename、fetch 前缀与 Cookie Path 必须一致。
 * 开发模式只绑定 127.0.0.1，并把 /webui/bff 与 /webui/health 代理到本地 BFF（保留路径前缀与 Origin）。
 */
export default defineConfig(() => ({
  base: '/webui/',
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(here, 'src') },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/webui/bff': { target: 'http://127.0.0.1:3000', changeOrigin: false },
      '/webui/health': { target: 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    // 生产构建绝不产出 .map：dist 会被原样 COPY 进运行镜像并由 @fastify/static
    // 以 public, max-age=31536000, immutable 对外托管，sourcemap 等于把完整前端源码
    // （含注释与内部接口结构）公开给任何能访问 /webui/ 的人。排查线上问题请用
    // 本地 sourcemap 或按需临时构建，不要把它带进镜像。
    sourcemap: false,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // 按依赖族拆包，避免 11 个页面 + 全量 antd 挤进一个 chunk。
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@ant-design/icons')) return 'vendor-icons';
          if (id.includes('/antd/') || id.includes('@ant-design/cssinjs') || id.includes('@ant-design/colors') || id.includes('@ant-design/fast-color') || id.includes('@rc-component/') || id.includes('/rc-')) return 'vendor-antd';
          if (id.includes('@tanstack/react-query')) return 'vendor-query';
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('react-router') || id.includes('/scheduler/')) return 'vendor-react';
          if (id.includes('/dayjs/')) return 'vendor-dayjs';
          return 'vendor';
        },
      },
    },
  },
}));
