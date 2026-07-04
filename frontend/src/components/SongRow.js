import React, { useEffect, useRef, useState } from 'react';
import { Play, Download, FileText, Check, RotateCw, ListPlus, Music, Trash2, HardDriveDownload, Ellipsis } from 'lucide-react';
import { getStreamUrl, saveToServer, coverProxyUrl } from '../services/musicdl';
import { cacheSong, canCacheSong, isSongCached, offlineSongKey, OFFLINE_AUDIO_CHANGED } from '../services/offlineAudio';
import { useCollections } from '../contexts/CollectionsContext';
import { useAuth } from '../contexts/AuthContext';
import { formatDuration } from '../utils/format';
import { sourceLabel } from '../utils/sourceLabels';

const fmtSec = (sec) => (sec ? formatDuration(sec * 1000) : '—');
const fmtSize = (bytes) => {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)}MB` : `${(bytes / 1024).toFixed(0)}KB`;
};

const CoverThumb = ({ song, size = 44 }) => {
  const [failed, setFailed] = useState(false);
  const url = coverProxyUrl(song);
  const showImg = url && !failed;
  return (
    <div
      className="flex-shrink-0 rounded bg-muted overflow-hidden flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      {showImg ? (
        <img
          src={url}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          className="w-full h-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <Music size={Math.round(size * 0.45)} className="text-muted-foreground" />
      )}
    </div>
  );
};

const qualityOf = (song) => {
  const ext = (song.ext || '').toLowerCase();
  const br = song.bitrate || 0;
  if (ext === 'flac' || br >= 800) return { label: '无损', cls: 'bg-primary text-primary-foreground' };
  if (br >= 320) return { label: '高品', cls: 'bg-success text-success-foreground' };
  if (br > 0) return { label: `${br}k`, cls: 'bg-muted text-muted-foreground' };
  return null;
};

const realQualityOf = (liveInfo, song) => {
  if (liveInfo && liveInfo.state === 'ok') {
    const br = liveInfo.bitrateNum || 0;
    if (br >= 800) return { label: '无损', cls: 'bg-primary/20 text-primary', title: '真实下载音质' };
    if (br >= 320) return { label: '高品', cls: 'bg-primary/10 text-primary', title: '真实下载音质' };
    if (br > 0) return { label: `${br}k`, cls: 'bg-muted text-muted-foreground', title: '真实下载音质' };
    return { label: '标准', cls: 'bg-muted text-muted-foreground', title: '真实下载音质' };
  }
  return qualityOf(song);
};

const statusBadge = (label, cls = 'bg-muted text-muted-foreground') => (
  <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap ${cls}`}>
    {label}
  </span>
);

const MenuItem = ({ icon: Icon, label, hint, onClick, disabled, danger, busy }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`w-full flex items-center gap-3 px-3 py-2 text-left text-sm transition-colors disabled:opacity-45 disabled:cursor-not-allowed ${
      danger ? 'text-destructive hover:bg-destructive/10' : 'text-foreground hover:bg-secondary'
    }`}
  >
    <Icon size={16} className={`flex-shrink-0 ${busy ? 'animate-pulse' : ''}`} />
    <span className="min-w-0">
      <span className="block font-medium truncate">{label}</span>
      {hint && <span className="block text-xs text-muted-foreground truncate">{hint}</span>}
    </span>
  </button>
);

const MenuPanel = ({ children }) => (
  <div
    className="absolute right-0 top-full z-40 mt-2 w-60 overflow-hidden rounded-md border border-border bg-card shadow-xl"
    onClick={(e) => e.stopPropagation()}
  >
    {children}
  </div>
);

export const SongListHeader = ({ className = '' }) => (
  <div className={`hidden md:grid grid-cols-[2rem_minmax(0,1.7fr)_minmax(8rem,1fr)_4.5rem_2.25rem] items-center gap-3 px-3 pb-2 text-xs font-semibold text-muted-foreground ${className}`}>
    <span className="text-right">#</span>
    <span>歌名 / 歌手</span>
    <span>专辑</span>
    <span className="text-right">时长</span>
    <span />
  </div>
);

