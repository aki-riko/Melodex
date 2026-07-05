import React, { useMemo, useRef, useState } from 'react';
import { useQuery } from 'react-query';
import { Clock, CornerDownLeft, Search, Sparkles } from 'lucide-react';
import { requestDownloadSearch } from '../services/downloadBus';
import { getSearchHistory } from '../services/musicdl';

// 主区顶部:全局搜索框,任意页面输入回车/点建议 -> 下载页并预填搜索。
export default function TopBar({ currentSection, onNavigate }) {
  const [kw, setKw] = useState('');
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef(null);

  const history = useQuery(['search-history'], getSearchHistory, {
    enabled: open,
    refetchOnWindowFocus: false,
    staleTime: 60 * 1000,
  });

  const query = kw.trim();
  const historyItems = history.data || [];
  const relatedItems = useMemo(() => {
    const normalized = query.toLowerCase();
    if (!normalized) return historyItems.slice(0, 6);
    return historyItems
      .filter((item) => {
        const keyword = (item.keyword || '').trim();
        return keyword && keyword.toLowerCase().includes(normalized) && keyword.toLowerCase() !== normalized;
      })
      .slice(0, 5);
  }, [historyItems, query]);

  const menuItems = useMemo(() => {
    if (!query) {
      return relatedItems.map((item) => ({
        key: `history-${item.keyword}`,
        keyword: item.keyword,
        label: item.keyword,
        detail: '最近搜索',
        icon: Clock,
      }));
    }
    return [
      {
        key: `search-${query}`,
        keyword: query,
        label: `搜索「${query}」`,
        detail: '进入搜索下载',
        icon: CornerDownLeft,
      },
      ...relatedItems.map((item) => ({
        key: `related-${item.keyword}`,
        keyword: item.keyword,
        label: item.keyword,
        detail: '相关历史',
        icon: Sparkles,
      })),
    ];
  }, [query, relatedItems]);

  const hasMenu = open;

  const openMenu = () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    setOpen(true);
  };

  const closeMenuSoon = () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => setOpen(false), 120);
  };

  const runSearch = (value) => {
    const q = (value || '').trim();
    if (!q) return;
    setKw(q);
    setOpen(false);
    onNavigate('Download');
    requestDownloadSearch(q);
  };

  const submit = (e) => {
    e.preventDefault();
    runSearch(kw);
  };

  return (
    <div className="sticky top-0 z-20 flex items-center gap-3 px-4 md:px-6 py-3 bg-background/80 backdrop-blur border-b border-border">
      <a
        href="#home"
        onClick={(e) => { e.preventDefault(); onNavigate('Home'); }}
        className="md:hidden text-xl font-black text-primary"
      >
        M<span className="text-foreground">dx</span>
      </a>
      <form onSubmit={submit} className="flex-grow max-w-md relative">
        <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <input
          value={kw}
          onFocus={openMenu}
          onBlur={closeMenuSoon}
          onChange={(e) => {
            setKw(e.target.value);
            openMenu();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setOpen(false);
              e.currentTarget.blur();
            }
          }}
          placeholder="搜索歌曲、歌手..."
          className="w-full bg-secondary text-foreground rounded-full pl-10 pr-4 py-2 text-sm outline-none focus:ring-2 focus:ring-primary placeholder:text-muted-foreground"
          aria-label="全局搜索"
          aria-expanded={hasMenu}
          aria-haspopup="listbox"
        />
        {hasMenu && (
          <div
            className="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-md border border-border bg-card shadow-2xl"
            onMouseDown={(e) => e.preventDefault()}
          >
            <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {query ? '相关搜索' : '搜索历史'}
            </div>
            {history.isLoading ? (
              <div className="px-3 pb-3 text-sm text-muted-foreground">
                加载中<span className="loading-dots" aria-hidden="true" />
              </div>
            ) : menuItems.length > 0 ? (
              <div className="max-h-72 overflow-y-auto py-1 app-scroll" role="listbox">
                {menuItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => runSearch(item.keyword)}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-secondary"
                      role="option"
                    >
                      <Icon size={17} className="flex-shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-grow">
                        <span className="block truncate text-sm font-medium text-foreground">{item.label}</span>
                        <span className="block text-xs text-muted-foreground">{item.detail}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="px-3 pb-3 text-sm text-muted-foreground">
                暂无搜索历史
              </div>
            )}
          </div>
        )}
      </form>
    </div>
  );
}
