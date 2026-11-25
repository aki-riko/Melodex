#!/usr/bin/env node
// 校验 Android APK 的签名证书指纹是否与「已发布版本」一致。
//
// 为什么需要：
//   `apksigner verify` 只证明「签名有效」，不证明「是我的那把密钥签的」。
//   keystore secret 配错成另一把密钥时，签名照样有效、CI 照样绿，
//   但 Android 会把新包当成**不同签名的应用**：
//     - 覆盖安装直接失败（INSTALL_FAILED_UPDATE_INCOMPATIBLE）
//     - 用户必须先卸载再装，App 数据全丢
//     - 且已发布版本无法再被更新
//   这是不可逆事故，所以必须在发布前比对指纹。
//
// 用法：
//   node android/scripts/verify-apk-signer.mjs --apk <APK路径>
//
// 期望指纹来源（按优先级）：
//   1) 环境变量 MELODEX_EXPECTED_CERT_SHA256
//   2) 仓库内 android/release-cert.sha256（建议提交这个文件，只含公钥指纹，不是秘密）
//
// 退出码：0 = 通过；1 = 有问题

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const EXPECTED_FILE = resolve(REPO_ROOT, "android/release-cert.sha256");

/** 把任意形式的指纹归一化成小写无分隔符，便于比较。 */
export function normalizeFingerprint(input) {
  return String(input || "")
    .replace(/[^0-9a-fA-F]/g, "")
    .toLowerCase();
}

/**
 * 从 apksigner verify --print-certs 的输出里提取证书 SHA-256。
 * 输出形如：
 *   Signer #1 certificate SHA-256 digest: 5f28d565...
 */
export function extractCertSha256(apksignerOutput) {
  const m = /Signer #1 certificate SHA-256 digest:\s*([0-9a-fA-F]+)/i.exec(
    String(apksignerOutput || ""),
  );
  if (!m) return null;
  return normalizeFingerprint(m[1]);
}

/**
 * 纯函数核心：比较实际指纹与期望指纹。
 */
export function collectSignerProblems({ actualFingerprint, expectedFingerprint }) {
  const problems = [];

  if (!actualFingerprint) {
    problems.push("无法从 apksigner 输出中取得证书 SHA-256 指纹");
    return problems;
  }
  if (!expectedFingerprint) {
    problems.push(
      "缺少期望的证书指纹：请设置 MELODEX_EXPECTED_CERT_SHA256，" +
        "或提交 android/release-cert.sha256 文件（只含公钥指纹，不是秘密）",
    );
    return problems;
  }

  const a = normalizeFingerprint(actualFingerprint);
  const e = normalizeFingerprint(expectedFingerprint);

  if (a !== e) {
    problems.push(
      `签名证书不一致：APK 是 ${a}，期望 ${e}。\n` +
        `    已装用户将无法覆盖升级（Android 会拒绝不同签名的安装），` +
        `必须卸载重装且丢失 App 数据。请检查 ANDROID_KEYSTORE_BASE64 是否指向正确 keystore。`,
    );
  }

  return problems;
}

function readExpectedFingerprint() {
  const fromEnv = process.env.MELODEX_EXPECTED_CERT_SHA256;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    // 文件允许带注释行（# 开头）与行尾说明
    const text = readFileSync(EXPECTED_FILE, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      // 取第一个像指纹的字段
      const m = /([0-9a-fA-F]{64})/.exec(t.replace(/:/g, ""));
      if (m) return m[1];
      return t.split(/\s+/)[0];
    }
  } catch {
    // 文件不存在不算错，交给 collectSignerProblems 报告
  }
  return "";
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (!t.startsWith("--")) continue;
    const k = t.slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`参数 --${k} 缺少值`);
    args[k] = v;
    i += 1;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputPath = args["apksigner-output"];
  const actualPath = args["actual-fingerprint"];

  let actual = "";
  if (actualPath) {
    actual = readFileSync(resolve(actualPath), "utf8");
  } else if (outputPath) {
    actual = extractCertSha256(readFileSync(resolve(outputPath), "utf8")) ?? "";
  } else {
    process.stderr.write(
      "用法:\n" +
        "  node android/scripts/verify-apk-signer.mjs --apksigner-output <apksigner输出文件>\n" +
        "  或 --actual-fingerprint <只含指纹的文件>\n",
    );
    process.exitCode = 1;
    return;
  }

  const expected = readExpectedFingerprint();
  const problems = collectSignerProblems({
    actualFingerprint: actual,
    expectedFingerprint: expected,
  });

  if (problems.length > 0) {
    process.stderr.write(`APK 签名校验未通过（${problems.length} 项）：\n`);
    for (const p of problems) process.stderr.write(`  ✗ ${p}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `APK 签名校验通过：证书 SHA-256 = ${normalizeFingerprint(actual)}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
