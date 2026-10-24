import React, { useState } from 'react';
import {
  Clock, Download, HardDriveDownload, HelpCircle, Home, LogOut, Menu,
  Music, Plus, Search, Settings, Users, X,
} from 'lucide-react';
import { useCollections } from '../contexts/CollectionsContext';
import { useAuth } from '../contexts/AuthContext';
import { useFeedback } from '../contexts/FeedbackContext';
import { importM3U } from '../services/collections';
import { requestOpenPlaylist } from '../services/playlistBus';
import ImportPlaylistModal from './ImportPlaylistModal';
import { MenuPopover, MenuItem } from '../ui/Menu';
import { cn } from '../ui/cn';

// 导航项:桌面左栏分组展示,移动端取 primary 的几项做底部 Tab
const GROUPS = [
  {
    title: '发现',
    items: [{ key: 'Home', label: '首页', icon: Home, primary: true }],
  },
  {
    title: '找歌',
    items: [{ key: 'Download', label: '搜索下载', icon: Search, primary: true, mobileLabel: '找歌' }],
  },
  {
    title: '曲库',
    items: [
      { key: 'Local', label: '已下载', icon: Download, primary: true, mobileLabel: '曲库' },
      { key: 'Offline', label: '离线音乐', icon: HardDriveDownload, primary: true, mobileLabel: '离线' },
      { key: 'Recent', label: '最近播放', icon: Clock },
    ],
  },
  {
    title: '更多',
    items: [
      { key: 'Settings', label: '设置', icon: Settings },
      { key: 'FAQ', label: '帮助', icon: HelpCircle },
    ],
  },
];

const MOBILE_TABS = GROUPS.flatMap((g) => g.items).filter((i) => i.primary);

// 桌面左侧固定栏
export function Sidebar({ currentSection, currentSubPath, onNavigate }) {
  const { user, isAdmin, logout, desktop } = useAuth();
  return (
    <aside className="hidden h-full w-60 flex-shrink-0 flex-col overflow-y-auto scroll-area border-r border-border bg-black/40 md:flex">
      <a
        href="#home"
        onClick={(e) => { e.preventDefault(); onNavigate('Home'); }}
        className="px-5 py-5 type-hero text-primary transition-opacity duration-base hover:opacity-80"
        aria-label="Melodex 首页"
      >
        Melo<span className="text-foreground">dex</span>
      </a>

      <nav className="flex-grow px-2" aria-label="主导航">
        {GROUPS.map((g) => (
          <div key={g.title} className="mb-4">
            <div className="mb-1 px-3 type-micro font-bold uppercase tracking-wider text-muted-foreground">
              {g.title}
            </div>
            {g.items.map((it) => {
              const Icon = it.icon;
              const active = currentSection === it.key;
              return (
                <a
                  key={it.key}
                  href={`#${it.key.toLowerCase()}`}
                  onClick={(e) => { e.preventDefault(); onNavigate(it.key); }}
                  className={cn(
                    'flex min-h-touch items-center gap-3 rounded-md px-3 type-body font-medium transition-colors duration-base',
                    'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[hsl(var(--ring))]',
                    active
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                  )}
                  aria-current={active ? 'page' : undefined}
                >
                  <Icon size={18} aria-hidden="true" />
                  <span>{it.label}</span>
                </a>
              );
            })}
            {g.title === '更多' && isAdmin && (
              <a
                href="#users"
                onClick={(e) => { e.preventDefault(); onNavigate('Users'); }}
                className={cn(
                  'flex min-h-touch items-center gap-3 rounded-md px-3 type-body font-medium transition-colors duration-base',
                  currentSection === 'Users'
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                )}
                aria-current={currentSection === 'Users' ? 'page' : undefined}
              >
                <Users size={18} aria-hidden="true" />
                <span>用户管理</span>
              </a>
            )}
          </div>
        ))}
        <PlaylistNav currentSection={currentSection} currentSubPath={currentSubPath} onNavigate={onNavigate} />
      </nav>

      {user && (
        <div className="flex items-center gap-2 border-t border-border px-3 py-3">
          <div className="min-w-0 flex-grow">
            <p className="truncate type-body font-semibold">{user.username}</p>
            <p className="type-micro text-muted-foreground">{user.role === 'admin' ? '管理员' : '普通用户'}</p>
          </div>
          {!desktop && (
            <button
              type="button"
              onClick={logout}
              className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors duration-base hover:bg-secondary hover:text-foreground"
              title="退出登录"
              aria-label="退出登录"
            >
              <LogOut size={17} />
            </button>
          )}
        </div>
      )}
    </aside>
  );
}

