#!/usr/bin/env node
// 从 Tauri updater 构建产物生成 latest.json。
//
// 用法：
//   node desktop/scripts/build-updater-manifest.mjs \
//     --version 0.2.0 \
//     --exe desktop/src-tauri/target/release/bundle/nsis/Melodex_0.2.0_x64-setup.exe \
//     --base-url https://music.9li.life/desktop
//
// 为什么需要它：Tauri CLI 会生成 .sig，但不会替你生成清单；
// 清单里的 signature / url 必须与实际发布路径严格一致，否则更新器拒绝安装。

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const parseArgs = (argv) => {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`参数 ${token} 缺少值`);
    }
    args[key] = value;
    i += 1;
  }
  return args;
};

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * 构造清单对象。纯函数，便于测试。
 *
 * @param {object} input
 * @param {string} input.version semver
 * @param {string} input.exeName 安装包文件名（不含目录）
 * @param {string} input.signature .sig 文件内容
 * @param {string} input.baseUrl 发布目录的公开 URL
 * @param {string} [input.pubDate] ISO 时间
 * @param {string} [input.notes]
 */
export const buildManifest = ({ version, exeName, signature, baseUrl, pubDate, notes }) => {
  if (!SEMVER.test(version || '')) throw new Error(`版本号不是合法 semver: ${version}`);
  if (!exeName) throw new Error('缺少安装包文件名');
  const trimmed = String(signature || '').trim();
  if (!trimmed) throw new Error('.sig 内容为空（构建时没有启用 createUpdaterArtifacts？）');
  if (!/^https:\/\//.test(baseUrl || '')) throw new Error('baseUrl 必须是 https');

  const url = `${baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(exeName)}`;
  return {
    version,
    ...(notes ? { notes } : {}),
    pub_date: pubDate || new Date().toISOString(),
    platforms: {
      'windows-x86_64': { signature: trimmed, url },
    },
  };
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ['version', 'exe', 'base-url']) {
    if (!args[required]) throw new Error(`缺少必需参数 --${required}`);
  }

  const exePath = resolve(args.exe);
  const sigPath = `${exePath}.sig`;
  // 读不到就抛错：静默生成一个空签名清单等于发布坏更新。
  const signature = readFileSync(sigPath, 'utf8');

  const manifest = buildManifest({
    version: args.version,
    exeName: basename(exePath),
    signature,
    baseUrl: args['base-url'],
    notes: args.notes,
  });

  const outPath = args.out ? resolve(args.out) : resolve('latest.json');
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`已写入 ${outPath}`);
  console.log(JSON.stringify(manifest, null, 2));
};

// 仅当作为脚本直接运行时执行；被测试 import 时不跑。
//
// ★ 不能用 `file://` + 手拼路径判断：Windows 上 `process.argv[1]` 是
// `D:\其他项目\...`，拼出来是 `file://D:/...`（两斜杠），而 `import.meta.url`
// 是 `file:///D:/...`（三斜杠）——字符串永不相等，main() 从来不会执行，
// 表现为「命令退出码 0、什么都不输出、也什么都不写」。
// 正确做法是拿 URL 反解出文件路径，再用 pathToFileURL 归一化后比较。
if (process.argv[1]) {
  const scriptUrl = pathToFileURL(resolve(process.argv[1])).href;
  if (import.meta.url === scriptUrl) {
    try {
      main();
    } catch (error) {
      console.error(`生成清单失败：${error.message}`);
      process.exitCode = 1;
    }
  }
}
