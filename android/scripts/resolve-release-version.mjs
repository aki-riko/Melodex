import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const NUMBER_PATTERN = "(0|[1-9]\\d*)";
const TAG_PATTERN = new RegExp(`^v${NUMBER_PATTERN}\\.${NUMBER_PATTERN}\\.${NUMBER_PATTERN}(?:-rc\\.${NUMBER_PATTERN})?$`);
const MAX_ANDROID_VERSION_CODE = 2_100_000_000;

export function resolveReleaseVersion(tag) {
  const match = TAG_PATTERN.exec(String(tag ?? "").trim());
  if (!match) {
    throw new Error(`无效Android发布标签: ${tag}`);
  }

  const [, majorText, minorText, patchText, rcText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  const rc = rcText === undefined ? null : Number(rcText);
  if (minor > 99 || patch > 99) {
    throw new Error("minor和patch必须在0到99之间");
  }
  if (rc !== null && (rc < 1 || rc > 98)) {
    throw new Error("RC序号必须在1到98之间");
  }

  const channel = rc ?? 99;
  const versionCode = major * 1_000_000 + minor * 10_000 + patch * 100 + channel;
  if (!Number.isSafeInteger(versionCode) || versionCode > MAX_ANDROID_VERSION_CODE) {
    throw new Error(`versionCode超出Android上限: ${versionCode}`);
  }

  return {
    versionName: tag.slice(1),
    versionCode,
    prerelease: rc !== null,
  };
}

function main() {
  const resolved = resolveReleaseVersion(process.argv[2]);
  const output = {
    version_name: resolved.versionName,
    version_code: String(resolved.versionCode),
    prerelease: String(resolved.prerelease),
  };
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(output).map(([key, value]) => `${key}=${value}\n`).join(""),
      "utf8",
    );
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
