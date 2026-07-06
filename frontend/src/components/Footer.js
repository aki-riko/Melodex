import React, { useState } from 'react';
import { Minus, Plus } from 'lucide-react';

// 页脚:作为 FAQ 同款折叠项展示项目与开源说明。
const Footer = () => {
  const [open, setOpen] = useState(false);
  const Icon = open ? Minus : Plus;

  return (
    <div className="border border-border">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="w-full cursor-pointer flex justify-between items-center gap-4 p-4 bg-muted text-left"
        aria-expanded={open}
      >
        <h2 className="min-w-0 text-lg md:text-xl font-semibold text-foreground">项目与开源说明</h2>
        <Icon size={18} className="flex-shrink-0 text-foreground" />
      </button>
      {open && (
        <div className="p-4 bg-card border-t-2 border-border text-sm text-muted-foreground">
          <p className="text-foreground/90">
            © 2024-2026 Melodex ·{' '}
            <a
              href="https://github.com/aki-riko/Melodex"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-primary"
            >
              GitHub
            </a>
            {' '}· 仅供学习与技术交流
          </p>
          <p className="mt-1">自托管 PWA 音乐搜索、服务器曲库与离线缓存工具。</p>
          <p className="mt-3 text-xs opacity-70">
            基于开源项目{' '}
            <a href="https://github.com/guohuiyuan/go-music-dl" target="_blank" rel="noopener noreferrer" className="underline hover:text-primary">go-music-dl</a>
            {' '}(AGPL-3.0)与{' '}
            <a href="https://github.com/peter-bf/tunescout" target="_blank" rel="noopener noreferrer" className="underline hover:text-primary">TuneScout</a>
            {' '}构建;界面设计改编自 Adam Lowenthal 的 Spotify Artist Page UI(
            <a
              href="https://codepen.io/alowenthal/pen/rxboRv"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-primary"
            >
              CodePen
            </a>
            ,MIT 许可)。本项目整体采用 AGPL-3.0。
          </p>
        </div>
      )}
    </div>
  );
};

export default Footer;
