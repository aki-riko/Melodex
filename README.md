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

> 视频生成(videogen)功能后端接口保留,但未在 React 前端重做;如需使用可直接访问后端的经典网页界面(`/music`)。

## 项目结构

```
TuneScout+/
├── backend/    Go 后端(基于 go-music-dl,Gin + music-lib)
│   └── internal/web/json_api.go   新增的 /api/v1/* JSON 接口
└── frontend/   React 前端(基于 TuneScout,CRA + react-query + tailwind)
    └── src/components/Download.js、Settings.js   新增的下载/设置页
```

## 开发运行

**后端**(默认 :8080):

```bash
cd backend
go run ./cmd/music-dl web --port 8080
```

**前端**(默认 :3000):

```bash
cd frontend
cp .env.example .env          # 按需填写 Last.fm/Spotify 密钥(发现页用);REACT_APP_MUSICDL_API 指向后端
npm install
npm start
```

发现页(Trending/Discover/Artists)依赖 Last.fm 与 Spotify 凭据,需在 `.env` 中配置 `REACT_APP_LASTFM_API_KEY`、`REACT_APP_SPOTIFY_CLIENT_ID`、`REACT_APP_SPOTIFY_CLIENT_SECRET`;不配置不影响下载页(国内源)使用。

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
- **前端构建依赖告警**:`npm audit` 会报若干来自 `react-scripts`(CRA 5,已停止维护)的告警,这些是 webpack-dev-server/svgr 等**构建期工具**,不进生产产物。运行时依赖(axios、react 等)已升级到无已知高危漏洞的版本。彻底清除构建期告警需迁移到 Vite 等新构建工具。
- **ffmpeg**:视频生成等功能依赖系统 ffmpeg;exec 调用均使用参数数组,无 shell 注入。

发现安全问题请提 issue 或私下联系维护者。

## 许可证

本项目整体采用 **AGPL-3.0**（继承自 go-music-dl）。详见 [LICENSE](./LICENSE)。
对外提供网络服务时,须依 AGPL-3.0 要求公开完整源码。

## 免责声明

本项目仅供学习与技术交流使用（沿袭 go-music-dl 的声明）。各音乐平台的解析与下载请遵守对应平台的服务条款及当地法律,因使用本项目产生的任何后果由使用者自负。
