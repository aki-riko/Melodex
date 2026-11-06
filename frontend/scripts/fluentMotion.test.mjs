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

// ---- 5. 时长上限 ----
// 超过 300ms 的进入动效会让"每次切页都要等"。marquee/vinyl 这类无限循环不算。
const motionDecls = [...css.matchAll(/animation\s*:\s*fluent-[a-z-]+\s+([^;]+);/g)].map((m) => m[1]);
for (const decl of motionDecls) {
  const match = decl.match(/(\d+)ms/);
  if (match) {
    assert.ok(
      Number(match[1]) <= 300,
      `Fluent 进入动效 ${decl.trim()} 超过 300ms —— 切页会有明显等待感`,
    );
  }
  // 用 token 的写法(如 var(--motion-base)=180ms)天然在范围内,不额外校验。
}

// ---- 6. 页面切换动效必须**看得出** ----
// 用户真机反馈"切换左侧项时没动画"。静态检查全过、CSS 也在产物里,
// 真实原因只是**幅度太弱**:第一版 6px / 180ms 在手机上不足 0.25% 高度、11 帧就过去了,
// 主观上等于没有。这条锁住下限,防止以后又被"优化"回去。
{
  const pageKeyframe = css.match(/@keyframes fluent-page-enter\s*\{([\s\S]*?)\n\}/);
  assert.ok(pageKeyframe, '找不到 @keyframes fluent-page-enter');
  const body = pageKeyframe[1];

  const shift = body.match(/translateY\((\d+)px\)/);
  assert.ok(shift, 'page-enter 必须有位移(纯淡入太弱,看不出"换页")');
  assert.ok(
    Number(shift[1]) >= 10,
    `page-enter 位移只有 ${shift[1]}px,太小 —— 手机上肉眼几乎看不出。实测 6px 时用户直接反馈"没动画"`,
  );

  // 时长:用 token 时要确认该 token 够长(>=200ms),否则再大的位移也一闪而过
  const pageRule = css.match(/\.fluent-page-enter\s*\{([^}]*)\}/);
  assert.ok(pageRule, '找不到 .fluent-page-enter 规则');
  const duration = pageRule[1].match(/var\(--motion-([a-z]+)\)/);
  assert.ok(duration, 'page-enter 应使用 motion token 而非字面量');
  const tokenValue = css.match(new RegExp(`--motion-${duration[1]}\\s*:\\s*(\\d+)ms`));
  assert.ok(tokenValue, `找不到 --motion-${duration[1]} 的毫秒值`);
  assert.ok(
    Number(tokenValue[1]) >= 200,
    `page-enter 时长只有 ${tokenValue[1]}ms —— 配合位移仍会"一闪而过",建议 >=200ms`,
  );
}

console.log('fluentMotion tests passed');
