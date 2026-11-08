import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VOLUME_HOVER_CLOSE_DELAY_MS,
  VOLUME_HOVER_OPEN_DELAY_MS,
  VOLUME_SLIDER_STEP,
  VOLUME_WHEEL_MAX_STEPS,
  VOLUME_WHEEL_STEP,
  VOLUME_WHEEL_UNIT,
  clampVolume,
  formatVolumePercent,
  normalizeWheelDelta,
  roundVolume,
  volumeAfterSteps,
  volumeIconTier,
  wheelVolumeSteps,
} from '../src/contexts/playerVolumeControl.js';

// 音量控件的门禁(2026-11 用户报「要么大要么小」后重做)。
//
// 这一组锁的是「改了也不会报错、只是手感变差」的地方:
//   · 滚轮方向反了(往上滚变小);
//   · 触控板惯性一次划到底;
//   · 0.05 累加出 0.30000000000000004;
//   · 垂直条忘了 direction:rtl(顶端变最小);
//   · React onWheel 是 passive,preventDefault 无效 → 一边调音量一边滚页面。

// ---- 1. 夹取与取整:audio.volume 拿到 NaN 会静默失效 ----
assert.equal(clampVolume(1.7), 1);
assert.equal(clampVolume(-0.3), 0);
assert.equal(clampVolume('0.42'), 0.42);
assert.equal(clampVolume(Number.NaN), 0, 'NaN 必须退化成 0,否则赋给 audio.volume 会被静默忽略');
assert.equal(clampVolume(undefined), 0);

assert.equal(roundVolume(0.1 + 0.2), 0.3, '浮点尾巴必须抹掉,否则界面会显示 30.000000000000004%');
assert.equal(roundVolume(1.4), 1);
assert.equal(roundVolume(-1), 0);

// ---- 2. 滚轮单位归一:Firefox 用「行」为单位,不归一会慢几十倍 ----
assert.equal(normalizeWheelDelta(100, 0), 100, '像素模式原样');
assert.equal(normalizeWheelDelta(3, 1), 48, '行模式应放大到像素量级');
assert.equal(normalizeWheelDelta(1, 2), 400, '页模式应放大到整页量级');
assert.equal(normalizeWheelDelta(Number.NaN, 0), 0);
assert.equal(normalizeWheelDelta('120', 0), 120, '字符串也要能用');

// ---- 3. 滚轮累积 → 步数,方向必须与直觉一致 ----
{
  // 一格滚轮(Chrome deltaY≈100)走 2 步,正好 10%
  const one = wheelVolumeSteps(0, 100);
  assert.equal(one.steps, 2, '一格滚轮应走 2 步');
  assert.equal(one.rest, 20, '走完后应留下 20px 余量');

  // 向下滚(deltaY>0)→ 负步数(减小音量)
  assert.ok(wheelVolumeSteps(0, 100).steps > 0, '内部口径:deltaY 向下为正');
}

// ---- 4. 触控板惯性必须封顶,不能一次划到底 ----
{
  const huge = wheelVolumeSteps(0, 5000);
  assert.ok(
    Math.abs(huge.steps) <= VOLUME_WHEEL_MAX_STEPS,
    `单次事件最多 ${VOLUME_WHEEL_MAX_STEPS} 步,实际 ${huge.steps} 步 —— 不封顶时触控板惯性会瞬间拉到底`,
  );
  // 被截掉的部分不能攒着,否则松手瞬间连跳
  assert.ok(Math.abs(huge.rest) <= VOLUME_WHEEL_UNIT, '超出上限的余量必须丢弃,不能留到下一次');

  const backwards = wheelVolumeSteps(0, -5000);
  assert.equal(backwards.steps, -VOLUME_WHEEL_MAX_STEPS, '反向同样封顶');
}

// ---- 5. 余量按方向保留:反向滚动不能先多走一步 ----
{
  // 攒 30px(不足一步),再反向 30px → 应当抵消回 0 步,而不是各走一步
  const first = wheelVolumeSteps(0, 30);
  assert.equal(first.steps, 0, '不足一个单位的位移不应走步');
  const back = wheelVolumeSteps(first.rest, -30);
  assert.equal(back.steps, 0, '反向抵消时不应产生步数,否则轻轻来回晃就会改变音量');
  assert.equal(back.rest, 0);
}

// ---- 6. 步数 → 音量,并夹在 [0,1] ----
assert.equal(volumeAfterSteps(0.5, 1), 0.55, '一步 = 5%');
assert.equal(volumeAfterSteps(0.5, -1), 0.45);
assert.equal(volumeAfterSteps(1, 5), 1, '上限必须夹住');
assert.equal(volumeAfterSteps(0, -5), 0, '下限必须夹住');
assert.equal(volumeAfterSteps(0.5, 0), 0.5, '0 步不改动');
// 连加 20 次一步,结果必须干净
{
  let v = 0;
  for (let i = 0; i < 20; i += 1) v = volumeAfterSteps(v, 1);
  assert.equal(v, 1, '20 步(100%)后应正好到 1,不能是 0.9999999');
  assert.equal(String(v).includes('9'), false, '浮点尾巴必须消失');
}

