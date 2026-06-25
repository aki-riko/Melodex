import React from 'react';
import { formatNumber } from '../utils/format';

const TrackCard = ({ track, index, onClick }) => {
  return (
    <div
      key={track.id}
      className="bg-white rounded-lg shadow-md overflow-hidden cursor-pointer transition-all duration-150 ease-in-out transform hover:-translate-y-1 hover:shadow-lg hover:shadow-glow hover:bg-gray-100"
      onClick={() => onClick(track)}
    >
      {track.image && (
        <img src={track.image} alt={track.name} className="w-full h-auto object-contain" loading="lazy" />
      )}
      <div className="p-2">
        <h3 className="font-bold text-sm truncate">
          {index !== undefined ? <span className="mr-1">{index + 1}.</span> : null}
          {track.name}
        </h3>
        <p className="text-m text-red-600 truncate mt-3">{track.artist}</p>
        {index !== undefined ? (
          <p className="text-m text-black-500">Streams: {formatNumber(track.playcount)}</p>
        ) : null}
      </div>
    </div>
  );
};

export default TrackCard;
