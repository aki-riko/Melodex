import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SLEEP_STOP_AFTER_TRACK_KEY,
  SLEEP_TIMER_PRESETS_MINUTES,
  createSleepTimer,
  formatSleepTimerRemaining,
  getSleepTimerRemainingMs,
  isSleepTimerDue,
  loadStopAfterTrackPreference,
  saveStopAfterTrackPreference,
  shouldStopAtTrackEnd,
} from '../src/contexts/playerSleepTimer.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptDir, '..');

// ============================================================
// 一、纯逻辑
// ============================================================

const NOW = 1_700_000_000_000;

assert.equal(createSleepTimer(0), null, '0 分钟不是合法定时');
assert.equal(createSleepTimer(-5), null, '负数不是合法定时');
assert.equal(createSleepTimer('abc'), null, '非数字不是合法定时');
assert.equal(createSleepTimer(null), null, 'null 不是合法定时');

const t30 = createSleepTimer(30, NOW);
assert.equal(t30.endsAt, NOW + 30 * 60 * 1000, '30 分钟应换算成毫秒');
assert.equal(t30.pendingEndOfTrack, false, '新建定时不能一开始就是待停止态');

assert.equal(getSleepTimerRemainingMs(null), 0, '没有定时时剩余为 0');
assert.equal(getSleepTimerRemainingMs(t30, NOW), 30 * 60 * 1000, '刚设定时剩余 = 全时长');
assert.equal(getSleepTimerRemainingMs(t30, NOW + 60_000), 29 * 60 * 1000, '过一分钟应少一分钟');
assert.equal(getSleepTimerRemainingMs(t30, t30.endsAt), 0, '到点剩余为 0');
assert.equal(getSleepTimerRemainingMs(t30, t30.endsAt + 999_999), 0, '过期后剩余钳到 0,不能变负数');

assert.equal(isSleepTimerDue(t30, NOW), false, '未到点不算到期');
assert.equal(isSleepTimerDue(t30, t30.endsAt), true, '恰好到点算到期');
assert.equal(isSleepTimerDue(null, NOW), false, '没有定时永远不算到期');

// 「到点后播完本首再停」:开关关着时到点也不得拦 ended。
assert.equal(shouldStopAtTrackEnd(null, true, NOW), false, '没设定时不得拦 ended');
assert.equal(shouldStopAtTrackEnd(t30, false, NOW), false, '开关关闭时定时不得拦 ended');
assert.equal(shouldStopAtTrackEnd(t30, true, NOW + 1), false, '开关开着但没到点不得拦 ended');
assert.equal(shouldStopAtTrackEnd(t30, true, t30.endsAt), true, '开关开着且到点,应在本首结束时停止');
// pendingEndOfTrack 一旦落下,后续 tick 不再依赖时钟(即使墙钟被回拨也要停)。
assert.equal(
  shouldStopAtTrackEnd({ ...t30, pendingEndOfTrack: true }, true, NOW),
  true,
  '已进入待停止态后必须无条件停,不能被时钟回拨解除',
);
assert.equal(
  shouldStopAtTrackEnd({ ...t30, pendingEndOfTrack: true }, false, NOW),
  false,
  '用户到点后关掉开关,应恢复连续播放',
);

assert.equal(formatSleepTimerRemaining(0), '0:00', '0 毫秒格式化');
assert.equal(formatSleepTimerRemaining(8_000), '0:08', '秒级补零');
assert.equal(formatSleepTimerRemaining(65_000), '1:05', '分:秒');
assert.equal(formatSleepTimerRemaining(3_600_000), '1:00:00', '满一小时切成 h:mm:ss');
assert.equal(formatSleepTimerRemaining(-1), '0:00', '负数钳到 0');
assert.equal(formatSleepTimerRemaining(NaN), '0:00', 'NaN 钳到 0');

assert.deepEqual(SLEEP_TIMER_PRESETS_MINUTES, [15, 30, 45, 60, 90, 120], '预设时长被改动需同步文档与 UI');

// 偏好持久化:默认开启,存 '0' 才算关闭,存储异常时回落默认。
const memoryStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    dump: () => Object.fromEntries(map),
  };
};
assert.equal(loadStopAfterTrackPreference(memoryStorage()), true, '缺省(没存过)应默认开启播完再停');
assert.equal(loadStopAfterTrackPreference(memoryStorage({ [SLEEP_STOP_AFTER_TRACK_KEY]: '0' })), false, '存 0 应读成关闭');
assert.equal(loadStopAfterTrackPreference(memoryStorage({ [SLEEP_STOP_AFTER_TRACK_KEY]: '1' })), true, '存 1 应读成开启');
assert.equal(
  loadStopAfterTrackPreference({ getItem() { throw new Error('blocked'); } }),
  true,
  '本地存储被禁用时必须回落默认值,不能抛给调用方',
);

