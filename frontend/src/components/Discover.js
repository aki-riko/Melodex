import React, { useState } from 'react';
import { searchSpotify } from '../services/spotify';

const Discover = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!searchQuery.trim()) {
      setError('Please enter a song or album title to search.');
      return;
    }
    setLoading(true);
    setError(null);

    try {
      const results = await searchSpotify(searchQuery);
      setSearchResults(results);
    } catch (err) {
      const message = err?.message?.includes('Spotify credentials')
        ? 'Spotify credentials are missing. Please configure environment variables before searching.'
        : 'Failed to fetch search results. Please try again later.';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-200px)] p-4">
      <h1 className="text-4xl font-bold mb-4">Discover Music</h1>
      <form onSubmit={handleSearch} className="w-full max-w-lg flex items-center bg-white rounded-lg shadow-md">
        <div className="px-3">
          <svg className="h-6 w-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        <input
          type="text"
          className="flex-grow p-2 rounded-l-lg focus:outline-none"
          placeholder="Search for songs or albums..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <button type="submit" className="bg-red-600 text-white px-4 py-2 rounded-r-lg">Search</button>
      </form>
      {loading && <p className="mt-4">Loading...</p>}
      {error && <p className="mt-4 text-red-500">{error}</p>}
      <div className="w-full max-w-4xl mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {searchResults?.tracks?.items?.map((track) => (
          <div key={track.id} className="w-full">
            <iframe
              src={`https://open.spotify.com/embed/track/${track.id}`}
              width="100%"
              height="80"
              frameBorder="0"
              allowTransparency="true"
              allow="encrypted-media"
              title={track.name}
              className="rounded-lg"
            ></iframe>
          </div>
        ))}
        {searchResults?.albums?.items?.map((album) => (
          <div key={album.id} className="w-full">
            <iframe
              src={`https://open.spotify.com/embed/album/${album.id}`}
              width="100%"
              height="380"
              frameBorder="0"
              allowTransparency="true"
              allow="encrypted-media"
              title={album.name}
              className="rounded-lg"
            ></iframe>
          </div>
        ))}
      </div>
      <p className="mt-1 text-center text-gray-500">
        (Note: When you click "Add to Spotify," if you are logged into Spotify on the browser, it will actually add it to your Spotify account!)
      </p>
      <p className="mt-1 text-center text-gray-500">
      Press the play button to play music!
      </p>

    </div>
  );
};

export default Discover;
