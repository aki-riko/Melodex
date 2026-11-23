// updater 清单生成的契约测试。
//
// 锁住这些点（每一条错了都会导致线上更新失败）：
// - 版本号必须是合法 semver
// - 签名不能为空（空签名清单 = 发布坏更新）
// - URL 必须是 https，且与安装包文件名一致
// - 输出的 platforms 键必须是 windows-x86_64（与 Tauri 期望一致）

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest } from './build-updater-manifest.mjs';

/** CLI 入口路径，供「真的能跑起来」那条用例调用。 */
const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'build-updater-manifest.mjs');

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
};

const base = {
  version: '0.2.0',
  exeName: 'Melodex_0.2.0_x64-setup.exe',
  signature: 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQpSV1E...',
  baseUrl: 'https://music.9li.life/desktop',
  pubDate: '2026-11-22T00:00:00.000Z',
};

test('生成符合 Tauri 期望的清单结构', () => {
  const manifest = buildManifest(base);
  assert.equal(manifest.version, '0.2.0');
  assert.equal(manifest.pub_date, '2026-11-22T00:00:00.000Z');
  assert.ok(manifest.platforms['windows-x86_64']);
  assert.equal(manifest.platforms['windows-x86_64'].signature, base.signature);
  assert.equal(
    manifest.platforms['windows-x86_64'].url,
    'https://music.9li.life/desktop/Melodex_0.2.0_x64-setup.exe',
  );
});

test('baseUrl 末尾斜杠不会产生双斜杠', () => {
  const manifest = buildManifest({ ...base, baseUrl: 'https://music.9li.life/desktop///' });
  assert.ok(!manifest.platforms['windows-x86_64'].url.includes('//Melodex'));
  assert.equal(
    manifest.platforms['windows-x86_64'].url,
    'https://music.9li.life/desktop/Melodex_0.2.0_x64-setup.exe',
  );
});

test('拒绝非 semver 版本号', () => {
  for (const version of ['0.2', 'v0.2.0', '', 'latest']) {
    assert.throws(() => buildManifest({ ...base, version }), /semver/, `${version} 应被拒`);
  }
});

test('接受带预发布后缀的 semver', () => {
  const manifest = buildManifest({ ...base, version: '0.2.0-rc.1' });
  assert.equal(manifest.version, '0.2.0-rc.1');
});

test('拒绝空签名', () => {
  for (const signature of ['', '   ', '\n']) {
    // 断言真实的报错语义（说的是 .sig 为空），不要为了迎合测试去改产品文案。
    assert.throws(() => buildManifest({ ...base, signature }), /\.sig 内容为空/, '空签名应被拒');
  }
});

test('拒绝非 https 的 baseUrl', () => {
  assert.throws(() => buildManifest({ ...base, baseUrl: 'http://music.9li.life/desktop' }), /https/);
});

test('签名两端空白被裁掉', () => {
  const manifest = buildManifest({ ...base, signature: `  ${base.signature}\n\n` });
  assert.equal(manifest.platforms['windows-x86_64'].signature, base.signature);
});

test('安装包名做 URL 编码', () => {
  const manifest = buildManifest({ ...base, exeName: 'Melodex 桌面包.exe' });
  assert.ok(manifest.platforms['windows-x86_64'].url.includes('%20'));
  assert.ok(manifest.platforms['windows-x86_64'].url.includes('.exe'));
});

test('notes 可选，不传就不出现', () => {
  assert.equal(buildManifest(base).notes, undefined);
  assert.equal(buildManifest({ ...base, notes: '修复若干问题' }).notes, '修复若干问题');
});

test('缺安装包文件名时报错', () => {
  assert.throws(() => buildManifest({ ...base, exeName: '' }), /安装包文件名/);
});

// ---------- CLI 真的能跑起来（本鱼实际踩到的静默失败）----------
//
// 历史 bug：脚本用 `file://` + 手拼路径判断「是否被直接运行」：
//   if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`)
// Windows 上 import.meta.url 是 `file:///D:/...`（三斜杠），拼出来是
// `file://D:/...`（两斜杠）→ 永远不相等 → main() 从不执行。
// 症状极具欺骗性：**退出码 0、什么都不输出、也不写文件**，
// 看起来像"跑成功了"，实际清单根本没生成。
//
// 前面那些断言全是 import 纯函数，完全覆盖不到这条路径，所以补这个端到端用例。
test('CLI 作为脚本运行时会真的生成清单文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'melodex-manifest-'));
  try {
    // 造一个假的安装包 + 签名（脚本只读 .sig 内容，不校验是合法签名）
    const exePath = join(dir, 'Melodex_9.9.9_x64-setup.exe');
    writeFileSync(exePath, 'MZ fake installer');
    writeFileSync(`${exePath}.sig`, 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQpSV1E=');
    const outPath = join(dir, 'latest.json');

    const result = spawnSync(
      process.execPath,
      [
        scriptPath,
        '--version', '9.9.9',
        '--exe', exePath,
        '--base-url', 'https://music.9li.life/desktop',
        '--out', outPath,
      ],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 0, `脚本退出码应为 0，stderr=${result.stderr}`);
    assert.ok(existsSync(outPath), '脚本必须真的写出清单文件（曾因运行判断写错而静默不写）');
    const manifest = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(manifest.version, '9.9.9');
    assert.equal(manifest.platforms['windows-x86_64'].signature, 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQpSV1E=');
    assert.match(result.stdout, /已写入/, '应回显写入路径');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\nupdater manifest tests passed (${passed})`);
