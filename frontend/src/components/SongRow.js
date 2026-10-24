import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Download,
  Ellipsis,
  FileText,
  HardDriveDownload,
  Heart,
  Music,
  Pause,
  Play,
  RotateCw,
  Trash2,
} from 'lucide-react';
import {
  getStreamUrl,
  saveToServer,
  serverSaveSucceeded,
  coverProxyUrl,
  getFavoriteStatus,
  toggleFavorite,
  inspectQuality,
} from '../services/musicdl';
import { cacheSong, canCacheSong, isSongCached, offlineSongKey, OFFLINE_AUDIO_CHANGED } from '../services/offlineAudio';
import { useCollections } from '../contexts/CollectionsContext';
import { useAuth } from '../contexts/AuthContext';
import { useServerDownloads } from '../contexts/ServerDownloadsContext';
import { useFeedback } from '../contexts/FeedbackContext';
import { sourceLabel } from '../utils/sourceLabels';
import { normalizeSong } from '../utils/songFields';
import { songIdentityKey } from '../utils/songIdentity';
import { formatDuration, formatBytes } from '../utils/displayFormat';
import HighlightedLyricMatch from './HighlightedLyricMatch';
import { MenuPopover, MenuItem, MenuDivider } from '../ui/Menu';
import { cn } from '../ui/cn';

const fmtSec = (sec) => (sec ? formatDuration(sec) : '—');

// 音质徽章:颜色只表达"有损/无损"这一个二元差异,
// 不再让 VIP、无损、来源全都抢同一块绿色(此前两枚同款绿片无法区分)。
const qualityOf = (song) => {
  const ext = (song.ext || '').toLowerCase();
  const br = song.bitrate || 0;
  if (ext === 'flac' || br >= 800) return { label: '无损', tone: 'lossless' };
  if (br >= 320) return { label: '高品', tone: 'high' };
  if (br > 0) return { label: `${Math.round(br)}k`, tone: 'plain' };
  return null;
};

const realQualityOf = (liveInfo, song) => {
  if (liveInfo && liveInfo.state === 'ok') {
    const br = liveInfo.bitrateNum || 0;
    if (br >= 800) return { label: '无损', tone: 'lossless', title: '真实下载音质' };
    if (br >= 320) return { label: '高品', tone: 'high', title: '真实下载音质' };
    if (br > 0) return { label: `${Math.round(br)}k`, tone: 'plain', title: '真实下载音质' };
    return { label: '标准', tone: 'plain', title: '真实下载音质' };
  }
  return qualityOf(song);
};

const BADGE_TONES = {
  lossless: 'bg-primary/15 text-primary',
  high: 'bg-success/15 text-success',
  plain: 'bg-muted text-muted-foreground',
  vip: 'bg-warning/15 text-warning',
  warn: 'bg-warning/15 text-warning',
  ok: 'bg-primary/15 text-primary',
  bad: 'bg-destructive/15 text-destructive',
  neutral: 'bg-muted text-muted-foreground',
};

const Badge = ({ tone = 'neutral', title, children }) => (
  <span
    title={title}
    className={cn('rounded px-1.5 py-0.5 type-micro font-semibold whitespace-nowrap', BADGE_TONES[tone])}
  >
    {children}
  </span>
);

// 从歌名/专辑名文本推断是否伴奏/无人声版本(平台无独立字段,只能靠命名标记)。
const instrumentalLabelOf = (song) => {
  const text = `${song?.name || ''} ${song?.album || ''}`;
  if (/[(（\[【][^)）\]】]*(instrumental|inst\.?|off\s*vocal|karaoke|カラオケ|伴奏)[^)）\]】]*[)）\]】]/i.test(text)) {
    return '伴奏';
  }
  if (/伴奏/.test(text) || /off\s*vocal/i.test(text)) return '伴奏';
  return null;
};

const favoriteStatusCache = new Map();

