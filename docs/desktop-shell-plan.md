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

## 四、阶段 0 实测结果（2026-11-22，真实 Windows 真机）

> 结论：**R1 通过、R3 通过、R2 部分通过**。原型代码在 `desktop/prototype/`（可整目录删除），
> 日志在 `desktop/prototype/prototype.log`。全部结论都有可复现命令与时间戳证据，不是推测。

### 测试环境

| 项 | 值 |
|---|---|
| WebView2 内核 | `Chrome/157.0.0.0 ... Edg/157.0.0.0`（运行时 `157.0.4341.60`） |
| Tauri | 2.10.1（首次编译 50s，复用 `desktop/src-tauri/Cargo.lock` 避免依赖漂移） |
| 工具链 | MSVC 2022 BuildTools 17.14、Rust 1.96、Node 24 |

### R1 媒体键 —— ✅ **通过（内核直通，无需 Rust 侧自建 SMTC）**

**证据链（时间戳取自 `prototype.log`，Unix 秒）**：

| 时刻 | 事件 |
|---|---|
| `…775.019` | `event-playing` — 音频真正开始播放 |
| `…778.025` | `autoplay-result` `paused:false, currentTime:2.97, readyState:4, errorCode:null` — 确在播，非假播放 |
| SMTC 侧观测 | 会话数由 `n=1` 变为 `n=2`，新增 `msedgewebview2.exe:Playing` |
| `…789.744` | 按下硬件媒体键 ⏯ → 页面收到 `handler-pause` |
| `…872.297` | 按下 ⏭ → `handler-next` |
| `…884.211` | 按下 ⏮ → `handler-prev` |
| `…887.000` | 按下 ⏹ → `handler-stop` |

全链路成立：**物理媒体键 → Windows SMTC → WebView2 → 页面 `mediaSession` handler**。
因此**不需要**在 Rust 侧用 `windows` crate 自建 SMTC，原计划的 2~3 天兜底工作量可以省掉。

**重要行为特征（必须写进实现与测试）**：
媒体键只路由给**当前活动**的 SMTC 会话。实测中当本机 Chrome 另有一个 `Playing`
会话时，本应用一旦暂停就失去活动位，后续按键全部被 Chrome 接走（3 次连按均无响应）。
这不是缺陷，是 Windows 的既定语义。产品含义：应用暂停时媒体键不响应是**正常**的，
验收用例必须据此书写，不能把「暂停后按 ⏯ 没反应」当成 bug。

**复现命令**：
```powershell
# 观察当前所有媒体会话
powershell.exe -NoProfile -ExecutionPolicy Bypass -File desktop\prototype\scripts\smtc-probe.ps1
# 发送真实硬件媒体键（playpause / next / prev / stop）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File desktop\prototype\scripts\press-media-key.ps1 -Key next
```

#### 补充取证（R1 第二轮，加载**真实站点**而非本地探针页）

阶段 0 首轮用的是本地探针页。为了排除「只有本地页才行」的疑虑，第二轮让原型壳
**加载真实站点 `https://music.9li.life/`** 并注入只读诊断脚本，结果：

```json
{"kind":"sw","href":"https://music.9li.life/","origin":"https://music.9li.life",
 "isSecureContext":true,"hasServiceWorker":true,
 "hasMediaSession":true,"hasMediaMetadata":true,"hasSetPositionState":true,
 "controller":"https://music.9li.life/sw.js","registrations":["https://music.9li.life/"]}
{"kind":"shortcut-event","received":true}
```

- **真实站点页面上 `mediaSession` 全套 API 可用**（含 `setPositionState`），
  说明新壳依赖的媒体键能力在真实页面成立，不是本地页特例。
- **壳派发的 `melodex:shell-shortcut` 事件能送达真实站点页面**（`received:true`），
  阶段 2 的薄桥链路在真实站点上成立。
- 随后对真实站点派发硬件媒体键：`handler-play` / `handler-pause` / `handler-next` 均到达。
- 同轮再次印证会话争用语义：应用暂停后按键会被另一个 `Playing` 会话接走，
  **恢复播放后立即恢复响应**。

### R2 线上站点 & SSO —— 🟡 **部分通过（需你人工确认登录态）**

- `https://music.9li.life/` 在壳内直接加载成功，`on_navigation` 只记录到 `NAV https://music.9li.life/`。
- **没有**出现跳往 Authentik 域名的导航事件。
- 但需诚实说明：本次测试机浏览器里已存在 SSO/Melodex 会话，
  **未覆盖「全新机器首次登录」这条路径**。这条必须由你人工走一遍。
- 已知利好：安卓 APK 用的是完全相同的「壳加载远端站 + 共享 Cookie」形态且已真机验证，
  Windows 侧内核同为 Chromium。

### R3 Service Worker —— ✅ **通过（远程 origin 上 SW 正常工作）**

注入诊断脚本后回传（`kind:"sw"`）：

```json
{"origin":"https://music.9li.life","isSecureContext":true,"hasServiceWorker":true,
 "controller":"https://music.9li.life/sw.js","registrations":["https://music.9li.life/"]}
```

