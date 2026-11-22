# 桌面客户端歌词窗 — 交接文档

> 写于 2026-11-23。交接原因：桌面歌词（尤其**控制条/设置项**）没对齐旧实现，
> 用户决定换人继续。本文只记录**已核实的事实**与**待做清单**，不含推测。
>
> 接手前请先读仓库根 `AGENTS.md` 的「桌面客户端」与「桌面歌词」两节。

---

## 一、当前状态（截至提交 `d121abb`）

### 已完成的

| 项 | 状态 | 证据 |
|---|---|---|
| Tauri 2 壳包裹线上 PWA | ✅ | 主窗口加载 `https://music.9li.life/` |
| 托盘 / 单实例 / 关闭到托盘 / 开机自启 | ✅ | 真机验证过关闭拦截与单实例唤回 |
| 全局快捷键 | ✅ | `Ctrl+Alt+Space/Left/Right` 真机按过，日志有记录 |
| 媒体键 | ✅ | 真实站点页面 `handler-play/pause/next` 均到达 |
| 自动更新「检查」链路 | ✅ | 本地清单服务实测 `update available: 9.9.9` |
| 歌词窗壳内直连（**已删配对流程**） | ✅ | 播放时歌词窗自动显示 |
| 歌词双行布局 / 字号 / 描边 / 配色 | ✅ | 用户确认「现在是两行了，看着正常」 |

### **没做完的（本次交接的核心）**

| 缺口 | 说明 |
|---|---|
| **歌词窗控制条** | 旧版是「悬停才淡入的胶囊卡片，含 5 个按钮」；新版只有 3 个按钮且**常驻显示**，样式未对齐 |
| **设置页歌词项** | 旧版有 6 个设置项（见第三节）；**新版一个都没有** |
| 8 套配色切换 | 现在写死珊瑚绯 |
| 6 种字体预设切换 | 现在写死微软雅黑 |
| 字号用户可调 | 现在固定 36px |
| 自动更新「安装」段 | 无真实签名产物，未验证 |

---

## 二、歌词窗架构（已实现，别再重造）

### 数据通道

```
主窗口页面(远程站点) ──invoke('lyrics_push_state')──▶ Rust ──emit──▶ 歌词窗渲染
歌词窗按钮 ──invoke('lyrics_send_command')──▶ Rust ──eval DOM event──▶ 主窗口页面
```

**为什么删了配对**：旧方案是「浏览器 → 服务器 hub → 独立助手」，跨进程所以要配对码。
新客户端里播放与歌词同进程，配对是多余的历史包袱。已删除。

### 文件分工

| 文件 | 职责 |
|---|---|
| `desktop/src-tauri/src/lyrics_bridge.rs` | 状态/命令转发 + 白名单校验（5 项单测） |
| `desktop/src-tauri/src/commands.rs` | `lyrics_push_state` / `lyrics_send_command` / `overlay_position` / `set_overlay_position` |
| `desktop/ui/overlay.html` | 双行结构（主行 + 副行）+ 3 个控制按钮 |
| `desktop/ui/overlay.css` | 视觉：描边/配色/字号/过渡 |
| `desktop/ui/overlay.js` | 渲染、字号自适应、行切换动画、位置记忆 |
| `frontend/src/platform/desktopShell.js` | 网页侧薄桥：`pushLyricsState` / `attachLyricsCommandBridge` |
| `frontend/src/contexts/PlayerContext.js` | 推送状态的两个 effect（**位置在 `lrc`/`lyricIdx` 定义之后**，见坑 1） |

### 安全边界（不许放宽）

- `capabilities/default.json` → 只覆盖 `overlay`/`settings` 本地窗口，含全部本地命令。
- `capabilities/lyrics-bridge.json` → 覆盖 `main` + `https://music.9li.life/*`，
  **只有** `lyrics_push_state` / `lyrics_send_command`。
- **禁止**给远程 origin 加 `core:*`、文件、网络、进程类权限。

---

## 三、旧实现的完整能力（**照着做，不要重新发明**）

