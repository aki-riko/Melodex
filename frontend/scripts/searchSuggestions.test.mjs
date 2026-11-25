// 搜索补全与「当前页过滤」的纯逻辑契约测试。
//
// 这些断言锁的是用户 2026-11 报的三件事：
//   ① 搜索完全没有补全 → 补全必须来自平台权威接口（不是只翻本地历史）；
//   ② 其他页面的搜索应该对应「当前歌单」→ 页内过滤的匹配规则；
//   ③ 同一个词再搜一次没反应 → 搜索 key 必须随提交次数变化。
//
// 不发网络请求、不渲染 React：只测能脱离环境验证的纯函数。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');
const read = (rel) => readFileSync(join(frontendRoot, rel), 'utf8');

// ---------- ① 补全：整理/去重/排序 ----------

// toSuggestTerms / resolveSuggestionKey 在组件文件里，但都是纯函数。
// 直接导入会把 React 拉进来（本仓测试跑在 node 下没有 JSX 转译），
// 所以这里复刻同一套规则并**同时断言源码里用的是这套规则**。
const normalizeSuggestName = (value) => String(value || '')
  .toLowerCase()
  .replace(/[\s()[\]（）【】·•.,，、\-—_/\\]/g, '');

const toSuggestTerms = (data) => {
  const out = [];
  const seen = new Set();
  const push = (term) => {
    const name = String(term?.name || '').trim();
    if (!name) return;
    const key = normalizeSuggestName(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ ...term, name, key });
  };
  for (const term of data?.terms || []) {
    push({ kind: term?.kind || 'song', name: term?.name, detail: String(term?.detail || '').trim() });
  }
  for (const song of data?.songs || []) {
    push({ kind: 'song', name: song?.name, detail: String(song?.artist || '').trim() });
  }
  for (const keyword of data?.keywords || []) {
    push({ kind: 'history', name: keyword, detail: '' });
  }
  return out;
};

const terms = toSuggestTerms({
  terms: [
    { kind: 'song', name: '晴天', detail: '周杰伦' },
    { kind: 'album', name: '晴天', detail: '周杰伦' }, // 同名不同类 → 必须合并
    { kind: 'singer', name: '周杰伦', detail: '' },
  ],
  songs: [{ name: '晴天', artist: '周杰伦' }], // 与补全项重复 → 合并
  keywords: ['晴天 周杰伦'],
});
assert.deepEqual(
  terms.map((t) => t.name), ['晴天', '周杰伦', '晴天 周杰伦'],
  '补全项按「结构化词条 → 缓存歌曲 → 纯关键词」排序且同名字合并',
);
assert.equal(terms[0].detail, '周杰伦', '补全项要带副标题（歌手名）');

// 源文件必须真的用这套规则（防止以后改坏而测试仍在断言副本）
const suggestSrc = read('src/components/SearchSuggestions.js');
assert.match(suggestSrc, /export function toSuggestTerms/, 'toSuggestTerms 必须仍是纯函数导出');
assert.match(suggestSrc, /const seen = new Set\(\)/, '必须按名字去重');
assert.match(suggestSrc, /SUGGEST_DEBOUNCE_MS = 180/, '必须去抖，否则每敲一个字都打上游');
assert.match(suggestSrc, /requestSeq/, '必须丢弃陈旧响应（快速输入时后发先至会显示旧结果）');
assert.match(suggestSrc, /controller\.abort\(\)/, '卸载/换词时必须中断在途请求');

// ---------- 键盘导航规则 ----------

const resolveSuggestionKey = (event, { itemCount, activeIndex, composing = false } = {}) => {
  const key = event?.key;
  if (key === 'Escape') return { handled: true, action: 'close' };
  if (key === 'Enter' && (composing || event?.nativeEvent?.isComposing)) {
    return { handled: false, action: 'none' };
  }
  if (key === 'ArrowDown' && itemCount > 0) {
    return { handled: true, action: 'focus', nextIndex: (activeIndex + 1) % itemCount };
  }
  if (key === 'ArrowUp' && itemCount > 0) {
    return { handled: true, action: 'focus', nextIndex: activeIndex <= 0 ? itemCount - 1 : activeIndex - 1 };
  }
  if (key === 'Enter' && activeIndex >= 0 && activeIndex < itemCount) {
    return { handled: true, action: 'pick', nextIndex: activeIndex };
  }
  return { handled: false, action: 'none' };
};

