# Melodex 桌面歌词助手

这是 Melodex Web 播放器配套的 Windows / macOS 原生透明歌词窗。音乐仍由浏览器播放；助手只负责显示歌词，并把上一首、播放/暂停、下一首命令安全地送回当前浏览器。

## 使用

1. 在 Melodex Web 的「设置 → 桌面歌词」生成一次性配对码。
2. 启动助手，填写 Melodex 站点根地址和配对码。
3. 浏览器开始播放且歌曲有歌词时，透明歌词窗会自动出现。
4. 默认开启鼠标穿透。需要移动窗口或使用控制按钮时，从系统托盘取消「鼠标穿透」；完成后可重新开启。

助手不会创建 Document Picture-in-Picture 窗口，也不会显示封面、歌曲标题、窗口标题栏或不透明背景。

## 本地开发与验证

需要 Rust stable，以及对应平台的 Tauri 2 系统依赖。

```text
cd desktop/src-tauri
cargo run
```

桌面端门禁：

```text
cd desktop/src-tauri
cargo fmt --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked
cd ../ui
node lyricsCore.test.mjs
```

非本机服务地址必须使用 HTTPS；只有 `localhost`、`127.0.0.1` 等回环地址允许 HTTP。设备令牌保存在系统分配给本应用的私有配置目录中，不写进仓库。

## macOS 分发边界

透明窗口依赖 Tauri 的 `macOSPrivateApi`。因此当前助手不适合提交 Mac App Store，只适合在仓库外配置 Apple Developer ID 签名和公证后直接分发。

当前 CI 只在 Windows 和 macOS 上执行格式、测试、Clippy 与编译检查，不产出签名安装包，也不包含签名证书、公证账号或密钥。

## 手工验收

- 播放有歌词的歌曲后，确认窗口只有三行歌词，没有黑底和标题栏。
- 将其他亮色、暗色窗口放在歌词下面，确认背景真实透明且歌词仍可读。
- 保持「鼠标穿透」开启，确认点击会落到下面的应用。
- 从托盘取消「鼠标穿透」，悬停确认出现上一首、播放/暂停、下一首按钮，并拖动歌词窗。
- 再次开启「鼠标穿透」，确认按钮隐藏且点击重新穿过窗口。
