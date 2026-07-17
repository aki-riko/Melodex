import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import './index.css';
import App from './App';
import { scheduleServiceWorkerUpdates } from './pwaUpdatePolicy.js';

registerSW({
  immediate: true,
  // 页面重载统一由 sw-force-reload.js 的 activate 生命周期执行，避免双重刷新。
  onNeedReload: () => {},
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
