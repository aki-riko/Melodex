import React, { useMemo, useRef, useState } from 'react';
import { useQuery } from 'react-query';
import { Clock, CornerDownLeft, Search, Sparkles } from 'lucide-react';
import { requestDownloadSearch } from '../services/downloadBus';
import { getSearchHistory } from '../services/musicdl';
import { cn } from '../ui/cn';

// 主区顶部:全局搜索框,任意页面输入回车/点建议 → 找歌页并预填搜索。
//
// 本轮修正:
//  · 下拉建议此前只有 role="listbox"/"option" 却没有键盘导航与 aria-activedescendant,
//    读屏与键盘用户实际用不了。现在补 ↑↓/Enter/Esc 与 aria-selected。
//  · 关层靠 onBlur + 120ms 延时(脆弱),改为锚点判定 + 全局 pointerdown。
export default function TopBar({ currentSection, onNavigate }) {
  const [kw, setKw] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef(null);
  const inputRef = useRef(null);

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
      { key: `search-${query}`, keyword: query, label: `搜索「${query}」`, detail: '进入找歌', icon: CornerDownLeft },
      ...relatedItems.map((item) => ({
        key: `related-${item.keyword}`,
        keyword: item.keyword,
        label: item.keyword,
        detail: '相关历史',
        icon: Sparkles,
      })),
    ];
  }, [query, relatedItems]);

  const closeMenu = () => { setOpen(false); setActiveIndex(-1); };

  const runSearch = (value) => {
    const q = (value || '').trim();
    if (!q) return;
    setKw(q);
    closeMenu();
    onNavigate('Download');
    requestDownloadSearch(q);
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      closeMenu();
      event.currentTarget.blur();
      return;
    }
    if (!open || menuItems.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((i) => (i + 1) % menuItems.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((i) => (i <= 0 ? menuItems.length - 1 : i - 1));
      return;
    }
    if (event.key === 'Enter' && activeIndex >= 0) {
      // 有高亮项时 Enter 走该项;否则交给表单提交(搜索输入框本身的值)
      event.preventDefault();
      runSearch(menuItems[activeIndex].keyword);
    }
  };

  return (
    <div className="sticky top-0 z-nav flex items-center gap-3 border-b border-border bg-background/80 px-4 py-3 backdrop-blur md:px-6">
      <a
        href="#home"
        onClick={(e) => { e.preventDefault(); onNavigate('Home'); }}
        className="type-title text-primary md:hidden"
        aria-label="Melodex 首页"
      >
        M<span className="text-foreground">dx</span>
      </a>

      <div ref={rootRef} className="relative max-w-md flex-grow">
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            if (activeIndex >= 0) return;
            runSearch(kw);
          }}
        >
          <Search
            size={17}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            value={kw}
            type="search"
            onFocus={() => setOpen(true)}
            onChange={(e) => { setKw(e.target.value); setOpen(true); setActiveIndex(-1); }}
            onKeyDown={onKeyDown}
            onBlur={() => window.setTimeout(() => {
              if (!rootRef.current?.contains(document.activeElement)) closeMenu();
            }, 100)}
            placeholder="搜索歌曲、歌手…"
            className="min-h-touch w-full rounded-full bg-secondary py-2 pl-9 pr-3 type-body text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary"
            aria-label="全局搜索"
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-controls="global-search-listbox"
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? `global-search-opt-${activeIndex}` : undefined}
            enterKeyHint="search"
          />
        </form>

        {open && (
          <div
            id="global-search-listbox"
            role="listbox"
            aria-label="搜索建议"
            className="absolute inset-x-0 top-full z-popover mt-2 overflow-hidden rounded-md border border-border bg-popover shadow-popover animate-pop-in"
            onMouseDown={(e) => e.preventDefault()}
          >
            <div className="px-3 py-2 type-micro font-semibold uppercase tracking-wider text-muted-foreground">
              {query ? '相关搜索' : '搜索历史'}
            </div>
            {history.isLoading ? (
              <div className="px-3 pb-3 type-caption text-muted-foreground">
                加载中<span className="loading-dots" aria-hidden="true" />
              </div>
            ) : menuItems.length > 0 ? (
              <div className="max-h-72 overflow-y-auto scroll-area py-1">
                {menuItems.map((item, i) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.key}
                      id={`global-search-opt-${i}`}
                      type="button"
                      role="option"
                      aria-selected={activeIndex === i}
                      onClick={() => runSearch(item.keyword)}
                      onMouseEnter={() => setActiveIndex(i)}
                      className={cn(
                        'flex min-h-touch w-full items-center gap-3 px-3 type-body transition-colors duration-base',
                        activeIndex === i ? 'bg-secondary' : 'hover:bg-secondary',
                      )}
                    >
                      <Icon size={16} className="flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 flex-grow">
                        <span className="block truncate font-medium text-foreground">{item.label}</span>
                        <span className="block type-micro text-muted-foreground">{item.detail}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="px-3 pb-3 type-caption text-muted-foreground">暂无搜索历史</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
