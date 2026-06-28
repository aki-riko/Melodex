import React, { useState, useEffect, useCallback } from 'react';
import { Play, Trash2 } from 'lucide-react';
import SongRow from './SongRow';
import { usePlayer } from '../contexts/PlayerContext';
import { useCollections } from '../contexts/CollectionsContext';
import { onOpenPlaylist } from '../services/playlistBus';
import { getCollectionSongs, removeSongFromCollection } from '../services/collections';
import { coverProxyUrl } from '../services/musicdl';

// 歌单详情头图:用歌单内歌曲封面拼图(Spotify 风格)。
//   - 取前 4 首"有封面"的歌:1 张铺满 / 2-3 张仍用首张铺满(半拼不好看) / ≥4 张 2x2 马赛克
//   - 走 cover_proxy(网易 http 封面在 https 生产会被拦混合内容)
//   - 无封面 → 灰占位 + Play 图标(保留原样)
function PlaylistCover({ songs }) {
  const covered = (songs || []).filter((s) => s && (s.cover || s.Cover));
  const placeholder = (
    <div className="w-32 h-32 rounded-lg bg-secondary flex items-center justify-center flex-shrink-0 overflow-hidden shadow">
      <Play size={40} className="text-muted-foreground" />
    </div>
  );
  if (covered.length === 0) return placeholder;

  if (covered.length >= 4) {
    const four = covered.slice(0, 4);
    return (
      <div className="w-32 h-32 rounded-lg overflow-hidden flex-shrink-0 shadow grid grid-cols-2 grid-rows-2 bg-secondary">
        {four.map((s, i) => (
          <img key={i} src={coverProxyUrl(s)} alt="" loading="lazy" className="w-full h-full object-cover" />
        ))}
      </div>
    );
  }
  return (
    <div className="w-32 h-32 rounded-lg overflow-hidden flex-shrink-0 shadow bg-secondary">
      <img src={coverProxyUrl(covered[0])} alt="" loading="lazy" className="w-full h-full object-cover" />
    </div>
  );
}

// 自建歌单详情页:侧栏点歌单 → 派发 {collectionId,name} → 这里加载歌曲并播放/移除。
export default function MyPlaylist() {
  const [meta, setMeta] = useState(null); // {collectionId, name}
  const [songs, setSongs] = useState([]);
  const [loading, setLoading] = useState(false);
  const { play, isPlaying } = usePlayer();
  const { remove, refresh } = useCollections();

  const load = useCallback(async (collectionId) => {
    setLoading(true);
    try {
      const data = await getCollectionSongs(collectionId);
      const list = Array.isArray(data) ? data : (data?.songs || []);
      setSongs(list);
    } catch { setSongs([]); } finally { setLoading(false); }
  }, []);

  useEffect(() => onOpenPlaylist((m) => {
    if (m && m.collectionId != null) { setMeta(m); load(m.collectionId); }
  }), [load]);

  if (!meta) {
    return <p className="text-muted-foreground py-10 text-center">从左侧选择一个歌单</p>;
  }

  const handleRemove = async (song) => {
    try {
      await removeSongFromCollection(meta.collectionId, song);
      setSongs((s) => s.filter((x) => !(x.id === song.id && x.source === song.source)));
    } catch { /* 静默 */ }
  };

  const handleDeleteCollection = async () => {
    if (!window.confirm(`删除歌单「${meta.name}」?`)) return;
    await remove(meta.collectionId);
    setMeta(null); setSongs([]);
  };

  return (
    <div>
      <div className="flex items-end gap-4 mb-6">
        <PlaylistCover songs={songs} />
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">歌单</p>
          <h1 className="text-3xl font-black truncate">{meta.name}</h1>
          <p className="text-sm text-muted-foreground mt-1">{songs.length} 首</p>
          <div className="flex gap-2 mt-3">
            <button onClick={() => songs.length && play(songs[0], songs)}
              disabled={!songs.length}
              className="flex items-center gap-2 px-5 py-2 rounded-full bg-primary text-primary-foreground font-semibold disabled:opacity-50">
              <Play size={18} fill="currentColor" />播放全部
            </button>
            <button onClick={handleDeleteCollection}
              className="flex items-center gap-2 px-4 py-2 rounded-full text-muted-foreground hover:text-destructive transition-colors"
              title="删除歌单">
              <Trash2 size={18} />
            </button>
          </div>
        </div>
      </div>
      {loading && <p className="text-muted-foreground">加载中…</p>}
      {!loading && songs.length === 0 && (
        <p className="text-muted-foreground">这个歌单还没有歌,去搜索里点曲目的 + 加进来吧。</p>
      )}
      <div className="space-y-0.5">
        {songs.map((song, i) => (
          <SongRow key={`${song.source}-${song.id}`} song={song} index={i}
            isPlaying={isPlaying(song)} onPlay={(s) => play(s, songs)}
            onRemove={handleRemove} />
        ))}
      </div>
    </div>
  );
}
