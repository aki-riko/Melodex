// 歌词弹窗逻辑只允许有一份实现(2026-11 全库扫描去重后的门禁)。
//
// 背景:同样一段"点歌词 → 加载中 → 拿到/无歌词/失败"的三段逻辑,原先在
// Download / MyPlaylist / PlaylistSongs 三个页面各写了一份,连三句文案都逐字
// 相同,而 catch 里的变量名已经出现细微分叉(一个用 text、一个用 t)。
// 现已收敛到 components/useSongLyric.jsx。
//
// 这条测试守着两件事:
//   ① 三个页面不得再各自出现那三句文案(否则说明又在抄一份);
//   ② 三个页面必须都从 useSongLyric 引入。
//
// 运行: node scripts/lyricDialogSingleSource.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptDir, '..');

const PAGES = [
  'src/components/Download.js',
  'src/components/MyPlaylist.js',
  'src/components/PlaylistSongs.js',
];

const SHARED = 'src/components/useSongLyric.jsx';

// 这三句文案只允许出现在共享实现里。
const COPY_TEXTS = ['加载中…', '无歌词', '歌词加载失败'];

const read = (rel) => readFileSync(resolve(frontendRoot, rel), 'utf8');

// ---- 1. 共享实现必须存在且含三句文案 ----
const shared = read(SHARED);
for (const text of COPY_TEXTS) {
  assert.ok(
    shared.includes(text),
    `${SHARED} 必须包含文案「${text}」—— 它是这三句文案的唯一出处`,
  );
}

// 竞态保护也必须留在共享实现里(三个页面原实现都没有,收敛时补上的)。
assert.ok(
  /requestIdRef/.test(shared),
  `${SHARED} 必须保留 requestId 竞态保护:点了 A 再点 B,旧响应不能覆盖新弹窗`,
);

// ---- 2. 各页面不得再抄这三句文案 ----
for (const page of PAGES) {
  const source = read(page);
  for (const text of COPY_TEXTS) {
    assert.ok(
      !source.includes(text),
      `${page} 里又出现了文案「${text}」—— 歌词文案只允许在 ${SHARED} 里`
      + '(否则改文案要动四处,而且已经出现过变量名分叉)',
    );
  }
}

// ---- 3. 各页面必须从共享实现引入 ----
for (const page of PAGES) {
  const source = read(page);
  assert.match(
    source,
    /import \{[^}]*\buseSongLyric\b[^}]*\} from '\.\/useSongLyric'/,
    `${page} 必须从 ./useSongLyric 引入 useSongLyric`,
  );
  assert.match(
    source,
    /import \{[^}]*\bLyricDialog\b[^}]*\} from '\.\/useSongLyric'/,
    `${page} 必须从 ./useSongLyric 引入 LyricDialog`,
  );
  assert.match(
    source,
    /const songLyric = useSongLyric\(\);/,
    `${page} 必须实例化 songLyric`,
  );
  assert.match(
    source,
    /<LyricDialog \{\.\.\.songLyric\.viewProps\} \/>/,
    `${page} 必须用 <LyricDialog {...songLyric.viewProps} /> 渲染(保证 props 形状一致)`,
  );
}

// ---- 4. 页面不得再自己持有 lyric 的 useState ----
//
// `const [lyric, setLyric] = useState(null)` 是收敛前的形态。若重新出现,
// 说明有人绕开 hook 自己管状态 —— 那竞态保护就没了。
for (const page of PAGES) {
  const source = read(page);
  assert.ok(
    !/const \[lyric, setLyric\] = useState/.test(source),
    `${page} 不得再自行管理 lyric 状态 —— 用 useSongLyric()`,
  );
}

console.log(
  '歌词弹窗单一实现通过:三句文案只存在于 useSongLyric.jsx、'
  + '三个页面都走 useSongLyric/LyricDialog、无页面自管 lyric 状态、竞态保护在位。',
);
