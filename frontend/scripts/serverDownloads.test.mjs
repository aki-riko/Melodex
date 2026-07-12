import assert from 'node:assert/strict';
import {
  serverDownloadEventBelongsToUser,
  serverDownloadStatusKey,
  serverDownloadTitleArtistKey,
} from '../src/utils/serverDownloads.js';

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

console.log('serverDownloads tests passed');
