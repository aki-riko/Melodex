# 电脑端 APP 重做方案：Tauri 2 包裹 PWA

> 状态：**方案待批准，尚未动工**。
> 结论先行：**能改成包裹 PWA 的应用程序**，但要先把 3 个未验证项做成原型验证，再动 7000 行旧代码。

## 一、为什么要重做（现状盘点）

仓库里现在有**两个**电脑端产物，都不是「包一层网页」：

| 产物 | 目录 | 是什么 | 规模 | 问题 |
|---|---|---|---|---|
| PrismQML 原生客户端 | `desktop-prismqml/` | C++/QML 独立 UI，自带登录、搜索、播放、歌单、歌词、托盘 | cpp 4482 行 + qml 2274 行 + Python 基线 2227 行 | **独立的第二套界面**，跟 Web 端各写一遍；且过不了 SSO |
| Tauri 桌面歌词助手 | `desktop/` | 只做透明歌词窗，通过 WebSocket 与浏览器配对 | Rust 422 行 + ui 669 行 | 是配套件，不是主应用 |

### 决定性的那条：PrismQML 进不了门

`desktop-prismqml/cpp/ApiClient.cpp:140` 里写着一句现成的错误文案：

> `服务被前置登录网关拦截，桌面客户端尚未取得访问授权`

生产 `music.9li.life` 前面挡着 **Authentik SSO**，PrismQML 用自己的 HTTP 客户端打 `/api/v1/*`，拿不到 SSO 会话。
这不是界面丑不丑的问题，是**它根本登不进去**。所以重做不是锦上添花，是修一条死路。

## 二、目标形态

**一套代码，两种外壳。**

```
                    ┌─────────────────────────────┐
                    │  https://music.9li.life     │  ← React PWA（不动）
                    │  React 18 + Vite + PWA SW   │
                    └──────┬───────────────┬──────┘
                           │               │
              ┌────────────▼───┐    ┌──────▼─────────┐
              │  浏览器 / PWA   │    │ Tauri 2 桌面壳  │
              │  （主力，不变）  │    │ WebView2 内核   │
              └────────────────┘    └──────┬─────────┘
                                           │ 同一份页面
                                    ┌──────▼─────────┐
                                    │ 原生增强层       │
                                    │ 托盘/歌词窗/    │
                                    │ 媒体键/快捷键/  │
                                    │ 自启/自动更新   │
                                    └────────────────┘
```

- 页面**不打包进安装包**，壳直接加载线上站点：前端部署即更新，不用重发安装包（与安卓 APK 完全同构，那条路已真机验证过）。
- 桌面端新增的一切能力都在**外壳的 Rust 侧**，网页侧只加一个薄桥接模块。
- `desktop-prismqml/` 整套退役，`desktop/` 从「歌词助手」改造为「主壳 + 内建歌词窗」。

## 三、必须保留的原生能力（你已确认全要）

| 能力 | 实现路径 | 难度 | 风险 |
|---|---|---|---|
| 系统媒体键 / 媒体浮层 | 优先吃 WebView2 的 MediaSession；不行则 Rust 侧接 SMTC | 中 | 🔴 **未验证**，见第四节 R1 |
| 桌面歌词（透明置顶、穿透、托盘开关） | 复用 `desktop/src-tauri` 现有 422 行逻辑，改为内建第二窗口 | 低 | 已有可用实现 |
| 托盘 + 关闭最小化 + 单实例 | `tauri-plugin-single-instance` + 托盘菜单 | 低 | 低 |
| 全局快捷键 | `tauri-plugin-global-shortcut`，命令经 IPC 转给网页 | 低 | 低 |
| 开机自启 | `tauri-plugin-autostart` | 低 | 低 |
| 断点续播 | **前端已实现**（`localStorage` 按 userId 存队列+进度），壳不用做 | 无 | 无 |
| 自动更新 | `tauri-plugin-updater` + NSIS + Ed25519 签名 | 中 | 私钥必须由你保管，见 R4 |

## 四、未验证项（不验证就动工会翻车）

