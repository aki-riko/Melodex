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

需要 MSVC 2022、CMake、NMake、Qt 6.11.1 基础 SDK、Qt Multimedia，以及使用同一
Qt 版本构建的 PrismQML C++ SDK。缺失的 Qt Multimedia 可以用项目内 venv 下载，
不会修改系统 Python 或系统 Qt：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install aqtinstall
.\.venv\Scripts\aqt.exe install-qt windows desktop 6.11.1 win64_msvc2022_64 `
    -m qtmultimedia -O .prism-sdk\qt
```

`.venv` 和 `.prism-sdk` 均已由 Git 忽略。Python 目录保留为迁移前的行为基线，
仅用于回归测试，不参与 C++ 程序运行。

## 构建与测试

在“x64 Native Tools for VS 2022”PowerShell 中执行。下面的路径全部通过当前会话变量
传入，不写死到项目代码：

```powershell
$env:QT_ROOT = "D:\Qt\6.11.1\msvc2022_64"
$env:PRISM_SDK_ROOT = "D:\PrismQML\PrismQML\cpp\build\sdk"
$env:MELODEX_BUILD_DIR = "$env:LOCALAPPDATA\Temp\melodex-desktop-build"

cmake -S . -B $env:MELODEX_BUILD_DIR -G "NMake Makefiles" `
    -DCMAKE_BUILD_TYPE=Release `
    -DCMAKE_PREFIX_PATH="$env:QT_ROOT" `
    -Dprism_DIR="$env:PRISM_SDK_ROOT\lib\cmake\prism"
cmake --build $env:MELODEX_BUILD_DIR
ctest --test-dir $env:MELODEX_BUILD_DIR --output-on-failure
```

若仓库路径包含中文，MSVC 可能因 PDB 路径报 `LNK1201`，链接器也可能无法打开中文路径下
的依赖库。保持源码原位，把构建目录、Qt SDK 和 PrismQML SDK 放在纯 ASCII 路径即可；
不需要创建盘符映射。

## 安装与运行

```powershell
$env:MELODEX_DEPLOY_DIR = "$PWD\.prism-sdk\deploy"
cmake --install $env:MELODEX_BUILD_DIR --prefix $env:MELODEX_DEPLOY_DIR
& "$env:QT_ROOT\bin\windeployqt.exe" --release --compiler-runtime `
    --no-system-dxc-compiler --qmldir "$PWD\qml" `
    --qmlimport "$env:MELODEX_DEPLOY_DIR\bin\qml" `
    --qml-deploy-dir "$env:MELODEX_DEPLOY_DIR\bin\qml" `
    "$env:MELODEX_DEPLOY_DIR\bin\melodex_desktop.exe"
& "$env:MELODEX_DEPLOY_DIR\bin\melodex_desktop.exe"
```

安装规则会把 PrismQML 模块复制到 EXE 旁的 `qml/PrismQML`。运行时查找顺序为
`PRISMQML_QML_DIR` 环境变量、EXE 同目录的 `qml`、构建期 SDK 路径，因此部署目录不依赖
源码或构建目录。

首次启动填写自己的 Melodex 服务地址和账号。会话 cookie 只保存在当前用户的应用配置目录；
服务地址前若有浏览器专用 SSO 网关，客户端会提示网关拦截，但不会擅自修改服务端配置。
桌面客户端与服务端必须同时更新到包含 `playback_ticket` 接口的版本，否则原生播放会明确报错，
不会退回可能受 Python 调度影响的旧音频转发链路。
