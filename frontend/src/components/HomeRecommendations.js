import React, { useEffect, useState } from 'react';
import { useQuery } from 'react-query';
import { Loader2, Play } from 'lucide-react';
import { getRecommend } from '../services/musicdl';
import { onOpenPlaylist } from '../services/playlistBus';
import { useCachedRefresh } from '../hooks/useCachedRefresh';
import LoadingState from './LoadingState';
import PlaylistSongs from './PlaylistSongs';

const RECOMMENDATION_SOURCES = ['netease', 'qq'];

function PlaylistCard({ playlist, onOpen }) {
  return (
    <div
      className="media-card group"
      onClick={() => onOpen(playlist)}
    >
      <div className="media-card__art">
        {playlist.cover && <img src={playlist.cover} alt={playlist.name} loading="lazy" />}
        <span className="media-card__play"><Play size={20} fill="currentColor" /></span>
      </div>
      <p className="text-sm font-medium line-clamp-2">{playlist.name}</p>
    </div>
  );
}

function RecommendationGroup({ tab, onOpen }) {
  return (
    <section>
      <h3 className="text-xl font-semibold mb-3 text-foreground">
        {tab.source_name || tab.source}
      </h3>
      {tab.error && <p className="text-destructive font-medium text-sm mb-2">{tab.error}</p>}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4 mt-3">
        {(tab.playlists || []).map((playlist) => (
          <PlaylistCard
            key={`${playlist.source}-${playlist.id}`}
            playlist={playlist}
            onOpen={onOpen}
          />
        ))}
      </div>
    </section>
  );
}

export default function HomeRecommendations() {
  const [selectedPlaylist, setSelectedPlaylist] = useState(null);
  const recommendationQuery = useQuery(['trending-recommend'], () =>
    getRecommend(RECOMMENDATION_SOURCES)
  );
  useCachedRefresh(recommendationQuery);

  useEffect(() => onOpenPlaylist((metadata) => {
    if (metadata?.id && metadata?.source) {
      setSelectedPlaylist(metadata);
    }
  }), []);

  if (selectedPlaylist) {
    return (
      <div className="max-w-5xl mx-auto p-4">
        <PlaylistSongs
          meta={selectedPlaylist}
          onBack={() => setSelectedPlaylist(null)}
        />
      </div>
    );
  }

  const { data, isError, isLoading } = recommendationQuery;
  const openPlaylist = (playlist) => setSelectedPlaylist({
    id: playlist.id,
    source: playlist.source,
    name: playlist.name,
  });

  return (
    <div>
      <h1 className="text-3xl font-black mb-6">热门推荐</h1>
      {isLoading && (
        <LoadingState
          title="加载热门推荐"
          detail="正在从国内音乐源拉取推荐歌单"
          rows={6}
          className="mb-6"
        />
      )}
      {isError && <p className="text-destructive font-medium">获取热门推荐失败</p>}
      {!isLoading && (
        <div className="space-y-8">
          {data?.cached && data?.refreshing && (
            <div className="inline-flex items-center gap-2 rounded-md border border-border bg-card/70 px-3 py-2 text-sm text-muted-foreground">
              <Loader2 size={15} className="animate-spin text-primary" />
              <span>正在后台更新缓存，当前先显示上次结果</span>
            </div>
          )}
          {(data?.tabs || []).map((tab) => (
            <RecommendationGroup key={tab.source} tab={tab} onOpen={openPlaylist} />
          ))}
        </div>
      )}
    </div>
  );
}
