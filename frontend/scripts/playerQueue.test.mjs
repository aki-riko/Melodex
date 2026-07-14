import assert from 'node:assert/strict';
import { isCurrentAudioEvent, pickNextSong } from '../src/contexts/playerQueue.js';
import {
  createSleepTimer,
  formatSleepTimerRemaining,
  getSleepTimerRemainingMs,
  isSleepTimerDue,
  loadStopAfterTrackPreference,
  SLEEP_TIMER_PRESETS_MINUTES,
  SLEEP_STOP_AFTER_TRACK_KEY,
  shouldStopAtTrackEnd,
} from '../src/contexts/playerSleepTimer.js';
import {
  fadeAudioVolume,
  PLAYER_PAUSE_FADE_MS,
  shouldResumePlayback,
} from '../src/contexts/playerVolumeFade.js';
import { ensurePlaybackSession, UNAUTHORIZED_EVENT } from '../src/contexts/playerAuth.js';
import { songIdentityKey } from '../src/utils/songIdentity.js';

const songs = [
  { source: 'qq', id: '1', name: '第一首', extra: { mid: 'a' } },
  { source: 'qq', id: '2', name: '第二首', extra: { mid: 'b' } },
  { source: 'netease', id: '3', name: '第三首', extra: { mid: 'c' } },
];

assert.equal(
  pickNextSong({ list: songs, current: songs[0], mode: 'loop', forward: true, auto: true }),
  songs[1],
  '列表循环自然结束应前往下一首',
);

assert.equal(
  pickNextSong({ list: songs, current: songs[2], mode: 'loop', forward: true, auto: true }),
  songs[0],
  '列表循环到队尾应回到第一首',
);

assert.equal(
  pickNextSong({ list: songs, current: songs[2], mode: 'order', forward: true, auto: true }),
  null,
  '顺序播放自然结束到队尾应停止',
);

assert.equal(
  pickNextSong({ list: songs, current: songs[2], mode: 'order', forward: true, auto: false }),
  songs[0],
  '手动下一首在队尾仍应绕回',
);

assert.equal(
  pickNextSong({ list: [songs[0]], current: songs[0], mode: 'loop', forward: true, auto: true }),
  songs[0],
  '单曲队列的列表循环应重播同一首',
);

assert.equal(
  pickNextSong({ list: songs, current: songs[0], mode: 'shuffle', random: () => 0.75 }),
  songs[2],
  '随机播放应返回非当前项',
);

const currentAudio = { dataset: { playSeq: '7', songKey: songIdentityKey(songs[0]) } };
assert.equal(isCurrentAudioEvent(currentAudio, 7, songs[0]), true, '当前播放请求的事件应被处理');
assert.equal(isCurrentAudioEvent(currentAudio, 8, songs[0]), false, '同一首歌的旧请求事件应被忽略');
assert.equal(isCurrentAudioEvent(currentAudio, 7, songs[1]), false, '旧歌曲事件不应污染当前歌曲');

const storage = new Map();
const mockStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
};
assert.equal(loadStopAfterTrackPreference(mockStorage), true, '播完整首歌后停止默认开启');
mockStorage.setItem(SLEEP_STOP_AFTER_TRACK_KEY, '0');
assert.equal(loadStopAfterTrackPreference(mockStorage), false, '用户关闭后应读取为关闭');
assert.deepEqual(SLEEP_TIMER_PRESETS_MINUTES, [15, 30, 45, 60, 90, 120], '生产定时预设不应保留1分钟测试档');

const sleepTimer = createSleepTimer(15, 1000);
assert.deepEqual(sleepTimer, { endsAt: 901000, pendingEndOfTrack: false }, '睡眠定时应按分钟生成到期时间');
assert.equal(getSleepTimerRemainingMs(sleepTimer, 60000), 841000, '未到期时应返回剩余毫秒');
assert.equal(isSleepTimerDue(sleepTimer, 901000), true, '到达 endsAt 即视为到期');
assert.equal(shouldStopAtTrackEnd(sleepTimer, true, 901000), true, '开关开启且到期后应在本曲结束时停止');
assert.equal(shouldStopAtTrackEnd(sleepTimer, false, 901000), false, '开关关闭时不走播完本曲分支');
assert.equal(shouldStopAtTrackEnd({ ...sleepTimer, pendingEndOfTrack: true }, true, 60000), true, '待停止状态应始终拦截自然续播');
assert.equal(formatSleepTimerRemaining(61000), '1:01', '分钟级剩余时间应格式化为 m:ss');
assert.equal(formatSleepTimerRemaining(3661000), '1:01:01', '小时级剩余时间应格式化为 h:mm:ss');

const scheduledFrames = new Map();
let nextFrameID = 1;
const requestFrame = (callback) => {
  const id = nextFrameID;
  nextFrameID += 1;
  scheduledFrames.set(id, callback);
  return id;
};
const cancelFrame = (id) => scheduledFrames.delete(id);
const runFrame = (timestamp) => {
  const callbacks = [...scheduledFrames.values()];
  scheduledFrames.clear();
  callbacks.forEach((callback) => callback(timestamp));
};