### R1. WebView2 里 MediaSession 会不会接管 Windows 媒体键 —— 🔴 最高优先级

前端 `PlayerContext.js:1353-1411` 已经把 `navigator.mediaSession` 的 action handler、`playbackState`、
`setPositionState` 全配齐了，**在 Chrome/Edge 里工作正常**。
但 WebView2 是嵌入式内核，微软按「浏览器功能在嵌入场景是否合理」做了裁剪，硬件媒体键这类能力**不保证默认开启**。

- 已有旁证：某 WPF + WebView2 应用在更新日志里专门写「**native** real-time SMTC media synchronization」——暗示它得自己在原生侧接，而不是靠内核白送。
- **验证方法**：最小 Tauri 窗口加载一个带 `<audio>` + MediaSession 的本地页，按键盘 ⏯/⏮/⏭，看有没有反应。
- **兜底方案**：Rust 侧用 `windows` crate 的 `SystemMediaTransportControls` 自己发布会话，网页把播放状态/元数据经 IPC 同步过去。工作量 +2~3 天，但**一定能成**。

### R2. Authentik SSO 在 WebView2 里能不能走完 —— 🟡

安卓已验证：Capacitor WebView 加载远端站点，CookieManager 与后端共享登录态。
Windows WebView2 在内核层面等价，但 OIDC 重定向**有可能被踢到系统浏览器**打开。

- **验证方法**：壳里打开站点，走完整登录，看是停在壳内还是跳出去。
- **兜底方案**：若跳出去，改用「授权码回跳 `tauri://` 自定义协议」把会话带回来；或让 NPM 对桌面壳的 UA 放行（不推荐，改动基础设施）。

### R3. 远程页面能不能用 Service Worker（决定离线能力） —— 🟡

壳加载的是 `https://music.9li.life`，origin 与浏览器一致，理论上 `sw.js` 照常注册，**离线打开的还是缓存好的 App shell**，不需要在壳里另起本地 HTTP 服务。

- **验证方法**：加载后 DevTools 看 `navigator.serviceWorker.controller`，再断网重启看是否仍能打开。
- **兜底方案**：壳内起一个只监听 `127.0.0.1` 的静态服务托管离线兜底页（`127.0.0.1` 是安全上下文，SW 也可以用）。工作量 +1~2 天。
- **注意**：`tauri://` / `asset://` 这类自定义协议**不是安全上下文，SW 根本不工作**——所以「打包本地产物」那条路反而更贵。

### R4. 自动更新的签名私钥 —— 🟡（流程问题，不是技术问题）

Tauri updater 强制 Ed25519 签名，无法关闭。私钥必须由**你自己**生成并保管（CI secret），
一旦丢失，已装用户再也收不到更新。本鱼不会代你生成或读取私钥。

## 五、安全边界（这条必须写死）

壳要给远程页面开 IPC，等价于「任何能在那页面执行 JS 的人都能调用本地命令」。因此：

1. **capability 白名单最小化**：只开 `窗口显示/隐藏`、`歌词同步`、`播放控制转发`、`更新检查` 这几条自定义命令，
   **绝不开** `fs` / `shell` / `http` 等通用插件权限。
2. `remote.urls` 精确到 `https://music.9li.life`，禁止通配。
3. 所有自定义命令里再次校验来源窗口 label，不信任网页传来的任意参数。
4. 桌面歌词沿用现有**配对码 + 设备令牌**机制（后端 `desktop_lyrics_auth.go` 已成熟），不复用网页会话。

## 六、实施步骤

### 阶段 0：原型验证（1~2 天，不改动生产代码）

> 目的：把 R1/R2/R3 三个问号变成确定的「行 / 不行」。**验证不过就回头改方案，不要硬着头皮往下写。**

1. 在 `desktop/` 里加一个临时 `prototype` 窗口。
2. 加载带 `<audio>` + MediaSession 的页面 → 按媒体键、看 Windows 媒体浮层。
3. 加载线上站点 → 走 SSO 登录 → 确认会话落在壳内。
4. 断网重启 → 确认 SW 缓存生效。
5. **产出**：三项各给「通过 / 不通过 + 证据」。不通过项按第四节兜底方案调整排期。

