import axios from 'axios';

// 后端基址:开发期由 .env 的 REACT_APP_MUSICDL_API 指定(默认本地 8080),
// 生产期前后端同源时留空即可。禁止硬编码,遵循全局规则。
const API_BASE = process.env.REACT_APP_MUSICDL_API || 'http://127.0.0.1:8080';

const client = axios.create({
  baseURL: API_BASE,
  timeout: 30000,
});

// 多源搜索。type: song | playlist | album
export const searchMusic = async (keyword, { type = 'song', sources = [], exactArtist = '' } = {}) => {
  const params = new URLSearchParams();
  params.set('q', keyword);
  params.set('type', type);
  if (exactArtist) params.set('exact_artist', exactArtist);
  sources.forEach((s) => params.append('sources', s));

  const { data } = await client.get(`/api/v1/search?${params.toString()}`);
  return data; // { songs, playlists, type, keyword, sources, error }
};

// 获取可用音乐源
export const getSources = async () => {
  const { data } = await client.get('/api/v1/sources');
  return data; // { all, default, playlist, album }
};

// 每日推荐歌单(按源分栏)
export const getRecommend = async (sources = []) => {
  const params = new URLSearchParams();
  sources.forEach((s) => params.append('sources', s));
  const { data } = await client.get(`/api/v1/recommend?${params.toString()}`);
  return data; // { tabs: [{source, source_name, playlists:[], error}] }
};

// 歌单详情(歌曲列表)
export const getPlaylistDetail = async (id, source) => {
  const { data } = await client.get(`/api/v1/playlist?id=${encodeURIComponent(id)}&source=${encodeURIComponent(source)}`);
  return data; // { songs, type, source, link, error }
};

// 专辑详情(歌曲列表)
export const getAlbumDetail = async (id, source) => {
  const { data } = await client.get(`/api/v1/album?id=${encodeURIComponent(id)}&source=${encodeURIComponent(source)}`);
  return data; // { songs, type, source, link, error }
};

// 歌词(纯文本 LRC,沿用 /music/lyric)
export const getLyric = async (song) => {
  const params = new URLSearchParams();
  params.set('id', song.id);
  params.set('source', song.source);
  params.set('name', song.name || '');
  params.set('artist', song.artist || '');
  const { data } = await client.get(`/music/lyric?${params.toString()}`, { responseType: 'text' });
  return data;
};

// 构造下载/播放链接(沿用 go-music-dl 现有的干净 /music/download 接口)。
// stream=1 用于在线播放(<audio src>);否则触发下载(可选 embed 写入元数据)。
const buildDownloadParams = (song, extra = {}) => {
  const params = new URLSearchParams();
  params.set('id', song.id);
  params.set('source', song.source);
  params.set('name', song.name || '');
  params.set('artist', song.artist || '');
  if (song.album) params.set('album', song.album);
  if (song.cover) params.set('cover', song.cover);
  Object.entries(extra).forEach(([k, v]) => params.set(k, v));
  return params.toString();
};

// 在线播放 URL(流式)
export const getStreamUrl = (song) =>
  `${API_BASE}/music/download?${buildDownloadParams(song, { stream: '1' })}`;

// 直接下载 URL(浏览器下载;embed=1 写入 ID3 元数据与封面)
export const getDownloadUrl = (song) =>
  `${API_BASE}/music/download?${buildDownloadParams(song, { embed: '1' })}`;

export const apiBase = API_BASE;
