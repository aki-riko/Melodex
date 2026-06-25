import React from 'react';
import { formatNumber } from '../utils/format';

const TrackTable = ({ tracks, onClick }) => {
  return (
    <div className="bg-white rounded-lg shadow-md overflow-hidden h-full flex flex-col">
      <table className="w-full">
        <thead className="bg-zinc-900/100 text-accent">
          <tr>
            <th className="px-2 py-1 text-left">#</th>
            <th className="px-2 py-1 text-left"></th>
            <th className="px-2 py-1 text-left">Name</th>
            <th className="px-2 py-1 text-left">Artist</th>
            <th className="px-2 py-1 text-right">Streams</th>
          </tr>
        </thead>
      </table>
      <div className="overflow-y-auto flex-grow" style={{ height: 'calc(100% - 30px)' }}>
        <table className="w-full">
          <tbody>
            {tracks.map((track, index) => (
              <tr
                key={track.id}
                className={`${index % 2 === 0 ? 'bg-primary/20' : 'bg-accent/10'} hover:bg-gray-200 cursor-pointer transition-colors duration-300`}
                onClick={() => onClick(track)}
              >
                <td className="px-2 py-1">{index + 7}</td>
                <td className="px-2 py-2">
                  <div className="w-12 h-12 overflow-hidden flex justify-center items-center">
                    <img src={track.image} alt={track.name} className="w-full h-full object-cover" loading="lazy" />
                  </div>
                </td>
                <td className="px-2 py-1 max-w-xs truncate">{track.name}</td>
                <td className="px-2 py-1 max-w-xs truncate">{track.artist}</td>
                <td className="px-2 py-1 text-right">{formatNumber(track.playcount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default TrackTable;
