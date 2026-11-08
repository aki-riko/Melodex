import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptDir, '..');
const srcRoot = resolve(frontendRoot, 'src');

// Hook 顺序契约(锁死 minified React error #300)。
//
// 为什么要有:2026-11 生产环境首页点开歌单后整站变成「界面出错了」,错误原文是
// `Rendered fewer hooks than expected. This may be caused by an accidental early
// return statement.`(minified #300)。
// 真因:`HomeRecommendations` 里 `if (selectedPlaylist) return <PlaylistSongs/>`
// 写在 `useMemo` **之前** —— 首页那副渲染是 5 个 hook,点开歌单后是 4 个,
// React 对不上号就抛错并卸载整棵树,用户只看到全局 ErrorBoundary。
//
// 这类错误构建不报错、Babel/TS 也不检查 hook 顺序,只有真机点进去才炸,
// 而且 minified 后错误信息全丢。所以这里静态锁死:
// **组件/自定义 hook 里,不允许在任何提前 return 之后还调用 hook**。
//
// 运行: node scripts/hookOrder.test.mjs   (或 npm run test:hooks)

// @babel/core 是 @vitejs/plugin-react 的直接依赖,构建链里必然存在。
// 纯正则无法正确判断 hook 顺序,必须拿 AST,但不新增依赖。
const babel = await import('@babel/core');

const isHookName = (name) => /^use[A-Z0-9]/.test(name || '');
const isComponentName = (name) => /^[A-Z]/.test(name || '');
const isFunctionNode = (node) =>
  node.type === 'FunctionDeclaration' ||
  node.type === 'FunctionExpression' ||
  node.type === 'ArrowFunctionExpression';

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.(js|jsx)$/.test(entry)) out.push(abs);
  }
  return out;
};

// 调用表达式名:useX(...) / React.useX(...)
const calleeName = (callee) => {
  if (!callee) return null;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed) return callee.property?.name || null;
  return null;
};

// 收集函数 **自身** body 里的 hook 调用(不进入嵌套函数 —— 那是独立组件/hook)。
const selfHooks = (fnBody) => {
  const found = [];
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node !== fnBody && isFunctionNode(node)) return;
    if (node.type === 'CallExpression') {
      const name = calleeName(node.callee);
      if (isHookName(name)) found.push({ name, line: node.loc?.start.line || 0 });
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === 'string') visit(child);
      } else if (value && typeof value.type === 'string') {
        visit(value);
      }
    }
  };
  visit(fnBody);
  return found;
};

// 函数自身 body 里最早出现的 `return` 行号(含 if/else/try/switch 分支里的)。
// 只用来回答「会不会在 hook 之前就跳出去」,保守取最早位置即可。
const earliestReturnLine = (fnBody) => {
  if (fnBody.type !== 'BlockStatement') return null; // 箭头函数简写体没有 return
  let earliest = null;
  const scan = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'ReturnStatement') {
      const line = node.loc?.start.line || 0;
      if (earliest === null || line < earliest) earliest = line;
      return;
    }
    if (isFunctionNode(node)) return; // 不进入嵌套函数
    switch (node.type) {
      case 'IfStatement':
        scan(node.consequent);
        scan(node.alternate);
        return;
      case 'BlockStatement':
        for (const s of node.body) scan(s);
        return;
      case 'TryStatement':
        scan(node.block);
        scan(node.handler);
        scan(node.finalizer);
        return;
      case 'CatchClause':
        scan(node.body);
        return;
      case 'SwitchStatement':
        for (const c of node.cases || []) scan(c);
        return;
      case 'SwitchCase':
        for (const s of node.consequent || []) scan(s);
        return;
      default:
    }
  };
  for (const statement of fnBody.body) scan(statement);
  return earliest;
};

