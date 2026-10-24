import React, { useState } from 'react';
import { Disc3 } from 'lucide-react';
import { coverProxyUrl } from '../services/musicdl';
import { sourceLabel } from '../utils/sourceLabels';

// 搜索结果顶部的专辑区。
// 旧实现:一条 `overflow-x-auto` 直接产生浏览器默认滚动条(白槽),
// 且卡片 144px 宽 + 双层文字,与下方歌曲列表争夺视觉权重。
// 现在:统一走 ScrollRow(隐藏滚动槽 + 箭头 + 渐隐),卡片更紧凑,
// 标题行右对齐"全部 N 张"作为可读的计数,而不是散在角落的小字。

const MAX_VISIBLE_ALBUMS = 12;

const AlbumCover = ({ album }) => {
  const [failed, setFailed] = useState(false);
  const cover = failed ? '' : coverProxyUrl(album);

  return (
    <div className="aspect-square overflow-hidden rounded-md bg-secondary">
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
          <Disc3 size={28} />
        </div>
      )}
    </div>
  );
};

const AlbumCard = ({ album, onOpen }) => (
  <button
    type="button"
    onClick={() => onOpen(album)}
    className="group w-[8.5rem] rounded-lg border border-transparent p-1.5 text-left transition-colors duration-base ease-standard hover:border-border hover:bg-secondary/60 focus-visible:border-border focus-visible:bg-secondary/60"
    title={`打开专辑「${album.name}」`}
  >
    <AlbumCover album={album} />
    <p className="mt-1.5 line-clamp-2 type-caption font-semibold leading-snug text-foreground">
      {album.name}
    </p>
    <p className="mt-0.5 truncate type-micro text-muted-foreground">
      {album.creator || '未知艺人'}
    </p>
    <p className="mt-0.5 flex items-center justify-between gap-1 type-micro text-muted-foreground">
      <span className="truncate">{sourceLabel(album.source)}</span>
      {album.track_count > 0 && <span className="flex-none nums">{album.track_count} 首</span>}
    </p>
  </button>
);

/**
 * @param {object} props
 * @param {Array} props.albums
 * @param {(album:object)=>void} props.onOpen
 * @param {React.ComponentType} [props.ScrollRow] 由调用方注入以复用 ui/ScrollRow
 */
export default function SearchAlbumRow({ albums = [], onOpen, ScrollRow }) {
  if (!albums.length) return null;
  const visible = albums.slice(0, MAX_VISIBLE_ALBUMS);

  const cards = visible.map((album) => (
    <AlbumCard key={`${album.source}-${album.id}`} album={album} onOpen={onOpen} />
  ));

  return (
    <section aria-labelledby="search-albums-title">
      <div className="mb-2 flex items-end justify-between gap-3">
        <h2 id="search-albums-title" className="type-section text-foreground">
          匹配到的专辑
        </h2>
        <span className="type-micro text-muted-foreground nums">
          共 {albums.length} 张{visible.length < albums.length ? ` · 显示前 ${visible.length}` : ''}
        </span>
      </div>
      {ScrollRow ? <ScrollRow label="匹配到的专辑">{cards}</ScrollRow> : (
        <div className="flex gap-2">{cards}</div>
      )}
    </section>
  );
}
