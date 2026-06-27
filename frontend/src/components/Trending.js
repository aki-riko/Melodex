import React, { useState, useEffect } from 'react';
import { useQuery } from 'react-query';
import { Play } from 'lucide-react';
import { getRecommend } from '../services/musicdl';
import { onOpenPlaylist } from '../services/playlistBus';
import PlaylistSongs from './PlaylistSongs';

// 热门:展示国内各源(网易云/QQ)的推荐歌单,点进看歌曲并播放/下载。
const Trending = () => {
  const [open, setOpen] = useState(null); // {id, source, name}
  const { data, isLoading, isError } = useQuery(['trending-recommend'], () =>
    getRecommend(['netease', 'qq'])
  );

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
      {isLoading && <p className="text-muted-foreground font-medium">加载中…</p>}
      {isError && <p className="text-destructive font-medium">获取热门推荐失败</p>}
      <div className="space-y-8">
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
      </div>
    </div>
  );
};

export default Trending;
