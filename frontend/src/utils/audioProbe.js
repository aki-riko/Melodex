const normalizeMime = (mime = '') => {
  const value = String(mime || '').trim().toLowerCase();
  const idx = value.indexOf(';');
  return idx >= 0 ? value.slice(0, idx).trim() : value;
};

const hasBytes = (bytes, offset, values) => {
  if (!bytes || bytes.length < offset + values.length) return false;
  return values.every((value, index) => bytes[offset + index] === value);
};

export const detectAudioHeader = (bytes) => {
  if (!bytes || !bytes.length) return '';
  if (hasBytes(bytes, 0, [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c])) return 'wma';
  if (hasBytes(bytes, 0, [0x66, 0x4c, 0x61, 0x43])) return 'flac';
  if (hasBytes(bytes, 0, [0x49, 0x44, 0x33])) return 'mp3';
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'mp3';
  if (hasBytes(bytes, 0, [0x4f, 0x67, 0x67, 0x53])) return 'ogg';
  if (bytes.length >= 12 && hasBytes(bytes, 4, [0x66, 0x74, 0x79, 0x70])) return 'm4a';
  if (bytes.length >= 12 && hasBytes(bytes, 0, [0x52, 0x49, 0x46, 0x46]) && hasBytes(bytes, 8, [0x57, 0x41, 0x56, 0x45])) return 'wav';
  return '';
};

const mimeLooksAudio = (mime = '') => {
  const value = normalizeMime(mime);
  return value.startsWith('audio/') || value === 'application/ogg' || value === 'video/x-ms-asf' || value === 'application/vnd.ms-asf';
};

const looksLikeTextResponse = (bytes) => {
  if (!bytes || !bytes.length) return false;
  const text = Array.from(bytes.slice(0, Math.min(bytes.length, 64)))
    .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : ' '))
    .join('')
    .trimStart()
    .toLowerCase();
  return text.startsWith('<!doctype')
    || text.startsWith('<html')
    || text.startsWith('<')
    || text.startsWith('{')
    || text.startsWith('[')
    || text.startsWith('error')
    || text.startsWith('failed')
    || text.startsWith('upstream');
};

export const audioBytesLookPlayable = (bytes, mime = '') => {
  if (!bytes || !bytes.length) return false;
  if (detectAudioHeader(bytes)) return true;
  if (!mimeLooksAudio(mime)) return false;
  return !looksLikeTextResponse(bytes);
};

export const audioBlobLooksPlayable = async (blob, mime = '') => {
  if (!blob || !blob.size || typeof blob.slice !== 'function') return false;
  const header = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  return audioBytesLookPlayable(header, mime || blob.type || '');
};
