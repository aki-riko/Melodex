import React, { useRef, useState, useMemo } from 'react';
import { useQuery, useQueryClient } from 'react-query';
import { ChevronLeft, Disc3, Download, Play, RotateCw, Upload } from 'lucide-react';
import SongRow, { SongListHeader } from './SongRow';
import { usePlayer } from '../contexts/PlayerContext';
import { useFeedback } from '../contexts/FeedbackContext';
import { getLocalMusic, deleteLocalMusic, uploadLocalMusic, coverProxyUrl } from '../services/musicdl';
import LoadingState from './LoadingState';
import CoverMosaic from './CoverMosaic';
import { useCachedRefresh } from '../hooks/useCachedRefresh';
import { songIdentityKey } from '../utils/songIdentity';
import Button from '../ui/Button';
import Segmented from '../ui/Segmented';
import StatusLine from '../ui/StatusLine';
import EmptyState from '../ui/EmptyState';
import { cn } from '../ui/cn';

const UNKNOWN_ALBUM = '未知专辑';

// 把曲目按「专辑 + 专辑艺人」聚合。
// 旧实现只按 album 名分组,不同艺人的「未知专辑」会被合并成一张。
function groupByAlbum(tracks) {
  const map = new Map();
  for (const t of tracks) {
    const albumName = (t.album && t.album.trim()) || UNKNOWN_ALBUM;
    const artist = (t.album_artist || t.artist || '').trim();
    const key = `${albumName}\u0000${artist}`;
    if (!map.has(key)) map.set(key, { key, name: albumName, artist, songs: [] });
    map.get(key).songs.push(t);
  }
  return Array.from(map.values());
}

