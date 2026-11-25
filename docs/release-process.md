# 发版流程（统一走 CI/CD）

> **核心原则**：所有产物都由 CI 构建，本地只负责「改版本号 → 打 tag → 推」。
> 本文是唯一权威流程，AGENTS.md 里的发版段落指向这里。

## 为什么不再本地构建发布

| 曾经的做法 | 问题 |
|---|---|
| 桌面端本机构建 → 手动 scp 到 NAS | 产物与 CI 不一致（实测同版本号但大小差 26 KB）；依赖本机环境；容易漏步骤 |
| 直接打 tag 不检查版本序 | 真实事故：桌面发 `v0.1.1`（versionCode 10199）时 Android 已到 `v0.2.2-rc.1`（20201），共用一个 `v*` 命名空间，导致已装用户无法升级 |
| 版本号靠记忆改 | `tauri.conf.json` / `Cargo.toml` / `Cargo.lock` 三处不一致会产出带错版本号的包 |

## 一次发版要做的三件事

```bash
# 1. 升版本号（三处必须一致，check 脚本会校验）
#    desktop/src-tauri/tauri.conf.json
#    desktop/src-tauri/Cargo.toml
#    desktop/src-tauri/Cargo.lock

# 2. 本地自检（会拦版本倒退、三处不一致、tag 非法）
npm run check:release -- --tag v0.2.3

# 3. 打 tag 并推（三个 workflow 自动触发）
git tag -a v0.2.3 -m "Melodex v0.2.3"
git push ghub refs/tags/v0.2.3
git push origin refs/tags/v0.2.3
```

## tag 一推，CI 自动做什么

| Workflow | runner | 触发 | 产物 |
|---|---|---|---|
| `android-release.yml` | ubuntu | `v*` tag | APK + `.sha256` → GitHub Release |
| `desktop-release.yml` | **windows** | `v*` tag | NSIS 安装包 + `.sig` + `latest.json` → 同一 Release |
| `docker-publish.yml` | ubuntu | `v*` tag | 两个镜像 → GHCR |

三个产物落在**同一个 GitHub Release** 下。

## 版本号必须递增（安卓硬约束）

`android/scripts/resolve-release-version.mjs` 的算法：

```
versionCode = major*1000000 + minor*10000 + patch*100 + (rc序号 或 99)
```

| tag | versionCode |
|---|---|
| `v0.2.1` | 20199 |
| `v0.2.2-rc.1` | 20201 |
| `v0.2.2` | 20299 |
| `v0.2.3-rc.1` | 20301 |

**安卓安装器只接受递增的 versionCode**，发一个比当前小的 tag 会让所有用户装不上。
`check-release-version.mjs` 会拿新 tag 和**所有已发布 tag**（本地 + 远端）比较，倒退直接失败。
这道检查已接进两个 release workflow 的构建前步骤。

## 桌面自动更新仍走 NAS（重要）

GitHub Release 里的桌面包只是**下载存档**。客户端的自动更新读的是：

```
https://music.9li.life/desktop/latest.json
```

所以桌面版发版后，**还要把产物部署到 NAS**：

```bash
# 从 Release 下载 CI 构建的那份（不要用本地构建的）
gh release download v0.2.3 --repo aki-riko/Melodex \
  --pattern 'Melodex_0.2.3_x64-setup.exe' --pattern 'latest.json' --dir dist

# scp 到 NAS
scp dist/Melodex_0.2.3_x64-setup.exe dist/latest.json \
  root@192.168.1.99:/tmp/

# 在 NAS 上部署（属主必须是 1000:1000，否则容器读不到）
ssh root@192.168.1.99 '
  D=/mnt/cache/appdata/melodex-src/data/desktop-release
  cp /tmp/Melodex_0.2.3_x64-setup.exe /tmp/latest.json "$D/"
  chown 1000:1000 "$D/Melodex_0.2.3_x64-setup.exe" "$D/latest.json"
  chmod 644 "$D/Melodex_0.2.3_x64-setup.exe" "$D/latest.json"
'
```

**统一走 CI 的好处**：以前 NAS 上是本地构建的包、GitHub 上是 CI 构建的包，两份不一致。
现在两边都用 CI 那一份，彻底一致。

## 签名材料位置（仓库外）

| 用途 | 位置 | 对应 secrets |
|---|---|---|
| Android APK 签名 | `Documents\Melodex\AndroidRelease\`（本机）+ NAS `重要文件/Android Secret/` | `ANDROID_KEYSTORE_BASE64` 等 4 个（environment: `android-release`） |
| 桌面更新签名 | NAS `重要文件/Tauri/` | `TAURI_SIGNING_PRIVATE_KEY` / `..._PASSWORD` |

恢复方式（换机器/删库重建后）：

```powershell
# Android
pwsh -NoProfile -File android\scripts\provision-release-signing.ps1 -Repository aki-riko/Melodex

# 桌面
pwsh -NoProfile -File desktop\scripts\provision-desktop-signing.ps1 `
  -Repository aki-riko/Melodex -KeyDir '\\192.168.1.99\data\home\Aquila\重要文件\Tauri'
```

## 门禁清单

发版前应全绿：

```bash
npm run test:android-version    # versionCode 算法
npm run test:release-version    # 版本序 / 三处一致性（10 项）
node desktop/ui/lyricsSettings.test.mjs
node desktop/ui/lyricsCore.test.mjs
node desktop/scripts/shellCommandManifest.test.mjs
node desktop/scripts/build-updater-manifest.test.mjs
```

`check-release-version.mjs` 在 CI 里会被两个 release workflow 各跑一次，
**本地跑它只是提前发现问题，不跑也不会漏**。
