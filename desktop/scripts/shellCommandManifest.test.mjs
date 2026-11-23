// 桌面壳命令清单一致性门禁 —— 锁死「命令注册了却调不到」。
//
// ## 为什么要有
//
// `build.rs` 启用 `app_manifest` 后，tauri-build **只对声明过的命令**生成
// `allow-*` 权限。漏一条的症状是：该命令在任何窗口都调不了，而且
// **日志里什么都不报** —— 歌词窗不显示、设置改不动，却找不到原因。
//
// 靠人记住「两处都要改」必然会漏（历史上已经漏过），所以这里用机器比对三处：
//   1. `main.rs` 的 `generate_handler![...]`   —— 实际注册的命令
//   2. `build.rs` 的 `commands(&[...])`         —— 生成权限的依据
//   3. `capabilities/*.json` 的 `allow-*` 条目  —— 实际授予窗口的权限
//
// 规则：
//   - 1 与 2 必须**完全相等**（漏声明 = 调不到；多声明 = 权限白名单虚高）
//   - 3 里的每个 `allow-<cmd>` 必须有对应命令（拼错就是永不生效的权限）
//     `core:` 之类内置权限跳过
//   - 每条命令必须至少被一个 capability 授予，否则等于没注册
//
// 运行: node scripts/shellCommandManifest.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const tauriRoot = resolve(scriptDir, '../../desktop/src-tauri');

const read = (...parts) => readFileSync(join(tauriRoot, ...parts), 'utf8');

// ---------- 1. main.rs 的 generate_handler! ----------

const mainRs = read('src', 'main.rs');
const handlerBlock = mainRs.match(/generate_handler!\s*\[([\s\S]*?)\]/);
assert.ok(handlerBlock, 'main.rs 里找不到 generate_handler![...]');

const registered = [...handlerBlock[1].matchAll(/commands::([a-z0-9_]+)/g)].map((m) => m[1]);
assert.ok(registered.length > 0, 'generate_handler! 里没有解析到任何命令');
assert.equal(
  new Set(registered).size,
  registered.length,
  `generate_handler! 里有重复命令：${registered.join(', ')}`,
);

// ---------- 2. build.rs 的 commands([...]) ----------

const buildRs = read('build.rs');
const manifestBlock = buildRs.match(/\.commands\(\s*&\[([\s\S]*?)\]\s*\)/);
assert.ok(manifestBlock, 'build.rs 里找不到 .commands(&[...])');