const CoverThumb = ({ song, size = 44 }) => {
  const [failed, setFailed] = useState(false);
  const url = coverProxyUrl(song);
  const showImg = url && !failed;
  return (
    <div
      className="flex flex-shrink-0 items-center justify-center overflow-hidden rounded bg-muted"
      style={{ width: size, height: size }}
    >
      {showImg ? (
        <img
          src={url}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <Music size={Math.round(size * 0.45)} className="text-muted-foreground" aria-hidden="true" />
      )}
    </div>
  );
};

// 列表表头:列宽与行布局共用同一套 grid 定义,避免"表头/行/窄屏"三者错位。
// 末列必须容得下「收藏(36px) + 更多(36px)」两个按钮 —— 曾按 2.5rem 写,
// 结果两个按钮在窄列里互相挤压。这里给 5rem(80px),并让移动端同样留足。
const ROW_GRID =
  'grid grid-cols-[minmax(0,1fr)_5rem] lg:grid-cols-[2rem_minmax(0,1.6fr)_7rem_minmax(6rem,0.8fr)_3.5rem_5rem] items-center gap-3 px-3';

export const SongListHeader = ({ className = '' }) => (
  <div
    className={cn(
      'hidden lg:grid lg:grid-cols-[2rem_minmax(0,1.6fr)_7rem_minmax(6rem,0.8fr)_3.5rem_5rem]',
      'items-center gap-3 px-3 pb-1.5 type-micro font-semibold uppercase tracking-wider text-muted-foreground',
      className,
    )}
    aria-hidden="true"
  >
    <span className="text-right">#</span>
    <span>歌名 / 歌手</span>
    <span>音质</span>
    <span>专辑</span>
    <span className="text-right">时长</span>
    <span className="text-right">操作</span>
  </div>
);

// 行内图标按钮:统一尺寸/焦点/禁用态
const IconAction = ({ icon: Icon, label, onClick, disabled, active, danger, busy, className }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label={label}
    title={label}
    aria-busy={busy || undefined}
    className={cn(
      'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full',
      'transition-colors duration-base ease-standard',
      'disabled:cursor-not-allowed disabled:opacity-40',
      danger
        ? 'text-destructive hover:bg-destructive/10'
        : active
          ? 'bg-primary/10 text-primary hover:bg-primary/15'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
      className,
    )}
  >
    <Icon size={17} fill={active ? 'currentColor' : 'none'} className={busy ? 'animate-pulse' : ''} aria-hidden="true" />
  </button>
);

/**
 * 歌曲行。
 *
 * 本轮改造重点("保存语义分层 + 失败不再静默"):
 *  · 「下载到服务器」= 长期存进 NAS 曲库;「缓存到本机」= 当前浏览器离线可听。
 *    两者此前是同一排并列图标,用户无法判断后果。现在:主位置只保留"保存"入口,
 *    两个目标收进菜单并明确写出后果;已保存状态用文字徽章(服务器 / 本机)表达,
 *    而不是只靠按钮变勾。
 *  · 下载/缓存/收藏/验活失败此前全部 `console.warn` 静默(界面只多一个"失败"小字)。
 *    现在全部经 feedback 给出可读原因。
 *  · 键盘用户此前无法触发"双击播放"这一主路径;现在整行可聚焦 + Enter/空格播放。
 */
