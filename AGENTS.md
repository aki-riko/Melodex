# AGENTS.md — TuneScout+ 项目纪律与概况

> 给接手本项目的 AI / 开发者。动手前务必读完本文件。

## 这是什么

TuneScout+ 是两个开源项目合并的成果:
- **[peter-bf/tunescout](https://github.com/peter-bf/tunescout)** —— React 发现页 UI(原英法双语,原接 Last.fm/Spotify)
- **[guohuiyuan/go-music-dl](https://github.com/guohuiyuan/go-music-dl)** —— Go 全网音乐搜索下载引擎(国内多源 + ffmpeg),**AGPL-3.0**

合并决策:**React 作统一前端,go-music-dl 退为 JSON 后端**。整体继承 **AGPL-3.0**。用户纯开源自用、不商业化。界面**全中文**(对接国内平台,无 i18n / 无语言切换),**Fluent Design**(亮色 + Fluent 蓝 #0078D4)。

## 架构(读源码得出,非臆测)

```
TuneScout+/
├── backend/    Go(Gin)。go-music-dl 改造而来,平台解析在外部依赖 music-lib
│   └── internal/web/
│       ├── json_api.go      新增的 /api/v1/* JSON 接口(React 用)
│       ├── frontend_embed.go  go:embed 托管 React 产物(SPA + /api、/music 各自路由)
│       ├── music.go/collection.go/local_music.go/videogen.go  原 /music/* 路由
│       └── frontend_dist/    占位 index.html;Docker 构建时被 React 产物覆盖
└── frontend/   React 18 + Vite + Tailwind(Fluent 设计系统)。无 react-router(currentSection 状态切页)
    └── src/
        ├── App.js            currentSection 驱动页面切换
        ├── components/        Navbar/Hero/Trending/Artists/Discover/Download/Settings/Videogen/SongRow/PlaylistSongs/FAQ/Footer
        ├── contexts/PlayerContext.js  全局常驻播放器(切页不停)
        ├── hooks/useLiveCheck.js       搜索结果并发验活
        ├── services/musicdl.js         后端 API 封装(API_BASE 默认空=同源)
        └── lib/videogenEngine.js       视频生成引擎(从原 videogen.js 提取)
```

### 关键设计点 / 坑(务必知道)
- **后端路由前缀 `RoutePrefix = "/music"`**(go-music-dl 原架构,几十处引用同一常量)。`/music` 的**老 HTMX 网页已下线**(renderIndex 返 410),只保留 JSON/下载/登录接口。用户曾想抽掉 /music,结论:**不抽**(深层架构,改动大且无实际收益)。
- **前端 API_BASE 默认空字符串**(同源相对路径);开发期用 `frontend/.env.development.local` 指向本地后端。
- **鉴权 cookie Path 必须是 `/`**(不是 /music),否则登录态覆盖不到 /api,表现为"登录没生效"。
- **登录/setup 页**(`/music/login`)保留,React Settings 引导用户来此做管理员鉴权。登录成功跳回 `/`(不是已下线的 /music)。
- **videogen 架构**:原是独立 render.html 窗口(window.isRenderWorker),移植为 ES module 引擎 + React 外壳;依赖系统 ffmpeg。

## 开发运行

```bash
# 后端(本机直接 cargo... 不,Go):
cd backend && go run ./cmd/music-dl web --port 8329 --no-browser
#   videogen 需 ffmpeg:用环境变量 MUSIC_DL_FFMPEG 指定 ffmpeg.exe 路径

# 前端:
cd frontend && npm install && npm run dev   # 读 .env.development.local 指向后端
```

- 本机 go run 后台跑有时进程被清理,验证时建议 `go build -o /tmp/xxx ./cmd/music-dl` 跑二进制更稳。
- 本机 curl 后端要加 `--noproxy "*"`(有 7890 代理干扰),vite dev 用 `localhost`(绑 IPv6,curl 127.0.0.1 连不上)。

## 测试与验证纪律(重要)

- 后端改动:`go build ./...` + `go test ./internal/web/ ./core/`,**零回归**才提交(go-music-dl 自带大量测试)。
- 前端**无自动化测试**(原 TuneScout 就没有)→ 靠 **playwright 真机验证**:搜索真返结果、播放查 `audio.currentTime` 真在走、getComputedStyle 验配色、派发 `tunescout:go-download` 事件测联动。
- **真实数据验证**:用真实关键词(周杰伦晴天等),不自造样本。ffprobe 验下载文件的元数据/封面。
- **改了样式没生效优先怀疑**:① 浏览器/PWA service worker 缓存(强制重载 stylesheet / Ctrl+F5)② HTML 行内 style 优先级高于 CSS。

## 部署(NAS,Unraid x86_64)

- 代码在 NAS `/mnt/cache/appdata/tunescout-plus-src`,Docker compose 运行,端口 **8329**。
- 访问 `https://tsp.9li.life`(NPM 反代 + **Authentik SSO** 守门)。PWA 静态资源(manifest/sw.js/图标)在 NPM 该站 Custom Nginx Config 用 `auth_request off;` 放行,其余走 SSO。
- **NAS 构建坑**:① 私仓 clone 用内网 `ssh://git@192.168.1.99:28022/...`(公网回环 NAT hairpin 超时)② docker.io 拉不到基础镜像 → 从 `docker.1ms.run` 拉 golang:1.25/alpine:3.22/node:22-alpine 再 `docker tag` 成原名,build 加 `--pull=false` ③ go mod 走 `--build-arg GOPROXY=https://goproxy.cn,direct` ④ 挂载的 `data` 目录要 `chown 1000:1000`(容器内 appuser uid)否则 SQLite 报 "out of memory"(实为权限)。
- 部署流程:NAS 上 `git pull origin master` → `docker build --pull=false --build-arg GOPROXY=https://goproxy.cn,direct -t tunescout-plus:latest .` → `docker compose up -d`。

## Git

- 双远程:fetch 走私仓,`git push` 一次双发 → 私仓 `git@git.9li.life:Aquila/TuneScoutPlus.git` + GitHub `git@github.com:aki-riko/TuneScoutPlus.git`。
- 仓库名 **TuneScoutPlus**(`+` 在仓库名非法;品牌名 / 界面仍用 "TuneScout+")。
- git 身份 local:Kotori <kotori@9li.life>。每次改动提交,push 前确保 build/test 过。

## 能力边界(已做到极限,别白费功夫)

- **刮削**:下载文件嵌入 标题/歌手/专辑/专辑艺人/日期/完整LRC歌词/封面(webp 自动转 JPEG)。track/genre/year **数据源没有**(model.Song + Extra 只有 song_id),硬加是空帧,别做。再要更全需接 MusicBrainz(另一量级)。
- **发现页**:国内源只有"歌单"维度(推荐歌单/分类/歌手搜索),**没有艺人榜/单曲榜**接口。
- **音质**:搜索返回的 bitrate/size 是**预览值常不准**;真实值靠"验"按钮 / 自动验活调 `/music/inspect`(对真实下载源发 Range 探测)。部分歌曲版权受限(如 kugou privilege)inspect 返回 valid:false,自动验活会隐藏。
