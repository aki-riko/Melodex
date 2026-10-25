import React, { useEffect, useMemo, useState } from 'react';
import { useQuery } from 'react-query';
import { Compass, Music, Play, RefreshCw } from 'lucide-react';
import { getRecommend, getPlaylistCategories, getCategoryPlaylists, coverProxyUrl } from '../services/musicdl';
import { onOpenPlaylist } from '../services/playlistBus';
import { useCachedRefresh } from '../hooks/useCachedRefresh';
import LoadingState from './LoadingState';
import PlaylistSongs from './PlaylistSongs';
import Button from '../ui/Button';
import EmptyState from '../ui/EmptyState';
import StatusLine from '../ui/StatusLine';
import ScrollRow from '../ui/ScrollRow';
import Segmented from '../ui/Segmented';
import { SectionHeader } from '../ui/Card';
import { cn } from '../ui/cn';
import { sourceLabel } from '../utils/sourceLabels';

// 推荐源:后端 recommendProviderNames 实际支持 5 个
// (netease / qq / kugou / kuwo / migu)。
// 此前这里只写了 ['netease','qq'] —— 明明后端还能给 90 张,前端却只要了 60 张,
// 这是"推荐太少"最直接的原因之一。实测各源推荐条数(生产环境):
//   netease 30 / qq 30 / kugou 30 / kuwo 30 / migu 20
const RECOMMENDATION_SOURCES = ['netease', 'qq', 'kugou', 'kuwo', 'migu'];

// 分类浏览可用的源。category 能力来自同一套 provider 客户端,
// 但 qq / kuwo 的分类 ID 需要平台真实 ID(用分类名调用会 400/返回 0 张),
// 因此这里只自动选「按名称能稳定取到」的源;其余源在 UI 上不出现,避免点了空白。
// 实测:netease 12 个分类 × 30 张, migu 19 个分类 × 20 张,稳定可用。
const CATEGORY_SOURCES = ['netease', 'migu'];

// 「全部」这类无意义的分类(点进去等于回到推荐,占了位置没增加内容)
const IGNORED_CATEGORY_NAMES = new Set(['全部', '全部歌单', '推荐']);

function PlaylistCard({ playlist, onOpen, showSource = false }) {
  const [failed, setFailed] = useState(false);
  const cover = failed ? '' : coverProxyUrl(playlist);
  return (
    <button
      type="button"
      onClick={() => onOpen(playlist)}
      className="group w-[9rem] rounded-lg border border-transparent p-2 text-left transition-colors duration-base ease-standard hover:border-border hover:bg-secondary/60 focus-visible:border-border focus-visible:bg-secondary/60 sm:w-40"
      title={`打开歌单「${playlist.name}」`}
    >
      <div className="relative aspect-square overflow-hidden rounded-md bg-secondary">
        {cover ? (
          <img
            src={cover}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-slow ease-standard group-hover:scale-[1.03]"
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <Music size={28} aria-hidden="true" />
          </div>
        )}
        <span
          className="absolute bottom-2 right-2 flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground opacity-0 shadow-lg transition-opacity duration-base group-hover:opacity-100 group-focus-within:opacity-100"
          aria-hidden="true"
        >
          <Play size={18} fill="currentColor" />
        </span>
        {showSource && (
          <span className="absolute left-2 top-2 rounded bg-black/65 px-1.5 py-0.5 type-micro font-semibold text-white">
            {sourceLabel(playlist.source)}
          </span>
        )}
      </div>
      <p className="mt-2 line-clamp-2 type-caption font-semibold leading-snug">{playlist.name}</p>
      {playlist.track_count > 0 && (
        <p className="mt-0.5 type-micro text-muted-foreground nums">{playlist.track_count} 首</p>
      )}
    </button>
  );
}