### 阶段 1：主壳骨架（2~3 天）

- 改造 `desktop/src-tauri/tauri.conf.json`：主窗口改为加载线上站点，`withGlobalTauri: true`。
- 新增 `capabilities/main.json`：`remote.urls` 锁到生产域名，权限最小化。
- 托盘 + 关闭最小化到托盘 + 单实例 + 开机自启。
- 日志落 `%LOCALAPPDATA%`（不要把 URL 查询串写进日志）。

### 阶段 2：原生增强（3~4 天）

- 媒体键：按阶段 0 结论，走内核直通或 Rust 侧 SMTC。
- 全局快捷键：播放/暂停、上一首、下一首。
- 歌词窗：把现有 `desktop` 的 overlay 逻辑内建进主壳（透明 + 穿透 + 托盘开关 + 拖动）。
- 前端加一个薄桥 `frontend/src/platform/desktopShell.js`：检测壳环境、注册 IPC、
  把播放状态同步给原生侧。**浏览器里必须完全无副作用**。

### 阶段 3：自动更新与分发（2 天）

- `tauri-plugin-updater` + NSIS（安装包约 2~5 MB）。
- 更新清单静态 JSON 或走 GitHub Releases。
- 首版只出 Windows；macOS 需要你提供签名证书才能覆盖，暂不做。

### 阶段 4：退役旧实现（1 天）

- 删除 `desktop-prismqml/` 整个目录（**需你明确同意**，这是不可逆的删除）。
- 前端「设置 → 桌面歌词」文案更新：配对流程保留，说明改为自动。
- CI：`desktop-lyrics-ci.yml` 改造为 `desktop-ci.yml`（fmt / test / clippy / build）。
- `AGENTS.md` 的「架构」「PrismQML 桌面原生播放」两节重写。

### 阶段 5：真机验收

- 用真实账号在真实 Windows 上：播放、媒体键、歌词窗、托盘、断点续播、断网、更新。
- **必须真机验证，不接受「单测通过就当修好」**。

## 七、验证门禁

```powershell
# 壳侧
cd desktop/src-tauri
cargo fmt --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked

# 前端（改动薄桥接后）
cd frontend
npm.cmd run build
npm.cmd run test:theme
```

真机验收清单（缺一不可）：

- [ ] 媒体键 ⏯/⏮/⏭ 生效，Windows 媒体浮层显示歌名与封面
- [ ] SSO 登录全程在壳内完成，无需外部浏览器
- [ ] 关闭窗口最小化到托盘，音乐不断
- [ ] 桌面歌词透明、可穿透、托盘可开关
- [ ] 全局快捷键在应用失焦时仍生效
- [ ] 开机自启后不自动播放（遵守浏览器策略，只恢复进度）
- [ ] 断网冷启动仍能打开界面
- [ ] 应用内检查更新 → 下载 → 安装 → 版本号变化

## 八、总体评估

| 项 | 评估 |
|---|---|
| 预期效果（量化） | 退役 7000+ 行重复实现；桌面端从「进不了 SSO 的死路」变为「与 Web 同源、部署即更新」；安装包 2~5 MB（对比 Electron 100 MB+） |
| 实施难度 | **7~12 人天**（不含阶段 0 的不确定性；若 R1 要自建 SMTC 则 +2~3 天） |
| 风险等级 | **中高**。风险集中在阶段 0 三个未验证项；阶段 1 之后基本是确定性工作 |

## 九、回退方案

- 阶段 0~3 全部在 `desktop/` 内推进，`desktop-prismqml/` **原样保留**，随时可退回。
- 旧客户端已部署在 `%LOCALAPPDATA%\Melodex\desktop-deploy`，删除源码目录前它照常可运行。
- 前端薄桥接在浏览器环境完全惰性，出问题删掉一个文件即可，不影响 PWA。
