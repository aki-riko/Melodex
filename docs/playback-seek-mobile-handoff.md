# 手机端拖动进度条无效 —— 排查交接文档

> 状态:**根因已定位并修复,待真机验证**。
> 前两版的核心推论**都错了**(见 §2 与 §4),本版基于可复现证据重写。
> 接手前读完 §1 和 §2 即可,不要沿用旧结论。

## 一、一句话根因

**Capacitor 的 `PluginCall.getLong()` 只接受 `instanceof Long`,其它数值类型一律静默返回默认值。**
JS 传过来的 `positionMs` 在桥接层常被解析成 `Integer` 或 `Double`,于是
`call.getLong("positionMs", 0L)` 恒得 **0** → `player.seekTo(0)` → **每次拖动都回到开头**。

用户原话「拖动进度是过去了,但是播放还是从 **0** 开始」是**字面意义上的准确**。

## 二、证据链(每一条都可复现)

### 2.1 Capacitor 的类型陷阱(直接根因)

`node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/PluginCall.java:196-206`:

```java
public Long getLong(String name, @Nullable Long defaultValue) {
    Object value = this.data.opt(name);
    if (value == null) return defaultValue;
    if (value instanceof Long) return (Long) value;
    return defaultValue;          // ← Integer / Double / String 全部落到这里
}
```

对比同文件的 `getDouble`(237-254)与 `getFloat`(213-230):它们都做了
`instanceof Double / Float / Integer` 的多路兼容。**只有 `getInt`/`getLong` 是类型敏感的。**

实测复刻该逻辑(本机 Go,与 Java 语义等价):

```
JSON 小整数 (常解析成 Integer)   -> positionMs=0        ← 坏
JSON 长整型                      -> positionMs=120000   ← 好
JSON 浮点 (带小数或 .0)          -> positionMs=0        ← 坏
JSON 字符串                      -> positionMs=0        ← 坏
```

### 2.2 这个根因能解释**每一个**观察到的现象

| 观察 | 解释 |
|---|---|
| 用户看到进度条拇指跟手 | `seek()` 里 `setProgress` 是纯 JS,不受影响 |
| 松手后从 0 播 / 从头播 | `seekTo(0)` 就是真的 0 |
| 服务端只收到 `bytes=570053-` | 见 2.3,570053 = 第一个音频帧 = 时间 0 |
| 两条不同时间的拖动偏移完全相同 | 因为目标**恒为 0**,不是"两次拖到同一处" |
| `.catch` 没抓到错误 | `seekTo` 成功返回了,只是参数是 0 —— 不报错 |
| PWA 正常 | Web 走 `audio.currentTime = target`,没有桥接层 |

### 2.3 「570053」的真实含义(纠正旧文档最误导的一条)

旧文档写:`570053 / 27065496 ≈ 2.1% ≈ 5.7 秒`。**错。**

该 FLAC 逐块解析(本机 node 独立复算 + `verifier` 用 `ffprobe`/整片解码交叉验证):

| FLAC 元数据块 | 长度 | 起止偏移 |
|---|---|---|
| `fLaC` 魔数 | 4 | 0 – 4 |
| STREAMINFO (type 0) | 34 | 4 – 42 |
| **PICTURE (type 6, 内嵌 JPEG 封面)** | **561,690** | 42 – 561,736 |
| VORBIS_COMMENT (type 4) | 117 | 561,736 – 561,857 |
| PADDING (type 1, last) | 8,192 | 561,857 – **570,053** |
| **第一个音频帧 `FF F8`** | — | **570,053** |

`570053` 处字节 = `FF F8 A9 18`,是合法 FLAC 帧头。**决定性佐证**:把
`fLaC + STREAMINFO(last=1) + bytes[570053:]` 重组成裸帧文件整片解码,
PCM md5 与原文件整片解码**逐字节相同** → 570053 就是第 0 帧。

所以 `Range: bytes=570053-` 在播放器语义下 = **offset 0 = 时间轴 0 秒**。
旧文档把 621KB 的封面当成了音频来按比例换算,才得出"5.7 秒"。

> 附带纠正:`12047707`(拖到 2 分钟)只是线性估算,`verifier` 实测该时刻包偏移
> 是 **11,169,339**(线性低估 7.3%)。5.7 秒实测是 **855,521** —— 与 570053 差 30 万字节,
> 根本不是同一位置。

### 2.4 服务端与 ExoPlayer 都不是根因(已排除,有反证)

- **`Content-Disposition: attachment` 不是原因**。本鱼实测 `http.ServeContent`:
  加不加该头,`206` + `Content-Range` + `Accept-Ranges` 行为**完全一致**。
- **media3 压根不读这两个头**。`stream-auditor` 解包了 media3 1.11.1 全部 4 个 aar,
  扫描所有 class 字符串常量:`Content-Disposition` / `Accept-Ranges` **零引用**。
  ExoPlayer 的 seek 能力只取自容器内解析出的 `SeekMap`。
- **能产生 570053 这种 Range 恰恰证明 ExoPlayer 认为该曲可 seek**
  (若 `Unseekable`,请求会是 `0`/无 Range,与观测不符)。
