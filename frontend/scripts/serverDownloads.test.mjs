import assert from 'node:assert/strict';
import {
  buildServerDownloadIndex,
  planServerDownloadBatch,
  serverDownloadEventBelongsToUser,
  serverDownloadMatchesKnownKeys,
  serverDownloadRecordExtension,
  serverDownloadRecordForSong,
  serverDownloadRecordSizeBytes,
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
import {
  autoDownloadFailureIsRetryable,
  autoDownloadOnPlayPlan,
  estimateServerCopyBitrate,
  retainAutoDownloadAttempt,
  serverCopyNeedsUpgrade,
  shouldAutoDownloadOnPlay,
} from '../src/contexts/playerAutoDownload.js';

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
// 兼容旧的布尔查询函数:已下载但拿不到记录 → 不升级、不重下(维持旧行为)。
assert.equal(shouldAutoDownloadOnPlay(realSong, () => true, enabledStorage), false);

// ---- 音质升级判定 serverCopyNeedsUpgrade ----
// 新后端契约:GET /music/downloads 每项新增 ext(小写)与 size_bytes。
const flacRecord = {
  source: 'qq',
  song_id: '002l8AAo4GpCaf',
  name: '庭園にて。',
  artist: 'acane_madder',
  rel_path: '庭園にて。 - acane_madder [qq-002l8AAo4GpCaf].flac',
  ext: 'flac',
  size_bytes: 35_661_811,
};
assert.equal(serverDownloadRecordExtension({ ext: 'FLAC' }), 'flac');
assert.equal(serverDownloadRecordExtension({ ext: '.Mp3' }), 'mp3');
assert.equal(serverDownloadRecordExtension({ rel_path: 'dir\\song.FLAC' }), 'flac');
assert.equal(serverDownloadRecordExtension({}), '');
assert.equal(serverDownloadRecordSizeBytes({ size_bytes: 1234 }), 1234);
assert.equal(serverDownloadRecordSizeBytes({ size_bytes: '1234' }), 1234);
assert.equal(serverDownloadRecordSizeBytes({}), 0);
assert.equal(serverDownloadRecordSizeBytes({ size_bytes: -5 }), 0);

const losslessSong = { source: 'qq', id: '002l8AAo4GpCaf', name: '庭園にて。', artist: 'acane_madder', bitrate: 1411, duration: 269, extra: { has_lossless: '1' } };
const lossyRecord = { ...flacRecord, ext: 'mp3', size_bytes: 4_300_000, rel_path: '庭園にて。 - acane_madder.mp3' };
// 无 record → false(没下载过不算升级)
assert.equal(serverCopyNeedsUpgrade(losslessSong, null), false);
assert.equal(serverCopyNeedsUpgrade(losslessSong, undefined), false);
// 本地源 → false
assert.equal(serverCopyNeedsUpgrade({ ...losslessSong, source: 'local' }, lossyRecord), false);
assert.equal(serverCopyNeedsUpgrade({ ...losslessSong, source: 'local_music' }, lossyRecord), false);
// 磁盘有损 + 源声明 has_lossless='1' → true
assert.equal(serverCopyNeedsUpgrade(losslessSong, lossyRecord), true);
// 已是无损 → false(无损之间不比体积)
assert.equal(serverCopyNeedsUpgrade(losslessSong, flacRecord), false);
// 磁盘有损、源无 has_lossless,但估算码率明显偏低(mp3 128k vs 在线 320k) → true
const lowRateRecord = { source: 'qq', song_id: 'lowrate', ext: 'mp3', size_bytes: 4_300_000, rel_path: 'a.mp3' };
const highRateSong = { source: 'qq', id: 'lowrate', name: '高码率', artist: '歌手', bitrate: 320, duration: 269, extra: {} };
assert.equal(estimateServerCopyBitrate(lowRateRecord, 269), 128);
assert.equal(serverCopyNeedsUpgrade(highRateSong, lowRateRecord), true);
// 码率接近(320k 文件 vs 在线 320k) → false,不无谓重下
const nearRecord = { source: 'qq', song_id: 'near', ext: 'mp3', size_bytes: 10_800_000, rel_path: 'b.mp3' };
const nearSong = { source: 'qq', id: 'near', name: '同码率', artist: '歌手', bitrate: 320, duration: 269, extra: {} };
assert.equal(estimateServerCopyBitrate(nearRecord, 269), 321);
assert.equal(serverCopyNeedsUpgrade(nearSong, nearRecord), false);
// 缺 size_bytes/时长 → 无法估算 → false(保守)
assert.equal(estimateServerCopyBitrate({ ext: 'mp3' }, 269), 0);
assert.equal(estimateServerCopyBitrate(lowRateRecord, 0), 0);
assert.equal(serverCopyNeedsUpgrade(highRateSong, { source: 'qq', song_id: 'lowrate', ext: 'mp3' }), false);
assert.equal(serverCopyNeedsUpgrade({ ...highRateSong, duration: 0 }, lowRateRecord), false);
// 在线无码率(0/非法) → 无正面证据 → false
assert.equal(serverCopyNeedsUpgrade({ ...highRateSong, bitrate: 0 }, lowRateRecord), false);
assert.equal(serverCopyNeedsUpgrade({ ...highRateSong, bitrate: 'unknown' }, lowRateRecord), false);
// 扩展名未知(旧记录缺 ext 且 rel_path 无后缀) → 不靠扩展名猜,只认码率证据。
assert.equal(serverCopyNeedsUpgrade(highRateSong, { source: 'qq', song_id: 'lowrate', size_bytes: 4_300_000 }), true);
// 同一文件按更短时长估算 = 估算码率 573k > 320k,不是升级。
assert.equal(serverCopyNeedsUpgrade({ ...highRateSong, duration: 60 }, { source: 'qq', song_id: 'lowrate', size_bytes: 4_300_000 }), false);
// 时长过短(<30s)不足以可靠估算 → 不升级。
assert.equal(serverCopyNeedsUpgrade({ ...highRateSong, duration: 10 }, { source: 'qq', song_id: 'lowrate', size_bytes: 4_300_000 }), false);

// ---- 索引 + 记录查找 ----
const downloadIndex = buildServerDownloadIndex([lossyRecord, flacRecord]);
assert.equal(serverDownloadRecordForSong(realSong, downloadIndex)?.ext, 'mp3');
assert.equal(serverDownloadRecordForSong({ source: 'qq', id: 'other-id', name: '庭園にて。', artist: 'acane_madder' }, downloadIndex), null);
assert.equal(serverDownloadRecordForSong({ name: '庭園にて。', artist: 'acane_madder' }, downloadIndex)?.song_id, '002l8AAo4GpCaf');
assert.equal(serverDownloadRecordForSong(localSong, downloadIndex), null);
assert.equal(serverDownloadRecordForSong(realSong, null), null);
// 后端已按 created_at DESC 返回:同一身份保留第一条,与实际播放的服务器副本一致。
const sameKeyNewer = { ...flacRecord, ext: 'flac', size_bytes: 35_000_000 };
const newerFirst = buildServerDownloadIndex([sameKeyNewer, lossyRecord]);
assert.equal(serverDownloadRecordForSong(realSong, newerFirst)?.ext, 'flac');
// 格式错误的条目必须被忽略,不能污染索引。
const dirtyIndex = buildServerDownloadIndex([null, 'junk', 42, [lossyRecord]]);
assert.equal(serverDownloadRecordForSong(realSong, dirtyIndex), null);
assert.equal(buildServerDownloadIndex(undefined).exact.size, 0);

// ---- shouldAutoDownloadOnPlay 的升级分支 ----
const lookup = (record) => () => record;
assert.equal(shouldAutoDownloadOnPlay(realSong, lookup(null), enabledStorage), true);
assert.equal(shouldAutoDownloadOnPlay(realSong, lookup(flacRecord), enabledStorage), false);
assert.equal(shouldAutoDownloadOnPlay(losslessSong, lookup(lossyRecord), enabledStorage), true);
assert.equal(shouldAutoDownloadOnPlay(losslessSong, lookup(flacRecord), enabledStorage), false);
assert.equal(shouldAutoDownloadOnPlay(losslessSong, lookup(lossyRecord), disabledStorage), false);
assert.equal(shouldAutoDownloadOnPlay({ ...losslessSong, source: 'local' }, lookup(lossyRecord), enabledStorage), false);
// 升级计划要能把「本次是升级」与「本次是首次下载」区分开,供失败后放弃会话用。
assert.deepEqual(autoDownloadOnPlayPlan(losslessSong, lookup(lossyRecord), enabledStorage), { download: true, upgrade: true });
assert.deepEqual(autoDownloadOnPlayPlan(realSong, lookup(null), enabledStorage), { download: true, upgrade: false });
assert.deepEqual(autoDownloadOnPlayPlan(losslessSong, lookup(flacRecord), enabledStorage), { download: false, upgrade: false });
// 升级失败放弃本次会话;首次下载失败保留重试。
assert.equal(autoDownloadFailureIsRetryable(true), false);
assert.equal(autoDownloadFailureIsRetryable(false), true);
// 失败后如何更新去重集合:升级失败必须把 key 留在集合里,否则下次播放会再重写同一份文件。
const upgradeAttempts = new Set(['qq:lossy-song:hash']);
assert.equal(retainAutoDownloadAttempt(upgradeAttempts, 'qq:lossy-song:hash', true), true);
assert.equal(upgradeAttempts.has('qq:lossy-song:hash'), true, '升级失败后必须保留去重 key,禁止本会话重试');
// 首次下载失败应把 key 移出集合,保留旧的"下次播放可重试"语义。
const firstAttempts = new Set(['qq:new-song:hash']);
assert.equal(retainAutoDownloadAttempt(firstAttempts, 'qq:new-song:hash', false), false);
assert.equal(firstAttempts.has('qq:new-song:hash'), false, '首次下载失败应允许重试');

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
