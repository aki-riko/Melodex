/**
 * Melodex 品牌图标生成器 —— 单一矢量为源,派生全部平台产物。
 *
 * 用法(frontend 目录):
 *   node scripts/build-icons.mjs           写文件
 *   node scripts/build-icons.mjs --check   只校验产物是否与源一致(CI/门禁用)
 *
 * 为什么要有这个脚本(而不是各处手放 PNG):
 *   图标此前是"哪个平台缺了就单独塞一张",于是 Android 的 ic_melodex.xml 停在
 *   2026-06 的旧版(绿圆+深色音符),Web 是另一套,桌面又是第三套。每次改品牌
 *   都得人工找齐五六个地方重画 —— 必然漏。这里把图形唯一定义在 ICON 常量里,
 *   其余产物一律由它渲染。
 *
 * 产物清单:
 *   public/icon.svg              圆角版(浏览器 favicon / og:image 源)
 *   public/icon-maskable.svg     满底 + 主体缩进安全区(Android 可用它做 maskable)
 *   public/logo192.png           PWA 192
 *   public/logo512.png           PWA 512
 *   public/maskable512.png       PWA maskable 512
 *   public/favicon-32.png        32 像素 favicon
 *   ../android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml   自适应图标
 *   ../android/app/src/main/res/drawable/ic_launcher_foreground.xml  前景矢量
 *   ../android/app/src/main/res/values/ic_launcher_background.xml    背景色
 *   ../android/app/src/main/res/mipmap-<density>/ic_launcher.png   旧版本(API<26)位图回退
 *   ../desktop/src-tauri/icons/icon-{32,128,256}.png + icon.ico
 *
 * 图形设计要点(改之前读一遍,别把好不容易修好的地方改回去):
 *   - 图形本身(折纸播放)在 scripts/icon-glyph.mjs,是唯一矢量源;
 *     这里只负责缩放、居中、裁边、派生各平台格式。
 *   - 纸面就是底板:圆角版的纸面铺满 512 画布,maskable/自适应版纸面满底,
 *     三角和折线一起收进安全区(SAFE_SCALE),折线仍画到画布边缘。
 *   - 三角按外框居中(中心 = 画布中心),不是按重心居中 —— 用户要求"完全居中"。
 *   - 纯色填充,不用渐变、阴影、滤镜。若以后要加渐变:必须 gradientUnits="userSpaceOnUse",
 *     默认的 objectBoundingBox 在竖直线段上包围盒宽度为 0,整条线不渲染(踩过两次)。
 *   - 主体必须落在 maskable 安全圆(r = 40% 边长)以内,否则被系统裁圆角切边。
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLORS, CORNER, LINES, LINE_WIDTH, PLAY } from './icon-glyph.mjs';

const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'));
const sharp = require('sharp');

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, '..');
const ROOT = resolve(FRONTEND, '..');
const PUBLIC = resolve(FRONTEND, 'public');
const ANDROID_RES = resolve(ROOT, 'android/app/src/main/res');
const TAURI_ICONS = resolve(ROOT, 'desktop/src-tauri/icons');

const CHECK = process.argv.includes('--check');

/** 底板就是纸面颜色:位图压底色、Android 自适应背景都用它。 */
const BASE = COLORS.paper;

/** 512 视图下的几何:纸面铺满画布,三角外框中心 = 画布中心。 */
const S = 512;
const R = CORNER * S;
const fmt = (v) => (Math.round(v * 100) / 100).toString();

/**
 * 三角与三条折线(不含纸面)。k 为绕画布中心的缩放:圆角版 1,maskable/自适应版 SAFE_SCALE。
 * 折线从顶点出发,按方向一直画到画布边缘(射线与 [0,512] 方框求交),
 * 圆角版再由纸面 clipPath 裁掉圆角外的部分。三角最后画,盖住折线起点。
 */
function playParts(k) {
  const w = PLAY.width * S * k, h = PLAY.height * S * k, c = S / 2;
  const v = {
    topLeft: [c - w / 2, c - h / 2],
    right: [c + w / 2, c],
    bottomLeft: [c - w / 2, c + h / 2],
  };
  const lines = LINES.map(({ from, dir }) => {
    const [px, py] = v[from];
    const len = Math.hypot(dir[0], dir[1]);
    const [ux, uy] = [dir[0] / len, dir[1] / len];
    // 射线 p + t·u 走出 [0,S]×[0,S] 时的 t
    const tx = ux > 0 ? (S - px) / ux : ux < 0 ? -px / ux : Infinity;
    const ty = uy > 0 ? (S - py) / uy : uy < 0 ? -py / uy : Infinity;
    const t = Math.min(tx, ty);
    return [[px, py], [px + ux * t, py + uy * t]];
  });
  const tri = [v.topLeft, v.right, v.bottomLeft];
  return { lines, tri, lineWidth: LINE_WIDTH * S };
}

