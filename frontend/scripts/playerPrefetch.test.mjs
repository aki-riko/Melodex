import assert from 'node:assert/strict';
import {
  createPreparedAudio,
  handoffAudioElement,
  isPreparedStandbyAudio,
  preparedAudioForTransition,
} from '../src/contexts/playerPrefetch.js';

const current = { source: 'qq', id: '1', name: '当前歌曲' };
const next = { source: 'qq', id: '2', name: '下一首' };
const standbyAudio = { src: '/music/download?id=2&source=qq&stream=1' };

const preparedOnline = createPreparedAudio({
  currentSong: current,
  nextSong: next,
  mode: 'loop',
  audio: standbyAudio,
  sourceKind: 'stream_preload',
});
assert.equal(preparedOnline.song, next, '预取记录应保留计划中的下一首');
assert.deepEqual(
  preparedAudioForTransition(preparedOnline, current, next, 'loop'),
  {
    audio: standbyAudio,
    sourceKind: 'stream_preload',
    objectUrl: '',
    coverBlob: null,
    coverMime: '',
  },
  '当前歌曲与计划下一首匹配时应消费备用 audio，而不是整首内存 Blob',
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

const cachedObjectUrl = 'blob:cached-next-song';
const preparedOffline = createPreparedAudio({
  currentSong: current,
  nextSong: next,
  mode: 'loop',
  audio: standbyAudio,
  sourceKind: 'cache_preload',
  objectUrl: cachedObjectUrl,
});
assert.equal(preparedOffline.objectUrl, cachedObjectUrl, '离线预载应保留可释放的缓存 Object URL');
assert.equal(preparedOffline.audio, standbyAudio, '离线预载也必须使用备用 audio 元素');

assert.equal(
  createPreparedAudio({ currentSong: current, nextSong: next, mode: 'loop', audio: null }),
  null,
  '备用 audio 尚未挂载时不得生成虚假预载记录',
);

let previousPauseCalls = 0;
const previousAudio = {
  paused: false,
  pause: () => {
    previousPauseCalls += 1;
    previousAudio.paused = true;
  },
};
const targetAudio = { paused: true };
assert.deepEqual(
  handoffAudioElement(previousAudio, targetAudio),
  { activeAudio: targetAudio, standbyAudio: previousAudio },
  '备用播放器接管后应交换活动与备用角色',
);
assert.equal(previousPauseCalls, 1, '新播放器接管时必须停止仍在出声的旧播放器');
assert.equal(
  handoffAudioElement(targetAudio, targetAudio),
  null,
  '目标已经是活动播放器时不得重复交接',
);
assert.equal(
  isPreparedStandbyAudio(preparedOnline, standbyAudio, previousAudio),
  true,
  '预载元素在接管前报错时应识别为备用播放器错误',
);
assert.equal(
  isPreparedStandbyAudio(preparedOnline, standbyAudio, standbyAudio),
  false,
  '预载元素已经接管后应走当前歌曲错误恢复，不得按备用错误丢弃',
);

console.log('playerPrefetch tests passed');
