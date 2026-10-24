import React, { useEffect, useState } from 'react';
import { useQuery } from 'react-query';
import { Compass, Music, Play } from 'lucide-react';
import { getRecommend, coverProxyUrl } from '../services/musicdl';
import { onOpenPlaylist } from '../services/playlistBus';
import { useCachedRefresh } from '../hooks/useCachedRefresh';
import LoadingState from './LoadingState';
import PlaylistSongs from './PlaylistSongs';
import Button from '../ui/Button';
import EmptyState from '../ui/EmptyState';
import StatusLine from '../ui/StatusLine';
import ScrollRow from '../ui/ScrollRow';
import { SectionHeader } from '../ui/Card';

const RECOMMENDATION_SOURCES = ['netease', 'qq'];

// 推荐歌单卡:封面必须走 coverProxyUrl(网易是 http://,生产 https 会被混合内容拦截),
// 且要 onError 回退 —— 此前直接用 pl.cover 且无回退,会出现裂图。
function PlaylistCard({ playlist, onOpen }) {
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
      </div>
      <p className="mt-2 line-clamp-2 type-caption font-semibold leading-snug">{playlist.name}</p>
    </button>
  );
}

function RecommendationGroup({ tab, onOpen }) {
  return (
    <section aria-labelledby={`home-${tab.source}`}>
      <SectionHeader
        id={`home-${tab.source}`}
        title={tab.source_name || tab.source}
        count={(tab.playlists || []).length ? `${(tab.playlists || []).length} 张` : undefined}
      />
      {tab.error ? (
        <StatusLine tone="warning">{tab.error}</StatusLine>
      ) : (tab.playlists || []).length === 0 ? (
        <StatusLine tone="neutral">这个源暂时没有返回推荐内容</StatusLine>
      ) : (
        <ScrollRow label={`${tab.source_name || tab.source} 推荐歌单`}>
          {(tab.playlists || []).map((playlist) => (
            <PlaylistCard key={`${playlist.source}-${playlist.id}`} playlist={playlist} onOpen={onOpen} />
          ))}
        </ScrollRow>
      )}
    </section>
  );
}

export default function HomeRecommendations() {
  const [selectedPlaylist, setSelectedPlaylist] = useState(null);
  const recommendationQuery = useQuery(['trending-recommend'], () => getRecommend(RECOMMENDATION_SOURCES));
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

  return (
    <div>
      <header className="mb-5">
        <h1 className="type-hero text-foreground">热门推荐</h1>
        <p className="mt-1 type-caption text-muted-foreground">
          来自网易云与 QQ 的歌单,点开即可播放、下载到服务器或缓存到本机
        </p>
      </header>

      {isLoading && (
        <LoadingState title="加载热门推荐" detail="正在从国内音乐源拉取推荐歌单" rows={3} />
      )}

      {isError && !isLoading && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4">
          <StatusLine tone="error" layout="banner">获取热门推荐失败</StatusLine>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => refetch()} loading={isFetching}>
            重试
          </Button>
        </div>
      )}

      {data?.cached && data?.refreshing && (
        <StatusLine tone="neutral" loading className="mb-3">
          正在后台更新缓存,先显示上次结果
        </StatusLine>
      )}

      {!isLoading && !isError && tabs.length === 0 && (
        <EmptyState
          icon={Compass}
          title="暂时没有推荐歌单"
          description="上游源可能繁忙或需要登录(在设置里扫码登录后音质与推荐更完整)。"
          action={<Button variant="secondary" onClick={() => refetch()} loading={isFetching}>重新加载</Button>}
        />
      )}

      {!isLoading && tabs.length > 0 && (
        <div className="space-y-7">
          {tabs.map((tab) => (
            <RecommendationGroup key={tab.source} tab={tab} onOpen={openPlaylist} />
          ))}
        </div>
      )}
    </div>
  );
}
