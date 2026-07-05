import React from 'react';

const lyricTokenSplitRe = /[\s/\\|,\uFF0C.\u3002;\uFF1B:\uFF1A!\uFF01?\uFF1F\u3001]+/;

const buildCompactLookup = (text) => {
  const compact = [];
  const map = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (/\s/.test(ch)) continue;
    compact.push(ch.toLocaleLowerCase());
    map.push(i);
  }
  return { compact: compact.join(''), map };
};

const mergeRanges = (ranges) => {
  if (!ranges.length) return [];
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((a, b) => (a.start - b.start) || (b.end - a.end));
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end) {
      merged.push({ ...range });
    } else if (range.end > last.end) {
      last.end = range.end;
    }
  }
  return merged;
};

const findTermRanges = (text, term) => {
  const normalizedTerm = String(term || '').replace(/\s+/g, '').toLocaleLowerCase();
  if (!normalizedTerm) return [];
  const { compact, map } = buildCompactLookup(text);
  const ranges = [];
  let from = 0;
  while (from < compact.length) {
    const idx = compact.indexOf(normalizedTerm, from);
    if (idx < 0) break;
    ranges.push({
      start: map[idx],
      end: map[idx + normalizedTerm.length - 1] + 1,
    });
    from = idx + normalizedTerm.length;
  }
  return ranges;
};

const lyricHighlightRanges = (text, query) => {
  const trimmedQuery = String(query || '').trim();
  if (!text || !trimmedQuery) return [];
  const exact = findTermRanges(text, trimmedQuery);
  if (exact.length) return mergeRanges(exact);

  const seen = new Set();
  const ranges = [];
  for (const term of trimmedQuery.split(lyricTokenSplitRe)) {
    const normalized = term.replace(/\s+/g, '').toLocaleLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ranges.push(...findTermRanges(text, term));
  }
  return mergeRanges(ranges);
};

const HighlightedLyricMatch = ({ text, query }) => {
  const ranges = lyricHighlightRanges(text, query);
  if (!ranges.length) return <>{text}</>;
  const nodes = [];
  let pos = 0;
  ranges.forEach((range, index) => {
    if (range.start > pos) {
      nodes.push(<span key={`plain-${index}`}>{text.slice(pos, range.start)}</span>);
    }
    nodes.push(
      <span key={`hit-${index}`} className="font-semibold text-primary">
        {text.slice(range.start, range.end)}
      </span>
    );
    pos = range.end;
  });
  if (pos < text.length) nodes.push(<span key="plain-tail">{text.slice(pos)}</span>);
  return <>{nodes}</>;
};

export default HighlightedLyricMatch;
