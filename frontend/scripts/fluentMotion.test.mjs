import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptDir, '..');
const srcRoot = resolve(frontendRoot, 'src');

// Fluent 动效契约。
//
// 为什么要有:动画是最容易"写了等于没写"的一类样式 ——
//   · @keyframes 定义了但没类名引用 → 死代码,没人看得见;
//   · 类名写进 JSX 但 CSS 里没有 → 完全静默,页面就是不动;
//   · 忘了 reduced-motion 降级 → 对"减少动态效果"用户是伤害;
//   · 用 width/height/top 做动画 → 每帧布局重排,低端安卓上肉眼可见地卡。
// 这些构建全部不报错。所以这里静态锁死。

const css = readFileSync(resolve(srcRoot, 'index.css'), 'utf8');

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.(js|jsx)$/.test(entry)) out.push(abs);
  }
  return out;
};
const sources = walk(srcRoot).map((f) => readFileSync(f, 'utf8')).join('\n');

// ---- 1. 定义在 CSS 里的 Fluent 动效类,必须真的被用到 ----
const fluentMotionClasses = [
  'fluent-page-enter',
  'fluent-item-enter',
  'fluent-flyout-in',
  'fluent-pressable',
];

for (const cls of fluentMotionClasses) {
  assert.ok(css.includes(`.${cls}`), `index.css 缺少 .${cls} 定义`);
}
// 只要求"页面切换"和"飞入"两档被实际使用 —— 另外两档是可选工具类,
// 将来用在列表项/按钮上,现在没用到不算错(但定义必须存在)。
for (const cls of ['fluent-page-enter', 'fluent-flyout-in']) {
  assert.ok(
    sources.includes(cls),
    `.${cls} 在 index.css 有定义但源码里没有任何地方使用 —— 动画写了等于没写`,
  );
}

// ---- 2. 每个 @keyframes 都必须有类名或 animation 引用 ----
// 防止删改后留下没人用的关键帧(死代码会让人误以为"这里还有动画")
const keyframeNames = [...css.matchAll(/@keyframes\s+([a-z0-9-]+)/gi)].map((m) => m[1]);
for (const name of keyframeNames) {
  // 该关键帧要么被 CSS 的 animation 引用,要么被 JS 的 animation 引用
  const usedInCss = new RegExp(`animation(-name)?\\s*:[^;]*\\b${name}\\b`).test(css);
  if (!usedInCss) {
    assert.fail(`@keyframes ${name} 没有被任何 animation 引用 —— 死代码`);
  }
}

// ---- 3. reduced-motion 必须覆盖全部 Fluent 动效 ----
const reducedBlock = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
assert.ok(reducedBlock.length > 0, 'index.css 缺少 prefers-reduced-motion 降级块');
for (const cls of fluentMotionClasses) {
  // 降级块里有全局 animation-duration:1ms !important 兜底,
  // 但显式列出更清楚,也防止那条全局规则将来被误删。
  const explicitlyCovered = reducedBlock.includes(`.${cls}`) || cls === 'fluent-pressable';
  assert.ok(
    explicitlyCovered,
    `reduced-motion 降级块没有覆盖 .${cls} —— 减少动态效果的用户仍会看到动画`,
  );
}
assert.ok(
  /animation-duration:\s*1ms\s*!important/.test(reducedBlock),
  'reduced-motion 必须有一条全局 animation-duration 兜底 —— 否则以后新增动画会自动漏网',
);

