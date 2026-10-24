import React from 'react';
import { useQuery, useQueryClient } from 'react-query';
import { Clock, Download, Play, Trash2 } from 'lucide-react';
import SongRow, { SongListHeader } from './SongRow';
import { usePlayer } from '../contexts/PlayerContext';
import { useAuth } from '../contexts/AuthContext';
import { useFeedback } from '../contexts/FeedbackContext';
import { getPlayHistory, clearPlayHistory } from '../services/musicdl';
import {
  runServerDownloadBatch,
  SERVER_DOWNLOAD_BULK_IDLE,
  serverDownloadBatchSummary,
} from '../services/serverDownloadBatch';
import { useScopedBulkState } from '../hooks/useScopedBulkState';
import { songIdentityKey } from '../utils/songIdentity';
import LoadingState from './LoadingState';
import CoverMosaic from './CoverMosaic';
import Button from '../ui/Button';
import StatusLine from '../ui/StatusLine';
import EmptyState from '../ui/EmptyState';

// 最近播放页:列出按用户隔离的播放历史(后端 played_at 降序,封顶 500)。
// 播放任意一首会以整张历史为队列;支持清空 / 删单条。
export default function RecentlyPlayed() {
  const { play, isPlaying, isPaused, togglePlay } = usePlayer();
  const { user, offline } = useAuth();
  const feedback = useFeedback();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery(['play-history'], getPlayHistory, { staleTime: 0 });
  const songs = data || [];
  const downloadTasks = useScopedBulkState(SERVER_DOWNLOAD_BULK_IDLE, 'recent-download');
  const taskKey = `user:${user?.id || 0}:recent:all`;
  const bulkDownload = downloadTasks.getState(taskKey);

  // 批量前读取当前账号的服务器下载记录,已存在和精确重复项直接跳过。
  const handleDownloadAll = async () => {
    if (!songs.length || offline || bulkDownload.phase === 'running') return;
    const list = songs.slice();
    const total = list.length;
    let finalResult = null;
    // runForKey 在同 key 已在下载时立即返回 false 且不执行 worker,
    // 此时不能弹 toast,否则会误报本次任务结果。
    const started = await downloadTasks.runForKey(taskKey, {
      ...SERVER_DOWNLOAD_BULK_IDLE,
      phase: 'running',
      total,
    }, async (update) => {
      finalResult = await runServerDownloadBatch(list, {
        expectedUserId: user?.id,
        onProgress: update,
      });
    });
    if (!started) return;
    if (finalResult?.statusError) {
      feedback.error('读取服务器已下载状态失败,未开始下载,请重试');
    } else if (finalResult?.authChanged || finalResult?.aborted) {
      feedback.error(serverDownloadBatchSummary(finalResult));
    } else if (finalResult?.fail) {
      feedback.error(`下载完成:${serverDownloadBatchSummary(finalResult)}`);
    } else if (!finalResult?.done && finalResult?.skipped) {
      feedback.info(`无需重复下载,已跳过 ${finalResult.skipped} 首`);
    } else {
      feedback.success(`下载完成:${serverDownloadBatchSummary(finalResult)}`);
    }
  };

  const bulkDownloadLabel = (() => {
    if (bulkDownload.phase === 'running') return '下载中';
    if (bulkDownload.phase === 'done') return '已下载';
    if (bulkDownload.phase === 'fail') return '重试下载';
    return '全部下载到服务器';
  })();

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
    const targetKey = songIdentityKey(song);
    const prev = qc.getQueryData(['play-history']) || [];
    qc.setQueryData(['play-history'], prev.filter((x) => songIdentityKey(x) !== targetKey));
    try {
      await clearPlayHistory(song);
    } catch (err) {
      qc.setQueryData(['play-history'], prev);
      feedback.error(`删除播放记录失败:${err?.response?.data?.error || err?.message || '请稍后重试'}`);
    }
  };

  return (
    <div>
      <header className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end">
        <CoverMosaic items={songs} icon={Clock} iconSize={36} />
        <div className="min-w-0 flex-1">
          <p className="type-micro uppercase tracking-wider text-muted-foreground">播放记录</p>
          <h1 className="mt-0.5 type-hero text-foreground">最近播放</h1>
          <p className="mt-1 type-caption text-muted-foreground nums">{songs.length} 首</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              onClick={() => songs.length && play(songs[0], songs)}
              disabled={!songs.length}
            >
              <Play size={16} fill="currentColor" aria-hidden="true" />
              播放全部
            </Button>
            <Button
              variant="secondary"
              onClick={handleDownloadAll}
              loading={bulkDownload.phase === 'running'}
              disabled={!songs.length || offline || bulkDownload.phase === 'running'}
              title={offline ? '离线状态无法下载到服务器' : '把最近播放里能播的歌全部存到服务器'}
            >
              <Download size={16} aria-hidden="true" />
              {bulkDownloadLabel}
            </Button>
            <Button
              variant="ghost"
              iconOnly
              onClick={handleClearAll}
              disabled={!songs.length}
              aria-label="清空播放记录"
              title="清空记录"
            >
              <Trash2 size={17} />
            </Button>
          </div>
        </div>
      </header>

      {bulkDownload.phase !== 'idle' && (
        <StatusLine
          tone={bulkDownload.phase === 'fail' ? 'error' : 'neutral'}
          loading={bulkDownload.phase === 'running'}
          className="mb-3"
        >
          {serverDownloadBatchSummary(bulkDownload)}
        </StatusLine>
      )}

      {isLoading && (
        <LoadingState title="加载最近播放" detail="正在读取当前账号的播放记录" rows={5} />
      )}

      {!isLoading && songs.length === 0 && (
        <EmptyState
          icon={Clock}
          title="还没有播放记录"
          description="在「找歌」或歌单里播放任意一首,这里就会留下记录。"
        />
      )}

      {!isLoading && songs.length > 0 && (
        <>
          <SongListHeader />
          <div className="space-y-0.5">
            {songs.map((song, i) => (
              <SongRow
                key={`${song.source}-${song.id}`}
                song={song}
                index={i}
                isPlaying={isPlaying(song)}
                onPlay={(s) => play(s, songs)}
                isPaused={isPaused}
                onTogglePlayback={togglePlay}
                onRemove={handleRemove}
                removeTitle="从最近播放移除"
                removeHint="只删除这条播放记录"
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
