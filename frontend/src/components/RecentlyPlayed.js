import React from 'react';
import { useQuery, useQueryClient } from 'react-query';
import { Play, Clock, Trash2 } from 'lucide-react';
import SongRow from './SongRow';
import { usePlayer } from '../contexts/PlayerContext';
import { useFeedback } from '../contexts/FeedbackContext';
import { getPlayHistory, clearPlayHistory } from '../services/musicdl';

// 最近播放页:列出按用户隔离的播放历史(后端 played_at 降序,封顶 500)。
// 播放任意一首会以整张历史为队列;支持清空 / 删单条。
export default function RecentlyPlayed() {
  const { play, isPlaying } = usePlayer();
  const feedback = useFeedback();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery(['play-history'], getPlayHistory, { staleTime: 0 });
  const songs = data || [];

  const handleClearAll = async () => {
    if (!songs.length) return;
    const ok = await feedback.confirm({
      title: '清空最近播放?',
      body: '只删除播放记录,不会删除歌曲文件或歌单。',
      confirmLabel: '清空',
      danger: true,
    });
    if (!ok) return;
    try {
      await clearPlayHistory();
      qc.invalidateQueries(['play-history']);
      feedback.success('最近播放已清空');
    } catch {
      feedback.error('清空最近播放失败,请稍后重试');
    }
  };

  const handleRemove = async (song) => {
    await clearPlayHistory(song);
    qc.setQueryData(['play-history'], (prev) =>
      (prev || []).filter((x) => !(x.id === song.id && x.source === song.source)));
  };

  return (
    <div>
      <div className="flex items-end gap-4 mb-6">
        <div className="w-32 h-32 rounded-lg bg-secondary flex items-center justify-center flex-shrink-0 shadow">
          <Clock size={48} className="text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">播放记录</p>
          <h1 className="text-3xl font-black truncate">最近播放</h1>
          <p className="text-sm text-muted-foreground mt-1">{songs.length} 首</p>
          <div className="flex gap-2 mt-3">
            <button onClick={() => songs.length && play(songs[0], songs)}
              disabled={!songs.length}
              className="flex items-center gap-2 px-5 py-2 rounded-full bg-primary text-primary-foreground font-semibold disabled:opacity-50">
              <Play size={18} fill="currentColor" />播放全部
            </button>
            <button onClick={handleClearAll}
              disabled={!songs.length}
              className="flex items-center gap-2 px-4 py-2 rounded-full text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
              title="清空记录">
              <Trash2 size={18} />
            </button>
          </div>
        </div>
      </div>
      {isLoading && <p className="text-muted-foreground">加载中…</p>}
      {!isLoading && songs.length === 0 && (
        <p className="text-muted-foreground">还没有播放记录,去搜索或歌单里播放歌曲吧。</p>
      )}
      <div className="space-y-0.5">
        {songs.map((song, i) => (
          <SongRow key={`${song.source}-${song.id}`} song={song} index={i}
            isPlaying={isPlaying(song)} onPlay={(s) => play(s, songs)}
            onRemove={handleRemove} removeTitle="从最近播放移除" removeHint="只删除这条播放记录" />
        ))}
      </div>
    </div>
  );
}
