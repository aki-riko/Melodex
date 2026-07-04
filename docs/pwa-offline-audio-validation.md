# PWA 离线音频缓存验收报告

日期: 2026-07-04

## 验收环境

- 本机浏览器: Thorium, `C:\Users\Kotori\AppData\Local\Thorium\Application\thorium.exe`
- 前端: Vite preview, `http://127.0.0.1:4173`
- 后端: `music-dl web --desktop --port 8330 --no-browser`, `http://127.0.0.1:8330`
- 用户: desktop local admin, `user.id=1`
- 浏览器数据: 独立临时 profile, 不污染用户日常 Thorium profile

## 已通过项目

### Windows / Thorium PWA

状态: 已通过。

真实缓存样本:

| 关键词 | 缓存歌曲 | 来源 | ID | 大小 | MIME | 封面 |
|---|---|---|---|---:|---|---|
| 周杰伦 晴天 | 晴天 (女声独唱版) / 梅菜扣肉肉 | QQ | `001LcPEv1TEenh` | 4,315,106 | `audio/mpeg` | 有 |
| 陈奕迅 十年 | 十年 / 陈奕迅-、MissGoog | 网易云 | `3391056680` | 7,411,235 | `audio/mpeg` | 有 |
| 孙燕姿 遇见 | 遇见 / Sazablue、孙燕姿. | 网易云 | `3328597961` | 8,868,968 | `audio/mpeg` | 有 |

通过断言:

- Service Worker `ready=true`, `controller=true`, scope 为 `http://127.0.0.1:4173/`。
- `/api/v1/me` 在线返回 desktop 用户, `melodex_last_known_user` 已写入。
- IndexedDB `melodex-offline-audio.tracks` 写入 3 条, `userId=1`, 音频 Blob 非空, 封面 Blob 非空。
- 在线刷新 `#offline` 后仍显示 3 首, 页面展示 `3 首 · 音频 19.6MB`。
- 断网新开 `#download` 时, App 自动进入离线音乐页, 不进入登录页。
- 离线冷启动只出现预期的 `/api/v1/me` 网络失败探针;未请求 `/music/download`、`/music/cover_proxy`、`/music/collections`、`/music/favorites` 或 Google Fonts。
- 离线播放使用 `blob:http://127.0.0.1:4173/...`, `audio.currentTime > 0`。
- 播放/暂停按钮可暂停。
- seek 后 `audio.currentTime` 接近目标值。
- 下一首按钮会切到新的 Blob URL。
- 删除单曲缓存后 IndexedDB 从 3 条变 2 条, 目标歌曲不再显示。
- 清空缓存后 IndexedDB 为 0 条, 离线页显示空状态。
- 恢复在线并触发 `online` 事件后, 观察到 `/api/v1/me` 被重新请求, 离线横幅消失, 页面回到 `#download` 在线权限态。

存储状态:

- `navigator.storage.estimate()` 返回使用量约 24.0MB, quota 约 936.9GB。
- `navigator.storage.persisted()` 当前为 `false`。
- 离线音乐页已显示容量与持久保存按钮。

### 在线恢复补丁

状态: 已通过。

`frontend/src/contexts/AuthContext.js` 新增 `window.online` 监听后, 断网冷启动进入 `offline:true`;恢复网络时会主动调用 `refresh()` 重新校验 `/api/v1/me`。Thorium 验收中观测到 3 次 `/api/v1/me` 请求, UI 从离线模式回到在线 `#download`。

### Android / Thorium PWA

状态: 已通过。

设备与浏览器:

- 设备: vivo `V2425A`
- Android: 15
- 包名: `org.chromium.thorium`
- 内核: `Chrome/138.0.7204.303`
- User-Agent: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36`

验收方式:

- PC 启动临时 desktop 后端 `http://127.0.0.1:8330`。
- PC 启动 Vite preview `http://127.0.0.1:4173`, 构建时 `VITE_MUSICDL_API=http://127.0.0.1:8330`。
- Android 通过 `adb reverse tcp:4173 tcp:4173` 和 `adb reverse tcp:8330 tcp:8330` 访问本地服务。
- Thorium DevTools 通过 `adb forward tcp:9222 localabstract:chrome_devtools_remote` 接入。

真实缓存样本:

