# Melodex backend

Melodex 后端负责用户、歌单、搜索编排、流式播放、服务器下载、本地曲库与 Subsonic facade。

## Provider 边界

歌曲搜索、媒体地址与歌词由独立 Provider sidecar 提供。sidecar 使用固定的
`CharlesPikachu/musicdl` 源码快照:

- 上游: <https://github.com/CharlesPikachu/musicdl>
- 提交: `b4cecd9d450ede6f5c8d4df08763668256dfee58`
- 版本: `2.8.4`
- 该提交许可证: Apache-2.0

完整上游许可证与固定版本说明位于
[`third_party/charles-musicdl`](./third_party/charles-musicdl)。Melodex 的 JSON 映射层位于
[`provider_bridge`](./provider_bridge),Go 客户端位于
[`internal/provider/bridge`](./internal/provider/bridge)。

当前树、兼容命名与 Git 历史的来源边界记录在
[`PROVENANCE.md`](./PROVENANCE.md)。

歌单、专辑、分类、平台歌单、网易扫码和账号校验也通过同一个 Provider
sidecar 提供，协议实现位于 [`provider_bridge`](./provider_bridge)，Go 侧只保留稳定模型
与业务编排，不再内置平台 HTTP Provider。

## 能力

- 12 个音源的歌曲搜索、播放地址和歌词: Provider sidecar
- 网易、QQ、酷狗、酷我、咪咕的歌单、专辑与分类
- 网易、QQ 的平台个人歌单导入
- 网易扫码登录
- 其他 Cookie 音源的管理员手动录入
- `/api/v1` JSON API
- `/music` 下载、播放、本地库与兼容 API
- 可选 `/rest` Subsonic facade

## 运行

推荐从仓库根目录运行完整 Compose，它会同时启动 PostgreSQL、Provider sidecar 和 Melodex:

```bash
cp .env.example .env
docker compose up -d --build
```

只运行 Go 服务时，必须先提供可访问的 Provider sidecar URL:

```bash
export MUSIC_DL_PROVIDER_URL=http://127.0.0.1:8840
go run ./cmd/melodex web --port 8329 --no-browser
```

现有 `MUSIC_DL_*` 环境变量和 `/music` 路由前缀作为部署兼容接口保留。

## 验证

与后端改动直接相关的门禁:

```bash
go test ./core ./internal/provider/... ./internal/web/ -count=1
go build ./cmd/melodex
python -m unittest discover -s provider_bridge/tests -v
```

真实平台联调需设置相应 Cookie；集合、扫码和账号校验请求均经 Provider sidecar。

## 许可证

Melodex 后端随项目按 AGPL-3.0 发布。固定的 CharlesPikachu/musicdl 快照继续遵循其
Apache-2.0 许可证，二者的许可证文件分别保留。
