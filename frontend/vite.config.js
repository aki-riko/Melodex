import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// TuneScout+ 前端构建配置(从 CRA 迁移而来)。
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'favicon-32.png', 'logo192.png', 'logo512.png'],
      manifest: {
        name: 'TuneScout+',
        short_name: 'TuneScout+',
        description: '音乐发现与多源下载二合一',
        theme_color: '#181818',
        background_color: '#181818',
        display: 'standalone',
        start_url: '.',
        icons: [
          { src: 'logo192.png', sizes: '192x192', type: 'image/png' },
          { src: 'logo512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // 预缓存构建产物,实现离线可用;音频/视频/API 不缓存(实时性)。
        globPatterns: ['**/*.{js,css,html,png,svg,ico}'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/music/, /^\/videos/],
        runtimeCaching: [
          {
            // 封面图等图片:缓存优先,加速二次加载
            urlPattern: ({ request }) => request.destination === 'image',
            handler: 'CacheFirst',
            options: {
              cacheName: 'tunescout-images',
              expiration: { maxEntries: 200, maxAgeSeconds: 7 * 24 * 3600 },
            },
          },
        ],
      },
    }),
  ],
  // 相对基址,适配本地全栈部署(前后端同源)与子路径托管。
  base: './',
  server: {
    port: 3000,
  },
  // 本项目沿用 CRA 习惯,JSX 写在 .js 文件中;让 esbuild 按 jsx 解析 .js。
  esbuild: {
    loader: 'jsx',
    include: /src\/.*\.jsx?$/,
    exclude: [],
  },
  optimizeDeps: {
    esbuildOptions: {
      loader: { '.js': 'jsx' },
    },
  },
  build: {
    outDir: 'build', // 沿用 CRA 的输出目录名,兼容已有部署习惯
  },
});
