import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Captions, Pause, Play, SkipBack, SkipForward, X } from 'lucide-react';
import { useFeedback } from '../contexts/FeedbackContext';
import {
  desktopLyricsErrorMessage,
  desktopLyricFrame,
  desktopLyricWordProgress,
  requestDesktopLyricsWindow,
  supportsDesktopLyrics,
} from '../contexts/playerDesktopLyrics';

const WINDOW_STYLE = `
  :root { color-scheme: dark; font-family: Roboto, "Microsoft YaHei", sans-serif; }
  * { box-sizing: border-box; }
  html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #181818; }
  button { font: inherit; }
  .lyrics-shell {
    position: relative; width: 100%; height: 100%; display: flex; flex-direction: column; padding: 14px 18px 12px;
    color: #fff; background: radial-gradient(circle at 18% 0%, #214a32 0, #181818 52%);
  }
  .lyrics-header { display: flex; align-items: center; gap: 10px; min-height: 34px; }
  .lyrics-cover { width: 34px; height: 34px; flex: 0 0 auto; border-radius: 5px; object-fit: cover; background: #282828; }
  .lyrics-track { min-width: 0; flex: 1; }
  .lyrics-title, .lyrics-artist { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lyrics-title { font-size: 13px; font-weight: 700; }
  .lyrics-artist { margin-top: 2px; color: #a7a7a7; font-size: 11px; }
  .lyrics-close { border: 0; border-radius: 50%; width: 30px; height: 30px; display: grid; place-items: center; color: #a7a7a7; background: transparent; cursor: pointer; }
  .lyrics-close:hover { color: #fff; background: rgba(255,255,255,.1); }
  .lyrics-lines { min-height: 0; flex: 1; display: grid; align-content: center; gap: 5px; text-align: center; }
  .lyrics-line { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lyrics-line--side { color: rgba(255,255,255,.38); font-size: clamp(12px, 3.2vw, 16px); }
  .lyrics-line--current { font-size: clamp(22px, 5.2vw, 34px); font-weight: 800; letter-spacing: .02em; text-shadow: 0 2px 16px rgba(0,0,0,.45); }
  .lyrics-empty { color: #a7a7a7; font-size: clamp(16px, 4vw, 24px); }
  .lyrics-controls { position: absolute; left: 50%; bottom: 9px; transform: translateX(-50%); display: flex; gap: 8px; opacity: 0; transition: opacity .16s ease; }
  .lyrics-shell:hover .lyrics-controls, .lyrics-controls:focus-within { opacity: 1; }
  .lyrics-control { width: 34px; height: 34px; display: grid; place-items: center; border: 1px solid rgba(255,255,255,.12); border-radius: 50%; color: #fff; background: rgba(24,24,24,.78); cursor: pointer; backdrop-filter: blur(8px); }
  .lyrics-control:hover { border-color: rgba(30,215,96,.55); color: #1ed760; }
  .lyrics-control--primary { color: #181818; background: #1ed760; border-color: #1ed760; }
  .lyrics-control--primary:hover { color: #181818; filter: brightness(1.08); }
`;

const KaraokeText = ({ line, currentTime }) => {
  if (!line?.words) return <span style={{ color: '#1ed760' }}>{line?.text || ''}</span>;
  return line.words.map((word, index) => {
    const progress = desktopLyricWordProgress(word, currentTime) * 100;
    return (
      <span key={index} style={{
        color: 'transparent',
        backgroundImage: `linear-gradient(90deg, #1ed760 ${progress}%, #a7a7a7 ${progress}%)`,
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
      }}>
        {word.s}
      </span>
    );
  });
};

