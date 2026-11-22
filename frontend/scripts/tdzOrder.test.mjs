import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptDir, '..');
const srcRoot = resolve(frontendRoot, 'src');

// 「声明前引用」门禁 —— 锁死 TDZ 白屏。
//
// ## 为什么要有
//
// 2026-11 桌面壳把歌词桥接的 useEffect 插在了 `const [lrc, setLrc] = useState([])`
// **之前**，组件体执行到那里时 `lrc` 还在暂时性死区，直接抛
// `lrc is not defined` —— 整棵组件树被 ErrorBoundary 接住，用户只看到「界面出错了」。
//
// 关键点：**Vite/Rollup 构建完全不报错**，现有 hookOrder 门禁也查不出
// （它只管「提前 return 之后还有 hook」）。只有真机打开才炸。
//
// ## 检测策略（刻意保守，宁可漏报也不要误报）
//
// 只在**同一个 BlockStatement 的直接语句序列**里比对：
//   第 i 条语句里出现名字 X 的**读取**，而 X 的 const/let 声明在第 j 条语句（j > i）。
//
// 「读取」严格定义，以下都**不算**读取，避免误报：
//   - 声明本身（`const X = ...`）
//   - 赋值左值（`X = ...`）—— 只可能是给已声明变量赋值
//   - 属性名（`obj.X`、`{ X: 1 }`）
//   - 函数体内的引用（延迟求值）**以及嵌套块里的引用**（有自己的声明域）
//   - 立即调用的 IIFE 体**算**读取（此刻就执行）
//
// 这条规则覆盖本次事故形态：`useEffect(..., [lrc])` 的依赖数组是即时求值，
// 而 `lrc` 的声明在后面的语句里。
//
// 运行: node scripts/tdzOrder.test.mjs   (或 npm run test:tdz)

const babel = await import('@babel/core');

// 与 hookOrder.test.mjs 一致：只用 parserOpts 开 jsx，不依赖未安装的 babel preset。
const parse = (code, filename) =>
  babel.parseSync(code, {
    filename,
    sourceType: 'module',
    parserOpts: { plugins: ['jsx'] },
    babelrc: false,
    configFile: false,
  });

const walk = (dir, acc = []) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(js|jsx)$/.test(entry)) acc.push(full);
  }
  return acc;
};

/** 取出声明模式里所有被声明的名字（支持解构）。 */
const patternNames = (node, out = []) => {
  if (!node || typeof node !== 'object') return out;
  switch (node.type) {
    case 'Identifier':
      out.push(node.name);
      break;
    case 'ArrayPattern':
      for (const el of node.elements || []) patternNames(el, out);
      break;
    case 'ObjectPattern':
      for (const prop of node.properties || []) {
        if (prop.type === 'RestElement') patternNames(prop.argument, out);
        else patternNames(prop.value, out);
      }
      break;
    case 'AssignmentPattern':
      patternNames(node.left, out);
      break;
    case 'RestElement':
      patternNames(node.argument, out);
      break;
    default:
      break;
  }
  return out;
};

/**
 * 收集「本条语句执行时就会求值」的标识符读取。
 *
 * 刻意不递归进：函数体、嵌套 BlockStatement。
 */
const collectReads = (node, out = []) => {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectReads(item, out);
    return out;
  }
  if (typeof node.type !== 'string') return out;

  switch (node.type) {
    // 声明：只看初始值
    case 'VariableDeclarator':
      collectReads(node.init, out);
      return out;

    // 赋值：左值若是裸标识符是写入，不算读取
    case 'AssignmentExpression':
      if (node.left.type !== 'Identifier') collectReads(node.left, out);
      collectReads(node.right, out);
      return out;

    // IIFE：函数体此刻就执行
    case 'CallExpression': {
      const callee = node.callee;
      if (
        callee
        && (callee.type === 'ArrowFunctionExpression' || callee.type === 'FunctionExpression')
      ) {
        collectReads(callee.body, out);
      } else {
        collectReads(callee, out);
      }
      for (const arg of node.arguments || []) collectReads(arg, out);
      return out;
    }

    // 普通函数：参数是**声明**（不是读取），只有默认值表达式即时求值；
    // 函数体延迟求值。
    // 踩过：把 params 整段当读取会把 `(count, err) => ...` 这类参数名误报成引用。
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
    case 'FunctionDeclaration':
      for (const param of node.params || []) {
        if (param && param.type === 'AssignmentPattern') collectReads(param.right, out);
      }
      return out;

    // 嵌套块：有自己的声明域，整体跳过
    case 'BlockStatement':
      return out;

    // 导入说明符：`import { a as b }` 里 imported/local 都是声明，不是读取。
    // 踩过：`expiryBadge as expiryBadgeSpec` 被当成读取 expiryBadge，误报。
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
      return out;

    // 成员：obj.prop / obj?.prop 的 prop 不是读取
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      collectReads(node.object, out);
      if (node.computed) collectReads(node.property, out);
      return out;

    // 对象属性：非计算 key 不是读取
    case 'ObjectProperty':
      if (node.computed) collectReads(node.key, out);
      collectReads(node.value, out);
      return out;

    case 'Identifier':
      out.push(node);
      return out;

    default: {
      for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'start' || key === 'end') continue;
        if (key.startsWith('leading') || key.startsWith('trailing') || key.startsWith('inner')) continue;
        const value = node[key];
        if (value && typeof value === 'object') collectReads(value, out);
      }
      return out;
    }
  }
};

