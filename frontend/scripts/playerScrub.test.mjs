import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MAX_SCRUB_DURATION_MS,
  SEEK_ARRIVAL_TOLERANCE_SECONDS,
  SEEK_SETTLE_TIMEOUT_MS,
  armSeekTarget,
  beginScrub,
  createScrubState,
  endScrub,
  isScrubbingActive,
  resetScrubState,
  shouldApplyProgressReport,
} from '../src/contexts/playerScrub.js';

// 门禁兜的是「拖动进度条会回弹」这个真实回归(2026-11 用户报,Android + PWA 都有)。
//
// 回弹的机理很朴素:用户把拇指拖到 90s,seek() 只改了界面状态,而播放器
// 真实位置还在 12s;下一秒播放器按时报时(Web 的 timeupdate / 原生 500ms 轮询)
// 把 12s 写回界面 → 进度条跳回 12s。所以这里锁死的是仲裁规则本身:
// 拖动中只认拇指、跳转后压住旧位置、到位或超时必须放行。

// ---- 1. 初始状态:没有闸门时一切照旧 ----
{
  const state = createScrubState();
  assert.equal(state.dragging, false);
  assert.equal(state.seekTarget, null);
  assert.equal(shouldApplyProgressReport(state, 12), true, '无闸门时正常跟随播放器报时');
  assert.equal(shouldApplyProgressReport(state, Number.NaN), false, '非法报时不得写入进度');
  assert.equal(shouldApplyProgressReport(state, -1), false, '负数报时不得写入进度');
}

// ---- 2. 拖动中:只认拇指,播放器报时一律丢弃(回弹的主因) ----
{
  const state = createScrubState();
  beginScrub(state);
  assert.equal(state.dragging, true);
  assert.equal(shouldApplyProgressReport(state, 12), false, '拖动中播放器报的旧位置必须被丢弃');
  assert.equal(shouldApplyProgressReport(state, 90), false, '拖动中即便碰巧等于拇指位置也由界面决定');
  endScrub(state);
  assert.equal(shouldApplyProgressReport(state, 12), true, '松手后恢复跟随');
}

// ---- 3. 跳转闸门:压住旧位置,报到目标附近才放行 ----
{
  const state = createScrubState();
  const now = 1_000_000;
  armSeekTarget(state, 90, now);
  assert.equal(state.seekTarget, 90);
  assert.equal(state.seekDeadline, now + SEEK_SETTLE_TIMEOUT_MS);

  assert.equal(
    shouldApplyProgressReport(state, 12, now + 100),
    false,
    '跳转后播放器还在报旧位置 → 丢弃,这就是用户看到的回弹',
  );
  assert.equal(
    shouldApplyProgressReport(state, 89.5, now + 400),
    true,
    '报到目标附近(容差内) → 放行并解除闸门',
  );
  assert.equal(state.seekTarget, null, '到位后闸门必须解除,否则后续进度会永久不跟');
  assert.equal(shouldApplyProgressReport(state, 89.6, now + 900), true, '解除后恢复正常跟随');
}

// ---- 4. 边界:恰好等于容差也算法到位 ----
{
  const state = createScrubState();
  armSeekTarget(state, 60, 0);
  assert.equal(
    shouldApplyProgressReport(state, 60 + SEEK_ARRIVAL_TOLERANCE_SECONDS, 10),
    true,
    '容差边界应判为到位',
  );
}

// ---- 5. 超时兜底:跳转没成功也必须放行,禁止永久冻住进度条 ----
{
  const state = createScrubState();
  const now = 5_000;
  armSeekTarget(state, 200, now);
  assert.equal(
    shouldApplyProgressReport(state, 12, now + SEEK_SETTLE_TIMEOUT_MS + 1),
    true,
    '超时后即使报的还是旧位置也必须放行(缓冲失败时不能把界面卡死)',
  );
  assert.equal(state.seekTarget, null);
}

// ---- 6. 重新拖动:旧的跳转目标立即作废 ----
{
  const state = createScrubState();
  armSeekTarget(state, 90, 1_000);
  beginScrub(state);
  assert.equal(state.seekTarget, null, '用户重新按住进度条时旧跳转目标必须清掉');
  assert.equal(shouldApplyProgressReport(state, 12, 1_100), false, '仍在拖动中,继续只认拇指');
}