// ---- 4. 动效不得用触发布局的属性 ----
// width/height/top/left/margin 做动画会每帧重排。
// 用括号配对精确取出每个 @keyframes 的主体,避免被嵌套块截断。
const layoutProps = /(?:^|\s|\{)(width|height|top|left|right|bottom|margin)\s*:/;
{
  const marker = /@keyframes\s+([a-z0-9-]+)\s*\{/gi;
  let m;
  while ((m = marker.exec(css)) !== null) {
    const name = m[1];
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close < 0) continue;
    const body = css.slice(open + 1, close);
    assert.ok(
      !layoutProps.test(body),
      `@keyframes ${name} 用了触发布局的属性(width/height/top/left/margin)—— 低端机会卡`,
    );
  }
}

// ---- 5. 时长上限(分两类,不能一刀切)----
//
// 原来统一限 300ms,但那条规则的**动机**是"每次切页都要等" ——
// 它针对的是**交互反馈类**动效(切页、浮层、按下),不是列表展示类。
//
// 列表项恰恰相反:用户明确要求"慢一点、有层次",420ms 才看得清"划入"的过程。
// 把两类混在一起会产生矛盾(self-conflict):为了让列表慢下来就得放宽上限,
// 而放宽上限又会让切页变得拖沓。所以分开校验。
const INTERACTIVE_MAX = 300;   // 反馈类:超过就有"等"的感觉
const SHOWCASE_MAX = 600;      // 展示类:可慢,但不能拖沓

// 展示类白名单:这些动画靠"过程"传达信息(列表依次划入),允许更长
const SHOWCASE = new Set(['fluent-list-item-in']);

const motionDecls = [...css.matchAll(/animation\s*:\s*(fluent-[a-z-]+)\s+([^;]+);/g)]
  .map((m) => ({ name: m[1], decl: m[2] }));
for (const { name, decl } of motionDecls) {
  const match = decl.match(/(\d+)ms/);
  if (!match) continue; // 用 token 的(如 var(--motion-base)=180ms)天然在范围内
  const ms = Number(match[1]);
  const limit = SHOWCASE.has(name) ? SHOWCASE_MAX : INTERACTIVE_MAX;
  assert.ok(
    ms <= limit,
    `${name} 时长 ${ms}ms 超过上限 ${limit}ms` +
    (SHOWCASE.has(name) ? '(展示类可慢,但 >600ms 会明显拖沓)' : '(交互反馈类 >300ms 会让用户觉得"每次都要等")'),
  );
}

// ---- 6. 页面切换必须是**错峰淡入**,且看得出 ----
//
// 这个设计换过三次,每次的教训都不同:
//   ① 6px/180ms 位移    → 用户"没动画"(幅度太弱)
//   ② 14px/280ms + 缩放 → 用户"动画不太对"(位移像把整块内容推了一下,
//      而同级页面切换本没有方向语义)
//   ③ 错峰淡入(当前)  → 标题先、内容后,靠**层次**而非位移制造可感知度
//
// 所以这条不再要求"位移够大",而是要求:
//   · 容器有淡入;
//   · 子元素错峰(第 2 个起有 delay),这是本设计的核心;
//   · 时长 >=160ms(太短仍是"眨一下就没了");
//   · 位移保持在**很小**的范围(≤6px)—— 大了又变回"被推一下"。
{
  // 容器淡入必须存在
  assert.ok(
    /\.fluent-page-enter\s*\{[^}]*animation:\s*fluent-page-fade/.test(css),
    'page-enter 容器应当用淡入(fluent-page-fade)',
  );

  // 错峰:必须覆盖**两层**,且 delay 加在内部块那一层
  //
  // 这里踩过一个真坑:一开始只写 `.fluent-page-enter > *`,
  // 结果每个页面组件的根节点都是单个 <div>,`:nth-child(n+2)` 根本没有对象,
  // 错峰等于没写 —— 连续三次调参都没效果,真因在这个层级上。
  const firstLayer = css.match(/\.fluent-page-enter\s*>\s*\*\s*[,{]/);
  const secondLayer = css.match(/\.fluent-page-enter\s*>\s*\*\s*>\s*\*/);
  assert.ok(firstLayer, '`> *` 层缺失');
  assert.ok(
    secondLayer,
    '`> * > *` 层缺失 —— 页面组件根节点是单个 div,只写 `> *` 的话错峰没有作用对象',
  );

  const innerDelay = css.match(/\.fluent-page-enter\s*>\s*\*\s*>\s*\*:nth-child\(n\s*\+\s*2\)\s*\{\s*animation-delay:\s*(\d+)ms/);
  assert.ok(innerDelay, '缺少内部块的 delay 定义(它是错峰真正的执行者)');
  assert.ok(
    Number(innerDelay[1]) > 0,
    '内部块 delay 必须 > 0,否则等于没有错峰',
  );
  assert.ok(
    Number(innerDelay[1]) <= 120,
    `内部块延迟 ${innerDelay[1]}ms 太大 —— 页面会有"内容跟不上"的迟滞感,建议 40~90ms`,
  );

  // 位移保持在很小的范围:大了又会变成"被推一下"
  const riseKeyframe = css.match(/@keyframes fluent-page-rise\s*\{([\s\S]*?)\n\}/);
  assert.ok(riseKeyframe, '找不到 @keyframes fluent-page-rise');
  const shift = riseKeyframe[1].match(/translateY\((\d+)px\)/);
  if (shift) {
    assert.ok(
      Number(shift[1]) <= 6,
      `错峰动画的位移 ${shift[1]}px 过大 —— 本设计靠层次而非位移,超过 6px 又会变成"整块被推一下"`,
    );
  }

  // 时长下限:太短仍是"眨一下就没了"
  const tokenMatch = css.match(/--motion-base\s*:\s*(\d+)ms/);
  assert.ok(tokenMatch, '找不到 --motion-base');
  assert.ok(
    Number(tokenMatch[1]) >= 160,
    `--motion-base 只有 ${tokenMatch[1]}ms,淡入会"一闪而过"`,
  );
}

// ---- 7. 选中竖条只能有一处来源 ----
//
// 真实事故:强调竖条早已由 index.css 的 `[aria-current="page"]::before` 统一提供
// (纯 CSS 增强,全站生效)。本鱼没查到它,又在 Sidebar 里手加了一条
// `<span class="... bg-primary">` 做滑入动画 —— 结果侧栏出现**两条并排的竖条**,
// 用户直接截图反馈"而且咋俩条"。
//
// 这条锁住:"竖条"这个视觉只能由 CSS 伪元素提供,组件里不得再画一个。
{
  const pillarInComponent = /bg-primary[^"'`]*w-\[3px\]|w-\[3px\][^"'`]*bg-primary/;
  assert.ok(
    !pillarInComponent.test(sources),
    '组件里出现了 3px 的 primary 竖条 —— 它与 [aria-current="page"]::before 会重叠成两条。' +
    '选中竖条只应由 index.css 的伪元素提供',
  );
  // 伪元素那条必须还在
  assert.ok(
    /\[aria-current="page"\]::before\s*\{/.test(css),
    'index.css 必须保留 [aria-current="page"]::before 作为竖条的唯一来源',
  );
}

// ---- 8. 歌曲列表:从右往左滑入 + 从上到下依次出现 ----
//
// 用户明确要求的效果(「从上到下依次加载并从右往左划入」),全站歌曲列表统一。
// 实现是挂在 `.space-y-0.5` 容器上的 —— 核查过 8 处用法,全部是歌曲列表容器,
// 所以不需要给 7 个页面各加类名。
{
  const listKeyframe = css.match(/@keyframes fluent-list-item-in\s*\{([\s\S]*?)\n\}/);
  assert.ok(listKeyframe, '缺少 fluent-list-item-in(歌曲列表滑入动画)');
  const body = listKeyframe[1];

  // 方向必须是"从右往左" = 起始时位于右侧(x 为正),结束时归位
  assert.ok(
    /translateX\(\s*[1-9]\d*px\s*\)/.test(body),
    '列表项动画必须是 translateX 正值(从右侧划入)。用 Y 轴就变成"从上往下浮起",不是用户要的方向',
  );

  // 位移幅度要克制:太大在长列表上会眼花
  const shift = body.match(/translateX\(\s*(\d+)px\s*\)/);
  assert.ok(Number(shift[1]) <= 40, `列表滑入位移 ${shift[1]}px 过大,长列表上会眼花(建议 ≤32px)`);

  // 容器钩子必须存在,且作用于直接子元素
  assert.ok(
    /\.space-y-0\\\.5\s*>\s*\*/.test(css),
    '缺少 .space-y-0.5 > * 的动画规则 —— 歌曲列表拿不到效果',
  );

  // 必须封顶,且封顶必须**紧接最后一条单项规则**(不能留空档)
  //
  // 踩过的坑:单项写到 nth-child(9),封顶却写成 `n + 12`,
  // 于是第 10、11 项拿不到任何 delay → 按 0ms 立刻出现,比第 2 项还早,
  // 列表顺序整个乱掉。所以这里断言封顶的起始下标 == 单项规则数 + 1。
  const singles = [...css.matchAll(/\.space-y-0\\\.5\s*>\s*\*:nth-child\((\d+)\)\s*\{\s*animation-delay:\s*(\d+)ms/g)]
    .map((m) => ({ n: Number(m[1]), delay: Number(m[2]) }))
    .sort((a, b) => a.n - b.n);
  assert.ok(singles.length >= 5, '单项延迟规则太少,列表层次感不足');

  const capped = css.match(/\.space-y-0\\\.5\s*>\s*\*:nth-child\(n\s*\+\s*(\d+)\)\s*\{\s*animation-delay:\s*(\d+)ms/);
  assert.ok(
    capped,
    '缺少封顶规则(:nth-child(n+N))。不封顶时 100 首的列表最后一行要等 2 秒以上,看着像卡死',
  );
  const capStart = Number(capped[1]);
  const capDelay = Number(capped[2]);
  const lastSingle = singles[singles.length - 1];

  assert.strictEqual(
    capStart,
    lastSingle.n + 1,
    `封顶从第 ${capStart} 项开始,但单项规则只写到第 ${lastSingle.n} 项 —— ` +
    `第 ${lastSingle.n + 1}~${capStart - 1} 项拿不到 delay,会按 0ms 立刻出现,列表顺序会乱`,
  );
  assert.ok(
    capDelay > lastSingle.delay,
    `封顶延迟(${capDelay}ms)必须大于最后一条单项(${lastSingle.delay}ms),否则后段会"抢跑"`,
  );

  // 逐项递增,间隔要够大才看得出层次(用户反馈"太快了"后从 22ms 提到 90ms)
  for (let i = 1; i < singles.length; i += 1) {
    const step = singles[i].delay - singles[i - 1].delay;
    assert.ok(
      step > 0,
      `第 ${singles[i].n} 项的延迟(${singles[i].delay}ms)没有大于上一项 —— 递进关系断了`,
    );
    assert.ok(
      step >= 50,
      `相邻两项只差 ${step}ms —— 这个间隔下"依次出现"会被看成"整片一起淡入"(用户实测 22ms 即如此)`,
    );
    assert.ok(step <= 120, `相邻两项差 ${step}ms 太大,列表会出现明显排队感`);
  }

  // 总量封顶:最后一批出现的时刻不应超过 1.5s
  assert.ok(
    capDelay <= 1500,
    `封顶延迟 ${capDelay}ms 过大 —— 列表末尾要等太久`,
  );

  // 单项动画时长:太短会"一闪而过"(用户反馈"太快")
  const durationMatch = css.match(/\.space-y-0\\\.5\s*>\s*\*\s*\{[^}]*animation:\s*fluent-list-item-in\s+(\d+)ms/);
  assert.ok(durationMatch, '列表项动画应写明毫秒时长(便于校验)');
  assert.ok(
    Number(durationMatch[1]) >= 300,
    `列表项动画只有 ${durationMatch[1]}ms —— 用户实测这个速度下看不清"划入"的过程,建议 ≥400ms`,
  );
  assert.ok(Number(durationMatch[1]) <= 600, `列表项动画 ${durationMatch[1]}ms 过慢,会有拖沓感`);
}

console.log('fluentMotion tests passed');
