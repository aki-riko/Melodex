#!/usr/bin/env node
// 验证 Tauri 更新产物：.sig 必须由 tauri.conf.json 里那把公钥对应的私钥签出，
// 且 .sig 内记录的文件名必须与安装包一致。
//
// 为什么需要这道门禁（真实风险）：
//   私钥配错（比如 secrets 填成旧机器的密钥）时，**签名照样能生成**，
//   但客户端验签失败 → 用户永远装不上更新，而且要到发布之后才发现。
//
// 原理：minisign 格式里，公钥和签名都内嵌 8 字节 keyID。两者不一致就说明
// 私钥与公钥不配对。这是不需要实际执行 Ed25519 验签也能可靠检出的判据。
//
// ★ 踩过的坑：`tauri signer` 子命令只有 sign/generate，**没有 verify**。
//   最初想调用官方验签，实测不存在，改为直接解析 minisign 结构比对 keyID。
//
// 用法：
//   node desktop/scripts/verify-updater-artifact.mjs --exe <安装包路径>
//
// 退出码：0 = 通过；1 = 有问题

import { readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CONF_PATH = resolve(REPO_ROOT, "desktop/src-tauri/tauri.conf.json");

/** minisign 公钥：2 字节算法标识 + 8 字节 keyID + 32 字节 Ed25519 公钥 */
export function parseMinisignPublicKey(encoded) {
  const lines = Buffer.from(String(encoded || "").trim(), "base64")
    .toString("utf8")
    .split(/\r?\n/)
    .filter((l) => l.length > 0);
  if (lines.length < 2) throw new Error("公钥结构不完整");
  const raw = Buffer.from(lines[1].trim(), "base64");
  if (raw.length !== 42) throw new Error(`公钥长度应为 42 字节，实际 ${raw.length}`);
  const algo = raw.subarray(0, 2).toString("utf8");
  if (algo !== "Ed") throw new Error(`公钥算法应为 Ed，实际 ${JSON.stringify(algo)}`);
  // keyID 在文件里是小端存放，显示时反转（与注释里的 16 位大写 hex 一致）
  const keyId = Buffer.from(raw.subarray(2, 10)).reverse().toString("hex").toUpperCase();
  return { algo, keyId, comment: lines[0] };
}

/** minisign 签名：2 字节算法 + 8 字节 keyID + 64 字节签名，另带 trusted comment */
export function parseMinisignSignature(encoded) {
  const lines = Buffer.from(String(encoded || "").trim(), "base64")
    .toString("utf8")
    .split(/\r?\n/)
    .filter((l) => l.length > 0);
  if (lines.length < 4) throw new Error(`签名结构不完整（${lines.length} 行，期望 4 行）`);

  const raw = Buffer.from(lines[1].trim(), "base64");
  if (raw.length !== 74) throw new Error(`签名长度应为 74 字节，实际 ${raw.length}`);
  const algo = raw.subarray(0, 2).toString("utf8");
  if (algo !== "ED") throw new Error(`签名算法应为 ED，实际 ${JSON.stringify(algo)}`);
  const keyId = Buffer.from(raw.subarray(2, 10)).reverse().toString("hex").toUpperCase();

  // trusted comment 形如：
  //   trusted comment: timestamp:1795631971	file:Melodex_0.1.1_x64-setup.exe
  const trusted = lines[2];
  const fileMatch = /file:([^\s]+)/.exec(trusted);
  const tsMatch = /timestamp:(\d+)/.exec(trusted);

  return {
    algo,
    keyId,
    fileInSignature: fileMatch ? fileMatch[1] : null,
    timestamp: tsMatch ? Number(tsMatch[1]) : null,
  };
}

/**
 * 纯函数核心：给定签名内容、产物名、公钥，返回问题清单。便于单测。
 */
export function collectArtifactProblems({ sigBase64, exeName, pubkey }) {
  const problems = [];

  if (!pubkey) {
    problems.push("tauri.conf.json 缺少 plugins.updater.pubkey");
    return problems;
  }

  let sig;
  try {
    sig = parseMinisignSignature(sigBase64);
  } catch (error) {
    return [`签名解析失败：${error instanceof Error ? error.message : String(error)}`];
  }

  let pub;
  try {
    pub = parseMinisignPublicKey(pubkey);
  } catch (error) {
    return [`公钥解析失败：${error instanceof Error ? error.message : String(error)}`];
  }

  // 最关键的一条：keyID 不匹配 = 私钥配错，客户端必然验签失败
  if (sig.keyId !== pub.keyId) {
    problems.push(
      `私钥与公钥不配对：签名 keyID=${sig.keyId}，公钥 keyID=${pub.keyId}。` +
        `客户端会拒绝安装这个更新，用户永远收不到升级。请检查 TAURI_SIGNING_PRIVATE_KEY 是否指向正确密钥。`,
    );
  }

  // .sig 内记录了被签名文件名，与实际产物不符说明拿错了产物
  if (!sig.fileInSignature) {
    problems.push("签名里没有 file: 字段，无法核对被签名的文件");
  } else if (sig.fileInSignature !== exeName) {
    problems.push(
      `签名与产物不匹配：签名记录的文件是 ${sig.fileInSignature}，实际是 ${exeName}`,
    );
  }

  // 时间戳异常（未来的时间说明签名文件来路不明）
  if (sig.timestamp !== null) {
    const signedAt = new Date(sig.timestamp * 1000);
    const now = Date.now();
    if (signedAt.getTime() > now + 24 * 3600 * 1000) {
      problems.push(`签名时间戳在未来（${signedAt.toISOString()}），签名文件可疑`);
    }
  }

  return problems;
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
  if (!args.exe) {
    process.stderr.write(
      "用法: node desktop/scripts/verify-updater-artifact.mjs --exe <安装包>\n",
    );
    process.exitCode = 1;
    return;
  }

  const exePath = resolve(args.exe);
  const exeName = basename(exePath);
  const problems = [];

  let size = 0;
  try {
    size = statSync(exePath).size;
  } catch {
    process.stderr.write(`产物不存在: ${exePath}\n`);
    process.exitCode = 1;
    return;
  }
  if (size === 0) problems.push(`产物为空文件: ${exeName}`);
  // NSIS 安装包 3MB 上下；小于 100KB 说明构建没真正产出
  if (size < 100 * 1024) problems.push(`产物过小（${size} 字节），不像是完整安装包`);

  let sigBase64 = "";
  try {
    sigBase64 = readFileSync(`${exePath}.sig`, "utf8");
  } catch {
    problems.push(`缺少签名文件: ${exeName}.sig`);
  }

  if (sigBase64) {
    const conf = JSON.parse(readFileSync(CONF_PATH, "utf8"));
    const pubkey = conf?.plugins?.updater?.pubkey ?? "";
    problems.push(...collectArtifactProblems({ sigBase64, exeName, pubkey }));
  }

  if (problems.length > 0) {
    process.stderr.write(`更新产物校验未通过（${problems.length} 项）：\n`);
    for (const p of problems) process.stderr.write(`  ✗ ${p}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `更新产物校验通过：${exeName}（${size} 字节），签名与公钥 keyID 配对、文件名一致\n`,
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
