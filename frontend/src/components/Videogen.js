import React, { useState, useRef } from 'react';
import { useQuery } from 'react-query';
import { searchMusic, getLyric, apiBase } from '../services/musicdl';
import { runOfflineRender } from '../lib/videogenEngine';

// 把 LRC 纯文本解析成引擎需要的 lyricRaw:[{time(ms), text}]
const parseLrc = (lrc) => {
  if (!lrc) return [];
  const re = /\[(\d+):(\d+)(?:\.(\d{1,3}))?\]/g;
  const out = [];
  lrc.split('\n').forEach((line) => {
    const text = line.replace(re, '').trim();
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line)) !== null) {
      const min = Number(m[1]);
      const sec = Number(m[2]);
      const ms = m[3] ? Number(m[3].padEnd(3, '0')) : 0;
      const time = min * 60000 + sec * 1000 + ms;
      if (text) out.push({ time, text });
    }
  });
  return out.sort((a, b) => a.time - b.time);
};

const Videogen = () => {
  const [keyword, setKeyword] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [phase, setPhase] = useState('idle'); // idle | rendering | done | error
  const [progress, setProgress] = useState({ title: '', desc: '', pct: 0 });
  const [result, setResult] = useState(null); // {url, filename}
  const [errMsg, setErrMsg] = useState('');
  const previewRef = useRef(null);

  const search = useQuery(
    ['videogen-search', query],
    () => searchMusic(query, { type: 'song' }),
    { enabled: !!query, keepPreviousData: true }
  );

  const handleSearch = (e) => {
    e.preventDefault();
    const k = keyword.trim();
    if (k) setQuery(k);
  };

  const startRender = async () => {
    if (!selected) return;
    setPhase('rendering');
    setResult(null);
    setErrMsg('');
    setProgress({ title: '准备中…', desc: '', pct: 0 });

    let lyricRaw = [];
    try {
      const lrc = await getLyric(selected);
      lyricRaw = parseLrc(lrc);
    } catch (_) { /* 无歌词也能生成,纯封面视频 */ }

    const data = {
      apiRoot: `${apiBase}/music`,
      id: selected.id,
      source: selected.source,
      name: selected.name || 'Unknown',
      artist: selected.artist || 'Unknown',
      rawCover: selected.cover || '',
      isVideoBg: false,
      lyricMode: 'line',
      lyricRaw,
      lyricGroups: [],
    };

    try {
      await runOfflineRender(data, {
        onProgress: (title, desc, pct) => setProgress({ title, desc, pct: pct || 0 }),
        getPreviewCanvas: () => previewRef.current,
        onComplete: (url, filename) => { setResult({ url, filename }); setPhase('done'); },
        onError: (msg) => { setErrMsg(msg); setPhase('error'); },
      });
    } catch (_) { /* onError 已处理 */ }
  };

  const songs = search.data?.songs || [];
  return (
    <div className="max-w-5xl mx-auto pb-32">
      <h2 className="text-3xl font-semibold mb-2 text-foreground">视频生成 <span className="text-primary">· Videogen</span></h2>
      <p className="text-muted-foreground mb-6 mt-3">把一首歌做成带封面与歌词的 MP4 视频(浏览器逐帧渲染,后端 ffmpeg 合成)。</p>

      {/* 选歌 */}
      <form onSubmit={handleSearch} className="flex gap-2 mb-4">
        <input
          type="text"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索要生成视频的歌曲…"
          className="flex-grow px-4 py-3 border border-border bg-card font-medium shadow-brutal-sm focus:shadow-brutal focus:-translate-x-0.5 focus:-translate-y-0.5 outline-none transition-all"
        />
        <button type="submit" className="px-6 py-3 border border-border bg-primary text-primary-foreground font-bold shadow-brutal-sm transition-all">搜索</button>
      </form>

      {search.isLoading && <p className="text-muted-foreground font-bold">搜索中…</p>}
      <div className="space-y-2 mb-6">
        {songs.slice(0, 12).map((song, idx) => (
          <div
            key={`${song.source}-${song.id}-${idx}`}
            onClick={() => setSelected(song)}
            className={`flex items-center gap-3 p-3 border border-border cursor-pointer transition-all ${
              selected && selected.id === song.id && selected.source === song.source
                ? 'bg-primary text-primary-foreground shadow-brutal'
                : 'bg-card shadow-brutal-sm'
            }`}
          >
            <div className="flex-grow min-w-0">
              <p className="font-bold truncate">{song.name}</p>
              <p className="text-sm truncate opacity-80">{song.artist} · {song.source}</p>
            </div>
            {selected && selected.id === song.id && selected.source === song.source && <span className="font-bold">✓ 已选</span>}
          </div>
        ))}
      </div>

      {/* 生成控制 */}
      {selected && (
        <div className="border border-border bg-card shadow-brutal p-5 mb-6">
          <p className="font-bold mb-3">已选:{selected.name} — {selected.artist}</p>
          <button
            onClick={startRender}
            disabled={phase === 'rendering'}
            className="px-6 py-3 border border-border bg-primary text-primary-foreground font-bold shadow-brutal-sm transition-all disabled:opacity-50 disabled:pointer-events-none"
          >
            {phase === 'rendering' ? '渲染中…' : '🎬 生成视频'}
          </button>

          {phase === 'rendering' && (
            <div className="mt-4">
              <p className="font-bold">{progress.title}</p>
              <p className="text-sm text-muted-foreground mb-2">{progress.desc}</p>
              <div className="w-full h-5 border border-border bg-muted">
                <div className="h-full bg-primary transition-all" style={{ width: `${progress.pct}%` }} />
              </div>
            </div>
          )}

          {phase === 'error' && <p className="mt-4 text-destructive font-bold">渲染失败:{errMsg}</p>}

          {phase === 'done' && result && (
            <div className="mt-4">
              <p className="font-bold text-success mb-2">✓ 生成成功!</p>
              <a href={result.url} download={result.filename} className="inline-block px-6 py-3 border border-border bg-success text-success-foreground font-bold shadow-brutal-sm transition-all no-underline">↓ 下载视频</a>
            </div>
          )}

          {/* 渲染预览 */}
          <div className={`mt-4 border border-border bg-black ${phase === 'idle' ? 'hidden' : ''}`} style={{ aspectRatio: '16/9' }}>
            <canvas ref={previewRef} className="w-full h-full object-contain" />
          </div>
        </div>
      )}
    </div>
  );
};

export default Videogen;
