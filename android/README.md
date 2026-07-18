# Melodex Android

Melodex Android 采用 Capacitor + Media3 混合架构：

- `BridgeActivity` 加载 `capacitor.config.json` 中配置的 Melodex Web 站点，完整复用 React 页面、服务端排序、登录、歌单、歌词和下载管理。
- 浏览器继续使用现有 Web 播放器；只有 Capacitor Android 会切换到 `NativePlayerProvider`。
- `NativePlaybackPlugin` 把网页队列原序交给 Media3 `MediaSessionService`，支持后台播放、锁屏媒体控件、蓝牙耳机、系统音频焦点和前台媒体通知。
- 原生播放器从 WebView `CookieManager` 读取当前站点 Cookie，并注入媒体流请求，保持 Authentik 与 Melodex 登录态。
- 网页资源从服务器实时加载，前端部署后无需重新发布 APK；APK 内的 `android/web/index.html` 仅作为本地占位资源。

## 环境

- Node.js 22+
- JDK 21
- Android SDK 36
- Gradle Wrapper（首次构建会解析官方 AndroidX/Media3 依赖）

## 构建

```powershell
# 仓库根目录：安装 Capacitor 构建依赖
npm.cmd install

# 可选：系统默认不是 JDK 21 时，指定便携 JDK 目录
$env:MELODEX_JAVA_HOME = 'D:\path\to\jdk-21'

cd android
.\build.cmd testDebugUnitTest assembleDebug lintDebug
```

调试 APK 生成到 `app/build/outputs/apk/debug/app-debug.apk`。

`build.cmd` 会先执行 `npm.cmd run cap:copy`，再把仓库根临时映射到空闲盘符并从 `android` 子目录执行 Gradle；结束后立即解除映射。这同时解决 Windows 非 ASCII 路径与 Capacitor 根目录 `node_modules` 的解析问题。

## 服务器配置

默认站点在仓库根 `capacitor.config.json` 的 `server.url` 中配置。自托管分支可修改该配置文件后重新构建 APK；生产媒体流必须使用 HTTPS。

## 验收边界

单测、构建与 Lint 只能证明桥接和静态行为正确。后台播放是否不再被手机系统杀死，必须在目标手机上安装 APK，用真实账号播放真实队列，并锁屏持续至少 15 分钟验证。