- 服务端 Range 支持本身正常(日志可见 206 与正确区间,`broken pipe` 属拖动中断的正常现象)。

### 2.5 「seekTo 日志一条都没有」不能用来说明 seekTo 没被调用

旧文档由此推出"JS 没发 seekTo"。两条硬伤:

1. `adb logcat -d` 只 dump 当前环形缓冲区,长会话早先日志会被滚掉;
2. 项目有**两个 TAG**:插件 `MelodexNativePlayback`、服务(`PlaybackService`)

而且事实上 **seekTo 是被调用的** —— 它只是拿到了 0。这也是为什么必须换成
`/music/playback_diagnostics` 落服务端日志(本轮已接上,见 §5)。

### 2.6 「APK 跑的是旧 JS」已排除

`app-release.apk` 的 `assets/public/` 只有 `cordova.js`(0B)、`cordova_plugins.js`(0B)、
`index.html`(731B),**无任何 JS 产物** → WebView 必然从 `server.url` 拉线上资源。
线上 `index-DGVHLqwT.js` 中可查到 `seekTarget`/`seekDeadline`/`dragStartedAt`/`dragging`
与 `armSeekTarget`/`seekTo` 调用,a44f044 的仲裁确实在线上。

> 核查坑:用 `Select-String` 搜 minified bundle 会**假阴性**(实测连 `seekTo` 都报 0 次)。
> 用 `[regex]::Matches($text, [regex]::Escape($k)).Count`。

## 三、本轮修复(未提交)

### 3.1 核心修复:替换类型敏感的 `getLong`

- `android/.../NativePlaybackModels.kt` 新增:
  - `coerceToLongMs(value: Any?): Long?` —— 兼容 `Long/Int/Short/Byte/Double/Float/Number/String`,
    非有限值与非法值返回 `null`(可与"明确的 0"区分);
  - `readMillisOption(raw: Any?, fallback: Long): Long` —— 钳到非负。
- `NativePlaybackPlugin.kt` 的 3 处 `getLong` 全部改为 `readMillisOption(call.data.opt(...))`:
  - `seekTo` 的 `positionMs` ← **本次故障点**
  - `setQueue` 的 `positionMs`(恢复上次进度,同样会静默变 0)
  - `setSleepTimer` 的 `deadlineMs`(同源风险,一并消除)

### 3.2 取证(让下次不必再猜)

- Kotlin `seekTo`:`call.resolve()` 额外带出
  `seekRequestedMs / seekAppliedMs / seekDurationMs / seekPositionMs / seekable / seekRawType / mediaItemType`,
  并各自打 `Log.w`。**`seekRawType` 直接记录桥接层给的 Java 类型**,
  将来 Capacitor 若改实现,这一项会立刻暴露差异。
- Kotlin `stateObject()`:每次 500ms 上报都带 `seekable`(不必等用户拖)。
- JS `nativePlayback.js` 新增 `nativeSeekDiagnostic()`:整理原生返回,`seekable` 三态处理
  (未知留空,不伪造 `false`)。
- JS `NativePlayerProvider.seek`:`seekTo` 成功后上报 `event: 'seek_requested'`。
- 后端 `playback_diagnostics.go`:白名单加 `seek_requested`/`seek_settled`,
  新增 6 个字段(`seek_requested_ms`/`seek_applied_ms`/`seek_duration_ms`/`seek_position_ms`/
  `seekable`/`media_item_type`)并打进日志。

### 3.3 门禁

| 门禁 | 结果 |
|---|---|
| `gradlew :app:testDebugUnitTest` | **17 tests, 0 failures**(新增 4 条锁死数值换算) |
| `npm run test:player` | **11/11 passed** |
| `go build ./...` | 通过 |
| `go test ./internal/web/ ./core/` | 通过 |

新增测试的关键用例:
- `millisOptionAcceptsEveryNumericShapeTheBridgeMaySend` —— Int/Long/Double/String/Float/Short/Byte 全覆盖
- `millisOptionFallsBackOnlyWhenValueIsTrulyUnusable` —— 明确区分"缺失"与"0"
- `millisOptionRejectsNonFiniteAndNegativeValues` —— NaN/Infinity/负数
- `coerceToLongMsDistinguishesMissingFromZero`
- 前端 `nativePlayback.test.mjs` 增加源码契约:必须真调 `reportPlaybackDiagnostic`、
  后端白名单必须放行 `seek_requested`

## 四、已证伪的假设(不要重复)

1. ❌ **"570053 ≈ 5.7 秒,所以 seek 差 20 倍"** —— 见 §2.3。把元数据区当音频算了。
2. ❌ **"seekTo 没被调用"** —— 被调用了,参数是 0。见 §2.5。
3. ❌ **"手机跑的是旧 bundle"** —— 见 §2.6。
4. ❌ **"`Content-Disposition: attachment` 让 ExoPlayer 判不可 seek"** —— 见 §2.4,
   ServeContent 行为不变,且 media3 零引用该头。
