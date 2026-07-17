import assert from 'node:assert/strict';
import { prepareNextAudioBlob, preparedAudioForTransition } from '../src/contexts/playerPrefetch.js';

const current = { source: 'qq', id: '1', name: '当前歌曲' };
const next = { source: 'qq', id: '2', name: '下一首' };
const blob = new Blob(['audio-bytes'], { type: 'audio/mpeg' });

let onlineCalls = 0;
const onlineController = new AbortController();
const preparedOnline = await prepareNextAudioBlob({
  currentSong: current,
  nextSong: next,
  mode: 'loop',
  offline: false,
  userId: 7,
  signal: onlineController.signal,
  getCachedAudio: async () => { throw new Error('在线模式不应读取 IndexedDB'); },
  fetchOnlineAudio: async (song, { signal }) => {
    onlineCalls += 1;
    assert.equal(song, next);
    assert.equal(signal, onlineController.signal, '在线预取必须把取消信号传给网络请求');
    return { blob, mime: 'audio/mpeg' };
  },
});
assert.equal(onlineCalls, 1, '在线模式应完整预取下一首');
assert.equal(preparedOnline.song, next, '预取记录应保留计划中的下一首');
assert.deepEqual(
  preparedAudioForTransition(preparedOnline, current, next, 'loop'),
  { blob, mime: 'audio/mpeg' },
  '当前歌曲与计划下一首匹配时应消费内存 Blob',
);
assert.equal(
  preparedAudioForTransition(preparedOnline, { ...current, id: 'other' }, next, 'loop'),
  null,
  '当前歌曲变化后不得消费陈旧预取',
);
assert.equal(
  preparedAudioForTransition(preparedOnline, current, next, 'shuffle'),
  null,
  '播放模式变化后不得消费旧模式计划的预取',
);

let cachedCalls = 0;
const preparedOffline = await prepareNextAudioBlob({
  currentSong: current,
  nextSong: next,
  mode: 'loop',
  offline: true,
  userId: 7,
  getCachedAudio: async (song, userId) => {
    cachedCalls += 1;
    assert.equal(song, next);
    assert.equal(userId, 7);
    return { blob, mime: 'audio/mpeg' };
  },
  fetchOnlineAudio: async () => { throw new Error('离线模式不得请求网络'); },
});
assert.equal(cachedCalls, 1, '离线模式应预读 IndexedDB 下一首');
assert.ok(preparedOffline?.blob, '离线缓存存在时应生成预取记录');

console.log('playerPrefetch tests passed');
