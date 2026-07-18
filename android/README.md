# Melodex Android

Melodex 的原生 Android 客户端。它直接连接后端现有的 Subsonic facade：

- `/rest/search3`：按后端完成验活与相关性排序后的原始顺序展示，不在客户端重排或折叠同名歌曲。
- `/rest/stream`：交给 Android Media3 `MediaSessionService` 播放，支持后台、锁屏媒体控件与系统音频焦点。
- 凭据：使用 Subsonic salt/token 认证；密码由 Android Keystore 加密后保存在应用私有目录。

## 环境

- JDK 17
- Android SDK 36
- Gradle Wrapper（首次构建会解析官方 AndroidX/Media3 依赖）

## 构建

```powershell
cd android
.\build.cmd
```

调试 APK 生成到 `app/build/outputs/apk/debug/app-debug.apk`。

`build.cmd` 会临时映射一个空闲盘符再执行 Gradle，结束后立即解除映射；这是为了绕过 Android Gradle Plugin 在 Windows 非 ASCII 路径下的测试问题，也不受 PowerShell 执行策略影响。

## 使用

首次启动填写：

1. Melodex 的 HTTPS 地址，不包含 `/rest`。
2. `MUSIC_DL_SUBSONIC_USER` 对应的用户名。
3. `MUSIC_DL_SUBSONIC_PASS` 对应的密码。

客户端先调用 `ping` 验证配置，成功后才保存并进入搜索页。

## 当前范围

首版只覆盖服务器配置、全网搜索、原序列表、播放队列和后台/锁屏播放。歌单、歌词、下载管理和离线曲库后续按真实使用需求增加。
