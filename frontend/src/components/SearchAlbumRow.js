import React, { useState } from 'react';
import { Disc3 } from 'lucide-react';
import { coverProxyUrl } from '../services/musicdl';
import { sourceLabel } from '../utils/sourceLabels';

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
          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
          <Disc3 size={36} />
        </div>
      )}
    </div>
  );
};

const SearchAlbumRow = ({ albums = [], onOpen }) => {
  if (!albums.length) return null;
  const visibleAlbums = albums.slice(0, MAX_VISIBLE_ALBUMS);

  return (
    <section className="mb-5" aria-labelledby="search-albums-title">
      <div className="mb-2 flex items-end justify-between gap-3">
        <div>
          <h3 id="search-albums-title" className="text-lg font-bold text-foreground">专辑</h3>
          <p className="text-xs text-muted-foreground">点开专辑即可查看完整曲目</p>
        </div>
        <span className="text-xs text-muted-foreground">共 {albums.length} 张</span>
      </div>
      <div className="flex snap-x gap-3 overflow-x-auto pb-2">
        {visibleAlbums.map((album) => (
          <button
            type="button"
            key={`${album.source}-${album.id}`}
            onClick={() => onOpen(album)}
            className="group w-36 flex-none snap-start rounded-lg border border-border bg-card p-2 text-left transition-colors hover:border-primary/60 hover:bg-secondary sm:w-40"
            title={`打开专辑「${album.name}」`}
          >
            <AlbumCover album={album} />
            <p className="mt-2 line-clamp-2 min-h-10 text-sm font-bold text-foreground">{album.name}</p>
            <p className="mt-1 truncate text-xs text-muted-foreground">{album.creator || '未知艺人'}</p>
            <p className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span className="truncate">{sourceLabel(album.source)}</span>
              {album.track_count > 0 && <span className="flex-none">{album.track_count} 首</span>}
            </p>
          </button>
        ))}
      </div>
    </section>
  );
};

export default SearchAlbumRow;
