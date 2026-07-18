import axios from 'axios';
import { normalizeSong, normalizeSongs, songWritePayload } from '../utils/songFields';
import { serverSaveSucceeded } from '../utils/serverDownloads';

export { serverSaveSucceeded };

// 后端基址:开发期由 .env 的 VITE_MUSICDL_API 指定(见 .env.development.local 指向本地后端);
// 生产/同源部署(如 Docker 内后端托管前端)留空 → axios 走相对路径,自动用当前 origin。
// 禁止硬编码,遵循全局规则。
const API_BASE = import.meta.env.VITE_MUSICDL_API || '';

const client = axios.create({
  baseURL: API_BASE,
  timeout: 30000,
  // 敏感接口(登录/cookie)需携带管理员鉴权 cookie。
  // 注意:跨域携带 credentials 时后端 CORS 不能用通配 Origin(见后端 corsMiddleware 说明)。
  withCredentials: true,
});

const withSongs = (data, key = 'songs') => (
  data && Array.isArray(data[key]) ? { ...data, [key]: normalizeSongs(data[key]) } : data
);

export const SERVER_DOWNLOADS_CHANGED = 'melodex:server-downloads-changed';

const notifyServerDownloadsChanged = (detail) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SERVER_DOWNLOADS_CHANGED, { detail }));
};

// 全局 401 拦截:会话过期/失效时派发事件,由 AuthProvider 监听并切回登录页。
// 排除鉴权自身接口(/auth/*、/me),避免登录失败时误触发(它们自行处理 401)。
client.interceptors.response.use(
  (resp) => resp,
  (error) => {
    const status = error?.response?.status;
    const url = error?.config?.url || '';
    const isAuthEndpoint = url.includes('/api/v1/auth/') || url.endsWith('/api/v1/me');
    if (status === 401 && !isAuthEndpoint && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('melodex:unauthorized'));
    }
    return Promise.reject(error);
  }
);

// 多源搜索。type: song | lyric | playlist | album
export const searchMusic = async (keyword, { type = 'song', sources = [], exactArtist = '', skipWarm = false } = {}) => {
  const params = new URLSearchParams();
  params.set('q', keyword);
  params.set('type', type);
  if (exactArtist) params.set('exact_artist', exactArtist);
  if (skipWarm) params.set('skip_warm', '1');
  sources.forEach((s) => params.append('sources', s));

  const { data } = await client.get(`/api/v1/search?${params.toString()}`);
  return withSongs(data); // { songs, playlists, type, keyword, sources, error }
};

export const clearSearchCache = async (keyword, { types = ['song'], sources = [], exactArtist = '' } = {}) => {
  const params = new URLSearchParams();
  params.set('q', keyword);
  (types.length ? types : ['song']).forEach((type) => params.append('type', type));
  if (exactArtist) params.set('exact_artist', exactArtist);
  sources.forEach((source) => params.append('sources', source));
  const { data } = await client.delete(`/api/v1/search_cache?${params.toString()}`);
  return data; // { deleted }
};

// 输入框补全建议:只读本地搜索历史/缓存,不触发上游搜索或验活。
export const getSearchSuggestions = async (keyword, { limit = 24 } = {}) => {
  const params = new URLSearchParams();
  params.set('q', keyword);
  params.set('limit', limit);
  const { data } = await client.get(`/api/v1/search_suggestions?${params.toString()}`);
  return withSongs(data); // { keywords, songs }
};

const recognitionExtForMime = (mime = '') => {
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  return 'webm';
};

// 听歌识曲:前端只上传短录音,第三方识曲 token/签名全部在后端处理。
export const recognizeAudio = async (blob) => {
  const form = new FormData();
  form.append('file', blob, `recognition.${recognitionExtForMime(blob?.type || '')}`);
  const { data } = await client.post('/api/v1/recognize', form, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    timeout: 60000,
  });
  return data; // { status, matched, provider, query, result, error? }
};

