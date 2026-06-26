# TuneScout+

> 音乐**发现**与**下载**二合一:在精致的 React 界面里发现好音乐,一键从国内多源解析下载。

TuneScout+ 把两个开源项目合并为一个统一工具:

- **发现** —— 沿用 [TuneScout](https://github.com/peter-bf/tunescout) 的 Last.fm / Spotify 榜单与艺人洞察界面。
- **下载** —— 集成 [go-music-dl](https://github.com/guohuiyuan/go-music-dl) 的全网多源搜索与无损下载能力(网易云、QQ、酷狗、酷我、咪咕、汽水、Bilibili、Apple Music 等 10+ 平台)。

架构上,React 作为统一前端,go-music-dl 退为提供 JSON API 的后端下载服务。

## 功能

- **歌曲搜索**:国内多源(网易云/QQ/酷狗/酷我/咪咕/汽水/B站/Apple 等)并发搜索,支持粘贴歌曲/歌单/专辑链接解析
- **在线播放 / 下载**:流式试听,一键下载(可写入 ID3 元数据与封面)
- **推荐歌单**:浏览各平台每日推荐歌单,进入歌单查看并下载
- **歌词**:查看逐行 LRC 歌词
- **账号登录**:扫码登录网易云/QQ/酷狗/B站以解锁会员或无损音质
- **本地音乐库**:管理已下载到本地的音乐
- **发现页联动**:在 Last.fm/Spotify 发现页点「在国内源下载这首歌」,自动跳到下载页并搜索
- **视频生成**:把一首歌做成带封面与歌词的 1080P MP4(浏览器逐帧 canvas 渲染,后端 ffmpeg 合成)。需要系统安装 **ffmpeg**(或用环境变量 `MUSIC_DL_FFMPEG` 指定其路径)。
- **Subsonic 客户端直连**:后端自带一套轻量 Subsonic API(`/rest`),用[音流 / substreamer](https://www.subsonic.org/) 等标准 Subsonic 客户端连本服务,即可**搜全网在线听 + 浏览已入库曲库 + 听过自动入库**。默认关闭,见下方「Subsonic API」。

## Subsonic API(让音流等客户端直连)

TuneScout+ 后端实现了一套轻量 Subsonic 服务端,音流/substreamer 等标准 Subsonic 客户端连一个地址即可:

- **搜索**(`search3`)直接接全网多源搜索,结果**验活后**返回(只给能播的)
- **播放**(`stream`)在线实时解析;同一首**播放过即在后台完整下载+刮削落盘入库**,下次播放走本地
- **曲库浏览**(专辑/艺人)= 已入库(听过)的歌

**默认关闭**,配齐以下环境变量才启用(在 `docker-compose.yml` 或运行环境设置):

```bash
MUSIC_DL_SUBSONIC_ENABLED=1
MUSIC_DL_SUBSONIC_USER=你的用户名
MUSIC_DL_SUBSONIC_PASS=强密码
```

客户端服务器地址填 `http(s)://<主机>:8329`(无需 `/rest` 后缀,客户端自动补),用户名/密码填上面两项。对外暴露时,反代层需为 `/rest` 放行 SSO(Subsonic 客户端走自身 user/pass 认证,不经登录页)。

## 项目结构

```
TuneScout+/
├── backend/    Go 后端(基于 go-music-dl,Gin + music-lib)
│   └── internal/web/json_api.go   新增的 /api/v1/* JSON 接口
└── frontend/   React 前端(基于 TuneScout,Vite + react-query + tailwind)
    └── src/components/Download.js、Settings.js   新增的下载/设置页
```

## 部署(Docker,推荐)

一体化镜像:React 前端 + Go 后端 + ffmpeg 打包进单个容器,前后端同源,开箱即用。

```bash
docker compose up -d --build      # 构建并启动
docker compose up -d --build      # 构建并启动
# 访问 http://<主机>:8329
```

镜像三阶段构建(Node 构建前端 → Go 编译并 `go:embed` 嵌入前端产物 → Alpine + ffmpeg 运行)。
数据(下载的音乐、cookie、生成的视频、settings.db)持久化在 `./data`。videogen 所需的 ffmpeg 已在镜像内,无需额外安装。

> 对外暴露前请阅读下方「安全说明」:搜索/下载等匿名可用,扫码登录等敏感操作需先在 `/music/setup` 初始化管理员。

## 开发运行

**后端**(示例用 :8329):

```bash
cd backend
go run ./cmd/music-dl web --port 8329
```

**前端**(默认 :3000):

```bash
cd frontend
cp .env.example .env          # 按需填写 Last.fm/Spotify 密钥(发现页用);VITE_MUSICDL_API 指向后端
npm install
npm run dev                   # 开发服务器;打包用 npm run build(产物在 build/)
```

发现页(Trending/Discover/Artists)依赖 Last.fm 与 Spotify 凭据,需在 `.env` 中配置 `VITE_LASTFM_API_KEY`、`VITE_SPOTIFY_CLIENT_ID`、`VITE_SPOTIFY_CLIENT_SECRET`;不配置不影响下载页(国内源)使用。

## 接口约定

前端通过两类后端接口工作:

- `GET /api/v1/*` —— 新增的 JSON 接口(搜索/歌单/专辑/歌词/推荐/登录/cookie),供 React 调用
- `GET|POST /music/*` —— go-music-dl 原有接口,其中 `/music/download`(下载/流式播放)与 `/music/local_music`(本地库)被前端直接复用

## 致谢与来源

本项目是以下两个开源项目的衍生作品,核心功能与代码来自它们,版权归原作者所有:

- [peter-bf/tunescout](https://github.com/peter-bf/tunescout) —— 发现页 UI
- [guohuiyuan/go-music-dl](https://github.com/guohuiyuan/go-music-dl)（作者 guohuiyuan）—— 多源搜索与下载引擎

## 安全说明

部署前请了解以下安全边界:

- **对外暴露需先设管理员**:后端默认监听全部网卡(`0.0.0.0`)。搜索/播放/下载等只读功能匿名可用;而扫码登录、Cookie 管理等敏感操作(`/api/v1/qr_login`、`/api/v1/cookies`)要求管理员鉴权——首次访问后端 `/music/setup` 用启动终端打印的令牌初始化管理员账号后方可使用。
- **仅本机使用更安全**:若只在本机使用,用 `--desktop` 模式启动会绑定 `127.0.0.1`。
- **SSRF 防护**:封面代理 `/music/cover_proxy` 已拒绝指向内网/环回/云元数据(`169.254.169.254`)的目标,并覆盖十进制/十六进制/IPv6 等绕过写法。注:校验在请求前做 DNS 解析,理论上仍存在 DNS rebinding(TOCTOU)的残余风险;若部署在敏感内网,建议在网络层(防火墙/出网策略)额外限制后端的出站访问。
- **登录防爆破**:管理员登录失败有次数锁定;密码以 bcrypt 存储。
- **上传限制**:本地音乐上传仅接受音频扩展名白名单,文件名经清洗防路径穿越。
- **前端依赖**:构建工具为 Vite,运行时依赖(axios、react 等)均已升级到无已知高危漏洞的版本,生产 build 产物无 critical/high 漏洞。`npm audit` 仍会报少量来自构建/开发期工具链(vite dev server、tailwind/postcss 的 glob 等)的告警,这些**不进生产产物**,且多为 dev-only(仅 `npm run dev` 期间)。
- **ffmpeg**:视频生成等功能依赖系统 ffmpeg;exec 调用均使用参数数组,无 shell 注入。

发现安全问题请提 issue 或私下联系维护者。

## 许可证

本项目整体采用 **AGPL-3.0**（继承自 go-music-dl）。详见 [LICENSE](./LICENSE)。
对外提供网络服务时,须依 AGPL-3.0 要求公开完整源码。

## 免责声明

本项目仅供学习与技术交流使用（沿袭 go-music-dl 的声明）。各音乐平台的解析与下载请遵守对应平台的服务条款及当地法律,因使用本项目产生的任何后果由使用者自负。
