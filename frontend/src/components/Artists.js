import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery } from 'react-query';
import { getLastFmTopArtists } from '../services/lastfm';
import ArtistCard from './ArtistCard';
import ArtistModal from './ArtistModal';

const Artists = () => {
  const [selectedArtist, setSelectedArtist] = useState(null);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const modalRef = useRef(null);
  const lastFocusedElement = useRef(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [currentArtists, setCurrentArtists] = useState([]);
  const artistsPerPage = 10;

  const { data: artists, error, isLoading } = useQuery('topArtists', getLastFmTopArtists);

  const handleArtistClick = useCallback((artist, event) => {
    if (event?.currentTarget) {
      lastFocusedElement.current = event.currentTarget;
    }
    setSelectedArtist(artist);
    setIsModalVisible(true);
  }, []);

  const closePopup = useCallback(() => {
    setIsModalVisible(false);
    setTimeout(() => {
      setSelectedArtist(null);
      if (lastFocusedElement.current) {
        lastFocusedElement.current.focus();
      }
    }, 300);
  }, []);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (modalRef.current && !modalRef.current.contains(event.target)) {
        closePopup();
      }
    };

    if (isModalVisible) {
      document.addEventListener('mousedown', handleClickOutside);
    } else {
      document.removeEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isModalVisible, closePopup]);

  useEffect(() => {
    if (artists) {
      const sortedArtists = [...artists].sort((a, b) => b.playcount - a.playcount);
      const indexOfLastArtist = currentPage * artistsPerPage;
      const indexOfFirstArtist = indexOfLastArtist - artistsPerPage;
      setCurrentArtists(sortedArtists.slice(indexOfFirstArtist, indexOfLastArtist));
    }
  }, [artists, currentPage]);

  if (error) return <p className="text-red-500 text-center mt-4" role="alert">Failed to fetch top artists</p>;
  if (isLoading) return <p className="text-center mt-4" role="status">Loading...</p>;

  const paginate = (pageNumber) => {
    setCurrentArtists([]); // Clear current artists before updating the page
    setCurrentPage(pageNumber);
  };

  const handlePreviousPage = () => {
    if (currentPage > 1) paginate(currentPage - 1);
  };

  const handleNextPage = () => {
    if (currentPage < Math.ceil(artists.length / artistsPerPage)) paginate(currentPage + 1);
  };

  return (
    <div className="p-4 mb-3">
      <header>
        <h1 className="text-5xl font-bold text-center mb-5 text-red-600 py-3" id="top-artists-heading">Top 50 Artists</h1>
      </header>
      <main>
        <div className="flex justify-center">
          <div className="grid grid-cols-5 gap-6" role="list" aria-labelledby="top-artists-heading">
            {currentArtists.map((artist, index) => (
              <ArtistCard
                key={artist.id}
                artist={artist}
                index={(currentPage - 1) * artistsPerPage + index}
                onClick={handleArtistClick}
                tabIndex="0"
                role="listitem"
              />
            ))}
          </div>
        </div>
        <nav aria-label="Pagination" className="flex justify-center mt-6">
          <button
            onClick={handlePreviousPage}
            className={`px-4 py-2 mx-1 rounded ${currentPage === 1 ? 'bg-gray-300 text-gray-500' : 'bg-white text-red-600'}`}
            disabled={currentPage === 1}
            aria-label="Previous Page"
          >
            Previous
          </button>
          {artists && Array.from({ length: Math.ceil(artists.length / artistsPerPage) }, (_, i) => (
            <button
              key={i + 1}
              onClick={() => paginate(i + 1)}
              className={`px-4 py-2 mx-1 rounded ${i + 1 === currentPage ? 'bg-red-600 text-white' : 'bg-white text-red-600'}`}
              aria-label={`Page ${i + 1}`}
              aria-current={i + 1 === currentPage ? 'page' : undefined}
            >
              {i + 1}
            </button>
          ))}
          <button
            onClick={handleNextPage}
            className={`px-4 py-2 mx-1 rounded ${currentPage === Math.ceil(artists.length / artistsPerPage) ? 'bg-gray-300 text-gray-500' : 'bg-white text-red-600'}`}
            disabled={currentPage === Math.ceil(artists.length / artistsPerPage)}
            aria-label="Next Page"
          >
            Next
          </button>
        </nav>
      </main>
      {selectedArtist && (
        <ArtistModal 
          artist={selectedArtist} 
          isVisible={isModalVisible} 
          onClose={closePopup} 
          modalRef={modalRef} 
        />
      )}
    </div>
  );
};

export default Artists;
