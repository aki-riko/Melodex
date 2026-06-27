import React, { useState, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from 'react-query';
import { Sidebar, MobileTabBar } from './components/Sidebar';
import TopBar from './components/TopBar';
import Trending from './components/Trending';
import Artists from './components/Artists';
import Discover from './components/Discover';
import Download from './components/Download';
import Settings from './components/Settings';
import MyPlaylist from './components/MyPlaylist';
import { onDownloadSearch } from './services/downloadBus';
import { PlayerProvider, PlayerBar } from './contexts/PlayerContext';
import { CollectionsProvider } from './contexts/CollectionsContext';
import AddToPlaylistModal from './components/AddToPlaylistModal';
import FAQ from './components/FAQ';
import Footer from './components/Footer';
import 'react-toastify/dist/ReactToastify.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      staleTime: 5 * 60 * 1000,
    },
  },
});

const VALID_SECTIONS = ['Home', 'Trending', 'Artists', 'Discover', 'Download', 'Settings', 'FAQ', 'MyPlaylist'];
const sectionFromHash = () => {
  const h = (window.location.hash || '').replace(/^#/, '').toLowerCase();
  return VALID_SECTIONS.find((s) => s.toLowerCase() === h) || 'Home';
};

function App() {
  const [currentSection, setCurrentSection] = useState(sectionFromHash);
  const [downloadRequest, setDownloadRequest] = useState(null);

  // hash 变化同步当前页(浏览器前进后退/分享)
  useEffect(() => {
    const onHash = () => setCurrentSection(sectionFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // 发现页/全局搜索「去下载」→ 切到下载页并预填搜索词
  useEffect(() => {
    return onDownloadSearch((keyword) => {
      setDownloadRequest({ keyword, ts: Date.now() });
      navigate('Download');
    });
  }, []);

  const navigate = (section) => {
    setCurrentSection(section);
    if (window.location.hash.replace(/^#/, '').toLowerCase() !== section.toLowerCase()) {
      window.location.hash = section.toLowerCase();
    }
    const scroller = document.getElementById('app-main');
    if (scroller) scroller.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <QueryClientProvider client={queryClient}>
      <CollectionsProvider>
      <PlayerProvider>
        {/* app-shell:左侧固定栏 + 右侧(顶栏+滚动主区);底部播放条与移动 Tab 固定 */}
        <div className="flex h-screen overflow-hidden bg-background text-foreground">
          <Sidebar currentSection={currentSection} onNavigate={navigate} />
          <div className="flex-grow flex flex-col min-w-0">
            <TopBar currentSection={currentSection} onNavigate={navigate} />
            <main
              id="app-main"
              className="flex-grow overflow-y-auto app-scroll"
              style={{ paddingBottom: '7rem' }}
            >
              <div className="container mx-auto px-4 md:px-6 py-6 max-w-6xl">
                {/* 首页直接用发现页(分类浏览歌单),去掉无实质内容的欢迎页 */}
                {(currentSection === 'Home' || currentSection === 'Discover') && <Discover />}
                {currentSection === 'Trending' && <Trending />}
                {currentSection === 'Download' && <Download downloadRequest={downloadRequest} />}
                {currentSection === 'Settings' && <Settings />}
                {currentSection === 'Artists' && <Artists />}
                {currentSection === 'MyPlaylist' && <MyPlaylist />}
                {currentSection === 'FAQ' && <FAQ />}
                {/* 页脚(含第三方署名)只放帮助页,其余页保持干净 */}
                {currentSection === 'FAQ' && <Footer />}
              </div>
            </main>
          </div>
        </div>
        <PlayerBar />
        <MobileTabBar currentSection={currentSection} onNavigate={navigate} />
        <AddToPlaylistModal />
      </PlayerProvider>
      </CollectionsProvider>
    </QueryClientProvider>
  );
}

export default App;
