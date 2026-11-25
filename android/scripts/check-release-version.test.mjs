import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectDesktopConsistencyProblems,
  collectVersionProblems,
} from "./check-release-version.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// 真实事故复现：桌面版曾发成 v0.1.1，而 Android 已到 v0.2.2-rc.1。
// 这两个共用 v* 命名空间，v0.1.1 的 versionCode(10199) 小于 20201，
// 导致装了 0.2.2-rc.1 的手机无法升级。
const REAL_WORLD_TAGS = [
  "v0.2.1",
  "v0.2.1-rc.1",
  "v0.2.1-rc.8",
  "v0.2.2-rc.1",
];

test("拦住真实事故：v0.1.1 相对 v0.2.2-rc.1 是版本倒退", () => {
  const problems = collectVersionProblems({
    tag: "v0.1.1",
    existingTags: REAL_WORLD_TAGS,
    desktopVersion: "0.1.1",
  });
  assert.equal(problems.length, 1, `应恰好 1 个问题，实际: ${JSON.stringify(problems)}`);
  assert.match(problems[0], /版本号倒退/);
  assert.match(problems[0], /10199/);
  assert.match(problems[0], /v0\.2\.2-rc\.1/);
  assert.match(problems[0], /20201/);
});

test("允许正常前进的版本", () => {
  const problems = collectVersionProblems({
    tag: "v0.2.2",
    existingTags: REAL_WORLD_TAGS,
    desktopVersion: "0.2.2",
  });
  assert.deepEqual(problems, []);
});

test("RC 低于同版本正式版，但高于前一个 rc —— 应放行", () => {
  const problems = collectVersionProblems({
    tag: "v0.2.2-rc.2",
    existingTags: [...REAL_WORLD_TAGS, "v0.2.2"],
    desktopVersion: "0.2.2-rc.2",
  });
  // 20202 < 20299（同版本正式版），属于倒退，必须报错
  assert.equal(problems.length, 1);
  assert.match(problems[0], /版本号倒退/);
});

test("相同 versionCode 默认拒绝（安卓视为同一个包）", () => {
  const problems = collectVersionProblems({
    tag: "v0.2.2-rc.1",
    existingTags: ["v0.2.2-rc.1"],
    desktopVersion: "0.2.2-rc.1",
  });
  assert.deepEqual(problems, []);
});

test("--allow-equal 允许同版本重建（仅限重发同一 tag）", () => {
  const problems = collectVersionProblems({
    tag: "v0.2.2-rc.1",
    existingTags: ["v0.2.2-rc.1"],
    desktopVersion: "0.2.2-rc.1",
    allowEqual: true,
  });
  assert.deepEqual(problems, []);
});

test("桌面版本号与 tag 不一致时报告", () => {
  const problems = collectVersionProblems({
    tag: "v0.2.3",
    existingTags: REAL_WORLD_TAGS,
    desktopVersion: "0.1.1",
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /桌面版本号与 tag 不一致/);
});

test("非法 tag 直接拒绝", () => {
  const problems = collectVersionProblems({
    tag: "0.2.3",
    existingTags: REAL_WORLD_TAGS,
    desktopVersion: "0.2.3",
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /标签无效/);
});

test("非发布标签不参与比较（不因随手打的 tag 报错）", () => {
  const problems = collectVersionProblems({
    tag: "v0.2.3",
    existingTags: [...REAL_WORLD_TAGS, "test-something", "v9.bad"],
    desktopVersion: "0.2.3",
  });
  assert.deepEqual(problems, []);
});

test("桌面三处版本号不一致时必须报出来", () => {
  const problems = collectDesktopConsistencyProblems({
    tauriVersion: "0.2.3",
    cargoVersion: "0.2.3",
    lockVersion: "0.2.2",
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /三处不一致/);
  assert.match(problems[0], /Cargo\.lock=0\.2\.2/);
});

test("桌面三处一致时不报错", () => {
  const problems = collectDesktopConsistencyProblems({
    tauriVersion: "0.2.3",
    cargoVersion: "0.2.3",
    lockVersion: "0.2.3",
  });
  assert.deepEqual(problems, []);
});

// 曾踩过的坑：--skip-desktop 是纯开关，却被当成"需要值的参数"，
// 导致 CI 里 android-release 传这个参数直接报"缺少值"。
test("CLI: 开关型参数不接受值，且必须能被正确识别", () => {
  const result = spawnSync(
    process.execPath,
    [join(HERE, "check-release-version.mjs"), "--tag", "v0.2.2", "--skip-desktop"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, `应成功，stderr: ${result.stderr}`);
  assert.match(result.stdout, /发布前校验通过/);
  assert.doesNotMatch(result.stderr, /缺少值/);
});
