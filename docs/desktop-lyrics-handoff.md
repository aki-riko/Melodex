# 桌面客户端歌词窗 — 交接文档

> 初版 2026-11-23，**同日续写**：控制条与设置页已补齐。
> 本文只记录**已核实的事实**与**待做清单**，不含推测。
>
> 接手前请先读仓库根 `AGENTS.md` 的「桌面客户端」与「桌面歌词」两节。

---

## 〇、2026-11-23 续：控制条与设置页已做完

初版交接时列的三个缺口（控制条 5 按钮 / 设置页 6 项 / 配色与字体可切换）**已全部实现**，
并补了两道机器门禁。全部门禁已跑通，详见第五节。

**但请先看这一条 —— 初版文档有两处与代码不符，已在本版更正：**

| 初版说法 | 实际情况 |
|---|---|
| 「新版只有 3 个按钮且**一直显示**」 | **不准确**。3 个按钮当时**已经是悬停才淡入**（`overlay.css` 的 `.controls` 默认 `opacity:0; pointer-events:none`，只有 `:hover` 才显示）。真正缺的只是**按钮数量**（3 → 5）和**尺寸未按 212×38 胶囊还原**。 |
| 「`build.rs` 的 `commands()` 有 9 条」 | 实际当时已是 **11 条**（含 `overlay_position` / `set_overlay_position`）。本版改为 15 条。 |

另外初版说「锁定/关闭**需要新增命令**」—— 只说对了一半：
- **锁定**：`apply_click_through` 当时**已经存在**（`overlay.rs`，托盘在用），只是没暴露给歌词窗；
- **关闭**：确实需要新东西，但**不能复用** `set_overlay_visible` —— 那个每次状态推送都会被
  `render()` 重设回 `true`，直接接上会「关掉又自己弹出来」。必须是一个**持久化开关**。

---

## 一、当前状态

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
| **控制条 5 按钮 + 212×38 胶囊 + 悬停淡入** | ✅ | `cargo test` 14 项 + `lyricsSettings.test.mjs` 20 项 |
| **设置页 6 项（显示/锁定/字体/字号/配色/位置）** | ✅ | 同上；`index.html` 已从配对页改为设置页 |
| **8 套配色 / 6 种字体可切换** | ✅ | 清单在 `lyrics_settings.rs`，逐字对照 `config.py` |
| **设置持久化** | ✅ | 落 `desktop-lyrics-settings.json`，三个窗口共用 |

### 仍然没做的

| 缺口 | 说明 |
|---|---|
| 自动更新「安装」段 | 无真实签名产物，未验证 |
| 控制条/设置页的**真机目视验收** | 见第七节，本鱼只做了自动化门禁与编译 |

---

## 二、歌词窗架构（已实现，别再重造）

### 数据通道

```
主窗口页面(远程站点) ──invoke('lyrics_push_state')──▶ Rust ──emit──▶ 歌词窗渲染
歌词窗按钮 ──invoke('lyrics_send_command')──▶ Rust ──eval DOM event──▶ 主窗口页面
三窗口 ──invoke('lyrics_settings_*')──▶ Rust ──写盘 + emit──▶ 全部窗口同步
```

**为什么删了配对**：旧方案是「浏览器 → 服务器 hub → 独立助手」，跨进程所以要配对码。
新客户端里播放与歌词同进程，配对是多余的历史包袱。已删除。

### 设置为什么放 Rust 侧（不是 localStorage）

设置要被**三个窗口**同时用：歌词窗（渲染）、设置窗（编辑）、托盘（勾选状态）。
窗口之间不共享内存，`localStorage` 只能各写各的、还会因窗口销毁而丢。
所以 `lyrics_settings.rs` 是**唯一真相源**：落一个 JSON 文件，任何窗口改动都经命令回到这里，
再由 Rust 广播给所有窗口。**不要再往歌词窗里加 `localStorage`。**

### 文件分工