// 侧栏自建歌单列表
function PlaylistNav({ currentSection, currentSubPath, onNavigate }) {
  const { collections, create, refresh } = useCollections();
  const { offline } = useAuth();
  const feedback = useFeedback();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [platformImportOpen, setPlatformImportOpen] = useState(false);
  const fileRef = React.useRef(null);
  const btnRef = React.useRef(null);
  const activeCollectionId = currentSection === 'MyPlaylist' && currentSubPath != null ? String(currentSubPath) : null;

  const openNew = (c, nm) => {
    if (c && c.id != null) {
      onNavigate('MyPlaylist', c.id);
      requestOpenPlaylist({ collectionId: c.id, name: nm || c.name, kind: c.kind });
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (offline) return;
    const n = name.trim();
    if (!n) return;
    try {
      const c = await create(n);
      setName('');
      setCreating(false);
      openNew(c, n);
    } catch (err) {
      feedback.error(`新建歌单失败:${err?.response?.data?.error || err?.message || '请稍后重试'}`);
    }
  };

  const onFile = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f || offline) return;
    setImporting(true);
    try {
      const content = await f.text();
      const base = f.name.replace(/\.(m3u8?|M3U8?)$/, '');
      const r = await importM3U(base || '导入歌单', content);
      await refresh();
      feedback.success(`导入「${r.name}」:共 ${r.total} 条,匹配 ${r.matched} 首${r.skipped ? `,${r.skipped} 首未匹配` : ''}`);
      openNew({ id: r.id }, r.name);
    } catch (err) {
      feedback.error(`导入失败:${err?.response?.data?.error || err.message || '未知错误'}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="mb-4 border-t border-border pt-4">
      <div className="mb-1 flex items-center justify-between px-3">
        <span className="type-micro font-bold uppercase tracking-wider text-muted-foreground">我的歌单</span>
        <button
          ref={btnRef}
          type="button"
          onClick={() => { if (!offline) setMenuOpen((v) => !v); }}
          disabled={offline}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors duration-base hover:bg-secondary hover:text-foreground disabled:opacity-50"
          title={offline ? '离线状态无法新建或导入歌单' : '新建 / 导入'}
          aria-label="新建或导入歌单"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <Plus size={16} />
        </button>
        <MenuPopover anchorRef={btnRef} open={menuOpen} onClose={() => setMenuOpen(false)} width="w-48">
          <MenuItem icon={Plus} label="新建空歌单" onClick={() => { setMenuOpen(false); setCreating(true); }} />
          <MenuItem
            icon={Download}
            label={importing ? '导入中…' : '导入 m3u/m3u8'}
            onClick={() => { setMenuOpen(false); fileRef.current && fileRef.current.click(); }}
            disabled={importing}
            busy={importing}
          />
          <MenuItem
            icon={Music}
            label="从平台导入歌单"
            hint="网易云 / QQ"
            onClick={() => { setMenuOpen(false); setPlatformImportOpen(true); }}
          />
        </MenuPopover>
        <input ref={fileRef} type="file" accept=".m3u,.m3u8" className="hidden" onChange={onFile} />
      </div>

      <ImportPlaylistModal
        open={platformImportOpen}
        onClose={() => setPlatformImportOpen(false)}
        onNavigate={onNavigate}
      />

      {creating && (
        <form onSubmit={submit} className="mb-2 px-3">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => { if (!name.trim()) setCreating(false); }}
            placeholder="歌单名,回车创建"
            aria-label="新歌单名称"
            className="min-h-9 w-full rounded border border-border bg-secondary px-2 type-caption text-foreground outline-none focus:border-primary"
          />
        </form>
      )}

      {collections.length === 0 && !creating && (
        <p className="px-3 type-micro text-muted-foreground/70">点 + 新建或导入歌单</p>
      )}

      {collections.map((c) => {
        const active = activeCollectionId === String(c.id);
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => {
              onNavigate('MyPlaylist', c.id);
              requestOpenPlaylist({ collectionId: c.id, name: c.name, kind: c.kind });
            }}
            className={cn(
              'flex min-h-9 w-full items-center gap-3 rounded-md px-3 type-caption transition-colors duration-base',
              active
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
            )}
            title={c.name}
            aria-current={active ? 'page' : undefined}
          >
            <Music size={15} className="flex-shrink-0" aria-hidden="true" />
            <span className="truncate">{c.name}</span>
          </button>
        );
      })}
    </div>
  );
}

// 移动端底部 Tab 栏:主项 + 「更多」抽屉。
export function MobileTabBar({ currentSection, currentSubPath, onNavigate }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const { user, isAdmin, logout, desktop } = useAuth();
  const { collections } = useCollections();
  const activeCollectionId = currentSection === 'MyPlaylist' && currentSubPath != null ? String(currentSubPath) : null;

  // Esc 关闭抽屉(此前只能点遮罩退出)
  React.useEffect(() => {
    if (!moreOpen) return undefined;
    const onKeyDown = (event) => { if (event.key === 'Escape') setMoreOpen(false); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [moreOpen]);

  const go = (section, after, subPath) => {
    setMoreOpen(false);
    onNavigate(section, subPath);
    if (after) after();
  };

  const moreNav = [
    { key: 'Recent', label: '最近播放', icon: Clock },
    { key: 'Settings', label: '设置', icon: Settings },
    { key: 'FAQ', label: '帮助', icon: HelpCircle },
  ];

  return (
    <>
      {moreOpen && (
        <>
          <div
            className="fixed inset-0 z-drawer bg-black/50 md:hidden"
            onClick={() => setMoreOpen(false)}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="更多入口"
            className="fixed inset-x-0 bottom-0 z-drawer max-h-[75vh] overflow-y-auto scroll-area rounded-t-2xl border-t border-border bg-popover md:hidden"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}
          >
            <div className="sticky top-0 flex items-center justify-between border-b border-border bg-popover/95 px-4 py-3 backdrop-blur">
              <p className="type-section">更多</p>
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                aria-label="关闭更多"
                className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <X size={18} />
              </button>
            </div>

            {user && (
              <div className="flex items-center gap-3 border-b border-border px-4 py-3">
                <div className="min-w-0 flex-grow">
                  <p className="truncate type-body font-semibold">{user.username}</p>
                  <p className="type-micro text-muted-foreground">{user.role === 'admin' ? '管理员' : '普通用户'}</p>
                </div>
                {!desktop && (
                  <button
                    type="button"
                    onClick={() => { setMoreOpen(false); logout(); }}
                    className="flex min-h-touch items-center gap-1.5 rounded-md px-3 type-caption text-muted-foreground transition-colors duration-base hover:bg-secondary hover:text-foreground"
                  >
                    <LogOut size={16} aria-hidden="true" /> 退出
                  </button>
                )}
              </div>
            )}

            <div className="border-b border-border px-2 py-2">
              {moreNav.map((it) => {
                const Icon = it.icon;
                const active = currentSection === it.key;
                return (
                  <button
                    key={it.key}
                    type="button"
                    onClick={() => go(it.key)}
                    className={cn(
                      'flex min-h-touch w-full items-center gap-3 rounded-md px-3 type-body font-medium transition-colors duration-base',
                      active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/60',
                    )}
                    aria-current={active ? 'page' : undefined}
                  >
                    <Icon size={18} aria-hidden="true" /> {it.label}
                  </button>
                );
              })}
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => go('Users')}
                  className={cn(
                    'flex min-h-touch w-full items-center gap-3 rounded-md px-3 type-body font-medium transition-colors duration-base',
                    currentSection === 'Users' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/60',
                  )}
                  aria-current={currentSection === 'Users' ? 'page' : undefined}
                >
                  <Users size={18} aria-hidden="true" /> 用户管理
                </button>
              )}
            </div>

            <div className="px-2 py-2">
              <p className="px-3 py-1 type-micro font-bold uppercase tracking-wider text-muted-foreground">我的歌单</p>
              {(collections || []).length === 0 ? (
                <p className="px-3 py-2 type-caption text-muted-foreground">还没有歌单</p>
              ) : (
                collections.map((c) => {
                  const active = activeCollectionId === String(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => go('MyPlaylist', () => requestOpenPlaylist({ collectionId: c.id, name: c.name, kind: c.kind }), c.id)}
                      className={cn(
                        'flex min-h-touch w-full items-center gap-3 rounded-md px-3 type-body transition-colors duration-base',
                        active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                      )}
                      aria-current={active ? 'page' : undefined}
                    >
                      <Music size={16} className="flex-shrink-0" aria-hidden="true" />
                      <span className="truncate">{c.name}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </>
      )}

      <nav
        className="fixed inset-x-0 bottom-0 z-tabbar flex items-stretch border-t border-border bg-card md:hidden"
        style={{
          height: 'calc(3.25rem + env(safe-area-inset-bottom))',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
        aria-label="底部导航"
      >
        {MOBILE_TABS.map((it) => {
          const Icon = it.icon;
          const active = currentSection === it.key && !moreOpen;
          return (
            <a
              key={it.key}
              href={`#${it.key.toLowerCase()}`}
              onClick={(e) => { e.preventDefault(); setMoreOpen(false); onNavigate(it.key); }}
              className={cn(
                'flex flex-1 flex-col items-center justify-center gap-0.5 type-micro transition-colors duration-base',
                active ? 'text-primary' : 'text-muted-foreground',
              )}
              aria-current={active ? 'page' : undefined}
            >
              <Icon size={20} aria-hidden="true" />
              <span>{it.mobileLabel || it.label}</span>
            </a>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen((o) => !o)}
          className={cn(
            'flex flex-1 flex-col items-center justify-center gap-0.5 type-micro transition-colors duration-base',
            moreOpen ? 'text-primary' : 'text-muted-foreground',
          )}
          aria-label="更多"
          aria-expanded={moreOpen}
        >
          <Menu size={20} aria-hidden="true" />
          <span>更多</span>
        </button>
      </nav>
    </>
  );
}
