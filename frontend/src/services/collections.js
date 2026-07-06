import axios from 'axios';
import { songWritePayload } from '../utils/songFields';

// 自建歌单 API 封装(后端 /music/collections,SQLite 存 NAS,全设备共享)。
const API_BASE = import.meta.env.VITE_MUSICDL_API || '';

const client = axios.create({
  baseURL: API_BASE,
  timeout: 30000,
  withCredentials: true,
});

const BASE = '/music/collections';

// 列我的歌单。includeImported=true 时含平台导入(引用型)歌单,否则只 manual+favorite。
export const listCollections = async ({ includeImported = false } = {}) => {
  const { data } = await client.get(includeImported ? `${BASE}?include_imported=1` : BASE);
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
  const { data } = await client.post(`${BASE}/${encodeURIComponent(id)}/songs`, songWritePayload(song));
  return data;
};

// 从歌单移除歌曲
export const removeSongFromCollection = async (id, song) => {
  const { data } = await client.delete(`${BASE}/${encodeURIComponent(id)}/songs`, {
    data: { songs: [{ id: song.id, source: song.source }] },
  });
  return data;
};

// 导入 m3u/m3u8(content=文件全文)→ 新建歌单并按歌名搜索匹配入库
// 每首一次多源搜索,大歌单可能耗时数分钟,故单独放宽超时到 10 分钟。
export const importM3U = async (name, content) => {
  const { data } = await client.post(`${BASE}/import_m3u`, { name, content }, { timeout: 600000 });
  return data;
};

// 引用型导入平台歌单:只存 source+id,打开时后端实时从平台拉曲目。
// playlist 来自 getUserPlaylists 返回的 model.Playlist(含 id/name/cover/creator/track_count/link/source)。
// 返回 { id, name }、{ id, name, duplicate:true } 或 { id, name, merged:true, added, total }。
export const importPlaylist = async (playlist, { mergeIntoId } = {}) => {
  const { data } = await client.post(`${BASE}/import`, {
    source: playlist.source,
    external_id: playlist.id,
    link: playlist.link || '',
    content_type: 'playlist',
    name: playlist.name || '',
    cover: playlist.cover || '',
    creator: playlist.creator || '',
    track_count: playlist.track_count || 0,
    ...(mergeIntoId ? { merge_into_id: mergeIntoId } : {}),
  });
  return data;
};
