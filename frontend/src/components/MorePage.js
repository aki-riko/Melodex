import React from 'react';
import {
  Clock, HelpCircle, LogOut, Menu, Music, Settings, Users,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useCollections } from '../contexts/CollectionsContext';
import { requestOpenPlaylist } from '../services/playlistBus';
import { cn } from '../ui/cn';

// 「更多」独立页。
//
// 以前它是底部 Tab 上弹出的一个半屏抽屉(fixed bottom sheet)。问题是那一页里
// 塞了两组完全不同的东西:导航入口(最近播放/设置/帮助/用户管理)和**我的歌单全列表**——
// 歌单一多就得在抽屉里再滚一层,滚动手势还会和抽屉本身的拖拽打架;
// 而且抽屉是有高度上限的,歌单多到一定程度用户只会觉得"点不完"。
//
// 现在改成一级页面(路由 #more),好处:
//   · 内容有整页高度,歌单列表不再嵌套滚动;
//   · 有真实 URL,可以直达/刷新/前进后退,和桌面侧栏语义一致;
//   · 返回键天然可用(路由页不需要额外的返回栈层,用浏览器后退即可)。
//
// 桌面端不显示这个入口 —— 那里左侧栏已经把同样的内容全部平铺出来了,
// 再做一个「更多」页属于重复导航。所以本页只在 lg 以下出现。
export default function MorePage({ onNavigate }) {
  const { user, isAdmin, logout, desktop } = useAuth();
  const { collections } = useCollections();

  const navItems = [
    { key: 'Recent', label: '最近播放', icon: Clock },
    { key: 'Settings', label: '设置', icon: Settings },
    { key: 'FAQ', label: '帮助', icon: HelpCircle },
    ...(isAdmin ? [{ key: 'Users', label: '用户管理', icon: Users }] : []),
  ];

  const openCollection = (collection) => {
    onNavigate('MyPlaylist', collection.id);
    requestOpenPlaylist({
      collectionId: collection.id,
      name: collection.name,
      kind: collection.kind,
    });
  };

  return (
    <div className="lg:hidden">
      <header className="mb-5">
        <p className="type-micro uppercase tracking-wider text-muted-foreground">全部功能</p>
        <h1 className="mt-0.5 type-hero flex items-center gap-2 text-foreground">
          <Menu size={28} aria-hidden="true" />
          更多
        </h1>
      </header>

      {user && (
        <section className="mb-5 flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
          <div className="min-w-0 flex-grow">
            <p className="truncate type-body font-semibold text-foreground">{user.username}</p>
            <p className="type-micro text-muted-foreground">
              {user.role === 'admin' ? '管理员' : '普通用户'}
            </p>
          </div>
          {!desktop && (
            <button
              type="button"
              onClick={logout}
              className="flex min-h-touch items-center gap-1.5 rounded-control px-3 type-caption text-muted-foreground transition-colors duration-base hover:bg-secondary hover:text-foreground"
            >
              <LogOut size={16} aria-hidden="true" /> 退出
            </button>
          )}
        </section>
      )}

      <section className="mb-6" aria-labelledby="more-nav-title">
        <h2 id="more-nav-title" className="mb-2 px-1 type-micro font-bold uppercase tracking-wider text-muted-foreground">
          功能入口
        </h2>
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {navItems.map((item, index) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => onNavigate(item.key)}
                className={cn(
                  'flex min-h-touch w-full items-center gap-3 px-4 py-3 text-left type-body font-medium',
                  'transition-colors duration-base hover:bg-secondary',
                  index > 0 && 'border-t border-border',
                )}
              >
                <Icon size={19} className="flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-grow text-foreground">{item.label}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="more-playlists-title">
        <div className="mb-2 flex items-center justify-between px-1">
          <h2 id="more-playlists-title" className="type-micro font-bold uppercase tracking-wider text-muted-foreground">
            我的歌单
          </h2>
          <span className="type-micro text-muted-foreground nums">
            {(collections || []).length} 个
          </span>
        </div>

        {(collections || []).length === 0 ? (
          <p className="rounded-lg border border-border bg-card px-4 py-6 text-center type-caption text-muted-foreground">
            还没有歌单,可以在桌面端或「加入歌单」里新建
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            {collections.map((collection, index) => (
              <button
                key={collection.id}
                type="button"
                onClick={() => openCollection(collection)}
                className={cn(
                  'flex min-h-touch w-full items-center gap-3 px-4 py-3 text-left type-body',
                  'transition-colors duration-base hover:bg-secondary',
                  index > 0 && 'border-t border-border',
                )}
              >
                <Music size={17} className="flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-grow truncate text-foreground">{collection.name}</span>
                {collection.kind === 'favorite' && (
                  <span className="flex-shrink-0 rounded-full bg-primary/15 px-2 py-0.5 type-micro text-primary">
                    默认
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
