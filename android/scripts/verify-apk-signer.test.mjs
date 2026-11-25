import assert from "node:assert/strict";
import test from "node:test";

import {
  collectSignerProblems,
  extractCertSha256,
  normalizeFingerprint,
} from "./verify-apk-signer.mjs";

// 真实项目的证书指纹（公开信息，见 android/release-cert.sha256）
const REAL_CERT = "5f28d565443ff568531b3748e72f508a44cc8f34dc46176b9da5f289faa2ba78";

// apksigner verify --print-certs 的真实输出片段
const REAL_OUTPUT = `
Verifies
Verified using v1 scheme (JAR signing): false
Verified using v2 scheme (APK Signature Scheme v2): true
Number of signers: 1
Signer #1 certificate DN: CN=Melodex, OU=Release, O=Melodex, C=CN
Signer #1 certificate SHA-256 digest: 5f28d565443ff568531b3748e72f508a44cc8f34dc46176b9da5f289faa2ba78
Signer #1 certificate SHA-1 digest: e4e933d5358c0621f1dc683bb8b321371b918f69
Signer #1 public key SHA-256 digest: 9ea497f42c6c0dfc3cda09cbc8e3db4f9e318d1fcf5876963431396cc5b7a9a5
`;

test("从真实 apksigner 输出提取证书 SHA-256", () => {
  assert.equal(extractCertSha256(REAL_OUTPUT), REAL_CERT);
});

test("★ 不能误取公钥指纹（两者完全不同，混用会永远失败）", () => {
  const extracted = extractCertSha256(REAL_OUTPUT);
  const publicKeyFingerprint = "9ea497f42c6c0dfc3cda09cbc8e3db4f9e318d1fcf5876963431396cc5b7a9a5";
  assert.notEqual(extracted, publicKeyFingerprint);
  assert.equal(extracted, REAL_CERT);
});

test("指纹归一化：忽略冒号和大小写", () => {
  assert.equal(
    normalizeFingerprint("5F:28:D5:65:44:3F:F5:68:53:1B:37:48:E7:2F:50:8A:44:CC:8F:34:DC:46:17:6B:9D:A5:F2:89:FA:A2:BA:78"),
    REAL_CERT,
  );
});

test("指纹一致时通过", () => {
  const problems = collectSignerProblems({
    actualFingerprint: REAL_CERT,
    expectedFingerprint: REAL_CERT,
  });
  assert.deepEqual(problems, []);
});

test("带冒号大写形式的期望值也能匹配", () => {
  const problems = collectSignerProblems({
    actualFingerprint: REAL_CERT,
    expectedFingerprint:
      "5F:28:D5:65:44:3F:F5:68:53:1B:37:48:E7:2F:50:8A:44:CC:8F:34:DC:46:17:6B:9D:A5:F2:89:FA:A2:BA:78",
  });
  assert.deepEqual(problems, []);
});

test("★ 核心用例：keystore 配错导致证书不同，必须被抓住", () => {
  const wrongKey = "1111222233334444555566667777888899990000111122223333444455556666";
  const problems = collectSignerProblems({
    actualFingerprint: wrongKey,
    expectedFingerprint: REAL_CERT,
  });
  assert.equal(problems.length, 1, `应恰好 1 个问题，实际: ${JSON.stringify(problems)}`);
  assert.match(problems[0], /签名证书不一致/);
  assert.match(problems[0], /无法覆盖升级/);
  assert.match(problems[0], /ANDROID_KEYSTORE_BASE64/);
});

test("无法提取指纹时报错（不能让解析失败静默通过）", () => {
  const problems = collectSignerProblems({
    actualFingerprint: extractCertSha256("没有指纹的输出"),
    expectedFingerprint: REAL_CERT,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /无法从 apksigner/);
});

test("缺期望指纹时报错并给出修复指引", () => {
  const problems = collectSignerProblems({
    actualFingerprint: REAL_CERT,
    expectedFingerprint: "",
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /缺少期望的证书指纹/);
  assert.match(problems[0], /release-cert\.sha256/);
});
