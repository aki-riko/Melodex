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
      setError('请输入要搜索的歌曲或专辑名称。');
      return;
    }
    setLoading(true);
    setError(null);

    try {
      const results = await searchSpotify(searchQuery);
      setSearchResults(results);
    } catch (err) {
      const message = err?.message?.includes('Spotify credentials')
        ? '缺少 Spotify 凭据,请先配置环境变量再搜索。'
        : '获取搜索结果失败,请稍后再试。';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-200px)] p-4">
      <h1 className="text-4xl font-bold mb-4">发现音乐</h1>
      <form onSubmit={handleSearch} className="w-full max-w-lg flex items-center bg-card border-2 border-border shadow-brutal-sm">
        <div className="px-3">
          <svg className="h-6 w-6 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
        <input
          type="text"
          className="flex-grow p-2 focus:outline-none"
          placeholder="搜索歌曲或专辑…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <button type="submit" className="bg-primary text-primary-foreground px-4 py-2 border-2 border-border font-bold shadow-brutal-sm transition-all hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none">搜索</button>
      </form>
      {loading && <p className="mt-4">加载中…</p>}
      {error && <p className="mt-4 text-destructive">{error}</p>}
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
            ></iframe>
          </div>
        ))}
      </div>
      <p className="mt-1 text-center text-muted-foreground">
        (提示:点击 "Add to Spotify" 时,如果你已在浏览器登录 Spotify,它会真的把歌曲添加到你的 Spotify 账户!)
      </p>
      <p className="mt-1 text-center text-muted-foreground">
      点击播放按钮即可试听音乐!
      </p>

    </div>
  );
};

export default Discover;
