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
 *   - 渐变必须 gradientUnits="userSpaceOnUse"。默认的 objectBoundingBox 在
 *     路径是**竖直线段**时包围盒宽度为 0,渐变无法解析,整条线直接不渲染
 *     (自查时连踩两次:图标只剩个空底)。
 *   - 主体必须落在 maskable 安全圆(r = 40% 边长)以内,否则被系统裁圆角切边。
 *   - 小尺寸靠**笔画粗细一致性**分辨,不靠细节。图标本身已按这个原则设计:
 *     只有粗笔画 + 两个符头,没有细线装饰,所以 16px 也不会糊成噪点。
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'));
const sharp = require('sharp');

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, '..');
const ROOT = resolve(FRONTEND, '..');
const PUBLIC = resolve(FRONTEND, 'public');
const ANDROID_RES = resolve(ROOT, 'android/app/src/main/res');
const TAURI_ICONS = resolve(ROOT, 'desktop/src-tauri/icons');

const CHECK = process.argv.includes('--check');

/** 品牌底色与绿色(与旧版同一色系,保持品牌连续性)。 */
const BASE = '#0E1E17';
/** 视觉中心:符干+横梁构成的 M 融合形。 */
const GRADIENT = `
    <linearGradient id="melodexGreen" gradientUnits="userSpaceOnUse"
                    x1="130" y1="110" x2="382" y2="400">
      <stop offset="0" stop-color="#6BF7AA"/>
      <stop offset="0.55" stop-color="#2FD982"/>
      <stop offset="1" stop-color="#0FA45F"/>
    </linearGradient>`;

/**
 * 图形主体(512 坐标系),两档笔画。
 *
 * 为什么要两档:512 视图里 stroke-width=46 缩到 32px 只剩 2.875 个像素,
 * 且不是整数 → 抗锯齿把笔画糊成软边,M 的横梁与两根符干粘连,小图标读不出字形。
 * 实测(nearest 放大逐像素比对)base46 在 32px 已糊成一团,bold72 仍清楚。
 * 所以 ≤48px 的产物改用加粗版:笔画 72、符干内收、符头放大,
 * 保证 16px 下"两根竖 + 中间尖"三个特征都还分得开。
 *
 * 两档共用同一套构造参数,避免以后改一处忘另一处。
 */
/** 两档几何参数 —— SVG 与 Android VectorDrawable 都从这里取,避免手抄坐标走样。 */
const GEO_STANDARD = { stroke: 46, stemIn: 176, headY: 344, headRx: 52, headRy: 39 };
const GEO_SMALL = { stroke: 72, stemIn: 188, headY: 339, headRx: 61, headRy: 46 };

function glyph(g = GEO_STANDARD) {
  const { stroke, stemIn, headY, headRx, headRy } = g;
  // 横梁是相对路径 l(beam) 84 (beam) -84:从 stemIn 走到中线 256 再走到对称位置,
  // 所以单段水平位移 = 256 - stemIn(不是 512-2*stemIn,那是总跨度)。
  const beam = 256 - stemIn;
  return `
    <g stroke="url(#melodexGreen)" fill="none"
       stroke-linecap="round" stroke-linejoin="round">
      <path d="M${stemIn} 328V138" stroke-width="${stroke}"/>
      <path d="M${512 - stemIn} 328V138" stroke-width="${stroke}"/>
      <path d="M${stemIn} 138l${beam} 84 ${beam} -84" stroke-width="${stroke}"/>
    </g>
    <ellipse cx="142" cy="${headY}" rx="${headRx}" ry="${headRy}"
             fill="url(#melodexGreen)" transform="rotate(-16 142 ${headY})"/>
    <ellipse cx="370" cy="${headY}" rx="${headRx}" ry="${headRy}"
             fill="url(#melodexGreen)" transform="rotate(-16 370 ${headY})"/>`;
}

/** 常规档:≥64px 的产物。 */
const GLYPH = glyph(GEO_STANDARD);

/** 加粗档:≤48px 的产物(原理见上)。 */
const GLYPH_SMALL = glyph(GEO_SMALL);

/**
 * 椭圆 → pathData(Android VectorDrawable 不支持 <ellipse>,只认 path)。
 * 用四段三次贝塞尔画闭合椭圆:圆角半径系数 0.5522847498 是 90° 弧的标准近似,
 * 误差 <0.03%,在小图标上完全看不出来。
 * rotation 为绕中心的旋转角(度),整体对每个点做旋转。
 */
function ellipsePath(cx, cy, rx, ry, rotation = 0) {
  const k = 0.5522847498;
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // 先按未旋转坐标算点,再绕中心旋转
  const rot = (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  };
  const f = (x, y) => {
    const [px, py] = rot(x, y);
    return `${px.toFixed(2)} ${py.toFixed(2)}`;
  };
  const krx = k * rx;
  const kry = k * ry;
  return (
    `M${f(cx - rx, cy)}` +
    `C${f(cx - rx, cy - kry)} ${f(cx - krx, cy - ry)} ${f(cx, cy - ry)}` +
    `C${f(cx + krx, cy - ry)} ${f(cx + rx, cy - kry)} ${f(cx + rx, cy)}` +
    `C${f(cx + rx, cy + kry)} ${f(cx + krx, cy + ry)} ${f(cx, cy + ry)}` +
    `C${f(cx - krx, cy + ry)} ${f(cx - rx, cy + kry)} ${f(cx - rx, cy)}Z`
  );
}

