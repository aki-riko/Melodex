import assert from 'node:assert/strict';
import {
  createPreparedAudio,
  preparedAudioForTransition,
} from '../src/contexts/playerPrefetch.js';

const current = { source: 'qq', id: '1', name: '当前歌曲' };
const next = { source: 'qq', id: '2', name: '下一首' };
const cachedBlob = new Blob(['cached-audio'], { type: 'audio/mpeg' });

const preparedOffline = createPreparedAudio({
  currentSong: current,
  nextSong: next,
  mode: 'loop',
  blob: cachedBlob,
  mime: 'audio/mpeg',
});
assert.equal(preparedOffline.song, next, '离线预取记录应保留计划中的下一首');
assert.deepEqual(
  preparedAudioForTransition(preparedOffline, current, next, 'loop'),
  {
    blob: cachedBlob,
    mime: 'audio/mpeg',
    coverBlob: null,
    coverMime: '',
  },
  '离线模式应把已读取的缓存 Blob 交给同一个常驻 audio 元素',
);
assert.equal(
  preparedAudioForTransition(preparedOffline, { ...current, id: 'other' }, next, 'loop'),
  null,
  '当前歌曲变化后不得消费陈旧预取',
);
assert.equal(
  preparedAudioForTransition(preparedOffline, current, next, 'shuffle'),
  null,
  '播放模式变化后不得消费旧模式计划的预取',
);

assert.equal(
  createPreparedAudio({ currentSong: current, nextSong: next, mode: 'loop', blob: null }),
  null,
  '没有离线缓存 Blob 时不得生成虚假预取记录',
);

console.log('playerPrefetch tests passed');
