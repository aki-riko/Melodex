const SOURCE_LABELS = {
  netease: '网易云音乐',
  qq: 'QQ音乐 · 强凭证',
  qq_mobile: 'QQ音乐 · 客户端入口',
  qq_connect: 'QQ音乐 · 旧入口',
  qq_wx: 'QQ音乐 · 微信入口',
  kugou: '酷狗音乐',
  kuwo: '酷我音乐',
  migu: '咪咕音乐',
  bilibili: '哔哩哔哩',
  soda: '汽水音乐',
  local: '本地音乐',
};

export const sourceLabel = (source) => {
  if (!source) return '';
  const key = String(source).trim().toLowerCase();
  return SOURCE_LABELS[key] || source;
};

export default SOURCE_LABELS;
