// 当前页面列表的**本地过滤**（不请求后端）。
//
// ## 为什么需要
// 顶部搜索框原来在任何页面都只有一条路：跳到「找歌」页做全网搜索。于是用户在
// 「我的歌单」里输入歌名想找这张歌单里的那首歌时，会被整页带走去做全网搜索 ——
// 完全不是他想要的动作。
//
// 现在：页面若提供了自己的列表，顶部搜索就**先筛这个列表**；筛不到时再给一个
// "全网搜这个词"的显式入口（由页面自己渲染），保持能力不丢。
//
// ## 与播放队列的关系（重要）
// 过滤只影响"显示哪些行"。点某一行播放时，队列必须是**过滤后的列表**，
// 否则用户看到的是一串筛选结果、播起来却混进没显示的歌 —— 表现为"下一首不对劲"。
// 所以调用方一律用 `filtered` 作为 onPlay 的队列参数。
//
// ## 匹配规则
// 歌名 / 歌手 / 专辑三个字段，忽略大小写、空白与常见标点。
// 空白分词按"每个词都要命中"处理（输入「周杰 晴天」两词都能在字段里找到才算命中）。

import { useMemo } from 'react';

const normalize = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/[\s()（）[\]【】·•.,，、\-—_/\\'"“”‘’《》<>|:：;；!！?？]+/g, '');

/** 单个歌曲是否命中关键词。空关键词一律命中（=不过滤）。 */
export const songMatchesFilter = (song, rawQuery) => {
  const tokens = String(rawQuery || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map(normalize)
    .filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = normalize([
    song?.name,
    song?.artist,
    song?.album,
    // 歌词命中片段也纳入，与找歌页的"歌词命中"保持一致
    song?.extra && typeof song.extra === 'object' ? song.extra.lyric_match : '',
  ].join(' '));
  return tokens.every((token) => haystack.includes(token));
};

/**
 * @param {Array} songs 原始列表
 * @param {string} query 过滤词
 * @returns {{ filtered: Array, active: boolean, total: number }}
 *   active 表示"确实在过滤"（关键词非空），页面据此显示"N/M 首"提示。
 */
export function useSongFilter(songs, query) {
  return useMemo(() => {
    const list = Array.isArray(songs) ? songs : [];
    const trimmed = String(query || '').trim();
    if (!trimmed) return { filtered: list, active: false, total: list.length };
    const filtered = list.filter((song) => songMatchesFilter(song, trimmed));
    return { filtered, active: true, total: list.length };
  }, [songs, query]);
}

export default useSongFilter;
