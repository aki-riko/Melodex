#!/usr/bin/env node
// 统一门禁入口：一条命令跑完所有检查，避免漏跑。
//
// 为什么需要：
//   门禁分散在 8 个地方（npm scripts、desktop/ui、desktop/scripts、android/scripts），
//   发版前靠记忆逐个敲，漏一个就可能把坏包发出去。这里集中管理。
//
// 用法：
//   node scripts/run-gates.mjs          # 快速门禁（纯本地、秒级）
//   node scripts/run-gates.mjs --all    # 含耗时检查（构建级验证）
//
// 退出码：0 = 全绿；1 = 有失败

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

/**
 * 每条门禁：{ name, cmd, args, slow? }
 * slow 的只在 --all 时跑（避免每次都等）。
 */
const GATES = [
  {
    name: "Android 版本号算法",
    cmd: process.execPath,
    args: ["--test", "android/scripts/resolve-release-version.test.mjs"],
  },
  {
    name: "发版版本序 + 三处一致性",
    cmd: process.execPath,
    args: ["--test", "android/scripts/check-release-version.test.mjs"],
  },
  {
    name: "APK 签名指纹比对",
    cmd: process.execPath,
    args: ["--test", "android/scripts/verify-apk-signer.test.mjs"],
  },
  {
    name: "桌面更新产物验签",
    cmd: process.execPath,
    args: ["--test", "desktop/scripts/verify-updater-artifact.test.mjs"],
  },
  {
    name: "桌面歌词设置契约",
    cmd: process.execPath,
    args: ["desktop/ui/lyricsSettings.test.mjs"],
  },
  {
    name: "桌面歌词核心逻辑",
    cmd: process.execPath,
    args: ["desktop/ui/lyricsCore.test.mjs"],
  },
  {
    // 运行期测试：真的把 overlay.js 跑起来断言填色进度/可见性，
    // 静态断言看不出这类问题，所以必须单独跑。
    name: "桌面歌词运行期行为",
    cmd: process.execPath,
    args: ["desktop/ui/desktopLyrics.runtime.test.mjs"],
  },
  {
    name: "桌面壳命令清单对齐",
    cmd: process.execPath,
    args: ["desktop/scripts/shellCommandManifest.test.mjs"],
  },
  {
    name: "更新清单生成",
    cmd: process.execPath,
    args: ["desktop/scripts/build-updater-manifest.test.mjs"],
  },
];

/** 慢速门禁：需要实际构建或跨平台编译，--all 才跑。 */
const SLOW_GATES = [
  {
    name: "Rust 单元测试",
    cmd: "cargo",
    args: ["test", "--locked"],
    cwd: "desktop/src-tauri",
  },
  {
    name: "Rust 格式检查",
    cmd: "cargo",
    args: ["fmt", "--check"],
    cwd: "desktop/src-tauri",
  },
];

/** 自动发现散落的 *.test.mjs，防止新加的门禁被忘记登记。 */
function discoverUnregisteredTests() {
  const roots = [
    { dir: "android/scripts", pattern: /\.test\.mjs$/ },
    { dir: "desktop/scripts", pattern: /\.test\.mjs$/ },
    { dir: "desktop/ui", pattern: /\.test\.mjs$/ },
  ];
  const registered = new Set();
  for (const g of [...GATES, ...SLOW_GATES]) {
    for (const a of g.args || []) {
      if (typeof a === "string" && a.endsWith(".test.mjs")) {
        registered.add(a.replace(/\\/g, "/"));
      }
    }
  }

  const missing = [];
  for (const { dir, pattern } of roots) {
    let entries;
    try {
      entries = readdirSync(join(REPO_ROOT, dir));
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!pattern.test(f)) continue;
      const rel = `${dir}/${f}`;
      if (!registered.has(rel)) missing.push(rel);
    }
  }
  return missing.sort();
}

function runGate(gate) {
  const cwd = gate.cwd ? join(REPO_ROOT, gate.cwd) : REPO_ROOT;
  const started = process.hrtime.bigint();
  const result = spawnSync(gate.cmd, gate.args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  return {
    name: gate.name,
    ok: result.status === 0,
    ms,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function printResult(r) {
  const mark = r.ok ? "✓" : "✗";
  const time = r.ms > 1000 ? `${(r.ms / 1000).toFixed(1)}s` : `${Math.round(r.ms)}ms`;
  process.stdout.write(`  ${mark} ${r.name}  (${time})\n`);
  if (!r.ok) {
    const detail = `${r.stdout}\n${r.stderr}`.trim();
    for (const line of detail.split(/\r?\n/).slice(-25)) {
      process.stdout.write(`      ${line}\n`);
    }
  }
}

function main() {
  const all = process.argv.includes("--all");

  // 先做登记完整性检查：新测试没接进门禁等于没有门禁
  const missing = discoverUnregisteredTests();
  const gateList = all ? [...GATES, ...SLOW_GATES] : GATES;

  process.stdout.write(`运行 ${gateList.length} 项门禁${all ? "（含慢速）" : ""}...\n\n`);

  const results = [];
  for (const gate of gateList) {
    const r = runGate(gate);
    printResult(r);
    results.push(r);
  }

  const failed = results.filter((r) => !r.ok);
  const totalMs = results.reduce((a, r) => a + r.ms, 0);

  process.stdout.write("\n");
  if (missing.length > 0) {
    process.stdout.write(
      `⚠ 有 ${missing.length} 个测试文件未登记到本门禁：\n` +
        missing.map((m) => `    ${m}\n`).join("") +
        "  请在 scripts/run-gates.mjs 的 GATES 里补上，否则它们不会被执行。\n\n",
    );
  }

  if (failed.length > 0) {
    process.stdout.write(
      `门禁失败：${failed.length}/${results.length} 项未通过（共 ${(totalMs / 1000).toFixed(1)}s）\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `全部门禁通过：${results.length} 项（共 ${(totalMs / 1000).toFixed(1)}s）` +
      `${missing.length > 0 ? "，但有未登记测试需处理" : ""}\n`,
  );
  // 未登记测试不算失败，但要让人看见；CI 里可用 --strict 变成失败
  if (missing.length > 0 && process.argv.includes("--strict")) {
    process.exitCode = 1;
  }
}

main();
