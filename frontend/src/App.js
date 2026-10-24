import React, { useState, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from 'react-query';
import { WifiOff } from 'lucide-react';
import { Sidebar, MobileTabBar } from './components/Sidebar';
import TopBar from './components/TopBar';
import HomeRecommendations from './components/HomeRecommendations';
import Download from './components/Download';
import Settings from './components/Settings';
import MyPlaylist from './components/MyPlaylist';
import RecentlyPlayed from './components/RecentlyPlayed';
import LocalMusic from './components/LocalMusic';
import OfflineMusic from './components/OfflineMusic';
import UserManagement from './components/UserManagement';
import AuthGate from './components/AuthGate';
import { onDownloadSearch } from './services/downloadBus';
import { PlayerProvider, PlayerBar, usePlayer } from './contexts/PlayerContext';
import { CollectionsProvider } from './contexts/CollectionsContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ServerDownloadsProvider } from './contexts/ServerDownloadsContext';
import { FeedbackProvider } from './contexts/FeedbackContext';
import AddToPlaylistModal from './components/AddToPlaylistModal';
import HelpPage from './components/HelpPage';
import LoadingState from './components/LoadingState';
import ErrorBoundary from './ui/ErrorBoundary';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      staleTime: 5 * 60 * 1000,
    },
  },
});

const VALID_SECTIONS = ['Home', 'Download', 'Settings', 'FAQ', 'MyPlaylist', 'Recent', 'Local', 'Offline', 'Users'];
// hash 形如 #myplaylist 或 #myplaylist/123(歌单 id);section 取第一段。
const routeFromHash = () => {
  const parts = (window.location.hash || '').replace(/^#/, '').split('/');
  const h = (parts[0] || '').toLowerCase();
  return {
    section: VALID_SECTIONS.find((s) => s.toLowerCase() === h) || 'Home',
    subPath: parts[1] || null,
  };
};

// AppShell:已登录后的主应用布局。
function AppShell() {
  const { isAdmin, offline } = useAuth();
  // 主滚动区底部留白取决于底栏实际占用(播放条/迷你条 + 提示行), 见 index.css 的 .app-main。
  const { nowPlaying, notice } = usePlayer();
  const [route, setRoute] = useState(routeFromHash);
  const { section: currentSection, subPath: currentSubPath } = route;
  const [downloadRequest, setDownloadRequest] = useState(null);

  // hash 变化同步当前页(浏览器前进后退/分享)
  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
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
    setRoute({ section, subPath: subPath != null ? String(subPath) : null });
    // 目标 hash:有 subPath 则 #section/sub(如 #myplaylist/123),否则 #section
    const targetHash = subPath != null ? `${section.toLowerCase()}/${subPath}` : section.toLowerCase();
    if (window.location.hash.replace(/^#/, '') !== targetHash) {
      window.location.hash = targetHash;
    }
    const scroller = document.getElementById('app-main');
    if (scroller) scroller.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // 离线模式只开放本机缓存页,避免首页/搜索/歌单页自动请求后端。
  // 非管理员访问用户管理页 → 回首页(防直接改 hash 进入)。
  const section = offline ? 'Offline' : (currentSection === 'Users' && !isAdmin ? 'Home' : currentSection);
  const activeSubPath = section === 'MyPlaylist' ? currentSubPath : null;

  return (
    <>
      {/* 键盘用户第一个 Tab 就能跳过侧栏直达主内容(全站此前无此能力)。
          注意不能只靠 href="#app-main":本应用是哈希路由,改 hash 会触发
          hashchange → routeFromHash() 不认识 app-main → 兜底回 Home,
          用户按"跳到主内容"反而被弹回首页、还丢掉 #myplaylist/<id> 深链接。
          所以这里 preventDefault,只做"聚焦 + 滚到顶"。 */}
      <a
        href="#app-main"
        className="skip-link"
        onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById('app-main');
          if (!main) return;
          main.focus();
          main.scrollTo({ top: 0, behavior: 'auto' });
        }}
      >
        跳到主内容
      </a>
      {/* app-shell:左侧固定栏 + 右侧(顶栏+滚动主区);底部播放条与移动 Tab 固定 */}
      <div className="app-shell flex overflow-hidden bg-background text-foreground">
        <Sidebar currentSection={section} currentSubPath={activeSubPath} onNavigate={navigate} />
        <div className="flex-grow flex flex-col min-w-0">
          <TopBar currentSection={section} onNavigate={navigate} />
          {offline && (
            <div className="flex items-center gap-2 border-b border-primary/30 bg-primary/10 px-4 md:px-6 py-2 type-caption text-primary">
              <WifiOff size={16} aria-hidden="true" />
              <span>离线模式:只播放本机缓存</span>
            </div>
          )}
          <main
            id="app-main"
            tabIndex={-1}
            className={`flex-grow overflow-y-auto scroll-area app-main ${
              nowPlaying ? 'app-main--playing' : ''
            } ${notice ? 'app-main--notice' : ''}`}
          >
            <div className="container mx-auto px-4 md:px-6 py-6 max-w-6xl">
              {section === 'Home' && <HomeRecommendations />}
              {section === 'Download' && <Download downloadRequest={downloadRequest} />}
              {section === 'Settings' && <Settings />}
              {section === 'MyPlaylist' && <MyPlaylist />}
              {section === 'Recent' && <RecentlyPlayed />}
              {section === 'Local' && <LocalMusic />}
              {section === 'Offline' && <OfflineMusic />}
              {section === 'Users' && isAdmin && <UserManagement />}
              {section === 'FAQ' && <HelpPage />}
            </div>
          </main>
        </div>
      </div>
      <PlayerBar />
      <MobileTabBar currentSection={section} currentSubPath={activeSubPath} onNavigate={navigate} />
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
        <LoadingState
          title="启动 Melodex"
          detail="正在恢复登录态和播放器状态"
          compact
          showRows={false}
          className="w-[min(28rem,calc(100vw-2rem))]"
        />
      </div>
    );
  }
  if (!authenticated) {
    return <AuthGate />;
  }
  return (
    <CollectionsProvider>
      <ServerDownloadsProvider>
        <PlayerProvider>
          <AppShell />
        </PlayerProvider>
      </ServerDownloadsProvider>
    </CollectionsProvider>
  );
}

function App() {
  return (
    // ErrorBoundary 必须在最外层:任何 Provider 内部组件渲染抛错都要被兜住,
    // 否则整棵树卸载 → 白屏(历史上真实发生过)。
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <FeedbackProvider>
            <AuthedApp />
          </FeedbackProvider>
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
