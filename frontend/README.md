# Melodex Frontend

React 18 + Vite 前端,默认同源调用 Melodex 后端。开发期可用 `VITE_MUSICDL_API` 指向本地后端。

## 环境变量

| Variable | Description |
| --- | --- |
| `VITE_LASTFM_API_KEY` | 可选。发现页 Last.fm 数据源使用 |
| `VITE_MUSICDL_API` | 可选。后端地址,同源部署可留空 |

不要在前端环境变量里放 Spotify Client Secret。浏览器 bundle 对用户可见,需要 Spotify 私密凭据的功能必须放到后端代理实现。

## Scripts

```bash
npm install
npm run dev
npm run build
```