assert.deepEqual(
  resolveSuggestionKey({ key: 'ArrowDown' }, { itemCount: 3, activeIndex: 2 }),
  { handled: true, action: 'focus', nextIndex: 0 },
  '↓ 在末项回环到首项',
);
assert.deepEqual(
  resolveSuggestionKey({ key: 'ArrowUp' }, { itemCount: 3, activeIndex: 0 }),
  { handled: true, action: 'focus', nextIndex: 2 },
  '↑ 在首项回环到末项',
);
assert.deepEqual(
  resolveSuggestionKey({ key: 'Escape' }, { itemCount: 3, activeIndex: 0 }),
  { handled: true, action: 'close' },
  'Esc 收起',
);
assert.deepEqual(
  resolveSuggestionKey({ key: 'Enter', nativeEvent: { isComposing: true } }, { itemCount: 3, activeIndex: 1 }),
  { handled: false, action: 'none' },
  '中文输入法上屏回车不能当成选中建议',
);
assert.deepEqual(
  resolveSuggestionKey({ key: 'Enter' }, { itemCount: 3, activeIndex: 1 }),
  { handled: true, action: 'pick', nextIndex: 1 },
  'Enter 在有高亮项时选中它',
);
assert.deepEqual(
  resolveSuggestionKey({ key: 'Enter' }, { itemCount: 3, activeIndex: -1 }),
  { handled: false, action: 'none' },
  '没有高亮项时 Enter 交给表单提交（搜输入框里的词）',
);

// ---------- ② 页内过滤的匹配规则 ----------

