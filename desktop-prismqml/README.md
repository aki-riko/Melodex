# Melodex PrismQML 桌面客户端

这是 Melodex 的独立 Windows/macOS 桌面客户端。它直接依赖 PyPI 发布的
`prismqml==0.3.1.34`，不修改 PrismQML 库源码，也不依赖 PWA 或 Tauri 桥接器。

界面使用 PrismQML 的 `Windows` 紧凑导航、SettingsCard、InfoBar、ListWidget、
SplitPane 等桌面组件重新设计，不复刻 PWA 的网页布局。当前包含 Melodex 登录与会话
保持、全网搜索、Qt Multimedia 原生播放队列、同步歌词、透明无标题桌面歌词、
鼠标穿透和系统托盘。

## 运行

Windows PowerShell：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe main.py
```

macOS：

```bash
python3 -m venv .venv
./.venv/bin/python -m pip install -r requirements.txt
./.venv/bin/python main.py
```

首次启动填写自己的 Melodex 服务地址和账号。会话 cookie 只保存在当前用户的应用配置目录；
服务地址前若有浏览器专用 SSO 网关，客户端会提示网关拦截，但不会擅自修改服务端配置。