const fadingAudio = { volume: 0.8 };
let fadeCompleted = false;
fadeAudioVolume(fadingAudio, 0, {
  durationMs: PLAYER_PAUSE_FADE_MS,
  now: () => 0,
  requestFrame,
  cancelFrame,
  onComplete: () => { fadeCompleted = true; },
});
runFrame(0);
runFrame(PLAYER_PAUSE_FADE_MS / 2);
assert.ok(Math.abs(fadingAudio.volume - 0.4) < 0.001, '暂停渐隐中点应降到用户音量的一半');
runFrame(PLAYER_PAUSE_FADE_MS);
assert.equal(fadingAudio.volume, 0, '暂停渐隐结束时音量应为0');
assert.equal(fadeCompleted, true, '暂停渐隐结束后应触发完成回调');

let delayedFrame = null;
const delayedFrameAudio = { volume: 0.8 };
let delayedFadeCompleted = false;
fadeAudioVolume(delayedFrameAudio, 0, {
  durationMs: PLAYER_PAUSE_FADE_MS,
  now: () => 0,
  requestFrame: (callback) => {
    delayedFrame = callback;
    return 1;
  },
  cancelFrame: () => {},
  onComplete: () => { delayedFadeCompleted = true; },
});
delayedFrame(PLAYER_PAUSE_FADE_MS);
assert.equal(delayedFrameAudio.volume, 0, '后台首个延迟调度应按真实经过时间直接完成渐隐');
assert.equal(delayedFadeCompleted, true, '后台调度延迟后仍必须触发暂停完成回调');

const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
let browserRAFCalled = false;
globalThis.requestAnimationFrame = () => {
  browserRAFCalled = true;
  throw new Error('后台渐变不应调用 requestAnimationFrame');
};
try {
  const timerScheduledAudio = { volume: 0.5 };
  await new Promise((resolve, reject) => {
    try {
      fadeAudioVolume(timerScheduledAudio, 0, { durationMs: 1, onComplete: resolve });
    } catch (err) {
      reject(err);
    }
  });
  assert.equal(browserRAFCalled, false, '生产渐变调度不得依赖后台会停摆的 requestAnimationFrame');
  assert.equal(timerScheduledAudio.volume, 0, '定时器调度应完成渐隐');
} finally {
  if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
  else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
}

const cancelledAudio = { volume: 0.6 };
let cancelledFadeCompleted = false;
const cancelFade = fadeAudioVolume(cancelledAudio, 0, {
  durationMs: PLAYER_PAUSE_FADE_MS,
  now: () => 0,
  requestFrame,
  cancelFrame,
  onComplete: () => { cancelledFadeCompleted = true; },
});
runFrame(0);
runFrame(PLAYER_PAUSE_FADE_MS / 2);
const volumeWhenCancelled = cancelledAudio.volume;
cancelFade();
runFrame(PLAYER_PAUSE_FADE_MS);
assert.equal(cancelledAudio.volume, volumeWhenCancelled, '取消旧渐变后不应继续改写音量');
assert.equal(cancelledFadeCompleted, false, '取消旧渐变后不应触发完成回调');
assert.equal(shouldResumePlayback(true, ''), true, '普通暂停态应执行淡入恢复');
assert.equal(shouldResumePlayback(false, ''), false, '普通播放态应执行淡出暂停');
assert.equal(shouldResumePlayback(false, 'pause'), true, '淡出期间再次点击应改为恢复播放');
assert.equal(shouldResumePlayback(true, 'play'), false, '淡入请求尚未落地时再次点击应取消恢复');

const authEvents = [];
const authEventTarget = { dispatchEvent: (event) => authEvents.push(event) };
assert.equal(
  await ensurePlaybackSession(async () => ({ authenticated: true }), { eventTarget: authEventTarget }),
  true,
  '播放报错时若会话仍有效,不应阻断原有换源逻辑',
);
assert.equal(authEvents.length, 0, '会话有效时不应派发 unauthorized 事件');
assert.equal(
  await ensurePlaybackSession(async () => ({ authenticated: false }), { eventTarget: authEventTarget }),
  false,
  '播放报错时若会话失效,应阻断自动换源/跳歌',
);
assert.equal(authEvents.length, 1, '会话失效时应派发一次 unauthorized 事件');
assert.equal(authEvents[0].type, UNAUTHORIZED_EVENT, '会话失效事件名称应保持统一');
assert.equal(authEvents[0].detail.reason, 'playback-auth', '会话失效事件应带播放报错来源');
assert.equal(
  await ensurePlaybackSession(async () => { throw new Error('network'); }, { eventTarget: authEventTarget }),
  true,
  '无法确认会话状态时不应误判为登出',
);

console.log('playerQueue tests passed');