const declared = [...manifestBlock[1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
assert.ok(declared.length > 0, 'build.rs 的 commands() 里没有解析到任何命令');
assert.equal(
  new Set(declared).size,
  declared.length,
  `build.rs 的 commands() 里有重复项：${declared.join(', ')}`,
);

// 核心断言：两处必须完全相等（顺序无关，但集合必须一致）。
const missingInManifest = registered.filter((cmd) => !declared.includes(cmd));
const extraInManifest = declared.filter((cmd) => !registered.includes(cmd));

assert.deepEqual(
  missingInManifest,
  [],
  `这些命令在 main.rs 注册了但 build.rs 没声明，将「任何窗口都调不了」：${missingInManifest.join(', ')}`,
);
assert.deepEqual(
  extraInManifest,
  [],
  `这些命令在 build.rs 声明了但 main.rs 没注册，权限白名单虚高：${extraInManifest.join(', ')}`,
);

// ---------- 3. capabilities/*.json 的 allow-* ----------

/** 命令名 → 授予它的 capability 列表。 */
const grantedBy = new Map();
const unknownPermissions = [];

for (const file of readdirSync(join(tauriRoot, 'capabilities')).filter((f) => f.endsWith('.json'))) {
  const capability = JSON.parse(read('capabilities', file));
  for (const permission of capability.permissions || []) {
    // 内置权限（core:default 等）不是 app 命令，跳过。
    if (!permission.startsWith('allow-')) continue;
    // 约定：Tauri 把 snake_case 命令名转成 kebab-case 权限名。
    const command = permission.slice('allow-'.length).replaceAll('-', '_');
    if (!registered.includes(command)) {
      unknownPermissions.push(`${file}: ${permission}`);
      continue;
    }
    if (!grantedBy.has(command)) grantedBy.set(command, []);
    grantedBy.get(command).push(file);
  }
}

assert.deepEqual(
  unknownPermissions,
  [],
  `这些 allow-* 权限找不到对应命令（拼错就永不生效）：\n  ${unknownPermissions.join('\n  ')}`,
);

const ungranted = registered.filter((cmd) => !grantedBy.has(cmd));
assert.deepEqual(
  ungranted,
  [],
  `这些命令没有授予任何窗口，等于没注册：${ungranted.join(', ')}`,
);

// ---------- 4. 安全边界：远程 origin 的 IPC 面必须逐个列举 ----------

const bridge = JSON.parse(read('capabilities', 'lyrics-bridge.json'));
assert.deepEqual(
  bridge.windows,
  ['main'],
  'lyrics-bridge 只应覆盖主窗口',
);
assert.deepEqual(
  (bridge.remote?.urls || []).length > 0,
  true,
  'lyrics-bridge 必须显式声明 remote.urls，否则等于没给远程页面开',
);

// ★ 远程 origin 白名单必须**逐条可解释**，不允许出现任意域名。
//
// 允许的两类：
//   ① 生产站点 https://music.9li.life/*
//   ② 本机回环（http://127.0.0.1:*/* 与 http://localhost:*/*）
//
// 为什么必须有 ②：壳支持 `MELODEX_SHELL_SITE` 运行时覆盖站点（service_url.rs 明确定义了
// loopback 例外，允许本机走 http），但 capability 的 remote.urls 若只写生产域名，
// 主窗口 origin 一变，**所有歌词桥命令都会被拒**（实测报
// `lyrics_settings_get not allowed on window "main" ... URL: http://127.0.0.1:8329/`）。
// 那意味着本地开发与自托管部署根本没法验证/使用桌面歌词。
//
// 回环的风险等级与公网域名不同：那是用户自己的机器，能连上它的人本来就能直接改设置文件。
// 但**绝不能**顺手加公网通配符（`https://*` 之类）——那等于把本机 IPC 面交给任意网站。
const REMOTE_ALLOWED_PATTERNS = [
  'https://music.9li.life/*',
  'http://127.0.0.1:*/*',
  'http://localhost:*/*',
];
assert.deepEqual(
  [...(bridge.remote?.urls || [])].sort(),
  [...REMOTE_ALLOWED_PATTERNS].sort(),
  '远程 origin 白名单只允许「生产站点 + 本机回环」，新增必须显式改这里并说明理由',
);
for (const url of bridge.remote?.urls || []) {
  assert.ok(
    !/^https?:\/\/\*/.test(url) && !url.includes('*.*'),
    `禁止通配域名（会把自己的 IPC 面交给任意网站）：${url}`,
  );
}
const bridgeCommands = (bridge.permissions || [])
  .filter((p) => p.startsWith('allow-'))
  .map((p) => p.slice('allow-'.length).replaceAll('-', '_'));

// 远程页面能调的**全部**命令在此逐一列举。
//
// 为什么允许设置命令：旧 PrismQML 实现的 6 项歌词设置就在**主窗口设置页**
// （SettingsPage.qml），用户点「设置」即可看到。新版照此放在 Web 设置页，
// 因此需要给主窗口开放 lyrics_settings_get / lyrics_settings_update /
// lyrics_reset_position 三条。
//
// 为什么这三条是安全的（与 lyrics_push_state 同理，语义自限）：
//   - get：只返回本机歌词显示偏好（字号/配色/字体/位置），不含任何凭据；
//   - update：只改本机歌词显示偏好，**不触碰文件系统/网络/进程**；
//   - reset_position：只把歌词窗挪回默认位置。
// 它们都不接受任意路径、URL 或命令名，最坏情况是「远程页面改了歌词颜色」，
// 而这本来就是它自己要显示的内容。
//
// **新增任何一条都必须在此显式修改**，让评审必须看见——这是刻意的摩擦。
const ALLOWED_REMOTE_COMMANDS = [
  'lyrics_push_state',
  'lyrics_send_command',
  'lyrics_settings_get',
  'lyrics_settings_update',
  'lyrics_reset_position',
];

assert.deepEqual(
  [...bridgeCommands].sort(),
  [...ALLOWED_REMOTE_COMMANDS].sort(),
  '远程 origin 的命令集必须与白名单完全一致（新增必须显式改白名单并说明理由）',
);
assert.equal(
  (bridge.permissions || []).filter((p) => p.startsWith('core:')).length,
  0,
  '禁止给远程 origin 开 core:* 权限',
);

// 其余命令（配对凭据、穿透控制、窗口位置写入、拖动）仍只给本地窗口。
const localOnly = registered.filter((cmd) => !ALLOWED_REMOTE_COMMANDS.includes(cmd));
for (const cmd of localOnly) {
  assert.ok(
    !bridgeCommands.includes(cmd),
    `${cmd} 是本地窗口命令，绝不能对远程 origin 开放`,
  );
}

// 特别点名：凭据类命令永远不许出现在远程 capability 里。
for (const forbidden of ['pair_device', 'clear_pairing', 'connection_config']) {
  assert.ok(
    !bridgeCommands.includes(forbidden),
    `${forbidden} 涉及设备凭据，绝不允许远程页面调用`,
  );
}

console.log(
  `桌面壳命令清单一致：${registered.length} 条命令，main.rs / build.rs / capabilities 三处对齐；`
    + `远程 origin 仅 ${bridgeCommands.length} 条（歌词桥）。`,
);
