import assert from 'node:assert/strict';
import {
  planServerDownloadBatch,
  serverDownloadEventBelongsToUser,
  serverDownloadMatchesKnownKeys,
  serverDownloadSongKey,
  serverDownloadStatusKey,
  serverDownloadTitleArtistKey,
  serverSaveSucceeded,
} from '../src/utils/serverDownloads.js';
import {
  runServerDownloadBatchCore,
  serverDownloadBatchProcessed,
  serverDownloadBatchSummary,
  shouldAbortServerDownloadBatch,
} from '../src/utils/serverDownloadBatch.js';
import { shouldAutoDownloadOnPlay } from '../src/contexts/playerAutoDownload.js';

assert.equal(serverDownloadStatusKey(' qq ', ' 002l8AAo4GpCaf '), 'qq\u0000002l8AAo4GpCaf');
assert.equal(serverDownloadStatusKey('qq', ''), '');

assert.equal(
  serverDownloadTitleArtistKey(' 庭園にて。 ', ' ACANE_MADDER '),
  '庭園にて。\u0000acane_madder',
);

assert.equal(serverDownloadEventBelongsToUser({ userId: 1 }, 1), true);
assert.equal(serverDownloadEventBelongsToUser({ userId: '1' }, 1), true);
assert.equal(serverDownloadEventBelongsToUser({ userId: 1 }, 2), false);
assert.equal(serverDownloadEventBelongsToUser({}, 1), false);
assert.equal(serverDownloadEventBelongsToUser({ userId: 1 }, 0), false);
assert.equal(serverSaveSucceeded({ saved: true, recorded: true }), true);
assert.equal(serverSaveSucceeded({ saved: true }), false);
assert.equal(serverSaveSucceeded({ saved: true, recorded: false }), false);

// 生产真实下载记录回归样本：部署前后核验过的 download_records.id=973。
const realDownloaded = {
  source: 'qq',
  song_id: '002l8AAo4GpCaf',
  name: '庭園にて。',
  artist: 'acane_madder',
};
const realSong = {
  source: 'qq',
  id: '002l8AAo4GpCaf',
  name: '庭園にて。',
  artist: 'acane_madder',
};
const pendingQQ = { source: 'qq', id: 'new-song-1', name: '新歌', artist: '歌手' };
const pendingQQDuplicate = { ...pendingQQ, extra: { quality: 'alternate' } };
const pendingNetease = { source: 'netease', id: 'new-song-1', name: '新歌', artist: '歌手' };
const pendingKugou = { source: 'kugou', id: 'new-song-2', name: '归属失败', artist: '歌手' };
const localSong = { source: 'local', id: 'local-track-1', name: '本地歌', artist: '歌手' };
const legacyLocalSong = { source: 'local-file', id: 'legacy-track-1', name: '旧本地歌', artist: '歌手' };
const localMusicSong = { source: 'local_music', id: 'compat-track-1', name: '兼容本地歌', artist: '歌手' };
const invalidSong = { source: 'qq', id: '', name: '缺少 ID', artist: '歌手' };
const batchSongs = [realSong, localSong, legacyLocalSong, localMusicSong, pendingQQ, pendingQQDuplicate, pendingNetease, pendingKugou, invalidSong];

assert.equal(serverDownloadSongKey(realSong), 'qq\u0000002l8AAo4GpCaf');

const originalIdentity = { source: 'qq', id: '001MPeqh1mdABU', name: '凝眸', artist: '王心凌, 张远' };
const accompanimentIdentity = { source: 'qq', id: '0003q6YO4Xvxj6', name: '凝眸', artist: '王心凌, 张远' };
const accompanimentExactKeys = new Set([serverDownloadSongKey(accompanimentIdentity)]);
const sharedTitleKeys = new Set([serverDownloadTitleArtistKey('凝眸', '王心凌, 张远')]);
assert.equal(serverDownloadMatchesKnownKeys(originalIdentity, accompanimentExactKeys, sharedTitleKeys), false);
assert.equal(serverDownloadMatchesKnownKeys(accompanimentIdentity, accompanimentExactKeys, sharedTitleKeys), true);
assert.equal(serverDownloadMatchesKnownKeys({ name: '凝眸', artist: '王心凌, 张远' }, new Set(), sharedTitleKeys), true);