// 专辑封面:取专辑内首张有封面的歌(走 cover_proxy);无则 Disc 占位 + onError 回退。
function AlbumCover({ songs }) {
  const [failed, setFailed] = useState(false);
  const covered = (songs || []).find((s) => s && s.cover);
  if (!covered || failed) {
    return (
      <div className="flex aspect-square w-full items-center justify-center rounded-md bg-secondary">
        <Disc3 size={36} className="text-muted-foreground" aria-hidden="true" />
      </div>
    );
  }
  return (
    <div className="aspect-square w-full overflow-hidden rounded-md bg-secondary">
      <img
        src={coverProxyUrl(covered)}
        alt=""
        loading="lazy"
        className="h-full w-full object-cover transition-transform duration-slow ease-standard group-hover:scale-[1.03]"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

// 已下载页:下载到服务器的音乐 + 上传文件,按 user_id 归属过滤。
export default function LocalMusic() {
  const { play, isPlaying, isPaused, togglePlay } = usePlayer();
  const feedback = useFeedback();
  const qc = useQueryClient();
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [view, setView] = useState('songs');
  const [openAlbum, setOpenAlbum] = useState(null);
  const localMusic = useQuery(['local-music-page'], () => getLocalMusic({ limit: 0 }), { staleTime: 0 });
  useCachedRefresh(localMusic);
  const { data, isLoading, isFetching } = localMusic;
  const primaryLoading = isLoading || (!data && isFetching);

  const tracks = useMemo(() => data?.tracks || [], [data]);
  const albums = useMemo(() => groupByAlbum(tracks), [tracks]);

  const refresh = () => { qc.invalidateQueries(['local-music-page']); setOpenAlbum(null); };

  // 删除是不可撤销的服务器文件操作:先确认,失败要看得见,并做乐观回滚。
  const handleDelete = async (song) => {
    const ok = await feedback.confirm({
      title: '从服务器删除这首歌?',
      body: `「${song.name || '这首歌'}」的文件会从下载目录移除,无法恢复。`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteLocalMusic(song.id);
      qc.setQueryData(['local-music-page'], (prev) =>
        prev ? { ...prev, tracks: (prev.tracks || []).filter((t) => t.id !== song.id) } : prev);
      setOpenAlbum((a) => (a ? { ...a, songs: a.songs.filter((t) => t.id !== song.id) } : a));
      feedback.success('已从服务器删除');
    } catch (err) {
      feedback.error(`删除失败:${err?.response?.data?.error || err?.message || '请稍后重试'}`);
    }
  };

  const onFile = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    setUploading(true);
    try {
      await uploadLocalMusic(f);
      refresh();
      feedback.success('上传完成');
    } catch (err) {
      feedback.error(`上传失败:${err?.response?.data?.error || err.message || '未知错误'}`);
    } finally {
      setUploading(false);
    }
  };

  if (primaryLoading) {
    return <LoadingState title="读取已下载列表" detail="正在扫描服务器下载目录、专辑和封面信息" rows={8} />;
  }

  // 专辑详情视图
  if (openAlbum) {
    const songs = openAlbum.songs;
    return (
      <div>
        <Button variant="ghost" size="sm" onClick={() => setOpenAlbum(null)} className="mb-4 -ml-2">
          <ChevronLeft size={16} aria-hidden="true" />
          返回专辑
        </Button>
        <header className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="w-28 flex-shrink-0 sm:w-32"><AlbumCover songs={songs} /></div>
          <div className="min-w-0 flex-1">
            <p className="type-micro uppercase tracking-wider text-muted-foreground">专辑</p>
            <h1 className="mt-0.5 line-clamp-2 type-hero text-foreground">{openAlbum.name}</h1>
            <p className="mt-1 type-caption text-muted-foreground">
              {openAlbum.artist ? `${openAlbum.artist} · ` : ''}<span className="nums">{songs.length}</span> 首
            </p>
            <div className="mt-3">
              <Button variant="primary" onClick={() => songs.length && play(songs[0], songs)} disabled={!songs.length}>
                <Play size={16} fill="currentColor" aria-hidden="true" />
                播放全部
              </Button>
            </div>
          </div>
        </header>
        <SongListHeader />
        <div className="space-y-0.5">
          {songs.map((song, i) => (
            <SongRow
              key={songIdentityKey(song) || `${song.source}-${song.id}`}
              song={song}
              index={i}
              isPlaying={isPlaying(song)}
              onPlay={(s) => play(s, songs)}
              isPaused={isPaused}
              onTogglePlayback={togglePlay}
              onRemove={handleDelete}
              removeTitle="从服务器删除"
              removeHint="会移除磁盘上的文件"
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <header className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end">
        <CoverMosaic items={tracks} icon={Download} iconSize={36} />
        <div className="min-w-0 flex-1">
          <p className="type-micro uppercase tracking-wider text-muted-foreground">服务器音乐</p>
          <h1 className="mt-0.5 type-hero text-foreground">已下载到服务器</h1>
          <p className="mt-1 type-caption text-muted-foreground">
            <span className="nums">{tracks.length}</span> 首 · <span className="nums">{albums.length}</span> 张专辑
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => tracks.length && play(tracks[0], tracks)} disabled={!tracks.length}>
              <Play size={16} fill="currentColor" aria-hidden="true" />
              播放全部
            </Button>
            <Button
              variant="outline"
              onClick={() => fileRef.current && fileRef.current.click()}
              loading={uploading}
              disabled={uploading}
            >
              {!uploading && <Upload size={16} aria-hidden="true" />}
              {uploading ? '上传中' : '上传'}
            </Button>
            <Button
              variant="ghost"
              iconOnly
              onClick={refresh}
              disabled={isFetching}
              aria-label="重新扫描下载目录"
              title="重新扫描"
            >
              <RotateCw size={16} className={isFetching ? 'animate-spin' : ''} />
            </Button>
          </div>
        </div>
      </header>

      <input
        ref={fileRef}
        type="file"
        accept=".mp3,.flac,.m4a,.aac,.ogg,.wav,.wma"
        className="hidden"
        onChange={onFile}
      />

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Segmented
          value={view}
          onChange={setView}
          options={[{ value: 'songs', label: '歌曲' }, { value: 'albums', label: '专辑' }]}
          size="sm"
          label="视图切换"
        />
        <p className="type-micro text-muted-foreground">
          下载目录:<span className="nums">{data?.download_dir || '—'}</span>
          {data && !data.exists && <span className="ml-1 text-warning">(目录不存在)</span>}
        </p>
      </div>

      {data?.refreshing && (
        <StatusLine tone="neutral" loading className="mb-3">正在后台扫描已下载文件,先显示已有结果</StatusLine>
      )}

      {tracks.length === 0 && (
        <EmptyState
          icon={Download}
          title="服务器上还没有歌"
          description="在「找歌」里把歌存到服务器,或在这里直接上传音频文件。"
          action={(
            <Button variant="primary" onClick={() => { window.location.hash = 'download'; }}>
              去找歌
            </Button>
          )}
        />
      )}

      {view === 'songs' && tracks.length > 0 && (
        <>
          <SongListHeader />
          <div className="space-y-0.5">
            {tracks.map((song, i) => (
              <SongRow
                key={songIdentityKey(song) || `${song.source}-${song.id}`}
                song={song}
                index={i}
                isPlaying={isPlaying(song)}
                onPlay={(s) => play(s, tracks)}
                isPaused={isPaused}
                onTogglePlayback={togglePlay}
                onRemove={handleDelete}
                removeTitle="从服务器删除"
                removeHint="会移除磁盘上的文件"
              />
            ))}
          </div>
        </>
      )}

      {view === 'albums' && tracks.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {albums.map((al) => (
            <div
              key={al.key}
              className="group rounded-lg border border-transparent p-1.5 transition-colors duration-base hover:border-border hover:bg-secondary/60"
            >
              <div className="relative">
                <AlbumCover songs={al.songs} />
                <button
                  type="button"
                  onClick={() => al.songs.length && play(al.songs[0], al.songs)}
                  aria-label={`播放专辑「${al.name}」`}
                  title="播放这张专辑"
                  className={cn(
                    'absolute bottom-2 right-2 flex h-10 w-10 items-center justify-center rounded-full',
                    'bg-primary text-primary-foreground shadow-lg transition-opacity duration-base',
                    'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
                    'hover:brightness-110',
                  )}
                >
                  <Play size={18} fill="currentColor" aria-hidden="true" />
                </button>
              </div>
              <button
                type="button"
                onClick={() => setOpenAlbum(al)}
                className="mt-1.5 block w-full text-left"
                title={`打开专辑「${al.name}」`}
              >
                <p className="truncate type-caption font-semibold text-foreground">{al.name}</p>
                <p className="truncate type-micro text-muted-foreground">
                  {al.artist || ''} · <span className="nums">{al.songs.length}</span> 首
                </p>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
