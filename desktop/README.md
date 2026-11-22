# Melodex 桌面客户端

这是 Melodex 的 Windows / macOS 桌面客户端。它**用 Tauri 2 包裹 Melodex PWA**：

- 主窗口直接加载线上站点（默认 `https://music.9li.life/`），页面内容随服务端部署更新，**前端更新不需要重发安装包**。
- 原生能力在 Rust 侧补齐：托盘常驻、关闭最小化、单实例、开机自启、透明桌面歌词。
- 系统媒体键由 WebView2 内核对 `navigator.mediaSession` 的直通处理，无需额外实现。

桌面歌词仍是配套能力：主窗口播放时，透明歌词窗自动出现，并把上一首、播放/暂停、下一首命令安全地送回页面。

## 使用

1. 在 Melodex Web 的「设置 → 桌面歌词」生成一次性配对码。
2. 启动客户端，在配对窗口中填写 Melodex 站点根地址和配对码。
3. 在主窗口播放且有歌词的歌曲时，透明歌词窗会自动出现。
4. 默认开启鼠标穿透。需要移动窗口或使用控制按钮时，从托盘取消「歌词鼠标穿透」；完成后可重新开启。

### 托盘菜单

- **显示 / 隐藏主窗口**：关闭主窗口只是隐藏到托盘，音乐不会中断。
- **桌面歌词配对…**：重新打开配对窗口。
- **歌词鼠标穿透**：切换歌词窗是否接收鼠标事件。
- **开机自动启动**：写入系统自启项；开机启动时主窗口静默创建（不抢焦点），**不会自动播放**。
- **退出**：真正结束进程。

## 安全边界

壳要给远程页面开 IPC 就等于「任何能在该页面执行 JS 的人都能调用本地命令」。因此：

- `capabilities/default.json` **只覆盖本地自绘窗口**（`overlay`、`settings`），
  主窗口（加载线上站点）不在任何 capability 中 → 线上页面完全无法触达 IPC。
- 没有为任何远程 origin 配置 `remote.urls`。
- 导航白名单：只允许站点同源与登录网关同源，其余外链交给系统浏览器，
  避免 WebView 被当成任意网页宿主。
- 站点地址只接受 HTTPS；仅回环地址允许 HTTP。设备令牌保存在系统私有配置目录，不写进仓库。

## 站点地址配置

默认加载 `https://music.9li.life/`，可用环境变量覆盖：

```text
MELODEX_SHELL_SITE=https://your-melodex.example
```

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

> **依赖版本纪律**：`tauri-plugin-single-instance` 固定 `2.4.5`、`tauri-plugin-autostart` 固定 `2.5.1`。
> 更新的 2.5.x / 2.6+ 要求 `tauri ^2.12`，与本项目锁定的 `tauri 2.10.1` 冲突，升级时必须同步升 tauri。

## 日志

运行日志写入系统应用日志目录（Windows 下为
`%LOCALAPPDATA%\life.9li.melodex.desktoplyrics\logs\shell.log`）。
日志不记录设备令牌与带签名的播放地址。

## macOS 分发边界

透明窗口依赖 Tauri 的 `macOSPrivateApi`。因此当前客户端不适合提交 Mac App Store，只适合在仓库外配置 Apple Developer ID 签名和公证后直接分发。

当前 CI 只在 Windows 和 macOS 上执行格式、测试、Clippy 与编译检查，不产出签名安装包，也不包含签名证书、公证账号或密钥。

## 手工验收

主窗口与生命周期：

- 关闭主窗口后进程仍在、音乐继续；从托盘可重新唤出。
- 再次双击启动时不会出现第二个实例，而是聚焦已有窗口。
- 托盘勾选「开机自动启动」后重启系统，主窗口静默创建、不自动播放。

媒体键（**重要**）：媒体键只作用于**当前活动**的媒体会话。应用暂停且系统里另有正在播放的
会话（如浏览器视频）时，按媒体键会作用于那个会话，这是 Windows 的既定语义，不是缺陷。

桌面歌词：

- 播放有歌词的歌曲后，确认窗口只有三行歌词，没有黑底和标题栏。
- 将其他亮色、暗色窗口放在歌词下面，确认背景真实透明且歌词仍可读。
- 保持「鼠标穿透」开启，确认点击会落到下面的应用。
- 从托盘取消「鼠标穿透」，悬停确认出现上一首、播放/暂停、下一首按钮，并拖动歌词窗。
- 再次开启「鼠标穿透」，确认按钮隐藏且点击重新穿过窗口。