export const getRecognitionStatus = async () => {
  const { data } = await client.get('/api/v1/recognize/status');
  return data; // { enabled, provider, max_bytes, timeout, rate_limit_per_minute, error? }
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

// 我在各平台创建/收藏的个人歌单(需先在设置里登录对应平台 cookie)。
// 不缓存(依登录态);未登录的源返回 tab.error。
export const getUserPlaylists = async (sources = []) => {
  const params = new URLSearchParams();
  sources.forEach((s) => params.append('sources', s));
  const qs = params.toString();
  const { data } = await client.get(`/api/v1/user_playlists${qs ? `?${qs}` : ''}`);
  return data; // { tabs: [{source, source_name, playlists:[{id,name,cover,track_count,creator,link}], error}] }
};

// 歌单分类(各源的分类标签)
export const getPlaylistCategories = async (sources = []) => {
  const params = new URLSearchParams();
  sources.forEach((s) => params.append('sources', s));
  const { data } = await client.get(`/api/v1/playlist_categories?${params.toString()}`);
  return data; // { sources: [{source, source_name, categories:[{id,name,group}], error}] }
};

// 某分类下的歌单
export const getCategoryPlaylists = async (source, categoryId) => {
  const params = new URLSearchParams();
  params.set('source', source);
  if (categoryId) params.set('category_id', categoryId);
  const { data } = await client.get(`/api/v1/category_playlists?${params.toString()}`);
  return data; // { playlists, source, error }
};

// 歌单详情(歌曲列表)
export const getPlaylistDetail = async (id, source) => {
  const { data } = await client.get(`/api/v1/playlist?id=${encodeURIComponent(id)}&source=${encodeURIComponent(source)}`);
  return withSongs(data); // { songs, type, source, link, error }
};

// 验音质:对真实下载源发探测请求,拿真实大小与码率(沿用 /music/inspect)
export const inspectQuality = async (song) => {
  const s = normalizeSong(song);
  const params = new URLSearchParams();
  params.set('id', s.id);
  params.set('source', s.source);
  if (s.duration) params.set('duration', s.duration);
  if (s.extra) params.set('extra', typeof s.extra === 'string' ? s.extra : JSON.stringify(s.extra));
  const { data } = await client.get(`/music/inspect?${params.toString()}`);
  return data; // { valid, url, size, bitrate }
};

// 播放/下载当前源失效时,让后端按歌名+歌手+时长寻找一个可播放的替代源。
export const switchSource = async (song, { target = '' } = {}) => {
  const s = normalizeSong(song);
  const params = new URLSearchParams();
  params.set('name', s.name || '');
  params.set('artist', s.artist || '');
  params.set('source', s.source || '');
  if (target) params.set('target', target);
  if (s.duration) params.set('duration', String(s.duration));
  const { data } = await client.get(`/music/switch_source?${params.toString()}`);
  return normalizeSong(data);
};

// 专辑详情(歌曲列表)
export const getAlbumDetail = async (id, source) => {
  const { data } = await client.get(`/api/v1/album?id=${encodeURIComponent(id)}&source=${encodeURIComponent(source)}`);
  return withSongs(data); // { songs, type, source, link, error }
};

// 歌词(纯文本 LRC,沿用 /music/lyric)
export const getLyric = async (song) => {
  const s = normalizeSong(song);
  const params = new URLSearchParams();
  params.set('id', s.id);
  params.set('source', s.source);
  params.set('name', s.name || '');
  params.set('artist', s.artist || '');
  const { data } = await client.get(`/music/lyric?${params.toString()}`, { responseType: 'text' });
  return data;
};

// 构造下载/播放链接(沿用 go-music-dl 现有的干净 /music/download 接口)。
// stream=1 用于在线播放(<audio src>);否则触发下载(可选 embed 写入元数据)。
const buildDownloadParams = (song, extra = {}) => {
  const s = normalizeSong(song);
  const params = new URLSearchParams();
  params.set('id', s.id);
  params.set('source', s.source);
  params.set('name', s.name || '');
  params.set('artist', s.artist || '');
  if (s.album) params.set('album', s.album);
  if (s.cover) params.set('cover', s.cover);
  if (s.extra) {
    const extraValue = typeof s.extra === 'string' ? s.extra : JSON.stringify(s.extra);
    if (extraValue && extraValue !== '{}' && extraValue !== 'null') params.set('extra', extraValue);
  }
  Object.entries(extra).forEach(([k, v]) => params.set(k, v));
  return params.toString();
};

// 在线播放 URL(流式)
export const getStreamUrl = (song) =>
  `${API_BASE}/music/download?${buildDownloadParams(song, { stream: '1' })}`;

// 锁屏连续播放分块：后端统一输出可独立重试、可追加到同一 MediaSource 的
// FLAC/fMP4 短块。与普通 stream URL 分开，避免不支持 MSE 的浏览器受到影响。
export const getPlaybackSegmentUrl = (song, chunkIndex = 0) =>
  `${API_BASE}/music/playback_segment?${buildDownloadParams(song, { chunk: String(chunkIndex) })}`;

// 直接下载 URL(浏览器下载;embed=1 写入 ID3 元数据与封面)
export const getDownloadUrl = (song) =>
  `${API_BASE}/music/download?${buildDownloadParams(song, { embed: '1' })}`;

// 下载到服务器(NAS):存到后端 data/downloads,带完整刮削(embed),本地音乐库可见。
// 后端 download 用 c.Query 读参数(走 URL),且要求 POST + 同源 + X-Requested-With(防 CSRF)。
export const saveToServer = async (song, { expectedUserId } = {}) => {
  const qs = buildDownloadParams(song, { embed: '1', save_local: '1' });
  const headers = { 'X-Requested-With': 'XMLHttpRequest' };
  if (Number(expectedUserId) > 0) {
    // 仅用于让后端确认“当前会话仍是批次启动用户”，后端不会据此选择归属。
    headers['X-Melodex-Expected-User-ID'] = String(expectedUserId);
  }
  const { data } = await client.post(`/music/download?${qs}`, null, {
    headers,
  });
  if (serverSaveSucceeded(data)) {
    notifyServerDownloadsChanged({
      action: 'saved',
      song: normalizeSong(song),
      userId: data.recorded_user_id,
    });
  }
  return data; // { status:'ok', saved:true, recorded:true, recorded_user_id, path, filename, warning? }
};

export const apiBase = API_BASE;

// 封面代理 URL:封面源站常有防盗链 + 网易封面是 http(生产 https 会被浏览器拦混合内容),
// 故统一走后端 cover_proxy(带 referer + 磁盘缓存)。无 cover 返回空串(前端显占位)。
// 例外:本地音乐封面是站内相对路径(/music/local_music/cover?id=...),直接用原路径,
// 不能套 cover_proxy——cover_proxy 的 isPublicHTTPURL 会拒绝站内/相对 URL(SSRF 防护)返 403。
export const coverProxyUrl = (song) => {
  const s = normalizeSong(song);
  const url = s.cover || '';
  if (!url) return '';
  // 站内相对路径(本地音乐封面)直接返回,拼上 API_BASE 即可。
  if (url.startsWith('/')) return `${API_BASE}${url}`;
  const src = s.source || '';
  return `${API_BASE}/music/cover_proxy?url=${encodeURIComponent(url)}${src ? `&source=${encodeURIComponent(src)}` : ''}`;
};

// 后端管理员登录/初始化页(原版 HTMX 页面)。敏感接口需先在此登录。
export const adminSetupUrl = `${API_BASE}/music/setup`;
export const adminLoginUrl = `${API_BASE}/music/login`;

// 标记鉴权错误,供 Settings 页给出清晰引导而非笼统“失败”。
export class AuthRequiredError extends Error {
  constructor(setupRequired) {
    super(setupRequired ? '需要先初始化管理员账号' : '需要先登录管理员账号');
    this.name = 'AuthRequiredError';
    this.setupRequired = !!setupRequired;
  }
}

// 把敏感接口的 401 统一转成 AuthRequiredError
const callSecure = async (fn) => {
  try {
    return await fn();
  } catch (e) {
    if (e?.response?.status === 401) {
      throw new AuthRequiredError(e.response.data?.setupRequired);
    }
    throw e;
  }
};

// ===== 多用户鉴权 / 账号管理 / 个人偏好 =====

// 当前登录用户 → { user:{id,username,role,disabled,created_at}, allowRegistration, setupRequired?, desktop? }
// 未登录返回 { authenticated:false, setupRequired?, allowRegistration }。
export const getMe = async () => {
  try {
    const { data } = await client.get('/api/v1/me');
    return { authenticated: true, ...data };
  } catch (e) {
    if (e?.response?.status === 401) {
      return {
        authenticated: false,
        setupRequired: !!e.response.data?.setupRequired,
        allowRegistration: !!e.response.data?.allowRegistration,
      };
    }
    throw e;
  }
};

// 初始化首个管理员 → { user }。setupToken 为服务启动终端打印的一次性令牌。
export const setupAdmin = async (username, password, setupToken) => {
  const { data } = await client.post('/api/v1/auth/setup', { username, password, setup_token: setupToken });
  return data;
};

// 登录 → { user }
export const login = async (username, password) => {
  const { data } = await client.post('/api/v1/auth/login', { username, password });
  return data;
};

// 自助注册(需后端开放)→ { user }
export const register = async (username, password) => {
  const { data } = await client.post('/api/v1/auth/register', { username, password });
  return data;
};

// 登出
export const logout = async () => {
  const { data } = await client.post('/api/v1/auth/logout');
  return data;
};

// 个人展示偏好(浮动歌词/每页条数)。返回合并后的完整 settings。
export const saveUserPrefs = async (prefs) => {
  const { data } = await client.post('/music/user/prefs', prefs, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });
  return data;
};

