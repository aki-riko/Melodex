import React, { useState } from 'react';
import { Play, Download, FileText, Gauge, Check, RotateCw } from 'lucide-react';
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
const SongRow = ({ song, index, isPlaying, onPlay, onShowLyric, liveInfo }) => {
  const q = qualityOf(song);
  const [real, setReal] = useState(null); // 手动验音质结果 {size, bitrate}
  const [checking, setChecking] = useState(false);
  const [dlState, setDlState] = useState(''); // '' | 'saving' | 'done' | 'fail'
  // 自动验活已拿到真实大小/码率时直接用(liveInfo),手动验音质(real)优先
  const effectiveReal = real || (liveInfo && liveInfo.state === 'ok' ? { size: liveInfo.size, bitrate: liveInfo.bitrate, bitrateNum: liveInfo.bitrateNum } : null);

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
    className={`group flex items-center gap-3 px-3 py-2 rounded-md transition-colors ${
      isPlaying ? 'bg-secondary' : 'hover:bg-secondary/60'
    }`}
  >
    <span className={`w-6 text-right text-sm tabular-nums ${isPlaying ? 'text-primary' : 'text-muted-foreground'}`}>
      {index + 1}
    </span>
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
    <span className="text-[11px] text-muted-foreground whitespace-nowrap uppercase hidden sm:inline">{song.source}</span>
    {song.duration ? <span className="text-xs text-muted-foreground whitespace-nowrap tabular-nums hidden sm:inline">{fmtSec(song.duration)}</span> : null}
    {(effectiveReal?.size || song.size) ? (
      <span className="text-xs text-muted-foreground whitespace-nowrap hidden md:inline">{effectiveReal?.size || fmtSize(song.size)}</span>
    ) : null}
    {/* 操作按钮:图标化,hover 显现 */}
    <button onClick={handleInspect} disabled={checking}
      className="p-1.5 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
      title="验真实音质与大小">
      <Gauge size={16} className={checking ? 'animate-pulse' : ''} />
    </button>
    {onShowLyric && (
      <button onClick={() => onShowLyric(song)}
        className="p-1.5 text-muted-foreground hover:text-foreground transition-colors"
        title="查看歌词">
        <FileText size={16} />
      </button>
    )}
    <button onClick={handleDownload} disabled={dlState === 'saving' || dlState === 'done'}
      className={`p-1.5 transition-colors ${
        dlState === 'done' ? 'text-primary'
        : dlState === 'fail' ? 'text-destructive'
        : 'text-muted-foreground hover:text-foreground'
      }`}
      title="下载到服务器(NAS)">
      {dlState === 'saving' ? <Download size={16} className="animate-pulse" />
        : dlState === 'done' ? <Check size={16} />
        : dlState === 'fail' ? <RotateCw size={16} />
        : <Download size={16} />}
    </button>
    <button onClick={() => onPlay(song)}
      className="flex items-center justify-center w-9 h-9 rounded-full bg-primary text-primary-foreground hover:scale-105 transition-transform flex-shrink-0"
      title="在线播放" aria-label="播放">
      <Play size={16} fill="currentColor" />
    </button>
  </div>
  );
};

export { getStreamUrl };
export default SongRow;