来源：`desktop-prismqml/qml/components/DesktopLyricsWindow.qml`（500 行）
与 `desktop-prismqml/melodex_desktop/config.py`。

### 3.1 控制条（新版最缺的）

旧版 `Fluent.Card`：

| 属性 | 值 |
|---|---|
| 尺寸 | 212 × 38，`borderRadius = height/2`（胶囊） |
| 位置 | 顶部居中（`anchors.top` + `horizontalCenter`） |
| 底色 | `rgba(0.97, 0.98, 0.99, 0.94)` |
| 边框 | `rgba(0.12, 0.14, 0.16, 0.20)`，thin |
| 出现条件 | `!clickThrough && windowHover.hovered`（**鼠标悬停才显示**） |
| 动画 | opacity + scale(0.96→1)，`Fluent duration.fast`，`OutCubic` |

**5 个按钮**（每个 32×30，`iconSize.s`）：

| 按钮 | 图标 | 动作 |
|---|---|---|
| 上一首 | `icon.previous` | `Player.previous()` |
| 播放/暂停 | `icon.play`/`icon.pause`，**primary 样式 + pill 形状** | `Player.togglePlay()` |
| 下一首 | `icon.next` | `Player.next()` |
| 锁定（开启鼠标穿透） | `icon.desktop_cursor` | `UserSettings.setClickThrough(true)` |
| 关闭歌词 | `icon.dismiss` | `UserSettings.setLyricsVisible(false)` |

> 新版 `overlay.html` 目前只有 prev/toggle/next 三个，缺「锁定」与「关闭」。
> `desktop/ui/overlay.js` 里已有 `lyrics_send_command` 通道，
> 但「锁定/关闭」需要**新增命令**（旧版是改设置），不在现有白名单里。

### 3.2 设置页项目（新版全缺）

`desktop-prismqml/qml/pages/SettingsPage.qml` 第 47~120 行，共 6 项：

| 设置项 | 控件 | 说明 |
|---|---|---|
| 显示桌面歌词 | 开关 | `lyricsVisible` |
| 锁定桌面歌词 | 开关 | `clickThrough`，锁定后鼠标穿透 |
| 歌词字体 | 下拉 | 6 种中文预设 |
| 歌词字号 | 滑块 | 20~64，显示「当前 N px」 |
| 歌词配色 | 下拉 | 8 套配色 |
| 桌面歌词位置 | 只读文本 | 已保存显示坐标，未保存提示「解锁后拖动」 |

### 3.3 视觉参数（已对齐，别再改）

| 项 | 值 |
|---|---|
| **布局** | **双行**：主行=当前、副行=下一行。**不要加第三行** |
| 主行字号 | 20~64，默认 36 |
| 主行字重 | DemiBold(600) |
| 副行字号 | 主行 × 0.67，最小 16 |
| 播放色 | 默认珊瑚绯 `#FFC6C6` |
| 未播放色 | `#EEEEEE` |
| 描边 | `rgba(5,6,8,0.82)` 约 1px |
| 阴影 | 垂直 1px，`rgba(5,6,8,0.30)` |
| 行切换 | 380ms `cubic-bezier(0.65,0,0.35,1)` |
| 默认位置 | 水平居中、垂直 76% |

**为什么必须要描边**：白字压浅色壁纸会完全看不见。这是用户最初抱怨「歌词做得烂」的直接原因。
Web 侧等价物 = `-webkit-text-stroke` + `text-shadow` 叠加。

### 3.4 8 套配色（`config.py` `LYRICS_COLOR_SCHEMES`）

格式 `(已播放色, 未播放色)`，未播放色统一 `#EEEEEE`：

```
珊瑚绯 #FFC6C6 | 暮霞 #EEC1D1 | 樱雾 #FDD6EB | 晴澜 #C7E4F1
青芽 #E6FAD0 | 藤影 #E7E3FB | 杏月 #FCE8C2 | 雾银 #D3D2D2
```

### 3.5 6 种字体预设（`config.py` `WINDOWS_LYRICS_FONT_PRESETS`）

