import React, { useState, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from 'react-query';
import { Sidebar, MobileTabBar } from './components/Sidebar';
import TopBar from './components/TopBar';
import Trending from './components/Trending';
import Artists from './components/Artists';
import Download from './components/Download';
import Settings from './components/Settings';
import MyPlaylist from './components/MyPlaylist';
import RecentlyPlayed from './components/RecentlyPlayed';
import LocalMusic from './components/LocalMusic';
import UserManagement from './components/UserManagement';
import AuthGate from './components/AuthGate';
import { onDownloadSearch } from './services/downloadBus';
import { PlayerProvider, PlayerBar } from './contexts/PlayerContext';
import { CollectionsProvider } from './contexts/CollectionsContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import AddToPlaylistModal from './components/AddToPlaylistModal';
import FAQ from './components/FAQ';
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

const VALID_SECTIONS = ['Home', 'Artists', 'Download', 'Settings', 'FAQ', 'MyPlaylist', 'Recent', 'Local', 'Users'];
// hash 形如 #myplaylist 或 #myplaylist/123(歌单 id);section 取第一段。
const sectionFromHash = () => {
  const h = (window.location.hash || '').replace(/^#/, '').split('/')[0].toLowerCase();
  return VALID_SECTIONS.find((s) => s.toLowerCase() === h) || 'Home';
};

// AppShell:已登录后的主应用布局。
function AppShell() {
  const { isAdmin } = useAuth();
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

  const navigate = (section, subPath) => {
    setCurrentSection(section);
    // 目标 hash:有 subPath 则 #section/sub(如 #myplaylist/123),否则 #section
    const targetHash = subPath != null ? `${section.toLowerCase()}/${subPath}` : section.toLowerCase();
    if (window.location.hash.replace(/^#/, '') !== targetHash) {
      window.location.hash = targetHash;
    }
    const scroller = document.getElementById('app-main');
    if (scroller) scroller.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // 非管理员访问用户管理页 → 回首页(防直接改 hash 进入)。
  const section = currentSection === 'Users' && !isAdmin ? 'Home' : currentSection;

  return (
    <>
      {/* app-shell:左侧固定栏 + 右侧(顶栏+滚动主区);底部播放条与移动 Tab 固定 */}
      <div className="flex h-screen overflow-hidden bg-background text-foreground">
        <Sidebar currentSection={section} onNavigate={navigate} />
        <div className="flex-grow flex flex-col min-w-0">
          <TopBar currentSection={section} onNavigate={navigate} />
          <main
            id="app-main"
            className="flex-grow overflow-y-auto app-scroll"
            style={{ paddingBottom: '7rem' }}
          >
            <div className="container mx-auto px-4 md:px-6 py-6 max-w-6xl">
              {(section === 'Home' || section === 'Trending') && <Trending />}
              {section === 'Download' && <Download downloadRequest={downloadRequest} />}
              {section === 'Settings' && <Settings />}
              {section === 'Artists' && <Artists />}
              {section === 'MyPlaylist' && <MyPlaylist />}
              {section === 'Recent' && <RecentlyPlayed />}
              {section === 'Local' && <LocalMusic />}
              {section === 'Users' && isAdmin && <UserManagement />}
              {section === 'FAQ' && <FAQ />}
            </div>
          </main>
        </div>
      </div>
      <PlayerBar />
      <MobileTabBar currentSection={section} onNavigate={navigate} />
      <AddToPlaylistModal />
    </>
  );
}

// AuthedApp:根据登录态决定渲染登录页还是主应用。
function AuthedApp() {
  const { loading, authenticated } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-muted-foreground">
        加载中…
      </div>
    );
  }
  if (!authenticated) {
    return <AuthGate />;
  }
  return (
    <CollectionsProvider>
      <PlayerProvider>
        <AppShell />
      </PlayerProvider>
    </CollectionsProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AuthedApp />
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
