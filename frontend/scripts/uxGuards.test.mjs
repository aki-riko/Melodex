import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// UX 一致性门禁。
//
// 为什么需要它:这个仓库的界面问题不是一次改坏的,是"每次新增都各写一套"累积出来的
// —— 同一个主按钮 8 种写法、z-index 15 个魔法数字、滚动条只有主区有样式、
// toast 没有 aria-live、同一句文案 3 种叫法。人工 review 拦不住这类回归,
// 所以把规则固化成静态扫描(零依赖,不需要浏览器)。
//
// 运行: node scripts/uxGuards.test.mjs      (或 npm run test:ux)

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptDir, '..');
const srcRoot = resolve(frontendRoot, 'src');

const failures = [];
const fail = (file, line, rule, detail) => {
  failures.push(`${relative(frontendRoot, file)}:${line} [${rule}] ${detail}`);
};

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (['.js', '.jsx', '.css'].includes(extname(entry.name))) out.push(abs);
  }
  return out;
}

// 把块注释与行注释替换为等长空白(保留换行),这样行号不偏移、也避免注释里的
// "z-[90]" / "window.confirm" 之类说明文字造成误报。
function stripComments(text) {
  let out = '';
  let i = 0;
  let inBlock = false;
  let inLine = false;
  let inString = null;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') { inLine = false; out += ch; } else out += ' ';
      i += 1;
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; out += '  '; i += 2; continue; }
      out += ch === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (ch === inString) inString = null;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') { inBlock = true; out += '  '; i += 2; continue; }
    if (ch === '/' && next === '/') { inLine = true; out += '  '; i += 2; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; out += ch; i += 1; continue; }
    out += ch;
    i += 1;
  }
  return out;
}

const allFiles = walk(srcRoot);
const sourceFiles = allFiles.filter((f) => !f.endsWith('index.css'));

const relOf = (file) => relative(srcRoot, file).split('\\').join('/');
const isDesignSystem = (file) => relOf(file).startsWith('ui/');
// 播放器/媒体管线的 catch 是"降级链":失败要回退到另一条播放路径,不适合弹 toast。
// 对它们只要求"不是完全空 catch";UI 层才强制用户可见反馈。
const isUiLayer = (file) => {
  const rel = relOf(file);
  return rel.startsWith('components/') || rel === 'App.js';
};

