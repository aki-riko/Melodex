import axios from 'axios';

// 自建歌单 API 封装(后端 /music/collections,SQLite 存 NAS,全设备共享)。
const API_BASE = import.meta.env.VITE_MUSICDL_API || '';

const client = axios.create({
  baseURL: API_BASE,
  timeout: 30000,
  withCredentials: true,
});

const BASE = '/music/collections';

// 列我的自建歌单(默认只 manual 自建)
export const listCollections = async () => {
  const { data } = await client.get(BASE);
  return Array.isArray(data) ? data : [];
};

// 新建歌单
export const createCollection = async (name, { description = '', cover = '' } = {}) => {
  const { data } = await client.post(BASE, { name, description, cover });
  return data;
};

// 改名/描述
export const updateCollection = async (id, fields) => {
  const { data } = await client.put(`${BASE}/${encodeURIComponent(id)}`, fields);
  return data;
};

// 删歌单
export const deleteCollection = async (id) => {
  const { data } = await client.delete(`${BASE}/${encodeURIComponent(id)}`);
  return data;
};

// 歌单内歌曲
export const getCollectionSongs = async (id) => {
  const { data } = await client.get(`${BASE}/${encodeURIComponent(id)}/songs`);
  return data; // { songs: [...] } 或数组,调用方兜底
};

// 加歌到歌单
export const addSongToCollection = async (id, song) => {
  const { data } = await client.post(`${BASE}/${encodeURIComponent(id)}/songs`, {
    id: song.id,
    source: song.source,
    name: song.name,
    artist: song.artist,
    cover: song.cover,
    duration: song.duration,
    extra: song.extra,
  });
  return data;
};

// 从歌单移除歌曲
export const removeSongFromCollection = async (id, song) => {
  const { data } = await client.delete(`${BASE}/${encodeURIComponent(id)}/songs`, {
    data: { songs: [{ id: song.id, source: song.source }] },
  });
  return data;
};