// ---- 7. 百分比文案四舍五入 ----
assert.equal(formatVolumePercent(0), '0%');
assert.equal(formatVolumePercent(0.639), '64%');
assert.equal(formatVolumePercent(1), '100%');
assert.equal(formatVolumePercent(1.9), '100%', '越界值先夹取再格式化');

// ---- 8. 图标档位与旧行为一致(0 → X,<0.5 → 单波,否则双波) ----
assert.equal(volumeIconTier(0), 'muted');
assert.equal(volumeIconTier(-1), 'muted');
assert.equal(volumeIconTier(0.49), 'low');
assert.equal(volumeIconTier(0.5), 'high');
assert.equal(volumeIconTier(1), 'high');

// ---- 9. 时序常量必须合理 ----
assert.ok(VOLUME_HOVER_OPEN_DELAY_MS > 0, '悬停立即弹出会误触,需要极短延时挡掉划过');
assert.ok(VOLUME_HOVER_OPEN_DELAY_MS < 300, `弹出延时 ${VOLUME_HOVER_OPEN_DELAY_MS}ms 太长,用户会觉得没反应`);
assert.ok(
  VOLUME_HOVER_CLOSE_DELAY_MS >= 200,
  `收起延时 ${VOLUME_HOVER_CLOSE_DELAY_MS}ms 太短 —— 鼠标从图标移到面板途中会先关掉,永远够不到滑块`,
);
assert.equal(VOLUME_SLIDER_STEP, 0.01, '滑块步进 = 1%,与滚轮 5%/格形成粗细两档');

// ---- 10. 源码契约:滚轮必须用原生非被动监听 ----
//
// React 17+ 把 wheel 事件挂在 root 容器上并且**默认 passive**
// (react-dom.development.js: `domEventName === 'wheel'` → isPassiveListener = true)。
// 所以在 onWheel 里 preventDefault() 无效:面板开着滚滚轮会**一边改音量一边滚页面**。
// 这条断言锁死实现方式,防止后人为了"简洁"改回 onWheel。
const componentSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/components/VolumeControl.js'),
  'utf8',
);
// 断言前先剥掉注释:文件头恰恰**写明**了"不要用 onWheel",不剥会自我误报
// —— 让门禁因为自己的说明文字而失败,是最没意义的失败。
const componentCode = componentSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

assert.ok(
  /addEventListener\(\s*'wheel'[\s\S]{0,80}\{\s*passive:\s*false\s*\}/.test(componentCode),
  "滚轮必须用 addEventListener('wheel', …, { passive: false }) —— React 的 onWheel 是 passive 监听,preventDefault 无效",
);
assert.ok(
  // 精确匹配 **JSX 属性**写法(onWheel={...}),而不是任何出现 onWheel 的地方 ——
  // 原生监听的回调函数本身就叫 onWheel,粗匹配会把自己的实现当成违规。
  !/\bonWheel\s*=\s*\{/.test(componentCode),
  '不要用 JSX 的 onWheel={…} 处理音量滚轮:它是 passive 监听,preventDefault 无效',
);
assert.ok(
  /removeEventListener\(\s*'wheel'/.test(componentCode),
  '原生监听必须在清理函数里移除,否则重复挂载会叠出多份(滚动时音量按倍数跳)',
);
assert.ok(
  /if\s*\(!open\)\s*return/.test(componentCode),
  '面板没开时不得拦截滚轮 —— 否则鼠标划过播放条就让页面滚不动了',
);

// ---- 11. 源码契约:垂直滑块必须 direction:rtl ----
//
// 只写 writing-mode: vertical-lr 时,默认 ltr 会让**顶端是最小值**:
// 用户往上拖,音量反而变小 —— 方向反了,但界面看起来完全正常。
const css = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.css'),
  'utf8',
);
const verticalRule = css.match(/\.volume-slider-vertical\s*\{([\s\S]*?)\n\}/);
assert.ok(verticalRule, 'index.css 缺少 .volume-slider-vertical 规则');
const verticalBody = verticalRule[1];
assert.match(verticalBody, /writing-mode\s*:\s*vertical-lr/, '垂直滑块必须用 writing-mode 实现(rotate 会破坏布局占位)');
assert.match(
  verticalBody,
  /direction\s*:\s*rtl/,
  '必须配 direction: rtl —— 否则顶端是最小值,往上拖反而变小(方向反了界面也看不出来)',
);
assert.match(verticalBody, /height\s*:\s*[\d.]+rem/, '必须给固定高度,否则 flex 子项没有可拖的行程');

// ---- 12. 源码契约:两处旧水平音量条必须已移除 ----
const playerSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/contexts/PlayerContext.js'),
  'utf8',
);
assert.match(playerSource, /from '\.\.\/components\/VolumeControl'/, 'PlayerContext 必须导入新的 VolumeControl');
assert.equal(
  (playerSource.match(/<VolumeControl\b/g) || []).length,
  2,
  '底部播放条与全屏播放页各一处,共 2 处 —— 少一处说明有一端还留着旧的短条',
);
assert.ok(
  !/aria-label="音量"[\s\S]{0,200}type="range"/.test(playerSource),
  'PlayerContext 里不应再出现水平音量 range —— 已统一收敛到 VolumeControl',
);

// ---- 13. 源码契约:鼠标点击静音不得顺带弹出面板 ----
//
// 真实踩坑(本鱼自查时发现):onFocus 无条件 setOpen(true) 时,鼠标点喇叭
// 会让按钮获得焦点 → 面板紧跟着弹出来。用户只想静音,却多出一个浮层。
// 修法是只认 :focus-visible(浏览器区分键盘聚焦/鼠标聚焦的标准判据)。
{
  const focusBlock = componentCode.match(/const handleFocus = useCallback\([\s\S]*?\}, \[[^\]]*\]\);/);
  assert.ok(focusBlock, '找不到 handleFocus 定义(布局已改?请同步更新本断言)');
  assert.match(
    focusBlock[0],
    /:focus-visible/,
    'onFocus 必须用 :focus-visible 过滤:否则鼠标点一下静音就会顺带弹出面板',
  );
  // 守卫必须在 setOpen 之前:判断写在 setOpen 后面等于没判断
  const guardIndex = focusBlock[0].indexOf(':focus-visible');
  const openIndex = focusBlock[0].indexOf('setOpen(true)');
  assert.ok(openIndex > guardIndex, 'setOpen(true) 必须在 :focus-visible 判断之后');
}

