import React, { useState } from 'react';
import { useQuery } from 'react-query';
import { getRecommend } from '../services/musicdl';
import PlaylistSongs from './PlaylistSongs';

// 热门:展示国内各源(网易云/QQ)的推荐歌单,点进看歌曲并播放/下载。
const Trending = () => {
  const [open, setOpen] = useState(null); // {id, source, name}
  const { data, isLoading, isError } = useQuery(['trending-recommend'], () =>
    getRecommend(['netease', 'qq'])
  );

  if (open) {
    return (
      <div className="max-w-5xl mx-auto p-4">
        <PlaylistSongs meta={open} onBack={() => setOpen(null)} />
      </div>
    );
  }

  const tabs = data?.tabs || [];
  return (
    <div className="max-w-5xl mx-auto p-4">
      <h1 className="text-4xl font-extrabold mb-6 inline-block border-2 border-border bg-primary text-primary-foreground px-4 py-1 shadow-brutal">
        热门推荐
      </h1>
      {isLoading && <p className="text-muted-foreground font-bold">加载中…</p>}
      {isError && <p className="text-destructive font-bold">获取热门推荐失败</p>}
      <div className="space-y-8 pb-32">
        {tabs.map((tab) => (
          <div key={tab.source}>
            <h3 className="text-xl font-bold mb-3 inline-block border-2 border-border bg-card px-3 py-1 shadow-brutal-sm">
              {tab.source_name || tab.source}
            </h3>
            {tab.error && <p className="text-destructive font-bold text-sm mb-2">{tab.error}</p>}
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4 mt-3">
              {(tab.playlists || []).map((pl) => (
                <div
                  key={`${pl.source}-${pl.id}`}
                  className="cursor-pointer group border-2 border-border bg-card shadow-brutal-sm transition-all hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none p-2"
                  onClick={() => setOpen({ id: pl.id, source: pl.source, name: pl.name })}
                >
                  <div className="aspect-square overflow-hidden border-2 border-border bg-muted">
                    {pl.cover && <img src={pl.cover} alt={pl.name} loading="lazy" className="w-full h-full object-cover" />}
                  </div>
                  <p className="text-sm font-bold mt-2 line-clamp-2">{pl.name}</p>
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
