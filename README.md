# Melodex

> 自托管音乐搜索、播放、歌单管理、服务器下载与离线缓存工具。

Melodex 以 React PWA 和 PrismQML 桌面客户端提供统一体验,后端负责多源音乐服务:

- **Web 与桌面客户端** —— Melodex 自有应用实现;Web 视觉改编自 MIT 许可的 Spotify Artist Page UI。
- **多源 Provider** —— 搜索、媒体地址和歌词能力移植自固定版本的 [CharlesPikachu/musicdl](https://github.com/CharlesPikachu/musicdl),该上游快照采用 Apache-2.0 许可。

架构上,React PWA 与 PrismQML 客户端连接 Melodex Go API;Go 服务通过独立 Python sidecar 调用固定的 Apache-2.0 Provider 快照。

## 功能

- **歌曲搜索**:国内多源(网易云/QQ/酷狗/酷我/咪咕/汽水/B站/Apple 等)并发搜索;网易、QQ、酷狗、酷我、咪咕支持歌单和专辑链接解析
- **在线播放 / 下载**:流式试听,一键下载(可写入 ID3 元数据与封面)
- **睡眠定时**:可定时停止播放,默认到点后播完整首歌再停
- **推荐歌单**:浏览各平台每日推荐歌单,进入歌单查看并下载
- **歌词**:查看逐行 LRC 歌词
- **账号登录**:网易云扫码登录;QQ、酷狗、酷我、咪咕、B站和汽水支持管理员手动录入 Cookie
- **本地音乐库**:管理已下载到本地的音乐
- **首页推荐**:直接浏览国内音乐源提供的推荐歌单,进入歌单后播放或下载
- **Subsonic 客户端直连**:后端自带一套轻量 Subsonic API(`/rest`),用[音流 / substreamer](https://www.subsonic.org/) 等标准 Subsonic 客户端连本服务,即可**搜全网在线听 + 浏览已入库曲库 + 听过自动入库**。默认关闭,见下方「Subsonic API」。

## Subsonic API(让音流等客户端直连)

Melodex 后端实现了一套轻量 Subsonic 服务端,音流/substreamer 等标准 Subsonic 客户端连一个地址即可:

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
Melodex/
├── backend/    Melodex Go 后端(Gin + Provider sidecar client)
│   ├── internal/web/              /api/v1、/music 与 /rest 接口
│   ├── provider_bridge/           Charles Provider 的 JSON sidecar
│   └── third_party/charles-musicdl/  固定上游快照与许可证
├── frontend/   React PWA(Vite + react-query + tailwind)
│   └── src/    首页、搜索、播放器、歌单、设置与离线缓存
└── desktop-prismqml/   PrismQML 原生桌面客户端
```

## 部署(Docker,推荐)

一体化镜像:React 前端 + Go 后端 + ffmpeg 打包进单个容器,前后端同源,开箱即用。

```bash
cp .env.example .env              # 首次部署:填写 POSTGRES_PASSWORD
docker compose up -d --build      # 构建并启动应用 + PostgreSQL
# 访问 http://<主机>:8329
```

镜像三阶段构建(Node 构建前端 → Go 编译并 `go:embed` 嵌入前端产物 → Alpine + ffmpeg 运行)。
PostgreSQL 使用当前稳定线 `postgres:18.4-alpine`;数据库数据持久化在 Compose volume `postgres_data`,下载的音乐与旧 SQLite 迁移源仍挂载在 `./data`。首次启用 Postgres 时,后端会从 `./data/settings.db` 迁移配置、账号、歌单、播放历史、搜索缓存等旧数据。

> 对外暴露前请阅读下方「安全说明」:除健康检查、登录/setup/register 与静态前端外,音乐数据接口均要求 Melodex 登录;首次部署需在 `/music/setup` 初始化管理员。

## 开发运行

**后端**(示例用 :8329):

```bash
cd backend
go run ./cmd/melodex web --port 8329
```

**前端**(默认 :3000):

```bash
cd frontend
cp .env.example .env          # VITE_MUSICDL_API 指向本地后端
npm install
npm run dev                   # 开发服务器;打包用 npm run build(产物在 build/)
```

## 接口约定

前端通过两类后端接口工作:

- `GET /api/v1/*` —— JSON 接口(搜索/歌单/专辑/歌词/推荐/登录/cookie),供 React 与 PrismQML 客户端调用
- `GET|POST /music/*` —— 下载、流式播放、本地库、歌单与兼容接口
- `GET|POST /rest/*` —— 可选 Subsonic facade

## 致谢与来源

当前代码使用并保留下列第三方来源的许可声明:

- [CharlesPikachu/musicdl](https://github.com/CharlesPikachu/musicdl)（作者 CharlesPikachu）—— 多源 Provider,固定提交 `b4cecd9d450ede6f5c8d4df08763668256dfee58`,Apache-2.0
- [Adam Lowenthal / Spotify Artist Page UI](https://codepen.io/alowenthal/pen/rxboRv) —— Web 视觉设计,MIT
- [PrismQML](https://github.com/aki-riko/PrismQML) —— 原生桌面客户端 UI 框架

后端当前树、固定 Provider 与 Git 历史的详细来源边界见
[`backend/PROVENANCE.md`](./backend/PROVENANCE.md)。

## 安全说明

部署前请了解以下安全边界:

- **对外暴露需先设管理员**:后端默认监听全部网卡(`0.0.0.0`)。除健康检查、登录/setup/register 与静态前端外,搜索、播放、下载、歌单和本地库等数据接口都要求 Melodex 登录;扫码登录、Cookie 管理、用户管理和系统设置还要求管理员角色。首次访问 `/music/setup` 时,用启动终端打印的令牌初始化管理员账号。
- **仅本机使用更安全**:若只在本机使用,用 `--desktop` 模式启动会绑定 `127.0.0.1`。
- **SSRF 防护**:封面代理 `/music/cover_proxy` 已拒绝指向内网/环回/云元数据(`169.254.169.254`)的目标,并覆盖十进制/十六进制/IPv6 等绕过写法。注:校验在请求前做 DNS 解析,理论上仍存在 DNS rebinding(TOCTOU)的残余风险;若部署在敏感内网,建议在网络层(防火墙/出网策略)额外限制后端的出站访问。
- **登录防爆破**:管理员登录失败有次数锁定;密码以 bcrypt 存储。
- **上传限制**:本地音乐上传仅接受音频扩展名白名单,文件名经清洗防路径穿越。
- **前端依赖**:构建工具为 Vite,运行时依赖(axios、react 等)均已升级到无已知高危漏洞的版本,生产 build 产物无 critical/high 漏洞。`npm audit` 仍会报少量来自构建/开发期工具链(vite dev server、tailwind/postcss 的 glob 等)的告警,这些**不进生产产物**,且多为 dev-only(仅 `npm run dev` 期间)。
- **ffmpeg**:音频探测、转码与元数据处理依赖系统 ffmpeg;exec 调用均使用参数数组,无 shell 注入。

发现安全问题请提 issue 或私下联系维护者。

## 许可证

本项目整体采用 **AGPL-3.0**。详见 [LICENSE](./LICENSE)。
`backend/third_party/charles-musicdl` 保留其 **Apache-2.0** 许可证、上游 README、CITATION 与固定提交说明。
对外提供网络服务时,须依 AGPL-3.0 要求公开完整源码。

## 免责声明

本项目仅供学习与技术交流使用。各音乐平台的解析与下载请遵守对应平台的服务条款及当地法律,因使用本项目产生的任何后果由使用者自负。