`controller` 已就位、注册作用域正确，说明 WebView2 像普通浏览器一样运行既有 PWA。
**因此不需要在壳内另起 `127.0.0.1` 静态服务**，原计划 +1~2 天兜底工作量省掉。
（`tauri://` 自定义协议不是安全上下文、SW 不工作，这条注意事项仍然成立，只是本方案不走那条路。）

### R4 签名私钥 —— ✅ 已就位（本鱼只确认存在，未读取任何内容）

`<SIGNING-DIR>` 下三个文件均在：
`.tauri-updater-key`、`.tauri-updater-key.pub`、`.tauri-updater-password`（2026-07-23）。
**本鱼未打开、未复制、未回显其中任何一个字节**，后续构建只通过环境变量指向路径。
私钥一旦丢失将无法给已装用户发更新，请自行做好离线备份。

### 其他实测踩坑（写进实现纪律）

1. **必须复用 `desktop/src-tauri/Cargo.lock`**。从零解析依赖会得到互相冲突的 `tauri` +
   传递依赖组合，编译报 `UnexpectedMenuKind` 之类 tauri 自身枚举缺失的错（实测 28 个错误）。
   注意锁文件里没有新包名时 `--locked` 会被拒，去掉该参数即可（既有版本仍被锁定）。
2. **PowerShell 5.1 读 UTF-8 无 BOM 会按 GBK 解析**：含中文的 `.ps1` 直接语法错误。
   诊断脚本一律写纯 ASCII，或带 BOM。
3. **`additional_browser_args` 会覆盖 wry 的默认值**，默认是
   `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`，自定义时必须自己带上。
4. **stdout 有管道缓冲**，取证日志必须同时写文件与 stderr，否则关键证据会丢。
5. **WinRT SMTC 只能在 Windows PowerShell 5.1 里用**：pwsh 7（.NET 8）无 WinRT 投影。
6. 用 `document.title` 回传诊断数据**不可靠**（SPA 路由会覆盖、title 同步也不保证），
   改用本地回环 HTTP 上报才稳。

## 五、安全边界（这条必须写死）

壳要给远程页面开 IPC，等价于「任何能在那页面执行 JS 的人都能调用本地命令」。因此：

1. **capability 白名单最小化**：只开 `窗口显示/隐藏`、`歌词同步`、`播放控制转发`、`更新检查` 这几条自定义命令，
   **绝不开** `fs` / `shell` / `http` 等通用插件权限。
2. `remote.urls` 精确到 `https://music.9li.life`，禁止通配。
3. 所有自定义命令里再次校验来源窗口 label，不信任网页传来的任意参数。
4. 桌面歌词沿用现有**配对码 + 设备令牌**机制（后端 `desktop_lyrics_auth.go` 已成熟），不复用网页会话。

## 六、实施步骤

### 阶段 0：原型验证 —— ✅ **已完成（2026-11-22）**

结论：R1 通过、R3 通过、R2 部分通过（需你人工走一次全新登录）。详见第四节。
原型留在 `desktop/prototype/`，阶段 5 后可整目录删除；也可现在就删，证据已全部摘录进本文档。

### 阶段 1：主壳骨架（2~3 天）

- 改造 `desktop/src-tauri/tauri.conf.json`：主窗口改为加载线上站点，`withGlobalTauri: true`。
- 新增 `capabilities/main.json`：`remote.urls` 锁到生产域名，权限最小化。
- 托盘 + 关闭最小化到托盘 + 单实例 + 开机自启。
- 日志落 `%LOCALAPPDATA%`（不要把 URL 查询串写进日志）。

### 阶段 2：原生增强（2~3 天，比原估下调）

- 媒体键：**走内核直通，零额外代码**（R1 已实测通过，省掉原计划 2~3 天的 Rust 侧 SMTC）。
  注意前端已有的 `PlayerContext.js` MediaSession 逻辑必须保持不动。
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
      （注意：**应用处于暂停态时媒体键不响应属正常**，见第四节 R1 的会话争用说明）
- [ ] SSO 登录全程在壳内完成，无需外部浏览器（**全新机器首次登录**必须覆盖）
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
| 实施难度 | **4~7 人天**（阶段 0 已完成；两项原兜底——Rust 侧自建 SMTC、壳内本地 HTTP 服务——经实测均不需要） |
| 风险等级 | **中低**（原为中高）。三条技术未知已实测澄清，剩余风险是常规实现与真机验收 |

## 九、回退方案

- 阶段 1~3 全部在 `desktop/` 内推进，`desktop-prismqml/` **原样保留**，随时可退回。
- 旧客户端已部署在 `%LOCALAPPDATA%\Melodex\desktop-deploy`，删除源码目录前它照常可运行。
- 前端薄桥接在浏览器环境完全惰性，出问题删掉一个文件即可，不影响 PWA。
- 原型 `desktop/prototype/` 与证据文件 `desktop/prototype/prototype.log` 可直接删除，不影响任何已提交代码。
