import { defineConfig } from 'vite';

// AudioWorklet 处理器放在 public/worklets/ 下，作为独立 ES 模块直接 URL 加载，
// 不经过打包，避免 worklet 环境与 bundler 产物不兼容。
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
    open: false,
  },
});
