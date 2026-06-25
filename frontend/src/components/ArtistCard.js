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
      className="bg-white rounded-lg shadow-md overflow-hidden cursor-pointer transition-all duration-150 ease-in-out transform hover:-translate-y-1 hover:shadow-lg hover:shadow-glow hover:bg-gray-100 w-48 h-64"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex="0"
      role="button"
      aria-label={`Artist ${artist.name}`}
      {...rest}
    >
      {artist.image && (
        <img
          src={artist.image}
          alt={artist.name}
          className="w-full h-36 object-cover"
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
            <p className="text-m text-red-600 truncate mt-3">
              Listeners: {formatNumber(artist.listeners)}
            </p>
            <p className="text-m text-black-500">
              Playcount: {formatNumber(artist.playcount)}
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
};

export default ArtistCard;