// ===== 搜索历史(按用户隔离,仅登录) =====

export const getSearchHistory = async () => {
  try {
    const { data } = await client.get('/music/search_history');
    return data.history || [];
  } catch {
    return []; // 未登录/出错时静默返回空,不打断搜索页
  }
};

// 删除单条(传 keyword)或清空(不传)
export const clearSearchHistory = async (keyword) => {
  const qs = keyword ? `?keyword=${encodeURIComponent(keyword)}` : '';
  await client.delete(`/music/search_history${qs}`, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });
};

// ===== 播放历史(最近播放,按用户隔离,仅登录,封顶 500 条) =====

// 记一次播放(播放器开始播放时 fire-and-forget 调用)。失败不打断播放。
export const recordPlayHistory = async (song) => {
  const payload = songWritePayload(song);
  if (!payload.id || !payload.source) return;
  try {
    await client.post('/music/play_history', payload, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  } catch (err) {
    console.warn('记录播放历史失败', err);
  }
};

// 锁屏续播的低频诊断事件。仅记录音频状态与歌曲 ID，失败不影响播放。
export const reportPlaybackDiagnostic = async (payload) => {
  try {
    await client.post('/music/playback_diagnostics', payload, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      timeout: 5000,
    });
  } catch (err) {
    // 诊断通道不可反向干扰播放器，但保留控制台证据便于定位服务端拒绝原因。
    console.debug('播放诊断上报失败', err);
  }
};

