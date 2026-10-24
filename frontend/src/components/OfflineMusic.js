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
import { useFeedback } from '../contexts/FeedbackContext';
import { formatDuration, formatBytes } from '../utils/displayFormat';
import { sourceLabel } from '../utils/sourceLabels';
import LoadingState from './LoadingState';
import CoverMosaic from './CoverMosaic';
import Button from '../ui/Button';
import StatusLine from '../ui/StatusLine';
import EmptyState from '../ui/EmptyState';
import { cn } from '../ui/cn';

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
    if (!record.coverBlob) { setBlobUrl(''); return undefined; }
    const url = URL.createObjectURL(record.coverBlob);
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [record.coverBlob]);

  useEffect(() => { setFailed(false); }, [blobUrl, record.cover]);

  const url = blobUrl || (!offline ? coverProxyUrl(song) : '');
  return (
    <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
      {url && !failed ? (
        <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <Music size={18} className="text-muted-foreground" aria-hidden="true" />
      )}
    </div>
  );
}

function OfflineHeaderCover({ records, offline }) {
  const [items, setItems] = useState([]);

  useEffect(() => {
    const objectUrls = [];
    const next = [];
    for (const record of records || []) {
      const song = toSong(record);
      let coverUrl = '';
      if (record.coverBlob && typeof URL !== 'undefined' && URL.createObjectURL) {
        coverUrl = URL.createObjectURL(record.coverBlob);
        objectUrls.push(coverUrl);
      }
      if (!coverUrl && !offline && song.cover) coverUrl = coverProxyUrl(song);
      if (coverUrl) next.push({ ...song, coverUrl });
      if (next.length >= 4) break;
    }
    setItems(next);
    return () => objectUrls.forEach((url) => URL.revokeObjectURL(url));
  }, [records, offline]);

  return <CoverMosaic items={items} icon={HardDriveDownload} iconSize={36} getUrl={(item) => item.coverUrl} />;
}

const ROW_GRID =
  'grid grid-cols-[2rem_minmax(0,1fr)_2.5rem_2.5rem] items-center gap-3 px-3 sm:grid-cols-[2rem_minmax(0,1fr)_5rem_4rem_4rem_2.5rem_2.5rem]';

function OfflineRow({ record, index, active, offline, onPlay, onDelete }) {
  return (
    <div
      className={cn(
        'group rounded-md py-1.5 transition-colors duration-base',
        ROW_GRID,
        active ? 'bg-secondary' : 'hover:bg-secondary/60',
      )}
    >
      <span className={cn('text-right type-caption nums', active ? 'text-primary' : 'text-muted-foreground')}>
        {index + 1}
      </span>

      <div className="flex min-w-0 items-center gap-3">
        <OfflineCover record={record} offline={offline} />
        <div className="min-w-0">
          <p className={cn('truncate type-body font-medium', active ? 'text-primary' : 'text-foreground')}>
            {record.name || '未知歌曲'}
          </p>
          <p className="truncate type-caption text-muted-foreground">
            {record.artist || '未知歌手'}
            {record.album ? ` · ${record.album}` : ''}
          </p>
        </div>
      </div>

      <span className="hidden truncate type-micro text-muted-foreground sm:block">{sourceLabel(record.source)}</span>
      <span className="hidden type-micro text-muted-foreground sm:block nums">
        {record.duration ? formatDuration(record.duration) : '—'}
      </span>
      <span className="hidden type-micro text-muted-foreground sm:block nums">{formatBytes(record.size)}</span>

      <button
        type="button"
        onClick={() => onPlay(record)}
        aria-label={`播放 ${record.name || '这首歌'}`}
        title="播放"
        className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground transition-[filter] duration-base hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--ring))]"
      >
        <Play size={16} fill="currentColor" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => onDelete(record)}
        aria-label={`删除本机缓存 ${record.name || '这首歌'}`}
        title="删除本机缓存"
        className="flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground transition-colors duration-base hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

