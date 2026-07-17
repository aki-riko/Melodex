import assert from 'node:assert/strict';
import {
  resumeUnexpectedBackgroundPause,
  shouldDeferPausedStateToEndedHandler,
  shouldRecoverUnexpectedBackgroundPause,
} from '../src/contexts/playerPauseRecovery.js';

const realFailure = {
  reason: 'unexpected',
  visibilityState: 'hidden',
  sourceKind: 'cache_preload',
  ended: false,
  playSeq: '3',
  recoveredPlaySeq: '',
};

assert.equal(shouldRecoverUnexpectedBackgroundPause(realFailure), true, '后台离线预载音轨首次意外暂停应自动恢复');
assert.equal(
  shouldRecoverUnexpectedBackgroundPause({ ...realFailure, visibilityState: 'visible' }),
  false,
  '前台意外暂停不应被自动接管',
);
assert.equal(
  shouldRecoverUnexpectedBackgroundPause({ ...realFailure, reason: 'media_session' }),
  false,
  '锁屏控制器的用户暂停必须保留',
);
assert.equal(
  shouldRecoverUnexpectedBackgroundPause({ ...realFailure, reason: 'sleep_timer' }),
  false,
  '睡眠定时暂停不得恢复',
);
assert.equal(
  shouldRecoverUnexpectedBackgroundPause({ ...realFailure, sourceKind: 'network' }),
  false,
  '恢复逻辑只针对离线预载 Blob 切入的音轨',
);
assert.equal(
  shouldRecoverUnexpectedBackgroundPause({ ...realFailure, recoveredPlaySeq: '3' }),
  false,
  '同一音轨最多自动恢复一次以避免循环',
);
assert.equal(
  shouldDeferPausedStateToEndedHandler('ended'),
  true,
  '自然结束的 pause 不得提前把 MediaSession 发布成 paused',
);
assert.equal(
  shouldDeferPausedStateToEndedHandler('media_session'),
  false,
  '用户从锁屏控制器暂停时必须立即同步 paused',
);
assert.equal(
  shouldDeferPausedStateToEndedHandler('sleep_timer'),
  false,
  '睡眠定时暂停不得延后',
);

const audio = {
  paused: true,
  async play() { this.paused = false; },
};
assert.equal(await resumeUnexpectedBackgroundPause(audio), true, 'play 成功后应确认音频已恢复');
await assert.rejects(
  resumeUnexpectedBackgroundPause({ paused: true, play: async () => { throw new Error('blocked'); } }),
  /blocked/,
  '浏览器拒绝恢复时应把错误交给诊断层',
);

console.log('playerPauseRecovery tests passed');