// 取最近播放列表(按 played_at 降序)。
export const getPlayHistory = async () => {
  try {
    const { data } = await client.get('/music/play_history');
    return normalizeSongs(data.history || []);
  } catch {
    return [];
  }
};

// 删除单条(传 song:id+source)或清空(不传)。
export const clearPlayHistory = async (song) => {
  const qs = song && song.id && song.source
    ? `?id=${encodeURIComponent(song.id)}&source=${encodeURIComponent(song.source)}`
    : '';
  await client.delete(`/music/play_history${qs}`, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });
};

// ===== 收藏(「我喜欢」歌单,按用户隔离) =====

const favoriteStatusBatch = {
  timer: null,
  queue: new Map(),
};

const favoritePairKey = (song) => `${song.source}\u001f${song.id}`;

const flushFavoriteStatusBatch = async () => {
  const entries = Array.from(favoriteStatusBatch.queue.values());
  favoriteStatusBatch.queue.clear();
  favoriteStatusBatch.timer = null;
  if (!entries.length) return;

  const runChunk = async (chunk) => {
    const { data } = await client.post('/music/favorites/status_batch', {
      songs: chunk.map((entry) => songWritePayload(entry.song)),
    }, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    const statusByKey = new Map();
    (data.statuses || []).forEach((item) => {
      statusByKey.set(`${item.source}\u001f${item.id}`, !!item.favorited);
    });
    chunk.forEach((entry) => {
      const favorited = statusByKey.get(favoritePairKey(entry.song)) || false;
      entry.resolve(favorited);
    });
  };

  try {
    for (let i = 0; i < entries.length; i += 500) {
      await runChunk(entries.slice(i, i + 500));
    }
  } catch (err) {
    entries.forEach((entry) => entry.reject(err));
  }
};

// 查某歌是否已收藏 → bool
export const getFavoriteStatus = async (song) => {
  const s = normalizeSong(song);
  if (!s.id || !s.source) return false;
  return new Promise((resolve, reject) => {
    const key = favoritePairKey(s);
    const existing = favoriteStatusBatch.queue.get(key);
    if (existing) {
      existing.resolve = ((prevResolve) => (value) => {
        prevResolve(value);
        resolve(value);
      })(existing.resolve);
      existing.reject = ((prevReject) => (err) => {
        prevReject(err);
        reject(err);
      })(existing.reject);
    } else {
      favoriteStatusBatch.queue.set(key, { song: s, resolve, reject });
    }
    if (!favoriteStatusBatch.timer) {
      favoriteStatusBatch.timer = globalThis.setTimeout(flushFavoriteStatusBatch, 25);
    }
  }).catch(() => false);
};

// 切换收藏(有则取消/无则加)→ 返回切换后的 bool
export const toggleFavorite = async (song) => {
  const { data } = await client.post('/music/favorites/toggle', songWritePayload(song), { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  return !!data.favorited;
};

// ===== 用户管理(仅管理员) =====

export const adminListUsers = async () =>
  callSecure(async () => {
    const { data } = await client.get('/api/v1/admin/users');
    return data; // { users:[], allowRegistration }
  });

export const adminCreateUser = async (username, password, role) =>
  callSecure(async () => {
    const { data } = await client.post('/api/v1/admin/users', { username, password, role });
    return data;
  });

export const adminSetUserRole = async (id, role) =>
  callSecure(async () => {
    const { data } = await client.put(`/api/v1/admin/users/${id}/role`, { role });
    return data;
  });

export const adminSetUserDisabled = async (id, disabled) =>
  callSecure(async () => {
    const { data } = await client.put(`/api/v1/admin/users/${id}/disabled`, { disabled });
    return data;
  });

export const adminResetPassword = async (id, password) =>
  callSecure(async () => {
    const { data } = await client.put(`/api/v1/admin/users/${id}/password`, { password });
    return data;
  });

export const adminDeleteUser = async (id) =>
  callSecure(async () => {
    const { data } = await client.delete(`/api/v1/admin/users/${id}`);
    return data;
  });

export const adminSetRegistration = async (allow) =>
  callSecure(async () => {
    const { data } = await client.put('/api/v1/admin/registration', { allow });
    return data;
  });

// ===== 二维码登录 / Cookie 管理 / 本地音乐 =====

export const getQRSources = async () => {
  const { data } = await client.get('/api/v1/qr_login/sources');
  const qrSources = data.sources || [];
  const cookieSources = data.cookie_sources || qrSources;
  const seen = new Set();
  return [...cookieSources, ...qrSources]
    .filter((source) => {
      if (seen.has(source)) return false;
      seen.add(source);
      return true;
    })
    .map((source) => ({ source, qr: qrSources.includes(source) }));
};

// 创建二维码登录会话 → { source, key, url, image_url }
export const createQRLogin = async (source) =>
  callSecure(async () => {
    const { data } = await client.post(`/api/v1/qr_login/${encodeURIComponent(source)}`);
    return data;
  });

// 轮询登录状态 → { status, cookie, ... }  status: waiting/scanned/success/expired/failed
export const checkQRLogin = async (source, key) =>
  callSecure(async () => {
    const { data } = await client.get(`/api/v1/qr_login/${encodeURIComponent(source)}?key=${encodeURIComponent(key)}`);
    return data;
  });

// 各源登录状态 → { loggedIn, details }; details 不含 Cookie 明文
export const getCookieStatus = async () =>
  callSecure(async () => {
    const { data } = await client.get('/api/v1/cookies?verify=1');
    return {
      loggedIn: data.logged_in || {},
      details: data.details || {},
    };
  });

// 退出某源登录
export const clearCookie = async (source) =>
  callSecure(async () => {
    const { data } = await client.delete(`/api/v1/cookies/${encodeURIComponent(source)}`);
    return data;
  });

// 手动填入某源 cookie(扫码拿不到完整鉴权字段时,如 QQ 音乐的 qm_keyst)
export const setCookie = async (source, cookie) =>
  callSecure(async () => {
    const { data } = await client.post(`/api/v1/cookies/${encodeURIComponent(source)}`, { cookie });
    return data;
  });

// 本地音乐列表(沿用 /music/local_music)
export const getLocalMusic = async ({ offset = 0, limit = 100, refresh = false } = {}) => {
  const params = new URLSearchParams();
  params.set('offset', offset);
  params.set('limit', limit);
  if (refresh) params.set('refresh', '1');
  const { data } = await client.get(`/music/local_music?${params.toString()}`);
  return withSongs(data, 'tracks'); // { download_dir, exists, tracks, total, has_more, ... }
};

// 当前用户可见、且服务器磁盘上仍存在的下载记录。
// 用于刷新/重新进入网页后恢复 SongRow 的“服务器”状态。
export const getServerDownloads = async () => {
  const { data } = await client.get('/music/downloads');
  return data; // { downloads:[{source,song_id,name,artist,rel_path,downloaded_at}], total }
};

// 删除本地音乐
export const deleteLocalMusic = async (id) => {
  const { data } = await client.delete(`/music/local_music?id=${encodeURIComponent(id)}`);
  notifyServerDownloadsChanged({ action: 'refresh' });
  return data;
};

// 上传本地音乐文件(multipart),返回 { status, track }
export const uploadLocalMusic = async (file) => {
  const form = new FormData();
  form.append('file', file);
  const { data } = await client.post('/music/local_music/upload', form, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });
  notifyServerDownloadsChanged({ action: 'refresh' });
  return data;
};
