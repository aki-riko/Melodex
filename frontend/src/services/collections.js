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

// 导入 m3u/m3u8(content=文件全文)→ 新建歌单并按歌名搜索匹配入库。
//
// ★ 2026-11 全库扫描改契约:提交**立即返回**,不再同步等搜索完。
//   原因:条目上限 1000、每条一次全源搜索(主力源实测 1~2 秒),同步跑要
//   1000~2000 秒,而这里原来设的 600 秒超时必然先到 —— 用户看到"导入失败",
//   但后端其实已建好歌单并在继续填歌,刷新一下歌单又出现了。
//
//   现在的形状:
//     POST   /import_m3u            → { task_id, id, name, total, state }
//     GET    /import_m3u/tasks/:id  → { state, total, processed, matched,
//                                      skipped, percent, message }
//     DELETE /import_m3u/tasks/:id  → 取消(已导入的歌曲保留)
//
//   所以这里不再需要 10 分钟超时,普通请求超时即可。
export const importM3U = async (name, content) => {
  const { data } = await client.post(`${BASE}/import_m3u`, { name, content });
  return data;
};

// 查询 m3u 导入进度。前端轮询直到 state 不再是 'running'。
export const getImportM3UTask = async (taskId) => {
  const { data } = await client.get(`${BASE}/import_m3u/tasks/${encodeURIComponent(taskId)}`);
  return data;
};

// 取消 m3u 导入。已导入的歌曲保留(半份歌单比全丢更有用)。
export const cancelImportM3UTask = async (taskId) => {
  const { data } = await client.delete(`${BASE}/import_m3u/tasks/${encodeURIComponent(taskId)}`);
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
