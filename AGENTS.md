# AGENTS.md — Melodex 项目纪律与概况

> 给接手本项目的 AI / 开发者。动手前务必读完本文件。

## 这是什么

Melodex 是两个开源项目合并的成果:
- **[peter-bf/tunescout](https://github.com/peter-bf/tunescout)** —— React 发现页 UI(原英法双语,原接 Last.fm/Spotify)
- **[guohuiyuan/go-music-dl](https://github.com/guohuiyuan/go-music-dl)** —— Go 全网音乐搜索下载引擎(国内多源 + ffmpeg),**AGPL-3.0**

合并决策:**React 作统一前端,go-music-dl 退为 JSON 后端**。整体继承 **AGPL-3.0**。用户纯开源自用、不商业化。界面**全中文**(对接国内平台,无 i18n / 无语言切换)。**UI 已于 2026-06 从 Fluent 亮色改为暗色 Spotify 风**(皮肤改编自 Adam Lowenthal 的 CodePen "Spotify Artist Page UI",**MIT**,见 `frontend/THIRD-PARTY-LICENSES.md` 署名;主色 Spotify 绿 #1ED760 / 底 #181818 / 卡片 #282828 / Roboto;图标用 lucide-react)。**主力用法已转 PWA Web 前端**(音流等 Subsonic 客户端对 search3 结果客户端重排,排序不可控,见下;Web 前端排序自控)。

## 架构(读源码得出,非臆测)

```
Melodex/
├── backend/    Go(Gin)。go-music-dl 改造而来,平台解析在外部依赖 music-lib
│   └── internal/web/
│       ├── json_api.go      新增的 /api/v1/* JSON 接口(React 用);含 cookie 管理(GET/POST/DELETE /cookies)
│       ├── frontend_embed.go  go:embed 托管 React 产物(SPA + /api、/music 各自路由)
│       ├── music.go/collection.go/local_music.go  原 /music/* 路由(下载/inspect/歌词/本地库)
│       │      videogen.go 仍在但**未注册**(功能已剥离,见下)
│       └── frontend_dist/    占位 index.html;Docker 构建时被 React 产物覆盖
└── frontend/   React 18 + Vite + Tailwind(暗色 Spotify 主题,CSS 变量在 index.css)。无 react-router,**哈希路由**(#download/#myplaylist 等,刷新不丢)
    └── src/
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
- **后端路由前缀 `RoutePrefix = "/music"`**(go-music-dl 原架构,几十处引用同一常量)。`/music` 的**老 HTMX 网页已下线**(renderIndex 返 410),只保留 JSON/下载/登录接口。用户曾想抽掉 /music,结论:**不抽**(深层架构,改动大且无实际收益)。
- **前端 API_BASE 默认空字符串**(同源相对路径);开发期用 `frontend/.env.development.local` 指向本地后端。
- **鉴权 cookie Path 必须是 `/`**(不是 /music),否则登录态覆盖不到 /api,表现为"登录没生效"。
- **登录/setup 页**(`/music/login`)保留,React Settings 引导用户来此做管理员鉴权。登录成功跳回 `/`(不是已下线的 /music)。
- **videogen 已剥离**(2026-06):前端组件/引擎/导航删除,后端 `RegisterVideogenRoutes` 不再注册。原因——移植成 ES module 后严格模式暴露隐式全局变量(coverRadius 等),且封面容错依赖墙外 placeholder + webp,国内环境天生不稳;用户不用。`videogen.go` 文件留着但不挂载,要彻底删可连文件一起清。
- **下载到 NAS(自托管)**:点「下载」走 `saveToServer` → `POST /music/download?save_local=1&embed=1` + `X-Requested-With` 头(`write_guard.go` 要求 POST+同源+XHR 防 CSRF),存到容器 `data/downloads`(随 data 卷持久化),带完整刮削,本地音乐库可扫到。**不是**浏览器下载(那不经服务器,本地库永远空)。
- **哈希路由**:URL hash 即当前页(#download/#settings),刷新/直达不丢;`handleLinkClick` 写 hash,`hashchange` 监听前进后退。
- **react-query 全局关 `refetchOnWindowFocus`/`refetchOnReconnect`**(App.js QueryClient defaultOptions):否则切窗口再聚焦会自动重新搜索 + 重新验活。

## 多用户隔离 + 两级 RBAC(2026-06 新增)

Melodex 从单管理员模型改造为**多用户 + 两级角色(admin/user)**。生产 tsp.9li.life 前面已有 Authentik SSO 守门,但后端拿不到 SSO 身份,故**自建多账号**(不依赖 SSO,可脱离 SSO 部署)。

### 数据模型(`backend/internal/web`,settings.db)
- **User 表**(`users.go`):username 唯一(大小写不敏感)/bcrypt 密码哈希/role(admin|user)/disabled。完整 CRUD + **最后管理员保护**(不能删/降级/禁用最后一个 admin)。
- **Collection.UserID**:歌单按 user_id 归属;SavedSong 经 Collection 归属。所有歌单查询经 `loadOwnedCollection(id, userID)`,跨用户访问按 404 处理(不泄露存在性)。
- **DownloadRecord 表**(`download_record.go`):下载**共享同一目录**(DownloadDir 全局),按 user_id 记录"谁下了哪个文件(relPath)"。本地库据此按用户过滤:普通用户只见自己下过的,管理员见全部。同首歌多人下只占一份盘。
- **userPrefRow 表**(`user_prefs.go`):仅 `disableFloatingLyrics`/`webPageSize` 两个**展示类偏好**按用户隔离;下载目录/并发/文件名模板/embed/更新/代理为**系统级全局**(仅管理员可改)——避免每人不同文件名模板破坏共享目录去重。

### 鉴权(`auth.go` / `auth_api.go`)
- session payload 含 UserID,全局 HMAC 签名密钥惰性生成存 `WebAuthSettings.SessionSecret`。`authRequired` 注入 userID/role/username 入 gin.Context(**绝不信任前端传的 user_id**),`adminRequired` 非管理员 403。
- **路由分级**:`bindAuthMiddleware` 返回 `adminAPI`(登录+管理员:cookie/系统设置/QR登录/用户管理)与 `userAPI`(仅登录:歌单/收藏/本地库)。公开读路由(搜索/播放/歌词)挂 `attachUserOptional` 让下载能记归属。
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

## 开发运行

```bash
# 后端(Go):
cd backend && go run ./cmd/music-dl web --port 8329 --no-browser
#   下载文件刮削嵌封面用到 ffmpeg:用环境变量 MUSIC_DL_FFMPEG 指定 ffmpeg 路径
#   (videogen 已剥离;ffmpeg 现仅用于刮削/转码场景)

# 前端:
cd frontend && npm install && npm run dev   # 读 .env.development.local 指向后端
```

- 本机 go run 后台跑有时进程被清理,验证时建议 `go build -o /tmp/xxx ./cmd/music-dl` 跑二进制更稳。
- 本机 curl 后端要加 `--noproxy "*"`(有 7890 代理干扰),vite dev 用 `localhost`(绑 IPv6,curl 127.0.0.1 连不上)。

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

### 部署鉴权(生产 tsp.9li.life)
- `/rest` 路径要在 NPM **放行 Authentik SSO**(`auth_request off`,与 PWA 静态资源同理),仅靠 Subsonic 自身 user/pass 认证——Subsonic 客户端不会过 SSO 登录页。
- env 在 `docker-compose.yml` 配(已留注释模板,默认注释掉)。

### 验证(已真机端到端,2026-06)
- `go build ./...` + `go test ./internal/web/ ./core/` 零回归;facade 单测覆盖 认证token计算(对齐协议文档示例)/id编解码往返+特殊字符/各端点格式/曲库聚合。
- 真机:本机起二进制 + curl 模拟 Subsonic 请求(`--noproxy '*'`,token=`printf '%s%s' pass salt | md5sum`)→ ping/getLicense/search3(真搜「周杰伦 晴天」验活返真实bitrate)/stream(ffprobe 验真MP3)/后台落盘(刮削+嵌PNG封面)/getAlbumList2(入库后可浏览)/本地id回放(发本地文件)/getCoverArt(本地嵌入图)全通;facade 默认关(无 env 返 code 0 未启用)已验。

## 自建歌单 + m3u 导入(2026-06 新增)

- **后端早有完整歌单 CRUD**(`collection.go`,SQLite 存 `data/settings.db` 的 collections/saved_songs 表,**非单独 favorites.db**——所有数据都在 settings.db 一个文件,迁移/备份保住它即可)。路由 `/music/collections`:GET 列 / POST 建 / PUT 改 / DELETE 删 / GET·POST·DELETE `/:id/songs` 看·加·移歌。前端 `services/collections.js` 封装。
- **前端自建歌单**:Sidebar「我的歌单」组列出 + 「+」弹出菜单(新建空歌单 / 导入 m3u);SongRow 的「+」(ListPlus)弹 AddToPlaylistModal 选歌单加入;MyPlaylist 是歌单详情页(播放全部/移歌/删歌单)。playlistBus 区分推荐歌单(id+source→Trending)vs 自建歌单(collectionId→MyPlaylist);`requestOpenPlaylist` 派发延 60ms 否则切页后目标组件未挂载收不到事件。
- **m3u/m3u8 导入**(`m3u_import.go`,`POST /music/collections/import_m3u`):解析 `#EXTINF` + 媒体行 → 每条按歌名 `concurrentKeywordSearch` + `sortSongsByRelevance` 取第1名入库 → 返回 {total,matched,skipped}。**关键:优先用媒体行文件名做搜索词**(含分隔符时),因真实 m3u 常 EXTINF 只有歌名、文件名才含"歌手-歌名",用文件名匹配率高(实战 407 首 100% 匹配)。识别 `#EXT-X-` HLS 视频流→拒绝。`.m3u`/`.m3u8` 同一套解析。**坑:前端 importM3U 超时必须放宽到 10min**(默认 30s,百首导入需数分钟会超时失败)。

## 搜索排序(2026-06 重写,Web 与 Subsonic 共用)

`json_api.go` 的 `/api/v1/search` 和 facade 的 search3 都用 `sortSongsByRelevance`:综合分 = 本地相关性 `relevanceScore`(歌名完全=1000/开头600/含400/多词累加/歌手+80) + 上游名次分 `upstreamRankScore`(各源返回序,译名匹配不到时兜底) + 正版信号 `officialBonus`(无损+600/付费+200) − 翻唱降权 `coverPenalty`(歌名含 Cover/翻唱/钢琴版/伴奏/纯音乐等强特征罚1200/Live等弱罚300);**无正版信号的完全匹配封顶到 600**(防译名翻唱白嫖歌名霸榜),同分按真实码率降序。前端 Download.js 信任后端返回序(relevance 字段取 -origIdx 不本地重算)。
- **正版信号来自本地化的 music-lib**:`backend/third_party/music-lib`(replace 引入,git clone 删 .git 并入主仓,Dockerfile 在 `go mod download` 前先 `COPY third_party`),改各源 Search 把 `has_lossless`(QQ SizeFlac>0 / netease Privilege.Fl≥999000)`is_paid`(QQ pay.PayTrackPrice>0)写进 `Extra`。music-lib 是 AGPL,改了保留版权声明。
- **边界**:无"原唱"元数据,纯算法靠"有无损≈正版原唱"近似,译名翻唱(歌名精确匹配译名又无标记,如 Cherisy)仍可能压过原名原唱(日文名匹配不上中文 query)。要精确区分需 MusicBrainz(不做)。带艺人/用原名搜最准。

## 功能现状(截至 2026-06,搜索/下载主线闭环)

用户用法:**自托管,搜索 → 验活 → 排序 → 下载到 NAS(刮削)→ 本地音乐库/可挂 Plex/Navidrome**。核心都在 `Download.js` + `SongRow.js` + `useLiveCheck.js` + `Settings.js`。

- **搜索**:多源合并。结果先**自动验活**(useLiveCheck 并发6调 inspect),死链/版权受限**隐藏**,显示"验活中 x/总数"+"共N首可用",渐进出结果(验完一首出一首)。代价:全验完约 20~25s(限并发必然),渐进显示缓解。
- **排序**:多级排序(相关/音质/大小可叠加,①②③优先级+↑↓+清除)。默认 relevance 降序。relevance=相关性评分(见能力边界);音质用验活真实 bitrateNum;同名同分隐式按音质降序。
- **歌曲行**(SongRow):显示 音质标签(验活真实值,无损/高品/Nk)+ 源 + 时长 + 真实大小;按钮 验/词/播放/下载。"验"=手动 inspect;自动验活的结果经 `liveInfo` prop 直接显示(effectiveReal=手动验优先,否则用 liveInfo)。
- **下载**:点「下载」= 下到 NAS(saveToServer,见关键设计点),状态 下载中/✓已下载/✗重试。
- **登录**(Settings):每源卡片 扫码登录(QRLoginCard;二维码 image_url 直接 `<img>`,url 文本则 QRCodeCanvas 画)+ 退出 + **手动填 Cookie**(带各源网址+F12教程+关键字段,COOKIE_HELP 映射)。登录态让验活/下载走 VIP 链路拿高音质。
- **播放**:全局常驻 PlayerContext,切页不停;播放失败自动跳下一首。
- **歌词**:SongRow"词"按钮拉 LRC。

## 测试与验证纪律(重要)

- 后端改动:`go build ./...` + `go test ./internal/web/ ./core/`,**零回归**才提交(go-music-dl 自带大量测试)。
- 前端**无自动化测试**(原 TuneScout 就没有)→ 靠 **playwright 真机验证**:搜索真返结果、播放查 `audio.currentTime` 真在走、getComputedStyle 验配色、派发 `melodex:go-download` 事件测联动。
- **真实数据验证**:用真实关键词(周杰伦晴天等),不自造样本。ffprobe 验下载文件的元数据/封面。
- **playwright 会话偶发卡死**("Browser is already in use",清 SingletonLock 也无效)→ 别死磕,改用真实搜索数据直接跑纯逻辑函数(如 relevanceScore 排序)验证,同样可靠。
- **音质相关验证需登录**:未登录后端验活/inspect 多返 128k,看不出无损/音质排序效果;无登录环境用合成数据验证排序逻辑,真实效果在生产(已登录会员)才显现。
- **改了样式没生效优先怀疑**:① 浏览器/PWA service worker 缓存(强制重载 / Ctrl+F5 / 注销 SW + 清 caches)② HTML 行内 style 优先级高于 CSS。**但别一律归咎缓存**:曾因 `bg-popover` 没在 tailwind.config 映射(只映了 card 漏了 popover)渲染成透明 `rgba(0,0,0,0)`,被误判成缓存让用户白刷几十遍——**"看起来不对"先用 getComputedStyle 查真实渲染值**(背景/位置/层级),确认是真渲染问题再排查,别空推缓存。用 tailwind 颜色类前确认该色在 config 里有映射。
- **音流(musiver Android)客户端坑**:① 对 search3 结果**客户端重排 + 同名折叠**(无视服务端顺序,服务端把原唱排第1它仍可能显第14)——服务端排序对它无效,这是它闭源的固有行为(GitHub gitbobobo/StreamMusic 只有文档站无源码,相关 issue 全 P3);② **「边听边存」开关有 bug**,开了任何歌播不了反复重拉(开发者 issue#1022 确认),需关掉。结论:音流排序/播放问题多在客户端,**服务端响应每项都验证正确却仍异常时,早去查客户端 issue 别在服务端空转**;主力用法已转 PWA Web 前端(排序自控)。

## 部署(NAS,Unraid x86_64)

- 代码在 NAS `/mnt/cache/appdata/melodex-src`,Docker compose 运行,端口 **8329**。
- 访问 `https://tsp.9li.life`(NPM 反代 + **Authentik SSO** 守门)。PWA 静态资源(manifest/sw.js/图标)在 NPM 该站 Custom Nginx Config 用 `auth_request off;` 放行,其余走 SSO。
- **NAS 构建坑**:① 私仓 clone 用内网 `ssh://git@192.168.1.99:28022/...`(公网回环 NAT hairpin 超时)② docker.io 拉不到基础镜像 → 从 `docker.1ms.run` 拉 golang:1.25/alpine:3.22/node:22-alpine 再 `docker tag` 成原名,build 加 `--pull=false` ③ go mod 走 `--build-arg GOPROXY=https://goproxy.cn,direct` ④ 挂载的 `data` 目录要 `chown 1000:1000`(容器内 appuser uid)否则 SQLite 报 "out of memory"(实为权限)。
- 部署流程:NAS 上 `git pull origin master` → `docker build --pull=false --build-arg GOPROXY=https://goproxy.cn,direct -t melodex:latest .` → `docker compose up -d`。

## Git

- 双远程:fetch 走私仓,`git push` 一次双发 → 私仓 `git@git.9li.life:Aquila/Melodex.git` + GitHub `git@github.com:aki-riko/Melodex.git`。
- 仓库名 **Melodex**(2026-06 由 TuneScoutPlus 改名;品牌名 / 界面同为 "Melodex")。
- git 身份 local:Kotori <kotori@9li.life>。每次改动提交,push 前确保 build/test 过。

## 能力边界(已做到极限,别白费功夫)

- **刮削**:下载文件嵌入 标题/歌手/专辑/专辑艺人/日期/完整LRC歌词/封面(webp 自动转 JPEG)。track/genre/year **数据源没有**(model.Song + Extra 只有 song_id),硬加是空帧,别做。再要更全需接 MusicBrainz(另一量级)。
- **发现页**:国内源只有"歌单"维度(推荐歌单/分类/歌手搜索),**没有艺人榜/单曲榜**接口。
- **音质**:搜索返回的 bitrate/size 是**预览值常不准**(多为 128);真实值靠自动验活 / "验"按钮调 `/music/inspect`(对真实下载源发 Range 探测,算 size/bitrate)。部分歌曲版权受限(如 kugou privilege=10/8)inspect 返回 valid:false,自动验活会**隐藏死链**。
- **无损/高音质依赖登录会员 cookie**:music-lib 的下载逻辑(kugou/QQ 等)在有 cookie 时优先走 VIP 链路(`IsVipAccount`→`fetchVIPSongInfo`,选 sq_hash/FLAC)。但 **QQ 扫码登录拿不到 SQ**——实测扫码(ptlogin)拿到的 cookie 里 `qm_keyst`/`qqmusic_key` 为空(缺音乐授权 musickey),只能拿到 ogg 高码率拿不到 FLAC。解法:Settings 的**手动填 Cookie**入口,从平台网页版(y.qq.com 等)抠含 qm_keyst 的完整 cookie 粘贴。无损能不能真拿到最终取决于**账号会员等级**。
- **同名歌曲排序**:见上方「搜索排序」节(综合分:相关性+上游名次+正版信号−翻唱降权,无正版信号的完全匹配封顶600,同分按真实音质降序)。无"原唱"数据,译名翻唱仍可能压过原名原唱,带歌手/用原名搜最准。
- **浏览器播放**:Web 前端 `<audio>` 原生解码 FLAC/WAV(现代浏览器支持,playwright 真机验证 FLAC 正常播);MediaSession 已接(锁屏/通知栏/蓝牙控制)。iOS Safari 后台播放限制比 Android 弱,未充分真机验。