// 「全部推荐」:把 5 个源的推荐打散混排,再按源分组展示。
// 混排是为了让首屏一眼能看到"不止两个源" —— 纯分组时 kugou/kuwo/migu 会被压到很下面。
function aggregateTabs(tabs) {
  const mixed = [];
  const seen = new Set();
  const groups = [];
  for (const tab of tabs) {
    const list = (tab.playlists || []).filter(Boolean);
    if (list.length === 0) continue;
    groups.push({ source: tab.source, sourceName: tab.source_name || tab.source, playlists: list });
  }
  // 按各源第 1 张、第 2 张……交错,得到视觉上"多源混合"的一行
  const maxLen = Math.max(0, ...groups.map((g) => g.playlists.length));
  for (let i = 0; i < maxLen; i += 1) {
    for (const g of groups) {
      const pl = g.playlists[i];
      if (!pl) continue;
      const key = `${pl.source}-${pl.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      mixed.push(pl);
    }
  }
  return { mixed, groups };
}

function CategoryBrowser({ onOpen }) {
  const [activeSource, setActiveSource] = useState(CATEGORY_SOURCES[0]);
  const [activeCategory, setActiveCategory] = useState('');

  const categoriesQuery = useQuery(
    ['playlist-categories', CATEGORY_SOURCES],
    () => getPlaylistCategories(CATEGORY_SOURCES),
    { refetchOnWindowFocus: false, staleTime: 30 * 60 * 1000 },
  );

  const sourceTabs = useMemo(() => {
    const list = categoriesQuery.data?.sources || [];
    return list
      .map((item) => ({
        source: item.source,
        sourceName: item.source_name || item.source,
        categories: (item.categories || [])
          .filter((c) => c && c.name && !IGNORED_CATEGORY_NAMES.has(String(c.name).trim()))
          .map((c) => ({ value: String(c.id ?? c.name), label: String(c.name) })),
        error: item.error,
      }))
      .filter((item) => item.categories.length > 0 || item.error);
  }, [categoriesQuery.data]);

  const currentTab = sourceTabs.find((t) => t.source === activeSource) || sourceTabs[0];
  const effectiveCategory = activeCategory || currentTab?.categories?.[0]?.value || '';

  const playlistsQuery = useQuery(
    ['category-playlists', currentTab?.source, effectiveCategory],
    () => getCategoryPlaylists(currentTab.source, effectiveCategory),
    { enabled: !!currentTab?.source && !!effectiveCategory, refetchOnWindowFocus: false, staleTime: 15 * 60 * 1000 },
  );

  const playlists = playlistsQuery.data?.playlists || [];

  if (categoriesQuery.isLoading) {
    return <LoadingState compact title="加载分类" detail="正在读取各平台的歌单分类" />;
  }
  if (sourceTabs.length === 0) {
    return <StatusLine tone="neutral">分类暂不可用</StatusLine>;
  }

  return (
    <section aria-labelledby="home-categories">
      <SectionHeader
        id="home-categories"
        title="按分类浏览"
        hint="换一个心情听:华语/欧美/摇滚/轻音乐…"
        actions={(
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="刷新分类"
            title="刷新"
            onClick={() => { categoriesQuery.refetch(); playlistsQuery.refetch(); }}
            loading={categoriesQuery.isFetching}
          >
            {!categoriesQuery.isFetching && <RefreshCw size={14} />}
          </Button>
        )}
      />

      {/* 源切换(只在多于 1 个可用源时显示) */}
      {sourceTabs.length > 1 && (
        <div className="mb-3">
          <Segmented
            value={currentTab?.source}
            onChange={(src) => { setActiveSource(src); setActiveCategory(''); }}
            options={sourceTabs.map((t) => ({ value: t.source, label: t.sourceName }))}
            size="sm"
            label="分类来源"
          />
        </div>
      )}

      {/* 分类 chips:换分类立刻重拉 */}
      {currentTab && currentTab.categories.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {currentTab.categories.map((cat) => {
            const active = cat.value === effectiveCategory;
            return (
              <button
                key={cat.value}
                type="button"
                onClick={() => setActiveCategory(cat.value)}
                className={cn(
                  'min-h-9 rounded-full border px-3 type-caption font-medium transition-colors duration-base',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--ring))]',
                  active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground',
                )}
              >
                {cat.label}
              </button>
            );
          })}
        </div>
      )}

      {currentTab?.error && <StatusLine tone="warning">{currentTab.error}</StatusLine>}

      {playlistsQuery.isLoading && (
        <LoadingState compact title="加载分类歌单" detail="正在读取该分类下的歌单" />
      )}

      {!playlistsQuery.isLoading && playlists.length > 0 && (
        <ScrollRow label="分类歌单">
          {playlists.map((pl) => (
            <PlaylistCard key={`${pl.source}-${pl.id}`} playlist={pl} onOpen={onOpen} />
          ))}
        </ScrollRow>
      )}

      {!playlistsQuery.isLoading && !playlists.length && !playlistsQuery.isError && (
        <StatusLine tone="neutral">这个分类暂时没有取到歌单,换一个试试</StatusLine>
      )}
      {playlistsQuery.isError && (
        <StatusLine tone="error" layout="banner">加载分类歌单失败,请换一个分类或稍后重试</StatusLine>
      )}
    </section>
  );
}

export default function HomeRecommendations() {
  const [selectedPlaylist, setSelectedPlaylist] = useState(null);
  const recommendationQuery = useQuery(
    ['trending-recommend', RECOMMENDATION_SOURCES.join(',')],
    () => getRecommend(RECOMMENDATION_SOURCES),
  );
  useCachedRefresh(recommendationQuery);

  useEffect(() => onOpenPlaylist((metadata) => {
    if (metadata?.id && metadata?.source) setSelectedPlaylist(metadata);
  }), []);

  if (selectedPlaylist) {
    // 不要再套一层 max-w/p-4:外层 AppShell 已经给了 max-w-6xl + px-4/6 py-6。
    return <PlaylistSongs meta={selectedPlaylist} onBack={() => setSelectedPlaylist(null)} />;
  }

  const { data, isError, isLoading, isFetching, refetch } = recommendationQuery;

  const openPlaylist = (playlist) => setSelectedPlaylist({
    id: playlist.id,
    source: playlist.source,
    name: playlist.name,
  });

  const tabs = (data?.tabs || []).filter((tab) => (tab.playlists || []).length > 0 || tab.error);
  const { mixed, groups } = useMemo(() => aggregateTabs(tabs), [data]);
  const totalCount = mixed.length;
  const okSourceCount = groups.length;

  return (
    <div>
      <header className="mb-5">
        <h1 className="type-hero text-foreground">发现音乐</h1>
        <p className="mt-1 type-caption text-muted-foreground">
          {totalCount > 0
            ? `来自 ${okSourceCount} 个音乐源的 ${totalCount} 张歌单 · 点开即可播放、存到服务器或缓存到本机`
            : '从多个国内音乐源聚合推荐歌单'}
        </p>
      </header>

      {isLoading && (
        <LoadingState title="加载推荐" detail="正在从多个音乐源并行拉取推荐歌单" rows={3} />
      )}

      {isError && !isLoading && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4">
          <StatusLine tone="error" layout="banner">获取推荐失败</StatusLine>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => refetch()} loading={isFetching}>
            重试
          </Button>
        </div>
      )}

      {data?.cached && data?.refreshing && (
        <StatusLine tone="neutral" loading className="mb-3">正在后台更新缓存,先显示上次结果</StatusLine>
      )}

      {!isLoading && !isError && totalCount === 0 && (
        <EmptyState
          icon={Compass}
          title="暂时没有推荐内容"
          description="上游源可能繁忙，或在设置里扫码登录后可拿到更完整的推荐。"
          action={<Button variant="secondary" onClick={() => refetch()} loading={isFetching}>重新加载</Button>}
        />
      )}

      {!isLoading && totalCount > 0 && (
        <div className="space-y-7">
          {/* 混合推荐:首屏统一露出一行,避免 3 个源被压在折叠线以下 */}
          <section aria-labelledby="home-mixed">
            <SectionHeader
              id="home-mixed"
              title="为你推荐"
              count={`${totalCount} 张`}
              hint="各源推荐混排"
            />
            <ScrollRow label="为你推荐">
              {mixed.map((pl) => (
                <PlaylistCard key={`mixed-${pl.source}-${pl.id}`} playlist={pl} onOpen={openPlaylist} showSource />
              ))}
            </ScrollRow>
          </section>

          {/* 按源分组:想专挑某个平台时可以逐组看 */}
          {groups.map((group) => (
            <section key={group.source} aria-labelledby={`home-${group.source}`}>
              <SectionHeader
                id={`home-${group.source}`}
                title={group.sourceName}
                count={`${group.playlists.length} 张`}
              />
              <ScrollRow label={`${group.sourceName} 推荐歌单`}>
                {group.playlists.map((pl) => (
                  <PlaylistCard key={`${group.source}-${pl.id}`} playlist={pl} onOpen={openPlaylist} />
                ))}
              </ScrollRow>
            </section>
          ))}

          {/* 分类浏览:此前后端早已实现、前端完全没用 —— 这是内容量最大的增量 */}
          <CategoryBrowser onOpen={openPlaylist} />
        </div>
      )}

      {/* 有源失败时低调说明,不打断浏览 */}
      {tabs.filter((t) => t.error).length > 0 && (
        <StatusLine tone="warning" className="mt-4">
          {tabs.filter((t) => t.error).map((t) => `${sourceLabel(t.source)}:${t.error}`).join(' · ')}
        </StatusLine>
      )}
    </div>
  );
}
