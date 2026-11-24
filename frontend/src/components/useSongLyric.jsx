// 歌曲歌词弹窗的共享实现(2026-11 全库扫描去重)。
//
// 背景:同样的"点歌词 → 加载中 → 拿到/无歌词/失败"三段逻辑在三个页面各写了一份
// (Download / MyPlaylist / PlaylistSongs),连三句文案都逐字相同:
//     setLyric({ song, text: '加载中…' });
//     try { const text = await getLyric(song); setLyric({ song, text: text || '无歌词' }); }
//     catch { setLyric({ song, text: '歌词加载失败' }); }
// 改文案或改交互要动三处,而且三处的 catch 写法已经出现细微分叉
// (PlaylistSongs 的变量名是 t,其余是 text)。
//
// 抽成 hook + 组件后:
//   · 状态机只有一份(loading → text/empty/error),文案只有一处;
//   · 竞态保护只有一份(快速连点多首歌时,旧请求的响应必须丢弃);
//   · 三个页面各删掉 6~8 行,只留 `<LyricDialog {...lyricDialog} />`。
//
// ★ 竞态保护是这次顺手补的:原来三处都没有 —— 点了 A 再点 B,如果 A 的请求
//   后返回,弹窗会显示 A 的歌词而标题是 B。下面用 requestId 丢弃陈旧响应。

import { useCallback, useRef, useState } from 'react';
import Dialog from '../ui/Dialog';
import { getLyric } from '../services/musicdl';

export const LYRIC_LOADING_TEXT = '加载中…';
export const LYRIC_EMPTY_TEXT = '无歌词';
export const LYRIC_ERROR_TEXT = '歌词加载失败';

/**
 * 管理"某首歌的歌词弹窗"状态。
 *
 * 返回:
 *   lyric   —— { song, text, state } 或 null(弹窗关闭)
 *   open(song)  —— 打开并加载
 *   close()     —— 关闭
 *   viewProps   —— 直接展开给 <LyricDialog>:<LyricDialog {...lyricDialog.viewProps} />
 */
export function useSongLyric() {
  const [lyric, setLyric] = useState(null);
  // 每次 open 递增;异步回调只在仍是"最后一次"时写状态。
  const requestIdRef = useRef(0);

  const close = useCallback(() => {
    // 关闭也算一次"作废":关掉之后旧请求的响应不该再把弹窗顶开。
    requestIdRef.current += 1;
    setLyric(null);
  }, []);

  const open = useCallback(async (song) => {
    if (!song) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLyric({ song, text: LYRIC_LOADING_TEXT, state: 'loading' });

    try {
      const text = await getLyric(song);
      if (requestIdRef.current !== requestId) return; // 已有更新的请求/已关闭
      setLyric({
        song,
        text: text || LYRIC_EMPTY_TEXT,
        state: text ? 'ready' : 'empty',
      });
    } catch {
      if (requestIdRef.current !== requestId) return;
      setLyric({ song, text: LYRIC_ERROR_TEXT, state: 'error' });
    }
  }, []);

  const viewProps = {
    lyric,
    onClose: close,
  };

  return { lyric, open, close, viewProps };
}

/**
 * 统一的歌词弹窗。三个页面共用,保证文案与布局只有一份。
 *
 * 标题用歌名、副标题用歌手,正文用等宽换行展示 LRC 原文
 * (不解析成滚动歌词 —— 那需要播放进度,而这个弹窗是"看词",不是"跟唱")。
 */
export function LyricDialog({ lyric, onClose }) {
  return (
    <Dialog open={!!lyric} onClose={onClose} title={lyric ? lyric.song.name : ''} size="lg">
      {lyric && (
        <>
          <p className="mb-3 type-caption text-muted-foreground">{lyric.song.artist}</p>
          <pre className="whitespace-pre-wrap font-sans type-body text-foreground">{lyric.text}</pre>
        </>
      )}
    </Dialog>
  );
}
