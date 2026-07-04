# PWA 离线音频缓存计划

## 背景

Melodex 现在的主力使用方式已经是 PWA Web 前端。当前「下载」按钮语义是下载到 NAS: 前端调用 `saveToServer(song)`, 后端写入容器 `data/downloads`, 并登记 `DownloadRecord`, 这样本地音乐库可见。

本计划讨论的是另一条能力: **把歌曲缓存到当前浏览器/PWA 的站点存储中, 断网后仍可在 Melodex 内播放**。它更接近原生音乐 App 的「离线听」, 但不等同于写入系统音乐目录或 NAS 本地库。

## 当前链路

- PWA 配置位于 `frontend/vite.config.js`。
  - 预缓存只包含 `js/css/html/png/svg/ico`。
  - `/api`、`/music` 被 `navigateFallbackDenylist` 排除。
  - runtime cache 只对图片使用 `CacheFirst`。
- 播放器位于 `frontend/src/contexts/PlayerContext.js`。
  - 当前播放统一使用 `audio.src = getStreamUrl(song)`。
  - `getStreamUrl(song)` 指向 `/music/download?...&stream=1`。
- 完整音频下载能力已有:
  - `getDownloadUrl(song)` 指向 `/music/download?...&embed=1`。
  - 后端 `downloadHandler` 的 `embedMeta` 分支会调用 `core.DownloadSongDataWithTemplate`, 返回带元数据/封面的完整音频。
- 离线冷启动存在现有阻塞:
  - `AuthContext` 启动会请求 `/api/v1/me`。
  - 网络错误时当前会设置 `authenticated:false`, 进而显示 `AuthGate`。
  - 所以只缓存音频还不够, 还要允许「最近登录用户」进入离线模式。

## 目标

1. 用户可以对单曲执行「缓存到本机/PWA」。
2. 用户可以对当前歌单执行「全部缓存到本机/PWA」。
3. 已缓存歌曲在断网状态下可播放、可暂停、可 seek、可切下一首。
4. 播放器优先使用本机缓存, 未缓存时再走在线流。
5. 提供「离线音乐」视图, 可查看、播放、删除已缓存歌曲。
6. 显示缓存占用、浏览器配额估算和持久化存储状态。
7. 多用户共用同一设备时, 离线缓存索引按 Melodex `userId` 隔离。

## 非目标

- 不把 PWA 缓存伪装成 NAS 下载。
- 不把缓存歌曲登记为后端 `DownloadRecord`。
- 不保证缓存永不丢失; 用户清站点数据、卸载 PWA、浏览器空间回收策略都可能删除缓存。
- 第一阶段不做后台下载保证。浏览器后台下载能力跨平台差, 先按前台任务处理。
- 第一阶段不切换到自定义 Service Worker 的 Range 响应方案。

## 推荐方案

### 第一阶段: IndexedDB Blob MVP

使用 IndexedDB 保存完整音频 Blob 与索引元数据。播放时如果命中缓存, 通过 `URL.createObjectURL(blob)` 给 `<audio>` 播放; 否则继续使用现有 `getStreamUrl(song)` 在线播放。

选择理由:

- 不需要改后端主链路。
- 不需要第一版处理 Service Worker Range 请求。
- 能快速验证「离线听」的产品闭环。
- 失败面集中在前端, 回滚简单。

建议新增模块:

- `frontend/src/services/offlineAudio.js`
  - `cacheSong(song, { onProgress })`
  - `getCachedSong(song, userId)`
  - `isSongCached(song, userId)`
  - `listCachedSongs(userId)`
  - `deleteCachedSong(song, userId)`
  - `deleteAllCachedSongs(userId)`
  - `getStorageEstimate()`
  - `requestPersistentStorage()`
- IndexedDB 数据库: `melodex-offline-audio`
  - object store `tracks`
  - key: `${userId}:${source}:${id}:${extraHash}`

建议索引字段:

```js
{
  key,
  userId,
  source,
  id,
  extraHash,
  name,
  artist,
  album,
  cover,
  duration,
  size,
  mime,
  filename,
  cachedAt,
  lastPlayedAt,
  blob
}
```

注意: `extra` 可能影响真实下载地址, key 里需要包含稳定 hash, 不能只用 `source + id`。

### 第二阶段: 自定义 Service Worker + Range

