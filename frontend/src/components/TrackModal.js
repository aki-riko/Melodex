import React, { useEffect, useState } from 'react';
import { getSpotifyTrackDetails, getSpotifyArtistDetails } from '../services/spotify';
import {
  getLastFmTrackDetails,
  getLastFmTrackTags,
  getLastFmArtistDetails,
} from '../services/lastfm';
import { formatNumber, formatDuration, capitalize } from '../utils/format';
import { requestDownloadSearch } from '../services/downloadBus';

const TrackModal = ({ track, isVisible, onClose, modalRef }) => {
  const [spotifyTrack, setSpotifyTrack] = useState(null);
  const [spotifyArtist, setSpotifyArtist] = useState(null);
  const [artistDetails, setArtistDetails] = useState(null);
  const [trackDetails, setTrackDetails] = useState(null);
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(false);
  const [comments, setComments] = useState([]);
  const [newComment, setNewComment] = useState('');
  const [error, setError] = useState('');
  const releaseDate = spotifyTrack?.album?.release_date ?? null;
  const durationMs = spotifyTrack?.duration_ms ?? (trackDetails?.duration ? Number(trackDetails.duration) * 1000 : null);
  const listenerCount = trackDetails?.listeners ? Number(trackDetails.listeners) : null;
  const hasStats = Boolean(releaseDate || durationMs || (tags && tags.length) || listenerCount);

  useEffect(() => {
    if (!isVisible || !track) {
      return;
    }

    let isCancelled = false;

    const fetchDetails = async () => {
      setLoading(true);
      try {
        const [lfmTrack, lfmTags] = await Promise.all([
          getLastFmTrackDetails({
            mbid: track.mbid,
            name: track.name,
            artist: track.artist,
          }).catch((lfmError) => {
            console.error('Failed to load Last.fm track details', lfmError);
            return null;
          }),
          getLastFmTrackTags({
            mbid: track.mbid,
            name: track.name,
            artist: track.artist,
          }),
        ]);

        const [spotifyTrackData, spotifyArtistData, lfmArtist] = await Promise.all([
          getSpotifyTrackDetails(track.name, track.artist).catch((spotifyError) => {
            console.warn('Spotify track details unavailable', spotifyError);
            return null;
          }),
          getSpotifyArtistDetails(track.artist).catch((spotifyError) => {
            console.warn('Spotify artist details unavailable', spotifyError);
            return null;
          }),
          getLastFmArtistDetails({
            mbid: track.artistMbid,
            name: track.artist,
          }).catch((artistError) => {
            console.error('Failed to load Last.fm artist details', artistError);
            return null;
          }),
        ]);

        if (isCancelled) {
          return;
        }

        setTrackDetails(lfmTrack);
        setTags(lfmTags);
        setSpotifyTrack(spotifyTrackData);
        setSpotifyArtist(spotifyArtistData);
        setArtistDetails(lfmArtist);
      } finally {
        if (!isCancelled) {
          setLoading(false);
        }
      }
    };

    fetchDetails();

    return () => {
      isCancelled = true;
    };
  }, [track, isVisible]);

  useEffect(() => {
    setComments([]);
    setNewComment('');
    setError('');
  }, [track?.id]);

  const handleCommentSubmit = (e) => {
    e.preventDefault();
    if (newComment.trim() === '') {
      setError('评论不能为空');
      return;
    }
    setComments([...comments, `User 1: ${newComment}`]);
    setNewComment('');
    setError('');
  };

  return (
    <div
      className={`fixed inset-0 bg-black transition-all duration-300 ease-in-out ${
        isVisible ? 'bg-opacity-50 backdrop-blur-sm' : 'bg-opacity-0 backdrop-blur-none pointer-events-none'
      } flex items-center justify-center z-50`}
    >
      <div
        ref={modalRef}
        className={`bg-card p-8 border border-border w-full max-w-4xl relative transition-all duration-300 ease-in-out ${
          isVisible ? 'scale-100 opacity-100' : 'scale-0 opacity-0'
        } overflow-y-auto max-h-[90vh]`}
      >
        <button onClick={onClose} className="absolute top-4 right-4 text-muted-foreground hover:text-foreground">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        <div className="flex flex-col md:flex-row">
          <div className="w-full md:w-1/2 pr-0 md:pr-6 mb-6 md:mb-0">
            <h2 className="text-3xl font-bold mb-4">{track.name}</h2>
            <p className="text-xl mb-2"><strong>艺人:</strong> {track.artist}</p>
            {trackDetails?.album?.title && trackDetails.album.title !== track.name ? (
              <p className="text-xl mb-2"><strong>专辑:</strong> {trackDetails.album.title}</p>
            ) : null}
            <p className="text-xl mb-6">
              <strong>播放量:</strong> {formatNumber(track.playcount)}
            </p>
            <button
              onClick={() => {
                requestDownloadSearch(`${track.name} ${track.artist}`);
                onClose();
              }}
              className="mb-6 inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground border border-border font-bold transition-all"
              title="跳转到下载页,从国内源搜索这首歌"
            >
              ↓ 在国内源下载这首歌
            </button>
            {spotifyTrack ? (
              <iframe
                src={`https://open.spotify.com/embed/track/${spotifyTrack.id}`}
                width="100%"
                height="152"
                frameBorder="0"
                allow="encrypted-media"
                className="mb-6"
                title="Track Player"
              ></iframe>
            ) : (
              <p className="mb-6 text-muted-foreground">这首歌暂无 Spotify 试听。</p>
            )}
            <div className="mb-4">
              <h3 className="text-2xl font-semibold mb-2">更多数据</h3>
              {hasStats ? (
                <ul className="list-disc pl-5 text-lg">
                  {releaseDate ? (
                    <li><strong>发行日期:</strong> {releaseDate}</li>
                  ) : null}
                  {durationMs ? (
                    <li>
                      <strong>时长:</strong> {formatDuration(durationMs)}
                    </li>
                  ) : null}
                  {tags.length ? (
                    <li>
                      <strong>标签:</strong> {tags.map(capitalize).join(', ')}
                    </li>
                  ) : null}
                  {listenerCount ? (
                    <li><strong>听众:</strong> {formatNumber(listenerCount)}</li>
                  ) : null}
                </ul>
              ) : (
                !loading && <p className="text-muted-foreground">未能找到这首歌的更多数据。</p>
              )}
            </div>
          </div>
          <div className="w-full md:w-1/2 pl-0 md:pl-6 flex flex-col">
            <div className="mb-6">
              <img
                src={
                  spotifyArtist?.images?.[0]?.url ||
                  artistDetails?.image?.find((img) => img.size === 'mega')?.url ||
                  artistDetails?.image?.[0]?.url ||
                  ''
                }
                alt={track.artist}
                className="w-40 h-40 rounded-full mx-auto object-cover"
                loading="lazy"
              />
            </div>
            {spotifyTrack?.album?.id ? (
              <iframe
                src={`https://open.spotify.com/embed/album/${spotifyTrack.album.id}`}
                width="100%"
                height="380"
                frameBorder="0"
                allow="encrypted-media"
                className="flex-grow"
                title="Album Player"
              ></iframe>
            ) : null}
            {loading ? <p className="mt-4 text-center text-muted-foreground">正在加载详情…</p> : null}
          </div>
        </div>
        
        {/* Comment Section */}
        <div className="mt-8">
          <h3 className="text-2xl font-semibold mb-4">评论</h3>
          <form onSubmit={handleCommentSubmit} className="mb-4">
            <textarea
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              className="w-full p-2 border border-border resize-none"
              placeholder="写下评论…"
              rows="1"
              maxLength="70"
            ></textarea>
            {error && <p className="text-destructive text-sm mt-1">{error}</p>}
            <button
              type="submit"
              className="mt-2 bg-primary text-primary-foreground px-5 py-2 rounded-full border border-border font-bold transition-all"
            >
              发表评论
            </button>
          </form>
          <div className="space-y-4">
            {comments.map((comment, index) => (
              <div key={index} className="bg-muted p-4 border border-border">
                <p>{comment}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default TrackModal;