/** 安全区缩放:maskable/自适应图标把三角和折线收到中心 72%。 */
const SAFE_SCALE = 0.72;

/** 折线与三角的 SVG 片段。 */
function playSvg(k) {
  const { lines, tri, lineWidth } = playParts(k);
  const seg = ([a, b]) => `<path d="M${fmt(a[0])} ${fmt(a[1])}L${fmt(b[0])} ${fmt(b[1])}"/>`;
  return `<g stroke="${COLORS.line}" stroke-width="${fmt(lineWidth)}">
    ${lines.map(seg).join('\n    ')}
  </g>
  <path d="M${tri.map((p) => `${fmt(p[0])} ${fmt(p[1])}`).join('L')}Z" fill="${COLORS.play}"/>`;
}

/** 圆角版(Web favicon / 桌面):纸面就是整块圆角方块,折线被圆角裁掉。 */
function roundedSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs><clipPath id="paper"><rect width="512" height="512" rx="${fmt(R)}"/></clipPath></defs>
  <g clip-path="url(#paper)">
  <rect width="512" height="512" fill="${COLORS.paper}"/>
  ${playSvg(1)}
  </g>
</svg>
`;
}

/** 满底版 —— 给 maskable 用,三角与折线收进安全区,折线仍画到边缘。 */
function maskableSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${COLORS.paper}"/>
  ${playSvg(SAFE_SCALE)}
</svg>
`;
}

/** 只有图形、没有底 —— Android 自适应图标的前景矢量(手动维护,见 androidGlyphVector)。 */
const FILES = new Map();

function put(path, content) {
  FILES.set(path, content);
}

/**
 * 渲染 PNG。
 * 每个尺寸都直接从矢量光栅化,不是先画 512 再缩小;用高 density 让 16/24px 也有干净的抗锯齿。
 * 不再分小尺寸档:图形只有一个大三角,小尺寸照样清楚;折线在 ≤64px 时不足 1px,
 * 自然淡到看不见,这是可接受的(主体是三角)。
 */
