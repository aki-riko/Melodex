import React from 'react';
import { getStreamUrl, getDownloadUrl } from '../services/musicdl';
import { formatDuration } from '../utils/format';

const fmtSec = (sec) => (sec ? formatDuration(sec * 1000) : '');
const fmtSize = (bytes) => {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)}MB` : `${(bytes / 1024).toFixed(0)}KB`;
};

// 单首歌曲行:歌曲搜索结果与歌单/专辑详情共用。
const SongRow = ({ song, index, isPlaying, onPlay, onShowLyric }) => (
  <div
    className={`flex items-center gap-3 p-3 rounded-lg bg-zinc-900 border transition ${
      isPlaying ? 'border-primary' : 'border-zinc-800 hover:border-primary'
    }`}
  >
    <span className="text-gray-500 w-6 text-right">{index + 1}</span>
    <div className="flex-grow min-w-0">
      <p className="font-semibold truncate text-white">
        {song.name}
        {song.is_vip && <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-yellow-600 text-white">VIP</span>}
      </p>
      <p className="text-sm text-gray-400 truncate">
        {song.artist}
        {song.album ? ` · ${song.album}` : ''}
      </p>
    </div>
    <span className="text-xs text-gray-500 whitespace-nowrap">{song.source}</span>
    {song.duration ? <span className="text-xs text-gray-500 whitespace-nowrap">{fmtSec(song.duration)}</span> : null}
    {song.size ? <span className="text-xs text-gray-500 whitespace-nowrap">{fmtSize(song.size)}</span> : null}
    {onShowLyric && (
      <button
        onClick={() => onShowLyric(song)}
        className="px-3 py-1.5 rounded bg-zinc-700 text-white text-sm hover:bg-zinc-600 transition"
        title="查看歌词"
      >
        词
      </button>
    )}
    <button
      onClick={() => onPlay(song)}
      className="px-3 py-1.5 rounded bg-zinc-700 text-white text-sm hover:bg-zinc-600 transition"
      title="在线播放"
    >
      ▶ 播放
    </button>
    <a
      href={getDownloadUrl(song)}
      className="px-3 py-1.5 rounded bg-primary text-white text-sm hover:bg-red-600 transition no-underline"
      title="下载到本地"
    >
      ↓ 下载
    </a>
  </div>
);

export { getStreamUrl };
export default SongRow;
