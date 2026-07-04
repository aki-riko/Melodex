const textValue = (value) => (value == null ? '' : String(value));

export const normalizeSongIdentity = (song) => {
  let extra = song?.extra ?? song?.Extra ?? null;
  if (typeof extra === 'string') {
    const raw = extra.trim();
    if (!raw || raw === '{}' || raw === 'null') {
      extra = null;
    } else {
      try { extra = JSON.parse(raw); } catch { extra = raw; }
    }
  }
  return {
    id: textValue(song?.id ?? song?.ID),
    source: textValue(song?.source ?? song?.Source),
    extra,
  };
};

export const stableStringify = (value) => {
  if (value == null) return '';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};

export const hashText = (text) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

export const songExtraHash = (song) => hashText(stableStringify(normalizeSongIdentity(song).extra));

export const songIdentityKey = (song) => {
  const s = normalizeSongIdentity(song);
  return `${s.source}:${s.id}:${songExtraHash(song)}`;
};
