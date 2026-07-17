// 新 Service Worker 激活后，强制现有 PWA 窗口重新导航一次。
// skipWaiting/clientsClaim 只能接管后续请求，无法替换页面内存里已经执行的旧 JS；
// navigate 才能保证播放器实际运行当前部署的 bundle。activate 每个 SW 只触发一次，
// 因此不会形成刷新循环。
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    windows.forEach((client) => {
      const url = new URL(client.url);
      if (url.origin !== self.location.origin) return;
      // 不等待 navigate Promise：导航可能等待新 SW 完成 activate，若纳入 waitUntil
      // 会形成“激活等导航、导航等激活”的互锁。
      try {
        const pending = client.navigate(client.url);
        pending?.catch?.(() => undefined);
      } catch {
        // 单个已关闭窗口不能阻断其他 PWA 窗口升级。
      }
    });
  })());
});