const findTdzViolations = (ast) => {
  const violations = [];

  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node.type !== 'string') return;

    if (node.type === 'BlockStatement' || node.type === 'Program') {
      checkBlock(node);
    }

    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue;
      if (key.startsWith('leading') || key.startsWith('trailing') || key.startsWith('inner')) continue;
      const value = node[key];
      if (value && typeof value === 'object') visit(value);
    }
  };

  const checkBlock = (block) => {
    const body = Array.isArray(block.body) ? block.body : [];

    /** @type {Map<string, number>} name -> 语句下标 */
    const declIndex = new Map();
    body.forEach((stmt, index) => {
      let decl = null;
      if (stmt.type === 'VariableDeclaration' && (stmt.kind === 'const' || stmt.kind === 'let')) {
        decl = stmt;
      } else if (
        stmt.type === 'ExportNamedDeclaration'
        && stmt.declaration?.type === 'VariableDeclaration'
        && (stmt.declaration.kind === 'const' || stmt.declaration.kind === 'let')
      ) {
        decl = stmt.declaration;
      }
      if (!decl) return;
      for (const declarator of decl.declarations) {
        for (const name of patternNames(declarator.id)) {
          if (!declIndex.has(name)) declIndex.set(name, index);
        }
      }
    });

    if (declIndex.size === 0) return;

    body.forEach((stmt, index) => {
      for (const ref of collectReads(stmt)) {
        const declaredAt = declIndex.get(ref.name);
        if (declaredAt !== undefined && declaredAt > index) {
          violations.push({
            name: ref.name,
            line: ref.loc?.start?.line ?? 0,
            declaredLine: body[declaredAt]?.loc?.start?.line ?? 0,
          });
        }
      }
    });
  };

  visit(ast);
  return violations;
};

// ---- 1. 自检：确保检测逻辑本身可信 ----
const samples = [
  {
    label: '坏样本：依赖数组引用更晚声明的变量（本次事故形态）',
    code: `
function Player() {
  useEffect(() => { void 1; }, [lrc]);
  const [lrc] = useState([]);
  return null;
}`,
    expectCatch: true,
  },
  {
    label: '坏样本：直接用参数传入更晚声明的变量',
    code: `
function Player() {
  doThing(lrc);
  const lrc = 1;
}`,
    expectCatch: true,
  },
  {
    label: '好样本：先声明后使用',
    code: `
function Player() {
  const [lrc] = useState([]);
  useEffect(() => { void lrc; }, [lrc]);
  return null;
}`,
    expectCatch: false,
  },
  {
    label: '好样本：闭包里引用更晚声明的变量',
    code: `
function Player() {
  const cb = () => later;
  const later = 1;
  return cb && later;
}`,
    expectCatch: false,
  },
  {
    label: '好样本：外层同名变量被内层块重新声明',
    code: `
function f() {
  if (ok) {
    let record = 1;
    use(record);
  }
  const record = 2;
  use(record);
}`,
    expectCatch: false,
  },
  {
    label: '好样本：赋值左值不是读取',
    code: `
function f() {
  record = 1;
  const record = 2;
  use(record);
}`,
    expectCatch: false,
  },
  {
    label: '好样本：属性名不是读取',
    code: `
function f() {
  use(obj.expiryBadge, { expiryBadge: 1 });
  const expiryBadge = 2;
}`,
    expectCatch: false,
  },
  {
    label: '坏样本：IIFE 体即时求值',
    code: `
function f() {
  const a = (() => b)();
  const b = 2;
  return a;
}`,
    expectCatch: true,
  },
];

const selfCheckErrors = [];
for (const sample of samples) {
  const caught = findTdzViolations(parse(sample.code, 'sample.jsx')).length > 0;
  if (caught !== sample.expectCatch) {
    selfCheckErrors.push(
      `${sample.label}:期望${sample.expectCatch ? '抓到' : '放过'},实际${caught ? '抓到' : '放过'}`,
    );
  }
}

if (selfCheckErrors.length) {
  console.error('tdz 门禁自检失败(检测逻辑本身不可信):');
  for (const e of selfCheckErrors) console.error(`  · ${e}`);
  process.exit(1);
}

// ---- 2. 扫真实源码 ----
const files = walk(srcRoot);
const failures = [];
for (const file of files) {
  const code = readFileSync(file, 'utf8');
  let ast;
  try {
    ast = parse(code, file);
  } catch {
    continue; // 语法错误交给 build 报
  }
  for (const v of findTdzViolations(ast)) {
    failures.push(
      `${relative(frontendRoot, file)}:${v.line} [tdz] 读取了 \`${v.name}\`，`
      + `但它在第 ${v.declaredLine} 行才用 const/let 声明 —— `
      + `运行时会抛 \`${v.name} is not defined\`，整棵组件树变「界面出错了」`,
    );
  }
}

if (failures.length) {
  console.error(`tdz 门禁失败(${failures.length} 处):\n`);
  for (const f of failures) console.error(`  · ${f}\n`);
  console.error('修法：把用到该变量的语句移到声明之后，或把声明上移。');
  console.error('      注意 Vite 构建不会报这个错，只有真机渲染才炸。');
  process.exit(1);
}

console.log(`tdz 门禁通过:${files.length} 个文件,未发现「const/let 声明前读取」`);
assert.ok(true);
