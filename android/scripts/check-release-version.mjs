#!/usr/bin/env node
// 发布前版本号校验：在打 tag 之前拦住「版本号倒退」这类错误。
//
// 为什么需要它（真实事故）：
//   曾把桌面版发成 v0.1.1，而 Android 已经发到 v0.2.2-rc.1。
//   两个平台共用同一套 v* 标签命名空间，于是：
//     v0.1.1 → Android versionCode 10199
//     v0.2.2-rc.1 → 20201
//   装了 20201 的手机无法升级到 10199（安卓只认递增），
//   而 v0.1.1 还是个正式的 Release。
//
// 用法：
//   node android/scripts/check-release-version.mjs --tag v0.2.3 [--allow-equal]
//   node android/scripts/check-release-version.mjs --tag v0.2.3 --desktop-version 0.2.3
//
// 退出码：0 = 可以发布；1 = 有问题（原因写 stderr）

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveReleaseVersion } from "./resolve-release-version.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

const SEMVER_PLAIN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function readDesktopVersion() {
  const confPath = join(REPO_ROOT, "desktop", "src-tauri", "tauri.conf.json");
  const conf = JSON.parse(readFileSync(confPath, "utf8"));
  return conf.version;
}

function readCargoVersion() {
  const cargoPath = join(REPO_ROOT, "desktop", "src-tauri", "Cargo.toml");
  const text = readFileSync(cargoPath, "utf8");
  // 只取 [package] 段的第一个 version，不碰依赖里的 version
  const m = /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(text);
  if (!m) throw new Error("无法从 Cargo.toml 读取 package.version");
  return m[1];
}

function readCargoLockVersion() {
  const lockPath = join(REPO_ROOT, "desktop", "src-tauri", "Cargo.lock");
  const text = readFileSync(lockPath, "utf8");
  const m = /name = "melodex-desktop-lyrics"\r?\nversion = "([^"]+)"/.exec(text);
  if (!m) throw new Error("无法从 Cargo.lock 读取本 crate 版本");
  return m[1];
}

