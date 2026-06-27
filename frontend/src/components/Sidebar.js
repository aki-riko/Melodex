import React from 'react';
import { Home, TrendingUp, Compass, Search, Library, Settings, HelpCircle } from 'lucide-react';

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
      </nav>
    </aside>
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