/** 小于此边长的位图一律用加粗档。 */
const SMALL_CUTOFF = 48;
const glyphFor = (size) => (size <= SMALL_CUTOFF ? GLYPH_SMALL : GLYPH);

/** 安全区缩放:maskable/自适应图标把主体收到中心 ~72%。 */
const SAFE_SCALE = 0.72;
const scaled = (body) =>
  `<g transform="translate(256 256) scale(${SAFE_SCALE}) translate(-256 -256)">${body}</g>`;

/** 圆角版(Web favicon / 桌面)。size 决定用哪一档笔画。 */
function roundedSvg(body = GLYPH) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>${GRADIENT}
  </defs>
  <rect width="512" height="512" rx="116" fill="${BASE}"/>
  ${body}
</svg>
`;
}

/** 圆形底版 —— Android 圆形启动器图标用。 */
function roundSvg(body = GLYPH) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>${GRADIENT}
  </defs>
  <circle cx="256" cy="256" r="256" fill="${BASE}"/>
  ${body}
</svg>
`;
}

/** 满底版 —— 给 maskable 用,图形缩进安全区,系统裁任意形状都不切主体。 */
function maskableSvg(body = GLYPH) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>${GRADIENT}
  </defs>
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
 * 关键:按目标尺寸挑笔画档(≤48px 用加粗档),而不是先画 512 再缩小 ——
 * 后者在小尺寸必糊(原因见 glyph 的注释)。
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
  if (colors.round) return roundSvg(body);
  if (colors.maskable) return maskableSvg(body);
  return roundedSvg(body);
}

/**
 * ICO 容器(Windows 桌面图标)。
 * sharp 不产 .ico,这里按 ICO 目录格式手工封装多张 PNG。
 * 每张都当"独立 PNG 条目"(ImageType 2),Vista 起广泛支持。
 * 每个尺寸各自选笔画档 —— 用一张 256 缩到 16 会糊。
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
 * 故意不放 <monochrome>:主题图标要求单色剪影,而这里的前景是渐变色块,
 * 硬塞进去会得到一团实心方块。
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

/** 同一渐变在 VectorDrawable 里的写法(<gradient> 塞进 aapt:attr)。 */
const AAPT_GRADIENT = (stopTag = 'android:strokeColor') => `
            <aapt:attr name="${stopTag}">
                <gradient android:type="linear"
                    android:startX="130" android:startY="110"
                    android:endX="382" android:endY="400"
                    android:startColor="#6BF7AA"
                    android:centerColor="#2FD982"
                    android:endColor="#0FA45F" />
            </aapt:attr>`;

/**
 * Android 矢量图(前景层)。
 * VectorDrawable 的 strokeWidth 是普通浮点属性;**不是** color 类属性,
 * 不能包在 <aapt:attr> 里(写成空 <attr/> 会被 aapt2 直接判非法)。
 * 只有渐变色的 strokeColor/fillColor 才需要 aapt:attr 包裹。
 *
 * 用哪一档:自适应图标在桌面上通常以 48~108dp 显示,栅格化后接近小图标,
 * 所以统一用**加粗档**,与位图回退的观感保持一致(不这么做会出现
 * "有的启动器用矢量有的用位图,粗细不一致"的割裂)。
 */
function androidGlyphVector({ geo = GEO_SMALL } = {}) {
  const { stroke, stemIn, headY, headRx, headRy } = geo;
  const beam = 256 - stemIn;
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- 由 frontend/scripts/build-icons.mjs 生成,勿手改。 -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="512"
    android:viewportHeight="512">
    <!-- 自适应图标安全区:512 视图里只有中心 72% 保证可见 -->
    <group android:translateX="71.68" android:translateY="71.68"
           android:scaleX="0.72" android:scaleY="0.72">

        <!-- 左符干 -->
        <path android:pathData="M${stemIn} 328V138"
            android:strokeWidth="${stroke}" android:strokeLineCap="round">
${AAPT_GRADIENT('android:strokeColor')}
        </path>

        <!-- 右符干 -->
        <path android:pathData="M${512 - stemIn} 328V138"
            android:strokeWidth="${stroke}" android:strokeLineCap="round">
${AAPT_GRADIENT('android:strokeColor')}
        </path>

        <!-- M 形横梁 -->
        <path android:pathData="M${stemIn} 138l${beam} 84 ${beam} -84"
            android:strokeWidth="${stroke}" android:strokeLineCap="round"
            android:strokeLineJoin="round">
${AAPT_GRADIENT('android:strokeColor')}
        </path>

        <!-- 两个符头(倾斜椭圆) -->
        <path android:pathData="${ellipsePath(142, headY, headRx, headRy, -16)}">
${AAPT_GRADIENT('android:fillColor')}
        </path>
        <path android:pathData="${ellipsePath(370, headY, headRx, headRy, -16)}">
${AAPT_GRADIENT('android:fillColor')}
        </path>
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