/** 列出所有已存在的 tag（本地 + 可选远端）。失败不致命 —— 没网时不阻断本地检查。 */
function listTags({ includeRemote }) {
  const tags = new Set();
  try {
    const local = execFileSync("git", ["tag", "--list"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    for (const t of local.split(/\r?\n/)) {
      if (t.trim()) tags.add(t.trim());
    }
  } catch {
    // 本地 git 不可用时只能跳过「历史最大版本」检查
  }
  if (includeRemote) {
    try {
      const remote = execFileSync("git", ["ls-remote", "--tags", "ghub"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const line of remote.split(/\r?\n/)) {
        const m = /refs\/tags\/(v[0-9][^\^]*)$/.exec(line.trim());
        if (m) tags.add(m[1]);
      }
    } catch {
      // 离线或没有 ghub remote 时忽略
    }
  }
  return [...tags];
}

/**
 * 纯函数核心：给定新 tag 与已有 tag 列表，返回问题清单。
 * 抽出来是为了能单测，不必真的打 tag。
 */
export function collectVersionProblems({ tag, existingTags, desktopVersion, allowEqual = false }) {
  const problems = [];

  // 1) tag 本身必须能解析成 Android 发布版本
  let incoming;
  try {
    incoming = resolveReleaseVersion(tag);
  } catch (error) {
    return [`标签无效：${error instanceof Error ? error.message : String(error)}`];
  }

  // 2) 不能低于任何已发布 tag 的 versionCode —— 安卓只认递增
  let maxCode = -1;
  let maxTag = null;
  for (const t of existingTags) {
    if (t === tag) continue;
    try {
      const v = resolveReleaseVersion(t);
      if (v.versionCode > maxCode) {
        maxCode = v.versionCode;
        maxTag = t;
      }
    } catch {
      // 非发布标签（如随意打的测试 tag）不参与比较
    }
  }
  if (maxTag !== null) {
    if (incoming.versionCode < maxCode) {
      problems.push(
        `版本号倒退：${tag} 的 versionCode=${incoming.versionCode}，` +
          `小于已发布的 ${maxTag}（${maxCode}）。` +
          `安卓安装器只接受递增的 versionCode，已装 ${maxTag} 的用户无法升级到 ${tag}。`,
      );
    } else if (incoming.versionCode === maxCode && !allowEqual) {
      problems.push(
        `versionCode 与已发布的 ${maxTag} 相同（${maxCode}），` +
          `会被安卓当成同一个包，无法覆盖安装。`,
      );
    }
  }

  // 3) 桌面版本号三处必须一致（不一致会导致构建出带错误版本号的包）
  if (desktopVersion !== undefined) {
    if (!SEMVER_PLAIN.test(desktopVersion)) {
      problems.push(`桌面版本号不是合法 semver：${desktopVersion}`);
    }
    const expected = tag.replace(/^v/, "");
    if (desktopVersion !== expected) {
      problems.push(
        `桌面版本号与 tag 不一致：tauri.conf.json 是 ${desktopVersion}，tag 推导应为 ${expected}。` +
          `更新器按 semver 比对，不一致会导致用户收不到更新。`,
      );
    }
  }

  return problems;
}

/** 三处桌面版本号必须完全一致，否则构建产物会带错版本。 */
export function collectDesktopConsistencyProblems({ tauriVersion, cargoVersion, lockVersion }) {
  const problems = [];
  const pairs = [
    ["tauri.conf.json", tauriVersion],
    ["Cargo.toml", cargoVersion],
    ["Cargo.lock", lockVersion],
  ];
  const distinct = new Set(pairs.map(([, v]) => v));
  if (distinct.size > 1) {
    problems.push(
      `桌面版本号三处不一致：${pairs.map(([f, v]) => `${f}=${v}`).join("，")}`,
    );
  }
  return problems;
}

function parseArgs(argv) {
  const args = {};
  // 纯开关型参数（带值的是 --tag / --desktop-version 等）
  const BOOLEAN_FLAGS = new Set(["allow-equal", "skip-desktop", "no-remote"]);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`参数 --${key} 缺少值`);
    }
    args[key] = value;
    i += 1;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.tag) {
    process.stderr.write("用法: node android/scripts/check-release-version.mjs --tag v0.2.3\n");
    process.exitCode = 1;
    return;
  }

  const existingTags = listTags({ includeRemote: !args["no-remote"] });
  const problems = [];

  // 桌面版本号一致性（三处）
  if (!args["skip-desktop"]) {
    try {
      problems.push(
        ...collectDesktopConsistencyProblems({
          tauriVersion: readDesktopVersion(),
          cargoVersion: readCargoVersion(),
          lockVersion: readCargoLockVersion(),
        }),
      );
    } catch (error) {
      problems.push(`读取桌面版本号失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 版本序 + 与 tag 的对应关系
  const desktopVersion = args["skip-desktop"] ? undefined : readDesktopVersion();
  problems.push(
    ...collectVersionProblems({
      tag: args.tag,
      existingTags,
      desktopVersion,
      allowEqual: Boolean(args["allow-equal"]),
    }),
  );

  if (problems.length > 0) {
    process.stderr.write(`发布前校验未通过（${problems.length} 项）：\n`);
    for (const p of problems) process.stderr.write(`  ✗ ${p}\n`);
    process.stderr.write(
      "\n修正方式：升 tauri.conf.json / Cargo.toml / Cargo.lock 三处版本号，" +
        "并确保新 tag 的 versionCode 大于所有已发布 tag。\n",
    );
    process.exitCode = 1;
    return;
  }

  const resolved = resolveReleaseVersion(args.tag);
  process.stdout.write(
    `发布前校验通过：${args.tag} → versionName=${resolved.versionName} ` +
      `versionCode=${resolved.versionCode} prerelease=${resolved.prerelease}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
