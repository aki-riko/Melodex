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
 *   - 图形本身(五根柱子 + 飘带)在 scripts/icon-glyph.mjs,是唯一矢量源;
 *     这里只负责缩放、居中、加底、派生各平台格式。
 *   - 纯色填充,不用渐变。若以后要加渐变:必须 gradientUnits="userSpaceOnUse",
 *     默认的 objectBoundingBox 在竖直线段上包围盒宽度为 0,整条线不渲染(踩过两次)。
 *   - 主体必须落在 maskable 安全圆(r = 40% 边长)以内,否则被系统裁圆角切边。
 *   - 小尺寸(≤48px)把图形放大到底板宽度的 80%,不加描边。实测(nearest 放大逐像素看):
 *     按 66% 缩到 16px 柱子只剩 1~2px,描边加粗又会把柱间缝隙填死,放大占比两边都不伤。
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLYPH_BOX, GLYPH_COLOR, GLYPH_PATHS } from './icon-glyph.mjs';

const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'));
const sharp = require('sharp');

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, '..');
const ROOT = resolve(FRONTEND, '..');
const PUBLIC = resolve(FRONTEND, 'public');
const ANDROID_RES = resolve(ROOT, 'android/app/src/main/res');
const TAURI_ICONS = resolve(ROOT, 'desktop/src-tauri/icons');

const CHECK = process.argv.includes('--check');

/** 底板为白色,图形为品牌紫(GLYPH_COLOR),与用户提供的原图一致。 */
const BASE = '#FFFFFF';

/**
 * 图形在 512 底板上的宽度占比。图形外框 975×765(见 GLYPH_BOX),
 * 0.66 时外框约 338×265,四周留白均匀;小尺寸改 0.80,原因见文件头。
 */
const FILL_STANDARD = 0.66;
const FILL_SMALL = 0.8;

/** 把 2000 坐标系的图形缩放并居中到 512 视图的变换参数(SVG 与 VectorDrawable 共用)。 */
function glyphTransform(fill) {
  const scale = (512 * fill) / GLYPH_BOX.width;
  const cx = GLYPH_BOX.x + GLYPH_BOX.width / 2;
  const cy = GLYPH_BOX.y + GLYPH_BOX.height / 2;
  return { scale, tx: 256 - cx * scale, ty: 256 - cy * scale };
}

function glyph(fill) {
  const { scale, tx, ty } = glyphTransform(fill);
  return `
    <g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${scale.toFixed(6)})" fill="${GLYPH_COLOR}">
${GLYPH_PATHS.map((d) => `      <path d="${d}"/>`).join('\n')}
    </g>`;
}

/** 常规档:≥64px 的产物。 */
const GLYPH = glyph(FILL_STANDARD);

/** 小尺寸档:≤48px 的产物(原理见文件头)。 */
const GLYPH_SMALL = glyph(FILL_SMALL);

/** 小于等于此边长的位图一律用小尺寸档。 */
const SMALL_CUTOFF = 48;
const glyphFor = (size) => (size <= SMALL_CUTOFF ? GLYPH_SMALL : GLYPH);

/** 安全区缩放:maskable/自适应图标把主体收到中心 ~72%。 */
const SAFE_SCALE = 0.72;
const scaled = (body) =>
  `<g transform="translate(256 256) scale(${SAFE_SCALE}) translate(-256 -256)">${body}</g>`;

/** 圆角版(Web favicon / 桌面)。body 决定用哪一档。 */
function roundedSvg(body = GLYPH) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="116" fill="${BASE}"/>
  ${body}
</svg>
`;
}

/** 满底版 —— 给 maskable 用,图形缩进安全区,系统裁任意形状都不切主体。 */
function maskableSvg(body = GLYPH) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${BASE}"/>
  ${scaled(body)}
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
 * 关键:按目标尺寸挑档位(≤48px 用小尺寸档),而不是先画 512 再缩小 ——
 * 后者在小尺寸柱子只剩 1~2px(原因见文件头)。
 * 同时用高 density 光栅化,让 16/24px 这类尺寸也能拿到干净的抗锯齿结果。
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

/** 按目标尺寸选好档位的完整图标 SVG。 */
function iconSvgFor(size, colors = {}) {
  const body = glyphFor(size);
  if (colors.maskable) return maskableSvg(body);
  return roundedSvg(body);
}

/**
 * ICO 容器(Windows 桌面图标)。
 * sharp 不产 .ico,这里按 ICO 目录格式手工封装多张 PNG。
 * 每张都当"独立 PNG 条目"(ImageType 2),Vista 起广泛支持。
 * 每个尺寸各自选档位 —— 用一张 256 缩到 16 会糊。
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
 * Android 矢量图(前景层)。
 * 纯色填充,直接用 android:fillColor,不需要 aapt:attr。
 * pathData 原样沿用 2000 坐标系的路径(含 A 圆弧指令,VectorDrawable 支持),
 * 缩放与居中交给内层 <group>,与 SVG 用的是同一组 glyphTransform 参数。
 *
 * 用哪一档:只能用常规档 0.66,**不能**用小尺寸档 0.80。
 * 自适应图标只保证中心直径 66dp(108dp 画布)可见,圆形启动器会裁掉其余部分。
 * 实测图形离中心最远的墨迹是飘带右上尖端(2000 坐标 (1488,608),半径 618.9),
 * 换算后安全圆允许的最大占比是 0.669:0.66 时半径 154.5 / 安全 156.4,
 * 0.80 时 187.2,尖端会被切掉。改图形后要重新量这个半径。
 */
function androidGlyphVector(fill = FILL_STANDARD) {
  const { scale, tx, ty } = glyphTransform(fill);
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- 由 frontend/scripts/build-icons.mjs 生成,勿手改。 -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="512"
    android:viewportHeight="512">
    <!-- 自适应图标安全区:512 视图里只有中心 72% 保证可见 -->
    <group android:translateX="71.68" android:translateY="71.68"
           android:scaleX="0.72" android:scaleY="0.72">
        <!-- 把 2000 坐标系的图形缩放并居中到 512 视图 -->
        <group android:translateX="${tx.toFixed(3)}" android:translateY="${ty.toFixed(3)}"
               android:scaleX="${scale.toFixed(6)}" android:scaleY="${scale.toFixed(6)}">
${GLYPH_PATHS.map((d) => `            <path android:fillColor="${GLYPH_COLOR}" android:pathData="${d}" />`).join('\n')}
        </group>
    </group>
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
  // 矢量源用常规档(它会在各尺寸被浏览器重新栅格化,favicon 由 PNG 兜底)。
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
  // ICO 每个尺寸单独选档,不能整体用一张大图缩
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
