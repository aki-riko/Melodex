// 搜索补全下拉 —— 全局搜索栏(TopBar)与找歌页(Download)共用一份实现。
//
// ## 两处的两种形态(2026-11-28 补齐找歌页)
//   ① **全局搜索型**(TopBar 的全网模式 / 找歌页的搜索框):
//      0 号是「搜索「xx」」,后面是平台补全词条。用 suggestionMenuCount /
//      pickSuggestionName 换算下标,两处共用同一套规则。
//   ② **页内过滤型**(TopBar 在有列表的页面):只筛本页,不发补全请求,
//      末位给一条显式的「全网搜」出口 —— 那一套逻辑留在 TopBar 里。
// 找歌页先前**只接了形态①的一半**:补全组件写好了、文件头也写着"两处共用",
// 但它的搜索框从头到尾没调用过 useSearchSuggestions,于是只有顶栏有联想。
//
// ## 为什么抽成组件
// 两处都要"边打字边联想 + ↑↓ 选择 + Enter 搜索 + Esc/点外收起"。分开写就会重演
// 本项目已经发生过多次的分叉:一处修了键盘导航、另一处还是旧的。
//
// ## 三条硬约束(全部来自补全接口的特性)
// 1. **去抖 + 丢弃陈旧响应**:补全是边打字边发的接口。这里的做法是
//    「输入变化 → 等 180ms → 发请求 → 只认最后一次请求的结果」。
//    不用 AbortController 也安全(后端有 2.5s 硬超时),但用了能少占连接,所以两个都用。
// 2. **不阻塞输入**:请求失败/超时一律静默,下拉保持"暂无建议",绝不弹错误提示 ——
//    用户正在打字,任何弹窗/红条都是干扰。
// 3. **单字也补全**:中文里一个字就能有意义的候选(输入「晴」→「晴天」)。
//    服务端不再要求 >= 2 字符(实测平台支持)。
//
// ## 为什么 term.kind 只影响图标
// 补全的语义是"该搜什么词",点歌/歌手/专辑发出去的都是同一个 name。类型只用来挑图标,
// 让用户一眼看出这条是歌还是人。

import { useEffect, useMemo, useRef, useState } from 'react';
import { Album, Clock, CornerDownLeft, Mic2, Music, Search } from 'lucide-react';
import { getSearchSuggestions } from '../services/musicdl';
import { cn } from '../ui/cn';

/** 输入变化到发请求的等待。180ms 是"看起来即时"与"少打几次上游"的折中。 */
export const SUGGEST_DEBOUNCE_MS = 180;

const KIND_META = {
  song: { icon: Music, label: '歌曲' },
  singer: { icon: Mic2, label: '歌手' },
  album: { icon: Album, label: '专辑' },
  history: { icon: Clock, label: '最近搜索' },
};

const kindMeta = (kind) => KIND_META[kind] || { icon: Search, label: '' };

/**
 * 搜索补全的取数逻辑(与 UI 分离,便于单独推理)。
 *
 * @returns {{ terms: Array, loading: boolean }}
 *   terms 每项形如 { key, kind, name, detail, label }
 */
export function useSearchSuggestions(query, { limit = 10, enabled = true } = {}) {
  const trimmed = (query || '').trim();
  const [state, setState] = useState({ terms: [], loading: false });
  const requestSeq = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setState({ terms: [], loading: false });
      return undefined;
    }
    // 空输入不给"补全",由调用方决定是否显示搜索历史 —— 那是另一回事。
    if (!trimmed) {
      setState({ terms: [], loading: false });
      return undefined;
    }

    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    let cancelled = false;
    const controller = new AbortController();

    // 立刻进入 loading(只影响一行"载入中"文字,不阻塞输入)。
    setState((current) => ({ terms: current.terms, loading: true }));

    const timer = window.setTimeout(() => {
      getSearchSuggestions(trimmed, { limit, signal: controller.signal })
        .then((data) => {
          // 只认最后一次请求:用户可能已经又敲了两个字符。
          if (cancelled || requestSeq.current !== seq) return;
          setState({ terms: toSuggestTerms(data), loading: false });
        })
        .catch(() => {
          if (cancelled || requestSeq.current !== seq) return;
          // 失败静默:不显示错误,只是没有补全。
          setState({ terms: [], loading: false });
        });
    }, SUGGEST_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, limit, enabled]);

  return state;
}

/**
 * 把接口响应整理成下拉项。
 *
 * 顺序:结构化词条(上游给的类型/副标题) → 缓存歌曲(带封面信息) → 纯关键词。
 * 同一名字只保留第一条,避免"晴天"重复出现两三次。
 */
export function toSuggestTerms(data) {
  const out = [];
  const seen = new Set();
  const push = (term) => {
    const name = String(term?.name || '').trim();
    if (!name) return;
    const key = normalizeSuggestName(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ ...term, name, key });
  };

  for (const term of data?.terms || []) {
    push({
      kind: term?.kind || 'song',
      name: term?.name,
      detail: String(term?.detail || '').trim(),
    });
  }
  for (const song of data?.songs || []) {
    push({
      kind: 'song',
      name: song?.name,
      detail: String(song?.artist || '').trim(),
    });
  }
  for (const keyword of data?.keywords || []) {
    push({ kind: 'history', name: keyword, detail: '' });
  }
  return out;
}

const normalizeSuggestName = (value) => String(value || '')
  .toLowerCase()
  .replace(/[\s()[\]（）【】·•.,，、\-—_/\\]/g, '');

