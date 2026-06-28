import axios from 'axios';

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
  return data; // { songs, type, source, link, error }
};

// 验音质:对真实下载源发探测请求,拿真实大小与码率(沿用 /music/inspect)
export const inspectQuality = async (song) => {
  const params = new URLSearchParams();
  params.set('id', song.id);
  params.set('source', song.source);
  if (song.duration) params.set('duration', song.duration);
  if (song.extra) params.set('extra', JSON.stringify(song.extra));
  const { data } = await client.get(`/music/inspect?${params.toString()}`);
  return data; // { valid, url, size, bitrate }
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

// 下载到服务器(NAS):存到后端 data/downloads,带完整刮削(embed),本地音乐库可见。
// 后端 download 用 c.Query 读参数(走 URL),且要求 POST + 同源 + X-Requested-With(防 CSRF)。
export const saveToServer = async (song) => {
  const qs = buildDownloadParams(song, { embed: '1', save_local: '1' });
  const { data } = await client.post(`/music/download?${qs}`, null, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });
  return data; // { status:'ok', saved:true, path, filename, warning? }
};

export const apiBase = API_BASE;

// 封面代理 URL:封面源站常有防盗链 + 网易封面是 http(生产 https 会被浏览器拦混合内容),
// 故统一走后端 cover_proxy(带 referer + 磁盘缓存)。无 cover 返回空串(前端显占位)。
export const coverProxyUrl = (song) => {
  const url = (song && (song.cover || song.Cover)) || '';
  if (!url) return '';
  const src = (song && (song.source || song.Source)) || '';
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

// ===== 收藏(「我喜欢」歌单,按用户隔离) =====

// 查某歌是否已收藏 → bool
export const getFavoriteStatus = async (song) => {
  try {
    const { data } = await client.get(
      `/music/favorites/status?source=${encodeURIComponent(song.source)}&id=${encodeURIComponent(song.id)}`,
    );
    return !!data.favorited;
  } catch {
    return false;
  }
};

// 切换收藏(有则取消/无则加)→ 返回切换后的 bool
export const toggleFavorite = async (song) => {
  const { data } = await client.post('/music/favorites/toggle', {
    id: song.id, source: song.source, name: song.name || '',
    artist: song.artist || '', cover: song.cover || '', duration: song.duration || 0,
    extra: song.extra,
  }, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
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
  return data.sources || [];
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

// 各源登录状态 → { logged_in: { netease:true, ... } }
export const getCookieStatus = async () =>
  callSecure(async () => {
    const { data } = await client.get('/api/v1/cookies');
    return data.logged_in || {};
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
  return data; // { download_dir, exists, tracks, total, has_more, ... }
};

// 删除本地音乐
export const deleteLocalMusic = async (id) => {
  const { data } = await client.delete(`/music/local_music?id=${encodeURIComponent(id)}`);
  return data;
};
