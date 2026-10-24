// 统一格式化:时长 / 文件大小 / 数字 / 相对时间。
// 历史问题:同一件事有 3 套口径并存,用户在同一个界面看到不同写法:
//   · 时长: SongRow 给 '—',mediaFormat 给英文 'N/A',播放器自己算 '75:03'(不折小时)
//   · 大小: SongRow '1.0MB'(无空格一位小数),Download '1 MB'(有空格取整),
//          OfflineMusic '0B'/'1.0MB' 第三套
//   · 日期: 只有一处用 toLocaleString,最近播放干脆不显示时间
// 这里全部收敛为中文界面口径。

/** 秒 → mm:ss,超过 1 小时 → h:mm:ss。非法值给 '—'(中文界面不用 'N/A')。 */
export function formatDuration(seconds) {
  const total = Math.round(Number(seconds));
  if (!Number.isFinite(total) || total < 0) return '—';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

/** 毫秒 → 同 formatDuration(保留旧调用点兼容)。 */
export function formatDurationMs(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '—';
  return formatDuration(value / 1000);
}

/** 字节 → '1.0 MB' / '860 KB' / '0 B'。统一:KB/MB 与数字间一个空格,KB 取整、MB 一位小数。 */
export function formatBytes(bytes, { space = true, empty = '' } = {}) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return empty;
  const sep = space ? ' ' : '';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)}${sep}GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)}${sep}MB`;
  if (value >= 1024) return `${Math.round(value / 1024)}${sep}KB`;
  return `${Math.round(value)}${sep}B`;
}

/** 千分位整数 */
export function formatCount(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) return '0';
  return value.toLocaleString('zh-CN');
}

/** 时间戳 → '今天 14:03' / '昨天 09:12' / '3月5日 14:03' */
export function formatDateTime(input) {
  if (!input) return '';
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();
  const hm = `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return `今天 ${hm}`;
  if (isYesterday) return `昨天 ${hm}`;
  const sameYear = date.getFullYear() === now.getFullYear();
  if (sameYear) return `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 码率 → '无损' / '320k' / '' */
export function formatBitrate(bitrate) {
  const value = Number(bitrate);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value >= 800) return '无损';
  return `${Math.round(value)}k`;
}