export default function OfflineMusic() {
  const { user, offline } = useAuth();
  const { play, isPlaying } = usePlayer();
  const feedback = useFeedback();
  const userId = user?.id || 0;
  const [records, setRecords] = useState([]);
  const [estimate, setEstimate] = useState({ usage: 0, quota: 0, persisted: false });
  const [loading, setLoading] = useState(true);
  const [persisting, setPersisting] = useState(false);

  const songs = useMemo(() => records.map(toSong), [records]);
  const totalSize = useMemo(() => records.reduce((sum, row) => sum + (row.size || 0), 0), [records]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rows, storage] = await Promise.all([listCachedSongs(userId), getStorageEstimate()]);
      setRecords(rows);
      setEstimate(storage);
    } catch {
      setRecords([]);
      feedback.error('离线缓存读取失败,请刷新后重试');
    } finally {
      setLoading(false);
    }
  }, [userId, feedback]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onChanged = (event) => {
      const detail = event.detail || {};
      if (detail.userId === String(userId)) load();
    };
    window.addEventListener(OFFLINE_AUDIO_CHANGED, onChanged);
    return () => window.removeEventListener(OFFLINE_AUDIO_CHANGED, onChanged);
  }, [load, userId]);

  const handlePlay = (record) => { play(toSong(record), songs); };

  const handleDelete = async (record) => {
    try {
      const deleted = await deleteCachedRecord(record.key, userId);
      if (deleted) setRecords((rows) => rows.filter((row) => row.key !== record.key));
      setEstimate(await getStorageEstimate());
    } catch {
      feedback.error('删除本机缓存失败,请稍后重试');
    }
  };

  const handleClear = async () => {
    if (!records.length) return;
    const ok = await feedback.confirm({
      title: '清空本机缓存?',
      body: '只清空当前账号在此浏览器/PWA 的离线缓存,不会删除服务器的「已下载」文件。',
      confirmLabel: '清空缓存',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteAllCachedSongs(userId);
      setRecords([]);
      setEstimate(await getStorageEstimate());
      feedback.success('本机缓存已清空');
    } catch {
      feedback.error('清空本机缓存失败,请稍后重试');
    }
  };

  const handlePersist = async () => {
    setPersisting(true);
    try {
      const ok = await requestPersistentStorage();
      setEstimate(await getStorageEstimate());
      if (!ok) feedback.warning('浏览器没有授予持久保存权限,缓存仍可使用,但空间紧张时可能被回收');
    } catch {
      feedback.error('请求持久保存失败,当前浏览器可能不支持');
    } finally {
      setPersisting(false);
    }
  };

  const primaryLoading = loading && records.length === 0;
  if (primaryLoading) {
    return <LoadingState title="读取离线音乐" detail="正在从当前浏览器/PWA 缓存读取已保存的音频" rows={7} />;
  }

  const usageLabel = estimate.quota
    ? `${formatBytes(estimate.usage)} / ${formatBytes(estimate.quota)}`
    : formatBytes(estimate.usage);
  const persistText = estimate.persisted
    ? '浏览器已尽量保留本站缓存'
    : '尚未获得持久保存权限,系统空间紧张时可能回收';

  return (
    <div>
      <header className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end">
        <OfflineHeaderCover records={records} offline={offline} />
        <div className="min-w-0 flex-1">
          <p className="type-micro uppercase tracking-wider text-muted-foreground">本机缓存</p>
          <h1 className="mt-0.5 type-hero text-foreground">离线音乐</h1>
          <p className="mt-1 type-caption text-muted-foreground">
            <span className="nums">{records.length}</span> 首 · 音频 <span className="nums">{formatBytes(totalSize) || '0 B'}</span>
            {' · '}站点 <span className="nums">{usageLabel || '0 B'}</span>
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              onClick={() => records.length && play(songs[0], songs)}
              disabled={!records.length}
            >
              <Play size={16} fill="currentColor" aria-hidden="true" />
              播放全部
            </Button>
            <Button
              variant="secondary"
              onClick={handlePersist}
              loading={persisting}
              disabled={persisting || estimate.persisted}
              title={estimate.persisted ? '浏览器已尽量持久保留本站缓存' : '请求浏览器尽量持久保留本站缓存'}
            >
              {estimate.persisted
                ? <Check size={16} aria-hidden="true" />
                : <ShieldCheck size={16} aria-hidden="true" />}
              {estimate.persisted ? '已持久保存' : '持久保存'}
            </Button>
            <Button variant="ghost" iconOnly onClick={load} disabled={loading} aria-label="刷新" title="刷新">
              <RotateCw size={16} className={loading ? 'animate-spin' : ''} />
            </Button>
            <Button
              variant="ghost"
              iconOnly
              onClick={handleClear}
              disabled={!records.length}
              aria-label="清空当前账号的本机缓存"
              title="清空当前账号缓存"
            >
              <Trash2 size={16} />
            </Button>
          </div>
        </div>
      </header>

      {offline && (
        <StatusLine tone="info" layout="banner" className="mb-3">
          离线模式:只显示本机已缓存歌曲,不会请求服务器或音乐源。
        </StatusLine>
      )}

      {/* 三块说明合并成一行内联事实,不再占用三张等宽卡片 */}
      <div className="mb-4 rounded-md border border-border/70 bg-card/40 px-3 py-2">
        <StatusLine tone={estimate.persisted ? 'success' : 'warning'}>
          本机缓存只存在当前浏览器/PWA,不进服务器曲库 · 音频 {formatBytes(totalSize) || '0 B'},站点共 {usageLabel || '0 B'} · {persistText}
        </StatusLine>
      </div>

      {loading && records.length > 0 && (
        <StatusLine tone="neutral" loading className="mb-2">正在刷新本机缓存</StatusLine>
      )}

      {records.length === 0 && (
        <EmptyState
          icon={HardDriveDownload}
          title="还没有本机缓存"
          description="在歌曲行的「更多操作」菜单里选「缓存到本机」,之后离线也能播放。"
        />
      )}

      {records.length > 0 && (
        <div className="space-y-0.5">
          {records.map((record, i) => (
            <OfflineRow
              key={record.key}
              record={record}
              index={i}
              active={!!isPlaying(toSong(record))}
              offline={offline}
              onPlay={handlePlay}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
