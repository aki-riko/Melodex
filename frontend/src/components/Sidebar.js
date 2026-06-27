import React, { useState } from 'react';
import { Home, TrendingUp, Compass, Search, Library, Settings, HelpCircle, Music, Plus } from 'lucide-react';
import { useCollections } from '../contexts/CollectionsContext';
import { requestOpenPlaylist } from '../services/playlistBus';

// 导航项:桌面左栏分组展示,移动端取 primary 的几项做底部 Tab
const GROUPS = [
  {
    title: '发现',
    items: [
      { key: 'Home', label: '首页', icon: Home, primary: true },
      { key: 'Trending', label: '热门', icon: TrendingUp },
      { key: 'Discover', label: '发现', icon: Compass },
    ],
  },
  {
    title: '音乐',
    items: [
      { key: 'Download', label: '搜索下载', icon: Search, primary: true, mobileLabel: '搜索' },
      { key: 'Artists', label: '艺人', icon: Library },
      { key: 'Settings', label: '设置', icon: Settings, primary: true },
      { key: 'FAQ', label: '帮助', icon: HelpCircle },
    ],
  },
];

// 移动端底部 Tab 取 primary 标记项 + 首页/搜索/设置
const MOBILE_TABS = GROUPS.flatMap((g) => g.items).filter((i) => i.primary);

// 桌面左侧固定栏
export function Sidebar({ currentSection, onNavigate }) {
  return (
    <aside className="hidden md:flex flex-col w-60 flex-shrink-0 bg-black/40 border-r border-border h-full overflow-y-auto app-scroll">
      <a
        href="#home"
        onClick={(e) => { e.preventDefault(); onNavigate('Home'); }}
        className="text-2xl font-black tracking-tight text-primary px-5 py-5 hover:opacity-80"
      >
        TuneScout<span className="text-foreground">+</span>
      </a>
      <nav className="flex-grow px-2">
        {GROUPS.map((g) => (
          <div key={g.title} className="mb-5">
            <div className="px-3 mb-1 text-xs font-bold uppercase tracking-wider text-muted-foreground">{g.title}</div>
            {g.items.map((it) => {
              const Icon = it.icon;
              const active = currentSection === it.key;
              return (
                <a
                  key={it.key}
                  href={`#${it.key.toLowerCase()}`}
                  onClick={(e) => { e.preventDefault(); onNavigate(it.key); }}
                  className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                    active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
                  }`}
                  aria-current={active ? 'page' : undefined}
                >
                  <Icon size={18} />
                  <span>{it.label}</span>
                </a>
              );
            })}
          </div>
        ))}
        {/* 歌单组:列推荐歌单,点击跳热门页并打开该歌单(1:1 复刻 Spotify 左栏 Playlists) */}
        <PlaylistNav onNavigate={onNavigate} />
      </nav>
    </aside>
  );
}

// 侧栏自建歌单列表:列我的歌单 + 新建,点击 → 切到歌单页打开该歌单
function PlaylistNav({ onNavigate }) {
  const { collections, create } = useCollections();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    const c = await create(n);
    setName(''); setCreating(false);
    if (c && c.id != null) { onNavigate('MyPlaylist'); requestOpenPlaylist({ collectionId: c.id, name: n }); }
  };

  return (
    <div className="mb-5 border-t border-border pt-4">
      <div className="flex items-center justify-between px-3 mb-1">
        <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">我的歌单</span>
        <button onClick={() => setCreating((v) => !v)} className="text-muted-foreground hover:text-foreground" title="新建歌单">
          <Plus size={16} />
        </button>
      </div>
      {creating && (
        <form onSubmit={submit} className="px-3 mb-2">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
            onBlur={() => { if (!name.trim()) setCreating(false); }}
            placeholder="歌单名,回车创建"
            className="w-full bg-secondary rounded px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-primary" />
        </form>
      )}
      {collections.length === 0 && !creating && (
        <p className="px-3 text-xs text-muted-foreground/70">点 + 新建你的第一个歌单</p>
      )}
      {collections.map((c) => (
        <button
          key={c.id}
          onClick={() => { onNavigate('MyPlaylist'); requestOpenPlaylist({ collectionId: c.id, name: c.name }); }}
          className="w-full flex items-center gap-3 px-3 py-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground transition-colors text-left"
          title={c.name}
        >
          <Music size={16} className="flex-shrink-0" />
          <span className="truncate">{c.name}</span>
        </button>
      ))}
    </div>
  );
}

// 移动端底部 Tab 栏
export function MobileTabBar({ currentSection, onNavigate }) {
  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-30 flex bg-card border-t border-border"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      {MOBILE_TABS.map((it) => {
        const Icon = it.icon;
        const active = currentSection === it.key;
        return (
          <a
            key={it.key}
            href={`#${it.key.toLowerCase()}`}
            onClick={(e) => { e.preventDefault(); onNavigate(it.key); }}
            className={`flex-1 flex flex-col items-center gap-0.5 py-2 text-[11px] transition-colors ${
              active ? 'text-primary' : 'text-muted-foreground'
            }`}
            aria-current={active ? 'page' : undefined}
          >
            <Icon size={20} />
            <span>{it.mobileLabel || it.label}</span>
          </a>
        );
      })}
    </nav>
  );
}
