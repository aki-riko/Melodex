// 播放失败原因头(纯函数,无 axios/浏览器依赖 → 可被 Node 契约测试直接 import)。
//
// 为什么需要这段编解码(2026-11-23 用户截图真实事故):
// 播放条出现 `「一万零一次沉溺」å½åæé³ä¹æº...，正在自动换源…`, 只有中间那段是乱码。
// 根因: 后端把中文原因直接写进 HTTP 响应头 X-Melodex-Playback-Reason。按 Fetch 规范,
// 响应头是**字节序列**, headers.get() 做的是「一个字节 → 一个码点」的同构解码,
// 不按 UTF-8 解码。于是「当」的 UTF-8 字节 e5 bd 93 被读成 U+00E5 U+00BD U+0093,
// 显示成 å½。同一句里由 JS 模板字符串拼的部分显示正常 —— 这就是本 bug 的指纹。
//
// 约定: 后端写入该头前做百分号编码(纯 ASCII), 前端读回后在这里解码。
// 必须容忍两种情况:
//   1. 旧后端/未编码的纯 ASCII 原因(如 "播放失败") —— decodeURIComponent 不改变它;
//   2. 已经烂掉的 latin1 同构乱码(例如用户端缓存的旧响应) —— 不抛错,原样返回,
//      绝不因为解码失败把整条提示丢掉变成空白。

// 判断一个字符串是否像「UTF-8 字节被当作 latin1 逐字节解码」产生的乱码。
// 判据: 出现 U+0080..U+00FF 的字符, 且按 latin1 编码回字节后能成功按 UTF-8 解码,
// 且解码结果里含中文。只用于兼容旧数据, 不用于正常路径。
const looksLikeMojibake = (value) => {
  if (typeof value !== 'string' || value === '') return false;
  // 只有全部码点 <= 0xFF 才可能是 latin1 同构解码的产物
  for (const ch of value) {
    if (ch.codePointAt(0) > 0xff) return false;
  }
  let hasHighByte = false;
  for (const ch of value) {
    if (ch.codePointAt(0) >= 0x80) { hasHighByte = true; break; }
  }
  if (!hasHighByte) return false;
  try {
    const bytes = Uint8Array.from(Array.from(value, (ch) => ch.codePointAt(0)));
    const repaired = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // 必须是真正的中文,否则宁可不改(避免把正常西文音译改坏)
    return /[\u4e00-\u9fff]/.test(repaired);
  } catch {
    return false;
  }
};

// 把乱码按「latin1 字节 → UTF-8」还原。失败返回原值。
const repairMojibake = (value) => {
  if (!looksLikeMojibake(value)) return value;
  try {
    const bytes = Uint8Array.from(Array.from(value, (ch) => ch.codePointAt(0)));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return value;
  }
};

// 读取并还原后端带来的播放失败原因。返回 '' 表示后端没给原因(调用方回退通用文案)。
export const decodePlaybackReason = (raw) => {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // 先按百分号编码解(后端 encodePlaybackReasonHeader 的对应端)。
  // 纯 ASCII 未编码原因不含 %XX, decode 后原样不变。
  let decoded = trimmed;
  if (trimmed.includes('%')) {
    try {
      decoded = decodeURIComponent(trimmed);
    } catch {
      decoded = trimmed;
    }
  }
  // 兼容旧响应:若仍是 latin1 同构乱码,就地还原,避免用户继续看到 å½。
  return repairMojibake(decoded);
};

// 供契约测试使用
export const __test = { looksLikeMojibake, repairMojibake };
