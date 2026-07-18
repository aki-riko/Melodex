import assert from "node:assert/strict";
import test from "node:test";

import { resolveReleaseVersion } from "./resolve-release-version.mjs";

test("正式标签生成稳定versionCode", () => {
  assert.deepEqual(resolveReleaseVersion("v0.2.1"), {
    versionName: "0.2.1",
    versionCode: 20_199,
    prerelease: false,
  });
});

test("RC标签的versionCode低于同版本正式版", () => {
  const rc = resolveReleaseVersion("v1.4.3-rc.7");
  const stable = resolveReleaseVersion("v1.4.3");
  assert.equal(rc.versionName, "1.4.3-rc.7");
  assert.equal(rc.versionCode, 1_040_307);
  assert.equal(rc.prerelease, true);
  assert.ok(rc.versionCode < stable.versionCode);
});

test("拒绝非发布标签和越界版本", () => {
  assert.throws(() => resolveReleaseVersion("0.2.1"), /无效Android发布标签/);
  assert.throws(() => resolveReleaseVersion("v0.02.1"), /无效Android发布标签/);
  assert.throws(() => resolveReleaseVersion("v0.2.1-rc.01"), /无效Android发布标签/);
  assert.throws(() => resolveReleaseVersion("v0.2.1-beta.1"), /无效Android发布标签/);
  assert.throws(() => resolveReleaseVersion("v0.100.0"), /minor和patch/);
  assert.throws(() => resolveReleaseVersion("v0.2.1-rc.99"), /RC序号/);
  assert.throws(() => resolveReleaseVersion("v2100.0.0"), /Android上限/);
});