for (const file of sourceFiles) {
  const raw = readFileSync(file, 'utf8');
  const code = stripComments(raw);
  const lines = code.split(/\r?\n/);
  const designSystem = isDesignSystem(file);

  lines.forEach((line, idx) => {
    const n = idx + 1;

    // ---- 1. 禁止裸 hex 颜色(设计系统层除外) ----
    if (!designSystem) {
      const hex = line.match(/#[0-9a-fA-F]{3,8}\b/g);
      if (hex) {
        const isHashLink = /href=\s*["']#/.test(line) || /location\.hash/.test(line);
        const isInUrl = /url\(/.test(line);
        if (!isHashLink && !isInUrl) {
          fail(file, n, 'no-raw-hex', `裸色值 ${hex.join(',')} —— 用 bg-card / text-primary 等 token,或写进 index.css 变量`);
        }
      }
      const arb = line.match(/(?:bg|text|border|ring|fill|stroke)-\[(?:#|rgb|hsl)/g);
      if (arb) fail(file, n, 'no-arbitrary-color', `任意色值 ${arb.join(',')} —— 用语义 token`);
    }

    // ---- 2. 禁止 z-index 魔法数字,只允许语义层 ----
    const zArb = line.match(/z-\[\d+\]/g);
    if (zArb) {
      fail(file, n, 'no-raw-zindex', `${zArb.join(',')} —— 用 z-nav/z-tabbar/z-bar/z-popover/z-drawer/z-sheet/z-modal/z-toast`);
    }
    const zNum = line.match(/(?<![\w-])z-(?:10|20|30|40|50|60|70|80|90|100)(?![\w-])/g);
    if (zNum) {
      fail(file, n, 'no-raw-zindex', `${zNum.join(',')} —— 用语义层级类`);
    }

    // ---- 3. 禁止原生阻塞对话框 ----
    if (/window\.(confirm|alert|prompt)\s*\(/.test(line)) {
      fail(file, n, 'no-native-dialog', '用 useFeedback().confirm / prompt(支持 Esc、焦点管理、不阻塞浏览器)');
    }

    // ---- 4. 可滚容器必须挂统一滚动条类 ----
    const scrollable = /\boverflow-(?:x|y)-(?:auto|scroll)\b/.test(line);
    if (scrollable) {
      const windowText = lines.slice(Math.max(0, idx - 8), idx + 9).join(' ');
      const hasUnified = /scroll-(?:area|x)\b|app-scroll\b/.test(windowText);
      if (!hasUnified) {
        fail(file, n, 'unified-scrollbar', '可滚容器未挂 .scroll-area / .scroll-x —— 否则渲染成浏览器默认滚动条');
      }
    }

    // ---- 5. 图标按钮必须有可访问名称 ----
    if (/<button\b/.test(line) && /\/>\s*$/.test(line)) {
      if (!/aria-label=|title=/.test(line)) {
        fail(file, n, 'button-needs-label', '<button /> 缺 aria-label/title,图标按钮对读屏是空的');
      }
    }

    // ---- 6. 禁止 style 写颜色/字号(绕过 token) ----
    if (/style=\{\{[^}]*\b(?:color|background|backgroundColor|fontSize)\s*:/.test(line)) {
      fail(file, n, 'no-inline-token-bypass', 'style 里写了颜色/字号 —— 用 Tailwind 类或 CSS 变量');
    }
  });

  // ---- 7. UI 层 catch 不得静默 ----
  if (isUiLayer(file)) {
    const content = code;
    const catchRe = /catch\s*(?:\([^)]*\))?\s*\{/g;
    let m;
    while ((m = catchRe.exec(content)) !== null) {
      let depth = 0;
      let i = m.index + m[0].length - 1;
      let end = -1;
      for (; i < content.length; i += 1) {
        if (content[i] === '{') depth += 1;
        else if (content[i] === '}') {
          depth -= 1;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end < 0) continue;
      const body = content.slice(m.index + m[0].length, end).trim();
      const lineNo = content.slice(0, m.index).split('\n').length;

      const silentOk = /silent-ok|ignore-on-purpose/.test(body);
      if (silentOk) continue;

      if (!body) {
        fail(file, lineNo, 'no-silent-catch', '空 catch —— 至少 console.error;UI 层应给用户反馈');
        continue;
      }

      // UI 层:剥掉 console 语句后如果什么都不剩 —— 用户主动操作失败却完全不可见。
      // (不能用单条正则去"匹配只有 console",那样会把 console + setError 也误吞。)
      const withoutConsole = body
        .replace(/console\.(?:error|warn|log|info)\s*\([\s\S]*?\)\s*;?/g, '')
        .replace(/[\s;]/g, '');
      if (withoutConsole === '') {
        fail(file, lineNo, 'no-silent-catch', 'UI 层 catch 只有 console —— 用户主动操作失败必须可见(接 feedback.error / setError)');
      }
    }
  }
}

// ---- 8. App.js 必须用 ErrorBoundary ----
try {
  const app = stripComments(readFileSync(resolve(srcRoot, 'App.js'), 'utf8'));
  if (!/<ErrorBoundary/.test(app)) {
    fail(resolve(srcRoot, 'App.js'), 1, 'needs-error-boundary', 'App.js 必须用 ErrorBoundary 包裹,否则渲染异常 = 白屏');
  }
} catch {
  fail(resolve(srcRoot, 'App.js'), 1, 'needs-error-boundary', '读不到 App.js');
}

// ---- 9. Toast 容器必须有 aria-live ----
try {
  const fb = stripComments(readFileSync(resolve(srcRoot, 'contexts', 'FeedbackContext.js'), 'utf8'));
  if (!/aria-live/.test(fb)) {
    fail(resolve(srcRoot, 'contexts', 'FeedbackContext.js'), 1, 'toast-aria-live', 'Toast 必须有 aria-live,否则读屏收不到反馈');
  }
} catch {
  fail(resolve(srcRoot, 'contexts', 'FeedbackContext.js'), 1, 'toast-aria-live', '读不到 FeedbackContext.js');
}

// ---- 10. 中文界面禁止 'N/A' ----
for (const file of sourceFiles) {
  const code = stripComments(readFileSync(file, 'utf8'));
  code.split(/\r?\n/).forEach((line, idx) => {
    if (/['"]N\/A['"]/.test(line)) {
      fail(file, idx + 1, 'no-english-placeholder', "中文界面不要 'N/A',用 '—'");
    }
  });
}

if (failures.length > 0) {
  console.error(`UX 门禁未通过,共 ${failures.length} 项:\n`);
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('UX 门禁通过:token / z-index / 滚动条 / 原生弹窗 / 静默失败 / 可访问名称 / ErrorBoundary / toast aria-live 均合规。');
}
