// 音质推算(纯函数,供 SongRow 使用,带 Node 契约测试)。
//
// 背景:音质有四个可信度完全不同的来源,早先代码只用了其中一个,导致
// 「自建歌单」这类页面整列音质显示为 "—":
//   1. 验活结果(最可信):直接探测上游真实下载地址得到的码率
//   2. 服务器磁盘副本(很可信):/music/downloads 的 ext + size_bytes 来自落盘文件本身
//   3. 歌曲记录里的 ext/bitrate(不可信):上游搜索接口给的"预览值",常恒为 128
//   4. 都没有 → null,界面不显示,不要编造

export const LOSSLESS_EXT = new Set(['flac', 'wav', 'ape', 'alac', 'aiff', 'aif', 'dsf', 'dff']);
export const LOSSY_EXT = new Set(['mp3', 'm4a', 'aac', 'ogg', 'opus', 'wma']);

const normalizeExt = (value) => String(value ?? '').trim().toLowerCase().replace(/^\./, '');

// 由「码率(kbps)」给出徽章。>=800 视为无损(flac 常见 900~1400)。
export const qualityFromBitrate = (bitrate) => {
  const br = Number(bitrate) || 0;
  if (br >= 800) return { label: '无损', tone: 'lossless' };
  if (br >= 320) return { label: '高品', tone: 'high' };
  if (br > 0) return { label: `${Math.round(br)}k`, tone: 'plain' };
  return null;
};

// 来源 3:歌曲记录自带的 ext / bitrate(上游预览值)。
export const qualityFromSong = (song) => {
  const ext = normalizeExt(song?.ext);
  const byExt = qualityFromBitrate(song?.bitrate);
  if (LOSSLESS_EXT.has(ext)) return { label: '无损', tone: 'lossless' };
  return byExt;
};

// 来源 2:服务器磁盘副本。
// 无损扩展名直接判无损;有损格式用「体积 × 8 ÷ 时长」反推真实码率。
// 只有扩展名、没有体积时不编造码率,退回显示格式名(如 MP3)。
export const qualityFromServerCopy = (record, song) => {
  if (!record || typeof record !== 'object') return null;
  const ext = normalizeExt(record.ext);
  const sizeBytes = Number(record.size_bytes) || 0;
  const duration = Number(song?.duration) || 0;

  if (LOSSLESS_EXT.has(ext)) {
    return { label: '无损', tone: 'lossless', title: `服务器文件：${ext.toUpperCase()} 无损` };
  }
  if (sizeBytes > 0 && duration > 0) {
    const kbps = Math.round((sizeBytes * 8) / duration / 1000);
    if (Number.isFinite(kbps) && kbps > 0) {
      if (kbps >= 320) return { label: '高品', tone: 'high', title: `服务器文件：约 ${kbps}kbps` };
      return { label: `${kbps}k`, tone: 'plain', title: `服务器文件：约 ${kbps}kbps` };
    }
  }
  if (LOSSY_EXT.has(ext)) {
    return { label: ext.toUpperCase(), tone: 'plain', title: `服务器文件：${ext.toUpperCase()}（未取到体积）` };
  }
  return null;
};

/**
 * 按可信度挑选音质徽章。优先级:验活 > 服务器副本 > 歌曲记录。
 * @param {{state?:string, bitrateNum?:number}|null} liveInfo 验活结果
 * @param {object|null} serverCopy /music/downloads 匹配到的记录
 * @param {object} song 歌曲
 */
export const resolveQuality = (liveInfo, serverCopy, song) => {
  if (liveInfo && liveInfo.state === 'ok') {
    const br = Number(liveInfo.bitrateNum) || 0;
    if (br >= 800) return { label: '无损', tone: 'lossless', title: '真实下载音质（已验活）' };
    if (br >= 320) return { label: '高品', tone: 'high', title: '真实下载音质（已验活）' };
    if (br > 0) return { label: `${Math.round(br)}k`, tone: 'plain', title: '真实下载音质（已验活）' };
    return { label: '标准', tone: 'plain', title: '真实下载音质（已验活）' };
  }
  return qualityFromServerCopy(serverCopy, song) || qualityFromSong(song);
};

// 「这个源拿不到完整音频,必须开会员」——与"能不能播"是两个独立信号。
//
// 真实事故(2026-11-22):用户搜「遗症 格林」,列表里那条来自酷我(kuwo)的结果
// is_vip=true / extra.needs_vip="1" / is_invalid=true —— 酷我侧判定为付费曲时
// **连取址请求都不发**(省一次往返,且防止把 11 秒试听片段当整曲交付)。于是用户
// 点播放拿到 404,表现成"放不出来"。而 VIP 徽章此前是 `hidden lg:inline-flex`,
// 手机上根本看不见 —— 用户是点了之后才知道放不出。
//
// 判据取两个来源,任一命中即算:① 规范化后的 is_vip ② 上游显式写进 extra 的
// needs_vip="1"(kuwo_source.build_payload 会写)。extra 里的值可能是字符串
// "1"、数字 1 或布尔 true,统一按"非空且不等于 0/false"判定。
const flagOn = (value) => {
  if (value === true) return true;
  if (value == null) return false;
  const text = String(value).trim().toLowerCase();
  return text !== '' && text !== '0' && text !== 'false' && text !== 'no';
};

export const needsVip = (song) => {
  if (!song || typeof song !== 'object') return false;
  if (flagOn(song.is_vip)) return true;
  const extra = song.extra;
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return false;
  return flagOn(extra.needs_vip);
};

// 列表里给用户看的说明文字:为什么这条点了可能放不出、该怎么办。
export const vipHintText = '当前源需要会员才能播放完整音频，可换源或到设置里登录该平台会员';

