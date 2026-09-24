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
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
  },
}));