| 文件 | 职责 |
|---|---|
| `desktop/src-tauri/src/lyrics_settings.rs` | 设置结构体 / 8 套配色 / 6 种字体 / 读写 / 夹取 / 补丁 / 广播（14 项单测） |
| `desktop/src-tauri/src/lyrics_bridge.rs` | 状态/命令转发 + 白名单校验（5 项单测） |
| `desktop/src-tauri/src/commands.rs` | `lyrics_push_state` / `lyrics_send_command` / `lyrics_settings_*` / `overlay_position` |
| `desktop/src-tauri/src/tray.rs` | 托盘勾选项与设置双向同步 |
| `desktop/ui/overlay.html` | 双行结构（主行 + 副行）+ **5 个控制按钮** |
| `desktop/ui/overlay.css` | 视觉：描边/配色/字号/控制条尺寸/过渡 |
| `desktop/ui/overlay.js` | 渲染、字号、行切换动画、设置消费、锁定/关闭 |
| `desktop/ui/index.html` | **歌词设置页**（原配对页已废弃） |
| `desktop/ui/settings.js` / `.css` | 6 项设置的渲染与提交 |
| `frontend/src/platform/desktopShell.js` | 网页侧薄桥：`pushLyricsState` / `attachLyricsCommandBridge` |
| `frontend/src/contexts/PlayerContext.js` | 推送状态的两个 effect（**位置在 `lrc`/`lyricIdx` 定义之后**，见坑 2） |

### 安全边界（不许放宽）

- `capabilities/default.json` → 只覆盖 `overlay`/`settings` 本地窗口，含全部本地命令。
- `capabilities/lyrics-bridge.json` → 覆盖 `main` + `https://music.9li.life/*`，
  **只有** `lyrics_push_state` / `lyrics_send_command`。
- **禁止**给远程 origin 加 `core:*`、文件、网络、进程类权限。

> 这条边界现在有**机器门禁**守着：`npm run test:shell-commands` 会断言
> `lyrics-bridge.json` 里只有那两条，且任何 `core:*` 都会让它红。


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

> **已实现**（本版）：5 个按钮齐全，顺序同上。锁定走 `lyrics_settings_update { click_through: true }`，
> 关闭走 `lyrics_settings_update { visible: false }` —— 都是**本机设置**，不经主窗口页面。
> 页面侧的白名单仍只有 `prev`/`toggle`/`next` 三条（见 `commands.rs` 注释）。

### 3.2 设置页项目

`desktop-prismqml/qml/pages/SettingsPage.qml` 第 47~120 行，共 6 项：

| 设置项 | 控件 | 说明 |
|---|---|---|
| 显示桌面歌词 | 开关 | `lyricsVisible` |
| 锁定桌面歌词 | 开关 | `clickThrough`，锁定后鼠标穿透 |
| 歌词字体 | 下拉 | 6 种中文预设 |
| 歌词字号 | 滑块 | 20~64，显示「当前 N px」 |
| 歌词配色 | 下拉 | 8 套配色 |
| 桌面歌词位置 | 只读文本 + 重置 | 已保存显示坐标，未保存提示「解锁后拖动」 |

> **已实现**（本版）：`desktop/ui/index.html` 已是这 6 项，原配对 UI 已删除。
> 位置那一行除了显示坐标，还有一个「重置位置」按钮（对齐旧实现的 `resetLyricsPosition`）。

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

> **已实现**：清单在 `desktop/src-tauri/src/lyrics_settings.rs` 的 `COLOR_SCHEMES`，
> 有单测逐条比对上面这 8 行；JS/CSS 侧不得再抄一份（`overlay.js` 只消费壳侧发来的色值）。

### 3.5 6 种字体预设（`config.py` `WINDOWS_LYRICS_FONT_PRESETS`）

`楷体=KaiTi`、`微软雅黑=Microsoft YaHei UI`、`等线=DengXian`、
`宋体=SimSun`、`黑体=SimHei`、`仿宋=FangSong`

> **已实现**：清单在 `lyrics_settings.rs` 的 `FONT_PRESETS`，同样有单测逐条比对。
> **注意**：字体名带空格（如 `Microsoft YaHei UI`）写 CSS 时必须加引号，
> `overlay.js` 的 `applyFontFamily` 已处理，别改成裸写。

---

## 四、踩过的坑（血泪，别再踩）

### 坑 1：`app_manifest` 与 `generate_handler!` 必须逐条对齐

启用 `build.rs` 的 `app_manifest` 后，**只对声明的命令生成 allow 权限**。
漏掉的命令等于「任何窗口都调不了」——症状是歌词窗永远不显示，**错误日志里什么都没有**。

新增命令时 **两处都要改**：`main.rs` 的 `generate_handler!` 与 `build.rs` 的 `commands()`。

