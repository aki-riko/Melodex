// 当前页面列表的**本地过滤**（不请求后端）+ 把它注册给顶部搜索框。
//
// ## 为什么需要
// 顶部搜索框原来在任何页面都只有一条路：跳到「找歌」页做全网搜索。于是用户在
// 「我的歌单」里输入歌名想找这张歌单里的那首歌时，会被整页带走去做全网搜索 ——
// 完全不是他想要的动作。用户原话：「其他页面的搜索不应该是这样的，
// 应该对应当前歌单的搜索才对」。
//
// 现在：页面若提供了自己的列表，顶部搜索就**先筛这个列表**；筛不到时再给一个
// "全网搜这个词"的显式入口（由 TopBar 渲染），保持能力不丢。
//
// ## 已接入的页面
// 我的歌单 / 已下载(本地音乐) / 最近播放 / 离线音乐。
// 新页面接入请直接用 `usePageSongFilter`（一行），不要自己拼 state + 注册 ——
// 那正是"只写了过滤、忘了播放队列"这类漏项的来源。
//
// ## 与播放队列的关系（重要）
// 过滤只影响"显示哪些行"。点某一行播放时，队列必须是**过滤后的列表**，
// 否则用户看到的是一串筛选结果、播起来却混进没显示的歌 —— 表现为"下一首不对劲"。
// 所以调用方一律用 `filtered` 作为 onPlay 的队列参数。
//
// ## 匹配规则
// 歌名 / 歌手 / 专辑三个字段，忽略大小写、空白与常见标点。
// 空白分词按"每个词都要命中"处理（输入「周杰 晴天」两词都能在字段里找到才算命中）。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRegisterPageSearchFilter } from '../contexts/pageSearchFilter.js';

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
 * @returns {{ filtered: Array, active: boolean, total: number, query: string }}
 *   active 表示"确实在过滤"（关键词非空），页面据此显示"N/M 首"提示。
 */
export function useSongFilter(songs, query) {
  return useMemo(() => {
    const list = Array.isArray(songs) ? songs : [];
    const trimmed = String(query || '').trim();
    if (!trimmed) {
      return { filtered: list, active: false, total: list.length, query: trimmed };
    }
    const filtered = list.filter((song) => songMatchesFilter(song, trimmed));
    return { filtered, active: true, total: list.length, query: trimmed };
  }, [songs, query]);
}

/**
 * 「让顶部搜索框筛这一页」的一站式 hook —— 页面只需要一行。
 *
 * 它把三件必须一起做的事绑在一起，避免每个页面各写一遍（写漏任一件都会出 bug）：
 *   ① 持有过滤词 state；
 *   ② 注册给 TopBar（`useRegisterPageSearchFilter`）；
 *   ③ 提供过滤结果，且**播放队列必须用 filtered**（见文件头注释）。
 *
 * @param {object} options
 * @param {Array}  options.songs        本页的歌曲列表
 * @param {string} options.label        占位词里的列表名（如「我喜欢」「最近播放」）
 * @param {boolean} [options.enabled]   为 false 时不接管顶栏（例如页面还没选定歌单）
 * @param {any}    [options.resetKey]   该值变化时清空过滤词（换歌单/换账号必须清，
 *                                      否则"刚切换过去就是空的"）
 * @returns {{ filtered, active, total, query, reset }}
 */
export function usePageSongFilter({ songs, label, enabled = true, resetKey }) {
  const [filterQuery, setFilterQuery] = useState('');
  const filter = useSongFilter(songs, filterQuery);

  // resetKey 变化 → 清空过滤词。
  // 用 ref 记录上一次的值，避免把 resetKey 放进依赖后"首次挂载也清一次"（无害但多余）。
  const lastResetKey = useRef(resetKey);
  useEffect(() => {
    if (lastResetKey.current === resetKey) return;
    lastResetKey.current = resetKey;
    setFilterQuery('');
  }, [resetKey]);

  useRegisterPageSearchFilter(
    enabled
      ? {
        placeholder: label ? `在「${label}」中搜索…` : '搜索当前列表…',
        count: filter.filtered.length,
        total: filter.total,
        onSearch: (keyword) => setFilterQuery(keyword || ''),
      }
      : null,
  );

  const reset = useCallback(() => setFilterQuery(''), []);

  return { ...filter, reset };
}

export default useSongFilter;
