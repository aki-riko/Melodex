import React, { useState } from 'react';
import { getStreamUrl, saveToServer, inspectQuality } from '../services/musicdl';
import { formatDuration } from '../utils/format';

const fmtSec = (sec) => (sec ? formatDuration(sec * 1000) : '');
const fmtSize = (bytes) => {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)}MB` : `${(bytes / 1024).toFixed(0)}KB`;
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

// 单首歌曲行:歌曲搜索结果与歌单/专辑详情共用。
const SongRow = ({ song, index, isPlaying, onPlay, onShowLyric }) => {
  const q = qualityOf(song);
  const [real, setReal] = useState(null); // 验音质结果 {size, bitrate}
  const [checking, setChecking] = useState(false);
  const [dlState, setDlState] = useState(''); // '' | 'saving' | 'done' | 'fail'

  const handleInspect = async (e) => {
    e.stopPropagation();
    setChecking(true);
    try {
      const r = await inspectQuality(song);
      if (r.valid) setReal({ size: r.size, bitrate: r.bitrate });
      else setReal({ size: '—', bitrate: '不可用' });
    } catch {
      setReal({ size: '—', bitrate: '失败' });
    } finally {
      setChecking(false);
    }
  };

  const handleDownload = async (e) => {
    e.stopPropagation();
    setDlState('saving');
    try {
      const r = await saveToServer(song);
      setDlState(r && r.saved ? 'done' : 'fail');
    } catch {
      setDlState('fail');
    }
  };

  return (
  <div
    className={`flex items-center gap-3 p-3 border bg-card text-card-foreground transition-shadow rounded-md ${
      isPlaying ? 'border-primary shadow-brutal' : 'border-border shadow-brutal-sm'
    }`}
  >
    <span className="text-muted-foreground font-medium w-6 text-right">{index + 1}</span>
    <div className="flex-grow min-w-0">
      <p className="font-semibold truncate">
        {song.name}
        {song.is_vip && <span className="ml-2 text-xs font-medium px-1.5 py-0.5 rounded bg-primary text-primary-foreground">VIP</span>}
      </p>
      <p className="text-sm text-muted-foreground truncate">
        {song.artist}
        {song.album ? ` · ${song.album}` : ''}
      </p>
    </div>
    {/* 验音质后显示真实码率,否则显示预览音质标签 */}
    {real ? (
      <span className="text-xs font-semibold px-1.5 py-0.5 rounded whitespace-nowrap bg-primary text-primary-foreground" title="真实下载音质">
        {real.bitrate}
      </span>
    ) : (
      q && <span className={`text-xs font-semibold px-1.5 py-0.5 rounded whitespace-nowrap ${q.cls}`}>{q.label}</span>
    )}
    <span className="text-xs font-medium text-muted-foreground whitespace-nowrap uppercase">{song.source}</span>
    {song.duration ? <span className="text-xs text-muted-foreground whitespace-nowrap">{fmtSec(song.duration)}</span> : null}
    {/* 大小:验音质后用真实值,否则预览值 */}
    {(real?.size || song.size) ? (
      <span className="text-xs text-muted-foreground whitespace-nowrap">{real?.size || fmtSize(song.size)}</span>
    ) : null}
    <button
      onClick={handleInspect}
      disabled={checking}
      className="px-2 py-1.5 border border-border bg-card font-medium text-sm rounded-md shadow-brutal-sm transition-colors hover:bg-secondary disabled:opacity-50"
      title="验真实音质与大小"
    >
      {checking ? '…' : '验'}
    </button>
    {onShowLyric && (
      <button
        onClick={() => onShowLyric(song)}
        className="px-3 py-1.5 border border-border bg-card font-medium text-sm rounded-md shadow-brutal-sm transition-colors hover:bg-secondary"
        title="查看歌词"
      >
        词
      </button>
    )}
    <button
      onClick={() => onPlay(song)}
      className="px-3 py-1.5 border border-border bg-card font-medium text-sm rounded-md shadow-brutal-sm transition-colors hover:bg-secondary"
      title="在线播放"
    >
      ▶ 播放
    </button>
    <button
      onClick={handleDownload}
      disabled={dlState === 'saving' || dlState === 'done'}
      className={`px-3 py-1.5 border font-medium text-sm rounded-md shadow-brutal-sm transition-opacity no-underline ${
        dlState === 'done'
          ? 'border-success bg-success text-success-foreground'
          : dlState === 'fail'
          ? 'border-destructive bg-destructive text-destructive-foreground'
          : 'border-primary bg-primary text-primary-foreground hover:opacity-90'
      } disabled:opacity-80`}
      title="下载到服务器(NAS)"
    >
      {dlState === 'saving' ? '下载中…' : dlState === 'done' ? '✓ 已下载' : dlState === 'fail' ? '✗ 重试' : '↓ 下载'}
    </button>
  </div>
  );
};

export { getStreamUrl };
export default SongRow;
