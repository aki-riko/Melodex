# Melodex PrismQML C++ 桌面客户端

这是 Melodex 的独立原生桌面客户端。主程序、业务对象、网络请求、Cookie 持久化、
播放队列和音频播放均由 C++ 实现，界面继续复用现有 QML。它直接消费 PrismQML 的
C++ SDK，不依赖 PWA、Tauri、PySide 或 Python 运行时。

界面使用 PrismQML 的 Fluent 亮色皮肤，以及 `Windows` 紧凑导航、SettingsCard、
SplashScreen、InfoBar、ListWidget、ScrollArea、ImageWidget、SplitPane 等发布版桌面组件重新设计，
不复刻 PWA 的网页布局。当前包含 Melodex 登录与会话保持、全网搜索、Qt Multimedia
原生播放队列、同步歌词、个人歌单（我喜欢、自建及平台导入）、搜索结果加入歌单、
透明无标题桌面歌词、鼠标穿透和系统托盘。

客户端先向 `/api/v1/playback_ticket` 申请与当前用户、会话纪元和单曲查询绑定的签名直链，
再注册到仅监听 `127.0.0.1` 的 C++ 媒体续传服务。`QMediaPlayer` 从不可猜的本地 URL
读取音频；独立 C++ 工作线程负责上游 Range 请求、固定上限背压和字节搬运。若反向代理或
远端在完整响应前断开，续传服务会从实际已交付字节的绝对偏移继续请求，并校验
`Content-Range`、总长度、ETag 与 Last-Modified 后再拼接，避免残缺 FLAC 被误判为播放结束。
整个音频数据面不经过 Python，也不占用 QML/UI 线程。票据默认有效 6 小时且不超过登录会话寿命；服务端可用
`MUSIC_DL_PLAYBACK_TICKET_MAX_AGE` 调整（Go duration 格式，最短 5m）。

当前歌曲、播放队列与进度会按 Melodex 服务地址和登录用户隔离保存。应用重新启动并
恢复会话后会还原“正在播放”界面与上次位置，但不会绕过系统策略自动开始播放。

## 依赖准备

需要 MSVC 2022、CMake、NMake、Qt 6.11.1 基础 SDK、Qt Multimedia、Qt Image Formats，
以及使用同一 Qt 版本构建的 PrismQML C++ SDK。Qt Image Formats 提供咪咕等来源 WebP
封面所需的 `qwebp` 插件。通过 Qt Online Installer 或对应 SDK 的 MaintenanceTool，
在同一个 Qt 6.11.1 MSVC 2022 64-bit 安装中勾选 Qt Multimedia 与 Qt Image Formats。
当前 `aqtinstall 3.3.0` 尚未适配 Qt 6.11.1 按架构拆分后的仓库目录，不能把它作为
这两个模块的增量安装命令。

`.venv` 和 `.prism-sdk` 均已由 Git 忽略。Python 目录保留为迁移前的行为基线，
仅用于回归测试，不参与 C++ 程序运行。

## 日常启动

客户端已经部署后，在任意当前 PowerShell 会话中始终执行这一条命令：

```powershell
& "$env:LOCALAPPDATA\Melodex\desktop-deploy\bin\melodex_desktop.exe"
```

这条命令直接运行固定部署目录里的现成客户端，不执行 Python 测试、CMake/CTest、安装或
Qt 部署，也不会再启动一个 PowerShell 子进程。日常“启动客户端”只使用这一条。

## 开发构建与完整验证

仅在需要重新构建或做完整开发验证时，复制本机配置模板，填写 Qt 和 Visual Studio
开发环境路径；`run-local.config.psd1` 已被 Git 忽略，本机路径不会进入仓库：

```powershell
Copy-Item .\desktop-prismqml\run-local.config.example.psd1 `
    .\desktop-prismqml\run-local.config.psd1
```

内部 `run-local.ps1` 会按固定顺序完成 Python 回归测试、CMake 配置与增量构建、CTest、安装、
`windeployqt`、结束旧客户端和启动新客户端。默认构建目录固定为
`%LOCALAPPDATA%\Melodex\desktop-build`，部署目录固定为
`%LOCALAPPDATA%\Melodex\desktop-deploy`，不再创建带时间戳的临时目录，也不依赖当前
PowerShell 会话里临时设置的环境变量。若本机目录需要调整，只修改一次本机配置文件。
脚本会在构建前检查 Qt SDK 的 `qwebp` 插件，并在部署后再次检查固定部署目录中的副本，
避免客户端在缺少 Qt Image Formats 时悄悄退化为“不支持 WebP”。
为规避 MSVC 链接中文依赖路径的问题，配置指定的 PrismQML SDK 会自动同步到同一目录下
的 `prism-sdk-cache`；CMake 和最终部署都使用这份固定缓存，不会混入另一版本的运行时。

若仓库路径包含中文，MSVC 可能因 PDB 路径报 `LNK1201`，链接器也可能无法打开中文路径下
的依赖库。脚本将构建、部署和 SDK 缓存固定放在纯 ASCII 的 LocalAppData 路径，源码仍保持原位。

安装规则会把本机配置指定的 PrismQML SDK 模块复制到 EXE 旁的 `qml/PrismQML`。
统一脚本在启动前会清除当前会话遗留的 `PRISMQML_QML_DIR`，避免意外加载另一套 QML
运行时；部署目录因此不依赖源码、构建目录或临时环境变量。

首次启动填写自己的 Melodex 服务地址和账号。会话 cookie 只保存在当前用户的应用配置目录；
服务地址前若有浏览器专用 SSO 网关，客户端会提示网关拦截，但不会擅自修改服务端配置。
桌面客户端与服务端必须同时更新到包含 `playback_ticket` 接口的版本，否则原生播放会明确报错，
不会退回可能受 Python 调度影响的旧音频转发链路。