/**
 * 补全下拉。受控:父组件持有输入值,这里只负责展示与键盘交互。
 *
 * @param {object} props
 * @param {string} props.query           当前输入(用于决定"搜索「xx」"那一行)
 * @param {Array}  props.terms           useSearchSuggestions 返回的 terms
 * @param {boolean} props.loading
 * @param {boolean} props.open
 * @param {number} props.activeIndex
 * @param {(index:number)=>void} props.onActiveIndexChange
 * @param {(name:string)=>void} props.onPick
 * @param {(children:React.ReactNode)=>React.ReactNode} [props.renderWrapper]
 *        允许调用方套一层定位容器(两处的定位方式不同)。
 */
export function SearchSuggestionList({
  query, terms, loading, open, activeIndex, onActiveIndexChange, onPick, listId, ariaLabel = '搜索建议',
}) {
  const trimmed = (query || '').trim();
  const items = useMemo(() => {
    const rows = [];
    // 第一项永远是"就搜这个" —— 用户输完直接回车时,高亮项不该悄悄改变搜索词。
    if (trimmed) {
      rows.push({
        key: `query-${trimmed}`,
        kind: 'query',
        name: trimmed,
        detail: '',
        label: `搜索「${trimmed}」`,
        icon: CornerDownLeft,
      });
    }
    for (const term of terms) {
      const meta = kindMeta(term.kind);
      rows.push({
        ...term,
        label: term.name,
        icon: meta.icon,
        // 副标题:优先上游给的(如歌手名),其次类型名。
        sublabel: term.detail || meta.label,
      });
    }
    return rows;
  }, [terms, trimmed]);

  if (!open) return null;

  return (
    <div
      id={listId}
      role="listbox"
      aria-label={ariaLabel}
      className="absolute inset-x-0 top-full z-popover mt-2 max-h-80 overflow-y-auto rounded-md border border-border surface-acrylic fluent-flyout-in scroll-area"
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.length === 0 ? (
        <div className="px-3 py-3 type-caption text-muted-foreground">
          {loading ? <>正在联想<span className="loading-dots" aria-hidden="true" /></> : '暂无建议'}
        </div>
      ) : (
        <div className="py-1">
          {items.map((item, i) => {
            const Icon = item.icon || Search;
            return (
              <button
                key={item.key}
                id={`${listId}-opt-${i}`}
                type="button"
                role="option"
                aria-selected={activeIndex === i}
                onClick={() => onPick(item.name)}
                onMouseEnter={() => onActiveIndexChange(i)}
                className={cn(
                  // text-left 必须显式写:<button> 的 UA 默认 text-align:center。
                  'flex min-h-touch w-full items-center gap-3 px-3 text-left type-body transition-colors duration-base',
                  activeIndex === i ? 'bg-secondary' : 'hover:bg-secondary',
                )}
              >
                <Icon size={16} className="flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-grow">
                  <span className="block truncate font-medium text-foreground">{item.label}</span>
                  {item.sublabel ? (
                    <span className="block type-micro text-muted-foreground">{item.sublabel}</span>
                  ) : null}
                </span>
              </button>
            );
          })}
          {loading && (
            <div className="px-3 py-1.5 type-micro text-muted-foreground">
              正在联想<span className="loading-dots" aria-hidden="true" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 「全网搜索型」下拉的项数:0 号是「搜索当前词」,后面才是补全项。
 *
 * 空输入没有补全(由调用方决定是否改显示搜索历史),所以返回 0。
 * 抽成纯函数是因为 TopBar 与找歌页都要算出同一个数 —— 键盘 ↑↓ 的回环、
 * aria-activedescendant 的下标、Enter 取哪一条全靠它,分开写必然分叉。
 */
export function suggestionMenuCount(query, terms) {
  if (!String(query || '').trim()) return 0;
  return 1 + (Array.isArray(terms) ? terms.length : 0);
}

/**
 * 「全网搜索型」下拉的取词:0 号取当前输入,其余取补全项。
 *
 * 高亮项越界或补全项没有名字时一律回退到当前输入 —— 也就是
 * 「按回车就搜自己打的词」,不能让高亮项悄悄改掉搜索词。
 */
export function pickSuggestionName({ query, terms, activeIndex } = {}) {
  const trimmed = String(query || '').trim();
  const list = Array.isArray(terms) ? terms : [];
  const index = Number(activeIndex);
  if (Number.isFinite(index) && index >= 1) {
    const name = String(list[index - 1]?.name || '').trim();
    if (name) return name;
  }
  return trimmed;
}

/**
 * 补全项的键盘导航(纯函数,便于测试):上/下/回车/Esc。
 *
 * 返回 `{ handled, nextIndex, pick }` —— 调用方据此决定 preventDefault 与后续动作。
 * 之所以拆出来:两处输入框都要同一套规则(↑↓ 循环、Enter 走高亮项),分开写必然分叉。
 */
export function resolveSuggestionKey(event, { itemCount, activeIndex, composing = false } = {}) {
  const key = event?.key;
  if (key === 'Escape') return { handled: true, action: 'close' };
  // 中文输入法上屏时的回车不能当成"选中建议"。
  if (key === 'Enter' && (composing || event?.nativeEvent?.isComposing)) {
    return { handled: false, action: 'none' };
  }
  if (key === 'ArrowDown' && itemCount > 0) {
    return { handled: true, action: 'focus', nextIndex: (activeIndex + 1) % itemCount };
  }
  if (key === 'ArrowUp' && itemCount > 0) {
    return { handled: true, action: 'focus', nextIndex: activeIndex <= 0 ? itemCount - 1 : activeIndex - 1 };
  }
  if (key === 'Enter' && activeIndex >= 0 && activeIndex < itemCount) {
    return { handled: true, action: 'pick', nextIndex: activeIndex };
  }
  return { handled: false, action: 'none' };
}
