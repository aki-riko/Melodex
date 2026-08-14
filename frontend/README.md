# Melodex Frontend

React 18 + Vite 前端,默认同源调用 Melodex 后端。首页、搜索、播放、歌单和离线缓存均直接使用 Melodex API。

## 环境变量

| Variable | Description |
| --- | --- |
| `VITE_MUSICDL_API` | 可选。后端地址,同源部署可留空 |

## Scripts

```bash
npm install
npm run dev
npm run test:source-boundary
npm run build
```
