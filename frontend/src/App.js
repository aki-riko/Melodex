import React, { useState, useEffect, useRef } from 'react';
import { QueryClient, QueryClientProvider } from 'react-query';
import Navbar from './components/Navbar';
import Hero from './components/Hero';
import Trending from './components/Trending';
import Artists from './components/Artists';
import Discover from './components/Discover';
import Download from './components/Download';
import Settings from './components/Settings';
import { onDownloadSearch } from './services/downloadBus';
import { PlayerProvider, PlayerBar } from './contexts/PlayerContext';
import FAQ from './components/FAQ';
import Footer from './components/Footer';
import 'react-toastify/dist/ReactToastify.css';

// Create a client
const queryClient = new QueryClient();

function App() {
  const [isNavbarVisible, setIsNavbarVisible] = useState(true);
  const [currentSection, setCurrentSection] = useState('Home');
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

  return (
    <QueryClientProvider client={queryClient}>
      <PlayerProvider>
      <div className="min-h-screen flex flex-col bg-background text-text">
        <Navbar
          isVisible={isNavbarVisible}
          onLinkClick={handleLinkClick}
          currentSection={currentSection}
        />
          <main className="flex-grow">
            {currentSection === 'Home' && (
              <section id="home">
                <Hero onLinkClick={handleLinkClick} />
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
          <PlayerBar />
          {/* <ToastContainer /> */}
        </div>
      </PlayerProvider>
    </QueryClientProvider>
  );
}

export default App;
