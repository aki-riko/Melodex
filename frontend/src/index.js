import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import './index.css';
import App from './App';
import { scheduleServiceWorkerUpdates } from './pwaUpdatePolicy.js';

registerSW({
  immediate: true,
  // 新 SW 可以接管后续请求，但不得在播放期间强制导航当前 PWA 窗口。
  // 当前页面继续运行已加载的版本，用户下次正常打开时再进入新 bundle。
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
