import axios from 'axios';

const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
const SEARCH_ENDPOINT = 'https://api.spotify.com/v1/search';
const DEFAULT_LIMIT = 10;

let cachedToken = null;
let cachedTokenExpiry = 0;

const getSpotifyCredentials = () => {
  const clientId = import.meta.env.VITE_SPOTIFY_CLIENT_ID;
  const clientSecret = import.meta.env.VITE_SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Missing Spotify credentials. Please set VITE_SPOTIFY_CLIENT_ID and VITE_SPOTIFY_CLIENT_SECRET.');
  }

  return { clientId, clientSecret };
};

const encodeCredentials = (clientId, clientSecret) => {
  const credentials = `${clientId}:${clientSecret}`;

  if (typeof window !== 'undefined' && window.btoa) {
    return window.btoa(credentials);
  }

  return Buffer.from(credentials).toString('base64');
};

export const getSpotifyToken = async () => {
  if (cachedToken && Date.now() < cachedTokenExpiry) {
    return cachedToken;
  }

  const { clientId, clientSecret } = getSpotifyCredentials();
  const encodedCredentials = encodeCredentials(clientId, clientSecret);

  const response = await axios.post(
    TOKEN_ENDPOINT,
    'grant_type=client_credentials',
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${encodedCredentials}`,
      },
    },
  );

  cachedToken = response.data.access_token;
  cachedTokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;

  return cachedToken;
};

const withSpotifyAuth = async (request) => {
  const token = await getSpotifyToken();
  return request(token);
};

const runSearch = async (params) => withSpotifyAuth(async (token) => {
  const response = await axios.get(SEARCH_ENDPOINT, {
    headers: { Authorization: `Bearer ${token}` },
    params,
  });

  return response.data;
});

export const getSpotifyTrackDetails = async (trackName, artistName) => {
  if (!trackName || !artistName) {
    return null;
  }

  const data = await runSearch({
    q: `track:${trackName} artist:${artistName}`,
    type: 'track',
    limit: 1,
  });

  return data.tracks?.items?.[0] ?? null;
};

export const getSpotifyArtistDetails = async (artistName) => {
  if (!artistName) {
    return null;
  }

  const data = await runSearch({
    q: `artist:${artistName}`,
    type: 'artist',
    limit: 1,
  });

  return data.artists?.items?.[0] ?? null;
};

export const searchSpotify = async (query, types = ['track', 'album'], limit = DEFAULT_LIMIT) => {
  if (!query) {
    return null;
  }

  return runSearch({
    q: query,
    type: types.join(','),
    limit,
  });
};
