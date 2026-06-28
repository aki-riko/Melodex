import React, { useRef, useState } from 'react';
import { useQuery, useQueryClient } from 'react-query';
import { Play, Download, Upload, RotateCw } from 'lucide-react';
import SongRow from './SongRow';
import { usePlayer } from '../contexts/PlayerContext';
import { getLocalMusic, deleteLocalMusic, uploadLocalMusic } from '../services/musicdl';

// 本地和下载页:列出当前用户的本地音乐库(下载到 NAS 的 + 上传的,后端按 user_id 归属过滤),
// 可直接播放(以整张列表为队列)、上传、删除。后端接口 /music/local_music。
export default function LocalMusic() {
  const { play, isPlaying } = usePlayer();
  const qc = useQueryClient();
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const { data, isLoading } = useQuery(['local-music-page'], () => getLocalMusic({ limit: 500 }), { staleTime: 0 });

  const tracks = data?.tracks || [];

  const refresh = () => qc.invalidateQueries(['local-music-page']);

  const handleDelete = async (song) => {
    await deleteLocalMusic(song.id);
    qc.setQueryData(['local-music-page'], (prev) =>
      prev ? { ...prev, tracks: (prev.tracks || []).filter((t) => t.id !== song.id) } : prev);
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

  return (
    <div>
      <div className="flex items-end gap-4 mb-6">
        <div className="w-32 h-32 rounded-lg bg-secondary flex items-center justify-center flex-shrink-0 shadow">
          <Download size={48} className="text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">本地音乐库</p>
          <h1 className="text-3xl font-black truncate">本地和下载</h1>
          <p className="text-sm text-muted-foreground mt-1">{tracks.length} 首</p>
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
      <p className="text-muted-foreground text-sm mb-3">
        下载目录:{data?.download_dir || '—'}
        {data && !data.exists && '(目录不存在)'}
      </p>
      {isLoading && <p className="text-muted-foreground">加载中…</p>}
      {!isLoading && tracks.length === 0 && (
        <p className="text-muted-foreground">本地音乐库为空。在搜索页下载歌曲、或在此上传文件后会出现在这里。</p>
      )}
      <div className="space-y-0.5">
        {tracks.map((song, i) => (
          <SongRow key={`${song.source}-${song.id}`} song={song} index={i}
            isPlaying={isPlaying(song)} onPlay={(s) => play(s, tracks)}
            onRemove={handleDelete} />
        ))}
      </div>
    </div>
  );
}
