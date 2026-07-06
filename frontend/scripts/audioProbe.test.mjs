import assert from 'node:assert/strict';
import { audioBlobLooksPlayable, audioBytesLookPlayable, detectAudioHeader } from '../src/utils/audioProbe.js';

const bytes = (...values) => new Uint8Array(values);

assert.equal(detectAudioHeader(bytes(0x66, 0x4c, 0x61, 0x43)), 'flac', 'detect flac magic');
assert.equal(detectAudioHeader(bytes(0x49, 0x44, 0x33, 0x04)), 'mp3', 'detect id3 mp3');
assert.equal(
  detectAudioHeader(bytes(0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20)),
  'm4a',
  'detect m4a ftyp',
);
assert.equal(
  detectAudioHeader(bytes(0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45)),
  'wav',
  'detect wav riff',
);

assert.equal(audioBytesLookPlayable(new TextEncoder().encode('<!doctype html><html>login</html>'), 'audio/mpeg'), false, 'reject html mislabeled as audio');
assert.equal(audioBytesLookPlayable(new TextEncoder().encode('{"error":"expired"}'), 'audio/mpeg'), false, 'reject json mislabeled as audio');
assert.equal(audioBytesLookPlayable(bytes(0x49, 0x44, 0x33, 0x04), 'text/html'), true, 'magic wins over wrong mime');

const htmlBlob = new Blob(['<!doctype html><html>login</html>'], { type: 'audio/mpeg' });
assert.equal(await audioBlobLooksPlayable(htmlBlob, 'audio/mpeg'), false, 'reject cached html blob');

const flacBlob = new Blob([bytes(0x66, 0x4c, 0x61, 0x43, 0x00)], { type: 'audio/flac' });
assert.equal(await audioBlobLooksPlayable(flacBlob, 'audio/flac'), true, 'accept cached flac blob');

console.log('audioProbe tests passed');
