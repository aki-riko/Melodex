// 对比「从 256 缩到 16」与「从 16 放大回 16」的观感差异，
// 用于验证「去掉 ICO 小尺寸档」能否改善桌面临标栏的清晰度。
//
// 用法（frontend 目录，借用其中的 sharp 依赖）：
//   node ../desktop/prototype/scripts/compare-icon-scaling.mjs
//
// 输出到系统临时目录，仅供目视对比，不写入仓库。

import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const require = createRequire(join(ROOT, 'frontend', 'package.json'));
const sharp = require('sharp');

const SRC = join(ROOT, 'desktop', 'src-tauri', 'icons', 'icon-256.png');
const OUT = join(tmpdir(), 'melodex-icon-compare');

/**
 * 把一个 buffer 规格化成 cell 大小的「像素放大」图，方便肉眼看清。
 */
const blowUp = async (buffer, cell) =>
  sharp(buffer).resize(cell, cell, { kernel: 'nearest' }).png().toBuffer();

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  const SCALE = 12;
  const CELL = 16 * SCALE;

  // 假设：Windows 在 150% DPI 下标题栏约 24px。
  // A 路线（推荐）：从 32px 高质量缩小到 24
  // B 路线（现状）：从 ICO 的 16px 档放大到 24
  const from32 = await sharp(SRC)
    .resize(32, 32, { kernel: 'lanczos3' })
    .png()
    .toBuffer();
  const small16 = await sharp(SRC).resize(16, 16, { kernel: 'lanczos3' }).png().toBuffer();

  const routeA = await sharp(from32)
    .resize(24, 24, { kernel: 'lanczos3' })
    .png()
    .toBuffer();
  const routeB = await sharp(small16)
    .resize(24, 24, { kernel: 'lanczos3' })
    .png()
    .toBuffer();

  // 另外给一个「从 256 直缩到 24」作参照
  const routeC = await sharp(SRC)
    .resize(24, 24, { kernel: 'lanczos3' })
    .png()
    .toBuffer();

  const a = await blowUp(routeA, CELL);
  const b = await blowUp(routeB, CELL);
  const c = await blowUp(routeC, CELL);

  const gap = 16;
  const width = CELL * 3 + gap * 2;
  const file = join(OUT, 'compare.png');
  await sharp({
    create: {
      width,
      height: CELL,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([
      { input: a, left: 0, top: 0 },
      { input: b, left: CELL + gap, top: 0 },
      { input: c, left: (CELL + gap) * 2, top: 0 },
    ])
    .png()
    .toFile(file);

  console.log(`对比图: ${file}`);
  console.log('左  = 从 32px 缩到 24px（去掉 ICO 小档后 Windows 会这么做）');
  console.log('中  = 从 16px 放大到 24px（现状：ICO 有 16px 档）');
  console.log('右  = 从 256px 直缩到 24px（理论上最佳）');
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
