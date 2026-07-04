import React from 'react';
import { formatNumber } from '../utils/format';

const TrackCard = ({ track, index, onClick }) => {
  return (
    <div
      key={track.id}
      className="bg-card border border-border overflow-hidden cursor-pointer transition-all"
      onClick={() => onClick(track)}
    >
      {track.image && (
        <img src={track.image} alt={track.name} className="w-full h-auto object-contain border-b-2 border-border" loading="lazy" />
      )}
      <div className="p-2">
        <h3 className="font-bold text-sm truncate">
          {index !== undefined ? <span className="mr-1">{index + 1}.</span> : null}
          {track.name}
        </h3>
        <p className="text-sm font-bold text-primary truncate mt-3">{track.artist}</p>
        {index !== undefined ? (
          <p className="text-sm text-muted-foreground">播放量: {formatNumber(track.playcount)}</p>
        ) : null}
      </div>
    </div>
  );
};

export default TrackCard;