`楷体=KaiTi`、`微软雅黑=Microsoft YaHei UI`、`等线=DengXian`、
`宋体=SimSun`、`黑体=SimHei`、`仿宋=FangSong`

---

## 四、踩过的坑（血泪，别再踩）

### 坑 1：`app_manifest` 与 `generate_handler!` 必须逐条对齐

启用 `build.rs` 的 `app_manifest` 后，**只对声明的命令生成 allow 权限**。
漏掉的命令等于「任何窗口都调不了」——症状是歌词窗永远不显示，**错误日志里什么都没有**。

新增命令时 **两处都要改**：`main.rs` 的 `generate_handler!` 与 `build.rs` 的 `commands()`。

### 坑 2：`lrc` 的 TDZ（曾导致整站白屏「界面出错了」）

歌词推送的两个 effect 必须在 `const [lrc, setLrc] = useState([])` **之后**。
放前面会抛 `lrc is not defined`，整棵组件树被 ErrorBoundary 接住。

已加门禁：`npm run test:tdz`（95 文件，含 8 个自检样本）。
**Vite 构建不报这个错**，只有真机渲染才炸。

### 坑 3：WebView2 透明窗口抓不到图

- `PrintWindow(PW_RENDERFULLCONTENT)` → 全白
- `CopyFromScreen` → 抓到的是底层壁纸

**歌词窗的视觉验证只能靠用户目视**，不要在这上面反复折腾截图工具
（`desktop/prototype/scripts/capture-window-*.ps1` 都试过了）。

### 坑 4：ICO 小尺寸档导致标题栏发虚

曾塞 16/24 档，150% DPI 下 Windows 取 16px 再**放大**，糊成灰雾。
现改为 `buildIco([32, 48, 64, 128, 256])`——只能取 32 档**缩小**，与 PWA 同路径。

### 坑 5：PowerShell 5.1 按 GBK 读 UTF-8 无 BOM 脚本

含中文的 `.ps1` 直接语法错误。诊断脚本一律写纯 ASCII 或带 BOM。

---

## 五、门禁（改完必须全过）

```powershell
# Rust
cd desktop/src-tauri
cargo fmt --check
cargo test --locked            # 当前 19 项
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked

# 歌词 UI 核
cd ../ui; node lyricsCore.test.mjs

# 前端
cd ../../frontend
npm run test:tdz               # 防空屏
npm run test:hooks
npm run test:desktop-shell     # 17 项
npm run test:player
npm run test:theme
npm run icons && npm run test:icons
```

---

## 六、下一步建议顺序

1. **控制条对齐**（用户最在意）：胶囊卡片 + 悬停淡入 + 补「锁定」「关闭」两个按钮。
   注意这两个需要新 IPC 命令，`build.rs` 与 `main.rs` 同步加。
2. **设置页歌词 6 项**：字体/字号/配色/显示开关/锁定/位置。
   这些是**本地用户设置**，建议存 `localStorage` 或壳配置文件，不经过服务器。
3. **自动更新安装段验证**：需要真实签名产物（私钥在
   `<SIGNING-DIR>`，**只确认存在，从未读取**）。

---

## 七、明确未验证的（不要当成已修好）

- **开机自启**：插件与菜单接好，但没勾选重启系统验证（需动注册表）。
- **自动更新「下载→安装→版本号变化」**：无真实签名产物，未跑通。
- **SSO 全新机器首次登录**：壳内不跳 Authentik 已验证，但全新登录未覆盖。
- **控制条/设置页**：**根本没做**，不是「有问题」，是不存在。

---

## 八、相关文档

- `docs/desktop-shell-plan.md` — 总体方案与阶段 0 实测证据
- `docs/desktop-release-updater.md` — 发布与自动更新（含 https 硬约束）
- `desktop/README.md` — 客户端使用说明
- `AGENTS.md`「桌面客户端」「桌面歌词」两节 — 纪律与安全边界
- **`desktop-prismqml/`** — 旧实现完整源码，**照着抄视觉与交互**。
  注意：它自带第二套 UI 且过不去 Authentik SSO，不要复活它，只抄它的细节。
