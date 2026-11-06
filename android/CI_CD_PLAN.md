# Melodex Android CI/CD实施计划

更新时间：2026-07-19

## 目标

为Android客户端建立可审计、可重复、可覆盖升级的构建发布链：

1. PR必须通过版本规则测试、Android单测、Lint和Debug构建。
2. `master`持续产生短期Debug诊断包，但不作为升级渠道。
3. `vX.Y.Z-rc.N`产生正式密钥签名的GitHub Pre-release。
4. `vX.Y.Z`产生正式密钥签名的GitHub Release。
5. 每个Release同时发布APK、SHA256和GitHub构建来源证明。
6. 稳定版必须来自已经在真机(PKG110 / Android 16)上完成真实播放验收的同一提交。

## 流水线

| 触发 | 检查 | 产物 | 保留/发布 |
|---|---|---|---|
| PR到`master` | Node版本规则、Android单测、Lint、Debug构建 | Debug APK | Actions Artifact 7天 |
| 推送`master` | 同PR | Debug APK | Actions Artifact 7天 |
| `vX.Y.Z-rc.N` | 全部检查、Release签名、验签、包信息校验 | 签名APK、SHA256、来源证明 | GitHub Pre-release |
| `vX.Y.Z` | 同RC | 签名APK、SHA256、来源证明 | GitHub Release |

GitHub Actions是唯一构建发布源。私仓与GitHub继续双推源码，但不运行第二套发布流水线，避免相同标签产生不同二进制。

## 当前实施状态

截至2026-07-19：

- 已落地版本解析测试、Gradle版本/签名注入、普通CI、签名Release、Dependabot和CODEOWNERS。
- 已建立正式Release Key、本机DPAPI备份、`android-release` Environment Secrets、维护者人工批准和`v*`标签策略。
- 已在JDK 21下完成无缓存Debug链路，以及`v0.2.1-rc.1`本地正式签名构建、验签和包元数据核对。
- 已双推源码，GitHub普通CI通过；`master`已要求真实check-run名称`verify`，并禁止强推、删除。
- `v0.2.1-rc.1`已完成首次真实Pre-release，APK、SHA256、固定证书和来源证明均通过；其运行暴露并验证修复了Windows PowerShell 5上传Base64时的BOM问题。
- 因上传修复发生在`rc.1`标签之后，本文件所在最终提交将直接发布为`v0.2.1-rc.2`，它才是后续vivo真机验收候选。
- `v0.2.1`稳定标签继续由目标vivo真机验收门禁阻挡，不在本轮自动创建。

截至2026-11-06（`v0.2.1-rc.3`）：

- 本版内容是**返回键系统化**(此前 APK 完全没处理返回键,按一下直接退 App)
  与睡眠定时面板修复。发布链本身无改动。
- `android-release` Environment 设了必需审核人,打标签后 workflow 会停在
  `waiting`。命令行批准(本机 `gh` token 已有权限):
  `gh api -X POST repos/aki-riko/Melodex/actions/runs/<id>/pending_deployments --input approve.json`,
  请求体 `{"environment_ids":[<env_id>],"state":"approved"}`;
  环境 id 从 `GET .../pending_deployments` 取。**注意 `-f environment_ids[]=` 会被当成字符串**
  报 422,必须走 `--input` 传 JSON。