当第一阶段确认好产品体验后, 再考虑切到 `vite-plugin-pwa` 的 `injectManifest`, 增加自定义 Service Worker。

用途:

- 用 Cache API 或 IndexedDB 响应 `/offline-audio/:key`。
- 对 `Range` 请求返回正确 `206 Partial Content`。
- 改善大文件 seek、媒体恢复和浏览器音频加载行为。

这一步比 MVP 更复杂, 不建议第一阶段直接做。

### 第三阶段: OPFS/文件式存储

如果后续离线库规模很大, 可以评估 Origin Private File System。

用途:

- 更接近文件式管理。
- 适合分片写入、断点续存和更大的本地库。

代价:

- 兼容性和实现复杂度更高。
- 移动端必须真机验证。

## 关键坑点

### 1. 不要直接给音频套 Workbox CacheFirst

音频播放经常使用 Range 请求。普通 `CacheFirst` 容易出现:

- 缓存到部分响应。
- seek 后无法正确返回 `206`。
- 同一 URL 的完整响应和 Range 响应混杂。
- 播放器在不同浏览器里表现不一致。

第一阶段用完整 Blob 播放, 可以绕开这个坑。

### 2. 离线冷启动不能卡在登录页

当前 `/api/v1/me` 网络失败会进入 `AuthGate`。离线缓存要可用, 必须增加:

- 最近登录用户快照, 存 localStorage 或 IndexedDB。
- `AuthContext` 网络失败时, 如果存在最近登录用户, 进入 `offline:true` 状态。
- 离线状态下隐藏或禁用依赖在线接口的页面操作。
- 仍然不能伪造管理员权限调用后端接口; 离线模式只允许本地缓存播放。

### 3. 浏览器存储不是硬盘承诺

需要接入:

- `navigator.storage.estimate()` 显示使用量与 quota。
- `navigator.storage.persisted()` 显示是否已持久化。
- `navigator.storage.persist()` 请求持久化。

UI 文案必须清楚: PWA 缓存会尽量保留, 但用户清站点数据或卸载 PWA 会删除。

### 4. 后端 `embed=1` 可能没有精确下载进度

`/music/download?embed=1` 会先下载并处理完整音频, 再返回响应。前端 fetch 的进度条可能在服务端处理阶段没有数据。

第一版 UI 应显示:

- `准备中`
- `缓存中`
- `已缓存`
- `失败, 可重试`

不要承诺百分比一定准确。

### 5. 多用户隔离

同一浏览器可能切换 Melodex 用户。缓存索引必须带 `userId`。

建议:

- 当前用户只能看到自己的缓存索引。
- 登出不自动删除缓存。
- 提供「清除此账号离线缓存」。
- 管理员也不应默认看到其他账号的 PWA 缓存, 因为这是本设备本地数据。

### 6. Object URL 生命周期

播放器使用 `URL.createObjectURL(blob)` 后需要在切歌或卸载时 `URL.revokeObjectURL(url)`。

否则长时间播放大量歌曲可能泄漏内存。

### 7. 离线歌词和封面

第一阶段至少缓存歌曲元数据和音频。封面可以先沿用已有图片缓存, 但断网时不一定可靠。

更稳妥的做法:

- 缓存时同时保存 cover URL。
- 后续阶段把 cover blob、歌词文本也写入 IndexedDB。
- 播放器 MediaSession artwork 离线时优先使用缓存封面 Object URL。

## UI 计划

### SongRow

新增或调整按钮语义:

- 下载到 NAS: 服务器落盘, 本地音乐库可见。
- 缓存到本机: PWA 离线缓存, 仅当前设备可用。

按钮状态:

- 未缓存
- 准备中
- 缓存中
- 已缓存
- 失败重试

### MyPlaylist

新增:

- 全部缓存到本机
- 进度: `已完成/失败/总数`
- 跳过已缓存歌曲

保留:

- 全部下载到 NAS

### Sidebar

新增入口:

- 离线音乐

### OfflineMusic 页面

展示:

- 已缓存歌曲列表
- 总占用空间
- 浏览器估算 quota
- 持久化状态
- 删除单曲
- 清空当前账号缓存

断网状态下:

- 该页面应仍可打开。
- 歌曲应可播放。

## 实施步骤

### Step 1: 离线存储服务

预期效果: 可以缓存、读取、删除单曲 Blob。
实施难度: 0.5-1 天。
风险等级: 中。

任务:

1. 新增 `offlineAudio.js`。
2. 实现 IndexedDB 打开、迁移、CRUD。
3. 用 `getDownloadUrl(song)` fetch 完整音频。
4. 记录 Blob、元数据、文件大小、缓存时间。
5. 接入 `navigator.storage.estimate/persisted/persist`。

验证:

- 缓存真实歌曲。
- 刷新页面后仍能列出缓存。
- 删除后缓存消失。
- DevTools Application 中可见 IndexedDB 数据。

### Step 2: 播放器本地优先

预期效果: 已缓存歌曲断网可播。
实施难度: 0.5 天。
风险等级: 中。

任务:

1. `PlayerContext` 播放前查询 offline cache。
2. 命中时使用 Object URL。
3. 未命中时走 `getStreamUrl(song)`。
4. 切歌时 revoke 旧 Object URL。
5. 恢复播放时也走本地优先。

验证:

- 在线播放已缓存歌曲时不请求 `/music/download?stream=1`。
- 断网后已缓存歌曲可播放。
- seek 可用。
- 下一首/上一首可用。

### Step 3: 离线登录降级

预期效果: 断网冷启动能进入离线音乐。
实施难度: 0.5 天。
风险等级: 高。

任务:

1. 登录成功后保存 last-known-user 快照。
2. `/api/v1/me` 网络错误时, 如果存在快照, 设置 `offline:true` 和 `authenticated:true`。
3. UI 显示离线状态。
4. 离线状态下禁用需要后端写入的操作。

验证:

- 完全断网后从新标签打开 PWA。
- 不进入 AuthGate。
- 可进入离线音乐并播放。
- 在线恢复后重新校验 `/api/v1/me`。

### Step 4: UI 接入

预期效果: 用户能从歌曲行、歌单详情、离线音乐页完成常用操作。
实施难度: 1 天。
风险等级: 中。

任务:

1. SongRow 增加「缓存到本机」状态按钮。
2. MyPlaylist 增加「全部缓存到本机」。
3. Sidebar 增加「离线音乐」入口。
4. 新增 OfflineMusic 页面。
5. 增加容量、持久化状态、删除缓存操作。

验证:

- 单曲缓存状态显示正确。
- 歌单批量缓存跳过已缓存歌曲。
- 删除缓存后播放器回退到在线流。
- 移动端按钮不挤压、不误触。

### Step 5: 真机验证

预期效果: 明确浏览器差异, 决定是否进入第二阶段。
实施难度: 0.5-1 天。
风险等级: 高。

必须验证:

1. Windows Chrome/Edge PWA。
2. Android Chrome PWA。
3. iOS Safari / 添加到主屏幕后 PWA。

场景:

- 在线缓存真实歌曲。
- 刷新后播放。
- 完全断网冷启动。
- seek 到中段。
- 锁屏/后台后恢复。
- 播放队列下一首。
- 清理缓存。
- 存储空间不足或模拟 quota error。

## 后续增强判断点

进入第二阶段的触发条件:

- Blob Object URL 播放大文件 seek 不稳定。
- iOS/Android PWA 后台恢复频繁失败。
- 离线库数量变大后内存压力明显。
- 需要更像原生的流式读取和 Range 支持。

第二阶段再做:

- `vite-plugin-pwa` 切 `strategies:'injectManifest'`。
- 自定义 SW。
- 离线音频专用 route。
- Range 请求返回 `206 Partial Content`。
- 可能引入 Workbox RangeRequestsPlugin。

## 验收标准

MVP 完成的最低验收:

- 至少 3 首真实歌曲可缓存。
- 刷新页面后缓存仍存在。
- 断网冷启动可进入离线音乐。
- 断网可播放已缓存歌曲。
- 播放器进度、暂停、seek、下一首正常。
- 未缓存歌曲断网时给出明确不可播放提示。
- 能查看缓存占用。
- 能删除单曲缓存。
- `npm.cmd run build` 通过。
- `git diff --check` 通过。

## 不建议的实现

- 不建议直接把 `/music/download?stream=1` 加到 Workbox `CacheFirst`。
- 不建议把 PWA 缓存状态和 NAS 下载状态混用。
- 不建议第一版引入后台下载 API, 兼容性不足。
- 不建议把离线缓存写入 localStorage, 容量和性能都不适合音频。
- 不建议未带 `userId` 做全局缓存列表。
