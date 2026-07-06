import assert from 'node:assert/strict';
import { isCurrentAudioEvent, pickNextSong } from '../src/contexts/playerQueue.js';
import {
  createSleepTimer,
  formatSleepTimerRemaining,
  getSleepTimerRemainingMs,
  isSleepTimerDue,
  loadStopAfterTrackPreference,
  SLEEP_STOP_AFTER_TRACK_KEY,
  shouldStopAtTrackEnd,
} from '../src/contexts/playerSleepTimer.js';
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

const sleepTimer = createSleepTimer(15, 1000);
assert.deepEqual(sleepTimer, { endsAt: 901000, pendingEndOfTrack: false }, '睡眠定时应按分钟生成到期时间');
assert.equal(getSleepTimerRemainingMs(sleepTimer, 60000), 841000, '未到期时应返回剩余毫秒');
assert.equal(isSleepTimerDue(sleepTimer, 901000), true, '到达 endsAt 即视为到期');
assert.equal(shouldStopAtTrackEnd(sleepTimer, true, 901000), true, '开关开启且到期后应在本曲结束时停止');
assert.equal(shouldStopAtTrackEnd(sleepTimer, false, 901000), false, '开关关闭时不走播完本曲分支');
assert.equal(shouldStopAtTrackEnd({ ...sleepTimer, pendingEndOfTrack: true }, true, 60000), true, '待停止状态应始终拦截自然续播');
assert.equal(formatSleepTimerRemaining(61000), '1:01', '分钟级剩余时间应格式化为 m:ss');
assert.equal(formatSleepTimerRemaining(3661000), '1:01:01', '小时级剩余时间应格式化为 h:mm:ss');

console.log('playerQueue tests passed');
