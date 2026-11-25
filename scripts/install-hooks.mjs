#!/usr/bin/env node
// 安装仓库自带的 git hooks（git 默认不启用自定义 hooks 目录，每台机器要跑一次）。
//
// 用法：node scripts/install-hooks.mjs
//   或 npm run hooks:install

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const HOOKS_DIR = ".githooks";

function main() {
  if (!existsSync(resolve(REPO_ROOT, HOOKS_DIR))) {
    process.stderr.write(`找不到 ${HOOKS_DIR} 目录\n`);
    process.exitCode = 1;
    return;
  }

  try {
    execFileSync("git", ["config", "core.hooksPath", HOOKS_DIR], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
  } catch (error) {
    process.stderr.write(`设置 core.hooksPath 失败：${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  const current = execFileSync("git", ["config", "--get", "core.hooksPath"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();

  // 确认 pre-push 真的可读
  const prePush = resolve(REPO_ROOT, HOOKS_DIR, "pre-push");
  const present = existsSync(prePush);
  const size = present ? statSync(prePush).size : 0;

  process.stdout.write(`core.hooksPath = ${current}\n`);
  process.stdout.write(
    present
      ? `pre-push hook 已就位（${size} 字节）\n`
      : "警告：pre-push hook 文件不存在\n",
  );
  process.stdout.write(
    "\n它会在推送 v* tag 时检查版本号是否倒退。\n" +
      "绕过方式（仅在补发历史 tag 时使用）：git push --no-verify\n",
  );

  if (!present) process.exitCode = 1;
}

main();
