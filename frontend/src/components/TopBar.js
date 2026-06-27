import React, { useState } from 'react';
import { Search } from 'lucide-react';
import { requestDownloadSearch } from '../services/downloadBus';

// 主区顶部:全局搜索框(任意页输入回车→跳下载页并预填搜索)+ 当前页标题
export default function TopBar({ currentSection, onNavigate }) {
  const [kw, setKw] = useState('');

  const submit = (e) => {
    e.preventDefault();
    const q = kw.trim();
    if (!q) return;
    onNavigate('Download');     // 先切到下载页
    requestDownloadSearch(q);   // 再派发预填搜索事件(Download 页监听)
  };

  return (
    <div className="sticky top-0 z-20 flex items-center gap-3 px-4 md:px-6 py-3 bg-background/80 backdrop-blur border-b border-border">
      {/* 移动端显示 logo(桌面 logo 在侧栏) */}
      <a
        href="#home"
        onClick={(e) => { e.preventDefault(); onNavigate('Home'); }}
        className="md:hidden text-xl font-black text-primary"
      >
        TS<span className="text-foreground">+</span>
      </a>
      <form onSubmit={submit} className="flex-grow max-w-md relative">
        <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <input
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          placeholder="搜索歌曲、歌手…"
          className="w-full bg-secondary text-foreground rounded-full pl-10 pr-4 py-2 text-sm outline-none focus:ring-2 focus:ring-primary placeholder:text-muted-foreground"
          aria-label="全局搜索"
        />
      </form>
    </div>
  );
}
