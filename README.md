# TuneScout+

> 音乐**发现**与**下载**二合一:在精致的 React 界面里发现好音乐,一键从国内多源解析下载。

TuneScout+ 把两个开源项目合并为一个统一工具:

- **发现** —— 沿用 [TuneScout](https://github.com/peter-bf/tunescout) 的 Last.fm / Spotify 榜单与艺人洞察界面。
- **下载** —— 集成 [go-music-dl](https://github.com/guohuiyuan/go-music-dl) 的全网多源搜索与无损下载能力(网易云、QQ、酷狗、酷我、咪咕、汽水、Bilibili、Apple Music 等 10+ 平台)。

架构上,React 作为统一前端,go-music-dl 退为提供 JSON API 的后端下载服务。

## 项目结构

```
TuneScout+/
├── backend/    Go 后端(基于 go-music-dl,Gin + music-lib),提供 /api/v1/* JSON 接口
└── frontend/   React 前端(基于 TuneScout,CRA + react-query + tailwind)
```

## 开发运行

后端:

```bash
cd backend
go run ./cmd/music-dl web   # 默认 :8080
```

前端:

```bash
cd frontend
npm install
npm start                   # 默认 :3000,开发时代理到后端
```

## 致谢与来源

本项目是以下两个开源项目的衍生作品,核心功能与代码来自它们,版权归原作者所有:

- [peter-bf/tunescout](https://github.com/peter-bf/tunescout) —— 发现页 UI
- [guohuiyuan/go-music-dl](https://github.com/guohuiyuan/go-music-dl)（作者 guohuiyuan）—— 多源搜索与下载引擎

## 许可证

本项目整体采用 **AGPL-3.0**（继承自 go-music-dl）。详见 [LICENSE](./LICENSE)。
对外提供网络服务时,须依 AGPL-3.0 要求公开完整源码。

## 免责声明

本项目仅供学习与技术交流使用（沿袭 go-music-dl 的声明）。各音乐平台的解析与下载请遵守对应平台的服务条款及当地法律,因使用本项目产生的任何后果由使用者自负。