| 关键词 | 缓存歌曲 | 来源 | ID | 大小 | MIME | 封面 |
|---|---|---|---|---:|---|---|
| 周杰伦 晴天 | 晴天 (女声独唱版) / 梅菜扣肉肉 | QQ | `001LcPEv1TEenh` | 4,315,106 | `audio/mpeg` | 有 |
| 陈奕迅 十年 | 十年 原唱. 陈奕迅 / BeatzHummer | 网易云 | `1467536356` | 8,374,034 | `audio/mpeg` | 有 |
| 孙燕姿 遇见 | 遇见 / Sazablue、孙燕姿. | 网易云 | `3328597961` | 8,868,968 | `audio/mpeg` | 有 |

通过断言:

- Android Thorium Service Worker `ready=true`, `controller=true`。
- `/api/v1/me` 经 `adb reverse` 返回 desktop 用户 `user.id=1`。
- IndexedDB `melodex-offline-audio.tracks` 写入 3 条, `userId=1`, 音频 Blob 非空。
- 在线刷新 `#offline` 后仍显示 3 首, 页面展示 `3 首 · 音频 20.6MB`。
- CDP 离线模式下新开 `#download` 自动进入离线音乐页, 只出现预期的 `/api/v1/me` 失败;未请求 `/music/download`、`/music/cover_proxy`、`/music/collections`、`/music/favorites` 或 Google Fonts。
- CDP 离线模式下已缓存歌曲使用 `blob:http://127.0.0.1:4173/...` 播放, `audio.currentTime > 0`。
- 手机移动端播放器可暂停, seek 后 `audio.currentTime` 接近目标值。
- 移动端迷你播放器展开全屏后, 下一首按钮会切到新的 Blob URL。
- 删除单曲缓存后 IndexedDB 从 3 条变 2 条。
- 清空缓存后 IndexedDB 为 0 条, 离线页显示空状态。
- 恢复 `adb reverse` 并触发 `online` 事件后, 观察到 `/api/v1/me` 被重新请求, 离线横幅消失, 页面回到在线 `#download`。

更接近真实断网的冷启动补充:

- 移除 `adb reverse tcp:4173` 和 `adb reverse tcp:8330` 后, 手机端已无法访问本地前后端服务。
- 强制停止并重启 `org.chromium.thorium`, 打开 `http://127.0.0.1:4173/#download`。
- Service Worker 仍接管导航, 页面进入离线模式并显示 3 首缓存歌曲。
- 在 reverse 为空的状态下, 真实点击播放按钮后音频仍使用 Blob URL, 且 `audio.currentTime > 0`。

存储状态:

- Android `navigator.storage.estimate()` 返回使用量约 24.7MB-54.3MB, quota 约 276.1GB。
- `navigator.storage.persisted()` 当前为 `false`。

## 部分验证 / 未完成项目

### Android Chrome PWA

状态: 不再单独阻塞。

本机没有 Google Chrome for Android, 但已用 Android Thorium 完成 Chromium 内核 PWA 验收。Chrome 专名验收仍未做, 但当前目标设备的 Chromium PWA 主链路已覆盖。

### iOS Safari / 主屏幕 PWA

状态: 阻塞。

本机未发现 iOS 调试工具:

- `idevice_id.exe`: 未找到
- `ios_webkit_debug_proxy.exe`: 未找到

需要 iPhone/iPad 真机继续验证:

- Safari 添加到主屏幕。
- 离线冷启动。
- 后台恢复与系统媒体控制。
- iOS 存储回收行为。

### quota / 存储空间不足

状态: 未完成。

已确认容量估算与持久化状态可见, 但没有完成稳定的 quota error UI 自动验收。尝试通过 monkey patch `IDBObjectStore.prototype.put` 抛 `QuotaExceededError`, 并对缓存下载响应做 fulfill, 但 Playwright/Thorium 会话未稳定进入 UI 的「缓存失败」状态, 因此不计为通过。

源码层面已具备失败路径:

- `cacheSong()` 的 IndexedDB 写入异常会 reject。
- `SongRow` 捕获异常后进入 `cacheState='fail'`。
- `MyPlaylist` 批量缓存会把异常计入失败数。

后续建议单独补一个可控的前端测试 seam, 例如给 `offlineAudio` 暴露测试注入点或用 Vitest/jsdom/fake-indexeddb 覆盖 quota reject 分支。

## 当前结论

PWA 离线音频缓存 MVP 在 Windows/Thorium 上的主链路已经可用:真实歌曲可缓存、刷新后持久、断网冷启动可进入离线音乐、播放器可离线播放与切歌、删除和清空可用、在线恢复会重新校验登录态。

仍不应宣称移动端完成, Android/iOS 必须等真机和调试工具到位后再验收。