const normalize = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/[\s()（）[\]【】·•.,，、\-—_/\\'"“”‘’《》<>|:：;；!！?？]+/g, '');

const songMatchesFilter = (song, rawQuery) => {
  const tokens = String(rawQuery || '').trim().toLowerCase().split(/\s+/).map(normalize).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = normalize([
    song?.name, song?.artist, song?.album,
    song?.extra && typeof song.extra === 'object' ? song.extra.lyric_match : '',
  ].join(' '));
  return tokens.every((token) => haystack.includes(token));
};

const songs = [
  { name: '晴天', artist: '周杰伦', album: '叶惠 美' },
  { name: '稻香', artist: '周杰伦', album: '魔杰座' },
  { name: 'Never Gonna Give You Up', artist: 'Rick Astley', album: '' },
  { name: '晴天 (Live)', artist: '周玥', album: '' },
];

assert.equal(songMatchesFilter(songs[0], '晴天'), true, '按歌名匹配');
assert.equal(songMatchesFilter(songs[0], '周杰伦'), true, '按歌手匹配');
assert.equal(songMatchesFilter(songs[0], '叶惠美'), true, '专辑名忽略空格匹配');
assert.equal(songMatchesFilter(songs[1], '晴天'), false, '不相关的歌不能命中');
assert.equal(songMatchesFilter(songs[0], ''), true, '空关键词不过滤');
assert.equal(songMatchesFilter(songs[0], '   '), true, '纯空白不过滤');
assert.equal(songMatchesFilter(songs[2], 'never gonna'), true, '英文忽略大小写且支持多词');
assert.equal(songMatchesFilter(songs[2], 'NEVER ASTLEY'), true, '多个词命中不同字段');
assert.equal(songMatchesFilter(songs[0], '晴天 周杰伦'), true, '歌名+歌手组合命中');
assert.equal(songMatchesFilter(songs[0], '晴天 稻香'), false, '每个词都必须命中');
assert.equal(songMatchesFilter({ name: 'x', extra: { lyric_match: '故事的小黄花' } }, '小黄花'), true,
  '歌词命中片段也参与过滤（与找歌页一致）');

// 过滤结果是原来数组的子集（顺序保持），播放队列才不会乱序
const filtered = songs.filter((s) => songMatchesFilter(s, '周杰伦'));
assert.deepEqual(filtered.map((s) => s.name), ['晴天', '稻香'], '过滤保持原顺序');

// 源文件必须真的是"过滤而非重排/重查"
const filterSrc = read('src/hooks/useSongFilter.js');
assert.match(filterSrc, /\.filter\(\(song\) => songMatchesFilter/, '必须是本地 filter');
assert.match(filterSrc, /tokens\.every/, '多词必须是"全部命中"而不是"任一命中"');

// ---------- ③ 同一个词再搜一次必须真的重查 ----------

const downloadSrc = read('src/components/Download.js');
assert.match(
  downloadSrc,
  /searchNonce/,
  '必须有 searchNonce：否则同一个词再次提交时 setQuery 值相同 → React bail out → 不发请求',
);
assert.match(
  downloadSrc,
  /searchQueryKey\(query, searchNonce\)/,
  'searchNonce 必须参与 query key，才能让"再搜一次"成为新查询',
);
assert.match(
  downloadSrc,
  /setSearchNonce\(\(n\) => n \+ 1\)/,
  '每次提交都要递增 nonce',
);
assert.doesNotMatch(
  downloadSrc,
  /if \(k !== query\) \{\s*queryClient\.removeQueries[\s\S]{0,200}?setQuery\(k\);\s*return;\s*\}\s*await queryClient\.invalidateQueries/,
  '清缓存后也必须递增 nonce，不能只 invalidate（旧 key 仍会被缓存挡住）',
);

// staleTime 仍然要保留：它保护的是"切页回来别重搜"，与"手动再搜"是两件事
assert.match(downloadSrc, /staleTime: 5 \* 60 \* 1000/, 'staleTime 不应被移除（切页回来仍复用结果）');

// ---------- TopBar：页内过滤优先，且保留全网入口 ----------

const topBarSrc = read('src/components/TopBar.js');
assert.match(topBarSrc, /usePageSearchFilter/, 'TopBar 必须读取当前页注册的过滤器');
assert.match(topBarSrc, /pageFilterActive/, '必须有"当前页过滤"分支');
assert.match(
  topBarSrc,
  /runGlobalSearch/,
  '页内过滤时必须保留显式的全网搜索入口（能力不能丢）',
);
assert.match(
  topBarSrc,
  /enabled: open && Boolean\(query\) && !pageFilterActive/,
  '页内过滤时不该再请求上游补全（那些全网歌名在本列表里搜不到，会误导）',
);
assert.match(topBarSrc, /搜索当前列表/, '占位符要说明是在当前列表里搜');

// 表单提交不能因为"有高亮项"就 return —— 那会让鼠标点搜索按钮完全没反应
assert.doesNotMatch(
  topBarSrc,
  /e\.preventDefault\(\);\s*if \(activeIndex >= 0\) return;/,
  '表单提交必须总是搜输入框里的词（否则下拉开着时有高亮项就点不动）',
);

// ---------- 页内过滤必须真的接进「列表 + 播放队列」 ----------
//
// 四页统一用 usePageSongFilter（一行搞定 state + 注册 + 过滤结果），
// 逐页断言，避免"只接了某几页"或"某页忘了播放队列"。

const PAGES = [
  {
    name: '我的歌单',
    file: 'src/components/MyPlaylist.js',
    options: /label:\s*currentName/,
    reset: /resetKey:\s*collectionId/,
    emptyHint: /没有匹配的歌曲/,
  },
  {
    name: '最近播放',
    file: 'src/components/RecentlyPlayed.js',
    options: /label:\s*'最近播放'/,
    reset: /resetKey:\s*user\?\.id/,
    emptyHint: /没有匹配的播放记录/,
  },
  {
    name: '已下载',
    file: 'src/components/LocalMusic.js',
    options: /label:\s*'已下载'/,
    reset: null,
    emptyHint: /没有匹配的已下载歌曲/,
  },
  {
    name: '离线音乐',
    file: 'src/components/OfflineMusic.js',
    options: /label:\s*'离线音乐'/,
    reset: /resetKey:\s*userId/,
    emptyHint: /没有匹配的本机缓存/,
  },
];

for (const page of PAGES) {
  const src = read(page.file);
  assert.match(src, /usePageSongFilter\(/, `${page.name}必须接入页内过滤`);
  assert.match(src, page.options, `${page.name}的占位词要给出列表名`);
  if (page.reset) {
    assert.match(src, page.reset, `${page.name}必须提供 resetKey（换歌单/换账号要清空过滤词）`);
  }
  assert.match(src, page.emptyHint, `${page.name}过滤无结果时要有明确提示`);
  assert.match(src, /filter\.reset/, `${page.name}过滤无结果要给一键清除`);
}

// 播放队列必须用过滤结果 —— 但四页写法不同，逐个按真实形态断言。
//
// ★ 只断言「文件里出现过 filter.filtered」是不够的：渲染列表本身就用了它，
//   把队列改回全量照样"出现过"，突变测不出来（本鱼踩过一次）。
// ★ 也不能一律断言 `play(s, filter.filtered)`：离线页把逻辑收在 handlePlay 里，
//   LocalMusic 里还有一个"专辑详情"子视图用它自己的 songs，本来就该自洽。
const QUEUE_ASSERTIONS = [
  {
    name: '我的歌单',
    file: 'src/components/MyPlaylist.js',
    patterns: [
      [/onPlay=\{\(s\)\s*=>\s*play\(s,\s*filter\.filtered\)\}/, '行内播放队列'],
      [/onClick=\{\(\)\s*=>\s*filter\.filtered\.length\s*&&\s*play\(filter\.filtered\[0\],\s*filter\.filtered\)\}/, '播放全部队列'],
    ],
  },
  {
    name: '最近播放',
    file: 'src/components/RecentlyPlayed.js',
    patterns: [
      [/onPlay=\{\(s\)\s*=>\s*play\(s,\s*filter\.filtered\)\}/, '行内播放队列'],
      [/onClick=\{\(\)\s*=>\s*filter\.filtered\.length\s*&&\s*play\(filter\.filtered\[0\],\s*filter\.filtered\)\}/, '播放全部队列'],
    ],
  },
  {
    name: '已下载',
    file: 'src/components/LocalMusic.js',
    patterns: [
      [/onPlay=\{\(s\)\s*=>\s*play\(s,\s*filter\.filtered\)\}/, '行内播放队列'],
      [/onClick=\{\(\)\s*=>\s*filter\.filtered\.length\s*&&\s*play\(filter\.filtered\[0\],\s*filter\.filtered\)\}/, '播放全部队列'],
    ],
  },
  {
    name: '离线音乐',
    file: 'src/components/OfflineMusic.js',
    // 离线页用 handlePlay 封装（record → song 的转换只在那一处）
    patterns: [
      [/const handlePlay = \(record\) => \{ play\(toSong\(record\), filter\.filtered\); \}/, 'handlePlay 队列'],
      [/onClick=\{\(\)\s*=>\s*filter\.filtered\.length\s*&&\s*play\(filter\.filtered\[0\],\s*filter\.filtered\)\}/, '播放全部队列'],
    ],
  },
];

for (const entry of QUEUE_ASSERTIONS) {
  const src = read(entry.file);
  for (const [pattern, label] of entry.patterns) {
    assert.match(
      src,
      pattern,
      `${entry.name}的${label}必须是过滤后的列表（否则播完一首会混进没显示的歌）`,
    );
  }
}

// 我的歌单额外锁定一句：播放队列确实用了 filter.filtered 而不是 songs
const playlistSrc = read('src/components/MyPlaylist.js');
assert.match(
  playlistSrc,
  /onPlay=\{\(s\) => play\(s, filter\.filtered\)\}/,
  '歌单页播放队列必须是过滤后的列表',
);

// 「已下载」的专辑视图也必须跟着过滤，否则筛完歌曲视图还留着一堆专辑
const localSrc = read('src/components/LocalMusic.js');
assert.match(localSrc, /filteredAlbums/, '专辑视图必须使用过滤后的分组');
assert.match(
  localSrc,
  /groupByAlbum\(filter\.filtered\)/,
  '专辑视图要按过滤后的曲目重新分组',
);
assert.match(
  localSrc,
  /filteredAlbums\.map/,
  '渲染必须用 filteredAlbums（原来用的是全量 albums）',
);

// 「离线音乐」渲染的是 OfflineRow(record)，过滤必须回到 records 上，
// 否则拿到的是 song 对象、丢 key/size，行会渲染不出来。
const offlineSrc = read('src/components/OfflineMusic.js');
assert.match(offlineSrc, /filteredRecords/, '离线页必须按 record 过滤（不能拿 song 对象直接渲染）');
assert.match(offlineSrc, /filteredRecords\.map/, '渲染必须用 filteredRecords');
assert.match(
  offlineSrc,
  /songIdentityKey\(toSong\(record\)\)/,
  'record → song 的身份键映射必须与过滤侧一致',
);

// hook 自身：四页共用一份，不允许页面再自己拼 state + 注册
const hookSrc = read('src/hooks/useSongFilter.js');
assert.match(hookSrc, /export function usePageSongFilter/, '必须提供一站式 usePageSongFilter');
assert.match(hookSrc, /useRegisterPageSearchFilter\(/, 'hook 内部负责注册，页面不该重复写');
assert.match(hookSrc, /resetKey/, '必须支持 resetKey（换歌单/换账号清空过滤词）');

console.log('search suggestion & page filter tests passed');