const DesktopLyricsPanel = ({ song, coverUrl, lines, activeIndex, currentTime, isPaused, onTogglePlay, onPrev, onNext, onClose }) => {
  const frame = desktopLyricFrame(lines, activeIndex);
  return (
    <div className="lyrics-shell">
      <div className="lyrics-header">
        {coverUrl && <img className="lyrics-cover" src={coverUrl} alt="" />}
        <div className="lyrics-track">
          <p className="lyrics-title">{song?.name || 'Melodex'}</p>
          <p className="lyrics-artist">{song?.artist || '桌面歌词'}</p>
        </div>
        <button type="button" className="lyrics-close" onClick={onClose} title="关闭桌面歌词" aria-label="关闭桌面歌词"><X size={17} /></button>
      </div>
      <div className="lyrics-lines" aria-label="桌面歌词">
        {lines.length === 0 ? <p className="lyrics-line lyrics-empty">暂无歌词</p> : (
          <>
            <p className="lyrics-line lyrics-line--side">{frame.previous?.text || '\u00a0'}</p>
            <p className="lyrics-line lyrics-line--current" aria-live="polite">
              {frame.current ? <KaraokeText line={frame.current} currentTime={currentTime} /> : '\u00a0'}
            </p>
            <p className="lyrics-line lyrics-line--side">{frame.next?.text || '\u00a0'}</p>
          </>
        )}
      </div>
      <div className="lyrics-controls">
        <button type="button" className="lyrics-control" onClick={onPrev} title="上一首" aria-label="上一首"><SkipBack size={17} fill="currentColor" /></button>
        <button type="button" className="lyrics-control lyrics-control--primary" onClick={onTogglePlay} title="播放/暂停" aria-label="播放/暂停">
          {isPaused ? <Play size={18} fill="currentColor" /> : <Pause size={18} fill="currentColor" />}
        </button>
        <button type="button" className="lyrics-control" onClick={onNext} title="下一首" aria-label="下一首"><SkipForward size={17} fill="currentColor" /></button>
      </div>
    </div>
  );
};

const useDesktopLyricsWindow = (onError) => {
  const [pipWindow, setPipWindow] = useState(null);
  const openingRef = useRef(false);
  const windowRef = useRef(null);

  const close = useCallback(() => {
    const opened = windowRef.current;
    windowRef.current = null;
    if (opened && !opened.closed) opened.close();
    setPipWindow(null);
  }, []);

  const toggle = useCallback(async () => {
    if (windowRef.current && !windowRef.current.closed) {
      close();
      return;
    }
    if (openingRef.current) return;
    if (!supportsDesktopLyrics()) {
      onError('当前浏览器不支持桌面歌词，请使用支持文档画中画的 Chromium 桌面浏览器（如 Thorium、Chrome、Edge）。');
      return;
    }
    openingRef.current = true;
    try {
      const opened = await requestDesktopLyricsWindow();
      opened.document.title = 'Melodex 桌面歌词';
      windowRef.current = opened;
      setPipWindow(opened);
    } catch (error) {
      onError(desktopLyricsErrorMessage(error));
    } finally {
      openingRef.current = false;
    }
  }, [close, onError]);

  useEffect(() => {
    if (!pipWindow) return undefined;
    const onPageHide = () => {
      if (windowRef.current === pipWindow) windowRef.current = null;
      setPipWindow(null);
    };
    pipWindow.addEventListener('pagehide', onPageHide, { once: true });
    return () => pipWindow.removeEventListener('pagehide', onPageHide);
  }, [pipWindow]);

  useEffect(() => () => {
    const opened = windowRef.current;
    windowRef.current = null;
    if (opened && !opened.closed) opened.close();
  }, []);

  return { pipWindow, close, toggle };
};

const DesktopLyricsWindow = (props) => {
  const feedback = useFeedback();
  const { pipWindow, close, toggle } = useDesktopLyricsWindow(feedback.error);
  const isOpen = Boolean(pipWindow && !pipWindow.closed);

  return (
    <>
      <button type="button" onClick={toggle} aria-label="桌面歌词" aria-pressed={isOpen}
        className={`transition-colors ${isOpen ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
        title={isOpen ? '关闭桌面歌词' : '打开桌面歌词（Chromium）'}>
        <Captions size={19} />
      </button>
      {isOpen && createPortal((
        <>
          <style>{WINDOW_STYLE}</style>
          <DesktopLyricsPanel {...props} onClose={close} />
        </>
      ), pipWindow.document.body)}
    </>
  );
};

export default DesktopLyricsWindow;
