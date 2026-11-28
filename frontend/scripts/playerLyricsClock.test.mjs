import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  LYRICS_ANCHOR_TOLERANCE_SECONDS,
  LYRICS_PROGRESS_INTERVAL_MS,
  liveLyricsPosition,
  nextLyricsProgressDelay,
} from '../src/contexts/playerLyricsClock.js';

// 门禁兜的是「桌面歌词逐字歌词行首回弹一下」(2026-11-28 用户报)。
//
// 机理(离线重放真实 overlay.js + 真实推送时序实测):
//   推给歌词窗的位置是 timeupdate 的**采样值**,最多滞后 250ms;
//   而 progress 包的 250ms 定时器会因 effect 依赖 progress.cur 被反复重建,
//   实测 50s 只发出 2 个包 —— 于是歌词窗只能靠"行首整包"改锚点,
//   新锚点比正在外推的位置旧 → 位置往回拨 250ms → 填色后退(行首最明显)。
//
// 这里锁两件事:
//   ① liveLyricsPosition 必须报**当前**位置,而不是陈旧的 state;
//   ② nextLyricsProgressDelay 必须保证推送节奏不会被 effect 重建吞掉。

// ---- 1. 播放中:必须取音频元素当前时间(而不是界面上陈旧的进度) ----
{
  const position = liveLyricsPosition({
    audio: { currentTime: 42.7 },
    paused: false,
    resume: null,
    pending: false,
    fallback: 40, // 界面上显示的还是 40s(timeupdate 采样滞后)
  });
  assert.equal(position, 42.7, '播放中必须报音频的真实 currentTime，不能报滞后 2.7s 的界面进度');
}

// ---- 2. 暂停:取兜底值(界面正在显示的位置),不取可能被夹住的 currentTime ----
{
  const position = liveLyricsPosition({
    audio: { currentTime: 41.2 },
    paused: true,
    fallback: 42.7,
  });
  assert.equal(position, 42.7, '暂停时用界面位置，避免 currentTime 被夹到缓冲边界造成跳动');
}

// ---- 3. 跳转后未追上:必须报跳转目标 ----
{
  const position = liveLyricsPosition({
    audio: { currentTime: 12 }, // 音频还停在旧位置
    paused: false,
    resume: 90,
    fallback: 90,
  });
  assert.equal(position, 90, '跳转闸门期间必须报目标位置，否则歌词会跳回旧位置');
}

// ---- 4. 拖动中:只认拇指 ----
{
  const position = liveLyricsPosition({
    audio: { currentTime: 12 },
    paused: false,
    resume: null,
    pending: true,
    fallback: 88,
  });
  assert.equal(position, 88, '拖动中报拇指位置，播放器报的是拖动前的位置');
}

// ---- 5. 退化输入一律不产生 NaN / 负数 ----
{
  for (const bad of [
    { audio: null },
    { audio: { currentTime: Number.NaN }, paused: false },
    { audio: { currentTime: -5 }, paused: false },
    { audio: undefined, fallback: Number.NaN },
    {},
  ]) {
    const value = liveLyricsPosition(bad);
    assert.ok(Number.isFinite(value), `退化输入 ${JSON.stringify(bad)} 必须返回有限数，实际 ${value}`);
    assert.ok(value >= 0, `退化输入不得返回负数，实际 ${value}`);
  }
}

// ---- 6. 推送节奏:未被节流时按间隔等满 ----
{
  assert.equal(LYRICS_PROGRESS_INTERVAL_MS, 250, '锚点刷新间隔固定 250ms，与既有实现一致');
  assert.equal(
    nextLyricsProgressDelay({ intervalMs: 250, elapsedMs: 0 }),
    250,
    '刚发过一个包，下一次要等满 250ms',
  );
  assert.equal(
    nextLyricsProgressDelay({ intervalMs: 250, elapsedMs: 100 }),
    150,
    '已经过了 100ms，只补等剩下的 150ms',
  );
}

// ---- 7. 被后台节流/掉帧后不得疯狂补发 ----
{
  const delay = nextLyricsProgressDelay({ intervalMs: 250, elapsedMs: 5000 });
  assert.equal(delay, 16, '已经超时很久时立刻补一次，但仍让出 16ms 给主线程');
  assert.ok(
    nextLyricsProgressDelay({ intervalMs: 250, elapsedMs: 5000 }) > 0,
    '补发也必须 > 0，否则会同步递归把主线程打满',
  );
}

// ---- 8. 退化参数:非法间隔/耗时不得返回负数或 NaN ----
{
  for (const args of [
    { intervalMs: Number.NaN, elapsedMs: 0 },
    { intervalMs: 10, elapsedMs: 0 },
    { intervalMs: 250, elapsedMs: Number.NaN },
    { intervalMs: 250, elapsedMs: -100 },
    {},
  ]) {
    const delay = nextLyricsProgressDelay(args);
    assert.ok(Number.isFinite(delay), `退化参数 ${JSON.stringify(args)} 必须返回有限数，实际 ${delay}`);
    assert.ok(delay >= 0, `退化参数不得返回负数，实际 ${delay}`);
  }
}

// ---- 9. 单调保护容差必须是"远小于一个 timeupdate 周期"的量级 ----
{
  assert.ok(
    LYRICS_ANCHOR_TOLERANCE_SECONDS > 0 && LYRICS_ANCHOR_TOLERANCE_SECONDS < 0.1,
    `锚点容差必须很小(实测回退是 250ms 级)，实际 ${LYRICS_ANCHOR_TOLERANCE_SECONDS}`,
  );
}

// ---- 10. 静态契约:PlayerContext 不得再把闭包里的陈旧 progress.cur 当位置推出去 ----
{
  const source = await readFile(new URL('../src/contexts/PlayerContext.js', import.meta.url), 'utf8');
  assert.ok(
    source.includes('liveLyricsPosition'),
    'PlayerContext 必须用 liveLyricsPosition 取实时位置(否则报的还是滞后 250ms 的采样值)',
  );
  assert.ok(
    source.includes('readLyricsPosition'),
    '位置必须经 Provider 的 readLyricsPosition() 取 —— resumeRef/scrubRef 只有 Provider 持有',
  );
  assert.ok(
    source.includes('nextLyricsProgressDelay'),
    'PlayerContext 必须用 nextLyricsProgressDelay 自调度推送节奏'
      + '(setInterval 会被 progress.cur 的 effect 重建吞掉，实测 50s 只发 2 个包)',
  );
  // 整包与进度包都不得直接写 position: progress.cur
  assert.doesNotMatch(
    source,
    /desktopLyricsTrackMessage\(\{[\s\S]{0,400}?position:\s*progress\.cur/,
    '整包不得直接上报 progress.cur(陈旧采样)，必须走 readLyricsPosition',
  );
  assert.doesNotMatch(
    source,
    /desktopLyricsProgressMessage\(\{[\s\S]{0,400}?position:\s*progress\.cur/,
    '进度包不得直接上报 progress.cur(陈旧采样)，必须走 readLyricsPosition',
  );
  // ★ 回归护栏：setInterval 版本的进度推送必须彻底消失
  assert.doesNotMatch(
    source,
    /setInterval\(\(\)\s*=>\s*\{[\s\S]{0,400}?desktopLyricsProgressMessage/,
    '进度包不得回到 setInterval —— 它的 effect 依赖 progress.cur，会被 4Hz 重建吞掉',
  );
}

console.log('playerLyricsClock.test.mjs: all assertions passed');