const enabledStorage = { getItem: () => '1' };
const disabledStorage = { getItem: () => '0' };
assert.equal(shouldAutoDownloadOnPlay(realSong, () => true, enabledStorage), false);
assert.equal(shouldAutoDownloadOnPlay(pendingQQ, () => false, enabledStorage), true);
assert.equal(shouldAutoDownloadOnPlay(localSong, () => false, enabledStorage), false);
assert.equal(shouldAutoDownloadOnPlay(legacyLocalSong, () => false, enabledStorage), false);
assert.equal(shouldAutoDownloadOnPlay(localMusicSong, () => false, enabledStorage), false);
assert.equal(shouldAutoDownloadOnPlay(pendingQQ, () => false, disabledStorage), false);

const plan = planServerDownloadBatch(batchSongs, [realDownloaded]);
assert.deepEqual(plan.pending, [pendingQQ, pendingNetease, pendingKugou]);
assert.equal(plan.total, 9);
assert.equal(plan.already, 4);
assert.equal(plan.duplicates, 1);
assert.equal(plan.invalid, 1);
assert.equal(plan.skipped, 5);

const savedKeys = [];
const progress = [];
const mixedResult = await runServerDownloadBatchCore(batchSongs, {
  loadDownloads: async () => ({ downloads: [realDownloaded] }),
  saveSong: async (song) => {
    savedKeys.push(serverDownloadSongKey(song));
    if (song.source === 'netease') throw new Error('真实死链等价失败');
    if (song.source === 'kugou') return { saved: true, recorded: false };
    return { saved: true, recorded: true };
  },
  onProgress: (state) => progress.push(state),
  logger: { warn: () => {} },
});
assert.deepEqual(savedKeys, ['qq\u0000new-song-1', 'netease\u0000new-song-1', 'kugou\u0000new-song-2']);
assert.equal(mixedResult.phase, 'fail');
assert.equal(mixedResult.done, 1);
assert.equal(mixedResult.fail, 3);
assert.equal(mixedResult.skipped, 5);
assert.equal(serverDownloadBatchProcessed(mixedResult), mixedResult.total);
assert.equal(serverDownloadBatchSummary(mixedResult), '新增 1 · 跳过 5 · 失败 3 · 共 9');
assert.ok(progress.length >= 3);

let allExistingSaveCalls = 0;
const allExistingResult = await runServerDownloadBatchCore([realSong, localSong, legacyLocalSong, localMusicSong], {
  loadDownloads: async () => ({ downloads: [realDownloaded] }),
  saveSong: async () => {
    allExistingSaveCalls += 1;
    return { saved: true, recorded: true };
  },
});
assert.equal(allExistingSaveCalls, 0);
assert.deepEqual(allExistingResult, {
  phase: 'done', done: 0, fail: 0, skipped: 4, aborted: 0, total: 4, statusError: false, authChanged: false,
});

let statusFailureSaveCalls = 0;
const statusFailureResult = await runServerDownloadBatchCore([pendingQQ], {
  loadDownloads: async () => { throw new Error('status unavailable'); },
  saveSong: async () => {
    statusFailureSaveCalls += 1;
    return { saved: true, recorded: true };
  },
  logger: { warn: () => {} },
});
assert.equal(statusFailureSaveCalls, 0);
assert.equal(statusFailureResult.phase, 'fail');
assert.equal(statusFailureResult.statusError, true);
assert.equal(statusFailureResult.aborted, 1);
assert.equal(serverDownloadBatchProcessed(statusFailureResult), statusFailureResult.total);

