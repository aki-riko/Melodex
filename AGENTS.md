# AGENTS.md — Melodex 项目纪律与概况

> 给接手本项目的 AI / 开发者。动手前务必读完本文件。

## 这是什么

Melodex 是自托管音乐应用:
- **Web/PWA 与 Tauri 桌面客户端** —— Melodex 自有应用实现
- **[CharlesPikachu/musicdl](https://github.com/CharlesPikachu/musicdl)** —— 固定提交的多源 Provider 快照,**Apache-2.0**

架构决策:**React 作统一 Web 前端,Tauri 2 壳包裹 PWA 作桌面客户端,Go 作 Melodex JSON/下载后端,Python sidecar 承载 Apache Provider**。项目整体采用 **AGPL-3.0**，固定 Provider 快照保留其 **Apache-2.0** 许可证。用户纯开源自用、不商业化。界面**全中文**(对接国内平台,无 i18n / 无语言切换)。**UI 使用 Fluent Design(Windows 11 风格),深浅两档、跟随系统**(详见下方「主题系统」节;Spotify 暗色皮肤已于 2026-11 彻底移除)。图标用 lucide-react。**主力用法已转 PWA Web 前端**(音流等 Subsonic 客户端对 search3 结果客户端重排,排序不可控,见下;Web 前端排序自控)。

## 架构(读源码得出,非臆测)

```
Melodex/
├── backend/    Go(Gin)应用后端 + Provider sidecar;不依赖外部 Go 音源库
│   └── internal/web/
│       ├── json_api.go      新增的 /api/v1/* JSON 接口(React 用);含 cookie 管理(GET/POST/DELETE /cookies)
│       ├── frontend_embed.go  go:embed 托管 React 产物(SPA + /api、/music 各自路由)
│       ├── music.go/collection.go/local_music.go  原 /music/* 路由(下载/inspect/歌词/本地库)
│       │      videogen.go 仍在但**未注册**(功能已剥离,见下)
│       └── frontend_dist/    占位 index.html;Docker 构建时被 React 产物覆盖
└── frontend/   React 18 + Vite + Tailwind(**单套 Fluent Design,深浅两档**:CSS 变量在 index.css,注册表在 src/theme/)。无 react-router,**哈希路由**(#download/#myplaylist 等,刷新不丢)
    └── src/
        ├── theme/            themes.js(主题注册表 + 39 个必填 token 清单 + 首帧/Storage 工具)/ ThemeContext.jsx(ThemeProvider,写 <html data-theme>)
        ├── App.js            app-shell 布局(Sidebar 左固定栏 + TopBar 全局搜索 + 滚动 main + PlayerBar 底部 + MobileTabBar);currentSection 驱动页 + hash 同步;QueryClient 关 refetchOnWindowFocus
        ├── components/        Sidebar(桌面左栏+移动底Tab,含自建歌单列表)/TopBar(全局搜索)/Trending(=首页,热门歌单)/Download(搜索下载)/Artists/Settings/SongRow/MyPlaylist(自建歌单详情)/AddToPlaylistModal/PlaylistSongs/FAQ/Footer
        │                     (Hero/Discover/Navbar/Videogen 已删:首页改用 Trending,发现页与热门重叠已删)
        ├── contexts/PlayerContext.js  全局常驻播放器(队列上/下一首+进度+播放模式 order/repeat/shuffle + MediaSession 锁屏控制;切页不停;失败自动跳下一首)
        ├── contexts/CollectionsContext.js  自建歌单全局态(列表+加歌目标 addTarget)
        ├── hooks/useLiveCheck.js       搜索结果并发验活(限并发6,返回真实 size/bitrate/bitrateNum)
        ├── services/musicdl.js         后端 API 封装;collections.js 自建歌单(m3u 导入);downloadBus/playlistBus 事件总线(前缀 melodex:)
        └── (Hero/Discover/lib/videogenEngine.js 已删)
```

### 关键设计点 / 坑(务必知道)
- **后端路由前缀 `RoutePrefix = "/music"`**作为现有客户端与部署兼容接口保留,几十处引用同一常量。`/music` 的**老 HTMX 网页已下线**(renderIndex 返 410),只保留 JSON/下载/登录接口。
- **前端 API_BASE 默认空字符串**(同源相对路径);开发期用 `frontend/.env.development.local` 指向本地后端。
- **鉴权 cookie Path 必须是 `/`**(不是 /music),否则登录态覆盖不到 /api,表现为"登录没生效"。
- **登录/setup 页**(`/music/login`)保留,React Settings 引导用户来此做管理员鉴权。登录成功跳回 `/`(不是已下线的 /music)。
- **videogen 已剥离**(2026-06):前端组件/引擎/导航删除,后端 `RegisterVideogenRoutes` 不再注册。原因——移植成 ES module 后严格模式暴露隐式全局变量(coverRadius 等),且封面容错依赖墙外 placeholder + webp,国内环境天生不稳;用户不用。`videogen.go` 文件留着但不挂载,要彻底删可连文件一起清。
- **下载到 NAS(自托管)**:点「下载」走 `saveToServer` → `POST /music/download?save_local=1&embed=1` + `X-Requested-With` 头(`write_guard.go` 要求 POST+同源+XHR 防 CSRF),存到容器 `data/downloads`(随 data 卷持久化),带完整刮削,本地音乐库可扫到。**不是**浏览器下载(那不经服务器,本地库永远空)。
- **哈希路由**:URL hash 即当前页(#download/#settings),刷新/直达不丢;**导航必须用 `pushRouteEntry`(写 `history.state` 深度标记),不能直接改 `location.hash`** —— 后者带不了 state,返回时无法判断"还有没有站内上一页"。
- **返回键三层(2026-11 系统化,`contexts/backLayers.js` + `backNavigation.js` + `routeHistory.js`)**:
  ① 浮层按 LIFO 收(弹窗/抽屉/菜单/播放页,均挂 `useBackLayer`);
  ② 浮层清空后沿**真实历史**后退一页(`goBackInApp`,靠 `ROUTE_DEPTH_KEY` 判断,不能用 `history.length` —— APK 外壳加载远端站时它包含外部跳转,几乎永远 >1);
  ③ 退回入口页(深度 0)才交给系统退出。
  **踩过的坑**:第一版写成"不在首页就 `navigate('Home')`",结果从歌单点进去按返回**一律掉回首页**(用户报的正是这个);
  另 `pushState` 只派发 `popstate` 不派发 `hashchange`,所以路由同步必须两个都听。
- **APK 侧返回键**:Capacitor 8 核心**不处理返回键**(不覆写 onBackPressed 也不转发),必须自己注册 `SystemBackPlugin`(OnBackPressedCallback → JS 派发 `melodex:systemback` → JS `preventDefault` 表示已消费),栈空时 `moveTaskToBack` 而非 `finish()`(后者会中断播放并丢 MediaSession)。
- **react-query 全局关 `refetchOnWindowFocus`/`refetchOnReconnect`**(App.js QueryClient defaultOptions):否则切窗口再聚焦会自动重新搜索 + 重新验活。

## 主题系统:Fluent Design 深浅两档(2026-11 重做)

全站只有 **Fluent Design 一套设计语言**,Spotify 暗色皮肤已彻底移除(用户明确要求)。
用户选的是**模式**(`system` / `light` / `dark`,默认 system),写到 `<html data-theme>` 的
是**解析后**的 id(`fluent-light` / `fluent-dark`)。组件只读 token,永远不知道用户选了什么模式。

### 文件分工
- `src/theme/themes.js` —— 纯数据/纯函数:模式清单、`resolveThemeId(mode, prefersDark)`、
  44 个必填 token、Storage 读写、旧值兼容。**全站唯一的解析处**。
- `src/theme/ThemeContext.jsx` —— React 态 + matchMedia/原生桥订阅 + 写 data-theme。
- `src/index.css` —— 两个变量块(`:root`/`fluent-light` 与 `fluent-dark`)。
- `index.html` 内联脚本 —— 首帧解析(异步拿不到原生值,只能用 matchMedia,见下)。

### 两档的三处非直觉差异(改配色前必读)
1. **层级方向相反**:深色越上层越亮(`#212121`→`#2C2C2C`→`#333`),浅色越上层越白
   (`#F3F3F3`→`#FAFAFA`→`#FFF`)。浅色照抄深色,白卡片会淹没在白底里。
2. **强调色不能跨模式复用**:Win11 深色是浅蓝 `#60CDFF`、浅色是深蓝 `#004F99`。
   浅色用浅蓝配白字只有 1.6:1(看不见);深色用深蓝压深底同样看不清。
3. **Mica 渐变方向相反**:深色"提亮"、浅色"压深",两套渐变不能互换颜色。

### ★ 「跟随系统」在 APK 里必须靠原生 uiMode(踩了很久)
**现象**:系统浅色、外观选「跟随系统」,页面却渲染成深色;手动选浅色立刻正常。
**根因**:APK 是外壳 + `server.url` 加载远端站点,此形态下
`matchMedia('(prefers-color-scheme: dark)')` **报告的与系统实际不符**(系统浅色它报 dark)。
**修法**:`SystemThemePlugin.getSystemTheme()` 读 `resources.configuration.uiMode`,
Android 上优先用它并订阅 `onConfigurationChanged`;Web 端仍用 matchMedia(浏览器里可靠)。
**首帧例外**:原生是异步的,等它回来页面已画完,所以首帧脚本只能用 matchMedia 猜一次,
挂载后立即纠正 —— 可能有一瞬跳变,但最终一定正确,比"首帧等异步白屏"好。

配套的原生侧两件事(缺一不可):
- `res/values/colors.xml` + **`values-night/`** 各一套窗口底色(此前只有写死的暗色、无 night 变体,
  导致 WebView 连底层依据都是暗的);
- `MainActivity` 设 `isAlgorithmicDarkeningAllowed = false`(API 33+)/
  `forceDark = FORCE_DARK_OFF`(API 29~32),**关掉 WebView 自己的算法反色** ——
  否则它会对我们精心调好的浅色页面强行反色,把对比度全毁。

### 验证与门禁(`npm run test:theme`,三套)
- `themeContract.test.mjs` —— 3 模式 → 2 主题、每块 44 token 齐全、
  index.css 无旧皮肤选择器、index.html 首帧脚本与注册表规则一致、旧值映射。
- `themeContrast.test.mjs` —— **两档各 20 组前景/背景配对做 WCAG AA 计算**,
  共 40 项。这是能机器验证的硬指标,改动配色后必须跑。
- `fluentMotion.test.mjs` —— 见下节。
- 设置页外观区有一行**诊断输出**(只在"原生值与 matchMedia 不一致"时显示),
  排查此类问题一眼定位,别再去两套颜色之间猜。

### 动效系统(2026-11)
五档 `.fluent-*` 类:切页(`-page-enter`,6px 上浮)、列表项(`-item-enter`,**最多 8 项**后一起出现
—— 不封顶时上百项列表的最后一行会延迟 2 秒才出,看着像卡死)、浮层(`-flyout-in`,缩放而非位移,
已替换 TopBar/Dialog/Menu/确认框;Toast 保留原动画因它是边缘滑入)、按下(`-pressable`,scale 0.98)、
导航项(`-nav-item`)。

三条纪律(`fluentMotion.test.mjs` 强制):一律 `transform`/`opacity`(**禁止** width/height/top/left,
逐帧重排会让低端安卓掉帧)、时长 ≤300ms、必须被 `prefers-reduced-motion` 覆盖。
该测试还**当场抓出过既有问题**:`loading-bar-indeterminate` 原本用 `left: -45%→100%` 做逐帧动画。

**切页动画必须配 `key={section/subPath}`**:否则 React 复用节点,animation 只在首次生效。

## 多用户隔离 + 两级 RBAC(2026-06 新增)

Melodex 从单管理员模型改造为**多用户 + 两级角色(admin/user)**。生产 music.9li.life 前面已有 Authentik SSO 守门,但后端拿不到 SSO 身份,故**自建多账号**(不依赖 SSO,可脱离 SSO 部署)。

### 数据模型(`backend/internal/web`,settings.db)
- **User 表**(`users.go`):username 唯一(大小写不敏感)/bcrypt 密码哈希/role(admin|user)/disabled。完整 CRUD + **最后管理员保护**(不能删/降级/禁用最后一个 admin)。
- **Collection.UserID**:歌单按 user_id 归属;SavedSong 经 Collection 归属。所有歌单查询经 `loadOwnedCollection(id, userID)`,跨用户访问按 404 处理(不泄露存在性)。
- **DownloadRecord 表**(`download_record.go`):下载**共享同一目录**(DownloadDir 全局),按 user_id 记录"谁下了哪个文件(relPath)"。本地库据此按用户过滤:普通用户只见自己下过的,管理员见全部。同首歌多人下只占一份盘。`GET /music/downloads` 返回当前用户可见且磁盘仍存在的记录(`Cache-Control: private, no-store`),前端 `ServerDownloadsContext` 据此在刷新/重进后恢复 SongRow 的「服务器」状态；查询缓存 key 必须带 user_id 防换账号串状态。音质升级替换扩展名时须把旧路径的**全部用户归属**迁到新路径,不可只保留本次下载者。
- **userPrefRow 表**(`user_prefs.go`):仅 `disableFloatingLyrics`/`webPageSize` 两个**展示类偏好**按用户隔离;下载目录/并发/文件名模板/embed/更新/代理为**系统级全局**(仅管理员可改)——避免每人不同文件名模板破坏共享目录去重。
- **「我喜欢」歌单**(`favorites.go`):每用户默认一个 kind=favorite 的 Collection(`ensureFavoriteCollection` 注册时建/懒建,OnConflict 并发安全 + 部分唯一索引 `idx_fav_user ON collections(user_id) WHERE kind='favorite'`,InitDB 内 `ensureFavoriteUniqueIndex` 建前去重)。`POST/GET /music/favorites/toggle|status` 收藏/查状态;不可删(DELETE collection 拦 kind=favorite);默认歌单列表含 favorite(侧栏可见)。
- **搜索历史**(`search_history.go`):`search_history_rows` 按 user_id 隔离,uniqueIndex(user_id,keyword) 去重更新时间,每人留 50 条,链接不入。`GET/DELETE /music/search_history`。前端 Download 页未发起搜索时显「最近搜索」chips。
- **搜索结果缓存**(`search_cache.go`,全局不隔离):key=sha1(type|keyword|exactArtist|sources排序),TTL 24h,空结果/链接不缓存,行数上限 5000 + 5min 节流 GC。坐实命中 1.7ms(首查 1.5s)。

### 鉴权(`auth.go` / `auth_api.go`)
- session payload 含 UserID,全局 HMAC 签名密钥惰性生成存 `WebAuthSettings.SessionSecret`。`authRequired` 注入 userID/role/username 入 gin.Context(**绝不信任前端传的 user_id**),`adminRequired` 非管理员 403。
- **会话可吊销**:User.SessionEpoch 嵌入 session payload,`setUserPassword` 改密码时 epoch+1 → 旧会话全失效(改密码即登出所有设备)。`authenticateRequest` 比对 epoch/用户名/disabled。
- **安全加固(2026-06 审计后)**:bcrypt + 登录失败限流(username|IP)+ 时序防护(不存在用户跑 dummy 哈希);密码 ≥8 位 + 弱密码黑名单;setup 一次性 token(HTML 与 JSON `/api/v1/auth/setup` 都校验 setup_token,防首次部署抢注 ROOT);cookie Secure 读 X-Forwarded-Proto;CORS 同源+env 白名单不反射任意 Origin;SSRF cover/download_cover 走 isPublicHTTPURL + fetch client CheckRedirect 每跳校验;本地音频流 serveLocalMusicDownload 校验归属(非管理员只取自己下过的否则 404);搜索 per-IP 限流;安全响应头中间件。详见 [安全审计 memory] 与「部署」节安全 env。
- **路由分级**:`bindAuthMiddleware` 返回 `adminAPI`(登录+管理员:cookie/系统设置/QR登录/用户管理)与 `userAPI`(仅登录:歌单/收藏/本地库)。音乐数据路由(搜索/播放/歌词/歌单/本地库)默认要求登录;仅健康检查、登录/setup/register 与静态前端公开。桌面模式由 `desktopUserMiddleware` 注入本地管理员。
- **JSON 鉴权接口**:`/api/v1/{me,auth/setup,auth/login,auth/register,auth/logout}` + `/api/v1/admin/users/*` + 开放注册开关(默认关,KV `allow_registration`)。HTML `/music/setup`/`/music/login` 也改查 User 表。
- **安全**:bcrypt 登录时序防护(不存在用户也跑假哈希)、登录/注册失败限流、禁止自删/自降/自禁、删用户级联清歌单+下载归属。
- **桌面模式**(`--desktop` / DisableAuth):`desktopUserMiddleware` 注入本地管理员 `local` 免登录,数据仍按 user_id 归属(单用户兜底)。
- **平台会员 cookie 全局共享**(房主一个会员号,多人共用),仅管理员可配置——这是有意决策,不按用户隔离。

### 迁移(`migrateRootUserAndOwnership`,InitDB 内幂等)
- 既有单管理员部署:复用旧 `WebAuthSettings` 的密码哈希创建 ROOT(role=admin),**绝不凭空造管理员密码**,全部存量 collection backfill 归 ROOT。全新部署:无用户,首次 setup 即 ROOT。

### 前端(`frontend/src`)
- `contexts/AuthContext.js`:启动拉 `/api/v1/me` 判登录态;未登录渲染 `AuthGate`(setup/login/register 三模式),登录后渲染主应用。全局 axios 401 拦截器派发 `melodex:unauthorized` 事件,AuthProvider 监听后重新鉴权(会话过期自动切登录页)。
- `components/UserManagement.js`(#users,仅管理员):用户 CRUD + 开放注册开关。Sidebar 底部显示当前用户+登出+(管理员)用户管理入口。Settings 的账号登录/Cookie 区块仅管理员可见。
- **重要行为变化**:数据接口现在**需要 Melodex 登录**(原来公开无鉴权,纯靠 SSO);生产上等于 Authentik SSO + Melodex 登录双重门。

### 验证(2026-06 真机端到端)
- 后端单测覆盖:用户CRUD/最后管理员保护/legacy迁移幂等/下载归属交叉隔离/session验签/RBAC边界/跨用户歌单隔离/偏好隔离,全过零回归。
- 真机 curl 端到端(本机二进制 + 临时 settings.db):setup ROOT→建user→各自建歌单→交叉访问验隔离(alice 对 root 歌单读/删全 404,root 歌单不受影响)→普通用户改cookie/列用户全 403→管理员可→禁止自删/自降→开放注册后可自助注册role=user→本地库 admin 见全部/user 无归属见空→桌面模式 desktop:true 免登录。

## 封面显示 + 三层缓存(2026-06 新增)

- **列表封面真相**:搜索结果 `song.cover` 后端**早已填好真实 URL**(QQ y.gtimg.cn / 网易 p1.music.126.net 实测都有),SavedSong 也存 cover;列表没封面纯属**前端 SongRow 没渲染**。已加 40×40 `CoverThumb`(SongRow),搜索/歌单详情共用。
- **必须走 cover_proxy**:网易封面是 `http://`,生产 https → 前端直接 `<img>` 会被浏览器拦混合内容;且源站防盗链。前端 `coverProxyUrl(song)` 统一包装 `/music/cover_proxy?url=&source=`,空 cover 显 lucide Music 占位(lazy + onError 回退)。
- **封面磁盘缓存**(`core/cover_cache.go`):`GetCachedCover` 查 `data/cache/covers/<sha1(url)>.<ext>` 命中直接返回,未命中回源落盘。Cache-Control 7天,512MB 软上限按 mtime LRU 清理(10分钟节流)。缓存读写失败不阻断(回退回源)。`data/cache/` 随 data 卷持久化。坐实命中 ~47ms。
  - **只缓存真图片**(Review 补漏):落盘前过 `isLikelyImage`(content-type 为 image/* **或**字节 magic 匹配 JPEG/PNG/GIF/WebP/BMP)且 ≤8MB 才写。原因:上游(QQ/网易)防盗链/限流常返回 HTML 错误页,200 但不是图片,若直接落盘会被 7 天 TTL 固化→所有人拿到坏图。非图片仍透传给调用方(不改行为)但不污染缓存。
- **搜索结果缓存**(`search_cache.go`,SQLite):`search_cache_rows` key=sha1(type|keyword|exactArtist|sources排序),存完整 JSON(含 cover/bitrate 全元数据),TTL 24h。**空结果不缓存**、**链接解析模式不缓存**,全局共享不隔离。坐实首次 1.51s→命中 1.7ms。
- **用户搜索历史**(`search_history.go`,按 user_id 隔离):`search_history_rows` uniqueIndex(user_id,keyword) 去重更新时间,每人留 50 条,链接不入、userID=0 跳过。`GET/DELETE /music/search_history`(userAPI 仅登录,DELETE 带 keyword 删单条/不带清空)。前端 Download.js 未发起搜索时显「最近搜索」chips。
- **接线坑**:`jsonSearchHandler` 在公开 `/api/v1` 组,要让登录用户搜索记入历史 → 给 `/api/v1` 挂 `attachUserOptional`(非阻塞,匿名照常,桌面注入 local)。InitDB AutoMigrate 加两表(幂等)。

## 桌面客户端:Tauri 2 包裹 PWA(2026-11,阶段 1~3 已完成)

电脑端主力形态是**用一个 Tauri 2 壳包裹线上 PWA**,不再维护第二套原生 UI。
方案与阶段 0 实测证据见 `docs/desktop-shell-plan.md`;发布与自动更新见 `docs/desktop-release-updater.md`。

### 结构(`desktop/src-tauri/src/`,已按职责拆模块)
- `main.rs` 只管装配:注册单实例/自启/快捷键/更新插件、建三个窗口、接窗口事件。
- `service_url.rs` **站点地址解析 + 导航白名单**(纯函数,改这里必须保持 11 个测试绿)。
- `main_window.rs` 主窗口:加载线上站点、`on_navigation` 护栏、关闭拦截为隐藏。
- `overlay.rs` 透明歌词窗;`settings_window.rs` 桌面歌词设置窗(关闭只隐藏)。
- `tray.rs` 托盘菜单(**含歌词显示/锁定两个勾选项,与设置双向同步**);`autostart_support.rs` 开机自启;
  `shortcuts.rs` 全局快捷键;`updates.rs` 自动更新;`device.rs` 配对凭据(历史保留)。
- `lyrics_settings.rs` **歌词用户设置唯一真相源**(8 套配色/6 种字体/字号/显示/锁定/位置);
- `commands.rs` 暴露给本地页的 IPC 命令;`logging.rs` 同时写 stderr 与文件。
- 前端薄桥:`frontend/src/platform/desktopShell.js`(`npm run test:desktop-shell`,17 项契约测试)。

### 桌面歌词:壳内直连(2026-11 重做,配对流程已删)

**旧设计已废弃**:原方案是「浏览器 → 服务器 hub → 独立歌词助手」,跨进程所以需要
一次性配对码 + 设备令牌。新客户端里**播放与歌词窗同进程**,那套配对纯属历史包袱,
表现为「必须先配对才能看歌词」的体验断裂。已删除。

> **2026-11-24 补删:后端那套中转服务本体也清掉了。**
> 那次「已删除」只删了客户端的配对流程(界面 + PrismQML),后端 1051 行仍在:
> `desktop_lyrics_auth.go`(345,配对/设备令牌/WS 握手)+ `desktop_lyrics_hub.go`
> (441,浏览器↔设备的消息路由)+ `desktop_lyrics_test.go`(265)。
> `server_routes.go` 还挂着 `RegisterDesktopLyricsRoutes`,`/api/v1/desktop-lyrics/*`
> 与两条 WebSocket 端点一直对外可访问;**前端三个配对 API 零调用点**,等于一整块
> 没有人用的服务面在线上开着。现已整体删除,连带 `DesktopLyricsDevice` 表也移出
> AutoMigrate(`users.go` 里那 4 处删表 + 4 处断连一并清理)。
>
> **Rust 侧的 `pair_device` / `clear_pairing` 命令仍在**(那是另一回事:Tauri 本地
> IPC,为兼容历史凭据保留,build.rs/capabilities 三处对齐)。不要把它们和上面这批
> 已删的后端 HTTP/WS 服务混为一谈。

**现设计**(`desktop/src-tauri/src/lyrics_bridge.rs`):

```
主窗口页面 ──invoke('lyrics_push_state')──▶ Rust ──emit──▶ 歌词窗渲染
歌词窗按钮 ──invoke('lyrics_send_command')──▶ Rust ──eval event──▶ 主窗口页面
```

- 前端薄桥:`frontend/src/platform/desktopShell.js` 的 `pushLyricsState` /
  `attachLyricsCommandBridge`;`PlayerContext` 里 track 变化推整包、250ms 推 progress。
- 歌词窗 `desktop/ui/overlay.js` 改为 `listen('melodex:lyrics-state')`,不再连 WebSocket。
- **开箱即用**:无配对码、无服务器中转、断网也能显示歌词。

**★ 权限必须双向对齐(踩过,很隐蔽)**
启用 `build.rs` 的 `app_manifest` 后,**只对声明的命令生成 allow 权限**,
漏掉的命令等于「任何窗口都调不了」,症状是歌词窗永远不显示。
所以 `build.rs` 的 `commands()` 必须与 `main.rs` 的 `generate_handler!` **逐条对齐**,
新增命令时两处都要改。当前 15 条:
`public_device_config / connection_config / pair_device / clear_pairing /
set_overlay_visible / start_overlay_drag / get_click_through / overlay_position /
set_overlay_position / lyrics_settings_get / lyrics_settings_update /
lyrics_reset_position / lyrics_save_position / lyrics_push_state / lyrics_send_command`。

**这条现在有机器门禁**:`npm run test:shell-commands`
(`desktop/scripts/shellCommandManifest.test.mjs`)解析三处并要求集合相等:
`generate_handler!` ↔ `commands()` ↔ `capabilities/*.json` 的 `allow-*`。
漏一条立刻红并指名道姓;它还守着远程 IPC 面白名单(见下)+ 窗口归属两条底线。

**安全边界(两档)** —— 以下与 `capabilities/*.json` 实际内容一致,**以文件为准**:

- `capabilities/default.json` → 只覆盖本地窗口(`overlay`/`settings`),含全部 13 条本地命令。
- `capabilities/lyrics-bridge.json` → 覆盖 `main` + `remote.urls`(生产站点 + 本机回环),
  实际授予 **5 条命令 + 2 条 `core:event`**:

  | 权限 | 为什么给远程 |
  |---|---|
  | `lyrics_push_state` | 把「在放什么歌」告诉本机歌词窗 —— 本来就是它要显示的内容 |
  | `lyrics_send_command` | 歌词窗上的播放/上下首按钮要把命令回传给主窗口 |
  | `lyrics_settings_get` | 主窗口设置页要读本机歌词偏好(字号/配色/字体/位置) |
  | `lyrics_settings_update` | 主窗口设置页要改上面这些偏好 |
  | `lyrics_reset_position` | 设置页「恢复默认位置」 |
  | `core:event:allow-listen` / `allow-unlisten` | 上面这些回传都靠 Tauri event,没有这两条收不到 |

  **它们的语义自限**:全部只作用于「本机歌词窗的显示偏好与播放状态」,
  不接受任意路径 / URL / 命令名,也不触碰文件系统、网络、进程。最坏情况是
  「远程页面改了歌词字号或位置」,而那本来就是它自己该显示的东西。

  ★ **`lyrics_settings_update` 的 patch 含 `position_x`/`position_y`** ——
  也就是说远程页面**确实能把本机歌词窗挪到任意坐标**。这是既有实现,
  与被判为「本地窗口专用」的 `set_overlay_position` 语义重叠。当前接受这一扩张
  (设置页在主窗口、迁移到本地设置窗成本更高;且歌词窗本就在用户自己屏幕上);
  但**新增任何一条权限都必须在此表和 `ALLOWED_REMOTE_COMMANDS` 里显式登记**,
  让评审必须看见 —— 这是刻意的摩擦。

- **不得**给任何远程 origin 开文件/网络/进程类权限或 `core:*` 中除
  `event:allow-listen`/`allow-unlisten` 以外的能力。

- 设置窗(原配对窗)**不自动弹出**,需从托盘「桌面歌词设置…」打开。
  配对命令(`pair_device`/`clear_pairing` 等)为兼容历史凭据保留,但设置页已不再提供配对 UI。

### 桌面歌词设置(2026-11 补齐,旧实现的 6 项)

`lyrics_settings.rs` 是**唯一真相源**(落 `desktop-lyrics-settings.json`),三个窗口共用:

```
歌词窗/设置窗/托盘 ──invoke('lyrics_settings_update', {patch})──▶ Rust ──写盘 + emit──▶ 全部窗口同步
```

- **为什么不用 localStorage**:设置要被三个窗口同时用,窗口间不共享内存,
  localStorage 会各写各的、还会随窗口销毁而丢。**不要再往 `overlay.js` 加 localStorage。**
- 8 套配色 / 6 种字体清单只存在 Rust 侧(`COLOR_SCHEMES` / `FONT_PRESETS`),
  有单测逐条对照 `desktop-prismqml/melodex_desktop/config.py`;**JS 侧不得再抄一份**。
- 更新走**补丁语义**(只传改动字段),避免设置页各项互相覆盖、也避免以后加字段时被默默重置。
- 写盘失败时**不改缓存、不广播**,让 UI 能如实回滚 —— 不许出现「界面改了、实际没保存」。
- **「关闭歌词」必须走持久化开关**(`visible`),不能复用 `set_overlay_visible`:
  后者每次播放状态推送都会被 `render()` 重设回 true,接上就是「关掉又自己弹出来」。
- 托盘两个勾选项(显示桌面歌词 / 锁定桌面歌词)与设置**双向同步**;
  关掉歌词后可从托盘或设置页重新打开(但旧 PrismQML 有同样的托盘项,别删)。

### 三条不可退让的规则
1. **远程页面的 IPC 面只能是「歌词桥」那 5 条 + 2 条 event**。`capabilities/default.json`
   只列 `overlay`/`settings` 本地窗口;`capabilities/lyrics-bridge.json` 只给 `main` +
   `remote.urls` 开 `lyrics_push_state` / `lyrics_send_command` /
   `lyrics_settings_get` / `lyrics_settings_update` / `lyrics_reset_position`
   与 `core:event:allow-listen` / `allow-unlisten`(完整清单与逐条理由见上面那张表)。
   **禁止**给任何远程 origin 开文件/网络/进程类权限,也禁止 `core:*` 里除这两条 event 外
   的任何能力。**新增一条必须同时改实现、`ALLOWED_REMOTE_COMMANDS` 和上面那张表。**
2. **导航白名单**。只允许站点同源与登录网关(`auth.<父域>`,且父域限 `9li.life`)同源;
   其余外链交给系统浏览器。禁止为了"方便"把 `on_navigation` 改成恒 `true`。
3. **关闭 = 隐藏到托盘,只有托盘「退出」才真退出**。`allow_exit()` 是唯一出口。
   **例外**:自动更新安装前必须调 `allow_exit()`,否则进程赖在托盘会让安装器覆盖不了文件。

### 实测结论(2026-11-22 真机,已不是推测)
- **媒体键走内核直通,不要另写 SMTC**。物理媒体键 → Windows SMTC → WebView2 → 页面
  `mediaSession` handler 全链路实测通过(`handler-pause/next/prev/stop`)。
  前端 `PlayerContext.js` 的 MediaSession 逻辑**保持原样**,壳不需要做任何事。
- **媒体键只作用于当前活动的媒体会话**。应用暂停且系统里另有 Playing 会话时按键会被那个会话接走,
  这是 Windows 语义,不是缺陷——验收与排查不要当 bug 修。
- **远程 origin 的 Service Worker 在 WebView2 里正常工作**(`controller=.../sw.js`),
  所以**不要**在壳里另起本地 HTTP 服务做离线兜底。
- **全局快捷键实测通过**:`Ctrl+Alt+Space`/`Left`/`Right` 分别映射 toggle/prev/next,
  日志可见 `global shortcut control+alt+Space -> toggle` 等。实测脚本在
  `desktop/prototype/scripts/send-shortcut.ps1`(用 keybd_event,不用 SendInput——
  后者在 PowerShell 里手搓 INPUT 联合体极容易算错 cbSize,实测直接返回 0)。
- **真实站点形态已二次取证**(第二轮,加载 `https://music.9li.life/` 而非本地探针页):
  `hasMediaSession/hasMediaMetadata/hasSetPositionState` 全为 true;
  壳派发的 `melodex:shell-shortcut` 事件 `received:true`(薄桥链路成立);
  硬件媒体键 `handler-play/pause/next` 均到达。**媒体键在真实页面已不是推断。**
- 原 PrismQML 客户端过不去 Authentik SSO(`ApiClient.cpp` 里已有"被前置登录网关拦截"文案),
  这是本次重做的直接原因。

### 自动更新的现状(重要,别误判)
壳已接 updater:启动 8s 后静默检查 + 托盘「检查更新…」交互式更新。
但 **`https://music.9li.life/desktop/latest.json` 尚未部署**,后端 SPA fallback 会返回 HTML 首页,
于是每次检查只记一条 `[WARN] update check failed: 检查更新失败：error decoding response body`。
**这是预期状态,不是缺陷**。部署清单后即恢复;`/desktop/` 路径必须绕过 SPA fallback 且 NPM 放行 SSO。
清单由 `desktop/scripts/build-updater-manifest.mjs` 生成(10 项契约测试)。

**「检查」这一段已端到端验证(2026-11-22)**:壳支持 `MELODEX_UPDATER_ENDPOINTS` 运行时覆盖端点
(逗号分隔)。配合 `desktop/prototype/scripts/serve-manifest.ps1` + `fixtures/latest.json` 实测:
服务端收到 `GET /latest.json`,壳日志出现 `update available: 9.9.9`。
**release 构建硬约束**:更新器拒绝非 https 端点(实测警告 `will fail in release builds`),
该 http 覆盖只用于本机调试;正式发布必须 https。
**仍未验证**:无真实签名产物,「下载→安装→版本号变化」没跑过。

### 依赖版本纪律(踩过)
`tauri-plugin-single-instance` 固定 **2.4.5**、`tauri-plugin-autostart` 固定 **2.5.1**、
`tauri-plugin-global-shortcut` 固定 **2.3.2**、`tauri-plugin-updater` 固定 **2.12.0**。
更高版本(如 single-instance 2.5.x、updater 2.13+)要求 `tauri ^2.12`,与锁定的 `tauri 2.10.1` 冲突。
**升插件必须同步升 tauri**,并重新核对该插件对 tauri 的 req。

### 门禁
```powershell
cd desktop/src-tauri
cargo fmt --check
cargo test --locked          # 当前 47 项
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked
cd ../ui; node lyricsSettings.test.mjs && node lyricsCore.test.mjs   # 36 项 + 核心 9 项
cd ../../frontend
npm run test:desktop-shell     # 17 项
npm run test:desktop-lyrics    # 36 项（设置契约）
npm run test:shell-commands    # 命令清单三处对齐 + 远程权限边界
node ../desktop/scripts/build-updater-manifest.test.mjs  # 10 项
```
日志落 `%LOCALAPPDATA%\life.9li.melodex.desktoplyrics\logs\shell.log`;
**日志不得记录设备令牌或带签名的播放地址**。

### 桌面歌词 1:1 复刻(2026-11-23,修掉四处真实缺陷)

对照旧 PrismQML(`DesktopLyricsWindow.qml` / `WordFill.qml` / `cpp/Lyrics.cpp`
/ `config.py` / `SettingsPage.qml`)逐项校准。**这些坑构建和类型检查都不会报**,
只有人眼能发现,所以每一条都补了机器门禁:

1. **CSS 类名与 HTML 对不上** → 整条定位规则被丢弃。CSS 写 `.lyric-row`、
   HTML 用 `class="lyric-line"`,于是三层退化成普通流式块,`top`/`transform`
   失去参照,歌词叠在一起、切行动画完全看不出。**改选择器务必先 grep 一遍 HTML。**
2. **新行入场方向反了**:旧版 `incomingActiveY - activeLineY` =
   `(主行高+副行高)/2`(字号36 → **+47px,从下往上升**);曾写成
   `副行高-主行高`(-18px),变成从上方掉下来。
3. **主行顶部偏移少了 32px**:旧版 `activeLineY = lyricSurface.y(32) + 12 = 44`,
   曾写成 12 → 整块歌词上移,悬停控制条(`top:0` 高 38)**直接压住歌词**。
4. **双击空白处关闭歌词缺失**:旧版 `WindowDragHandle.onDoubleClicked →
   setLyricsVisible(false)`。补 `dblclick` 时要排除 `.controls`,
   否则双击「上一首」会关掉歌词。

同时补齐旧版有、新版缺的行为:

- **行索引必须回退到同一时间戳分组首行**(`Lyrics.cpp:122-127`)。LRC 里合唱/
  翻译常同戳多行;只取"最后一个 `t<=pos`"会停在组末,表现为合唱先亮最后一行。
- **副行独立字号适配**(`DesktopLyricsWindow.qml:462-464`):旧版副行有自己的
  `Text.Fit` + 下限 `max(14, 主行最小-4)`。复用主行缩放系数会让
  「主行短 / 副行长」时副行溢出。
- **副行左右各多缩 8px**(旧版 margin 42 vs 主行 34);`.adjacent` 曾有两处
  重复定义且属性重叠,已合并。
- **行可用宽度 = 窗口宽 - 92**(lyricSurface 内缩 12 + 行内 margin 34),
  与旧版排得下同样长的句子;CSS `padding` 与 JS `LINE_HORIZONTAL_PADDING`
  由门禁绑定,改一边必须改另一边。
- **窗口几何随字号联动**:旧版是 QML 绑定表达式,Web 侧没有这层,必须显式调用。
  宽 `min(920, max(640, 屏宽-96))`、高 `46 + (字号+20) + (副行字号+14) + 18`;
  改字号后 `apply_window_geometry` 重算尺寸并 `clamp_to_visible_area`
  (对应旧版 `onHeightChanged → clampToVisibleArea`)。
- **位置保存前先 clamp**(旧版每次坐标变化都夹)。否则拖到屏幕外后存下的坐标
  会让歌词"重启后消失"。为此新增本地命令 `overlay_clamp_position`
  (**仅本地窗口**;远程白名单不变 —— 仍是那 5 条 + 2 条 event,见上面的权限表)。
- 纯逻辑核心抽到 `desktop/ui/lyricsCore.js`,数值行为由 `lyricsCore.test.mjs`
  逐条对照 `cpp/Lyrics.cpp` 锁死。

### 桌面歌词重做(2026-11-23 第二轮,用户报「一坨屎」后整块重写)

用户一次性点了五条:空框挡鼠标 / 文字难看(糊、白边、重影) / 逐字填色不对 /
切行动画不对 / 双行结构不对。**逐条都拿到了真机证据**,不是照着感觉改。

#### 五个真实根因(全部有实测数据)

1. **「整行一次性亮」—— 填色进度拿到的是残缺行对象。**
   `render()` 曾写 `renderCurrentLine({ text: mainText }, position)`,
   而函数内部又调 `lineProgress(line, position)`。这个 `line` 只有 `text`,
   没有 `t`/`end`/`words`,于是走无 words 分支:`start=0`、`end=0+5=5`,
   `progress = clamp((pos-0)/5)` —— **播放 5 秒后恒为 1**,逐字填色等于不存在。
   修法:把「换行/换字」与「唱到哪了」彻底分成两个函数
   (`renderCurrentLine` 只写文字,`updateFillProgress` 只写进度),
   进度用 `playback.lyrics[renderedLineIndex]` 这个**真实行**。

2. **「没放歌时留一个看不见的空框挡鼠标」—— 可见性只看用户开关。**
   真机实测:窗口 535×158、`TOPMOST=true`、`WS_EX_TRANSPARENT=0`(不穿透)、
   内容全透明 —— 屏幕上什么都没有,却实实在在挡住下面的窗口。
   修法对齐 `desktop_state.py:40-48` 的
   `should_show = lyricsVisible and bool(current_song.id)`:
   `setOverlayVisible(Boolean(settings.visible && playback.track))`。
   ★ 判据必须是 `playback.track`,**不能**是 `hasState`(暂停时会消失)
   或 `hasLyrics()`(纯音乐会完全不显示)。

3. **「两行字直接重叠」—— 行坐标被多加了 32px。**
   QML 里 `WordFill`/`secondaryLyric` 只 `anchors.left: lyricSurface.left`,
   **没有 anchors.top**,它们的 parent 是 Window 内容项 ——
   所以 `y: activeLineY`(44)是**相对窗口顶部**的绝对坐标。
   第一版把三层放进 `top:32` 的容器里,主行实际落在 32+44=76
   (CDP 实测 `wrapRect.y=76`),副行被窗口底边切掉、看起来像重叠。
   修法:`.lyrics-shell { top: 0 }`,只提供左右边界。

4. **「逐字填色断在半路 + 重影」—— 先量宽度、后改字号。**
   `applyLineGeometry` 原来先 `measureLineWidth()` 再
   `setProperty('--line-font-scale')`,量到的是**上一个字号**下的宽度:
   实测 `--text-width` 停在 160px(旧字号 20px 时),而新字号 35px 下真实需要
   281.5px → ① 裁剪区只覆盖文字左半边,粉色断在半路;
   ② `textLeft=(292-160)/2=66px`,比真实的 5.25px 偏 60px,裁剪区整体右移
   → 与底层文字错开,看起来像重影。
   修法:**先写字号,再量宽度**(`Range.getBoundingClientRect` 会强制同步布局,
   紧接着读就是新字号下的真实宽度,不需要 rAF 等一帧)。
   ★ `--line-width` 必须是**整行宽度**,不是文字宽度 —— 写成文字宽度会让短句的
   上层被压窄再居中,同样错位。

5. **窗口宽度异步变化后几何不重算。** `--line-width` 停在"窗口还没变宽"那一刻
   的值(实测 164px,而实际行宽 292px)。修法:`render()` 每帧调
   `refreshRenderedGeometry()`,靠 `(文字|缩放|可用宽)` 签名去重,
   稳定态只做字符串比较、不碰 DOM。

#### 视觉细节按 QML 逐项校准(之前"难看"的来源)

- **阴影 blur 必须为 0**:QML `lyricShadowBlur = 0`、垂直偏移 1px。
  曾写 `text-shadow: 0 1px 2px`(blur 2px)—— 那是「字发糊」的直接原因。
- **letterSpacing 必须是 0**:QML 显式写 0。曾写 `0.01em`,
  实测同一句差 13.33px(`0.01em × 36px × 37字`),这也是当年
  「canvas 与 DOM 量宽差 2%」的真正来源。
- **描边 `paint-order: stroke fill`**:让填充画在描边之上,视觉等于"描边在外"。
- **新行入场缩放 = 副行字号 / 主行字号**(QML `incomingActiveScale`),
  不是常数 0.67:字号 20 时是 16/20 = 0.8,64 时是 43/64 ≈ 0.672。
- **`nextText` 回退到歌手名是无条件的**(QML `nextLine ? text : artist`):
  唱到最后一行时副行显示歌手名。曾多判一层 `hasFrame` 导致副行空掉。

#### 门禁(这次新增的)

- `desktop/ui/desktopLyrics.runtime.test.mjs`(**4 项,运行期**):
  用最小 DOM/Tauri 桩把 `overlay.js` **真的跑起来**,断言
  ① 填色进度随位置变化(0.25→0.75,不是恒 1);
  ② 无歌时 `set_overlay_visible(false)`;③ 有歌时 `true`;
  ④ 换行后主/副行文字取对。
  **静态断言看不出前两条** —— 代码"看起来调用了 lineProgress"照样是错的。
- `lyricsSettings.test.mjs` 从 36 项扩到 **43 项**,新增 6 条锁上面每个根因:
  填色必须用真实行对象 / 几何签名含可用宽 / 变量写在各自 wrap 上 /
  入场缩放按字号算 / 旧行结束后必须隐藏 / 同时间戳分组也算向前。
- 已接入 `npm run test:desktop-lyrics`。

#### 第三轮(2026-11-23 当晚,用户又抓出两条)

6. **「歌词向上滚动时粉字与白字分离,就几帧」—— 量宽被祖先 transform 缩放污染。**
   `Range.getBoundingClientRect()` 返回的是**被祖先 `transform: scale()` 缩放后**的尺寸,
   而这个测量发生在切行动画期间 —— 主行正在 `scale(0.67 → 1)`。
   CDP 现场量(动画各阶段):
   ```
   progress=0    transform=matrix(0.667,...)  raw=199.15px
   progress=0.5  transform=matrix(0.833,...)  raw=248.94px
   progress=1    transform=matrix(1,...)      raw=298.73px
   ```
   动画期间只量到真实宽度的 **2/3** → `--text-width` 偏小 → 粉色裁剪区提前截断、
   右边露出白字;`--text-left` 也偏 → 两层横向错开。
   因为动画只有 300ms,用户看到的就是「就几帧」。
   修法:新增 `accumulatedScale()` 向上遍历祖先累乘 `matrix()` 的缩放,
   `measureLineWidth()` 返回 `rect.width / scale`。
   验证:动画 0→1 全程 `--text-width` 恒为 334.73px、`baseVsActive=0`、
   裁剪区位置误差 0.01px。

7. **「一半着色一半没有」/「暂无歌词 四个字一半粉一半白」—— 占位行没被剥掉。**
   平台没歌词时会返回 `[00:00.65]暂无歌词`,它**带合法时间戳**。
   前端只有 `hasUsableLyrics()` 做"有没有真歌词"的判断,这条占位行仍留在数组里
   → 桌面歌词窗当普通歌词渲染,`lineProgress` 按 t/end 算出进度 → 整行或半行
   被涂成已播放色。
   修法:`playerLyrics.mjs` 新增 `stripPlaceholderLyrics()`,
   在 `parseLRC` 之后立即过滤;剥掉后数组为空 → 歌词窗按"无歌词"回退显示歌名/歌手名。

#### ★ 配色对比度:8 套里有 5 套几乎分不出已播放/未播放(设计遗留,不是 bug)

实测(WCAG 相对亮度比):

| 配色 | 已播放 | vs 未播放 #EEEEEE |
|---|---|---|
| 珊瑚绯 | #FFC6C6 | 1.28:1 |
| 暮霞 | #EEC1D1 | 1.37:1 |
| 樱雾 | #FDD6EB | **1.13:1** |
| 晴澜 | #C7E4F1 | **1.15:1** |
| 青芽 | #E6FAD0 | **1.05:1** |
| 藤影 | #E7E3FB | **1.08:1** |
| 杏月 | #FCE8C2 | **1.04:1** |
| 雾银 | #D3D2D2 | 1.30:1 |

这套色值是**照抄旧 PrismQML `config.py` 的**,不是本鱼选的;但 5 套配色下
「唱到哪儿」基本看不出来。**改色值是产品决策,必须先问用户**,
不要因为"对比度低"就擅自调整 —— 用户是按旧版样子验收的。

#### 第四轮(2026-11-23 深夜,用户一口气报了四条)

8. **「歌词一直在往右移动,得固定中心点往两边扩散」—— 窗口宽度随内容变。**
   之前窗口宽度跟着每行文字算("贴合内容"),CDP 实测连续三行:
   ```
   「眉目缱绻中 飘零」 窗口 360 → 文字中心 x=180
   「心之 所寄」       窗口 252 → 文字中心 x=126
   「劫数应声而起」     窗口 312 → 文字中心 x=156
   ```
   文字中心**始终等于窗口中心**(偏离 0),但窗口宽度变了 ——
   整块歌词在屏幕上横移 54px。窗口是独立原生窗口、位置由壳侧固定,
   只有宽度固定文字才能钉住。
   修法:前端 `syncWindowGeometry()` 只传 `contentWidth: 0`,
   壳侧 `fixed_or_content_width()` 见 0 就走 `overlay_width(屏宽)`;
   只在字号变化时同步一次。实测窗口恒定 920px、文字中心跨度 **0.0px**。
   **副作用**:透明区域会拦截鼠标 → 缓解办法是默认锁定/穿透(旧版行为)。

9. **「文本有锯齿」—— `-webkit-text-stroke` + `paint-order` 在 Chromium 里是坏的。**
   写 `paint-order: stroke fill`,实测 `getComputedStyle().paintOrder === "stroke"`
   —— **只解析第一个值**,于是描边画在填充**之上**,等于给每个字盖一圈 1px 黑边,
   字变脏、边缘发毛。叠加 DPR=1.5 时描边是 **1.5 物理像素**(非整数),必然发虚。
   修法:改用 **8 向 `text-shadow` 模拟外描边**(±1.2px 八方向 + 旧版那条 blur=0 硬阴影)。
   阴影永远在文字**之下**,天然等价于「描边在外、填充在内」,且不参与字形栅格化。
   A/B 截图验证:现方案字干净、描边确实在外。

10. **「动画不够平滑」—— 渲染循环是 `setInterval(render, 80)` = 12.5fps。**
    填色进度每 80ms 才前进一格,而显示器 60/120Hz,看到的就是一跳一跳的格子。
    旧版 PrismQML 用 `FrameAnimation`(跟合成器帧走),不是定时器。
    修法:`requestAnimationFrame(renderLoop)` 自递归 + `MIN_RENDER_INTERVAL_MS`
    节流到 ~60fps(高刷屏不空转)。

11. **切行动画去掉 `scale`(锯齿的另一个来源)。**
    原方案 `scale(0.667 → 1)` 让浏览器**每帧用新的非整数比例重新栅格化字形**
    (实测 0.6667 / 0.7 / 0.75 / 0.7767 / 0.8333 / 0.89 / 0.9167 / 0.9667),
    抗锯齿边缘每帧重算 → 抖动发虚。
    修法:文字**始终 `scale(1)`** 栅格化一次,只做 `translateY` + `opacity`。
    观感上仍保留「新行从副行位置升上来」的层次。
    ★ 同时**删掉 `will-change: transform`** —— 它会强制建合成层,
      文字在层里按半分辨率栅格化,反而更糊。

#### 配色对比度:用户明确要求**保持旧版原样**,不要再提

实测 8 套里 5 套已播放/未播放对比度仅 1.04~1.15:1(青芽 1.05、杏月 1.04)。
本鱼报告过,用户回答「不动,保持旧版原样」。**这是已决策项,不要重复建议改色。**

#### 第五轮(2026-11-23 深夜):硬描边 → 梯度光晕

12. **「字体描边太硬了,弄那种察觉不出来的很软的描边,用设计来描边」**
    上一轮为修锯齿把 `-webkit-text-stroke` 换成 **8 向零模糊阴影**
    (`±1.2px 0 0 rgba(...)`) —— 锯齿是没了,但**零模糊 = 硬边**,
    笔画转折处像被黑线勾了框,用户直接否掉。

    **先量化了"为什么非要有衬托"**:未播放色 `#EEEEEE` 的 WCAG 对比度
    ```
    纯白 #FFFFFF 1.16:1 ／ 浅灰 #F5F3F0 1.05:1 ／ 米白 #F0EDE8 1.01:1
    浅粉 #F4D8E8 1.14:1 ／ 浅蓝 #CFE3F5 1.13:1
    ```
    大字要求 ≥3:1 —— 也就是**完全看不见**。所以"干脆不加"这条路不通。

    **最终方案:4 层梯度光晕**
    ```css
    --lyric-outline-shadow:
      0 0 0.5px rgba(5,6,8,0.55),   /* 贴边:压住背景 */
      0 0 2px   rgba(5,6,8,0.42),
      0 0 4px   rgba(5,6,8,0.28),
      0 0 8px   rgba(5,6,8,0.16);   /* 外围:柔化过渡 */
    ```
    半径 0.5→2→4→8 递增、浓度 0.55→0.42→0.28→0.16 递减,
    从字形边缘向外**平滑衰减**,没有任何"边"。副行等比收小(0.5/1.5/3/6)。
    连带删掉不再使用的 `--outline-color` / `--shadow-color` 变量。

    A/B 实测过 6 种组合(单层轻阴影 / 双层 / 3 层 / 4 层 / 加落影 / 无描边),
    在纯浅底 / 花哨渐变底 / 深底三种背景上截图对比后选定。

#### 第六轮(2026-11-23 深夜):空格导致逐字填色跳字

13. **「逐字歌词有时候会跳着显示,主要在空格之后」—— 按字数加权 ≠ 按像素宽度。**
    旧实现(含旧版 `Lyrics.cpp:lyricProgress`)用 `Σ max(1, len(word.s))` 按**字数**加权,
    把空格也算成 1 整字。但空格的渲染宽度只有汉字的约 **1/4**,
    于是「字数进度」与「像素进度」对不上,填色位置在空格处突然跳一下。

    **实测偏差**(「眉目缱绻中 飘零 随风」,词时间均匀分布):
    ```
    按字数进度  0.454 / 0.727 / 1.000
    按像素进度  0.523 / 0.761 / 1.000
    最大偏差 0.66em(约 0.7 个字宽)
    ```
    而无空格的行两者完全一致(偏差 0.0001)—— 这解释了为什么问题总出在空格后。

    **修法**:`lyricsCore.js` 新增 `charWidthWeight()` / `textWidthWeight()`,
    权重为 **空白 0.28 ／ CJK 1.0 ／ 其他(拉丁数字符号) 0.55**,
    `lineProgress` 从 `completed / totalChars` 改成 `completed / totalWidth`。
    纯中文无空格时结果与旧版**完全一致**,不影响原观感。

    **验证**:逐 0.1s 采样全程进度曲线,**0 处异常跳变**
    (单步增量 0.0032~0.0116,阈值 0.03);空格处的推进量从 0.091 降到 **0.029**
    (正好是 1 整字 → 0.28 字宽的修正)。
    边界也测了:半角空格 / 全角空格 / 连续空格 / 中英混排 / 纯英文 / 退化输入全部单调且有界。

    **门禁**:`lyricsCore.test.mjs` 9→10 项(新增空格专项),
    `lyricsSettings.test.mjs` 里那条从「按字数」改为「按视觉宽度」并禁止回退。
    做了突变验证:把空格权重改回 1 整字,测试立刻红(期望 0.6868 实际 0.6621)。

#### 第七轮(2026-11-23 深夜):三处细节打磨

用户点明三处「细节再优化」：填色接缝 / 切行动画手感 / 控制条。
（配色被明确表扬「跟网易云基本一毛一样」，**不要动**。）

14. **填色接缝切在字中间。**
    行级 LRC 只有整行 `t/end`，进度线性插值 → 边界必然随机落在某个字的
    笔画中间，看着像一条硬切线（真机截图：「遗传」的「遗」是粉、「症」是白）。
    **修法**：给 `.lyric-clip` 加右侧渐隐 `mask`（`--fill-softness` = 0.4em，
    跟随字号缩放），填色边界变成柔和过渡。底层白字始终完整，
    过渡区天然是「粉→白」渐变，不会缺字。
    **收尾保护**：`ratio >= 0.999` 时取消 mask（`data-full="1"`），
    否则整行唱完后最后一个字右半边被削淡。

15. **切行动画手感。**
    原来只做 47px 位移 + 透明度 0.96→1（QML 原值）—— 透明度只变 4%，
    肉眼等于没有淡入，观感是"硬位移啪地弹上去"。
    **修法**：① 透明度起点降到 **0.55**（位移同时明显淡入，更像"浮上来"）；
    ② 缓动从 **InOutCubic 改成 OutCubic** —— 前者起步极慢、中段猛冲、收尾又慢，
    配合 47px 会显得"黏→弹→黏"；OutCubic 快起慢收，按下即响应、末段柔和落位。
    时长仍 300ms（`duration.slower`），位移量 47px 不动（那是"从副行位置升上来"的语义）。

16. **控制条细节。**
    ① `top: 0` → `top: 1px`（胶囊贴窗口上沿太紧）。
       ★ **不能留更多**：主行在 44px、胶囊高 38，`top:4` 只剩 2px 间隙会压住歌词。
    ② `padding: 0 10px` → `0 8px`、按钮 `gap: 4px` → `6px`（包得更紧凑）。
    ③ 图标 `14px` → `15px`（14px 在 32×30 按钮里四周各空 9px，显得空）。
    ④ 淡入 `120ms` → `150ms`（120ms 时 5 个按钮带缩放一起浮现像"闪一下"）。

#### 第八轮(2026-11-23 深夜):按钮点不动 + 控制条 UI 重做

17. **「这里的按钮完全无法点击，没回调」—— 命令授错窗口。**
    `overlay.js` 的 click handler 调 `invoke('lyrics_send_command')`，
    但这条命令**只在 `lyrics-bridge.json` 里授予了 `main` 窗口**，
    而唯一覆盖 `overlay` 的 `default.json` 里没有它。运行时直接拒绝。
    实测报错原文（CDP 抓的，`overlay.js` 里 catch 只 `console.warn` 所以看不见）：
    ```
    lyrics_send_command not allowed on window "overlay", webview "overlay", URL: local
    allowed on: [windows: "main", URL: local], [windows: "main", URL: https://music.9li.life/*] ...
    referenced by: capability: lyrics-bridge, permission: allow-lyrics-send-command
    ```
    **修法**：把 `allow-lyrics-send-command` 加进 `capabilities/default.json`。

    **★ 门禁漏洞（这次补上）**：原 `shellCommandManifest.test.mjs` 只做
    「集合相等」——命令存在、也**有**窗口被授予，只是**授错了窗口**，查不出来。
    新增一段**窗口归属**断言：
    - 用正则从 `overlay.js` 抠出所有 `invoke('xxx'`（**必须先剥注释** ——
      文件头架构说明里写着 `invoke('lyrics_push_state')` 当示意，会被误抓）；
    - 断言这些命令**每个**都被某个覆盖 `overlay` 的 capability 授予；
    - 反向点名 `lyrics_send_command` / `lyrics_settings_*` 必须同时授予 overlay。
    突变验证：去掉那条权限后测试立刻红并指名 `lyrics_send_command`。

18. **「设置里关掉歌词，窗口却还挂在屏幕上」—— 可见性声称状态初值错。**
    `overlayVisible` 初值是 `false`，而 `setOverlayVisible` 有「同值短路」。
    启动时若 `settings.visible === false`（用户此前关过歌词），
    `render()` 调 `setOverlayVisible(false)` → `overlayVisible === false` →
    **直接 return，从不真的调用壳侧 `set_overlay_visible(false)`** →
    窗口保持 Windows 创建时的可见状态。
    **修法**：初值改 `null`（"未知，还没和壳侧同步过"），第一次调用必定下发；
    且下发失败时把状态退回 `null` 让下次重试。
    （这条被既有的 TDZ 门禁当场抓出：本鱼一度把声明放在文件后段，
    而第 61 行的 top-level 语句引用了它。）

19. **控制条 UI 重做（用户：「这个条的 UI 也设计一下」）。**
    旧观感是一块 `rgba(247,250,252,0.94)` 的**实心白饼**、无投影、
    边框在 DPR 1.5 下只有 0.67px —— 浮在深色壁纸上像贴上去的纸片，
    与旁边那套「梯度光晕」的柔和语言完全不搭。
    **新方案：毛玻璃胶囊**
    - 半透明底 `rgba(250,251,252,0.72)` + `backdrop-filter: blur(20px) saturate(180%)`：
      透出壁纸色，深浅通吃；
    - **顶部 1px 内高光**（`inset 0 1px 0 rgba(255,255,255,0.75)`）＋底部内侧暗边：
      这是「玻璃边缘受光」的关键，少了它就是普通半透明色块；
    - 双层柔和投影（`0 2px 6px` + `0 6px 18px`）：近实远散，让胶囊浮起来；
    - 按钮圆角 `6px` → **全圆**（胶囊 + 圆角按钮才是同一套语言）；
    - 悬停从灰块改**白色柔光**（配毛玻璃像"光打上去"），`:active` 加 0.92 缩放；
    - 主播放按钮从扁平深灰改成**带内高光的深色玻璃**（渐变 + 同色投影），
      在一排无底色图标中间成为视觉焦点。
    - 暂停图标显示用 `flex` 而不是 `block`（按钮是 grid 容器，block 不居中）。

    **排查坑**：`overlay.js` 用 `const { invoke } = window.__TAURI__.core;`
    **解构赋值**在模块加载时就把函数引用抓走了 —— 之后替换
    `window.__TAURI__.core.invoke` 对它**完全无效**，
    导致所有"拦截 invoke 验证点击"的测试都看不到调用（本鱼踩了两轮）。
    可靠判据改成**看副作用**：点「下一首」后 `current-line-base.textContent` 变了
    （实测 `"但是我们渐行渐远"` → `" 作词 : Fanko冯思源"`，确实切歌了）。

#### 第九~十轮(2026-11-24 凌晨):全库扫描 + 行高节奏

用户「扫所有同类型问题扩散到全库修复」「还有能扣的细节吗」。

**方法论**:每轮先写扫描器,但**必先用 CDP 实测甄别假问题**再动手。
实测手段:多个视口宽度(800/960/1024/1280)×多页面,量
`元素实际尺寸 vs 声明尺寸`、`fontSize+lineHeight 组合`、`focus() 后有无可见轮廓`。

**排除掉的假问题**(量化后确认是设计意图):
- 首页圆角 9999/8/6/4 三种 → 嵌套层级递减(卡片→封面→角标)
- 按钮高度 220/44/36/32 → 层级差异(卡片/行操作/常规/图标钮)
- 静态扫描报「91 处可点元素缺 focus-visible」→ **实测 40 个元素逐个 focus()
  全部有可见轮廓**(项目有全局兜底) → 误报,未改
- z-index 魔法数字 0 处 / 动画时长硬编码 0 处 / 内联硬编码颜色 0 处
  → 历史轮次已治好

**真修的**:
1. `flex-shrink-0` 缺 27 处 → 0(预防性:实测 4 个宽度下未真触发,
   但加一行按钮就会塌,播放条「时间被切成 1:2」正是这么来的)
2. 内容卡片材质 5 处 `bg-card` → `.surface`(浅色主题下会与背景糊在一起)
3. 裸 `rounded` 17 处 → `rounded-control`(绕过 `--radius-control`)
4. 手写行高 → 令牌:同字号多套行高(11px 三套、14px 三套)
5. `text-sm`(14/1.25=20px) 与 `type-body`(14/1.5=21px) 同页并存 → 统一

**★ 同一个坑踩了三次(值得单独记)**:
门禁查「裸 rounded」时,三种 className 写法各漏一次:
  ① 只查 `className="..."` → 漏 `className={`...`}`(LoadingState 骨架屏)
  ② 正则被**注释里的反引号**提前截断 → 误判(SleepTimerControl)
  ③ 只查 className → 漏 `className={cn('...')}`(SongRow 徽章)
第③次后果最严重:**静态漏 1 处,运行时被列表渲染放大成 185/289 处**。
教训:**静态扫描只能发现「代码里怎么写」,发现不了「运行时放大多少」——
必须部署后实测 DOM**。最终门禁覆盖三种写法。

**刻意保留的「不统一」**(都已量化核实,不要当 bug 修):
- 卡片标题 `type-caption leading-snug`(17.875px) vs 页面副标题
  `type-caption`(18.2px):去掉 leading-snug 卡片只高 1px、极差仍 0,
  但收紧配合 `min-h-[2lh]` 是对的设计意图
- 播放条内部自成一套尺寸体系(固定高度约束下重排过)
- HelpPage `leading-7` / LoadingState `leading-6`:长文阅读舒适度
- `player-lyric-line leading-relaxed`:歌词正文需要舒展

**门禁增长**:11 → 18 → 20 条(`npm run test:ui-consistency`)。
每条都做过突变验证(改一处 → 确认变红并指出文件行号 → 还原)。

#### 第十一轮(2026-11-26):手机端排版对齐(列表/头部/卡片/头图)

用户:「手机 APP 上的 UI 布局能不能做一下优化。尺寸对齐排版重做之类」。
这一轮**全部是算出来的缺陷**,不是观感判断 —— 每一条都能给出具体 px 差额:

1. **歌曲行右列溢出 2px**(四种宽度下必然发生)。手机档 `grid-cols-[..._5rem]`(80px),
   里面放「播放 44 + gap 2 + 更多 36 = 82px」,两颗按钮都 `flex-shrink-0`(门禁强制),
   装不下就是内容压出边界。列宽改 `5.75rem`(92px)。离线页同类网格同步。
2. **「更多」按钮 36px < 项目自己的 44px 触控下限**(ux-redesign-plan.md 写明)。
   手机档改 44px,桌面 `lg:h-9 lg:w-9` 保持原尺寸。离线页行内 40px 按钮同理。
3. **同屏两种左边距**:行内 `px-3`(12px) 叠加页面 `px-4`(16px) → 列表内容起点 28px、
   页面标题 16px。手机档收到 `px-1`(4px):起点 20px 与标题同列。
   ★ **不能取 `px-0`**:那样高亮底色会贴死屏幕边缘、圆角被切,反而更难看 ——
   4px 是"看起来对齐"与"圆角不被裁"的交点,别为了"完全对齐"改成 0。
4. **头图两种尺寸**:`CoverMosaic` 默认 128px、手写三处 112px。统一手机 112 / 桌面 128。
5. **横滑卡片两套宽度(144/136) + 两套内边距(p-2/p-1.5)**:收敛到 `ui/mediaCard.js`。

顺带修:**详情页头部手机端 `flex-col` 让封面独占一整行**,以 375×667 算头部约 342px
(一首歌都没露出来),抽 `ui/DetailHeader` 后约 220px。桌面用两行 grid 复刻原
`items-end` 观感,**桌面外观不变**;`ref` 仍指向同一个按钮节点(没有渲染两份)。

另修:本机专辑卡播放按钮只有 `opacity-0 group-hover` —— **触屏没有 hover,等于不可达**,
改为手机常显。这类「只在 hover 出现」的可交互元素在移动端一律要检查。

**★ 本项目的 `cn()` 不做 Tailwind 冲突合并**(没装 tailwind-merge,只拼接字符串)。
所以 `w-full` 与 `w-[8.5rem]` **不能同时出现** —— 谁生效取决于 Tailwind 生成规则的
先后,不是 className 书写顺序(实测产物里 `.w-full` 排在 `w-[9rem]` 之后)。
宽度一律按场景二选一,`mediaCard.js` 里用 `MEDIA_CARD_ROW_WIDTH` /
`MEDIA_CARD_GRID_WIDTH` 两个常量强制这一点。

**主动放弃的一项**(已量化,不要当遗漏):`px-0` 换来的 12px 歌名宽度。
15px 换"高亮圆角被裁"不划算,`px-1` 是平衡点。

**门禁**:新增 `npm run test:mobile`(`scripts/mobileLayout.test.mjs`,7 条),
每条都做过突变验证(改回旧值 → 确认变红并指名文件与差额)。已接入 CI ——
顺带发现 **CI 原先根本没跑 `test:ui-consistency`**,一并补上。

**未验证**:本机无无头浏览器(无 jsdom/playwright),**没有做像素级截图比对**。
上述结论全部来自:源代码 + 构建产物里实际生成的 CSS 类 + 排版数学核算。
真机观感仍需人工确认。

#### 排查手法(可复用)
- **UI 资源是编译进二进制的**(`frontendDist: "../ui"`):
  改完 `desktop/ui/*` **必须 `cargo build` 才生效**,只重启进程看到的是旧界面
  (这次浪费了一轮:磁盘 CSS 已是 `top:0`,页面计算值仍是 32px)。
- 用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`
  起壳,再用 CDP `Runtime.evaluate` 读真实 DOM/`getComputedStyle`/
  `getBoundingClientRect`,比截图猜快得多;
  `Page.captureScreenshot` 截的是页面自身渲染,**不受其它窗口遮挡**影响
  (全屏 Blender 会盖住 TOPMOST 歌词窗,屏幕截图拍不到)。
- 判据一律用数值交叉核对,例如「裁剪宽度 ≈ 文字宽 × 进度」误差 <1.5px、
  「裁剪区左边 == 文字 Range 左边」误差 <1.5px。

### 置顶失效:全屏游戏降级 + 层级守护(2026-11-24)

用户报「桌面歌词没置顶」。**抓到了活体故障态**(不是推测),根因与修法如下。

#### 现场证据(21:15:42 快照)

```text
exstyle=0xC0138  →  WS_EX_TOPMOST = True      ← 样式位说它是置顶窗口
z 序 rank=15     →  上方压着 14 个「非置顶」窗口,其中 7 个几何覆盖歌词窗
                    （Telegram / DeepSeek Harness / chrome / QQ / 微信…）
                 对照正常态:rank=0,上方非置顶 0 个
```

#### 触发源:全屏独占应用

用户原话「**刚关闭游戏**」。全屏独占游戏运行期间 Windows 把其它顶层窗口降到普通层,
**但保留 `WS_EX_TOPMOST` 样式位**;游戏退出后它自己不会恢复。

已**排除**的候选(逐个真实执行 + Win32 断言,全部不影响层级):
改字号 36↔48 / 切鼠标穿透 / 隐藏→显示 / 换配色 / `lyrics_resize_to_content` /
重置位置 / 主窗口最小化 / 退托盘 / 反复切前台 10 次 / `Alt+Tab`×3 / `Win+D`。

> ★ **拿「全屏置顶窗口」去撞是撞不出来的** —— 那不是独占全屏,Windows 不走这条特殊路径。
> 本鱼在这上面浪费了两轮,别重复。

#### ★ 核心机制:样式位为真 ≠ 在置顶层

三次独立实验的一致结论:

| 手段 | 结果 |
|---|---|
| 只写 `SetWindowLongW(GWL_EXSTYLE, ex \| WS_EX_TOPMOST)` + `SWP_NOZORDER` 刷新 | **完全无效**,系统立刻把样式位改回去,窗口仍停在普通层 |
| `SetWindowPos(hwnd, HWND_TOPMOST, ...)` | **立刻恢复** rank 15 → 0 |

因此:**判定失位必须读真实 z 序(不能读样式位);修复只能用 z-order API(不能写样式位)**。

#### 修法:`topmost_guard.rs`(**只读巡检 + 失位才动作**)

- 沿 z 链从最上层走到歌词窗,统计「**非置顶** 且 **几何覆盖** 歌词窗」的窗口数,
  `>0` 即判失位(`blockers` + `rank` 一起记进日志)。
- 纠正走 `SetWindowPos(HWND_TOPMOST)`;带 **3s 冷却**防与别的置顶程序抢。
- `main.rs` 起后台线程,**每 1.5s** 巡检一次。
- 失位被捡回时记一条 `WARN`,**必须带遮蔽者身份**:进程名 + 窗口类名 + 标题(截断 48 字),
  最多记 3 个。

  ★ **这条是补记的教训**:第一版只记 `rank` + `blockers` 两个数,上线后日志确实出现
  「纠正前 rank=2,压着它的非置顶窗口=1 个」—— 数量有了,但**仍然不知道是谁压的**,
  等于白记一轮。而那条日志出现的时机是**进程启动后 17 秒**,说明失位不是游戏专属的
  偶发事件、日常就会撞上(只是被守护在 1.5s 内挡住了,用户无感知)。
  **诊断信息必须能直接指认对象,不能只给计数。**

  真机验证用的造场手法(记下来,后续复现直接用):
  ① 挑一个普通窗口(或临时建一个)；
  ② `SetWindowPos(lyric, HWND_NOTOPMOST)` 把歌词窗移出置顶带；
  ③ `SetWindowPos(lyric, blockerHwnd)` 把它排到 blocker **下面**
     —— 注意 Win32 的 `hWndInsertAfter` 是「放在它后面(更低)」,顺序搞反就造不出覆盖；
  ④ 再写回 `WS_EX_TOPMOST` 样式位,复刻「样式=1 但层级不对」的真机形态。
- **正常时零副作用**:只读查询,不发任何窗口操作。实测正常态 6 秒零日志(不抽搐)。
- 窗口不可见/最小化时判 `Inactive` 直接跳过,不参与争抢。

#### 门禁

`cargo test --locked` 47 项(新增 4 条锁上面每个设计前提):
冷却 ≥ 巡检周期 / 失位状态必须带 rank+blockers+遮蔽者身份 / 遮蔽者最多记 3 个 /
只有 `Displaced` 触发纠正(其余三态必须沉默,否则「正常态零副作用」就破了)。

真机验证:人为造出故障态 → **1.5s 内自动捡回**;恢复后 6s 无重复纠正。

### 未验证项(截至 2026-11-23,不要当成已修好)
- **开机自启**:插件与菜单已接好,但**没有真的勾选并重启系统验证**(需动注册表,留待用户本人确认)。
- **自动更新的端到端**:清单 `latest.json` 未部署,「检查→下载→安装→版本号变化」未在真实发布上跑通。
  壳侧降级行为已验证(只记 WARN、不崩溃、不打扰)。
- **SSO 全新登录**:壳内加载站点未跳 Authentik 已验证,但"全新机器首次登录"未覆盖,需用户人工走一遍。
- **控制条/设置页的真机观感(2026-11 新增)**:代码、编译、Rust 39 项单测、36 项设置契约全过,
  但**没有人眼看过实际渲染**。旧实现的数值(212×38 / 32×30 / 8 套配色)是照 QML 抄的,
  而 WebView2 的字体渲染与 Qt 不完全一致 —— **像素级观感仍需用户目视确认后才算验收**。
  同理「拖动能存位置」「关闭后从托盘能重新打开」这类交互，需真机走一遍。

> 已澄清:**媒体键在真实站点页面成立**(第二轮取证),不再是未验证项。

## PrismQML 桌面原生播放(2026-07,**已被取代,保留待验收后删除**)

> **状态**:`desktop-prismqml` 已由上面的 Tauri 2 外壳**取代**,但**尚未删除**——
> 用户决定先用新客户端一段时间确认无遗留功能后再删。
> 因此:crate/CI 工作流/本机构建产物**暂时全部保留**,不要擅自清理。
> 退役原因:它自带第二套 UI 且过不去 Authentik SSO。
> 真删时需同时处理:`desktop-prismqml/`(75 文件/10,844 行)、CI 工作流、本文档本节、
> 以及本机 `%LOCALAPPDATA%\Melodex\desktop-{build,deploy}` 与 `.prism-sdk`/`build-cpp`。

- `desktop-prismqml` 的解码与声卡输出由 Qt Multimedia C++ `QMediaPlayer/QAudioOutput` 完成；Python `PlayerController` 只负责队列、歌词、状态持久化和 QML 信号。
- **音频数据面不得走 Python loopback 代理**：桌面端通过登录 cookie `POST /api/v1/playback_ticket`，服务端返回绑定 user_id/username/session_epoch/完整 stream 查询摘要的签名 URL；随后 `QMediaPlayer` 直接读取 `/music/download?...&playback_token=...`。`authRequired` 只允许该票据用于 `GET /music/download` 且必须 `stream=1`，修改 id/source/任意查询参数、改密码、禁用用户或票据过期都会失效。
- 票据默认 6h，且永不超过 `MUSIC_DL_SESSION_MAX_AGE`；可用 `MUSIC_DL_PLAYBACK_TICKET_MAX_AGE` 配置(Go duration，最短 5m)。桌面端严格校验返回 URL 与配置的 Melodex 服务同源，拒绝跨域/嵌入凭据 URL；启动时必须关闭 Qt FFmpeg URL 诊断，禁止 `playback_token` 进入客户端日志。
- 快速切歌必须以请求序号丢弃旧票据回调，禁止旧异步响应覆盖新曲。封面仍可走 loopback 鉴权代理(小对象)，但连续音频字节不可再由 Python 搬运。
- 验证门禁：`desktop-prismqml/.venv/Scripts/python.exe -m unittest discover -s tests -v`；后端仍执行 `go build ./...` 与 `go test ./internal/web/ ./core/`。真实卡顿修复必须用同一首生产歌曲在机器负载下复验，不能只以单测代替听感/断供数据。
- **本机日常启动的唯一指令**：在当前 PowerShell 直接执行 `& "$env:LOCALAPPDATA\Melodex\desktop-deploy\bin\melodex_desktop.exe"`。这条命令只运行固定部署目录里的现成客户端，不调用 Python、CMake、CTest、安装或部署，也不新开 PowerShell。给用户“启动客户端”的指令必须始终使用这一条，不得换成 `run-local.ps1`、临时脚本或构建命令。
- `desktop-prismqml/run-local.ps1` 仅用于开发阶段需要完整执行 Python 回归、CMake 构建、CTest、Qt 部署和重启时；不得把它当成日常启动器。只有用户明确要求构建/完整验证时才可运行。
- 本机 Qt、PrismQML SDK、Visual Studio、构建目录和部署目录只写入已被 Git 忽略的 `desktop-prismqml/run-local.config.psd1`；提交到仓库的 `run-local.config.example.psd1` 只保留占位配置，禁止提交本机绝对路径。
- 桌面端必须安装与 Qt 6.11.1/工具链匹配的 **Qt Image Formats** 模块；咪咕等来源返回 WebP 封面时依赖 `plugins/imageformats/qwebp.dll`。`run-local.ps1` 必须在构建前检查 Qt SDK 插件、在 `windeployqt` 后检查固定部署目录副本，缺失即停止，禁止带着 `Unsupported image format` 继续启动。
- 固定构建/部署目录为 `%LOCALAPPDATA%\Melodex\desktop-build` 与 `%LOCALAPPDATA%\Melodex\desktop-deploy`。脚本会把配置指定的同一 PrismQML SDK 同步到纯 ASCII 的 `prism-sdk-cache`，CMake 和运行时必须使用这一份，禁止通过 `PRISMQML_QML_DIR` 临时切换到其他版本。
- 禁止再创建带时间戳或功能名的 `melodex-*build*`、`melodex-*deploy*` QA 目录；验证完成的客户端必须从固定部署目录启动。需要升级 SDK 时只修改本机配置并继续运行同一入口。

## 品牌图标:单一矢量为源(2026-11 重画)

**所有图标产物都由 `frontend/scripts/build-icons.mjs` 从一个矢量图形派生**,禁止再手放 PNG / 手写矢量。
图形本身在 `frontend/scripts/icon-glyph.mjs`(唯一矢量源,只有颜色/尺寸比例/折线方向);`build-icons.mjs` 只负责缩放、居中、裁边、出各平台格式。

- 命令:`cd frontend && npm run icons`(写文件)/ `npm run test:icons`(只校验,不一致退 1)。
- 产物三平台共 24 个:Web-PWA(`public/icon.svg`、`icon-maskable.svg`、`logo192/512`、`maskable512`、`favicon-32`)、
  Android(`mipmap-<density>/ic_launcher(_round).png` 五档位图回退 + `mipmap-anydpi-v26/ic_launcher(_round).xml` 自适应 +
  `drawable/ic_launcher_foreground.xml` 矢量 + `values/ic_launcher_background.xml`)、桌面 Tauri(`icons/icon-{32,128,256}.png` + `icon.ico`)。
  `desktop-prismqml` 直接引用 `frontend/public/logo512.png`,随之一起更新。
- **图形(2026-11 换为「折纸播放」)**:纯色纸面 `#F6F1EE`(圆角 = 边长 × 220/1540),正中一个等腰播放三角 `#2F2C29`,
  三条折线 `#D9D3CF` 分别从三角三个顶点引到纸面边缘。按用户提供的 2000px 折纸位图测量后,
  **按用户要求规整**:三角改等腰并按外框完全居中、去掉颜色略深的折瓣与原有折痕、去掉全部阴影。
  (同月更早换过一版紫色柱状图 `b4d9c79`,已被这一版取代。)

### 坑(都实际踩过,改之前必读)
1. **"居中"指三角外框中心 = 画布中心**,不是重心居中。原图的三角右顶点比左边中点低约 4px、纸面也不是正方形
   (实测 1537×1544),用户明确要求"完全居中",所以规整成等腰 + 正方形。logo512.png 实测外框中心偏移 dx=-0.5 / dy=0
   (半像素是抗锯齿取整,坐标本身精确居中)。
2. **折线是射线,不是固定长度的线段**:`playParts()` 从顶点沿方向求到 [0,512] 画布边界的交点,
   圆角版再用纸面 clipPath 裁掉圆角外的部分。maskable/自适应版三角收进安全区(×0.72),但折线仍画到画布边缘 ——
   否则缩进后的折线会停在纸面中间,不像折痕。
3. **安全区**:离中心最远的是三角两个左侧顶点,512 视图半径 hypot(w/2,h/2)×0.72 ≈ 119.6,
   小于 maskable 安全圆 204.8 与自适应 66dp 安全圆 156.4。改三角尺寸后要重算。
4. **小尺寸不再分档**:只有一个大三角,16px 照样清楚;折线 1px 宽,≤64px 时自然淡到看不见,这是已知取舍(主体是三角)。
5. **清单必须 `android:icon="@mipmap/ic_launcher"`**。此前是 `@drawable/ic_melodex`,那样 `mipmap-anydpi-v26` 的自适应图标
   **根本不会被使用**;旧的 `ic_melodex.xml` 已删除——同一图形留两份必然分叉。
6. 若以后引入渐变:**必须 `gradientUnits="userSpaceOnUse"`**,默认 `objectBoundingBox` 在竖直线段上包围盒宽度为 0,
   整条线不渲染;VectorDrawable 里渐变色要包进 `<aapt:attr>`,`strokeWidth` 这类普通浮点属性不能包。

验证:`npm run build`(产物进 build/)+ `npm run test:icons` + `cd android && ./gradlew :app:processDebugResources`
(后者是确认 VectorDrawable 路径 / 自适应图标引用真正合法的唯一可靠手段,不能只看 XML 顺眼)。

## 开发运行

```bash
# 后端(Go):
cd backend && go run ./cmd/melodex web --port 8329 --no-browser
#   下载文件刮削嵌封面用到 ffmpeg:用环境变量 MUSIC_DL_FFMPEG 指定 ffmpeg 路径
#   (videogen 已剥离;ffmpeg 现仅用于刮削/转码场景)

# 前端:
cd frontend && npm install && npm run dev   # 读 .env.development.local 指向后端
```

- 本机 go run 后台跑有时进程被清理,验证时建议 `go build -o /tmp/melodex ./cmd/melodex` 跑二进制更稳。
- 本机 curl 后端要加 `--noproxy "*"`:**开发机(Windows)的代理是 `127.0.0.1:7897`**(见 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量),
  curl 默认会走它连本机端口而失败;`NO_PROXY` 虽含 `127.0.0.1` 但不含 `localhost`,所以用 `localhost` 时反而要留意。
  **注意 7890 是 NAS 上的代理端口,开发机不通**(曾误把两者当同一个,导致"本机端口打不通"的错误结论)。
  vite dev 用 `localhost`(绑 IPv6,curl 127.0.0.1 连不上)。

## Subsonic API facade(2026-06 新增,音流/substreamer 等客户端直连)

Melodex 后端**自实现一套轻量 Subsonic 服务端**(挂 `/rest`,非 Navidrome),让标准 Subsonic 客户端连一个地址即可「搜全网在线听 + 浏览已入库本地曲库 + 听过自动入库」。代码在 `backend/internal/web/subsonic*.go`(facade 主体 `subsonic.go`、id编解码+search3 `subsonic_search.go`、stream `subsonic_stream.go`、封面+曲库浏览 `subsonic_library.go`)。

### 设计要点(读源码得出)
- **默认关**:`MUSIC_DL_SUBSONIC_ENABLED` + `_USER` + `_PASS` 三个 env 配齐才启用;缺凭据强制关(无法认证的 facade 不暴露端点)。纯下载/现有部署不受影响。
- **认证**:Subsonic salt+token,`t=md5(password+salt)`,凭据走 env(禁止硬编码)。报协议版本 1.16.1,支持 xml/json/jsonp。自带认证,**不走 /music 管理员鉴权**,直接挂 raw engine。
- **search3 接联网搜索**:复用 `concurrentKeywordSearch` → **后端验活**(`liveCheckSong`,复用 inspect 的 Range 探测逻辑,并发6过滤死链/版权受限,回填真实 size/bitrate)→ 映射 Subsonic searchResult3。
- **id 编解码**:在线源 id = `ts1:` + 各字段独立 base64url 用 `.` 连接(`.` 不在 base64url 字母表,字段含任意字节都不破坏分隔);extra(源特有元数据)存进程内映射表(上限5000,超限清空重建)。本地曲库 id = `loc:` + 包裹 localMusic 的 track.ID。**坑:不能用单字节分隔符**(字段值本身可能含该字节),早期用 `\x1f` 被测试 `TestOnlineSongIDHandlesSpecialChars` 抓出。
- **stream「听=下载」**:① 本地 id 直接发文件 ② 在线 id 先 `findDownloadedTrack`(按 标题+艺人 归一化匹配扫描快照),已下载走本地(省流量秒开)③ 未下载则在线反代播放(复用 `NewSourceRangeFetch` 支持拖进度)+ **后台 goroutine 完整下载刮削落盘**(`downloadInFlight` sync.Map 去重防重复下载)。失败打日志不影响在线播放。
- **曲库浏览**:getMusicFolders/getIndexes/getArtists/getArtist/getAlbumList2/getAlbum 全部读 `scanLocalMusicTracksCached` 快照聚合(艺人按首字母分组,专辑空名归「未知专辑」)。getCoverArt:本地读 `readLocalMusicCover` 嵌入图,在线代理 cover URL(复用 `isPublicHTTPURL` SSRF 防护 + `core.FetchBytesWithMime`)。
- **共享存储**:下载落 `settings.DownloadDir`(与现有下载同目录);Navidrome 若同时跑可扫同一目录(本 facade 与 Navidrome 互不依赖,二选一即可)。

### 部署鉴权(生产 music.9li.life)
- `/rest` 路径要在 NPM **放行 Authentik SSO**(`auth_request off`,与 PWA 静态资源同理),仅靠 Subsonic 自身 user/pass 认证——Subsonic 客户端不会过 SSO 登录页。
- env 在 `docker-compose.yml` 配(已留注释模板,默认注释掉)。

### 验证(已真机端到端,2026-06)
- `go build ./...` + `go test ./internal/web/ ./core/` 零回归;facade 单测覆盖 认证token计算(对齐协议文档示例)/id编解码往返+特殊字符/各端点格式/曲库聚合。
- 真机:本机起二进制 + curl 模拟 Subsonic 请求(`--noproxy '*'`,token=`printf '%s%s' pass salt | md5sum`)→ ping/getLicense/search3(真搜「周杰伦 晴天」验活返真实bitrate)/stream(ffprobe 验真MP3)/后台落盘(刮削+嵌PNG封面)/getAlbumList2(入库后可浏览)/本地id回放(发本地文件)/getCoverArt(本地嵌入图)全通;facade 默认关(无 env 返 code 0 未启用)已验。

## 自建歌单 + m3u 导入(2026-06 新增)

- **后端早有完整歌单 CRUD**(`collection.go`,SQLite 存 `data/settings.db` 的 collections/saved_songs 表,**非单独 favorites.db**——所有数据都在 settings.db 一个文件,迁移/备份保住它即可)。路由 `/music/collections`:GET 列 / POST 建 / PUT 改 / DELETE 删 / GET·POST·DELETE `/:id/songs` 看·加·移歌。前端 `services/collections.js` 封装。
- **前端自建歌单**:Sidebar「我的歌单」组列出 + 「+」弹出菜单(新建空歌单 / 导入 m3u);SongRow 的「+」(ListPlus)弹 AddToPlaylistModal 选歌单加入;MyPlaylist 是歌单详情页(播放全部/移歌/删歌单)。playlistBus 区分推荐歌单(id+source→Trending)vs 自建歌单(collectionId→MyPlaylist);`requestOpenPlaylist` 派发延 60ms 否则切页后目标组件未挂载收不到事件。
- **m3u/m3u8 导入**(`m3u_import.go`,`POST /music/collections/import_m3u`):解析 `#EXTINF` + 媒体行 → 每条按歌名 `concurrentKeywordSearch` + `sortSongsByRelevance` 取第1名入库 → 返回 {total,matched,skipped}。**关键:优先用媒体行文件名做搜索词**(含分隔符时),因真实 m3u 常 EXTINF 只有歌名、文件名才含"歌手-歌名",用文件名匹配率高(实战 407 首 100% 匹配)。识别 `#EXT-X-` HLS 视频流→拒绝。`.m3u`/`.m3u8` 同一套解析。**坑:前端 importM3U 超时必须放宽到 10min**(默认 30s,百首导入需数分钟会超时失败)。

## 「我的歌单」加载慢:两条根因(2026-10 修复,别再踩)

用户报「每次点歌单都慢」。**这不是一个 bug,是前后端各一处叠加**,两处都必须修;只修一边仍会觉得慢。

### 根因 1(后端,主因):逐首 `payload LIKE` 全表扫描 = O(缺专辑歌曲数) 次全表扫描
`/music/collections/:id/songs` 每首**缺 album 元数据**的歌都要问一次搜索缓存,改造前是
`select * from search_cache_rows where payload LIKE '%"id":"<songid>"%' limit 25`。
生产实测(postgres,238 行 / 9.7MB / 单行最大 240KB):**单次 52ms**,99 首歌单里 15 首缺 → 780ms,
与线上日志 `GET /collections/8/songs = 755~828ms` 完全吻合;而 19 首且 0 首缺只要 32ms。
更糟的是**缺 album 的歌往往在搜索缓存里 0 命中**(实测 43 首命中 0)→ 永远写不回 `saved_songs.extra`
→ **每次打开都重扫**,所以慢是恒定复现而不是偶发。
修复(`search_album_index.go`):进程内 `(source,song_id) → {album,album_id}` 索引,流式扫一次表构建,
请求路径只做 O(1) map 查找;TTL 15min(`MUSIC_DL_SEARCH_ALBUM_INDEX_TTL`)、过期先用旧快照后台单飞重建、
三道上限(5000 行 / 64MB / 20万条)、扫表失败退避 10s 后**退回旧 LIKE 作兜底**(功能不退化)。
`putCachedSearch` 增量合并不整体失效(否则每次搜索换一次全表重扫);`deleteCachedSearchKey`/GC 删行整体失效,
并用**代数计数器**防止"扫描期间被删→陈旧快照把已删数据灌回"。
顺带修掉 `warmQualityCache` 的第二个 N+1:它原先在**请求路径上**逐首 `getCachedQuality` 点查(163 首 = 163 条 SQL)
才起后台 goroutine,现改为一次 IN 批量(500/块,兼容 sqlite 999 参数上限),真实探测仍留在后台。
**实测(同库同数据,430 首/8 歌单)**:163 首/43 首缺 **672ms → 4.3ms(约 156×)**;99 首/15 缺 240ms → 3.4ms;
43 首/8 缺 127ms → 2.2ms;0 首缺 3.6ms → 1.4ms。**响应体与修复前逐字节一致**(四个歌单 SHA256 相同)。

### 根因 2(前端):点一次歌单发**两次**相同请求,且零缓存
`MyPlaylist` 有两个独立来源都直接调 `load(id)`:
① 侧栏 `onNavigate` 改 hash → 组件挂载 → hash 恢复 effect 取数;
② `playlistBus.requestOpenPlaylist` 延 60ms 派发的事件 → 回调里再取数一次。
没有去重(dev 下 `React.StrictMode` 再翻倍),且无缓存 → 每次切换都重放骨架。
修复:两个来源**只负责决定 collectionId**(`utils/collectionRoute.js` 的 `mergeCollectionSelection` 收敛成一个 selection),
取数只由 `useQuery(['collection-songs', String(id)])` 一处完成(StrictMode/并发挂载天然幂等);
骨架只在 `isLoading`(首次无数据)出现,5 分钟内复访直接用缓存(全局 staleTime 5min),移歌改乐观更新+回滚。
契约测试 `frontend/scripts/collectionRoute.test.mjs`(`npm run test:collection-route`)直接用 `node_modules` 里
同一份 react-query v3 断言请求次数,并用「MyPlaylist 里 `getCollectionSongs(` 只能出现 1 处」作静态门禁。

### 排查方法沉淀(可复用)
- 先用**生产真库**量化,别猜:`docker exec melodex-postgres psql -U melodex -d melodex` 数 `saved_songs`
  里"缺 album"的行,再 `\timing` 手跑一次 `payload LIKE '...'` 拿到单次成本,两者相乘对日志延迟即可定位。
- 阶梯现象是 N+1 的指纹:**耗时 ≈ 缺数据行数 × 单次固定成本**(本例 sqlite 基准 ~15ms/首、postgres ~52ms/首)。
- 回归测试**不要用耗时断言**(CI 抖动),用 GORM logger 计 SQL 条数:`163 首全缺 album 一次请求 ≤ 8 条`;
  再用 test-only 开关强制退回旧路径断言 `≥163 条 LIKE`,证明这条断言真的锁住了 N+1(否则形同虚设)。
- 造基准库时若 `quality_cache` 的 key 不是按 Go 的 `qualityCacheKey` 逐字节算出来的,warm 会全部 miss →
  后台打上游 + 写 SQLite,写锁把基准污染成假慢(实测把 4ms 测成 1181ms)。先用全命中把 warm 静音再测。

## 平台个人歌单导入(引用型,2026-07 新增)

从已登录平台(当前为网易云/QQ,以 `core.GetUserPlaylistSourceNames()` 为准)一键导入你创建/收藏的歌单。**引用型**:只存 `source+external_id`,打开时后端 `loadImportedCollectionSongs` 实时从平台拉曲目,导入瞬间完成、可在线听、也可整单/逐首下载到 NAS(复用 MyPlaylist 现有下载按钮)。

- **后端能力**由 Charles Provider sidecar 的 `/v1/collections` 返回 `UserPlaylists` + `GetPlaylistSongs`;`POST /music/collections/import` 建 kind=imported 歌单并去重。
- **新增路由 `GET /api/v1/user_playlists`**(`json_api.go`,userSecure 组需登录):复用 `loadPlaylistTabsJSON` + `userPlaylistsFuncProvider`(可替换以便测试,默认 `core.GetUserPlaylistsFunc`)按源返回 `{tabs:[{source,source_name,playlists,error}]}`。**不缓存**(依登录 cookie,跨用户/跨登录态会串)。未登录的源 `GetUserPlaylists` 自身返 error → 落 tab.Error,前端提示「去设置登录」。
- **前端**:`musicdl.js` 的 `getUserPlaylists()` 拉列表;`collections.js` 的 `importPlaylist(playlist)` 把 `model.Playlist`(id/name/cover/creator/track_count/link)映射成 import body(content_type='playlist');`ImportPlaylistModal.js` 按源 tab 展示歌单卡片,点击导入,duplicate 提示已导入;Sidebar「+」菜单第三项「从平台导入歌单」。
- **坑:侧栏必须带 `include_imported=1`**(`listCollections({includeImported:true})`,CollectionsContext 已改),否则导入歌单不显示——后端默认列表只返 manual+favorite。
- 验证(本机桌面模式二进制,2026-07):`/api/v1/user_playlists` 未登录返 200 且 4 源各带正确 source_name + require cookie error;import 建引用型歌单返 id+自动补 link;重复导入返 duplicate;默认列表不含 imported、include_imported=1 可见。前后端 build/test 零回归。

## 搜索排序(2026-06 重写,Web 与 Subsonic 共用)

`json_api.go` 的 `/api/v1/search` 和 facade 的 search3 都用 `sortSongsByRelevance`:综合分 = 本地相关性 `relevanceScore`(歌名完全=1000/开头600/含400/多词累加/歌手+80) + 上游名次分 `upstreamRankScore`(各源返回序,译名匹配不到时兜底) + 正版信号 `officialBonus`(无损+600/付费+200) − 翻唱降权 `coverPenalty`(歌名含 Cover/翻唱/钢琴版/伴奏/纯音乐等强特征罚1200/Live等弱罚300);**无正版信号的完全匹配封顶到 600**(防译名翻唱白嫖歌名霸榜),同分按真实码率降序。前端 Download.js 信任后端返回序(relevance 字段取 -origIdx 不本地重算)。
- **音质信号来自 Provider sidecar**:`backend/provider_bridge/app.py` 将 Charles 快照返回的格式、码率和可下载状态映射到稳定 `Song` 模型;无损扩展名写入 `has_lossless`。固定提交和许可证见 `backend/third_party/charles-musicdl/UPSTREAM.md`。
- **边界**:无"原唱"元数据,纯算法靠"有无损≈正版原唱"近似,译名翻唱(歌名精确匹配译名又无标记,如 Cherisy)仍可能压过原名原唱(日文名匹配不上中文 query)。要精确区分需 MusicBrainz(不做)。带艺人/用原名搜最准。

## 功能现状(截至 2026-06,搜索/下载主线闭环)

用户用法:**自托管,搜索 → 验活 → 排序 → 下载到 NAS(刮削)→ 本地音乐库/可挂 Plex/Navidrome**。核心都在 `Download.js` + `SongRow.js` + `useLiveCheck.js` + `Settings.js`。

- **搜索**:多源合并。结果先**自动验活**(useLiveCheck 并发6调 inspect),死链/版权受限**隐藏**,显示"验活中 x/总数"+"共N首可用",渐进出结果(验完一首出一首)。代价:全验完约 20~25s(限并发必然),渐进显示缓解。
- **排序**:多级排序(相关/音质/大小可叠加,①②③优先级+↑↓+清除)。默认 relevance 降序。relevance=相关性评分(见能力边界);音质用验活真实 bitrateNum;同名同分隐式按音质降序。
- **歌曲行**(SongRow):显示 音质标签(验活真实值,无损/高品/Nk)+ 源 + 时长 + 真实大小;按钮 验/词/播放/下载。"验"=手动 inspect;自动验活的结果经 `liveInfo` prop 直接显示(effectiveReal=手动验优先,否则用 liveInfo)。
- **下载**:点「下载」= 下到 NAS(saveToServer,见关键设计点),状态 下载中/✓已下载/✗重试。服务器状态不是会话内临时值:`ServerDownloadsContext` 启动读取 `/music/downloads`,精确按 source+song_id、再以完整歌名+完整歌手等值回退；侧栏「已下载」(`#local`)列出服务器文件。下载响应只有 `saved:true,recorded:true` 才算可持久恢复成功；成功事件还必须校验后端返回的 `recorded_user_id` 与当前 user_id 一致,防慢请求在换账号后串状态。
- **服务器副本播放优先**(2026-07):Web 播放仍请求原歌曲 `/music/download?...&stream=1`,但后端在访问在线源前先按当前用户可见的 DownloadRecord 解析 NAS 文件(先 source+song_id,再完整歌名+歌手等值回退),命中即用本地 `ServeContent`/Range 发流并返回 `X-Melodex-Playback-Source: server`；无命中才走在线源/自动换源。禁止直接复用 Subsonic 的全局目录匹配(不含 Web 用户归属)。`PlayerContext` 对已有“服务器”状态的歌曲跳过“播放时自动下载”,避免重复拉流并重写正在播放的同名文件。
- **副本优先的音质门控**(2026-10 补,`internal/web/stream_quality.go`):上面的"副本优先"原先**不比较音质**,于是早年在没有会员/无损凭证时落盘的 128k mp3 会永久压过后来已能取到的 FLAC —— 列表标签来自对**在线源**的 inspect(显示"无损"),耳朵听到的是磁盘上有损副本。现在 `stream=1` 与 `/music/playback_segment` 两条路径都会先判:副本是**有损**扩展名 且 在线源 `extra.has_lossless=1` → 改走在线,并打日志 `[stream] 副本为有损(mp3),在线源声明无损,改走在线`。
  **关键安全阀**:只有在线地址**确认能解析**时才让位(`onlineStreamResolvable`,命中 provider 10 分钟歌曲缓存时近乎零成本);解析不到就照旧播副本,绝不为了"修音质"把歌弄成放不出来。副本已是无损、或在线未声明无损时,保持原有副本优先语义、不额外回源。
  配套(**升级判定**):`/music/downloads` 每项新增 `ext`/`size_bytes`(落盘刮削后的真实大小),前端 `serverCopyNeedsUpgrade` 据此只在有**正面证据**时重下(磁盘有损+源声明无损,或估算码率 < 0.7×在线且差距 ≥32kbps),其余一律不动。
  **下载覆盖判定的历史 bug**(2026-10 修,`core/download_storage.go`):旧 `audioQualityRanks` 表达的其实是**编码格式序**(aac/m4a=3 > ogg=2 > mp3=1)而非音质序,曾把 320k mp3 判给 128k ogg 替换。现改为「无损 > 有损;同为有损按体积比 1.25×」。注意:`findSameNameAudioFiles` 会把 target 自身排除,所以**完全同名同格式重下仍无条件覆盖**(刻意保留,能修好截断的旧文件);只有"同 stem 不同扩展名"才走上述比较。
- **登录**(Settings):每源卡片 扫码登录(QRLoginCard;二维码 image_url 直接 `<img>`,url 文本则 QRCodeCanvas 画)+ 退出 + **手动填 Cookie**(带各源网址+F12教程+关键字段,COOKIE_HELP 映射)。登录态让验活/下载走 VIP 链路拿高音质。
- **播放**:全局常驻 PlayerContext,切页不停;播放失败自动跳下一首。
- **歌词**:SongRow"词"按钮拉 LRC。

## 播放器完整能力(2026-06,集中在 contexts/PlayerContext.js)

`PlayerContext.js` 同时是状态层(PlayerProvider)与 UI 层(PlayerBar:桌面横条 + 移动迷你条 + 全屏播放页)。`<audio>` 元素全局唯一,桌面/移动共用。

- **播放控制**:播放/暂停、上一首/下一首、进度拖动(seek)、空队列/死链处理。
- **播放队列**:`play(song, list)` 设队列(state 副本 `queue` 供面板渲染 + ref `queueRef` 供回调免闭包陈旧);桌面横条 ListMusic 按钮弹队列 popover,移动全屏页内队列覆盖层;点队列项 `playFromQueue` 只切曲不改队列。
- **4 种播放模式**(自定义 SVG 图标 `PlayModeIcon`):order 顺序(放完停)/ loop 列表循环(放完从头)/ repeat 单曲循环 / shuffle 随机。`pickNext(cur,forward,auto)`:auto 续播时 order 到队尾返 null 停止,手动点上/下一首任何模式都绕回。**默认 loop**,按设备持久化(localStorage `melodex_play_mode`)。
- **音量**:音量条 + 静音(仅桌面;移动用系统音量),持久化 localStorage `melodex_volume`。
- **播放进度记忆**:按登录用户 `melodex_playback_<userId>` 存上次的歌+队列+进度;登录后恢复(只加载定位不自动播放,浏览器禁 autoplay);节流 5s + 暂停时保存。
- **收藏**:每用户默认「我喜欢」歌单(后端 kind=favorite,见多用户节)。迷你条/全屏页心形按钮 toggle,乐观更新+失败回滚;收藏时后台静默下载到 NAS(与"加歌单即下载"一致),取消不下载。
- **MediaSession(PC 全局媒体键)**:绑 play/pause/prev/next/stop/seek action handler + `playbackState`(playing/paused,决定系统媒体键能否正确恢复)+ `setPositionState`(OS 媒体面板进度条)+ 封面走 cover_proxy 多尺寸 artwork。**关键**:只绑 handler 不够,必须同步 playbackState/positionState 系统媒体键才稳定接管(键盘 ⏯⏮⏭/耳机线控/Win 媒体浮层)。
- **移动端 QQ 音乐式**:迷你条(封面+跑马灯歌名+收藏/播放/队列三按钮,`bottom: calc(3.25rem + safe-area)` 贴底部 Tab 栏上方不留缝)→ 点击展开全屏播放页(滑入 player-slide-up / 收起 player-slide-down 动画;返回键 history.pushState 拦截为收起不退站)。
- **全屏播放页「沉浸式 + 可切换」——仅桌面端**(2026-11 重做,`contexts/playerStage.mjs` + `components/PlayerStageChrome.js` + `PlayerContext.js` 里的 `hidden lg:flex` 那段):顶部有**两颗切换控件**:
  - **布局三档**(默认档 = **沉浸**):`沉浸` = **大封面占左半 + 右侧歌词面板**;`歌词` = 歌词独占整屏;`封面` = 大封面独占整屏。**色板两档**:沉浸暗场(默认)/ 跟随主题。
  - **★ 什么叫"沉浸"(2026-11 用户纠正,别再搞错)**:用户给网易云参考图并明确「封面占半壁,剩下是歌词」。所以沉浸档的核心是**方形大封面当主角**(`.player-stage__art-frame` + `.player-stage__art-img`),**不是**深色底 + 嵌在黑胶里的小圆盘 —— 第一版就是后者,被用户直接否掉(「你那算个几把的沉浸」)。桌面舞台里现在**不再有** `vinyl-wrap`/`turntable`/`tonearm`,由 `playerStage.test.mjs` 断言锁死。
  - **封面尺寸必须够大**:`clamp(15rem, min(44vw, 52vh), 44rem)`。判据是**宽度**为主(占屏宽 ≥33% 或屏高 ≥40%),用 vw 不是 vh;上限 44rem 是防止 4K 上荒谬,不能小到把 2K 屏卡成小方块(34rem 时 2560 宽只有 21%,实测不够)。
  - 沉浸档歌词区:`flex:1 1 0` + 左对齐 + 上下渐隐 mask(还没唱到的行自然淡出,不是被容器切一刀);空歌词有专门的说明态,不是光秃秃一行"暂无歌词"。
  - 沉浸档**与全站主题无关地变深**,做法是在 `.player-stage--immersive` 里**重定义 --background/--foreground/--muted-foreground/--primary 等语义 token**,舞台内所有 Tailwind 类与 `.player-lyric-line` 自动跟着走(比逐元素覆盖少漏);强调色必须换成深色那档的浅蓝(沿用浅色主题的 #004F99 在深底上等于看不见)。「跟随主题」档**不重定义任何颜色**,只把封面底图压淡。
  - 偏好按设备落 localStorage(`melodex_stage_layout` / `melodex_stage_tone`),脏值与存储抛错一律收敛到默认(无痕模式不能崩)。
  - **★ 移动端不参与**:`.lg:hidden` 那张整段保持重做前的原样(「封面 ↔ 歌词」隐式点击切换),用户明确「只要桌面端」。所以 `showLyric` 状态与 `activeLyricRef` 滚动必须**继续存在**并只服务移动端;桌面端读舞台档位。`playerStage.test.mjs` 用两段注释标题切片,断言切换控件**只在桌面段**、移动段必须仍有 `setShowLyric`。
  - **★ 坑:舞台 CSS 写在 @layer 之外,不得声明 display / position / inset / z-index**。未分层样式优先级高于 @layer 中的 Tailwind utilities,写 `display:flex` 会压过 `hidden`(两套断点舞台同时显示),写 `position:relative` 会压过 `fixed`(舞台不黏视口)。这两类只在真机可见,构建/单测/门禁全不报 —— 现由 `playerStage.test.mjs` 逐条锁死(已用突变验证能抓到)。
  - **两端歌词可见性判据不同**:移动端 `mobileLyricsVisible = expanded && showLyric`,桌面端 `desktopLyricsVisible = expanded && stageShowsLyrics(stageLayout)`。两个滚动 effect 各用独立快照,混用会让"从隐藏端切到可见端"被误判成逐行推进、从第一行一路滑到当前行。注意 `stageShowsLyrics` 返回 true 的是 `disc`(沉浸)与 `lyrics`,**不是** `split`(封面档没有歌词)。
  - **不要逆向网易云客户端**:用户提过"逆向学习",但那既拿不到"为什么好看"也踩 AGPL/许可证红线。参考图已经把设计语言讲透(大封面 + 右侧歌词 + 模糊封面底 + 当前行高亮),从图里读规范即可。
- **留声机 + 逐字歌词**(全屏页):黑胶唱片(封面嵌黑胶,播放转 vinyl-spin / 暂停停 + 唱臂 .up/.down 摆动)↔ 布局档位决定唱片/歌词各自的去留。歌词 `parseLRC` 自适应:QQ 逐字 LRC(每字时间戳,≥2 有效字段)→ `KaraokeLine` 卡拉OK填色(background-clip:text 按 progress.cur 渐变);网易行级 LRC(行首+行尾两戳)→ 整行高亮;当前行 scrollIntoView 居中。
- **封面**:列表/歌单/播放器所有封面走 `coverProxyUrl`(后端 cover_proxy,解决网易 http 在 https 被拦混合内容 + 防盗链 + 磁盘缓存);无封面 lucide Music 占位。
- **行交互**(SongRow):手机 coarse 指针单击整行 / 电脑双击整行播放;行内按钮 stopPropagation 不触发行播放;歌单详情 onRemove 删除按钮内嵌长条内。
- **持久化偏好均按设备**(localStorage,不跨设备):音量/播放模式/进度。要跨设备需挪后端 user_prefs。
- **SW 自动更新**:vite-plugin-pwa `registerType:autoUpdate` + workbox `skipWaiting/clientsClaim/cleanupOutdatedCaches`,新部署 SW 立即接管,用户无需手动清缓存(此前漏配致"刷新还是旧 bundle")。

## 测试与验证纪律(重要)

- 后端改动:`go build ./cmd/melodex` + `go test ./internal/web/ ./core/ ./internal/provider/...`,**零回归**才提交。
- 前端有定向 Node 合同测试,按改动范围运行对应脚本;当前禁止浏览器自动化,真实搜索、播放和视觉行为需在允许的真机验收阶段单独确认。
- **真实数据验证**:用真实关键词(周杰伦晴天等),不自造样本。ffprobe 验下载文件的元数据/封面。
- **playwright 会话偶发卡死**("Browser is already in use",清 SingletonLock 也无效)→ 别死磕,改用真实搜索数据直接跑纯逻辑函数(如 relevanceScore 排序)验证,同样可靠。
- **音质相关验证需登录**:未登录后端验活/inspect 多返 128k,看不出无损/音质排序效果;无登录环境用合成数据验证排序逻辑,真实效果在生产(已登录会员)才显现。
- **改了样式没生效优先怀疑**:① 浏览器/PWA service worker 缓存(强制重载 / Ctrl+F5 / 注销 SW + 清 caches)② HTML 行内 style 优先级高于 CSS。**但别一律归咎缓存**:曾因 `bg-popover` 没在 tailwind.config 映射(只映了 card 漏了 popover)渲染成透明 `rgba(0,0,0,0)`,被误判成缓存让用户白刷几十遍——**"看起来不对"先用 getComputedStyle 查真实渲染值**(背景/位置/层级),确认是真渲染问题再排查,别空推缓存。用 tailwind 颜色类前确认该色在 config 里有映射。
- **音流(musiver Android)客户端坑**:① 对 search3 结果**客户端重排 + 同名折叠**(无视服务端顺序,服务端把原唱排第1它仍可能显第14)——服务端排序对它无效,这是它闭源的固有行为(GitHub gitbobobo/StreamMusic 只有文档站无源码,相关 issue 全 P3);② **「边听边存」开关有 bug**,开了任何歌播不了反复重拉(开发者 issue#1022 确认),需关掉。结论:音流排序/播放问题多在客户端,**服务端响应每项都验证正确却仍异常时,早去查客户端 issue 别在服务端空转**;主力用法已转 PWA Web 前端(排序自控)。

## 部署(NAS,Unraid x86_64)

- 代码在 NAS **`/mnt/user/appdata/melodex-src`**（2026-11-23 核实；旧文档写的 `/mnt/cache/appdata/...`
  也指向同一份数据，但 `find` 实查的结果是这个路径，按这个来），Docker compose 运行,端口 **8329**。
- 访问 `https://music.9li.life`(NPM 反代 + **Authentik SSO** 守门)。PWA 静态资源(manifest/sw.js/图标)在 NPM 该站 Custom Nginx Config 用 `auth_request off;` 放行,其余走 SSO。
- **NAS 构建坑**:① 私仓 clone 用内网 `ssh://git@<NAS内网地址>:<内部SSH端口>/...`(公网回环 NAT hairpin 超时;真实地址见仓库外私有笔记,本仓库公开故不记载)② docker.io 拉不到基础镜像 → 从 `docker.1ms.run` 拉 golang:1.25/alpine:3.22/node:20-alpine 再 `docker tag` 成原名,build 加 `--pull=false` ③ go mod 走 `--build-arg GOPROXY=https://goproxy.cn,direct` ④ 挂载的 `data` 目录要 `chown 1000:1000`(容器内 appuser uid)否则 SQLite 报 "out of memory"(实为权限)⑤ `npm ci` 直连官方源会卡死,传 `--build-arg NPM_REGISTRY=https://registry.npmmirror.com`。
- **生产现状(2026-11-12 核实)**:应用镜像是 **NAS 本地构建的 `melodex:latest`**,不是 GHCR 预构建镜像(下面「镜像发布」节的 2026-10-25 记录已过时);provider 仍用 `ghcr.io/aki-riko/melodex-provider:edge`。
  NAS `.env` 第 7 行已改为 `MELODEX_IMAGE=melodex:latest`(此前写着 `ghcr.io/aki-riko/melodex:v0.2.1`,与实际运行不符 ——
  直接 `docker compose up -d` 会把生产悄悄退回 v0.2.1),改前备份 `.env.bak_20261112_214413`。
- **部署流程(应用镜像,provider 与 postgres 不动)**:
  1. `cd /mnt/cache/appdata/melodex-src && git pull --ff-only origin master`
  2. 先给当前镜像打回退标签:`docker tag melodex:latest melodex:rollback-<旧提交短哈希>`
  3. `docker build --pull=false --build-arg IMAGE_PREFIX=docker.io/library --build-arg GOPROXY=https://goproxy.cn,direct --build-arg NPM_REGISTRY=https://registry.npmmirror.com -t melodex:latest .`
  4. `docker compose up -d --no-build --no-deps melodex`(只重建应用容器)
  5. 验证:`docker exec melodex wget -qO- http://127.0.0.1:8329/api/v1/healthz` 应为 `{"app":"melodex","status":"ok"}`;
     改了前端静态资源时,再比对 `docker exec melodex wget -qO- http://127.0.0.1:8329/logo512.png | sha256sum` 与本地文件。
  - **★ `GOPROXY` 必须显式传**(2026-11-23 实测踩到):Dockerfile 里 `ARG GOPROXY=direct`,
    不传就直连 `golang.org` 拉模块,150s 后超时失败:
    `go: golang.org/x/arch@v0.20.0: unrecognized import path ... dial tcp ... i/o timeout`。
    ▲ 此时**前端阶段是成功的**(日志里能看到 `✓ built in 3.47s` 与新 css 哈希),
    只有 Go 阶段挂 —— 别看到前端构建成功就以为整个构建过了。
  - **为什么传 `IMAGE_PREFIX=docker.io/library`**:Dockerfile 默认前缀是 `docker.1ms.run/library`,
    2026-11-12 该镜像站 CDN 中途断连(`failed to copy: httpReadSeeker ... EOF`),构建在拉 `alpine:3.22` 元数据时失败。
    NAS 本地已有按原名 retag 的 `alpine:3.22` / `node:20-alpine` / `golang:1.25`,换成 `docker.io/library` 前缀 + `--pull=false`
    就完全不联网拉基础镜像。基础镜像本地没有时,才需要先按 ② 从镜像站拉再 retag。
  - **开发机 SSH 到 NAS 要用 Windows 自带的 OpenSSH**(`/c/Windows/System32/OpenSSH/ssh.exe`):`~/.ssh/config` 里 NAS 的
    `IdentityFile` 指向 `.pub`,私钥在 Windows SSH agent 里;Git Bash 自带的 ssh 连不上这个 agent,报
    `Load key ".../nas_unraid.pub": error in libcrypto: unsupported` 后被拒。
- **音乐下载位置可自定义**:compose 里 `- ${MELODEX_DOWNLOAD_DIR:-./data/downloads}:/home/appuser/data/downloads`
  —— 默认值与现状一致(宿主 `./data/downloads` ↔ 容器 `/home/appuser/data/downloads`,实测 741 个文件两边一致、
  目录属 `1000:1000`);在 `.env` 设 `MELODEX_DOWNLOAD_DIR=/宿主/绝对路径` 就能换地方(如 Plex/Navidrome 扫的媒体目录)。
  **容器内路径恒定不变**是刻意的:应用里的「下载目录」系统设置(`core.WebSettings.DownloadDir`,默认相对路径
  `data/downloads`)、`DownloadRecord.RelPath`(相对下载目录,是本地库/服务器副本播放的关联键)、本地音乐库扫描
  全部照旧,不需要动应用设置。
  两个前提:① 宿主目录要先 `mkdir` 并 `chown 1000:1000`(容器内 appuser;实测 root:root 的目录 `touch` 直接
  Permission denied,1000:1000 才 WRITE_OK,而且 Docker 会以 root 自动创建不存在的宿主目录,很容易踩),
  ② 换目录要把 `data/downloads` 已有文件搬过去,否则文件不在、`GET /music/downloads` 会把这些记录过滤掉。
  另外注意:**「下载目录」目前在 React 界面里只显示不可改**(Settings 页只有一行「下载目录:…」);
  要改应用内的路径只能走管理员接口 `POST /music/settings`(GET 完整设置 → 改 `downloadDir` → 整份 POST 回去,
  别只发一个字段:那是整份覆盖,`embedDownload` 这类 bool 没有默认值兜底会被清掉),
  而且换应用内路径会让旧的 relPath 记录失配 —— 所以优先用上面的挂载法。
  **生产已于 2026-09-11 实际切换**(可用此法核对/回退):`.env` 里
  `MELODEX_DOWNLOAD_DIR=/mnt/user/data/media/link/音乐`(阵列 shfs,宿主目录已 `chown 1000:1000`),
  ▲ **注意真实路径是 `data/media`(小写)不是 `Media`** —— 本文档曾把这里写成 `/mnt/user/Media/link/音乐`,
  按文档去核对会得到 "No such file or directory",白白浪费一轮排查(2026-11-24 实测两处大小写不一致)。
  迁移方式 `rsync -a` 741 个文件 / 19,653,291,976 字节,校验用 `rsync -rcn --delete` 复核传输数 = 0,
  核对无误后才删缓存池旧副本(`/mnt/cache/appdata/melodex-src/data/downloads` 现为空目录,
  19G 从 appdata 缓存池释放 —— **appdata 是 ZFS,`df` 有片刻延迟**:删完立刻看可能还是 207G/13%,
  过一会儿才是 188G/12%,别以为没释放又去折腾)。库构成:.flac 550 / .mp3 59 / .m4a 12 / .ogg 11 + .lrc 109 = 741;
  应用侧临时容器调 `GET /music/local_music` 扫到 **632 首**(音频数,`exists:true`),
  Postgres 里 633 条 `download_records` 的 rel_path **全部**在新目录命中(633 记录 = 632 文件,
  因为 `晚安 - 许莉洁.ogg` 有两条身份记录)—— 所以「已下载」状态与"服务器副本优先播放"不需要改任何数据。
  回退只需把 `.env` 里那行删掉再 `docker compose up -d melodex`(文件不会自己回去)。

### ★ 真实事故(2026-11-24):自动缓存到 NAS「悄悄失效」两个月

**现象**:用户报「现在播放似乎不会自动缓存到 NAS 了」,前端无报错、无提示,看起来功能没了。

**根因**:切换下载目录后,`/mnt/user/data/media/link/音乐` 是 `root:root 755`,而容器以
`appuser(uid=1000)` 运行 → 该身份属"others",**没有写权限**。于是链路是:前端照常发
`POST ?save_local=1` → 后端照常拉到音频 → `os.CreateTemp` 处 `Permission denied` →
**只回 JSON、日志一行不打** → 用户侧完全无迹可循。最后一条成功下载记录停在 `2026-09-18`,
之后 10 月/11 月 `download_records` 新增 **0 条**,而同期播放照常(11-18 单日 69 次)。

**★ 这次真正的教训不是"忘了 chown",而是三条排查/可观测性纪律:**

1. **下载目录换位置后,必须验证的是"容器身份可写"而不是"目录存在"。**
   正确判据(容器内执行,宿主用户无关):
   ```bash
   docker exec melodex sh -c 'test -w /home/appuser/data/downloads && echo WRITABLE || echo NOT_WRITABLE'
   ```
   `docker exec melodex id` 应为 `uid=1000(appuser)`;`ls -ld <宿主目录>` 的 owner 必须是 **1000**。
   只 `mkdir` 不 `chown` 时目录是 `root:root 755`,**读得到、列得出、就是写不进** —— 这类缺陷
   在只读检查里完全隐形。修复:`chown -R 1000:1000 "<宿主音乐目录>"`。
2. **数据库 `download_records` 的 `max(created_at)` 是这条链路的黄金指标。**
   怀疑"不缓存了"第一时间查它,不要从前端代码开始猜:
   ```bash
   docker exec melodex-postgres sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB \
     -c "SELECT count(*), max(created_at) FROM download_records;"'
   # 再按日/按月看断点:
     -c "SELECT to_char(created_at,'YYYY-MM') m, count(*) FROM download_records GROUP BY 1 ORDER BY 1 DESC;"
   ```
   与 `play_history_rows` 同期数据对比:播放有、下载无 → 断在写盘/权限;两者都无 → 断在前端。
3. **后端写盘失败必须留日志**(已修,`music_routes.go` 的 `saveTrackToServer`/`saveWebAssetResponse`)。
   现在失败会打 `[download] save to server failed source=... id=... dir=...: ...`,
   一条命令就能定位:`docker logs melodex 2>&1 | grep '\[download\]'`。
   前端 `PlayerContext`/`NativePlayerProvider` 的 `saveToServer` 也会 `console.warn`(含后端 200
   但 `saved/recorded` 不为 true 的情况)。

**★ 排查时踩到的假象(会把人带偏,记下来):**
- **"72 小时 0 次 POST"是假证据**:容器刚重建,`docker logs` 只覆盖那 20 分钟。
  判断日志覆盖范围必须先看 `docker ps` 的 `Up` 时长与日志首行时间戳。
- `settings.db` 停在 7 月不代表数据没在写:生产用 **Postgres**(`MUSIC_DL_DATABASE_DRIVER=postgres`),
  `settings.db` 只是 `MUSIC_DL_LEGACY_SQLITE_DB` 遗留文件。真实数据在 `melodex-postgres` 容器里。
- 前端是 `go:embed` 编译进二进制的,线上包要查有没有某段逻辑,得
  `curl -s http://127.0.0.1:8329/assets/index-*.js | grep -o <特征串> | wc -l`
  (**别用 `grep -c`,压缩包只有一行,它恒返回 1,会得出相反结论**)。
- 本机 curl 打容器要 `--noproxy "*"`,否则走开发机 7897 代理连不上。
  容器内自测用 `127.0.0.1:8329`;从 NAS 宿主访问用
  `docker inspect <容器> --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'`
  动态取容器 IP(不要写死网段,重建后会变)。


- **安全相关 env(2026-06 审计后新增,反代部署建议配)**:
  - `MUSIC_DL_TRUSTED_PROXIES`:逗号分隔 CIDR/IP(如 NPM 容器网段 `172.18.0.0/16`)。配后仅这些来源的 `X-Forwarded-For` 被 `ClientIP()` 采信,防客户端伪造 XFF 绕过限流/登录锁。**不配时后端不信任任何代理并忽略 XFF**;配置非法则拒绝启动。有反代且需要还原客户端 IP 时务必准确配置。
  - `MUSIC_DL_CORS_ORIGINS`:逗号分隔的可信跨域来源(同源无需配)。CORS 不再反射任意 Origin,只对同源+此白名单回显凭据。
  - cookie `Secure` 自动按 `X-Forwarded-Proto=https` 置位(NPM 终止 TLS 场景),无需配置但 NPM 需透传该头。
  - 资源上限默认值:搜索 per-IP 30 次/分钟、search_cache 5000 行、上传单文件 200MB、m3u 导入 ≤1000 条(均硬编码,需调改源码)。
  - **搜索延迟相关 env**:`MUSIC_DL_SEARCH_SOURCE_BUDGET`(默认 12s,compose 里已配)—— 只是安全网,
    正常情况"主力源(qq/netease)齐了就返回",实测端到端 2~3s;想多等一会儿多收几个源就调大它。
    `MELODEX_NETEASE_NATIVE_SEARCH=0` 可让网易退回快照实现(慢 130 倍,不建议)。

## 安卓打包与装机(2026-11-12 实测)

APK 是外壳(`server.url = https://music.9li.life`),页面内容随 NAS 部署更新;**启动器图标、原生插件**等改动必须重新装 APK。

- **本地打包**:`pwsh -NoProfile -File android/build.ps1`(默认跑 `testDebugUnitTest` + `assembleDebug`),两个前提缺一不可:
  1. **必须用 PowerShell 7(`pwsh`),不能用 Windows 自带的 `powershell.exe`(5.1)**:5.1 按 GBK 读这个 UTF-8 脚本,
     中文字符串变乱码,脚本在语法解析阶段就报 `UnexpectedToken`,根本没进 Gradle。
  2. **必须用 JDK 21**:开发机 `JAVA_HOME` 是 JDK 17,编译 `:capacitor-android:compileDebugJavaWithJavac` 时报
     「无效的源发行版:21」。脚本支持只对本次生效的覆盖:`MELODEX_JAVA_HOME='C:\Program Files\Microsoft\jdk-21.0.11.10-hotspot'`,不用改系统设置。
- **本地 debug 包装不到用户手机上**:手机上装的是 CI 发的**正式签名包**(`CN=Melodex, OU=Release`,
  证书 SHA-256 `5f28d565…`),本地包是 Android 默认调试证书,且不传 `-PmelodexVersionCode` 时版本号默认是 **2**。
  `adb install -r` 会以 `INSTALL_FAILED_VERSION_DOWNGRADE` / 签名不一致失败;唯一的绕过是先卸载,**会清空 App 数据(登录态、本地设置)**,
  必须先征得用户同意。本机没有正式签名所需的 `ANDROID_KEYSTORE_*` 环境变量。
- **要更新用户手机 → 打标签走 CI**:推 `vX.Y.Z` 或 `vX.Y.Z-rc.N` 标签触发 `android-release.yml`(同时也会触发 `docker-publish.yml`)。
  版本号由 `android/scripts/resolve-release-version.mjs` 算:`major*1000000 + minor*10000 + patch*100 + (rc 或 99)`,
  例 `v0.2.2-rc.1` → 20201;新标签的版本号必须大于手机上已装的才能覆盖安装。
  - 发版 job 在 **`android-release` 环境等人工审批**(审批人 aki-riko;只允许 `v*` 标签部署)。网页上要点 Review deployments →
    勾选 `android-release` → **Approve and deploy**,只勾选不确认不会生效。曾有 4 次发版(`v0.2.1-rc.6`~`v0.2.1`)在这里挂了四天没人批,
    2026-11-12 已取消。用户明确同意时也可以命令行批准单个运行:
    `gh api -X POST repos/aki-riko/Melodex/actions/runs/<run_id>/pending_deployments -F 'environment_ids[]=<env_id>' -f state=approved -f comment='…'`
    (`env_id` 从同一路径的 GET 里取)。审批是用户设的门槛,不要未经同意替用户批。
  - 装机前核对:Release 附带的 `.sha256` 与下载的文件一致;`aapt2 dump badging` 看 versionCode/versionName;
    `apksigner verify --print-certs` 看签名证书与手机上原版一致。
  - **核对图标别比字节哈希**:正式包会重新压缩 PNG 并把资源改名(如 `res/o-.png`),要先用 `aapt2 dump resources` 找到
    `mipmap/ic_launcher (xxxhdpi)` 对应的文件,再**逐像素**比对(2026-11-12 实测字节哈希不同、147456 个通道值完全一致)。
  - 装机:`adb install -r <apk>`,覆盖安装保留 App 数据;装完 `adb shell dumpsys package life.nineli.melodex | grep -E "versionCode|versionName|lastUpdateTime"` 确认。

## 镜像发布(GHCR,2026-09 新增)

`.github/workflows/docker-publish.yml`:打 `v*` 标签或手动 dispatch 才跑(**普通 push 不跑**,免得每次提交都推镜像),
用内置 `GITHUB_TOKEN`(`packages: write`)推到 `ghcr.io/aki-riko/melodex` 与 `ghcr.io/aki-riko/melodex-provider`,
**不需要任何额外 secret**。标签规则:`v1.2.3` → `v1.2.3` + `latest` + `sha-<short>`;手动触发 → `<extra_tag>`(默认 `edge`)+ `sha-<short>`。
**带 `-` 的预发布标签(本仓库在用的 `v0.2.1-rc.1` 这种)故意不打 `latest`** —— 否则 `latest` 会指向候选版。
标签计算这一步可以脱网真跑验证:`GITHUB_OUTPUT=<临时文件> REF_TYPE=tag REF_NAME=v1.2.3 bash <(渲染后的步骤)`。
实测真跑结果:`v1.2.3` → `v1.2.3,latest,sha-…`;`v0.2.1-rc.3` → `v0.2.1-rc.3,sha-…`(无 latest);
dispatch → `edge,sha-…`(extra_tag 空也回退 `edge`);owner 大写会被转成小写。
首次真实运行(2026-09,run 34610640123,手动 dispatch)实测:两个 job 全绿(melodex 2m40s / provider 1m8s),
`edge` 与 `sha-4ac6c71` 同 digest,包为**公开**(匿名 token 可取 ✓)。

- 两个镜像各跑一次**真启动冒烟**:应用镜像起服务 + `wget /api/v1/healthz` + 断言首页含 `id="root"` 与 `/assets/`
  (证明 React 产物确实被 `go:embed` 进去了,这是最容易悄悄坏掉的一环);provider 镜像 import 一遍
  `provider_bridge`(含 `server`/`app`/`qq_*`/`netease_source`/`kugou_lyric`)并确认固定快照 `LICENSE` 在位。
- **基础镜像前缀 `IMAGE_PREFIX`**:两个 Dockerfile 都改成 `ARG IMAGE_PREFIX=…` + `FROM ${IMAGE_PREFIX}/…`。
  应用镜像默认仍是 `docker.1ms.run/library`(NAS 直连 docker.io 拉不到),provider 默认 `docker.io/library`(=原样);
  **CI 显式传 `--build-arg IMAGE_PREFIX=docker.io/library`** —— 境外 runner 不要去拉国内镜像站。
- **冒烟脚本必须落文件再挂进容器**(`printf '%s\n' "$SMOKE" > /tmp/smoke.sh` + `-v /tmp/smoke.sh:/smoke.sh:ro`),
  不要写成 `sh -c "${{ matrix.smoke }}"`:多行命令里的引号会被外层 shell 吃掉(实测 `python -c "…"` 直接语法错误,
  由 `sh -n` 预检抓出)。
- 用预构建镜像:compose 里两个服务都写成 `image: ${MELODEX_IMAGE:-melodex:latest}` /
  `${MELODEX_PROVIDER_IMAGE:-melodex-provider:apache-2.0}`(默认值不变,纯本地构建部署零影响)。
  在 `.env` 设 `MELODEX_IMAGE=ghcr.io/aki-riko/melodex:edge` 后 `docker compose up -d --no-build` 即可切过去。
- **NAS 拉 GHCR 并不慢(2026-10-25 实测,已更正旧记录)**:经 `/etc/docker/daemon.json` 里配的
  `proxies.http-proxy/https-proxy = http://127.0.0.1:7890` 拉取,`melodex-provider:edge` **22s**、
  `melodex:edge` **9s**(本机 curl 直测 GHCR blob 经代理 ~9.6MB/s、直连 ~10MB/s)。
  > 历史坑:这里原先写着「实测只有 ~90KB/s,131MB 要二十多分钟」——那是 2026-09 某一次的瞬时观测,
  > **不是常态**,却被当成结论沿用,导致后来误判「切预构建镜像要等很久」。要判断网络问题请当场实测
  > (`curl -o /dev/null -w '%{speed_download} B/s'` 打一个 blob),别引用这条旧数字。
  注意区分两台机器的代理端口:**NAS 是 7890**,开发机(Windows)是 `7897`;
  别拿本机端口去测 NAS,反之亦然。registry 匿名可取 token/manifest/blob(均为公开包)。
- **(历史记录,已过时 —— 当前生产状态见「部署」节)生产曾切预构建镜像(2026-10-25)**:NAS `.env` 第 7-8 行设为
  `MELODEX_IMAGE=ghcr.io/aki-riko/melodex:edge` / `MELODEX_PROVIDER_IMAGE=ghcr.io/aki-riko/melodex-provider:edge`,
  `docker compose up -d --no-build` 生效;当时对应提交 `d1b0203`,镜像 digest
  `melodex@sha256:dcb1fd76…` / `melodex-provider@sha256:e05f74b4…`。
  **回退**:`.env.bak_20261025_045314` 是切换前备份,注释掉那两行再 `up -d --no-build` 即回到
  本地构建的 `melodex:latest` / `melodex-provider:apache-2.0`(旧镜像仍留在机器上)。
  验证:`docker exec melodex wget -qO- http://127.0.0.1:8329/api/v1/healthz`。
- 许可证标签:应用镜像 `AGPL-3.0`;provider 镜像 `AGPL-3.0 AND Apache-2.0 AND GPL-3.0-only`(内含固定快照与 QRC 解密实现)。

## Git

- 双远程:fetch 走私仓,`git push` 一次双发 → 私仓 `git@<私有 Git 主机>:<账户>/Melodex.git` + GitHub `git@github.com:aki-riko/Melodex.git`（**本仓库公开**,内网地址/账户名不在此记载,见仓库外私有笔记）。
- 仓库名、品牌名和界面名称统一为 **Melodex**。
- git 身份 local:Kotori <kotori@9li.life>。每次改动提交,push 前确保 build/test 过。

### 分支保护 `verify` 检查(2026-09 修)
master 的分支保护要求 status check **`verify`**(来自 GitHub Actions, app_id 15368;`enforce_admins=false`,
所以管理员直推只是被"提示绕过")。原先 `android-ci.yml` 用 `paths:` 过滤**触发条件**, 不碰 `android/**` 的推送
根本不跑 workflow → 检查永不上报, 每次直推 master 都靠管理员权限绕过(remote 回显
`Required status check "verify" is expected`), 且 dependabot 之外没有任何 `verify` 运行记录
(`gh run list -R aki-riko/Melodex --workflow=android-ci.yml` 可核)。

现在改为: 去掉触发条件上的 `paths`, **每次 push/PR 都运行**, 是否跑完整 Android 构建由 job 内
`Detect Android-related changes`(`git diff` 比对 `github.event.before` / PR base, 路径范围与旧 `paths` 完全一致)
决定 —— 不相关时 11 个重步骤跳过、job 仍成功。实测: 非 Android 推送 14s 通过, Android 改动 2m8s 跑完整构建。
**注意**: 直推 master 时 remote 仍会打印那次 bypass 提示 —— 检查不可能在被推的那个 commit 上"已经"通过。
要彻底消除只有两条路: (a) 改走 PR 合入(required check 在 PR 上判定, 无需绕过),
或 (b) 在 GitHub 上关掉该 required check(需仓库管理员权限; 本机 `gh` token 没有 `administration` scope)。
`desktop-lyrics-ci.yml` 里也有个 job 键名叫 `verify`, 但它的 `name` 是 `${{ matrix.name }}`(windows/macos),
不占用 `verify` 这个 check 名, 不要把它接成 required。

## Provider 源覆盖、歌词能力与补源工作量(2026-09 核查)

### "歌单/专辑源覆盖 12→5" 不是重构退步, 是能力矩阵
`core/providers.go` 的清单(由 `core/provider_catalog_contract_test.go` 锁定):

| 清单 | 数量 | 源 |
| --- | --- | --- |
| `allProviderNames` 全部 | 12 | netease, qq, kugou, kuwo, migu, fivesing, jamendo, joox, qianqian, soda, bilibili, apple |
| `defaultProviderNames` 搜索默认 | 7 | netease, qq, kugou, kuwo, migu, qianqian, soda |
| `collectionProviderNames` 歌单/专辑/分类/推荐 | 5 | netease, qq, kugou, kuwo, migu |
| `userLibrarySourceNames` 用户歌单导入 | 2 | netease, qq |
| `cookieSourceNames` 可存 cookie | 8 | netease, qq, qq_wx, kugou, kuwo, migu, bilibili, soda |
| `GetQRLoginSourceNames` 扫码登录 | 2 | netease, qq |

2026-08-15 的 refactor `b681335`("将歌单与登录流程迁移到 Charles sidecar")迁移前的
`collectionProviderFactories` **本来就只有那 5 个源**(`git show b681335 -- backend/core/providers.go` 可核)。
即"12 个源里只有 5 个具备歌单/专辑能力"一直是事实, 迁移前后一致, 没有源在重构中丢掉歌单支持。

### 为什么补歌单/专辑贵: 固定快照根本不提供这个能力
`third_party/charles-musicdl` 是**搜索/下载库**: 所有源类只有 `_search` + `download`
(`grep -n 'def ' musicdl/modules/sources/*.py` 可核), 没有任何歌单/专辑/分类接口。
现有 5 个源能歌单, 靠的是 `provider_bridge/platforms/<source>.py` 里**自研**的平台客户端(6.5–14KB/个)。
再补一个源 = 从零逆向该平台的 专辑/歌单/推荐/分类/用户歌单/parse 链接 六类接口, **0.5–1 天/源**。

### 快照里那 ~34 个源大多已死: 别指望"多接源"白捡覆盖率
快照 `MusicClientBuilder.REGISTERED_MODULES` 注册 34 个源, Melodex 只放行 12 个。
2026-09 用真实关键词扫过其余候选(jcpoo/gequbao/htqyy/kkws/yinyuedao/mitu/fivesong/buguyy/fangpi/
gequhai/twot58/livepoo/mp3juice/myfreemp3/tunehub/gdstudio/flmp3): 对「周杰伦 晴天」**全部 0 首**,
其中 flmp3/kkws/fivesong 直接 `AssertionError`(站点结构已变)、mp3juice `AttributeError`。
结论: 在这份固定快照上"加源"提不了覆盖率, 有效路径是修好现有源(如 2026-09 给 QQ/网易做的原生实现)。

### 其他源"扫码登录 / 会员校验"的可行方案与工作量
- **会员校验**(`provider_bridge/account.py` → `/v1/account/verify` → `core.BuildCookieStatusDetail`): 目前只有
  netease(一个用户接口 + vipType 判断, 22 行)。每加一源 = 找该平台"当前用户"接口 + 判会员字段 + 合成响应单测,
  **1–2 小时/源**; 真机验收需要该源一份有效 cookie(生产当前只存 netease/qq/bilibili)。
- **扫码登录**(`core.GetQRLoginSourceNames()` = **netease + qq**; 其余源靠 Settings 手动填 cookie):
  - **netease**: 网易自己的 unikey 轮询(`provider_bridge/qr.py`)。
  - **qq**: `provider_bridge/qq_login.py` —— ptqrshow 取二维码 → ptqrlogin 轮询 →
    check_sig 收授权 cookie → `graph.qq.com/oauth2.0/authorize` 换 code →
    `musicu` 的 `QQConnectLogin.LoginServer/QQLogin` 换强凭证(musickey/musicid/keyExpiresIn…)。
    **这个入口被删过一次**: 2026-08-15 的 `d222a0c`(后端来源脱钩)把它连同
    `music-lib/qq/login.go` 一起删了(当年还修过 5 次 check_sig: 650dcd3/192c63a/d07acc2/
    d9bed20/21edac9), 之后界面 QQ 卡片就没有"扫码"按钮了; 2026-09 按新架构重建。
    两个当年踩过的坑写在 `qq_login.py` 文件头: ptsigx 必须逐字节保留(URL 解码会把 `+`
    变空格 → check_sig 失败), 以及授权 token 要按 p_skey→skey→superkey→supertoken→
    pt_oauth_token→g_tk=5381 的顺序回退。
  - 前端**不需要为新增扫码源改代码**: `qrSupported` 来自 `/api/v1/qr_login/sources`,
    名单一变卡片上就自动出现"扫码"; `Settings.js` 的 `qrLoginNote` 早就写好 qq 分支
    (`credential_source === 'qq_connect_login'` / `strong_login_error`) —— 当年只删了后端。
  - 还要做的源: bilibili 有公开 QR 接口 ~2h; kugou ~3h; kuwo/migu 无公开 QR 需逆向客户端
    4–6h/源且成功率低。
  - **验收边界**: 扫码后在手机上"确认登录"以及之后的强登录换取, 必须由用户真机扫一次才能验收;
    create/轮询接口本身可以机器验证(实测 create 0.18s 返回真实 111×111 PNG + qrsig,
    check 0.19s 返回 code=66「二维码未失效。」)。

### 搜索延迟与"主力源早退"(2026-09 提速)
实测各家耗时(limit=20, 全部并发起跑, 生产容器内):

| 源 | 耗时 | 结果 | 说明 |
| --- | --- | --- | --- |
| soda | 0.5s | 0 | 快但没货 |
| qq | 1.7s(慢时 8.4s) | 3~10 | Melodex 原生实现; 会员凭证有效时 20 首全可播 |
| netease(原生) | ~1.0s | 20 | `netease_source.search_songs`, 可播 20/20、FLAC 1394~1607k |
| qianqian | 18.7s | 5 | 前台不等, 由后台补齐任务写进缓存后再出现 |
| kugou | 25.2s | 2 | 同上。缺酷狗会员 cookie 时每一档 hash 都回 "Needs to be Paid", 所以只有免费曲 |
| kuwo | 83.7s | 20 | 快照实现每首跑音质阶梯+探活; 官方接口现已加签名("request is illegal"), 做原生要另找路子 |
| migu | 114.9s | 3 | 同上 |
| netease(快照) | 131.7s | 17 | **已由原生实现取代**(131.7s → 1.0s) |

慢的根因: 快照客户端对**每首歌**都要跑 8 档音质阶梯并探测下载地址, 20 首就是 1~2 分钟。
历史与现状:
- 最初 `MUSIC_DL_SEARCH_SOURCE_BUDGET=60s` → 端到端**每次实打实等满 60.1s**, 而且 netease/kuwo
  跑不完被**整源丢掉**(用户既等得久又拿不到结果)。
- 网易改原生后 → 12.1s。
- 再改成"**等齐主力源就返回**"(`json_api.go` 的 `searchPrimarySources = {qq, netease}`:
  主力源齐了立刻返回, 其余源只在预算内赶上才算) → **2.0~2.9s**, 且 netease 20 首回来了。
  边界: 用户若在源选择里排除了全部主力源, 则仍等齐所选源(不超过预算), 免得第一个返回就丢其余的。
  回归测试: `internal/web/search_primary_test.go`(慢源挂 10s 也必须 <3s 返回、不含其结果,
  并断言 pending 准确报出没等到的源)。
- **慢源照样参与(2026-09, 用户明确要求"它们还是要参与搜索")**: 前台不等, 但也不丢 ——
  没等到的源名报在响应字段 `pending_sources` 里; 后台 `completeSearchCacheAsync` 用
  `MUSIC_DL_SEARCH_COMPLETE_BUDGET`(默认 150s)把它们跑完并写进 24h 搜索缓存(置空 pending);
  前端 `Download.js` 每 25s 自动补拉一次(最多 6 次, 期间显示"还有 N 个源在后台补齐"提示)。
  实测: 第一次 2.0s/22 首(pending=[kugou,kuwo,migu,qianqian]) → 后台 1m55s 写入 52 首 →
  第二次 0.1s/**52 首、六个源齐全** (qianqian 5+kuwo 20+netease 20+qq 2+kugou 2+migu 3)。
- 想让它们**第一次搜索就在**, 只有两条路: 调大 `MUSIC_DL_SEARCH_SOURCE_BUDGET`(等于重新变慢),
  或给它们做**原生搜索**(每个 1~2 小时, 参照 `qq_source.py` / `netease_source.py`: 只打必要请求,
  不逐档重试、不逐首探活)。酷狗原生可行性已验证可行(搜索 `songsearch.kugou.com` 0.5s、
  取址 `trackercdn` + `md5(hash+"kgcloud")` 0.1s, 但没会员 cookie 时仍只有免费曲)。
- **别再加"可播率低就退回快照"这类兜底**(踩过): 无会员 cookie 时网易付费曲本来就没有地址,
  早先按"可播率 <0.5 回退"的写法把「林俊杰 江南」(可播率 0.40)从 1s 变成 **132.0s**, 直接超预算
  被丢。拿不到地址的歌已标 `is_invalid`, 前端验活会隐藏它们 —— 直接返回原生结果又快又一致。
  网易原生实现的开关是 `MELODEX_NETEASE_NATIVE_SEARCH=0`(真出问题时才用)。

### 歌词能力现状(2026-09)
- **逐字歌词**: 前端 `parseLRC` 认"一行里 >= 2 个 `[mm:ss(.sss)]` 段"为逐字行。provider 侧三路互补:
  - 网易 YRC(`netease_lyric.py`, 明文但覆盖稀, 周杰伦多首原唱都没有 yrc 字段);
  - 酷狗 KRC(`kugou_lyric.py`, 解码 = base64 → 去 4 字节头 → 16 字节固定密钥 XOR → zlib;
    **词时间是相对行首的毫秒**, 与 YRC 的绝对毫秒不同, 必须先加行首);
  - QQ QRC(`qq_qrc.py`, 2026-09 打通)。**更正一条错误结论**: QRC 不是"新加密解不开", 当年失败
    有两个真实原因 —— ①请求参数不齐: 只传 `songMID` 时响应里根本没有 QRC, 必须带
    `songName/albumName/singerName`(base64)+ `interval` + `qrc:1/crypt:1/ct:19` 一整套
    (`qq_qrc.qrc_request_param`); ②`lyric` 字段是**十六进制**, 不是 base64。解密是
    hex → QQ 自家 DES 变体(**不是标准 3DES**, 标准库同密钥解不出 zlib 流) → zlib → 明文 XML
    (`<QrcInfos>…<Lyric_1 …LyricContent="[ti:…][行起,行时长]文字(词起,词时长)…"/>`)。
    实测匿名即可取到(晴天 36/36 行、稻香 79/79 行全为逐字行), 前端真解析器复核 3 首 172 行
    100% 判为逐字行; 取不到时自动回退 base64 行级歌词。开关 `MELODEX_QQ_VERBATIM_LYRIC`。
    该文件的 DES 移植自 LDDC(GPL-3.0-only), 本文件按上游继续以 GPL-3.0-only 分发, 见
    `backend/PROVENANCE.md`。
  三路都由 `app.py` 的 `_enrich_verbatim_lyrics`(网易/酷狗, 按源同源匹配)与 `qq_source`
  自身的歌词链路写入 `extra.lyric`, 逐字时附 `lyric_verbatim=1`。
- **歌词片段搜索**(`type=lyric`): 真正做歌词检索的是 QQ(`qq_source.py`, `search_type=7`)与
  网易(`netease_source.py`, 原生 `/api/search/get/web type=1006`, **匿名即可命中**; 带管理员 cookie 时付费曲
  能取到无损地址 —— 实测 孤勇者/陈奕迅 52391KB/1676k flac); kuwo/migu 仍是"按标题/歌手兜底"
  (`core.GetLyricSearchFunc`)。QQ 会员凭证失效时, 靠网易这一路兜住整条功能。
- **缓存版本坑**: `search_cache` 的 key 含版本号, payload 形状一变(如新增逐字歌词)必须 bump
  `searchRankingCacheVersion`, 否则旧行会在 TTL(24h)内继续返回旧内容, 看起来像"改动没生效"。

### 副歌点位(chorus, 2026-11)

前端在播放进度条上画一个可点标记,点击跳到副歌起点。数据写在 `extra.chorus_start_ms` /
`extra.chorus_end_ms`(字符串毫秒,**两个都必须是真值**,缺一边前端就不画)。

- **数据只有两路,QQ 没有**:
  - **酷我**:搜索响应的 `payInfo.refrain_start/refrain_end` **自带**,零额外请求。`kuwo_source._chorus_range`
    会校验「起点>0 且 终点>起点 且 终点 <= 曲长+容差(复用 `DURATION_TOLERANCE_*`)」,
    **曲长缺失时不写**(无法校验越界,标错比不标更糟)。
  - **网易**:搜索响应**没有**这字段,要额外打一次官方批量接口
    `GET https://music.163.com/api/song/chorus?ids=[186016,185809]`(实测一次覆盖整页 9~10/10)。
    实现在 `netease_chorus.py`,由 `app.py:_enrich_netease_chorus` 接在**原生搜索分支**返回前,
    整段 try/except 尽力而为。开关 `MELODEX_NETEASE_CHORUS`(默认开)。
  - **QQ:没有任何可用接口** —— 试过 `PreviewInfoRead.GetPreviewInfo` / `ChorusInfo.GetChorusInfo`
    等多个模块全部返回 `code 500003`(模块不存在),别再白费功夫。
- **千万别用 `refrain_start` 判付费**:它每首歌都有非零值(免费曲也有),误用会把所有歌判成付费。
  这是 `_is_paid_item` 里刻意写下的反例,新代码不要"顺手复用"。
- **交叉验证过的真值**:酷我与网易对《晴天》给出的副歌点分别是 84346ms 与 84498ms,
  换算到进度条是 31.36% vs 31.41%(偏差 0.05%)——两路独立数据高度吻合,说明是真实数据而非估算。
  这条交叉校验固化在 `frontend/scripts/playerChorusE2E.mjs`。
- **`qualityExtraHash` 的连带坑(踩过,已修)**:`internal/web/quality_cache.go` 原先把这个歌
  `extra` 的**所有**键都算进 `quality_cache` 主键。于是往 extra 里加任何**展示型**字段(如副歌点位)
  都会把整库音质缓存一次性冲掉,下次打开歌单要对每首歌重新打上游探测 —— 纯浪费的真回归。
  现已改成白名单 `qualityExtraKeyAllowlist`(只让真正影响取址的字段参与),并由
  `TestQualityExtraHashIgnoresPresentationOnlyFields` 锁死。**以后往 extra 加展示字段前,
  先 grep 一遍有没有别处把整份 extra 当哈希/主键用。**
- 前端解析在 `src/contexts/playerChorus.mjs`(宽容解析:extra 可为对象或 JSON 串、毫秒可为数字或字符串;
  非法值一律安静降级成"没有副歌",绝不抛异常影响播放)。标记组件 `ChorusMarker` 用
  `<button>` 保证键盘/读屏可达,移动迷你条那条 2px 细进度条只画不可点的视觉指示。

## 平台凭证有效期与「自动续期」的 UI 契约(2026-11)

用户反馈:设置页 QQ 卡片显示「⚠ 剩 23 小时 34 分」,以为马上要掉线、准备重新扫码。**实际上它会自己续上。**

### 机制(读源码得出)
- QQ **musickey 只有 72h**(`keyExpiresIn=259200`),但同一份 cookie 里的授权 token
  (`p_skey/skey/superkey/supertoken/pt_oauth_token`,即 `qq_login.TOKEN_KEYS`)寿命长得多。
- `provider_bridge/qq_source.py` 的 `refresh_musickey` 用它们重走扫码登录第 5 步
  (`QQConnectLogin.LoginServer/QQLogin`)换出**全新 musickey**,经 `refreshed_cookie_sink`
  → `app.py` 的 `refreshed_cookie` → Go `core.persistRefreshedCookie` 落库(settings.db)。
- **触发时机只有一处**:`qq_source.search()` 里 `state["has_key"] and state["expired"]`,
  即**下次搜索/取址/播放**时才续。倒计时走到 0 之后不会自动重登,但也**不需要**用户重登。
- 因此 `state == "expiring_soon"`(剩 <24h)**不代表要掉线**,只代表"还没到续期那一刻"。

### 判断「能不能续」的唯一口径:`detail.auto_refreshable`
`core.BuildCookieStatusDetail` 输出该字段,三条件缺一不可,与 sidecar 的真实行为逐项对应:
`has_uin`(拿不到 uin 直接返回 `{}`)+ `has_music_key`(只有 key 过期才触发)+
`has_long_lived_token`(候选 token 全空同样换不出新 key)。非 QQ 源恒为 false。

> **踩过的 bug**:Go 侧原先只有 `has_refresh_key`/`has_refresh_token` 两项,而
> `refresh_musickey` 真正用的是 `TOKEN_KEYS`(refresh_token 只是其中一个可选来源)。
> 于是「扫码登录、p_skey 齐全、但没有 refresh_token」的 cookie 被判成不可续期,
> 把用户赶去白扫一次码 —— 而它自己就能续。Python 侧 `credential_state.refreshable`
> 同步修正为同一份清单。**两边判据必须一致:判断能续的,就必须真能续。**

### UI 规则
- 纯逻辑在 `frontend/src/utils/credentialExpiry.js`(`expiryBadge`/`expiryHint`/
  `classifyCredentialNotices`/`credentialNoticeText`),由
  `frontend/scripts/credentialExpiry.test.mjs`(`npm run test:credential`)锁定。
- **能续期时绝不催用户重新登录**:徽章用中性/蓝色 +「自动续期」字样,
  `expired` 且能续期显示「已过期 · 待续期」(黄色,不是红色 —— 红色会让人立刻跑去重扫)。
- **不能续期时如实警告**,并说明"缺长期授权凭证、无法自动续期"。
- `CredentialNotice` 全局提示条按**用户要不要动手**分三桶(**不是**按"能不能续"分,这里极易写反):
  - `expired` + 不能续 → 红色,"必须自己重登";
  - `expired` + **能续** → 蓝色,**仍然提示**:"下次搜索会自动续期,若续期失败再重扫"。
    不能因为"能续"就不提示 —— 续期可能被上游风控拒绝,而失败表现正是"音质悄悄变差",
    那恰是本组件当初要解决的问题;
  - `expiring_soon` + 能续 → **完全不提示**(正常现象,下次搜索就续上);
  - `expiring_soon` + 不能续 → 黄色,"无法自动续期,建议提前重登"。
- 前端**不得自己推断**能否续期:它看不见 cookie 内容,一律读后端 `auto_refreshable`
  (旧后端无此字段 → 按 false 处理,宁可多提醒一次)。

## 能力边界(已做到极限,别白费功夫)

- **刮削**:下载文件嵌入 标题/歌手/专辑/专辑艺人/日期/完整LRC歌词/封面(webp 自动转 JPEG)。track/genre/year **数据源没有**(model.Song + Extra 只有 song_id),硬加是空帧,别做。再要更全需接 MusicBrainz(另一量级)。
- **发现页**:国内源只有"歌单"维度(推荐歌单/分类/歌手搜索),**没有艺人榜/单曲榜**接口。
- **音质**:搜索返回的 bitrate/size 是**预览值常不准**(多为 128);真实值靠自动验活 / "验"按钮调 `/music/inspect`(对真实下载源发 Range 探测,算 size/bitrate)。部分歌曲版权受限(如 kugou privilege=10/8)inspect 返回 valid:false,自动验活会**隐藏死链**。
- **无损/高音质依赖登录会员 cookie**:Provider sidecar 会把管理员保存的平台 Cookie 传给对应 Charles 客户端。网易云与 QQ 都有**扫码登录**(QQ 见 `provider_bridge/qq_login.py`),其余平台使用 Settings 的**手动填 Cookie**入口;无损能否取得最终取决于上游能力、Cookie 有效性与账号会员等级。
- **同名歌曲排序**:见上方「搜索排序」节(综合分:相关性+上游名次+正版信号−翻唱降权,无正版信号的完全匹配封顶600,同分按真实音质降序)。无"原唱"数据,译名翻唱仍可能压过原名原唱,带歌手/用原名搜最准。
- **浏览器播放**:Web 前端 `<audio>` 原生解码 FLAC/WAV(现代浏览器支持,playwright 真机验证 FLAC 正常播);MediaSession 已接(锁屏/通知栏/蓝牙控制)。iOS Safari 后台播放限制比 Android 弱,未充分真机验。

