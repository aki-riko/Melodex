import React, { useEffect, useRef, useState } from 'react';
import { Play, Download, FileText, Gauge, Check, RotateCw, ListPlus, Music, Trash2, HardDriveDownload, Save, Ellipsis } from 'lucide-react';
import { getStreamUrl, saveToServer, inspectQuality, coverProxyUrl } from '../services/musicdl';
import { cacheSong, canCacheSong, isSongCached, offlineSongKey, OFFLINE_AUDIO_CHANGED } from '../services/offlineAudio';
import { useCollections } from '../contexts/CollectionsContext';
import { useAuth } from '../contexts/AuthContext';
import { formatDuration } from '../utils/format';
import { sourceLabel } from '../utils/sourceLabels';

const fmtSec = (sec) => (sec ? formatDuration(sec * 1000) : '');
const fmtSize = (bytes) => {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)}MB` : `${(bytes / 1024).toFixed(0)}KB`;
};

const parseBitrateNum = (bitrate) => parseInt(String(bitrate || '').replace(/[^0-9]/g, ''), 10) || 0;

// 封面缩略图:走 cover_proxy(防盗链/混合内容/磁盘缓存);无封面或加载失败显音符占位。
const CoverThumb = ({ song, size = 40 }) => {
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

// 根据码率/扩展名判定音质等级
const qualityOf = (song) => {
  const ext = (song.ext || '').toLowerCase();
  const br = song.bitrate || 0;
  if (ext === 'flac' || br >= 800) return { label: '无损', cls: 'bg-primary text-primary-foreground' };
  if (br >= 320) return { label: '高品', cls: 'bg-success text-success-foreground' };
  if (br > 0) return { label: `${br}k`, cls: 'bg-muted text-muted-foreground' };
  return null;
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
    className="absolute right-0 top-full z-40 mt-2 w-56 overflow-hidden rounded-md border border-border bg-card shadow-xl"
    onClick={(e) => e.stopPropagation()}
  >
    {children}
  </div>
);

// 单首歌曲行:歌曲搜索结果与歌单/专辑详情共用。
// onRemove 不为空时在「更多」菜单里显示危险动作。
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
  const q = qualityOf(song);
  const { setAddTarget } = useCollections();
  const { user, offline } = useAuth();
  const userId = user?.id || 0;
  const [real, setReal] = useState(null); // 手动验音质结果 {size, bitrate}
  const [checking, setChecking] = useState(false);
  const [dlState, setDlState] = useState(''); // '' | 'saving' | 'done' | 'fail'
  const [cacheState, setCacheState] = useState(''); // '' | 'saving' | 'done' | 'fail'
  const [openMenu, setOpenMenu] = useState(null); // null | 'save' | 'more'
  const menuRef = useRef(null);
  const cacheable = canCacheSong(song);
  // 自动验活已拿到真实大小/码率时直接用(liveInfo),手动验音质(real)优先
  const effectiveReal = real || (liveInfo && liveInfo.state === 'ok' ? { size: liveInfo.size, bitrate: liveInfo.bitrate, bitrateNum: liveInfo.bitrateNum } : null);

  useEffect(() => {
    if (!openMenu) return undefined;
    const onPointerDown = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) setOpenMenu(null);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpenMenu(null);
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

  const handleInspect = async (e) => {
    e.stopPropagation();
    if (offline) return;
    setChecking(true);
    try {
      const r = await inspectQuality(song);
      if (r.valid) setReal({ size: r.size, bitrate: r.bitrate, bitrateNum: parseBitrateNum(r.bitrate) });
      else setReal({ size: '—', bitrate: '不可用' });
    } catch {
      setReal({ size: '—', bitrate: '失败' });
    } finally {
      setChecking(false);
    }
  };

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

  const toggleMenu = (menu, e) => {
    e.stopPropagation();
    setOpenMenu((current) => (current === menu ? null : menu));
  };

  const closeMenu = () => setOpenMenu(null);

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

  // 行播放:手机(coarse 指针)单击整行播放;电脑(精确指针)双击整行播放。
  // 行内按钮均 stopPropagation,点按钮不触发行播放。
  const isCoarse = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const handleRowClick = () => { if (isCoarse) onPlay(song); };
  const handleRowDouble = () => { if (!isCoarse) onPlay(song); };
  const saveBusy = dlState === 'saving' || cacheState === 'saving';
  const saveDone = dlState === 'done' || cacheState === 'done';
  const saveFail = dlState === 'fail' || cacheState === 'fail';
  const SaveIcon = saveBusy ? RotateCw : saveDone ? Check : saveFail ? RotateCw : Save;
  const saveButtonCls = saveFail
    ? 'text-destructive bg-destructive/10 hover:bg-destructive/20'
    : saveDone
      ? 'text-primary bg-primary/10 hover:bg-primary/20'
      : 'text-muted-foreground hover:text-foreground hover:bg-secondary';

  return (
  <div
    onClick={handleRowClick}
    onDoubleClick={handleRowDouble}
    className={`group flex items-center gap-3 px-3 py-2 rounded-md transition-colors cursor-pointer select-none ${
      isPlaying ? 'bg-secondary' : 'hover:bg-secondary/60'
    }`}
  >
    <span className={`w-6 text-right text-sm tabular-nums ${isPlaying ? 'text-primary' : 'text-muted-foreground'}`}>
      {index + 1}
    </span>
    <CoverThumb song={song} />
    <div className="flex-grow min-w-0">
      <p className={`font-medium truncate ${isPlaying ? 'text-primary' : ''}`}>
        {song.name}
        {song.is_vip && <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-primary text-primary-foreground align-middle">VIP</span>}
      </p>
      <p className="text-sm text-muted-foreground truncate">
        {song.artist}
        {song.album ? ` · ${song.album}` : ''}
      </p>
    </div>
    {/* 音质标签:真实码率优先,否则预览 */}
    {(() => {
      const br = effectiveReal?.bitrateNum || 0;
      let label, cls;
      if (effectiveReal) {
        if (br >= 800) { label = '无损'; cls = 'bg-primary/20 text-primary'; }
        else if (br >= 320) { label = '高品'; cls = 'bg-primary/10 text-primary'; }
        else if (br > 0) { label = `${br}k`; cls = 'bg-muted text-muted-foreground'; }
        else { label = '标准'; cls = 'bg-muted text-muted-foreground'; }
        return <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap ${cls}`} title="真实下载音质">{label}</span>;
      }
      return q && <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap ${q.cls}`}>{q.label}</span>;
    })()}
    <span className="text-[11px] text-muted-foreground whitespace-nowrap hidden sm:inline">{sourceLabel(song.source)}</span>
    {song.duration ? <span className="text-xs text-muted-foreground whitespace-nowrap tabular-nums hidden sm:inline">{fmtSec(song.duration)}</span> : null}
    {(effectiveReal?.size || song.size) ? (
      <span className="text-xs text-muted-foreground whitespace-nowrap hidden md:inline">{effectiveReal?.size || fmtSize(song.size)}</span>
    ) : null}
    {cacheState === 'done' && statusBadge('本机', 'bg-primary/10 text-primary')}
    {dlState === 'done' && statusBadge('NAS', 'bg-primary/10 text-primary')}
    {(cacheState === 'fail' || dlState === 'fail') && statusBadge('失败', 'bg-destructive/10 text-destructive')}
    <div ref={menuRef} className="relative flex items-center gap-1 flex-shrink-0">
      <button
        type="button"
        onClick={(e) => toggleMenu('save', e)}
        className={`flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-full px-2.5 transition-colors ${saveButtonCls}`}
        title="保存"
        aria-label="保存"
        aria-expanded={openMenu === 'save'}
      >
        <SaveIcon size={16} className={saveBusy ? 'animate-pulse' : ''} />
        <span className="hidden sm:inline text-sm font-medium">保存</span>
      </button>
      {openMenu === 'save' && (
        <MenuPanel>
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
        </MenuPanel>
      )}
      <button
        type="button"
        onClick={(e) => toggleMenu('more', e)}
        className={`flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
          openMenu === 'more' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
        }`}
        title="更多操作"
        aria-label="更多操作"
        aria-expanded={openMenu === 'more'}
      >
        <Ellipsis size={18} className={checking ? 'animate-pulse' : ''} />
      </button>
      {openMenu === 'more' && (
        <MenuPanel>
          <MenuItem
            icon={Gauge}
            label={checking ? '正在检查音质' : '检查真实音质'}
            hint={offline ? '离线状态不可用' : '刷新码率和大小'}
            onClick={runMenuAction(handleInspect)}
            disabled={offline || checking}
            busy={checking}
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
    <button onClick={(e) => { e.stopPropagation(); onPlay(song); }}
      className="flex items-center justify-center w-9 h-9 rounded-full bg-primary text-primary-foreground hover:scale-105 transition-transform flex-shrink-0"
      title="在线播放" aria-label="播放">
      <Play size={16} fill="currentColor" />
    </button>
  </div>
  );
};

export { getStreamUrl };
export default SongRow;
