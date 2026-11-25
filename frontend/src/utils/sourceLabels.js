const SOURCE_LABELS = {
  netease: '网易云音乐',
  qq: 'QQ音乐 · 强凭证',
  qq_mobile: 'QQ音乐 · 客户端入口',
  qq_connect: 'QQ音乐 · 旧入口',
  qq_wx: 'QQ音乐 · 微信入口',
  kugou: '酷狗音乐',
  kuwo: '酷我音乐',
  migu: '咪咕音乐',
  qianqian: '千千音乐',
  bilibili: '哔哩哔哩',
  soda: '汽水音乐',
  local: '本地音乐',
};

// 短名:手机端列表里用来标识"这条来自哪个平台"。
//
// 为什么需要单独一套:全称里有「QQ音乐 · 强凭证」这种 11 个字的说明,
// 在 375px 的搜索结果行里会和歌手/音质徽章抢宽度,把行挤成 3~4 行。
// 短名只要 2~4 个字,同时**不丢失"哪个平台"这个关键信息**。
// 注意这不是省略号截断 —— 截断会得到「QQ音乐 · …」这种看不出差别的结果。
const SOURCE_SHORT_LABELS = {
  netease: '网易',
  qq: 'QQ',
  qq_mobile: 'QQ',
  qq_connect: 'QQ',
  qq_wx: 'QQ',
  kugou: '酷狗',
  kuwo: '酷我',
  migu: '咪咕',
  qianqian: '千千',
  bilibili: 'B站',
  soda: '汽水',
  local: '本地',
};

export const sourceLabel = (source) => {
  if (!source) return '';
  const key = String(source).trim().toLowerCase();
  return SOURCE_LABELS[key] || source;
};

/**
 * 平台短名（手机端列表用）。未知源回退到原名，绝不返回空 ——
 * 空字符串会让用户以为"这条没有来源"，而实际上是有源只是没登记。
 */
export const sourceShortLabel = (source) => {
  if (!source) return '';
  const key = String(source).trim().toLowerCase();
  return SOURCE_SHORT_LABELS[key] || sourceLabel(source);
};

export default SOURCE_LABELS;
