import React, { useState, useEffect } from 'react';
import { useQuery } from 'react-query';
import { Loader2, Play } from 'lucide-react';
import { getRecommend } from '../services/musicdl';
import { onOpenPlaylist } from '../services/playlistBus';
import PlaylistSongs from './PlaylistSongs';
import LoadingState from './LoadingState';
import { useCachedRefresh } from '../hooks/useCachedRefresh';

// 热门:展示国内各源(网易云/QQ)的推荐歌单,点进看歌曲并播放/下载。
const Trending = () => {
  const [open, setOpen] = useState(null); // {id, source, name}
  const recommend = useQuery(['trending-recommend'], () =>
    getRecommend(['netease', 'qq'])
  );
  useCachedRefresh(recommend);
  const { data, isLoading, isError } = recommend;

  // 仅处理推荐歌单(带 id+source);自建歌单(collectionId)由 MyPlaylist 处理
  useEffect(() => onOpenPlaylist((meta) => { if (meta && meta.id && meta.source) setOpen(meta); }), []);

  if (open) {
    return (
      <div className="max-w-5xl mx-auto p-4">
        <PlaylistSongs meta={open} onBack={() => setOpen(null)} />
      </div>
    );
  }

  const tabs = data?.tabs || [];
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
      {!isLoading && <div className="space-y-8">
        {data?.cached && data?.refreshing && (
          <div className="inline-flex items-center gap-2 rounded-md border border-border bg-card/70 px-3 py-2 text-sm text-muted-foreground">
            <Loader2 size={15} className="animate-spin text-primary" />
            <span>正在后台更新缓存，当前先显示上次结果</span>
          </div>
        )}
        {tabs.map((tab) => (
          <div key={tab.source}>            <h3 className="text-xl font-semibold mb-3 text-foreground">
              {tab.source_name || tab.source}
            </h3>
            {tab.error && <p className="text-destructive font-medium text-sm mb-2">{tab.error}</p>}
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4 mt-3">
              {(tab.playlists || []).map((pl) => (
                <div
                  key={`${pl.source}-${pl.id}`}
                  className="media-card group"
                  onClick={() => setOpen({ id: pl.id, source: pl.source, name: pl.name })}
                >
                  <div className="media-card__art">
                    {pl.cover && <img src={pl.cover} alt={pl.name} loading="lazy" />}
                    <span className="media-card__play"><Play size={20} fill="currentColor" /></span>
                  </div>
                  <p className="text-sm font-medium line-clamp-2">{pl.name}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>}
    </div>
  );
};

export default Trending;
