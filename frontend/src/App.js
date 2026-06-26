import React, { useState, useEffect, useRef, useCallback } from 'react';
import { QueryClient, QueryClientProvider } from 'react-query';
import Navbar from './components/Navbar';
import Hero from './components/Hero';
import Trending from './components/Trending';
import Artists from './components/Artists';
import Discover from './components/Discover';
import Download from './components/Download';
import Settings from './components/Settings';
import Videogen from './components/Videogen';
import { onDownloadSearch } from './services/downloadBus';
import FAQ from './components/FAQ';
import Footer from './components/Footer';
import 'react-toastify/dist/ReactToastify.css';

// Create a client
const queryClient = new QueryClient();

const PopupMenu = ({ isOpen, onClose }) => {
  const popupRef = useRef(null);

  const handleKeyDown = useCallback((event) => {
    if (event.key === 'Escape' || event.key === 'Enter') {
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      const focusableElements = popupRef.current?.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (focusableElements && focusableElements.length) {
        focusableElements[0].focus();
      }
    } else {
      document.removeEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, handleKeyDown]);

  return (
    <div className={`fixed inset-0 bg-gray-900 bg-opacity-50 ${isOpen ? 'flex' : 'hidden'} justify-center items-center`}>
      <div
        ref={popupRef}
        className="bg-white p-6 rounded-lg shadow-lg w-1/2"
        tabIndex={0}
      >
        <h2 className="text-2xl font-semibold mb-4">欢迎使用 TuneScout+!</h2>
        <p className="mb-1">- 在「发现 / 热门 / 艺人」里浏览 Last.fm 与 Spotify 的榜单与艺人信息 📈</p>
        <p className="mb-1">- 在「下载」页从国内多源搜索、在线播放、下载音乐 🎶</p>
        <p className="mb-1">- 在歌曲详情里可一键跳到「下载」从国内源获取 🔎</p>
        <p className="mb-4">- 在「视频生成」把歌曲做成带封面与歌词的视频 🎬</p>
        <button
          onClick={onClose}
          className="bg-primary text-white px-6 py-2 rounded-full hover:bg-red-500 transition duration-300"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onClose();
          }}
        >
          开始使用
        </button>
      </div>
    </div>
  );
};

function App() {
  const [isNavbarVisible, setIsNavbarVisible] = useState(true);
  const [currentSection, setCurrentSection] = useState('Home');
  const [isPopupOpen, setIsPopupOpen] = useState(true);
  const [downloadRequest, setDownloadRequest] = useState({ keyword: '', nonce: 0 });
  const lastScrollYRef = useRef(0);

  // 发现页「在国内源下载」→ 切到下载页并预填搜索词。
  // 用递增 nonce 确保即便重复点同一首歌也能再次触发搜索。
  useEffect(() => {
    return onDownloadSearch((keyword) => {
      setDownloadRequest((prev) => ({ keyword, nonce: prev.nonce + 1 }));
      setCurrentSection('Download');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const controlNavbar = () => {
      const currentScroll = window.scrollY;
      if (currentScroll > lastScrollYRef.current + 30) {
        setIsNavbarVisible(false);
      } else if (currentScroll < lastScrollYRef.current - 10) {
        setIsNavbarVisible(true);
      }
      lastScrollYRef.current = currentScroll;
    };

    window.addEventListener('scroll', controlNavbar, { passive: true });

    return () => {
      window.removeEventListener('scroll', controlNavbar);
    };
  }, []);

  const handleLinkClick = (section) => {
    setCurrentSection(section);
  };

  const closePopup = () => {
    setIsPopupOpen(false);
  };

  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen flex flex-col bg-background text-text">
        <Navbar
          isVisible={isNavbarVisible}
          onLinkClick={handleLinkClick}
          currentSection={currentSection}
        />
          <main className="flex-grow">
            {currentSection === 'Home' && (
              <section id="home">
                <Hero onLinkClick={handleLinkClick} isPopupOpen={isPopupOpen} />
                <div className="flex justify-center">
                  <Trending />
                </div>
                <FAQ />
              </section>
            )}
            {currentSection === 'Trending' && (
              <section id="trending" className="container mx-auto container-padding py-2">
                <div className="flex justify-center">
                  <Trending />
                </div>
              </section>
            )}
            {currentSection === 'Discover' && (
              <section id="discover" className="container mx-auto container-padding section-padding">
                <Discover />
              </section>
            )}
            {currentSection === 'Download' && (
              <section id="download" className="container mx-auto container-padding section-padding pb-32">
                <Download downloadRequest={downloadRequest} />
              </section>
            )}
            {currentSection === 'Settings' && (
              <section id="settings" className="container mx-auto container-padding section-padding">
                <Settings />
              </section>
            )}
            {currentSection === 'Videogen' && (
              <section id="videogen" className="container mx-auto container-padding section-padding">
                <Videogen />
              </section>
            )}
            {currentSection === 'Artists' && (
              <section id="artists" className="container mx-auto container-padding section-padding">
                <Artists />
              </section>
            )}
            {currentSection === 'FAQ' && (
              <section id="faq" className="container mx-auto container-padding section-padding">
                <FAQ />
              </section>
            )}
          </main>
          <Footer />
          <PopupMenu isOpen={isPopupOpen} onClose={closePopup} />
          {/* <ToastContainer /> */}
        </div>
    </QueryClientProvider>
  );
}

export default App;
