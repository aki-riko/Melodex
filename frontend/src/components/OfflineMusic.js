import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, HardDriveDownload, Music, Play, RotateCw, ShieldCheck, Trash2 } from 'lucide-react';
import { coverProxyUrl } from '../services/musicdl';
import {
  deleteAllCachedSongs,
  deleteCachedRecord,
  getStorageEstimate,
  listCachedSongs,
  OFFLINE_AUDIO_CHANGED,
  requestPersistentStorage,
} from '../services/offlineAudio';
import { useAuth } from '../contexts/AuthContext';
import { usePlayer } from '../contexts/PlayerContext';
import { formatDuration } from '../utils/format';
import { sourceLabel } from '../utils/sourceLabels';

const fmtBytes = (bytes) => {
  if (!bytes) return '0B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value.toFixed(0) : value.toFixed(1)}${units[unit]}`;
};

const toSong = (record) => ({
  id: record.id,
  source: record.source,
  name: record.name,
  artist: record.artist,
  album: record.album,
  cover: record.cover,
  duration: record.duration,
  extra: record.extra,
});

function OfflineCover({ record, offline }) {
  const [failed, setFailed] = useState(false);
  const [blobUrl, setBlobUrl] = useState('');
  const song = toSong(record);

  useEffect(() => {
    if (!record.coverBlob) {
      setBlobUrl('');
      return undefined;
    }
    const url = URL.createObjectURL(record.coverBlob);
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [record.coverBlob]);

  useEffect(() => {
    setFailed(false);
  }, [blobUrl, record.cover]);

  const url = blobUrl || (!offline ? coverProxyUrl(song) : '');
  return (
    <div className="w-11 h-11 rounded bg-muted overflow-hidden flex items-center justify-center flex-shrink-0">
      {url && !failed ? (
        <img src={url} alt="" loading="lazy" className="w-full h-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <Music size={18} className="text-muted-foreground" />
      )}
    </div>
  );
}

function OfflineRow({ record, index, active, offline, onPlay, onDelete }) {
  const song = toSong(record);
  return (
    <div className={`group flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${
      active ? 'bg-secondary' : 'hover:bg-secondary/60'
    }`}>
      <span className={`w-6 text-right text-sm tabular-nums ${active ? 'text-primary' : 'text-muted-foreground'}`}>
        {index + 1}
      </span>
      <OfflineCover record={record} offline={offline} />
      <button onClick={() => onPlay(record)} className="min-w-0 flex-grow text-left">
        <p className={`font-medium truncate ${active ? 'text-primary' : ''}`}>{record.name || '未知歌曲'}</p>
        <p className="text-sm text-muted-foreground truncate">
          {record.artist || '未知歌手'}
          {record.album ? ` · ${record.album}` : ''}
        </p>
      </button>
      <span className="text-[11px] text-muted-foreground whitespace-nowrap hidden sm:inline">{sourceLabel(record.source)}</span>
      {record.duration ? (
        <span className="text-xs text-muted-foreground whitespace-nowrap tabular-nums hidden sm:inline">
          {formatDuration(record.duration * 1000)}
        </span>
      ) : null}
      <span className="text-xs text-muted-foreground whitespace-nowrap hidden md:inline">{fmtBytes(record.size)}</span>
      <button onClick={() => onPlay(record)}
        className="flex items-center justify-center w-9 h-9 rounded-full bg-primary text-primary-foreground hover:scale-105 transition-transform flex-shrink-0"
        title="播放" aria-label="播放">
        <Play size={16} fill="currentColor" />
      </button>
      <button onClick={() => onDelete(record)}
        className="p-1.5 text-muted-foreground hover:text-destructive transition-colors flex-shrink-0"
        title="删除本机缓存" aria-label="删除本机缓存">
        <Trash2 size={16} />
      </button>
    </div>
  );
}

export default function OfflineMusic() {
  const { user, offline } = useAuth();
  const { play, isPlaying } = usePlayer();
  const userId = user?.id || 0;
  const [records, setRecords] = useState([]);
  const [estimate, setEstimate] = useState({ usage: 0, quota: 0, persisted: false });
  const [loading, setLoading] = useState(false);
  const [persisting, setPersisting] = useState(false);

  const songs = useMemo(() => records.map(toSong), [records]);
  const totalSize = useMemo(() => records.reduce((sum, row) => sum + (row.size || 0), 0), [records]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rows, storage] = await Promise.all([
        listCachedSongs(userId),
        getStorageEstimate(),
      ]);
      setRecords(rows);
      setEstimate(storage);
    } catch {
      setRecords([]);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onChanged = (event) => {
      const detail = event.detail || {};
      if (detail.userId === String(userId)) load();
    };
    window.addEventListener(OFFLINE_AUDIO_CHANGED, onChanged);
    return () => window.removeEventListener(OFFLINE_AUDIO_CHANGED, onChanged);
  }, [load, userId]);

  const handlePlay = (record) => {
    play(toSong(record), songs);
  };

  const handleDelete = async (record) => {
    await deleteCachedRecord(record.key, userId);
    setRecords((rows) => rows.filter((row) => row.key !== record.key));
    setEstimate(await getStorageEstimate());
  };

  const handleClear = async () => {
    if (!records.length) return;
    if (!window.confirm('清空当前账号的全部本机缓存?')) return;
    await deleteAllCachedSongs(userId);
    setRecords([]);
    setEstimate(await getStorageEstimate());
  };

  const handlePersist = async () => {
    setPersisting(true);
    try {
      await requestPersistentStorage();
      setEstimate(await getStorageEstimate());
    } finally {
      setPersisting(false);
    }
  };

  const usageLabel = estimate.quota
    ? `${fmtBytes(estimate.usage)} / ${fmtBytes(estimate.quota)}`
    : fmtBytes(estimate.usage);

  return (
    <div>
      <div className="flex items-end gap-4 mb-6">
        <div className="w-32 h-32 rounded-lg bg-secondary flex items-center justify-center flex-shrink-0 shadow">
          <HardDriveDownload size={48} className="text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">本机缓存</p>
          <h1 className="text-3xl font-black truncate">离线音乐</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {records.length} 首 · 音频 {fmtBytes(totalSize)} · 站点 {usageLabel}
          </p>
          <div className="flex flex-wrap gap-2 mt-3">
            <button onClick={() => records.length && play(songs[0], songs)}
              disabled={!records.length}
              className="flex items-center gap-2 px-5 py-2 rounded-full bg-primary text-primary-foreground font-semibold disabled:opacity-50">
              <Play size={18} fill="currentColor" />播放全部
            </button>
            <button onClick={handlePersist}
              disabled={persisting || estimate.persisted}
              className={`flex items-center gap-2 px-4 py-2 rounded-full font-semibold transition-colors disabled:opacity-50 ${
                estimate.persisted ? 'bg-primary/10 text-primary' : 'bg-secondary text-foreground hover:bg-secondary/80'
              }`}
              title={estimate.persisted ? '浏览器已尽量持久保留本站缓存' : '请求浏览器尽量持久保留本站缓存'}>
              {estimate.persisted ? <Check size={18} /> : <ShieldCheck size={18} className={persisting ? 'animate-pulse' : ''} />}
              {estimate.persisted ? '已持久保存' : '持久保存'}
            </button>
            <button onClick={load}
              className="flex items-center gap-2 px-4 py-2 rounded-full text-muted-foreground hover:text-foreground transition-colors"
              title="刷新">
              <RotateCw size={18} className={loading ? 'animate-spin' : ''} />
            </button>
            <button onClick={handleClear}
              disabled={!records.length}
              className="flex items-center gap-2 px-4 py-2 rounded-full text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
              title="清空当前账号缓存">
              <Trash2 size={18} />
            </button>
          </div>
        </div>
      </div>

      {offline && (
        <div className="mb-4 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm text-primary">
          离线模式
        </div>
      )}

      {loading && <p className="text-muted-foreground">加载中…</p>}
      {!loading && records.length === 0 && (
        <p className="text-muted-foreground">还没有本机缓存。在搜索结果或歌单里点硬盘按钮后会出现在这里。</p>
      )}

      <div className="space-y-0.5">
        {records.map((record, i) => {
          const song = toSong(record);
          return (
            <OfflineRow
              key={record.key}
              record={record}
              index={i}
              active={!!isPlaying(song)}
              offline={offline}
              onPlay={handlePlay}
              onDelete={handleDelete}
            />
          );
        })}
      </div>
    </div>
  );
}
