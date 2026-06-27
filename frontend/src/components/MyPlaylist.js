import React, { useState, useEffect, useCallback } from 'react';
import { Play, Trash2 } from 'lucide-react';
import SongRow from './SongRow';
import { usePlayer } from '../contexts/PlayerContext';
import { useCollections } from '../contexts/CollectionsContext';
import { onOpenPlaylist } from '../services/playlistBus';
import { getCollectionSongs, removeSongFromCollection } from '../services/collections';

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
        <div className="w-32 h-32 rounded-lg bg-secondary flex items-center justify-center flex-shrink-0">
          <Play size={40} className="text-muted-foreground" />
        </div>
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
          <div key={`${song.source}-${song.id}`} className="flex items-center group">
            <div className="flex-grow min-w-0">
              <SongRow song={song} index={i} isPlaying={isPlaying(song)} onPlay={(s) => play(s, songs)} />
            </div>
            <button onClick={() => handleRemove(song)}
              className="p-1.5 text-muted-foreground hover:text-destructive transition-colors flex-shrink-0"
              title="从歌单移除">
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
