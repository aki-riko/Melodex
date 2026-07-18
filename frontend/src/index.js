import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import './index.css';
import App from './App';
import {
  createSafeServiceWorkerReloader,
  scheduleServiceWorkerUpdates,
} from './pwaUpdatePolicy.js';

const serviceWorkerReloader = createSafeServiceWorkerReloader();
serviceWorkerReloader.listen();

registerSW({
  immediate: true,
  // 更新已激活时必须切换页面内存中的旧 JS；播放中则等到 pause/ended 安全边界。
  onNeedReload: serviceWorkerReloader.requestReload,
  onRegisteredSW: (_swUrl, registration) => {
    scheduleServiceWorkerUpdates(registration, {
      intervalMs: import.meta.env.VITE_SW_UPDATE_INTERVAL_MS,
    });
  },
  onRegisterError: (err) => console.warn('注册 PWA 更新服务失败', err),
});

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
