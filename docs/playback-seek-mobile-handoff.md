# 手机端拖动进度条无效 —— 排查交接文档

> 状态:**未解决**。PWA 已修好,Android 客户端仍无法拖动进度条。
> 接手前请先读完本文,尤其是「已验证的事实」和「不要重复的弯路」两节。

## 一、用户可见现象

Android 客户端(APK,`life.nineli.melodex`)拖动播放进度条:

- **拖动时**拇指会跟着走(界面层有反应)
- **松手后**从上一次的位置继续播,或从头播
- **声音从不跳到拖动目标位置**

用户的准确描述:「拖动进度是过去了,但是播放还是从 0 开始」「拖了还是不行」。

PWA(浏览器)上同类问题**已修复**,可正常拖动。

## 二、已验证的事实(带证据,可直接采信)

### 2.1 服务端 Range 完全正常

生产日志可见 206 与正确区间:

```
[GIN] 200  GET /music/download?id=...&stream=1     ← 首次无 Range
[GIN] 206  GET /music/download?id=...&stream=1     ← 后续分段
```

`[stream-range]` 诊断日志(e01d42e 起)记录到:

```
02:23:23  range=""                                    ← 首次加载
02:24:18  range="bytes=570053-"                       ← 用户第 1 次拖动
02:24:20  range="bytes=570053-"
02:24:21  range="bytes=570053-"
02:24:39  range="bytes=570053-"                       ← 用户第 2 次拖动(间隔 18 秒)
02:24:41  range="bytes=570053-"
```

**两次拖动请求的字节位置完全相同(570053)。** 若 seek 真生效,不同位置应请求不同偏移。

该歌曲:文件 `冬眠 - 司南.flac`,大小 **27,065,496 字节**,时长 **269 秒**。
570053 / 27065496 ≈ **2.1% ≈ 5.7 秒**。用户拖到的是约 2 分钟处。

### 2.2 时长认知正确

Android 系统媒体面板日志显示 `269583`(毫秒),即 269.5 秒 —— **播放器知道正确时长**。所以"duration 被压小导致换算错误"这条假设可以排除。

### 2.3 原生 `seekTo` 的日志一条都没出现

e01d42e 在 `NativePlaybackPlugin.seekTo()` 里加了:

```kotlin
Log.w(TAG, "seekTo requested=${requestedMs}ms duration=${player.duration}ms before=${player.currentPosition}ms ...")
```

APK 已重新构建并安装(`app-release.apk`,2026-11-08 02:15,签名 SHA256 `5f28d565...faa2ba78`),
`adb logcat -d -s MelodexNativePlayback` **无任何输出**。

**这是目前最硬的线索:`seekTo` 很可能根本没被调用。**

### 2.4 WebView 的 JS 资源请求在服务端日志中查不到

`capacitor.config.json` 的 `server.url` 指向 `https://music.9li.life`,
理论上 WebView 会从线上拉 JS。但服务端日志里**没有任何 `/assets/index-*.js` 请求记录**,
说明 WebView 用的是本地/磁盘缓存。

**因此:APK 里跑的 JS 是否包含最新改动,未经验证。** 这是当前最大的未知数。

## 三、已做过的修改(按时间顺序,含被推翻的)

| commit | 内容 | 结论 |
|---|---|---|
| `a44f044` | 加 `playerScrub.js` 拖动仲裁:拖动中只认拇指、seek 后压住旧位置 3 秒 | **只修表象**。把拇指按在目标位置而音频仍在原处,反而制造"条与声音不一致"。保留但非根因。 |
| `dd1374c` | 关闭多曲 MSE 拼接(`ENABLE_CONTINUOUS_MEDIA_SOURCE = false`),主路径回普通流 + Range;**PWA 由此修好** | 正确,保留 |
| `dd1374c` | `proxyProviderAudio` 的 `Accept-Ranges` 声明 | 第一版写错(拿不到分段时写 `none`),已在 `f43da3d` 修正 |
| `f43da3d` | 修正 `Accept-Ranges`:仅真拿到 206+Content-Range 才声明 `bytes` | 正确,保留 |
| `e01d42e` | 补 `[stream-range]` 诊断(区间/总长/UA)+ 原生 `seekTo` 日志 | 诊断用 |
| 未提交 | `nativePlayback.js` 新增 `resolvePlaybackDuration`,原生时长与元数据差 >10% 时用元数据 | 正确性加固,**但按 2.2 已证实时长本就正确,与本次故障无关**;含 4 条测试 |

## 四、被证伪的假设(不要重复)

