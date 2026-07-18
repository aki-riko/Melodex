// 新页面会响应升级握手，并自行等到播放器 pause/ended 后安全重载。
// 旧页面没有握手能力；如果不迁移，它即使拿到新 SW 也会一直执行内存中的旧 JS。
const SW_UPDATE_QUERY = 'melodex:sw-update-query';
const SW_UPDATE_RESPONSE = 'melodex:sw-update-capable';
const SW_UPDATE_PROTOCOL = 1;
const CLIENT_HANDSHAKE_TIMEOUT_MS = 1200;
const updatingExistingWorker = Boolean(self.registration.active);

const queryUpdateCapability = (client) => new Promise((resolve) => {
  const channel = new MessageChannel();
  let settled = false;
  const finish = (capable) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutID);
    channel.port1.close?.();
    resolve(capable);
  };
  const timeoutID = setTimeout(() => finish(false), CLIENT_HANDSHAKE_TIMEOUT_MS);
  channel.port1.onmessage = (event) => {
    finish(
      event.data?.type === SW_UPDATE_RESPONSE
      && Number(event.data?.protocol) >= SW_UPDATE_PROTOCOL,
    );
  };
  try {
    client.postMessage({ type: SW_UPDATE_QUERY }, [channel.port2]);
  } catch {
    finish(false);
  }
});

const navigateLegacyClient = (client) => {
  try {
    const pending = client.navigate(client.url);
    pending?.catch?.(() => undefined);
  } catch {
    // 已关闭的单个窗口不能阻断其他 PWA 窗口升级。
  }
};

self.addEventListener('activate', (event) => {
  if (!updatingExistingWorker) return;
  event.waitUntil((async () => {
    await self.clients.claim();
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await Promise.all(windows.map(async (client) => {
      const url = new URL(client.url);
      if (url.origin !== self.location.origin) return;
      const supportsSafeReload = await queryUpdateCapability(client);
      if (!supportsSafeReload) navigateLegacyClient(client);
    }));
  })());
});