// 找出「提前 return 之后仍然调用了 hook」的组件/自定义 hook。
const findViolations = (ast, getCode = () => '') => {
  const violations = [];
  const visit = (node, ownerName) => {
    if (!node || typeof node.type !== 'string') return;
    let name = ownerName;
    if (node.type === 'FunctionDeclaration') {
      name = node.id?.name || ownerName;
    } else if (node.type === 'VariableDeclarator' && node.init && isFunctionNode(node.init)) {
      name = node.id?.type === 'Identifier' ? node.id.name : ownerName;
    } else if (
      (node.type === 'ObjectMethod' || node.type === 'ClassMethod' ||
        node.type === 'ObjectProperty' || node.type === 'ClassProperty') &&
      node.key?.name
    ) {
      name = node.key.name;
    }

    if (isFunctionNode(node) && node.body && (isComponentName(name) || isHookName(name))) {
      const hooks = selfHooks(node.body);
      const returnLine = earliestReturnLine(node.body);
      if (returnLine !== null) {
        const late = hooks.filter((h) => h.line > returnLine);
        if (late.length) {
          violations.push({
            name,
            line: node.loc?.start.line || 0,
            returnLine,
            hooks: late,
          });
        }
      }
    }

    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === 'string') visit(child, name);
      } else if (value && typeof value.type === 'string') {
        visit(value, name);
      }
    }
  };
  visit(ast.program, null);
  return violations;
};

const parse = (code, filename = 'sample.jsx') => babel.parseSync(code, {
  filename,
  babelrc: false,
  configFile: false,
  sourceType: 'module',
  parserOpts: { plugins: ['jsx'] },
});

// ---- 1. 自检:门禁本身必须先证明能抓到坏样本,否则形同虚设 ----
const samples = [
  {
    label: '坏样本:提前 return 之后才调 useMemo',
    code: `import React, { useState, useMemo } from 'react';
export default function Broken({ flag }) {
  const [v] = useState(0);
  if (flag) return null;
  const m = useMemo(() => v, [v]);
  return m;
}`,
    expectCatch: true,
  },
  {
    label: '好样本:全部 hook 都在分支之前',
    code: `import React, { useState, useMemo } from 'react';
export default function Fine({ flag }) {
  const [v] = useState(0);
  const m = useMemo(() => v, [v]);
  if (flag) return null;
  return m;
}`,
    expectCatch: false,
  },
  {
    label: '好样本:嵌套函数里的 hook 不参与父组件顺序',
    code: `import React, { useState } from 'react';
export default function Parent({ flag }) {
  const [v] = useState(0);
  const Child = () => {
    const [c] = useState(1);
    return c;
  };
  if (flag) return null;
  return Child;
}`,
    expectCatch: false,
  },
  {
    label: '坏样本:自定义 hook 里的分支后 hook',
    code: `import { useState, useEffect } from 'react';
export function useThing(flag) {
  const [v] = useState(0);
  if (!flag) return null;
  useEffect(() => {}, []);
  return v;
}`,
    expectCatch: true,
  },
];

const selfCheckErrors = [];
for (const sample of samples) {
  const caught = findViolations(parse(sample.code)).length > 0;
  if (caught !== sample.expectCatch) {
    selfCheckErrors.push(`${sample.label}:期望${sample.expectCatch ? '抓到' : '放过'},实际${caught ? '抓到' : '放过'}`);
  }
}

if (selfCheckErrors.length) {
  console.error('hookOrder 门禁自检失败(检测逻辑本身不可信):');
  for (const e of selfCheckErrors) console.error(`  · ${e}`);
  process.exit(1);
}

// ---- 2. 扫真实源码 ----
const files = walk(srcRoot);
const failures = [];
for (const file of files) {
  const code = readFileSync(file, 'utf8');
  if (!/use[A-Z]/.test(code)) continue;
  let ast;
  try {
    ast = parse(code, file);
  } catch {
    continue; // 语法错误交给 build 报,不在这里制造噪声
  }
  for (const v of findViolations(ast)) {
    failures.push(
      `${relative(frontendRoot, file)}:${v.line} [hook-order] ${v.name} ` +
      `在第 ${v.returnLine} 行提前 return 之后仍有 hook 调用(` +
      `${v.hooks.map((h) => `${h.name}@${h.line}`).join(', ')})——` +
      `不同渲染分支的 hook 数量会不一致,生产构建抛 minified React error #300`,
    );
  }
}

if (failures.length) {
  console.error(`hookOrder 门禁失败(${failures.length} 处):\n`);
  for (const f of failures) console.error(`  · ${f}\n`);
  console.error('修法:把提前 return / 条件分支移到全部 hook 调用之后,');
  console.error('      或把分支渲染的组件拆成子组件 —— 不要靠"条件里没有 hook"侥幸。');
  process.exit(1);
}

console.log(`hookOrder 门禁通过:${files.length} 个文件,未发现「提前 return 之后调用 hook」`);
assert.ok(true);
