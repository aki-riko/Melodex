import React, { useEffect, useCallback, useState } from 'react';
import { getLastFmArtistDetails } from '../services/lastfm';
import { getSpotifyArtistDetails } from '../services/spotify';
import { formatNumber, capitalize } from '../utils/format';

const ArtistModal = ({ artist, isVisible, onClose, modalRef }) => {
  const [artistInfo, setArtistInfo] = useState(null);
  const [spotifyArtist, setSpotifyArtist] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isVisible || !artist) {
      return;
    }

    let isCancelled = false;

    const fetchArtistDetails = async () => {
      setLoading(true);
      try {
        const [lastFmDetails, spotifyDetails] = await Promise.all([
          getLastFmArtistDetails({ mbid: artist.mbid, name: artist.name }).catch((error) => {
            console.error('Failed to fetch Last.fm artist details', error);
            return null;
          }),
          getSpotifyArtistDetails(artist.name).catch((error) => {
            console.warn('Spotify artist data unavailable', error);
            return null;
          }),
        ]);

        if (isCancelled) {
          return;
        }

        setArtistInfo(lastFmDetails);
        setSpotifyArtist(spotifyDetails);
      } finally {
        if (!isCancelled) {
          setLoading(false);
        }
      }
    };

    fetchArtistDetails();

    return () => {
      isCancelled = true;
    };
  }, [artist, isVisible]);

  const handleKeyDown = useCallback(
    (event) => {
      if (event.key === 'Escape' || event.key === 'Enter') {
        onClose();
      }
    },
    [onClose]
  );

  const trapFocus = useCallback((event) => {
    if (!modalRef?.current) {
      return;
    }

    const focusableElements = modalRef.current.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (event.shiftKey && document.activeElement === firstElement) {
      lastElement.focus();
      event.preventDefault();
    } else if (!event.shiftKey && document.activeElement === lastElement) {
      firstElement.focus();
      event.preventDefault();
    }
  }, [modalRef]);

  useEffect(() => {
    if (isVisible) {
      document.addEventListener('keydown', handleKeyDown);
      document.addEventListener('keydown', trapFocus);

      if (modalRef?.current) {
        const focusableElements = modalRef.current.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (focusableElements.length) {
          focusableElements[0].focus();
        }
      }
    } else {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keydown', trapFocus);
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keydown', trapFocus);
    };
  }, [isVisible, handleKeyDown, trapFocus, modalRef]);

  return (
    <div
      className={`fixed inset-0 bg-black transition-all duration-300 ease-in-out ${
        isVisible ? 'bg-opacity-50 backdrop-blur-sm' : 'bg-opacity-0 backdrop-blur-none pointer-events-none'
      } flex items-center justify-center z-50`}
    >
      <div
        ref={modalRef}
        className={`bg-white p-8 rounded-lg shadow-xl w-full max-w-4xl relative transition-all duration-300 ease-in-out ${
          isVisible ? 'scale-100 opacity-100' : 'scale-0 opacity-0'
        }`}
      >
        <button onClick={onClose} className="absolute top-4 right-4 text-gray-600 hover:text-gray-800" aria-label="Close modal">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        <div className="flex">
          <div className="w-1/2 pr-6">
            <h2 className="text-3xl font-bold mb-4">{artist.name}</h2>
            <p className="text-xl mb-2">
              <strong>Followers:</strong>{' '}
              {formatNumber(spotifyArtist?.followers?.total ?? artistInfo?.stats?.listeners ?? artist.listeners)}
            </p>
            <p className="text-xl mb-2">
              <strong>Genres:</strong>{' '}
              {(spotifyArtist?.genres?.length
                ? spotifyArtist.genres.map(capitalize).join(', ')
                : artistInfo?.tags?.length
                  ? artistInfo.tags.map(capitalize).join(', ')
                  : 'N/A')}
            </p>
            <p className="text-xl mb-2">
              <strong>Popularity:</strong>{' '}
              {spotifyArtist?.popularity ? `${spotifyArtist.popularity}/100` : 'N/A'}
            </p>
            <p className="text-xl mb-6">
              <strong>Playcount:</strong>{' '}
              {formatNumber(artistInfo?.stats?.playcount ?? artist.playcount)}
            </p>
            {artistInfo?.bio?.summary ? (
              <p className="text-base text-gray-700">
                {artistInfo.bio.summary.replace(/<[^>]+>/g, '').slice(0, 300)}{artistInfo.bio.summary.length > 300 ? '…' : ''}
              </p>
            ) : null}
            {loading ? <p className="mt-4 text-gray-500">Loading details…</p> : null}
          </div>
          <div className="w-1/2 pl-6 flex flex-col">
            <div className="mb-6">
              <img
                src={
                  spotifyArtist?.images?.[0]?.url ||
                  artistInfo?.image?.find((img) => img.size === 'mega')?.url ||
                  artist.image ||
                  ''
                }
                alt={artist.name}
                className="w-40 h-40 rounded-full mx-auto object-cover"
                loading="lazy"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ArtistModal;
