# AGENTS.md — Melodex 项目纪律与概况

> 给接手本项目的 AI / 开发者。动手前务必读完本文件。

## 这是什么

Melodex 是两个开源项目合并的成果:
- **[peter-bf/tunescout](https://github.com/peter-bf/tunescout)** —— React 发现页 UI(原英法双语,原接 Last.fm/Spotify)
- **[guohuiyuan/go-music-dl](https://github.com/guohuiyuan/go-music-dl)** —— Go 全网音乐搜索下载引擎(国内多源 + ffmpeg),**AGPL-3.0**

合并决策:**React 作统一前端,go-music-dl 退为 JSON 后端**。整体继承 **AGPL-3.0**。用户纯开源自用、不商业化。界面**全中文**(对接国内平台,无 i18n / 无语言切换),**Fluent Design**(亮色 + Fluent 蓝 #0078D4)。

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
└── frontend/   React 18 + Vite + Tailwind(Fluent 设计系统)。无 react-router,**哈希路由**(#download/#settings,刷新不丢)
    └── src/
        ├── App.js            currentSection 驱动页面切换 + URL hash 同步(sectionFromHash/hashchange)
        │                     QueryClient 全局关 refetchOnWindowFocus(否则切窗口回来重搜)
        ├── components/        Navbar/Hero/Trending/Artists/Discover/Download/Settings/SongRow/PlaylistSongs/FAQ/Footer
        │                     (Videogen 已删)
        ├── contexts/PlayerContext.js  全局常驻播放器(切页不停;播放失败自动跳下一首)
        ├── hooks/useLiveCheck.js       搜索结果并发验活(限并发6,返回真实 size/bitrate/bitrateNum)
        ├── services/musicdl.js         后端 API 封装(API_BASE 默认空=同源);saveToServer/setCookie/inspectQuality
        └── (lib/videogenEngine.js 已随 videogen 剥离删除)
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
- **改了样式没生效优先怀疑**:① 浏览器/PWA service worker 缓存(强制重载 stylesheet / Ctrl+F5)② HTML 行内 style 优先级高于 CSS。

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
- **同名歌曲排序**:搜索结果按 `relevanceScore` 排(歌名=词1000/开头600/含400/多词累加/歌手+80/噪声0沉底);**同名同分时按真实音质降序**(无损正版顶到翻唱前,需验活完成有 bitrateNum)。无"原唱"数据,要精确置顶正版靠"带歌手搜索"。
