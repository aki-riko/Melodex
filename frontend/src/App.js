import React, { useState, useEffect, useRef } from 'react';
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
import { ThemeProvider } from './theme/ThemeContext.jsx';
import AddToPlaylistModal from './components/AddToPlaylistModal';
import HelpPage from './components/HelpPage';
import MorePage from './components/MorePage';
import LoadingState from './components/LoadingState';
import CredentialNotice from './components/CredentialNotice';
import ErrorBoundary from './ui/ErrorBoundary';
import { useBackNavigation, setRouteBackResolver } from './contexts/backNavigation.js';
import { pushRouteEntry, goBackInApp, ROUTE_DEPTH_KEY } from './contexts/routeHistory.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      staleTime: 5 * 60 * 1000,
    },
  },
});

const VALID_SECTIONS = ['Home', 'Download', 'Settings', 'FAQ', 'MyPlaylist', 'Recent', 'Local', 'Offline', 'Users', 'More'];
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

  // 首次挂载:把当前页标记成"本次会话的入口页"(深度 0)。
  //
  // 为什么需要:hash 路由里用户可能带着 #myplaylist/7 深链接直接进来,
  // 或者刷新到某一子页 —— 这时 history.state 是 null。不显式标 0 的话,
  // readRouteDepth 会把 null 当 0(行为正确),但**深链接页面上"是否还能后退"**
  // 就失去了明确语义;标一次之后,后续 pushRouteEntry 的 +1 才有可靠基线。
  // 用 replaceState 而不是 pushState:入口页不该多出一条历史。
  useEffect(() => {
    if (window.history.state?.[ROUTE_DEPTH_KEY] != null) return;
    window.history.replaceState({ [ROUTE_DEPTH_KEY]: 0 }, '', window.location.href);
  }, []);

  // 路由同步。两个来源都要听,缺一个就会出现"URL 变了页面没变":
  //   · hashchange —— 手动改 hash(深链接、外部跳转、部分老入口);
  //   · popstate   —— 用 pushState 写的历史(本站 navigate)在后退/前进时
  //                   **只派发 popstate,不派发 hashchange**。
  // 只监听 hashchange 的话,按返回键 URL 会变但页面停在原处 —— 真机踩过。
  useEffect(() => {
    const syncRoute = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', syncRoute);
    window.addEventListener('popstate', syncRoute);
    return () => {
      window.removeEventListener('hashchange', syncRoute);
      window.removeEventListener('popstate', syncRoute);
    };
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
      // 用 pushState 而不是 location.hash=:后者带不了 state,而"返回上一页"
      // 需要靠 state 里的深度标记区分站内层级(见 routeHistory.js)。
      pushRouteEntry(targetHash);
    }
    const scroller = document.getElementById('app-main');
    if (scroller) scroller.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // 离线模式只开放本机缓存页,避免首页/搜索/歌单页自动请求后端。
  // 非管理员访问用户管理页 → 回首页(防直接改 hash 进入)。
  // 「更多」页里的入口(最近播放/设置/歌单)都要打后端,离线时同样归到离线页。
  const section = offline ? 'Offline' : (currentSection === 'Users' && !isAdmin ? 'Home' : currentSection);
  const activeSubPath = section === 'MyPlaylist' ? currentSubPath : null;

  // 返回键:浮层都收完之后,沿**历史**退回上一页;退不动了才交给系统退出。
  //
  // 这里踩过一个坑,记下来别再犯:第一版写的是"不在首页就 navigate('Home')",
  // 于是从歌单点进去按返回,不管从哪来都一律掉回首页 —— 用户报的正是这个。
  // "上一页"必须沿真实历史后退,不能猜一个固定目标。
  //
  // 判断依据是 history.state 里的深度标记(见 routeHistory.js):
  // APK 是外壳加载远端站,history.length 包含外部跳转,拿它判断必然误判。
  useEffect(() => setRouteBackResolver(() => {
    // 站内还有上一页 → 后退。浏览器/WebView 会派发 popstate,
    // 上面那个同步 effect 监听了 popstate,路由随之更新。
    // 已经是本次会话的入口页(深度 0)→ 不消费,让系统退出/退到后台。
    return goBackInApp();
  }), []);

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
          {/* 凭证过期/即将过期提示。放在离线横幅同一位置 ——
              这类"能力降级"信息应该常驻可见,而不是埋在设置页里。 */}
          <CredentialNotice />
          <main
            id="app-main"
            tabIndex={-1}
            className={`flex-grow overflow-y-auto scroll-area app-main ${
              nowPlaying ? 'app-main--playing' : ''
            } ${notice ? 'app-main--notice' : ''}`}
          >
            {/* key 用 section+subPath:切页时容器重挂载,动画才会重新播放。
                若只加 className,React 复用同一节点,animation 只在首次生效。
                动画定义在 index.css 的 .fluent-page-enter(14px 上浮 + 淡入 +
                轻微缩放,var(--motion-slow)=280ms),并已被 prefers-reduced-motion 覆盖。
                幅度经过一轮调整:第一版 6px/180ms 用户反馈"没动画"(太弱不是没生效)。 */}
            <div
              key={`${section}/${activeSubPath || ''}`}
              className="container mx-auto px-4 md:px-6 py-6 max-w-6xl fluent-page-enter"
            >
              {section === 'Home' && <HomeRecommendations />}
              {section === 'Download' && <Download downloadRequest={downloadRequest} />}
              {section === 'Settings' && <Settings />}
              {section === 'MyPlaylist' && <MyPlaylist />}
              {section === 'Recent' && <RecentlyPlayed />}
              {section === 'Local' && <LocalMusic />}
              {section === 'Offline' && <OfflineMusic />}
              {section === 'Users' && isAdmin && <UserManagement />}
              {section === 'FAQ' && <HelpPage />}
              {section === 'More' && <MorePage onNavigate={navigate} />}
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
  // 返回键接线必须在根部挂一次(浏览器 popstate + 安卓原生事件 → 统一返回栈)。
  // 放在 App 而不是 AppShell:登录页(未鉴权)也会有弹层,同样需要返回键生效。
  useBackNavigation();

  return (
    // ErrorBoundary 必须在最外层:任何 Provider 内部组件渲染抛错都要被兜住,
    // 否则整棵树卸载 → 白屏(历史上真实发生过)。
    <ErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <FeedbackProvider>
              <AuthedApp />
            </FeedbackProvider>
          </AuthProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
