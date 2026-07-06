import assert from 'node:assert/strict';
import { isCurrentAudioEvent, pickNextSong } from '../src/contexts/playerQueue.js';
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

console.log('playerQueue tests passed');
