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
// 关键:必须识别正则字面量,否则含引号的字符类会让字符串状态错位(见下方注释)。

// 判断当前 "/" 是除号还是正则起始:看前一个有意义字符。
function regexAllowed(prevSig) {
  if (!prevSig) return true;
  if (/[=(,:[!&|?{};+\-*%~^<>]/.test(prevSig)) return true;
  return /\b(return|typeof|case|in|of|new|delete|void|throw|instanceof|do|else|yield|await)$/.test(prevSig);
}

function stripComments(text) {
  let out = '';
  let i = 0;
  let inBlock = false;
  let inLine = false;
  let inString = null;
  let prevSig = '';   // 上一个有意义字符,用于区分正则字面量与除号
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

    // 正则字面量:必须识别,否则像 Download.js 的
    //   /[\s/\\|,，.。;；:：!！?？、'"“”‘’《》<>()[\]【】{}-]+/
    // 这类含引号的字符类会把 inString 状态带偏,导致该文件之后的注释全部不被剥离
    // (同时造成误报与漏报 —— 这是实测过的确定性缺陷)。
    if (ch === '/' && regexAllowed(prevSig)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      for (; j < text.length; j += 1) {
        const rc = text[j];
        if (rc === '\\') { j += 1; continue; }
        if (rc === '[') { inClass = true; continue; }
        if (rc === ']') { inClass = false; continue; }
        if (rc === '/' && !inClass) { closed = true; break; }
        if (rc === '\n') break; // 非法正则,按除号处理
      }
      if (closed) {
        out += text.slice(i, j + 1);
        i = j + 1;
        prevSig = '/';
        continue;
      }
    }

    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; out += ch; i += 1; continue; }
    out += ch;
    if (!/\s/.test(ch)) prevSig = ch;
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

// ---- 10. 中文界面文案标点必须是全角 ----
// 曾出现 120 处「中文后接半角逗号/问号」混用,视觉上像半角拼凑的机器翻译。
// 只检查字符串字面量内部且含中文的情况,注释与代码不动。
function scanCjkPunctuation(file, code) {
  const CJK = /[\u4e00-\u9fa5]/;
  code.split(/\r?\n/).forEach((line, idx) => {
    const strings = line.match(/(['"`])(?:\\.|(?!\1).)*\1/g) || [];
    for (const s of strings) {
      if (!CJK.test(s)) continue;
      // 先把 ${...} 模板表达式挖掉,避免把代码里的半角标点当文案
      const plain = s.replace(/\$\{[^}]*\}/g, '');
      const bad = [];
      if (CJK.test(plain) && /[\u4e00-\u9fa5],/.test(plain)) bad.push('半角逗号');
      if (CJK.test(plain) && /[\u4e00-\u9fa5]\?/.test(plain)) bad.push('半角问号');
      if (CJK.test(plain) && /[\u4e00-\u9fa5];/.test(plain)) bad.push('半角分号');
      if (/[\u4e00-\u9fa5]\.\.\./.test(plain)) bad.push('三点省略号');
      if (bad.length) {
        fail(file, idx + 1, 'cjk-punctuation', `${bad.join('+')} —— 中文文案请用全角「，？」与「…」:${s.slice(0, 40)}`);
      }
    }
  });
}

for (const file of sourceFiles) {
  scanCjkPunctuation(file, stripComments(readFileSync(file, 'utf8')));
}

// ---- 11. 中文界面禁止 'N/A' ----
for (const file of sourceFiles) {
  const code = stripComments(readFileSync(file, 'utf8'));
  code.split(/\r?\n/).forEach((line, idx) => {
    if (/['"]N\/A['"]/.test(line)) {
      fail(file, idx + 1, 'no-english-placeholder', "中文界面不要 'N/A',用 '—'");
    }
  });
}

// ---- 12. 组件/图标标识符必须已导入或声明 ----
//
// 这条规则来自一次真实生产事故:重写 SongRow 时把 `ListPlus` 从 lucide-react 的
// import 里删掉了,但 JSX 里 `<MenuItem icon={ListPlus} …/>` 还在用。
// vite build **不会报错**(打包器不把未定义标识符当错误),产物里 `ListPlus` 以
// 自由变量形式残留 → 每一行 SongRow 渲染即抛 ReferenceError →
// 由 ErrorBoundary 接管 → 搜索结果/歌单/已下载/最近播放**整页不可用**,
// 而且这个版本已经部署到了生产。
//
// 仓库没有 ESLint(也就没有 no-undef / react/jsx-no-undef),所以在这里补一条
// 针对性的轻量检查:凡是「大写开头、被当作组件或 icon={} 使用」的标识符,
// 必须在本文件的 import / 顶层声明 / 解构里出现过。
const JS_GLOBALS = new Set([
  'React', 'Math', 'JSON', 'Object', 'String', 'Number', 'Boolean', 'Array', 'Promise',
  'Date', 'Error', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'BigInt',
  'Intl', 'URL', 'URLSearchParams', 'Blob', 'File', 'FileReader', 'FormData', 'AbortController',
  'IntersectionObserver', 'ResizeObserver', 'MutationObserver', 'MediaRecorder', 'Audio',
  'Notification', 'navigator', 'window', 'document', 'localStorage', 'sessionStorage',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'fetch', 'console', 'process', 'globalThis', 'undefined', 'NaN', 'Infinity',
]);

function checkUndefinedIdentifiers(file, code) {
  const localNames = new Set(JS_GLOBALS);
  const addFromBindingPattern = (pattern) => {
    // 处理 `A`、`A as B`、`a: A`、`...A`、`a: { b: C }` 等绑定形式:
    // 取每段里的「本地名」(as 之后 / 冒号之后 / 裸标识符)
    pattern.split(',').forEach((part) => {
      const seg = part.trim().replace(/^\.\.\./, '');
      if (!seg) return;
      const renamed = seg.includes(':') ? seg.split(':').pop().trim() : seg;
      const asMatch = seg.match(/\bas\s+([A-Za-z_$][\w$]*)/);
      if (asMatch) { localNames.add(asMatch[1]); return; }
      const id = renamed.match(/^([A-Za-z_$][\w$]*)/);
      if (id) localNames.add(id[1]);
    });
  };

  // 1) import 语句:逐行处理,支持多行 `import {\n  A,\n  B,\n} from 'x'`。
  //    不能用一条跨语句的正则 —— `import './x.css'; import App from './App'`
  //    这种没有 from 的副作用导入会让 [\s\S]*? 一路吃穿到下一条语句的 from。
  const lineList = code.split(/\r?\n/);
  for (let li = 0; li < lineList.length; li += 1) {
    const startLine = lineList[li];
    if (!/^\s*import\b/.test(startLine)) continue;
    // 拼出完整语句:直到出现 from '…' 或以引号结尾的副作用导入
    let stmt = startLine;
    let end = li;
    while (!/from\s+['"][^'"]*['"]\s*;?\s*$/.test(stmt) && !/^\s*import\s+['"][^'"]*['"]\s*;?\s*$/.test(stmt)) {
      if (end + 1 >= lineList.length) break;
      end += 1;
      stmt += ` ${lineList[end]}`;
      if (end - li > 20) break; // 兜底,避免异常文件无限拼
    }
    li = end;
    const clauseMatch = stmt.match(/^\s*import\s+([\s\S]*?)\s+from\s+['"]/);
    if (!clauseMatch) continue; // 副作用导入 `import './x.css'`,没有绑定
    const clause = clauseMatch[1];
    // default import
    const dflt = clause.match(/^([A-Za-z_$][\w$]*)/);
    if (dflt) localNames.add(dflt[1]);
    // namespace: * as Name
    const ns = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (ns) localNames.add(ns[1]);
    // named: { A, B as C }
    const named = clause.match(/\{([\s\S]*?)\}/);
    if (named) addFromBindingPattern(named[1]);
  }

  // 2) 声明:const/let/var/function/class
  const declRe = /\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = declRe.exec(code)) !== null) localNames.add(m[1]);

  // 解构声明: const { a, b: c } = … / const [x, y] = …
  const destrRe = /\b(?:const|let|var)\s*[{[]([\s\S]*?)[}\]]\s*=/g;
  while ((m = destrRe.exec(code)) !== null) addFromBindingPattern(m[1]);

  // 3) 函数/组件参数里的名字与解构。
  //    这是最容易漏的一类:组件常写成
  //      const SongRow = ({ song, icon: Icon }) => …
  //      export default function NativePlayerProvider({ context: PlayerContext, children }) {…}
  //    `Icon` / `PlayerContext` 都是合法的本地绑定,不能判成未定义。
  const fnParamRe = /(?:function\s*[A-Za-z_$\w]*\s*|=>\s*)\(([\s\S]*?)\)\s*(?:=>|\{)/g;
  while ((m = fnParamRe.exec(code)) !== null) {
    const params = m[1];
    // 先整体当绑定模式处理(覆盖 `{ a, b: C }`)
    addFromBindingPattern(params.replace(/[{}[\]]/g, ''));
    // 再补箭头函数单参 `x => …`
  }
  // 箭头函数单参数: (x) => / x =>
  const arrowRe = /\(([A-Za-z_$][\w$]*)\)\s*=>/g;
  while ((m = arrowRe.exec(code)) !== null) localNames.add(m[1]);
  const bareArrowRe = /(?:^|[\s(,])([A-Za-z_$][\w$]*)\s*=>/g;
  while ((m = bareArrowRe.exec(code)) !== null) localNames.add(m[1]);
  // 解构参数(不带 function 关键字): ({ a }) =>
  const destrParamRe = /\(\s*\{([\s\S]*?)\}\s*\)\s*=>/g;
  while ((m = destrParamRe.exec(code)) !== null) addFromBindingPattern(m[1]);
  // 普通声明式解构参数: function X({...})
  const destrFnRe = /function\s*[A-Za-z_$\w]*\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
  while ((m = destrFnRe.exec(code)) !== null) addFromBindingPattern(m[1]);

  // 4) 找出「被当作组件或图标使用」的大写标识符
  const used = new Map();
  lineList.forEach((line, idx) => {
    const record = (name) => {
      if (!/^[A-Z]/.test(name)) return;
      if (!used.has(name)) used.set(name, idx + 1);
    };
    // icon={Foo} / component={Foo} / as={Foo}
    for (const mm of line.matchAll(/\b(?:icon|component|as)\s*=\s*\{\s*([A-Z][\w$]*)/g)) record(mm[1]);
    // JSX 标签 <Foo> / <Foo.Bar> / <Foo/>
    for (const mm of line.matchAll(/<([A-Z][\w$]*)/g)) record(mm[1]);
  });

  for (const [name, lineNo] of used) {
    if (localNames.has(name)) continue;
    fail(
      file,
      lineNo,
      'undefined-identifier',
      `标识符 ${name} 被当作组件/图标使用,但本文件没有 import 或声明它 —— ` +
      '构建不会报错,运行时却是 ReferenceError(曾因此让整页列表崩溃并上了生产)',
    );
  }
}

for (const file of sourceFiles) {
  checkUndefinedIdentifiers(file, stripComments(readFileSync(file, 'utf8')));
}

if (failures.length > 0) {
  console.error(`UX 门禁未通过,共 ${failures.length} 项:\n`);
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('UX 门禁通过:未定义标识符 / token / z-index / 滚动条 / 原生弹窗 / 静默失败 / 可访问名称 / ErrorBoundary / toast aria-live 均合规。');
}
