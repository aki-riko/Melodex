import React, { useState, useEffect, useRef, useCallback } from 'react';
import { QueryClient, QueryClientProvider } from 'react-query';
import { BrowserRouter as Router } from 'react-router-dom';
import Navbar from './components/Navbar';
import Hero from './components/Hero';
import Trending from './components/Trending';
import Artists from './components/Artists';
import Discover from './components/Discover';
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
        <h2 className="text-2xl font-semibold mb-4">Welcome to TuneScout!</h2>
        <p className="mb-1">- TuneScout uses real Last.fm and Spotify information (API implementation) 📈</p>
        <p className="mb-1">- Cards ARE clickable, and Embeds let you play music and add to your Spotify 🎶</p>
        <p className="mb-1">- Please zoom out for a better experience 🔎</p>
        <p className="mb-4">- Psss! Try holding down the Vinyl record and dragging it UP and DOWN quickly 😉</p>
        <button
          onClick={onClose}
          className="bg-primary text-white px-6 py-2 rounded-full hover:bg-red-500 transition duration-300"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onClose();
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
};

function App() {
  const [isNavbarVisible, setIsNavbarVisible] = useState(true);
  const [currentSection, setCurrentSection] = useState('Home');
  const [isPopupOpen, setIsPopupOpen] = useState(true);
  const lastScrollYRef = useRef(0);

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
      <Router basename={process.env.REACT_APP_BASENAME || ''}>
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
      </Router>
    </QueryClientProvider>
  );
}

export default App;
