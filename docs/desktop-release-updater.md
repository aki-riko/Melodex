# 桌面客户端发布与自动更新

Melodex 桌面客户端使用 Tauri 2 的 updater 插件做应用内更新。本文说明**发布一次新版本**要做什么，
以及**为什么当前自动更新还不会真正生效**。

## 现状（2026-11-22）

- 壳已接入 updater：启动后台静默检查 + 托盘「检查更新…」交互式更新。
- 公钥已写入 `desktop/src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`
  （来自 `<SIGNING-DIR>/.tauri-updater-key.pub`）。
- **更新清单 `https://music.9li.life/desktop/latest.json` 尚未部署**，所以现在每次检查都会得到
  `检查更新失败：error decoding response body` 并只记一条 WARN。
  原因：后端 SPA fallback 把该路径当成前端路由，返回了 HTML 首页而不是 JSON。
  这是预期状态，不是缺陷；部署清单后即恢复。

### 已完成的端到端验证（2026-11-22）

清单未部署不妨碍先验「检查」这一段。壳体支持**运行时覆盖更新端点**：

```powershell
$env:MELODEX_UPDATER_ENDPOINTS = 'http://127.0.0.1:47900/latest.json'
& "$env:LOCALAPPDATA\Melodex\desktop-deploy\bin\melodex_desktop.exe"
```

配合 `desktop/prototype/scripts/serve-manifest.ps1`（本地清单服务）与
`desktop/prototype/fixtures/latest.json`（版本 9.9.9 的测试清单）实测结果：

- 服务端：`request GET /latest.json`（两次）
- 壳侧：`updater endpoints overridden by MELODEX_UPDATER_ENDPOINTS: ...` →
  `update available: 9.9.9`

即 **「发起检查 → 拉取清单 → 解析 → 判定有新版本」这一段已用真实 HTTP 请求验证通过**。

> **release 构建的硬约束（实测警告）**：更新器会对非 https 端点告警
> `The updater endpoint ... doesn't use https protocol. This is allowed in development
> but will fail in release builds`。所以上面的 `http://127.0.0.1` 覆盖**只适用于本机调试**；
> 正式发布必须用 `https`。若确实需要 http（不建议），得在插件配置里显式打开
> `dangerousInsecureTransportProtocol`。

> **仍未验证**：由于没有真实签名产物，「下载 → 安装 → 版本号变化」这一段没跑过。
> 首次真实发布时必须逐项确认，不可仅凭代码推断。

## 发布一次新版本的完整步骤

### 1. 改版本号

版本号在 `desktop/src-tauri/tauri.conf.json` 的 `version` 字段。semver，必须比用户已装的更大。

### 2. 用私钥签名构建

私钥与口令**不在仓库内**，位于 NAS：`<SIGNING-DIR>`

```powershell
# 只在本机会话内注入，不要把值写进任何文件或提交
$env:TAURI_SIGNING_PRIVATE_KEY = '<私钥文件内容或路径，按官方文档要求>'
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '<口令>'

cd desktop/src-tauri
npx tauri build
```

产物：

- `target/release/bundle/nsis/Melodex_<version>_x64-setup.exe`
- `target/release/bundle/nsis/Melodex_<version>_x64-setup.exe.sig`（签名，updater 必需）

> **私钥纪律**：`TAURI_SIGNING_PRIVATE_KEY` 只在构建时存在于环境变量。
> 禁止写入 `.env`、脚本、CI 明文日志；禁止在对话/输出里回显。
> 私钥丢失 = 已装用户再也收不到更新，请确保离线备份。

### 3. 生成更新清单

`desktop/scripts/build-updater-manifest.mjs` 从构建产物生成 `latest.json`：

```powershell
node desktop/scripts/build-updater-manifest.mjs `
  --version 0.2.0 `
  --exe desktop/src-tauri/target/release/bundle/nsis/Melodex_0.2.0_x64-setup.exe `
  --base-url https://music.9li.life/desktop
```

### 4. 发布产物

把 `setup.exe` 与 `latest.json` 放到服务端，使 URL 满足：

- 清单：`https://music.9li.life/desktop/latest.json`
- 安装包：`https://music.9li.life/desktop/<exe 文件名>`

**关键（踩坑）**：`/desktop/` 必须**绕过 SPA fallback**，否则后端会返回 HTML 首页而不是静态文件。
在反代或后端静态路由里为 `/desktop/` 添加直读静态文件的映射，
并在 NPM 对该路径 `auth_request off;` 放行（与 PWA 静态资源同理，更新器不带 SSO 会话）。

验证：

```powershell
# 必须是 JSON，不能是 HTML
curl.exe -s https://music.9li.life/desktop/latest.json | Select-Object -First 1
```

### 5. 验证更新流程

1. 保持旧版本运行 → 托盘「检查更新…」→ 应弹出「发现新版本」确认框。
2. 确认后应下载、启动安装器、进程退出（Windows 语义）。
3. 重新打开，版本号应为新版本。

**未验证项**：截至 2026-11-22，上述第 5 步尚未在真实发布上跑通（清单未部署）。
首次真实发布时必须逐项确认，不可仅凭代码推断。