// ---- 14. 源码契约:面板必须朝安全的一侧弹出 ----
//
// 两个调用点(底部播放条、全屏播放页底部控制行)都贴着屏幕底边。
// 向下弹 = 面板跑到屏幕外,用户以为"点了没反应"。
assert.match(
  componentCode,
  /openUp\s*=\s*true/,
  'openUp 默认必须为 true —— 两处调用点都靠屏幕底部,向下弹会出屏',
);
assert.ok(
  // 这里查**原始源码**而不是剥注释版:该表达式含模板字符串,正则化的注释剥离
  // 可能吃掉字符串片段(本鱼自己就踩了一次),换成带注释的原文更可靠。
  /openUp\s*\?\s*'bottom-full/.test(componentSource),
  "openUp 分支必须用 bottom-full(向上弹)",
);

// ---- 15. 源码契约:音量按钮与队列按钮必须同尺寸 ----
//
// 来自用户真机截图反馈「这俩对齐啊」:喇叭图标比右边的队列图标高一点点。
// 逐像素量过(2323×1443 截图,播放条内 y[1376,1412]):
//   上一首 / 下一首 / 播放模式 cy≈1393.5  ← 播放条的真实基线
//   音量喇叭        cy≈1394.5  (+1.0)
//   队列            cy≈1389.0  (-4.5) ← 偏得最多
// 根因不是图标本身,而是**按钮盒子没有高度**:盒高 == 图标高(18~23px),
// 父级 items-center 只能把这坨矮盒子居中,与其他 44px 控件对不齐。
// 修法是把两个按钮都改成 44×44(h-11 w-11,仓库里图标按钮的通行尺寸)。
{
  assert.match(
    componentCode,
    /className="[^"]*\bh-11\b[^"]*\bw-11\b|className="[^"]*\bw-11\b[^"]*\bh-11\b/,
    '音量触发按钮必须有固定 44×44 盒子(h-11 w-11)——否则盒高只有图标高,与相邻控件对不齐',
  );

  // 队列按钮在 PlayerContext 里,必须同尺寸
  const queueButton = playerSource.match(/aria-label="播放队列"[\s\S]{0,80}/);
  assert.ok(queueButton, '找不到播放队列按钮(文案改过?请同步更新本断言)');
  const queueChunk = playerSource.slice(
    Math.max(0, playerSource.indexOf('aria-label="播放队列"') - 400),
    playerSource.indexOf('aria-label="播放队列"'),
  );
  assert.match(
    queueChunk,
    /\bh-11\b[\s\S]{0,60}\bw-11\b|\bw-11\b[\s\S]{0,60}\bh-11\b/,
    '队列按钮也必须 h-11 w-11 —— 它与音量按钮相邻,两者盒高不同就会错位(用户已截图反馈)',
  );
}

console.log('playerVolumeControl tests passed');
