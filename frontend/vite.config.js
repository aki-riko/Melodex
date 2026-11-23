import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Melodex PWA front-end build configuration.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['favicon-32.png', 'logo192.png', 'logo512.png'],
      manifest: {
        name: 'Melodex',
        short_name: 'Melodex',
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
        // 新部署后让新 SW 立即接管并清理旧预缓存,避免用户停留在旧 bundle
        // (否则 autoUpdate 的新 SW 会等所有标签页关闭才激活,表现为"刷新了还是旧的")。
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        importScripts: ['sw-force-reload.js'],
        runtimeCaching: [
          {
            // 封面图等图片:缓存优先,加速二次加载
            urlPattern: ({ request }) => request.destination === 'image',
            handler: 'CacheFirst',
            options: {
              cacheName: 'melodex-images',
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
    // ===== 手动分包(2026-11)=====
    //
    // ★ 背景:主包曾 586KB(gzip 187KB),全部打成一块。
    //   已先把 9 个页面组件改成 React.lazy()(主包 → 475KB / gzip 153KB)。
    //   这里再把**第三方库**拆出去,目的是**长期缓存**:
    //   库版本不变时,这些 chunk 的 hash 不变,用户发版后只需重下业务代码。
    //
    // ★ 为什么按这些边界分(不是按体积平均切):
    //   · react-vendor   react/react-dom/scheduler —— 版本最稳定,几乎永不失效
    //   · query-vendor   react-query —— 同样稳定
    //   · net-vendor     axios —— 稳定
    //   · icon-vendor    lucide-react —— 版本升得较快,单独一块避免连累 react
    //   · qr-vendor      qrcode.react —— 只在设置页用,连懒加载一起走
    //
    // ★ 不要用「把所有 node_modules 塞进一个 vendor chunk」的粗暴写法:
    //   那样任一库升级都会让整块 hash 变化,缓存全失效,
    //   反而比不拆更糟(用户要重下全部依赖)。
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react-vendor';
          if (/[\\/]node_modules[\\/](react-query|@tanstack)[\\/]/.test(id)) return 'query-vendor';
          if (/[\\/]node_modules[\\/]axios[\\/]/.test(id)) return 'net-vendor';
          if (/[\\/]node_modules[\\/]lucide-react[\\/]/.test(id)) return 'icon-vendor';
          if (/[\\/]node_modules[\\/]qrcode\.react[\\/]/.test(id)) return 'qr-vendor';
          // 其余小库交给 Rollup 自动归入主包（拆得太碎会增加请求数，反而不划算）
          return undefined;
        },
      },
    },
    // 主包压到 500KB 以下后，这个阈值就能守住回归了
    chunkSizeWarningLimit: 520,
  },
});
