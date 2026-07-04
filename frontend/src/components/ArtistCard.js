import React from 'react';
import { formatNumber } from '../utils/format';

const ArtistCard = ({ artist, index, onClick, ...rest }) => {
  const handleClick = (event) => {
    onClick(artist, event);
  };

  const handleKeyDown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick(artist, event);
    }
  };

  return (
    <div
      key={artist.id}
      className="bg-card border border-border overflow-hidden cursor-pointer transition-all w-48 h-64"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex="0"
      role="button"
      aria-label={`艺人 ${artist.name}`}
      {...rest}
    >
      {artist.image && (
        <img
          src={artist.image}
          alt={artist.name}
          className="w-full h-36 object-cover border-b-2 border-border"
          loading="lazy"
          draggable="false"
        />
      )}
      <div className="p-2">
        <h3 className="font-bold text-xs truncate">
          {index !== undefined ? <span className="mr-1">{index + 1}.</span> : null}
          {artist.name}
        </h3>
        {index !== undefined ? (
          <>
            <p className="text-sm font-bold text-primary truncate mt-3">
              听众: {formatNumber(artist.listeners)}
            </p>
            <p className="text-sm text-muted-foreground">
              播放量: {formatNumber(artist.playcount)}
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
};

export default ArtistCard;
