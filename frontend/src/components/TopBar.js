import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from 'react-query';
import { Clock, Globe2, Search } from 'lucide-react';
import { requestDownloadSearch } from '../services/downloadBus';
import { getSearchHistory } from '../services/musicdl';
import { cn } from '../ui/cn';
import { useBackLayer } from '../contexts/backNavigation.js';
import { usePageSearchFilter } from '../contexts/pageSearchFilter.js';
import {
  SearchSuggestionList,
  pickSuggestionName,
  resolveSuggestionKey,
  suggestionMenuCount,
  toSuggestTerms,
  useSearchSuggestions,
} from './SearchSuggestions.js';

// 主区顶部:搜索框。
//
// 两条路径(2026-11 按用户反馈明确化):
//   ① **当前页面有列表** → 先筛这个列表(就地过滤,不发请求、不跳页)。
//      用户原话:「其他页面的搜索不应该是这样的,应该对应当前歌单的搜索才对」。
//      回车 = 只筛本页;输入即筛(边打边缩)。非要全网搜时,下拉底部有显式入口。
//   ② 页面没有列表(首页/设置/找歌页本身) → 跳「找歌」做全网搜索(原行为)。
//
// 其它历史修正:
//  · 下拉建议此前只有 role="listbox"/"option" 却没有键盘导航与 aria-activedescendant,
//    读屏与键盘用户实际用不了。现在补 ↑↓/Enter/Esc 与 aria-selected。
//  · 关层靠 onBlur + 120ms 延时(脆弱),改为锚点判定 + 全局 pointerdown。
export default function TopBar({ currentSection: _currentSection, onNavigate }) {
  const [kw, setKw] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const pageFilter = usePageSearchFilter();
  const pageFilterActive = Boolean(pageFilter?.active);

  // 页面过滤器的实时数据（count/placeholder 每次页面渲染都可能变）。
  const live = pageFilterActive ? pageFilter.readLive?.() : null;
  const filterPlaceholder = live?.placeholder || '搜索当前列表…';

  const history = useQuery(['search-history'], getSearchHistory, {
    enabled: open,
    refetchOnWindowFocus: false,
    staleTime: 60 * 1000,
  });

  const query = kw.trim();
  // 必须 memo:`history.data || []` 在 data 为空时每次渲染都新建一个空数组,
  // 下面两个 useMemo 的依赖引用就永远在变 —— memo 等于没写。
  const historyItems = useMemo(() => history.data || [], [history.data]);

  // 平台权威补全：只在"要走全网搜索"时才请求。
  // 页面内过滤是纯本地匹配，此时还去问上游纯属浪费（而且补全出来的全网歌名
  // 在这张歌单里多半搜不到，反而误导）。
  const suggestionState = useSearchSuggestions(query, {
    enabled: open && Boolean(query) && !pageFilterActive,
  });
  const suggestionTerms = useMemo(
    () => toSuggestTerms({ terms: suggestionState.terms }),
    [suggestionState.terms],
  );

  // 空输入:最近搜索。有输入:补全列表由 SearchSuggestionList 自己拼（首项是"搜索「xx」"）。
  const historyMenuItems = useMemo(() => historyItems.slice(0, 6).map((item) => ({
    key: `history-${item.keyword}`,
    name: item.keyword,
    detail: '最近搜索',
    icon: Clock,
  })), [historyItems]);

  // 边打边筛：只有"当前页过滤"模式才这么干（它是纯本地计算，不会打后端）。
  // 全网搜索模式下输入不发请求，必须回车/点建议才搜 —— 否则每敲一个字就搜全网。
  useEffect(() => {
    if (!pageFilterActive) return;
    pageFilter.onSearch?.(query);
  }, [pageFilterActive, pageFilter, query]);

  // 下拉总项数:
  //   页面过滤模式 = 补全条数(空则 1 条"全网搜")+ 1 条"全网搜"入口
  //   全网模式     = 1(搜索当前词)+ 补全条数 —— 与找歌页共用 suggestionMenuCount
  const menuItemCount = pageFilterActive
    ? Math.max(1, suggestionTerms.length ? suggestionTerms.length + 1 : 1)
    : (query ? suggestionMenuCount(query, suggestionTerms) : historyMenuItems.length);

  const closeMenu = () => { setOpen(false); setActiveIndex(-1); };

  // 安卓返回键 / 浏览器后退:先收搜索建议下拉,而不是直接退站。
  // 注意 open 也会因 onFocus 打开(还没输入内容),这同样算一层可见层。
  useBackLayer({
    active: open,
    name: 'topbar-suggest',
    onBack: () => {
      closeMenu();
      // 收起下拉后再按返回应能继续往下走,所以这里不聚焦也不阻止默认。
    },
  });

  // 全网搜索：跳找歌页并预填词。
  const runGlobalSearch = (value) => {
    const q = (value || '').trim();
    if (!q) return;
    setKw(q);
    closeMenu();
    onNavigate('Download');
    requestDownloadSearch(q);
  };

  // 提交搜索 = 有页面过滤就地筛，否则走全网。
  const runSearch = (value) => {
    const q = (value || '').trim();
    if (!q) return;
    if (pageFilterActive) {
      setKw(q);
      pageFilter.onSearch?.(q);
      closeMenu();
      return;
    }
    runGlobalSearch(q);
  };

  const onKeyDown = (event) => {
    const decision = resolveSuggestionKey(event, {
      itemCount: open ? menuItemCount : 0,
      activeIndex,
    });
    if (decision.handled) event.preventDefault();
    if (decision.action === 'close') {
      closeMenu();
      event.currentTarget.blur();
      return;
    }
    if (decision.action === 'focus') {
      setActiveIndex(decision.nextIndex);
      return;
    }
    if (decision.action === 'pick') {
      if (pageFilterActive) {
        // 页面过滤模式的下拉只有两类项：补全词条 与 末尾的「全网搜」。
        // 补全词条直接拿来筛本页；全网搜那条（index === suggestionTerms.length）才跳页。
        const term = suggestionTerms[activeIndex];
        if (term) runSearch(term.name);
      } else if (query) {
        // 0 号是「搜索当前词」，其余是补全项 —— 与找歌页共用同一套取词规则。
        runSearch(pickSuggestionName({ query, terms: suggestionTerms, activeIndex }));
      } else {
        const picked = historyMenuItems[activeIndex]?.name;
        if (picked) runSearch(picked);
      }
    }
  };

  return (
    // ★ 2026-11-26 顶部/左右安全区：此前**完全没处理**，只有全屏播放页用了
    //   env(safe-area-inset-top)。真机风险来自 Capacitor 8 的 SystemBars：
    //   当「WebView ≥ 140 且页面有 viewport-fit=cover」时，它把原生 padding 清零
    //   （`v.setPadding(0, 0, 0, ...)`）并把 insets 注入成 CSS 变量
    //   （见 SystemBars.injectSafeAreaCSS），也就是**页面内容会顶到状态栏下面**。
    //   本项目 index.html 正好是 viewport-fit=cover，安卓 WebView 现在普遍 ≥ 140，
    //   所以这是默认路径 —— 顶栏会被状态栏/挖孔压住。
    //   （WebView < 140 走另一分支，系统给原生 padding、顶栏本就被推开；
    //    此时 --safe-top 为 0，下面的 padding 不产生任何效果。）
    //
    // ★ 为什么用 CSS 类而不是内联 style：内联的 paddingLeft 会在所有断点生效，
    //   把 Tailwind 的 `md:px-6`(24px) 覆盖成 16px —— 桌面端会窄 8px。
    //   类里用同样的断点写死两档，才与改造前完全一致。
    <div className="safe-top-bar sticky top-0 z-nav flex items-center gap-3 border-b border-border surface-bar px-4 py-3 md:px-6">
      <a
        href="#home"
        onClick={(e) => { e.preventDefault(); onNavigate('Home'); }}
        className="type-title text-primary lg:hidden"
        aria-label="Melodex 首页"
      >
        M<span className="text-foreground">dx</span>
      </a>

      <div ref={rootRef} className="relative max-w-md flex-grow">
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            // 表单提交总是搜输入框里的词。高亮项只影响按 ↑↓ 后的 Enter,
            // 这里不要再"if (activeIndex >= 0) return" —— 那会让鼠标点搜索按钮
            // 在下拉开着且有高亮时完全没反应。
            runSearch(kw);
          }}
        >
          <Search
            size={18}
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
            placeholder={pageFilterActive ? filterPlaceholder : '搜索歌曲、歌手…'}
            className="min-h-touch w-full rounded-control bg-secondary py-2 pl-9 pr-3 type-body text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary"
            aria-label={pageFilterActive ? '搜索当前列表' : '全局搜索'}
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-controls="global-search-listbox"
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? `global-search-opt-${activeIndex}` : undefined}
            enterKeyHint="search"
          />
        </form>

        {open && pageFilterActive && query && (
          <div
            id="global-search-listbox"
            role="listbox"
            aria-label="当前列表搜索结果"
            className="absolute inset-x-0 top-full z-popover mt-2 overflow-hidden rounded-md border border-border surface-acrylic fluent-flyout-in"
            onMouseDown={(e) => e.preventDefault()}
          >
            <div className="flex items-center justify-between gap-2 px-3 py-2 type-micro text-muted-foreground">
              <span className="font-semibold uppercase tracking-wider">当前列表</span>
              <span className="nums">{live?.count ?? 0} / {live?.total ?? 0} 首</span>
            </div>
            <button
              type="button"
              role="option"
              aria-selected={activeIndex === (suggestionTerms.length || 0)}
              onClick={() => runGlobalSearch(query)}
              onMouseEnter={() => setActiveIndex(suggestionTerms.length || 0)}
              className={cn(
                'flex min-h-touch w-full items-center gap-3 px-3 text-left type-body transition-colors duration-base border-t border-border',
                activeIndex === (suggestionTerms.length || 0) ? 'bg-secondary' : 'hover:bg-secondary',
              )}
            >
              <Globe2 size={16} className="flex-shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-grow">
                <span className="block truncate font-medium text-foreground">全网搜「{query}」</span>
                <span className="block type-micro text-muted-foreground">离开当前列表，去「找歌」搜索全部来源</span>
              </span>
            </button>
          </div>
        )}

        {open && !pageFilterActive && (
          query ? (
            <SearchSuggestionList
              query={query}
              terms={suggestionTerms}
              loading={suggestionState.loading}
              open={open}
              activeIndex={activeIndex}
              onActiveIndexChange={setActiveIndex}
              onPick={runSearch}
              listId="global-search-listbox"
              ariaLabel="搜索建议"
            />
          ) : (
            <div
              id="global-search-listbox"
              role="listbox"
              aria-label="搜索历史"
              className="absolute inset-x-0 top-full z-popover mt-2 overflow-hidden rounded-md border border-border surface-acrylic fluent-flyout-in"
              onMouseDown={(e) => e.preventDefault()}
            >
              <div className="px-3 py-2 type-micro font-semibold uppercase tracking-wider text-muted-foreground">
                搜索历史
              </div>
              {history.isLoading ? (
                <div className="px-3 pb-3 type-caption text-muted-foreground">
                  加载中<span className="loading-dots" aria-hidden="true" />
                </div>
              ) : historyMenuItems.length > 0 ? (
                <div className="max-h-72 overflow-y-auto scroll-area py-1">
                  {historyMenuItems.map((item, i) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.key}
                        id={`global-search-opt-${i}`}
                        type="button"
                        role="option"
                        aria-selected={activeIndex === i}
                        onClick={() => runSearch(item.name)}
                        onMouseEnter={() => setActiveIndex(i)}
                        className={cn(
                          // text-left 必须显式写:<button> 的 UA 默认是 text-align:center,
                          // 里面 block 的"歌名/最近搜索"两行会继承居中,
                          // 于是表现为"图标贴最左、文字挤在中间"。
                          'flex min-h-touch w-full items-center gap-3 px-3 text-left type-body transition-colors duration-base',
                          activeIndex === i ? 'bg-secondary' : 'hover:bg-secondary',
                        )}
                      >
                        <Icon size={16} className="flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                        <span className="min-w-0 flex-grow">
                          <span className="block truncate font-medium text-foreground">{item.name}</span>
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
          )
        )}
      </div>
    </div>
  );
}