> **现在有机器门禁了**：`npm run test:shell-commands`
> （`desktop/scripts/shellCommandManifest.test.mjs`）会解析三处并断言集合相等：
> `main.rs` 的 `generate_handler!` ↔ `build.rs` 的 `commands()` ↔ `capabilities/*.json` 的 `allow-*`。
> 漏一条立刻红，并直接说出「哪条命令将任何窗口都调不了」。
> 它还守着一条安全底线：`lyrics-bridge.json` 只能有歌词桥两条命令、不得有 `core:*`。
>
> **本鱼验证过这道门禁真的会红**：故意从 `build.rs` 删掉 `lyrics_save_position` 后，
> 门禁报 `这些命令在 main.rs 注册了但 build.rs 没声明，将「任何窗口都调不了」：lyrics_save_position`，exit 1。

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

### 坑 6：写契约测试时，注释会把断言喂饱（本鱼这次踩的）

用正则断言 `assert.doesNotMatch(code, /localStorage/)` 时，**代码注释里解释「为什么不用 localStorage」
也会命中**，测试直接红，而代码其实是对的。同理「不得有第三行」会被注释里的 `outgoingLyric` 命中。

正确做法：断元素用 `id="..."` 这类**只有真元素才有的特征**，或先把注释剥掉再断言：

```js
const body = html.replace(/<!--[\s\S]*?-->/g, '');
const code = js.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
```

> 这类「门禁自己写错」比代码写错更危险：会让人以为功能没做对。

---

## 五、门禁（改完必须全过）

```powershell
# Rust（当前 33 项单测）
cd desktop/src-tauri
cargo fmt --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked

# 歌词 UI 契约（20 项）
cd ../ui; node lyricsSettings.test.mjs; node lyricsCore.test.mjs

# 前端
cd ../../frontend
npm run test:tdz               # 防空屏（95 文件）
npm run test:hooks             # 95 文件
npm run test:desktop-shell     # 17 项
npm run test:desktop-lyrics    # 20 项（设置契约）+ 歌词核心
npm run test:shell-commands    # 命令清单三处对齐 + 远程权限边界
npm run test:player
npm run test:theme
npm run icons && npm run test:icons
```

> **构建前先看内存闸门**（仓库规则）：用户可能在玩游戏或跑渲染，
> 先查 `(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1MB` 与页面文件用量，
> 有大内存前台应用时先问用户，别自顾自开跑。

---

## 六、下一步建议顺序

1. ~~控制条对齐~~ **已做完**（5 按钮 / 212×38 胶囊 / 悬停淡入）。
2. ~~设置页歌词 6 项~~ **已做完**（存壳侧配置文件，**不是** localStorage —— 理由见第二节）。
3. **真机目视验收**（下一件该做的事）：跑起来看一眼 5 个按钮的观感、8 套配色、字号滑块联动。
   自动化门禁只证明了「参数写对了、接线通了」，**证明不了「看着像旧版」**。
4. **自动更新安装段验证**：需要真实签名产物（签名材料目录见仓库外私有笔记，**只确认存在，从未读取**）。

---

## 七、明确未验证的（不要当成已修好）

- **开机自启**：插件与菜单接好，但没勾选重启系统验证（需动注册表）。
- **自动更新「下载→安装→版本号变化」**：无真实签名产物，未跑通。
- **SSO 全新机器首次登录**：壳内不跳 Authentik 已验证，但全新登录未覆盖。
- **控制条 / 设置页的真机观感**：代码、编译、契约测试全过，但**没有人眼看过实际渲染**。
  本节写明这一点：**测试绿 ≠ 用户看着满意**。旧实现那些数值（212×38、32×30、色值）
  是照 `DesktopLyricsWindow.qml` 抄的，但 WebView2 的字体渲染与 Qt 不完全一致，
  像素级观感仍需用户确认后才算验收。

---

## 八、相关文档

- `docs/desktop-shell-plan.md` — 总体方案与阶段 0 实测证据
- `docs/desktop-release-updater.md` — 发布与自动更新（含 https 硬约束）
- `desktop/README.md` — 客户端使用说明
- `AGENTS.md`「桌面客户端」「桌面歌词」两节 — 纪律与安全边界
- **`desktop-prismqml/`** — 旧实现完整源码，**照着抄视觉与交互**。
  注意：它自带第二套 UI 且过不去 Authentik SSO，不要复活它，只抄它的细节。