const SongRow = ({
  song,
  index,
  isPlaying,
  isPaused = false,
  onPlay,
  onTogglePlayback,
  onShowLyric,
  liveInfo,
  lyricQuery = '',
  onRemove,
  removeTitle = '从歌单移除',
  removeHint = '只从当前歌单移除',
}) => {
  const rowSong = useMemo(() => normalizeSong(song), [song]);
  const instrumentalLabel = instrumentalLabelOf(rowSong);
  const { setAddTarget } = useCollections();
  const { user, offline } = useAuth();
  const { isDownloaded } = useServerDownloads();
  const feedback = useFeedback();
  const userId = user?.id || 0;
  const [dlState, setDlState] = useState('');
  const [cacheState, setCacheState] = useState('');
  const [favorited, setFavorited] = useState(false);
  const [favBusy, setFavBusy] = useState(false);
  const [inspectState, setInspectState] = useState('');
  const [manualLiveInfo, setManualLiveInfo] = useState(null);
  const [openMenu, setOpenMenu] = useState(false);
  const menuBtnRef = useRef(null);

  const cacheable = canCacheSong(rowSong);
  const effectiveLiveInfo = manualLiveInfo || liveInfo;
  const q = realQualityOf(effectiveLiveInfo, rowSong);
  const sizeLabel = formatBytes(effectiveLiveInfo?.sizeBytes || rowSong.size);
  const rowKey = songIdentityKey(rowSong);
  const downloadedToServer = isDownloaded(rowSong);
  const favoriteCacheKey = `${userId}:${rowKey}`;
  const albumTitle = rowSong.album || '—';
  const lyricMatch = rowSong.extra && typeof rowSong.extra === 'object' ? rowSong.extra.lyric_match : '';
  const isActivelyPlaying = isPlaying && !isPaused;
  const showPausedCoverPlayButton = isPlaying && isPaused;
  const CoverActionIcon = isActivelyPlaying ? Pause : Play;
  const coverActionLabel = isActivelyPlaying ? '暂停' : '播放';

  useEffect(() => {
    setDlState(downloadedToServer ? 'done' : '');
  }, [downloadedToServer, rowKey]);

  useEffect(() => {
    setInspectState('');
    setManualLiveInfo(null);
  }, [rowKey]);

  useEffect(() => {
    if (!cacheable) { setCacheState(''); return undefined; }
    let cancelled = false;
    const key = offlineSongKey(rowSong, userId);
    const refresh = () => {
      isSongCached(rowSong, userId)
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
  }, [cacheable, rowSong, userId]);

  useEffect(() => {
    if (offline || !rowSong.id || !rowSong.source) { setFavorited(false); return undefined; }
    const cached = favoriteStatusCache.get(favoriteCacheKey);
    if (cached != null) { setFavorited(cached); return undefined; }
    let cancelled = false;
    getFavoriteStatus(rowSong)
      .then((ok) => {
        favoriteStatusCache.set(favoriteCacheKey, ok);
        if (!cancelled) setFavorited(ok);
      })
      .catch(() => { if (!cancelled) setFavorited(false); });
    return () => { cancelled = true; };
  }, [favoriteCacheKey, offline, rowSong]);

  const closeMenu = () => setOpenMenu(false);

  const handleDownload = async (e) => {
    e?.stopPropagation?.();
    if (offline || dlState === 'saving' || dlState === 'done') return;
    setDlState('saving');
    try {
      const r = await saveToServer(rowSong);
      if (serverSaveSucceeded(r)) {
        setDlState('done');
        feedback.success(`已存到服务器:${rowSong.name || '这首歌'}`);
      } else {
        setDlState('fail');
        feedback.error(`存到服务器失败:${rowSong.name || '这首歌'}(上游未返回成功)`);
      }
    } catch (err) {
      setDlState('fail');
      feedback.error(`存到服务器失败:${err?.response?.data?.error || err?.message || '网络或上游返回异常'}`);
    }
  };

  const handleInspect = async (e) => {
    e?.stopPropagation?.();
    if (offline || inspectState === 'checking') return;
    setInspectState('checking');
    try {
      const r = await inspectQuality(rowSong);
      if (r && r.valid) {
        const brNum = Number(r.bitrate_num || r.bitrateNum) || parseInt(String(r.bitrate || '').replace(/[^0-9]/g, ''), 10) || 0;
        const sizeBytes = Number(r.size_bytes || r.sizeBytes) || 0;
        setManualLiveInfo({
          state: 'ok', size: r.size, sizeBytes, bitrate: r.bitrate, bitrateNum: brNum, cached: !!r.cached,
        });
        setInspectState('ok');
      } else {
        setManualLiveInfo({ state: 'dead' });
        setInspectState('fail');
        feedback.warning(`${rowSong.name || '这首歌'}当前不可播放(版权受限或上游失效)`);
      }
    } catch (err) {
      setManualLiveInfo({ state: 'dead' });
      setInspectState('fail');
      feedback.error(`验活失败:${err?.response?.data?.error || err?.message || '无法连接到上游'}`);
    }
  };

  const handleCache = async (e) => {
    e?.stopPropagation?.();
    if (offline || !cacheable || cacheState === 'saving' || cacheState === 'done') return;
    setCacheState('saving');
    try {
      await cacheSong(rowSong, { userId });
      setCacheState('done');
      feedback.success(`已缓存到本机:${rowSong.name || '这首歌'}`);
    } catch (err) {
      setCacheState('fail');
      feedback.error(`缓存到本机失败:${err?.message || '浏览器存储空间不足或被拒绝'}`);
    }
  };

  const handleFavorite = async (e) => {
    e?.stopPropagation?.();
    if (offline || favBusy || !rowSong.id || !rowSong.source) return;
    const prev = favorited;
    setFavBusy(true);
    setFavorited(!prev);
    favoriteStatusCache.set(favoriteCacheKey, !prev);
    try {
      const next = await toggleFavorite(rowSong);
      setFavorited(next);
      favoriteStatusCache.set(favoriteCacheKey, next);
      if (next && rowSong.source !== 'local') {
        // 收藏即静默存到服务器(与"加歌单即下载"一致);失败只在控制台留痕,
        // 因为用户主动作是"收藏",不该被下载失败打断。
        saveToServer(rowSong)
          .then((r) => { if (serverSaveSucceeded(r)) setDlState('done'); })
          .catch(() => {});
      }
    } catch (err) {
      setFavorited(prev);
      favoriteStatusCache.set(favoriteCacheKey, prev);
      feedback.error(`收藏失败:${err?.response?.data?.error || err?.message || '请稍后重试'}`);
    } finally {
      setFavBusy(false);
    }
  };

  const handleAddToPlaylist = (e) => {
    e?.stopPropagation?.();
    if (offline) return;
    closeMenu();
    setAddTarget(rowSong);
  };

  const runMenuAction = (fn) => (e) => {
    e?.stopPropagation?.();
    closeMenu();
    fn(e);
  };

  const isCoarse = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

  const handleRowClick = () => {
    if (isCoarse) onPlay(rowSong);
  };
  const handleRowDouble = () => {
    if (!isCoarse) onPlay(rowSong);
  };
  const handleRowKeyDown = (event) => {
    // 键盘用户此前无法触发播放(整行是 div + onClick)
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onPlay(rowSong);
    }
  };
  const handleCoverAction = (e) => {
    e.stopPropagation();
    if (isPlaying && onTogglePlayback) { onTogglePlayback(); return; }
    onPlay(rowSong);
  };

  const savedBadges = [];
  if (cacheState === 'done') savedBadges.push('本机');
  if (dlState === 'done') savedBadges.push('服务器');

  return (
    <div
      onClick={handleRowClick}
      onDoubleClick={handleRowDouble}
      onKeyDown={handleRowKeyDown}
      tabIndex={0}
      role="button"
      aria-label={`${rowSong.name || '未知歌曲'}${rowSong.artist ? ` - ${rowSong.artist}` : ''}${isActivelyPlaying ? '(正在播放)' : ''}`}
      aria-current={isActivelyPlaying || undefined}
      className={cn(
        ROW_GRID,
        'group rounded-md py-1.5 transition-colors duration-base ease-standard',
        'cursor-pointer select-none',
        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[hsl(var(--ring))]',
        isPlaying ? 'bg-secondary' : 'hover:bg-secondary/60',
      )}
    >
      {/* 序号 */}
      <div className={cn('hidden h-8 items-center justify-end type-caption nums lg:flex', isPlaying ? 'text-primary' : 'text-muted-foreground')}>
        {isActivelyPlaying ? (
          <span className="song-row-equalizer h-4 scale-[0.7]" aria-hidden="true">
            <span /><span /><span /><span />
          </span>
        ) : index + 1}
      </div>

      {/* 封面 + 标题/艺人/徽章 */}
      <div className="flex min-w-0 items-center gap-3">
        <div className="song-row-cover-action relative flex-shrink-0">
          <CoverThumb song={rowSong} />
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleCoverAction}
            aria-label={coverActionLabel}
            title={coverActionLabel}
            className={cn(
              'absolute inset-0 z-base hidden items-center justify-center rounded bg-black/45 text-primary md:flex',
              'transition-opacity duration-base ease-standard',
              showPausedCoverPlayButton ? 'opacity-100' : 'opacity-0 hover:opacity-100 focus:opacity-100',
            )}
          >
            <CoverActionIcon size={18} fill="currentColor" aria-hidden="true" />
          </button>
        </div>

        <div className="min-w-0 flex-1">
          <p className={cn('truncate type-body font-medium', isPlaying ? 'text-primary' : 'text-foreground')}>
            {rowSong.name || '未知歌曲'}
          </p>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 type-caption text-muted-foreground">
            <span className="max-w-[12rem] truncate">{rowSong.artist || '未知歌手'}</span>
            {rowSong.is_vip && <Badge tone="vip">VIP</Badge>}
            {q && <Badge tone={q.tone} title={q.title}>{q.label}</Badge>}
            {instrumentalLabel && <Badge tone="warn">{instrumentalLabel}</Badge>}
            {inspectState === 'checking' && <Badge tone="neutral">验证中</Badge>}
            {inspectState === 'ok' && <Badge tone="ok">已验</Badge>}
            {inspectState === 'fail' && <Badge tone="bad">不可播</Badge>}
            {savedBadges.map((label) => (
              <Badge key={label} tone="ok">{label}</Badge>
            ))}
            {(cacheState === 'fail' || dlState === 'fail') && (
              <Badge tone="bad" title="上次操作失败，点行内按钮或菜单可重试">失败</Badge>
            )}
            <span className="type-micro text-muted-foreground/80">{sourceLabel(rowSong.source)}</span>
            {sizeLabel && <span className="type-micro nums">{sizeLabel}</span>}
          </div>
          {lyricMatch && (
            <p className="mt-1 flex min-w-0 items-center gap-1.5 type-micro">
              <span className="flex-shrink-0 rounded bg-primary/10 px-1.5 py-0.5 font-semibold text-primary">歌词命中</span>
              <span className="truncate text-foreground/90">
                <HighlightedLyricMatch text={lyricMatch} query={lyricQuery} />
              </span>
            </p>
          )}
        </div>
      </div>

      {/* 音质列(桌面) */}
      <div className="hidden lg:block">
        {q ? <Badge tone={q.tone} title={q.title}>{q.label}</Badge> : <span className="type-micro text-muted-foreground">—</span>}
      </div>

      {/* 专辑列(桌面) */}
      <div className="hidden lg:block min-w-0 truncate type-caption text-muted-foreground">
        {albumTitle}
      </div>

      {/* 时长列(桌面) */}
      <div className="hidden lg:block text-right type-caption tabular-nums text-muted-foreground nums">
        {fmtSec(rowSong.duration)}
      </div>

      {/* 主按钮:移动端播放 / 桌面端收藏 */}
      <div className="flex items-center justify-end gap-0.5">
        <IconAction
          icon={Heart}
          label={offline ? '离线状态无法收藏' : favorited ? '取消收藏' : '收藏'}
          onClick={handleFavorite}
          disabled={offline || favBusy}
          active={favorited}
          busy={favBusy}
          className="hidden lg:flex"
        />
        <button
          type="button"
          onClick={handleCoverAction}
          aria-label={coverActionLabel}
          title={coverActionLabel}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm transition-[filter] duration-base hover:brightness-110 lg:hidden"
        >
          <CoverActionIcon size={18} fill="currentColor" aria-hidden="true" />
        </button>

        {/* 更多:把"验活 / 缓存到本机 / 看歌词 / 移除"收进菜单,
            让主行只留"播放 + 收藏"两个主动作。 */}
        <button
          ref={menuBtnRef}
          type="button"
          onClick={(e) => { e.stopPropagation(); setOpenMenu((v) => !v); }}
          aria-label="更多操作"
          aria-haspopup="menu"
          aria-expanded={openMenu}
          className={cn(
            'flex h-9 w-9 items-center justify-center rounded-full transition-colors duration-base',
            openMenu ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
          )}
        >
          <Ellipsis size={18} aria-hidden="true" />
        </button>
      </div>

      <MenuPopover anchorRef={menuBtnRef} open={openMenu} onClose={closeMenu} width="w-64">
        <MenuItem icon={Play} label="播放" hint="立即播放这首歌" onClick={runMenuAction(() => onPlay(rowSong))} />
        <MenuItem
          icon={inspectState === 'ok' ? Check : RotateCw}
          label={inspectState === 'ok' ? '重新验音质/可播' : inspectState === 'fail' ? '重试验音质/可播' : '验音质/可播'}
          hint="只检查当前这一首"
          onClick={runMenuAction(handleInspect)}
          disabled={offline || inspectState === 'checking'}
          busy={inspectState === 'checking'}
          danger={inspectState === 'fail'}
        />
        <MenuDivider />
        <MenuItem
          icon={dlState === 'done' ? Check : dlState === 'fail' ? RotateCw : Download}
          label={dlState === 'done' ? '已存到服务器' : dlState === 'fail' ? '重试存到服务器' : '存到服务器'}
          hint="长期保存进 NAS 曲库，任何设备可听"
          onClick={runMenuAction(handleDownload)}
          disabled={offline || dlState === 'saving' || dlState === 'done'}
          busy={dlState === 'saving'}
          danger={dlState === 'fail'}
        />
        {cacheable && (
          <MenuItem
            icon={cacheState === 'done' ? Check : cacheState === 'fail' ? RotateCw : HardDriveDownload}
            label={cacheState === 'done' ? '已缓存到本机' : cacheState === 'fail' ? '重试缓存到本机' : '缓存到本机'}
            hint="存进当前浏览器，可离线听"
            onClick={runMenuAction(handleCache)}
            disabled={offline || cacheState === 'saving' || cacheState === 'done'}
            busy={cacheState === 'saving'}
            danger={cacheState === 'fail'}
          />
        )}
        <MenuItem
          icon={Heart}
          label={favorited ? '取消收藏' : '收藏到「我喜欢」'}
          hint={favorited ? '从我喜欢里移除' : '同时会静默存到服务器'}
          onClick={runMenuAction(handleFavorite)}
          disabled={offline || favBusy}
          busy={favBusy}
        />
        <MenuItem icon={ListPlus} label="加入歌单" hint="组织到自建歌单" onClick={runMenuAction(handleAddToPlaylist)} disabled={offline} />
        {onShowLyric && (
          <MenuItem
            icon={FileText}
            label="查看歌词"
            hint="打开 LRC 文本"
            onClick={runMenuAction(() => onShowLyric(rowSong))}
          />
        )}
        {onRemove && (
          <>
            <MenuDivider />
            <MenuItem
              icon={Trash2}
              label={removeTitle}
              hint={removeHint}
              onClick={runMenuAction(() => onRemove(rowSong))}
              danger
            />
          </>
        )}
      </MenuPopover>
    </div>
  );
};

export { getStreamUrl };
export default SongRow;
