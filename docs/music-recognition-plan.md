# Melodex 听歌识曲调研与上线方案

## 结论

听歌识曲可以做成 PWA 能用的形态：前端录 8-12 秒短音频，后端调用官方识曲服务，识别出歌名/歌手后复用现有「歌名 + 歌词合并搜索」和自动验活播放流程。

本次落地优先支持官方 HTTP 服务：

- AudD：HTTP multipart 接入最薄，适合先上线。
- ACRCloud：企业级服务，签名稍复杂，保留为可配置 provider。

不把网易云/QQ 音乐的听歌识曲做为正式方案。调研时没有找到可信的官方公开识曲 API 文档；网上常见的是非官方封装或私有接口逆向，稳定性、风控、授权和可维护性都不适合放进自托管生产主线。

## 抓包/请求确认

已用真实 HTTP 请求确认 AudD 官方入口的请求形态：

```bash
curl.exe -sS -D - -X POST https://api.audd.io/ \
  -F "url=https://audd.tech/example.mp3" \
  -F "return=apple_music,spotify" \
  -F "api_token=test"
```

确认结果：

- 返回 `HTTP/1.1 200 OK`。
- 响应 `Content-Type: application/json`。
- JSON 顶层为 `status` + `result`。
- `result` 内含 `artist`、`title`、`album`、`release_date`、`timecode`、`song_link`，可直接转成 Melodex 搜索词。
- 上传非歌曲/不可指纹音频时，AudD 返回 `status:error` 与错误码/错误信息，后端需要透传成清晰失败状态。

官方资料：

- AudD 文档：https://docs.audd.io/
- ACRCloud Identification API：https://docs.acrcloud.com/reference/identification-api
- MediaRecorder：https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder
- getUserMedia：https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- ShazamKit：https://developer.apple.com/shazamkit/

## 实现方案

### 前端

- 搜索框旁新增「听歌识曲」按钮。
- 使用 `navigator.mediaDevices.getUserMedia` 获取麦克风权限。
- 使用 `MediaRecorder` 录制 10 秒；录音中再次点击按钮可提前停止并识别。
- 上传短音频到 `/api/v1/recognize`。
- 成功后将后端返回的 `query` 写入搜索框，触发现有搜索，并设置 `autoPlayQuery`。
- 搜索结果完成验活后，复用现有逻辑自动播放第一首可播结果。

### 后端

- 新增 `POST /api/v1/recognize`，仅登录用户可用。
- 新增 `GET /api/v1/recognize/status`，只返回是否启用、provider 和上传限制，不暴露 token/endpoint。
- 复用 `allowSameOriginWrite`，要求 `X-Requested-With: XMLHttpRequest`，防止跨站页面借用户登录态消耗识曲额度。
- 上传文件不落盘，只在内存中短暂转发给 provider。
- 默认单次上传上限 10MB，可通过 `MUSIC_DL_RECOGNITION_MAX_BYTES` 调整。
- 默认识曲超时 20 秒，可通过 `MUSIC_DL_RECOGNITION_TIMEOUT` 调整。
- provider 默认不启用；配置完整后自动启用，或显式设置 `MUSIC_DL_RECOGNITION_PROVIDER`。

## 环境变量

AudD：

```env
MUSIC_DL_RECOGNITION_PROVIDER=audd
MUSIC_DL_AUDD_ENDPOINT=https://api.audd.io/
MUSIC_DL_AUDD_TOKEN=your-token
MUSIC_DL_AUDD_RETURN=apple_music,spotify
```

ACRCloud：

```env
MUSIC_DL_RECOGNITION_PROVIDER=acrcloud
MUSIC_DL_ACRCLOUD_ENDPOINT=https://your-host/v1/identify
MUSIC_DL_ACRCLOUD_ACCESS_KEY=your-access-key
MUSIC_DL_ACRCLOUD_ACCESS_SECRET=your-access-secret
```

通用：

```env
MUSIC_DL_RECOGNITION_TIMEOUT=20s
MUSIC_DL_RECOGNITION_MAX_BYTES=10485760
```

## 上线风险

- 浏览器麦克风权限必须在 HTTPS 或 localhost 下使用；生产 `https://tsp.9li.life` 满足条件。
- iOS Safari/部分 Android Chromium 的录音格式可能不同，后端按 multipart 透传给 provider，由 provider 做格式兼容。
- 识曲服务是外部付费/限额服务，必须保留登录态和同源保护。
- 识曲只能得到「歌名/歌手」级结果，最终能否播放仍由 Melodex 当前国内源搜索和验活决定。
- 没有配置 provider 时，按钮会返回“未启用”，不会误调用外部服务。
- Provider endpoint 生产必须使用 HTTPS；HTTP 只允许 localhost/127.0.0.1 这类本机测试地址，避免 token 明文出网。

## 验证清单

- `go test ./internal/web/ ./core/`
- `go build ./...`
- `npm run build`
- 本机启动后端 + 前端，用真实麦克风录音，确认：
  - 未配置 provider 时提示未启用。
  - 配置 provider 后能识别真实歌曲。
  - 识别成功后自动填入搜索词。
  - 搜索验活完成后自动播放第一首可播歌曲。
  - PWA/HTTPS 环境麦克风权限正常弹出。