- 本机给真机装包时注意:设备上装的是 Release 签名版,**debug 包签名不同装不上**
  (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`),必须走 CI 出正式签名包。
  而 `cap:copy` 只拷贝 `android/web`,前端改动仍随远端站点即时生效,
  只有**原生代码**(如 SystemBackPlugin)必须重新装 APK。
- 真机(PKG110 / Android 16 / API 36)已实测 `rc.3` 返回键三项:
  ① 打开「更多」抽屉按返回 → 只收抽屉,Activity 仍 `topResumedActivity`;
  ② 全屏播放页按返回 → 收起播放页留在列表;
  ③ 层级全空后再按一次 → App 退到后台(前台切走)且 **pid 仍存活**、
  MediaSession 仍在(播放不中断);再回 App 状态完整保留。
  ④ 连按两次:第一次收播放页且留在 App,第二次才退后台 —— 证明不是"一按就退"。


## 版本规则

标签是Release版本的唯一来源：

```text
versionCode = major * 1,000,000 + minor * 10,000 + patch * 100 + channel
```

- `rc.1`到`rc.98`：`channel=1..98`
- 稳定版：`channel=99`
- `major <= 2099`，`minor/patch <= 99`

示例：

- `v0.2.1-rc.1` → `versionName=0.2.1-rc.1`，`versionCode=20101`
- `v0.2.1` → `versionName=0.2.1`，`versionCode=20199`

## 签名与密钥

- Release Key为RSA 4096位PKCS12，有效期10000天，别名`melodex`。
- 密钥、密码和恢复文件禁止进入Git；`.gitignore`覆盖`.jks/.keystore`及签名属性文件。
- GitHub Environment：`android-release`。
- Environment Secrets：
  - `ANDROID_KEYSTORE_BASE64`
  - `ANDROID_KEYSTORE_PASSWORD`
  - `ANDROID_KEY_ALIAS`
  - `ANDROID_KEY_PASSWORD`
- Provision脚本在本机保存keystore，并用当前Windows用户DPAPI加密恢复信息。
- 本机备份不等于离线备份；首次发布前必须再复制到至少一个离线介质。

密钥丢失后无法覆盖升级已安装客户端，这是稳定发布的硬门禁。

## GitHub安全边界

- Workflow第三方Action固定到完整提交SHA，由Dependabot维护。
- 普通CI权限仅为`contents: read`。
- Release任务仅获得`contents: write`、`id-token: write`和`attestations: write`。
- Release Secret只存在于受保护Environment，不提供给PR和`master`普通CI。
- `master`禁止强推和删除，合并前必须通过`Android CI / verify`。
- 单人维护暂不强制他人Review，避免无法合并自己的PR；敏感文件仍由CODEOWNERS标记。

## RC真机验收

自动化通过不等于播放问题已经真实修复。每个准备晋升稳定版的RC必须：

1. 从GitHub Pre-release下载签名APK并覆盖安装旧版，确认设置和登录数据保留。
2. 用真实账号、真实歌曲队列锁屏播放至少15分钟。
3. 至少自动切换4首，确认队列顺序和音流一致。
4. 确认虚假noisy事件不会暂停(此前 vivo 机型出现过;换机后同样要观察)。
5. 确认真实有线/蓝牙耳机断开会暂停。
6. 确认耳机键单击播放/暂停、双击下一首。
7. 返回键逐层收界面、层空才退后台,且退后台后播放不中断(见上方 rc.3 实测项)。
8. 日志中无崩溃、后台服务退出或循环错误重试。

验收通过后，对同一提交创建稳定标签；禁止修改代码后直接沿用旧RC结论。

## 实施顺序

1. 落地版本解析与单测、Gradle版本/签名注入。
2. 落地PR/master CI和标签Release workflow。
3. 本机无缓存跑完整测试、Lint、Debug和正式密钥签名Release构建。
4. 推送后等待GitHub CI真实通过。
5. 创建`android-release` Environment，配置当前维护者人工批准和`v*`标签策略。
6. 生成Release Key、保存本机DPAPI备份并写入Environment Secrets。
7. 首次GitHub CI成功后读取真实check-run名称，再开启`master`分支保护。
8. 创建`v0.2.1-rc.1`并等待Pre-release产物、验签、校验和与来源证明完成。
9. 真机验收通过后再创建`v0.2.1`。

## 完成判据

- PR检查能阻止测试、Lint或构建失败的提交合并。
- `master`构建可下载Debug Artifact。
- RC标签产生可覆盖安装、签名证书固定的APK。
- GitHub Release同时存在APK、`.sha256`和有效构建证明。
- Release日志与Artifact不包含密钥或密码。
- 私仓与GitHub的源码提交和标签一致。