async function renderPng(svg, size, { background = null } = {}) {
  const img = sharp(Buffer.from(svg), { density: 900 });
  if (background) {
    // 有底色的位图不能要透明边,否则 Windows/mac 任务栏会露出灰边
    return img
      .resize(size, size, { fit: 'contain', background })
      .flatten({ background })
      .png({ compressionLevel: 9 })
      .toBuffer();
  }
  return img
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** 完整图标 SVG。size 参数保留给调用处标注用途,各尺寸用同一份矢量。 */
function iconSvgFor(size, colors = {}) {
  return colors.maskable ? maskableSvg() : roundedSvg();
}

/**
 * ICO 容器(Windows 桌面图标)。
 * sharp 不产 .ico,这里按 ICO 目录格式手工封装多张 PNG。
 * 每张都当"独立 PNG 条目"(ImageType 2),Vista 起广泛支持。
 * 每个尺寸各自从矢量光栅化 —— 用一张 256 缩到 16 会糊。
 */
async function buildIco(sizes) {
  const pngs = [];
  for (const s of sizes) {
    pngs.push({
      size: s,
      data: await renderPng(iconSvgFor(s), s, { background: BASE }),
    });
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(pngs.length, 4);

  const directory = Buffer.alloc(16 * pngs.length);
  let offset = 6 + 16 * pngs.length;
  pngs.forEach((entry, i) => {
    const at = i * 16;
    // 256 在 ICO 里用 0 表示
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 0);
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 1);
    directory.writeUInt8(0, at + 2); // 调色板数
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // color planes
    directory.writeUInt16LE(32, at + 6); // bpp
    directory.writeUInt32LE(entry.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.data.length;
  });

  return Buffer.concat([header, directory, ...pngs.map((p) => p.data)]);
}

/**
 * Android 自适应图标(API 26+)。
 * 前景由 ic_launcher_foreground.xml 提供(已缩进安全区),背景是纯色。
 * 暂不放 <monochrome>(Android 13 主题图标):需要单独确认在系统取色下的观感,
 * 这次只换图形,不扩大范围。
 */
function androidAdaptiveXml() {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- 由 frontend/scripts/build-icons.mjs 生成,勿手改。 -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
`;
}

/**
 * Android 矢量图(前景层)。背景层是纸面纯色(ic_launcher_background)。
 * 与 maskable 版同一套几何:三角收进 SAFE_SCALE,折线画到画布边缘
 * (自适应图标外圈本来就会被系统按启动器形状裁掉,折线跟着纸面一起被裁,观感一致)。
 * 安全区核对:离中心最远的是三角两个左侧顶点,512 视图里半径 = hypot(w/2, h/2)×0.72 ≈ 119.6,
 * 小于 66dp/108dp 安全圆半径 156.4。改三角尺寸后要重算。
 */
function androidGlyphVector() {
  const { lines, tri, lineWidth } = playParts(SAFE_SCALE);
  const p = (pt) => `${fmt(pt[0])} ${fmt(pt[1])}`;
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- 由 frontend/scripts/build-icons.mjs 生成,勿手改。 -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="512"
    android:viewportHeight="512">
${lines.map(([a, b]) => `    <path android:strokeColor="${COLORS.line}" android:strokeWidth="${fmt(lineWidth)}" android:pathData="M${p(a)}L${p(b)}" />`).join('\n')}
    <path android:fillColor="${COLORS.play}" android:pathData="M${tri.map(p).join('L')}Z" />
</vector>
`;
}

/**
 * 旧清单引用的 drawable/ic_melodex.xml —— 带底色,单文件即可显示。
 * 清单现在指向 @mipmap/ic_launcher(自适应图标),这个文件已删除:
 * 留着同一图形两份必然分叉,正是这次重画要消灭的问题。
 */

async function main() {
  // ---- Web / PWA ----
  // 矢量源会在各尺寸被浏览器重新栅格化,favicon 由 PNG 兜底。
  put(resolve(PUBLIC, 'icon.svg'), roundedSvg());
  put(resolve(PUBLIC, 'icon-maskable.svg'), maskableSvg());

  put(resolve(PUBLIC, 'logo512.png'), await renderPng(iconSvgFor(512), 512));
  put(resolve(PUBLIC, 'logo192.png'), await renderPng(iconSvgFor(192), 192));
  put(resolve(PUBLIC, 'maskable512.png'), await renderPng(iconSvgFor(512, { maskable: true }), 512));
  put(resolve(PUBLIC, 'favicon-32.png'), await renderPng(iconSvgFor(32), 32));

  // ---- Android ----
  const DPPI = [
    ['mdpi', 48],
    ['hdpi', 72],
    ['xhdpi', 96],
    ['xxhdpi', 144],
    ['xxxhdpi', 192],
  ];
  for (const [bucket, size] of DPPI) {
    put(
      resolve(ANDROID_RES, `mipmap-${bucket}/ic_launcher.png`),
      await renderPng(iconSvgFor(size), size)
    );
    put(
      resolve(ANDROID_RES, `mipmap-${bucket}/ic_launcher_round.png`),
      await renderPng(iconSvgFor(size, { maskable: true }), size)
    );
  }
  put(resolve(ANDROID_RES, 'mipmap-anydpi-v26/ic_launcher.xml'), androidAdaptiveXml());
  put(resolve(ANDROID_RES, 'mipmap-anydpi-v26/ic_launcher_round.xml'), androidAdaptiveXml());
  put(resolve(ANDROID_RES, 'drawable/ic_launcher_foreground.xml'), androidGlyphVector());
  put(
    resolve(ANDROID_RES, 'values/ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- 由 frontend/scripts/build-icons.mjs 生成,勿手改。-->
    <color name="ic_launcher_background">${BASE}</color>
</resources>
`
  );

  // ---- 桌面(Tauri) ----
  put(resolve(TAURI_ICONS, 'icon-32.png'), await renderPng(iconSvgFor(32), 32));
  put(resolve(TAURI_ICONS, 'icon-128.png'), await renderPng(iconSvgFor(128), 128));
  put(resolve(TAURI_ICONS, 'icon-256.png'), await renderPng(iconSvgFor(256), 256));
  // ICO 每个尺寸单独从矢量光栅化,不能整体用一张大图缩
  put(resolve(TAURI_ICONS, 'icon.ico'), await buildIco([16, 24, 32, 48, 64, 128, 256]));

  // ---- 落盘 / 校验 ----
  const written = [];
  const mismatched = [];
  const missing = [];

  for (const [path, content] of FILES) {
    if (typeof content === 'string') {
      if (CHECK) {
        const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
        if (current === null) missing.push(path);
        else if (current !== content) mismatched.push(path);
      } else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
        written.push(path);
      }
    } else {
      // 二进制:逐字节比对
      if (CHECK) {
        const current = existsSync(path) ? readFileSync(path) : null;
        if (current === null) missing.push(path);
        else if (!current.equals(content)) mismatched.push(path);
      } else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
        written.push(path);
      }
    }
  }

  const rel = (p) => p.slice(ROOT.length + 1).replace(/\\/g, '/');

  if (CHECK) {
    if (missing.length === 0 && mismatched.length === 0) {
      console.log(`icons: ${FILES.size} 个产物与源一致`);
      return;
    }
    for (const p of missing) console.error(`缺失: ${rel(p)}`);
    for (const p of mismatched) console.error(`与源不一致(请跑 node scripts/build-icons.mjs): ${rel(p)}`);
    process.exitCode = 1;
    return;
  }

  console.log(`icons: 已写入 ${written.length} 个文件`);
  for (const p of written) console.log(`  ${rel(p)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
