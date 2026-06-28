import React, { useRef, useState, useMemo } from 'react';
import { useQuery, useQueryClient } from 'react-query';
import { Play, Download, Upload, RotateCw, Disc3, ChevronLeft } from 'lucide-react';
import SongRow from './SongRow';
import { usePlayer } from '../contexts/PlayerContext';
import { getLocalMusic, deleteLocalMusic, uploadLocalMusic, coverProxyUrl } from '../services/musicdl';

const UNKNOWN_ALBUM = '未知专辑';

// 把曲目按 album 聚合成专辑列表(保持首次出现顺序)。
function groupByAlbum(tracks) {
  const map = new Map();
  for (const t of tracks) {
    const key = (t.album && t.album.trim()) || UNKNOWN_ALBUM;
    if (!map.has(key)) map.set(key, { name: key, songs: [] });
    map.get(key).songs.push(t);
  }
  return Array.from(map.values());
}

// 专辑封面:取专辑内首张有封面的歌(走 cover_proxy);无则 Disc 占位。
function AlbumCover({ songs }) {
  const covered = (songs || []).find((s) => s && s.cover);
  if (!covered) {
    return (
      <div className="w-full aspect-square rounded-md bg-secondary flex items-center justify-center">
        <Disc3 size={40} className="text-muted-foreground" />
      </div>
    );
  }
  return (
    <div className="w-full aspect-square rounded-md overflow-hidden bg-secondary">
      <img src={coverProxyUrl(covered)} alt="" loading="lazy" className="w-full h-full object-cover" />
    </div>
  );
}

// 本地和下载页:本地音乐库(下载到 NAS + 上传,按 user_id 归属过滤)。
// 支持「歌曲 / 专辑」两种视图;可播放/上传/删除。后端接口 /music/local_music。
export default function LocalMusic() {
  const { play, isPlaying } = usePlayer();
  const qc = useQueryClient();
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [view, setView] = useState('songs'); // 'songs' | 'albums'
  const [openAlbum, setOpenAlbum] = useState(null); // 专辑详情(album 对象)
  const { data, isLoading } = useQuery(['local-music-page'], () => getLocalMusic({ limit: 500 }), { staleTime: 0 });

  const tracks = useMemo(() => data?.tracks || [], [data]);
  const albums = useMemo(() => groupByAlbum(tracks), [tracks]);

  const refresh = () => { qc.invalidateQueries(['local-music-page']); setOpenAlbum(null); };

  const handleDelete = async (song) => {
    await deleteLocalMusic(song.id);
    qc.setQueryData(['local-music-page'], (prev) =>
      prev ? { ...prev, tracks: (prev.tracks || []).filter((t) => t.id !== song.id) } : prev);
    setOpenAlbum((a) => (a ? { ...a, songs: a.songs.filter((t) => t.id !== song.id) } : a));
  };

  const onFile = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    setUploading(true);
    try {
      await uploadLocalMusic(f);
      refresh();
    } catch (err) {
      window.alert('上传失败:' + (err?.response?.data?.error || err.message || '未知错误'));
    } finally {
      setUploading(false);
    }
  };

  // 专辑详情视图
  if (openAlbum) {
    const songs = openAlbum.songs;
    return (
      <div>
        <button onClick={() => setOpenAlbum(null)}
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
          <ChevronLeft size={18} />返回专辑
        </button>
        <div className="flex items-end gap-4 mb-6">
          <div className="w-32 h-32 flex-shrink-0 shadow"><AlbumCover songs={songs} /></div>
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">专辑</p>
            <h1 className="text-3xl font-black truncate">{openAlbum.name}</h1>
            <p className="text-sm text-muted-foreground mt-1">{songs.length} 首</p>
            <button onClick={() => songs.length && play(songs[0], songs)}
              className="flex items-center gap-2 px-5 py-2 mt-3 rounded-full bg-primary text-primary-foreground font-semibold">
              <Play size={18} fill="currentColor" />播放全部
            </button>
          </div>
        </div>
        <div className="space-y-0.5">
          {songs.map((song, i) => (
            <SongRow key={`${song.source}-${song.id}`} song={song} index={i}
              isPlaying={isPlaying(song)} onPlay={(s) => play(s, songs)} onRemove={handleDelete} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-end gap-4 mb-6">
        <div className="w-32 h-32 rounded-lg bg-secondary flex items-center justify-center flex-shrink-0 shadow">
          <Download size={48} className="text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">本地音乐库</p>
          <h1 className="text-3xl font-black truncate">本地和下载</h1>
          <p className="text-sm text-muted-foreground mt-1">{tracks.length} 首 · {albums.length} 张专辑</p>
          <div className="flex flex-wrap gap-2 mt-3">
            <button onClick={() => tracks.length && play(tracks[0], tracks)}
              disabled={!tracks.length}
              className="flex items-center gap-2 px-5 py-2 rounded-full bg-primary text-primary-foreground font-semibold disabled:opacity-50">
              <Play size={18} fill="currentColor" />播放全部
            </button>
            <button onClick={() => fileRef.current && fileRef.current.click()}
              disabled={uploading}
              className="flex items-center gap-2 px-4 py-2 rounded-full border border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50">
              <Upload size={18} />{uploading ? '上传中…' : '上传'}
            </button>
            <button onClick={refresh}
              className="flex items-center gap-2 px-4 py-2 rounded-full text-muted-foreground hover:text-foreground transition-colors"
              title="刷新">
              <RotateCw size={18} />
            </button>
          </div>
        </div>
      </div>
      <input ref={fileRef} type="file" accept=".mp3,.flac,.m4a,.aac,.ogg,.wav,.wma" className="hidden" onChange={onFile} />

      {/* 视图切换:歌曲 / 专辑 */}
      <div className="flex items-center gap-2 mb-4">
        {[['songs', '歌曲'], ['albums', '专辑']].map(([k, label]) => (
          <button key={k} onClick={() => setView(k)}
            className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-colors ${
              view === k ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}>
            {label}
          </button>
        ))}
      </div>

      <p className="text-muted-foreground text-sm mb-3">
        下载目录:{data?.download_dir || '—'}
        {data && !data.exists && '(目录不存在)'}
      </p>
      {isLoading && <p className="text-muted-foreground">加载中…</p>}
      {!isLoading && tracks.length === 0 && (
        <p className="text-muted-foreground">本地音乐库为空。在搜索页下载歌曲、或在此上传文件后会出现在这里。</p>
      )}

      {view === 'songs' && (
        <div className="space-y-0.5">
          {tracks.map((song, i) => (
            <SongRow key={`${song.source}-${song.id}`} song={song} index={i}
              isPlaying={isPlaying(song)} onPlay={(s) => play(s, tracks)} onRemove={handleDelete} />
          ))}
        </div>
      )}

      {view === 'albums' && tracks.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {albums.map((al) => (
            <button key={al.name} onClick={() => setOpenAlbum(al)}
              className="group text-left p-3 rounded-lg bg-card hover:bg-secondary transition-colors">
              <div className="relative mb-2">
                <AlbumCover songs={al.songs} />
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); al.songs.length && play(al.songs[0], al.songs); }}
                  className="absolute right-2 bottom-2 w-10 h-10 rounded-full bg-primary text-primary-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-lg hover:scale-105"
                  title="播放这张专辑"
                >
                  <Play size={18} fill="currentColor" />
                </span>
              </div>
              <p className="font-semibold text-sm truncate">{al.name}</p>
              <p className="text-xs text-muted-foreground truncate">
                {al.songs[0]?.artist || ''} · {al.songs.length} 首
              </p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