5. ❌ **"服务端 `Accept-Ranges` / 响应头导致 seek 退化"** —— 同上,两条发流路径对 seek 关键头等价。
6. ❌ **"MSE sequence 模式让 timestampOffset 失效"** —— 规范原文:`sequence` 模式下设
   `timestampOffset` 正是把分片放到时间轴指定位置的官方手段
   ([MSE §5.1](https://w3c.github.io/media-source/#dom-appendmode-sequence))。
7. ❌ **"seek 到 buffered 外会被重置为 0"** —— 无权威依据;规范是钳到 `seekable` 最近点。
8. ❌ **"分块 PTS 全为 0 是根因"** —— 那是 MSE 路径问题,关掉 MSE 后与手机端无关。
9. ❌ **"duration 被压小导致 positionMs 算错"** —— 媒体面板 269583ms 与 ffprobe 269.583220 一致。

## 五、验证步骤(需要真机)

```powershell
# 1. 构建并签名安装(必须 JDK 21)
cd android
$env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-21.0.11.10-hotspot"
.\scripts\verify-local-release.ps1 -Tag v0.2.1-rc.6 -JavaHome $env:JAVA_HOME

# 2. 后端也要更新(诊断字段新增),否则 seek 字段被丢弃
#    生产走 GHCR:打 tag 触发 docker-publish.yml,或本地构建部署

# 3. 手机上拖到约 2 分钟,然后看服务端日志
ssh root@192.168.1.99 "docker logs melodex --since 5m 2>&1 | grep -E 'seek_req_ms|stream-range'"
```

**验收标准**:
- `seek_req_ms` ≈ 120000(不再是 0);
- 紧随其后的 `[stream-range]` 偏移落在**中段**(约 1.1e7 量级),**不再是恒定的 570053**;
- 耳朵听到从拖动位置继续。

**若仍有问题**,按 `seekRawType` / `seekable` / `seek_applied_ms` 三项判读:
- `seekRawType` 仍是意外类型 → 桥接层还有别的路径没覆盖;
- `seekable=false` → 才轮到查 FLAC seektable(`metaflac --list | grep -A2 SEEKTABLE`);
- `seek_applied_ms≈0` 而 `seek_req_ms=120000` → ExoPlayer 钳位,查该曲 seektable/容器。

## 六、关键文件

| 文件 | 作用 |
|---|---|
| `android/.../NativePlaybackModels.kt` | **`coerceToLongMs` / `readMillisOption`(本次修复核心)** |
| `android/.../NativePlaybackPlugin.kt` | Capacitor 插件,`seekTo` 与取证字段 |
| `android/.../PlaybackService.kt` | ExoPlayer + MediaSession(TAG `MelodexPlayback`) |
| `frontend/src/contexts/NativePlayerProvider.js` | 手机端 Provider,`seek` 在此 |
| `frontend/src/contexts/nativePlayback.js` | 快照映射 + 时长仲裁 + `nativeSeekDiagnostic` |
| `frontend/src/contexts/playerScrub.js` | 拖动仲裁纯函数 |
| `backend/internal/web/playback_diagnostics.go` | 诊断通道(事件白名单 + 字段) |
| `backend/internal/web/music_routes.go` | `/music/download`,含 `[stream-range]` 日志 |
| `backend/internal/web/local_media_files.go` | `serveLocalMusicDownload`(副本路径发流) |

## 七、环境信息(已踩过的坑)

- **构建必须用 JDK 21**。`JAVA_HOME` 本机指向 17,直接跑报「无效的源发行版: 21」。
  ```powershell
  $env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-21.0.11.10-hotspot"
  ```
- **签名不用手动配**:`android/scripts/verify-local-release.ps1`,凭据经 Windows DPAPI 加密,
  位于 `我的文档\Melodex\AndroidRelease\`。`:app:clean FAILED` 时先 `.\gradlew.bat --stop`。
- **本机两台设备**:`3B656W00MPC00000`(真机 PKG110)与 `emulator-5554`。装真机要加 `-s`。
  2026-11-08 08:00 复核:真机不在线,模拟器未装 `life.nineli.melodex`。
- **不要读 `.env`**,含真实凭据。生产 NAS `192.168.1.99`,容器 `melodex`。
- **容器内没有 python3**,有 `ffprobe/ffmpeg/od/dd/base64`。
  取字节:`od -An -v -tx1 -j <off> -N <n> "<file>"`(BusyBox od 支持 -j/-N)。
- 生产日志里 `broken pipe` 是拖动中断旧请求的正常现象。
- **minified bundle 搜索**:`Select-String` 假阴性,用 `[regex]::Matches` + `Escape`。

## 八、当前生产状态

- 生产镜像:`ghcr.io/aki-riko/melodex:edge`,含 `e01d42e` 的诊断日志
- 线上前端 bundle:`index-DGVHLqwT.js`(562,378 字节;**非 HEAD**,约落后 01299eb 一个提交)
- PWA:拖动正常
- Android:**仍不正常**。真机最后安装的是 2026-11-08 02:15 构建的 rc.5 包
  (签名 SHA256 `5f28d565...faa2ba78`)
- **本轮修复尚未提交、尚未部署、尚未装机**