const okStorage = memoryStorage();
saveStopAfterTrackPreference(false, okStorage);
assert.equal(okStorage.dump()[SLEEP_STOP_AFTER_TRACK_KEY], '0', '关闭开关应写入 0');
saveStopAfterTrackPreference(true, okStorage);
assert.equal(okStorage.dump()[SLEEP_STOP_AFTER_TRACK_KEY], '1', '开启开关应写入 1');
assert.doesNotThrow(
  () => saveStopAfterTrackPreference(true, { setItem() { throw new Error('full'); } }),
  '写入失败(配额满/隐私模式)不得影响本次会话播放',
);

// ============================================================
// 二、静态契约:面板不得被自己的透明遮罩盖住
// ============================================================
//
// 这条锁的是一个真实上线的回归(2026-10 的 z-index 语义化 sweep):
// 面板原本是「透明全屏遮罩 z-[80] + 浮层 z-[90]」,sweep 换成
// backdrop=z-drawer(60) / panel=z-popover(50),**顺序反了**。
// 遮罩是透明的,所以视觉上面板照常显示,但用户点到面板的每一下其实都点在遮罩上:
// 遮罩的 onClick 只有 setOpen(false) → 「选 30 分钟」表现为面板一闪就没了、
// 定时根本没设上,连「播完本首再停」的复选框都点不动 = 用户眼里的「自动停止失效」。
//
// 纯逻辑测试对这类 bug 是瞎的(状态机完全正确,只是点不到),所以必须静态扫源码。
const Z_LAYER = { nav: 20, tabbar: 30, bar: 40, popover: 50, drawer: 60, sheet: 70, modal: 85, toast: 90 };
const PANEL_Z = Z_LAYER.popover;

const scanBackdropVsPanel = (relPath) => {
  const source = readFileSync(resolve(frontendRoot, relPath), 'utf8')
    .split(/\r?\n/)
    // 剥行注释,避免注释里提到 z-drawer 造成误报
    .map((line) => line.replace(/\/\/.*$/, ''));
  const problems = [];
  const hasPopoverPanel = source.some((line) => /\bz-popover\b/.test(line));
  if (!hasPopoverPanel) return problems;
  source.forEach((line, idx) => {
    if (!/fixed inset-0/.test(line)) return;
    // 只认"自闭合的透明遮罩":带子元素的 fixed inset-0 是全屏页/对话框容器,不是遮罩。
    if (!/\/>\s*$/.test(line)) return;
    const m = line.match(/\bz-(nav|tabbar|bar|popover|drawer|sheet|modal|toast)\b/);
    if (!m) return;
    const value = Z_LAYER[m[1]];
    if (value > PANEL_Z) {
      problems.push(`${relPath}:${idx + 1} 透明遮罩 z-${m[1]}(${value}) 压住了同文件的 z-popover(${PANEL_Z}) 面板`);
    }
  });
  return problems;
};

const overlayProblems = [
  ...scanBackdropVsPanel('src/components/SleepTimerControl.js'),
  ...scanBackdropVsPanel('src/contexts/PlayerContext.js'),
];
assert.deepEqual(overlayProblems, [], `弹层遮罩层级倒置:\n${overlayProblems.join('\n')}`);

// 睡眠面板必须自己处理"点外面 / Esc 关闭",不能靠再插一层全屏遮罩。
const sleepSource = readFileSync(resolve(frontendRoot, 'src/components/SleepTimerControl.js'), 'utf8');
assert.ok(/pointerdown/.test(sleepSource), '睡眠面板必须监听 pointerdown 实现点击外部关闭');
assert.ok(/Escape/.test(sleepSource), '睡眠面板必须支持 Esc 关闭');
assert.ok(!/fixed inset-0/.test(sleepSource), '睡眠面板不得再自己铺全屏遮罩(历史事故根因)');

// 「选时长」必须落在预设按钮上,不能被 any overlay 提前吞掉:断言每个预设都绑定了 onStart。
assert.ok(/SLEEP_TIMER_PRESETS_MINUTES\.map/.test(sleepSource), '预设时长必须由 SLEEP_TIMER_PRESETS_MINUTES 渲染');
assert.ok(/onClick=\{\(\) => chooseMinutes\(minutes\)\}/.test(sleepSource), '每个预设按钮都必须真的调用 chooseMinutes(onStart)');
assert.ok(/onClick=\{cancel\}/.test(sleepSource), '取消按钮必须真的调用 onCancel');

console.log('playerSleepTimer tests passed');
