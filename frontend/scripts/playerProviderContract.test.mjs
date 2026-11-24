// 两个 PlayerProvider 的上下文契约必须一致(2026-11 全库扫描补充)。
//
// 为什么要有:Melodex 有两个播放器实现 —— WebPlayerProvider(PlayerContext.js)
// 与 NativePlayerProvider(安卓原生播放)。两者向同一棵树暴露**同名同义**的
// PlayerContext,组件不知道自己跑在哪个上面。而这份契约是**两份手写清单**,
// 没有任何类型、接口或测试保证它们一致。
//
// 后果不是"编译不过",而是**运行时才发现**:组件在 Web 上读 setProgress 正常,
// 换到安卓上就是 undefined(反之亦然)。这类"只在某个平台坏"的 bug 最难查。
//
// 这条测试用 AST 提取两边的键集合并要求相等 —— 用 AST 不用正则,是因为
// 两边都是嵌套对象/注释/多行,正则很容易漏或误抓(本项目已有先例:
// 查"裸 rounded"时正则被注释里的反引号截断过)。
//
// 运行: node scripts/playerProviderContract.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptDir, '..');

// @babel/core 是 @vitejs/plugin-react 的直接依赖,构建链里必然存在(不新增依赖)。
const babel = await import('@babel/core');

const readSource = (rel) => readFileSync(resolve(frontendRoot, rel), 'utf8');

/**
 * 提取 `<name> = useMemo(() => ({ ... }), deps)` 里的对象键。
 * 同时支持 `() => ({...})` 与 `() => { return ({...}); }` 两种写法。
 */
function extractMemoObjectKeys(source, filename, variableName) {
  const ast = babel.parseSync(source, {
    filename,
    presets: [],
    parserOpts: { plugins: ['jsx'], sourceType: 'module' },
  });

  const keys = [];

  const collectFromObject = (obj) => {
    for (const prop of obj.properties) {
      if (prop.type === 'ObjectProperty' && prop.key) {
        keys.push(prop.key.name || prop.key.value);
      } else if (prop.type === 'SpreadElement') {
        keys.push('<<spread>>');
      }
    }
  };

  const stripParens = (node) => {
    let current = node;
    while (current && current.type === 'ParenthesizedExpression') current = current.expression;
    return current;
  };

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;

    if (
      node.type === 'VariableDeclarator'
      && node.id && node.id.name === variableName
      && node.init && node.init.type === 'CallExpression'
    ) {
      const fn = (node.init.arguments || [])[0];
      if (fn && (fn.type === 'ArrowFunctionExpression' || fn.type === 'FunctionExpression')) {
        const body = stripParens(fn.body);
        if (body && body.type === 'ObjectExpression') {
          collectFromObject(body);
        } else if (body && body.type === 'BlockStatement') {
          for (const stmt of body.body) {
            if (stmt.type === 'ReturnStatement') {
              const arg = stripParens(stmt.argument);
              if (arg && arg.type === 'ObjectExpression') collectFromObject(arg);
            }
          }
        }
      }
    }

    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end') continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(walk);
      else walk(value);
    }
  };

  walk(ast);
  return keys;
}

const webSource = readSource('src/contexts/PlayerContext.js');
const nativeSource = readSource('src/contexts/NativePlayerProvider.js');

// ---- 1. 两边的控制面键集合必须完全一致 ----
const webControl = extractMemoObjectKeys(webSource, 'PlayerContext.js', 'controlValue');
const nativeControl = extractMemoObjectKeys(
  nativeSource, 'NativePlayerProvider.js', 'controlValue',
);

assert.ok(
  webControl.length > 20,
  `WebPlayerProvider 的 controlValue 只提取到 ${webControl.length} 个键,提取逻辑可能失效了`,
);
assert.ok(
  nativeControl.length > 20,
  `NativePlayerProvider 的 controlValue 只提取到 ${nativeControl.length} 个键,提取逻辑可能失效了`,
);

const onlyWeb = webControl.filter((k) => !nativeControl.includes(k));
const onlyNative = nativeControl.filter((k) => !webControl.includes(k));
assert.deepEqual(
  { onlyWeb, onlyNative },
  { onlyWeb: [], onlyNative: [] },
  '两个 PlayerProvider 的 controlValue 键集合不一致:'
  + `\n  只在 Web: ${onlyWeb.join(', ') || '(无)'}`
  + `\n  只在 Native: ${onlyNative.join(', ') || '(无)'}`
  + '\n组件不知道自己在哪个平台上跑,缺任何一边都是"只在安卓/只在 Web 坏"的运行时 bug。',
);

// ---- 2. 两边都必须有同一个 PlayerProgressContext(进度面) ----
for (const [label, source] of [['Web', webSource], ['Native', nativeSource]]) {
  assert.ok(
    source.includes('PlayerProgressContext.Provider value={progressValue}'),
    `${label}Provider 必须提供 PlayerProgressContext(P1-2 拆分的进度面)`,
  );
}

const webProgress = extractMemoObjectKeys(webSource, 'PlayerContext.js', 'progressValue');
const nativeProgress = extractMemoObjectKeys(
  nativeSource, 'NativePlayerProvider.js', 'progressValue',
);
assert.deepEqual(
  webProgress,
  nativeProgress,
  '两个 Provider 的 progressValue 键集合必须一致',
);
assert.ok(
  webProgress.includes('progress') && webProgress.includes('setProgress'),
  'progressValue 必须同时含 progress 与 setProgress',
);

// ---- 3. 同一个键不得同时出现在控制面与进度面 ----
//
// 这条是**实测抓出过问题的**:P1-2 拆分时 Web 版把 setIsPaused/setProgress
// 移出了 controlValue,原生版漏改 —— 同一个 setter 同时存在两个 Context 里。
// 消费者读哪个都能拿到,但"进度更新会带动控制面重渲染"的隔离就破了。
const duplicated = webControl.filter((k) => webProgress.includes(k));
assert.deepEqual(
  duplicated,
  [],
  `以下键同时出现在 controlValue 与 progressValue,会破坏 P1-2 的重渲染隔离: ${duplicated.join(', ')}`,
);

// ---- 4. 被两次拆出来的 Provider 必须都挂在 PlayerProvider 里 ----
assert.match(
  webSource,
  /<NativePlayerProvider context=\{PlayerContext\} progressContext=\{PlayerProgressContext\}>/,
  'PlayerProvider 必须把两个 Context 都传给 NativePlayerProvider(少传一个 = 安卓端进度面整个缺失)',
);

console.log(
  'PlayerProvider 契约通过:两个实现的 controlValue 键集合完全一致'
  + `(${webControl.length} 个)、progressValue 一致`
  + `(${webProgress.length} 个)、控制面与进度面无重复键、原生 Provider 收到两个 Context。`,
);