// ---- 6.5 pointerup 丢失的兜底:拖动不能永久卡死进度条 ----
{
  const state = createScrubState();
  const startedAt = 100_000;
  beginScrub(state, startedAt);
  assert.equal(state.dragging, true);
  assert.equal(state.dragStartedAt, startedAt, '必须记录拖动起点,兜底才有依据');

  assert.equal(isScrubbingActive(state, startedAt + 1000), true, '刚按下应算拖动中');
  assert.equal(
    shouldApplyProgressReport(state, 12, startedAt + 1000),
    false,
    '正常拖动期间播放器报时仍应被丢弃',
  );

  assert.equal(
    isScrubbingActive(state, startedAt + MAX_SCRUB_DURATION_MS + 1),
    false,
    '超过兜底时长视同已松手(pointerup 丢失不能把进度条冻死)',
  );
  assert.equal(state.dragging, false, '兜底触发时必须真的复位 dragging');
  assert.equal(
    shouldApplyProgressReport(state, 12, startedAt + MAX_SCRUB_DURATION_MS + 2),
    true,
    '兜底复位后进度条必须恢复跟随',
  );
}

// ---- 7. 换歌复位:上一首的闸门不得压住新歌 ----
{
  const state = createScrubState();
  beginScrub(state);
  armSeekTarget(state, 120, 2_000);
  resetScrubState(state);
  assert.equal(state.dragging, false);
  assert.equal(state.seekTarget, null);
  assert.equal(shouldApplyProgressReport(state, 0, 2_100), true, '换歌后新歌的进度必须能正常写入');
}

// ---- 8. 非法目标不建闸门(防御 Number(e.target.value) 之类) ----
{
  const state = createScrubState();
  armSeekTarget(state, Number.NaN, 1_000);
  assert.equal(state.seekTarget, null, 'NaN 目标不应建立闸门');
  armSeekTarget(state, '90.5', 1_000);
  assert.equal(state.seekTarget, 90.5, '数字字符串应被接受(进度条回传的是字符串)');
}

// ---- 9. 静态契约:两套播放器都必须真的接上仲裁 ----
//
// 纯函数全绿也可能因为"没接上"而毫无作用,这类"测试通过但产品仍坏"的漏网
// 只能靠源码契约兜住(仓库没有 ESLint,构建也不会报未使用)。
const webSource = await readFile(new URL('../src/contexts/PlayerContext.js', import.meta.url), 'utf8');
assert.match(webSource, /from '\.\/playerScrub\.js'/, 'Web/PWA 播放器必须导入拖动仲裁');
assert.match(webSource, /shouldApplyProgressReport\(/, 'Web timeupdate 必须过仲裁再写进度');
assert.match(webSource, /armSeekTarget\(/, 'Web seek 必须建立跳转闸门');
assert.match(webSource, /beginScrub\(|endScrub\(|useProgressScrub\(/, 'Web 进度条必须区分拖动中/松手');

const nativeSource = await readFile(
  new URL('../src/contexts/NativePlayerProvider.js', import.meta.url),
  'utf8',
);
assert.match(nativeSource, /from '\.\/playerScrub\.js'/, 'Android 原生播放器必须导入拖动仲裁');
assert.match(nativeSource, /shouldApplyProgressReport\(/, '原生 500ms 状态轮询必须过仲裁,否则拖完必回弹');
assert.match(nativeSource, /armSeekTarget\(/, '原生 seekTo 必须建立跳转闸门');

// ---- 10. 架构闸门:不许再悄悄启用「多曲 MSE 拼接」 ----
//
// 这是本次排查最贵的教训:进度条失效的根因不是某个 if 写错,而是**架构选错**。
// MSE 的数据全靠 appendBuffer 喂,自己不发起网络请求;拖到未 append 的区间拿不到
// 数据,而后端分块又都是 PTS=0 起,缓冲区永远贴着 0 排 → 拖到 90 秒越界被夹回 0。
//
// 源码级核对过 Navidrome / Jellyfin / Ampache:三家全是普通音频元素 + HTTP Range,
// 没有一家用多曲 MSE;连 Spotify web 都不做 gapless。所以这里把"默认关闭"锁死,
// 防止以后有人为了"无缝连播"再把它打开,又让进度条坏掉。
const enableFlag = webSource.match(/const ENABLE_CONTINUOUS_MEDIA_SOURCE = (true|false);/);
assert.ok(enableFlag, '必须保留 ENABLE_CONTINUOUS_MEDIA_SOURCE 开关(便于回退与对照实验)');
assert.equal(
  enableFlag[1],
  'false',
  '多曲 MSE 拼接必须默认关闭 —— 它会让拖动进度条失效(拖到未缓冲区间拿不到数据,'
  + '且分块 PTS 全为 0 导致越界夹回 0)。成熟自托管音乐项目都用普通音频元素 + HTTP Range。',
);
assert.match(
  webSource,
  /supportsContinuousMediaSource\(\)/,
  'MSE 分支的判断函数应保留,但必须与上面的开关同时成立才生效',
);

console.log('playerScrub tests passed');