let malformedSaveCalls = 0;
const malformedResult = await runServerDownloadBatchCore([pendingQQ], {
  loadDownloads: async () => ({}),
  saveSong: async () => {
    malformedSaveCalls += 1;
    return { saved: true, recorded: true };
  },
  logger: { warn: () => {} },
});
assert.equal(malformedSaveCalls, 0);
assert.equal(malformedResult.statusError, true);
assert.equal(malformedResult.aborted, 1);

let malformedItemSaveCalls = 0;
const malformedItemResult = await runServerDownloadBatchCore([pendingQQ], {
  loadDownloads: async () => ({ downloads: [{ source: 'qq' }] }),
  saveSong: async () => {
    malformedItemSaveCalls += 1;
    return { saved: true, recorded: true };
  },
  logger: { warn: () => {} },
});
assert.equal(malformedItemSaveCalls, 0);
assert.equal(malformedItemResult.statusError, true);

const wrongTypeStatusResult = await runServerDownloadBatchCore([pendingQQ], {
  loadDownloads: async () => ({ downloads: [{ source: {}, song_id: {}, rel_path: {} }] }),
  saveSong: async () => ({ saved: true, recorded: true }),
  logger: { warn: () => {} },
});
assert.equal(wrongTypeStatusResult.statusError, true);

let legacyStatusSaveCalls = 0;
const legacyStatusResult = await runServerDownloadBatchCore([pendingQQ], {
  loadDownloads: async () => ({ downloads: [{ rel_path: 'legacy-without-identity.mp3' }] }),
  saveSong: async () => {
    legacyStatusSaveCalls += 1;
    return { saved: true, recorded: true };
  },
});
assert.equal(legacyStatusSaveCalls, 1);
assert.equal(legacyStatusResult.phase, 'done');

const missingRecordedResult = await runServerDownloadBatchCore([pendingQQ], {
  loadDownloads: async () => ({ downloads: [] }),
  saveSong: async () => ({ saved: true }),
  logger: { warn: () => {} },
});
assert.equal(missingRecordedResult.phase, 'fail');
assert.equal(missingRecordedResult.done, 0);
assert.equal(missingRecordedResult.fail, 1);

const userChangedError = new Error('user changed');
userChangedError.response = { status: 409, data: { code: 'user_changed' } };
let userChangedSaveCalls = 0;
const userChangedResult = await runServerDownloadBatchCore([pendingQQ, pendingNetease], {
  loadDownloads: async () => ({ downloads: [] }),
  saveSong: async () => {
    userChangedSaveCalls += 1;
    throw userChangedError;
  },
  abortOnError: shouldAbortServerDownloadBatch,
  logger: { warn: () => {} },
});
assert.equal(userChangedSaveCalls, 1);
assert.equal(userChangedResult.phase, 'fail');
assert.equal(userChangedResult.authChanged, true);
assert.equal(userChangedResult.aborted, 2);
assert.equal(serverDownloadBatchProcessed(userChangedResult), userChangedResult.total);
assert.match(serverDownloadBatchSummary(userChangedResult), /^登录状态已变化，批量已停止/);

const unauthorizedError = new Error('unauthorized');
unauthorizedError.response = { status: 401, data: {} };
let unauthorizedSaveCalls = 0;
const unauthorizedResult = await runServerDownloadBatchCore([pendingQQ, pendingNetease, pendingKugou], {
  loadDownloads: async () => ({ downloads: [] }),
  saveSong: async () => {
    unauthorizedSaveCalls += 1;
    throw unauthorizedError;
  },
  abortOnError: shouldAbortServerDownloadBatch,
  logger: { warn: () => {} },
});
assert.equal(unauthorizedSaveCalls, 1);
assert.equal(unauthorizedResult.authChanged, true);
assert.equal(unauthorizedResult.aborted, 3);
assert.equal(serverDownloadBatchProcessed(unauthorizedResult), unauthorizedResult.total);
assert.equal(shouldAbortServerDownloadBatch({ response: { status: 500, data: {} } }), false);

console.log('serverDownloads tests passed');