const SongRow = ({
  song,
  index,
  isPlaying,
  onPlay,
  onShowLyric,
  liveInfo,
  onRemove,
  removeTitle = '从歌单移除',
  removeHint = '只从当前歌单移除',
}) => {
  const q = realQualityOf(liveInfo, song);
  const { setAddTarget } = useCollections();
  const { user, offline } = useAuth();
  const userId = user?.id || 0;
  const [dlState, setDlState] = useState('');
  const [cacheState, setCacheState] = useState('');
  const [openMenu, setOpenMenu] = useState(false);
  const menuRef = useRef(null);
  const cacheable = canCacheSong(song);
  const sizeLabel = liveInfo?.size || fmtSize(song.size);

  useEffect(() => {
    if (!openMenu) return undefined;
    const onPointerDown = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) setOpenMenu(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpenMenu(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenu]);

  useEffect(() => {
    if (!cacheable) {
      setCacheState('');
      return undefined;
    }
    let cancelled = false;
    const key = offlineSongKey(song, userId);
    const refresh = () => {
      isSongCached(song, userId)
        .then((ok) => { if (!cancelled) setCacheState((s) => (s === 'saving' ? s : (ok ? 'done' : ''))); })
        .catch(() => { if (!cancelled) setCacheState((s) => (s === 'saving' ? s : '')); });
    };
    refresh();
    const onChanged = (event) => {
      const detail = event.detail || {};
      if (detail.userId !== String(userId)) return;
      if (detail.action === 'clear' || detail.key === key) refresh();
    };
    window.addEventListener(OFFLINE_AUDIO_CHANGED, onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(OFFLINE_AUDIO_CHANGED, onChanged);
    };
  }, [cacheable, song, userId]);

  const closeMenu = () => setOpenMenu(false);

  const handleDownload = async (e) => {
    e.stopPropagation();
    if (offline) return;
    setDlState('saving');
    try {
      const r = await saveToServer(song);
      setDlState(r && r.saved ? 'done' : 'fail');
    } catch {
      setDlState('fail');
    }
  };

  const handleCache = async (e) => {
    e.stopPropagation();
    if (offline || !cacheable || cacheState === 'saving' || cacheState === 'done') return;
    setCacheState('saving');
    try {
      await cacheSong(song, { userId });
      setCacheState('done');
    } catch {
      setCacheState('fail');
    }
  };

  const handleAddToPlaylist = (e) => {
    e.stopPropagation();
    if (offline) return;
    closeMenu();
    setAddTarget(song);
  };

  const runMenuAction = (fn) => (e) => {
    e.stopPropagation();
    closeMenu();
    fn(e);
  };

  const isCoarse = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const handleRowClick = () => { if (isCoarse) onPlay(song); };
  const handleRowDouble = () => { if (!isCoarse) onPlay(song); };
  const playFromMenu = (e) => {
    e.stopPropagation();
    closeMenu();
    onPlay(song);
  };

  return (
    <div
      onClick={handleRowClick}
      onDoubleClick={handleRowDouble}
      className={`group grid grid-cols-[1.75rem_minmax(0,1fr)_2.25rem] md:grid-cols-[2rem_minmax(0,1.7fr)_minmax(8rem,1fr)_4.5rem_2.25rem] items-center gap-3 px-3 py-2 rounded-md transition-colors cursor-pointer select-none ${
        isPlaying ? 'bg-secondary' : 'hover:bg-secondary/60'
      }`}
    >
      <div className={`h-8 flex items-center justify-end text-sm tabular-nums ${isPlaying ? 'text-primary' : 'text-muted-foreground'}`}>
        <span className="group-hover:hidden">{index + 1}</span>
        <Play size={16} fill="currentColor" className="hidden group-hover:block" />
      </div>

      <div className="min-w-0 flex items-center gap-3">
        <CoverThumb song={song} />
        <div className="min-w-0">
          <p className={`font-medium truncate ${isPlaying ? 'text-primary' : 'text-foreground'}`}>
            {song.name || '未知歌曲'}
          </p>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
            <span className="truncate max-w-[14rem]">{song.artist || '未知歌手'}</span>
            {song.is_vip && statusBadge('VIP', 'bg-primary text-primary-foreground')}
            {q && statusBadge(q.label, q.cls)}
            <span className="text-[11px] whitespace-nowrap">{sourceLabel(song.source)}</span>
            {sizeLabel && <span className="text-[11px] whitespace-nowrap">{sizeLabel}</span>}
            {cacheState === 'done' && statusBadge('本机', 'bg-primary/10 text-primary')}
            {dlState === 'done' && statusBadge('NAS', 'bg-primary/10 text-primary')}
            {(cacheState === 'fail' || dlState === 'fail') && statusBadge('失败', 'bg-destructive/10 text-destructive')}
          </div>
        </div>
      </div>

      <div className="hidden md:block min-w-0 text-sm text-muted-foreground truncate">
        {song.album || '—'}
      </div>

      <div className="hidden md:block text-right text-sm tabular-nums text-muted-foreground">
        {fmtSec(song.duration)}
      </div>

      <div ref={menuRef} className="relative flex items-center justify-end">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setOpenMenu((v) => !v); }}
          className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
            openMenu ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
          }`}
          title="更多操作"
          aria-label="更多操作"
          aria-expanded={openMenu}
        >
          <Ellipsis size={18} />
        </button>
        {openMenu && (
          <MenuPanel>
            <MenuItem icon={Play} label="播放" hint="立即播放这首歌" onClick={playFromMenu} />
            <MenuItem
              icon={ListPlus}
              label="加入歌单"
              hint={offline ? '离线状态不可用' : '整理到我的歌单'}
              onClick={handleAddToPlaylist}
              disabled={offline}
            />
            {cacheable && (
              <MenuItem
                icon={cacheState === 'done' ? Check : cacheState === 'fail' ? RotateCw : HardDriveDownload}
                label={cacheState === 'done' ? '已缓存到本机' : cacheState === 'fail' ? '重试缓存到本机' : '缓存到本机'}
                hint="当前浏览器/PWA 离线播放"
                onClick={runMenuAction(handleCache)}
                disabled={offline || cacheState === 'saving' || cacheState === 'done'}
                busy={cacheState === 'saving'}
                danger={cacheState === 'fail'}
              />
            )}
            <MenuItem
              icon={dlState === 'done' ? Check : dlState === 'fail' ? RotateCw : Download}
              label={dlState === 'done' ? '已下载到 NAS' : dlState === 'fail' ? '重试下载到 NAS' : '下载到 NAS'}
              hint="进入服务器曲库长期保存"
              onClick={runMenuAction(handleDownload)}
              disabled={offline || dlState === 'saving' || dlState === 'done'}
              busy={dlState === 'saving'}
              danger={dlState === 'fail'}
            />
            {onShowLyric && (
              <MenuItem
                icon={FileText}
                label="查看歌词"
                hint="打开 LRC 文本"
                onClick={(e) => {
                  e.stopPropagation();
                  closeMenu();
                  onShowLyric(song);
                }}
              />
            )}
            {onRemove && (
              <MenuItem
                icon={Trash2}
                label={removeTitle}
                hint={removeHint}
                onClick={(e) => {
                  e.stopPropagation();
                  closeMenu();
                  onRemove(song);
                }}
                danger
              />
            )}
          </MenuPanel>
        )}
      </div>
    </div>
  );
};

export { getStreamUrl };
export default SongRow;