1. ❌ **"MSE sequence 模式让 timestampOffset 失效"** —— 规范原文:
   `sequence` 模式下设 `timestampOffset` 正是"把分片放到时间轴指定位置"的官方手段
   ([MSE §5.1](https://w3c.github.io/media-source/#dom-appendmode-sequence))。
   注意 `abort()` 会把 `[[group start timestamp]]` 冲成 `[[group end timestamp]]`,之后旧 offset 会失效。

2. ❌ **"seek 到 buffered 外会被重置为 0"** —— 任何权威文本都不支持。
   规范是"钳到 `seekable` 最近点"或"卡在 waiting 等 append"。

3. ❌ **"这些分块 PTS 全为 0 是根因"** —— 已用 ffmpeg 实测确认 `-reset_timestamps 1` 下
   四块 `first_pts` 确实全为 0,但那是 MSE 路径的问题;关掉 MSE 后与手机端无关。

4. ❌ **"duration 被压小导致 positionMs 算错"** —— 见 2.2,时长正确。

## 五、下一步该查什么(按优先级)

### 5.1 最高优先:确认手机里跑的 JS 版本

这是唯一能解释"改了 JS 但行为不变"的原因。

```powershell
# 1. 看 APK 里打包的 web 资源(注意 server.url 存在时,webDir 可能不生效)
cd android; unzip -l app\build\outputs\apk\release\app-release.apk | Select-String "assets/public"

# 2. 用 chrome://inspect 连 WebView 看实际加载的 bundle
#    需要先在 capacitor.config.json 打开 webContentsDebuggingEnabled: true 并重打包
```

若确认是旧 bundle,修法:清 App 数据(`adb shell pm clear life.nineli.melodex`)后重装,
或检查 Capacitor 的缓存策略。

### 5.2 其次:确认拖动时 JS 是否调了 seekTo

打开 WebView 调试后,在 Console 里看拖动时:

- `onChange` 是否触发
- `NativePlayerProvider.seek()` 是否被调用
- `NativePlayback.seekTo()` 的 Promise 是否 reject(当前 `.catch` 只 `setNotice`,错误被吞)

代码位置:`frontend/src/contexts/NativePlayerProvider.js` 的 `seek`(约 L271)。

### 5.3 也要排除:进度条事件被抢

`scrubHandlers` 绑了 `onPointerDown/Up/Cancel`。
Android WebView 的触摸事件在某些机型上可能只触发 touch 系列而非 pointer 系列,
导致 `beginScrub` 一直为 true、或事件未到达 `onChange`。
检查 `frontend/src/contexts/playerScrub.js` 的 `MAX_SCRUB_DURATION_MS`(30 秒)兜底是否生效。

## 六、关键文件

| 文件 | 作用 |
|---|---|
| `frontend/src/contexts/NativePlayerProvider.js` | 手机端播放器 Provider,`seek` 在此 |
| `frontend/src/contexts/nativePlayback.js` | 快照映射 + 时长仲裁 |
| `frontend/src/contexts/playerScrub.js` | 拖动仲裁纯函数(含单测契约) |
| `android/.../NativePlaybackPlugin.kt` | Capacitor 插件,`seekTo` 在此 |
| `android/.../PlaybackService.kt` | ExoPlayer + MediaSession |
| `backend/internal/web/music_routes.go` | `/music/download`,含 `[stream-range]` 诊断日志 |

## 七、环境信息(已踩过的坑)

- **构建必须用 JDK 21**。`JAVA_HOME` 在本机指向 17,直接跑会报「无效的源发行版: 21」。
  ```powershell
  $env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-21.0.11.10-hotspot"
  ```
- **签名不用手动配**。仓库自带 `android/scripts/verify-local-release.ps1`,
  凭据是 Windows DPAPI 加密的,位于 `我的文档\Melodex\AndroidRelease\`
  (`melodex-release.jks` / `credentials.dpapi` / `certificate.txt`)。
  ```powershell
  cd android
  .\scripts\verify-local-release.ps1 -Tag v0.2.1-rc.5 -JavaHome $env:JAVA_HOME
  ```
  若 `:app:clean FAILED`(文件被占用),先 `.\gradlew.bat --stop`。
- **本机有两台设备**:`3B656W00MPC00000`(真机 PKG110)与 `emulator-5554`。装真机要加 `-s`。
- **不要读 `.env`**,含真实凭据。生产在 NAS `192.168.1.99`,容器名 `melodex`。
- 生产日志里 `broken pipe` 是拖动中断旧请求的正常现象,不是错误。

## 八、当前生产状态

- 生产镜像: `ghcr.io/aki-riko/melodex:edge`,已含 `e01d42e` 的诊断日志
- PWA: 拖动正常
- Android: **仍不正常**,已装 2026-11-08 02:15 构建的 rc.5 包
