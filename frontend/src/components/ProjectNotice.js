import React, { useState } from 'react';
import { Minus, Plus } from 'lucide-react';

const PROJECT_URL = 'https://github.com/aki-riko/Melodex';
const BACKEND_URL = 'https://github.com/guohuiyuan/go-music-dl';
const DESIGN_URL = 'https://codepen.io/alowenthal/pen/rxboRv';

export default function ProjectNotice() {
  const [expanded, setExpanded] = useState(false);
  const Icon = expanded ? Minus : Plus;

  return (
    <div className="border border-border">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="w-full cursor-pointer flex justify-between items-center gap-4 p-4 bg-muted text-left"
        aria-expanded={expanded}
      >
        <h2 className="min-w-0 text-lg md:text-xl font-semibold text-foreground">项目与开源说明</h2>
        <Icon size={18} className="flex-shrink-0 text-foreground" />
      </button>
      {expanded && (
        <div className="p-4 bg-card border-t-2 border-border text-sm text-muted-foreground">
          <p className="text-foreground/90">
            © 2024-2026 Melodex ·{' '}
            <a
              href={PROJECT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-primary"
            >
              GitHub
            </a>
            {' '}· 仅供学习与技术交流
          </p>
          <p className="mt-1">自托管 PWA 音乐搜索、服务器下载与离线缓存工具。</p>
          <p className="mt-3 text-xs opacity-70">
            后端基于{' '}
            <a href={BACKEND_URL} target="_blank" rel="noopener noreferrer" className="underline hover:text-primary">
              go-music-dl
            </a>
            {' '}(AGPL-3.0);Web 前端功能由 Melodex 实现,界面视觉改编自 Adam Lowenthal 的{' '}
            <a href={DESIGN_URL} target="_blank" rel="noopener noreferrer" className="underline hover:text-primary">
              Spotify Artist Page UI
            </a>
            {' '}(MIT)。本项目整体采用 AGPL-3.0。
          </p>
        </div>
      )}
    </div>
  );
}
