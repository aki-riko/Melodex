import React from 'react';
import { useQuery, useQueryClient } from 'react-query';
import { Play, Clock, Trash2, Download, Check, RotateCw } from 'lucide-react';
import SongRow, { SongListHeader } from './SongRow';
import { usePlayer } from '../contexts/PlayerContext';
import { useAuth } from '../contexts/AuthContext';
import { useFeedback } from '../contexts/FeedbackContext';
import { getPlayHistory, clearPlayHistory, saveToServer } from '../services/musicdl';
import { useScopedBulkState } from '../hooks/useScopedBulkState';
import LoadingState from './LoadingState';
import CoverMosaic from './CoverMosaic';

const IDLE_BULK_DOWNLOAD = { phase: 'idle', done: 0, fail: 0, total: 0 };

// 最近播放页:列出按用户隔离的播放历史(后端 played_at 降序,封顶 500)。
// 播放任意一首会以整张历史为队列;支持清空 / 删单条。
export default function RecentlyPlayed() {
  const { play, isPlaying, isPaused, togglePlay } = usePlayer();
  const { offline } = useAuth();
  const feedback = useFeedback();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery(['play-history'], getPlayHistory, { staleTime: 0 });
  const songs = data || [];
  const downloadTasks = useScopedBulkState(IDLE_BULK_DOWNLOAD, 'recent-download');
  const taskKey = 'recent:all';
  const bulkDownload = downloadTasks.getState(taskKey);

  // 把最近播放里能播的歌全部下载到服务器(NAS)。逐首 saveToServer:
  // 活的成功计入 done,死链下载失败计入 fail —— 天然实现"只落活的"。
  const handleDownloadAll = async () => {
    if (!songs.length || offline || bulkDownload.phase === 'running') return;
    const list = songs.slice();
    const total = list.length;
    let done = 0;
    let fail = 0;
    // runForKey 在同 key 已在下载时立即返回 false 且不执行 worker,
    // 此时 done/fail 仍为 0,不能弹 toast(否则误报"已下载 0 首")。
    const started = await downloadTasks.runForKey(taskKey, { phase: 'running', done, fail, total }, async (update) => {
      for (const song of list) {
        try {
          const result = await saveToServer(song);
          if (result?.saved) done += 1;
          else fail += 1;
        } catch {
          fail += 1;
        }
        update({ phase: 'running', done, fail, total });
      }
      update({ phase: fail ? 'fail' : 'done', done, fail, total });
    });
    if (!started) return;
    if (fail) feedback.error(`下载完成,${fail} 首失败(多为死链/需登录)`);
    else feedback.success(`已全部下载到服务器 ${done} 首`);
  };

  const bulkDownloadLabel = (() => {
    if (bulkDownload.phase === 'running') return `下载到服务器 ${bulkDownload.done + bulkDownload.fail}/${bulkDownload.total}`;
    if (bulkDownload.phase === 'done') return '已下载到服务器';
    if (bulkDownload.phase === 'fail') return '重试下载到服务器';
    return '全部下载到服务器';
  })();
  const BulkIcon = bulkDownload.phase === 'done' ? Check : bulkDownload.phase === 'fail' ? RotateCw : Download;

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
        <CoverMosaic items={songs} icon={Clock} />
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
            <button onClick={handleDownloadAll}
              disabled={!songs.length || offline || bulkDownload.phase === 'running'}
              className={`flex items-center gap-2 px-4 py-2 rounded-full font-semibold transition-colors disabled:opacity-50 ${
                bulkDownload.phase === 'done' ? 'bg-primary/10 text-primary'
                : bulkDownload.phase === 'fail' ? 'bg-destructive/10 text-destructive hover:bg-destructive/20'
                : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}`}
              title={offline ? '离线状态无法下载到服务器' : '把最近播放里能播的歌全部下载到服务器(NAS)'}>
              <BulkIcon size={18} className={bulkDownload.phase === 'running' ? 'animate-pulse' : ''} />
              {bulkDownloadLabel}
            </button>
            <button onClick={handleClearAll}
              disabled={!songs.length}
              className="flex items-center gap-2 px-4 py-2 rounded-full text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
              title="清空记录">
              <Trash2 size={18} />
            </button>
          </div>
          {bulkDownload.phase !== 'idle' && (
            <div className={`mt-3 inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs ${
              bulkDownload.phase === 'fail' ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border bg-card/70 text-muted-foreground'}`}>
              <span>
                已完成 {bulkDownload.done}/{bulkDownload.total}
                {bulkDownload.fail ? ` · 失败 ${bulkDownload.fail}` : ''}
              </span>
            </div>
          )}
        </div>
      </div>
      {isLoading && (
        <LoadingState
          title="加载最近播放"
          detail="正在读取当前账号的播放记录"
          rows={6}
          className="mb-4"
        />
      )}
      {!isLoading && songs.length === 0 && (
        <p className="text-muted-foreground">还没有播放记录,去搜索或歌单里播放歌曲吧。</p>
      )}
      {!isLoading && (
        <>
          <SongListHeader />
          <div className="space-y-0.5">
            {songs.map((song, i) => (
              <SongRow key={`${song.source}-${song.id}`} song={song} index={i}
                isPlaying={isPlaying(song)} onPlay={(s) => play(s, songs)}
                isPaused={isPaused}
                onTogglePlayback={togglePlay}
                onRemove={handleRemove} removeTitle="从最近播放移除" removeHint="只删除这条播放记录" />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
