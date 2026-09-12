// 逐字歌词(extra.lyric)是纯展示字段:前端/桌面在发请求前就直接消费它,
// 播放/下载/歌词 URL 从来不需要携带。整首 LRC(尤其 QQ 逐字 QRC)可达几十 KB,
// 一旦序列化进查询串,请求行会超过反向代理(Nginx large_client_header_buffers)
// 的上限,连接在代理层被直接重置:浏览器只会看到 "Failed to fetch",后端与
// 代理访问日志里都不留任何记录,表现为"点播放完全没反应"。
// 因此所有把 song.extra 拼进 URL 的路径必须先经过本模块剔除重字段。
export const URL_HEAVY_EXTRA_KEYS = ['lyric'];

const isPlainObject = (value) => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const stripHeavyKeys = (extra) => {
  const cleaned = {};
  let removed = false;
  Object.entries(extra).forEach(([key, value]) => {
    if (URL_HEAVY_EXTRA_KEYS.includes(key)) {
      removed = true;
      return;
    }
    cleaned[key] = value;
  });
  return { cleaned, removed };
};

// 返回可安全放入查询串的 extra 字符串;无内容时返回空串(调用方据此省略参数)。
export const urlSafeExtraValue = (extra) => {
  if (extra == null || extra === '') return '';
  if (isPlainObject(extra)) {
    const { cleaned, removed } = stripHeavyKeys(extra);
    if (!removed) {
      const direct = JSON.stringify(extra);
      return (direct && direct !== '{}' && direct !== 'null') ? direct : '';
    }
    if (!Object.keys(cleaned).length) return '';
    const serialized = JSON.stringify(cleaned);
    return serialized === '{}' ? '' : serialized;
  }
  if (typeof extra === 'string') {
    const trimmed = extra.trim();
    if (!trimmed) return '';
    // 字符串形态的 extra(历史数据/直接透传)也可能内嵌歌词,尝试解析后剔除。
    if (URL_HEAVY_EXTRA_KEYS.some((key) => trimmed.includes(`"${key}"`))) {
      try {
        const parsed = JSON.parse(trimmed);
        if (isPlainObject(parsed)) {
          const { cleaned, removed } = stripHeavyKeys(parsed);
          if (removed) {
            if (!Object.keys(cleaned).length) return '';
            const serialized = JSON.stringify(cleaned);
            return serialized === '{}' ? '' : serialized;
          }
        }
      } catch {
        // 非法 JSON 时保持原样透传,不改变既有行为。
      }
    }
    return trimmed === '{}' || trimmed === 'null' ? '' : trimmed;
  }
  return JSON.stringify(extra);
};
