import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectArtifactProblems,
  parseMinisignPublicKey,
  parseMinisignSignature,
} from "./verify-updater-artifact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

// 用仓库里真实的公钥做基线（这是公开信息，写在 tauri.conf.json 里）
const REAL_PUBKEY = JSON.parse(
  readFileSync(resolve(REPO_ROOT, "desktop/src-tauri/tauri.conf.json"), "utf8"),
).plugins.updater.pubkey;

/** 构造一个合法的 minisign 签名（不需要真实私钥，只为测解析与比对逻辑）。 */
function makeSignature({ keyIdHex, filename, timestamp = 1795631971 }) {
  // 2 字节算法 + 8 字节 keyID(小端) + 64 字节签名
  const raw = Buffer.alloc(74);
  raw.write("ED", 0, "utf8");
  Buffer.from(keyIdHex, "hex").reverse().copy(raw, 2);
  for (let i = 10; i < 74; i += 1) raw[i] = i;

  const trusted = `trusted comment: timestamp:${timestamp}\tfile:${filename}`;
  const globalSig = Buffer.alloc(64, 7).toString("base64");
  const plain = [
    "untrusted comment: signature from tauri secret key",
    raw.toString("base64"),
    trusted,
    globalSig,
  ].join("\n");
  return Buffer.from(plain, "utf8").toString("base64");
}

test("解析真实公钥：算法 Ed、keyID 与注释一致", () => {
  const parsed = parseMinisignPublicKey(REAL_PUBKEY);
  assert.equal(parsed.algo, "Ed");
  assert.match(parsed.comment, /minisign public key:/);
  // keyID 必须与注释里的 16 位 hex 一致
  assert.ok(
    parsed.comment.includes(parsed.keyId),
    `keyID ${parsed.keyId} 应出现在注释 "${parsed.comment}" 中`,
  );
});

test("解析签名：取出 keyID / 文件名 / 时间戳", () => {
  const sig = makeSignature({
    keyIdHex: "80BC0F8ECBCE4233",
    filename: "Melodex_0.2.2_x64-setup.exe",
  });
  const parsed = parseMinisignSignature(sig);
  assert.equal(parsed.algo, "ED");
  assert.equal(parsed.keyId, "80BC0F8ECBCE4233");
  assert.equal(parsed.fileInSignature, "Melodex_0.2.2_x64-setup.exe");
  assert.equal(parsed.timestamp, 1795631971);
});

test("★ 核心用例：私钥配错（keyID 不符）必须被抓住", () => {
  // 用另一把密钥的 keyID 伪造签名
  const wrongSig = makeSignature({
    keyIdHex: "1111222233334444",
    filename: "Melodex_0.2.2_x64-setup.exe",
  });
  const problems = collectArtifactProblems({
    sigBase64: wrongSig,
    exeName: "Melodex_0.2.2_x64-setup.exe",
    pubkey: REAL_PUBKEY,
  });
  assert.equal(problems.length, 1, `应恰好 1 个问题，实际: ${JSON.stringify(problems)}`);
  assert.match(problems[0], /私钥与公钥不配对/);
  assert.match(problems[0], /1111222233334444/);
});

test("签名文件名与产物不符时必须报错", () => {
  const sig = makeSignature({
    keyIdHex: "80BC0F8ECBCE4233",
    filename: "Melodex_0.1.0_x64-setup.exe", // 错版本
  });
  const problems = collectArtifactProblems({
    sigBase64: sig,
    exeName: "Melodex_0.2.2_x64-setup.exe",
    pubkey: REAL_PUBKEY,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /签名与产物不匹配/);
  assert.match(problems[0], /0\.1\.0/);
});

test("签名与公钥配对、文件名一致时通过", () => {
  const sig = makeSignature({
    keyIdHex: "80BC0F8ECBCE4233",
    filename: "Melodex_0.2.2_x64-setup.exe",
  });
  const problems = collectArtifactProblems({
    sigBase64: sig,
    exeName: "Melodex_0.2.2_x64-setup.exe",
    pubkey: REAL_PUBKEY,
  });
  assert.deepEqual(problems, []);
});

test("缺公钥时报错（配置损坏不能静默放行）", () => {
  const sig = makeSignature({
    keyIdHex: "80BC0F8ECBCE4233",
    filename: "Melodex_0.2.2_x64-setup.exe",
  });
  const problems = collectArtifactProblems({
    sigBase64: sig,
    exeName: "Melodex_0.2.2_x64-setup.exe",
    pubkey: "",
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /缺少.*pubkey/);
});

test("签名结构损坏时报错而不是崩溃", () => {
  const problems = collectArtifactProblems({
    sigBase64: Buffer.from("too short", "utf8").toString("base64"),
    exeName: "Melodex_0.2.2_x64-setup.exe",
    pubkey: REAL_PUBKEY,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /签名解析失败/);
});

test("签名时间戳在未来时告警", () => {
  const future = Math.floor(Date.now() / 1000) + 86400 * 30;
  const sig = makeSignature({
    keyIdHex: "80BC0F8ECBCE4233",
    filename: "Melodex_0.2.2_x64-setup.exe",
    timestamp: future,
  });
  const problems = collectArtifactProblems({
    sigBase64: sig,
    exeName: "Melodex_0.2.2_x64-setup.exe",
    pubkey: REAL_PUBKEY,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /时间戳在未来/);
});
