import axios from 'axios';

const BASE_URL = 'https://ws.audioscrobbler.com/2.0/';
const DEFAULT_LIMIT = 50;

const getApiKey = () => {
  const apiKey = import.meta.env.VITE_LASTFM_API_KEY;

  if (!apiKey) {
    throw new Error('Missing Last.fm credentials. Please set VITE_LASTFM_API_KEY.');
  }

  return apiKey;
};

const getImageUrl = (images = [], preferredSize = 'large') => {
  const match = images.find((image) => image.size === preferredSize);
  return match?.['#text'] ?? images[0]?.['#text'] ?? '';
};

const chartRequest = async (method, extraParams = {}) => {
  const apiKey = getApiKey();

  const response = await axios.get(BASE_URL, {
    params: {
      method,
      api_key: apiKey,
      format: 'json',
      ...extraParams,
    },
  });

  return response.data;
};

export const getLastFmTopTracks = async (limit = DEFAULT_LIMIT) => {
  const data = await chartRequest('chart.gettoptracks', { limit });

  return data.tracks.track.map((track) => ({
    id: track.mbid || `${track.name}-${track.artist.name}`,
    mbid: track.mbid,
    name: track.name,
    artist: track.artist.name,
    artistMbid: track.artist.mbid,
    playcount: Number(track.playcount) || 0,
    listeners: Number(track.listeners) || 0,
    image: getImageUrl(track.image),
    url: track.url,
  }));
};

const buildTrackRequestParams = ({ mbid, name, artist }) => {
  if (mbid) {
    return { mbid };
  }

  return { track: name, artist };
};

export const getLastFmTrackDetails = async ({ mbid, name, artist }) => {
  const data = await chartRequest('track.getInfo', buildTrackRequestParams({ mbid, name, artist }));
  return data.track ?? null;
};

export const getLastFmTrackTags = async ({ mbid, name, artist }) => {
  try {
    const data = await chartRequest('track.getTopTags', buildTrackRequestParams({ mbid, name, artist }));
    if (!data?.toptags?.tag) {
      return [];
    }

    return data.toptags.tag
      .filter((tag) => Boolean(tag.name))
      .map((tag) => tag.name);
  } catch (error) {
    console.error('Failed to fetch Last.fm track tags', error);
    return [];
  }
};

export const getLastFmTopArtists = async (limit = DEFAULT_LIMIT) => {
  const data = await chartRequest('chart.gettopartists', { limit });

  return data.artists.artist.map((artist) => ({
    id: artist.mbid || artist.name,
    mbid: artist.mbid,
    name: artist.name,
    playcount: Number(artist.playcount) || 0,
    listeners: Number(artist.listeners) || 0,
    image: getImageUrl(artist.image),
    url: artist.url,
  }));
};

export const getLastFmArtistDetails = async ({ mbid, name }) => {
  const params = mbid ? { mbid } : { artist: name };
  const data = await chartRequest('artist.getInfo', params);
  const artist = data.artist;

  if (!artist) {
    return null;
  }

  return {
    ...artist,
    image: artist.image?.map((img) => ({ url: img['#text'], size: img.size })) ?? [],
    tags: artist.tags?.tag?.map((tag) => tag.name) ?? [],
  };
};
