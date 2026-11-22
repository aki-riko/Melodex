// 全屏播放页「舞台」的展示偏好纯逻辑 —— 无 React、无 DOM,便于 Node 契约测试直接 import。
//
// 为什么单独抽出来:PlayerContext.js 已经 2500 行,而这两种偏好恰好是
// 「写错了构建不报错、只是界面不对」的一类 —— 默认值、存储损坏兜底、三档循环、
// 「这一档到底显不显示歌词」这类判断,靠肉眼看代码很容易漏。
//
// ---- 两件事,各自独立 ----
//   布局三档:disc(唱片)/ lyrics(歌词)/ split(双栏)
//   色板两档:immersive(沉浸暗场)/ theme(跟随当前主题)
//
// 都是**按设备**的展示偏好,所以与音量/播放模式一样落 localStorage,
// 不进后端 user_prefs(那是跨设备同步的偏好,混在一起会让"我只在这台电脑上
// 想沉浸一点"变成全局行为)。

export const STAGE_LAYOUTS = ['disc', 'lyrics', 'split'];
export const STAGE_TONES = ['immersive', 'theme'];

export const STAGE_LAYOUT_KEY = 'melodex_stage_layout';
export const STAGE_TONE_KEY = 'melodex_stage_tone';

/** 界面上给人看的中文名。布局/色板各一份,组件只读这里,不再各写一套。 */
export const STAGE_LAYOUT_LABELS = { disc: '唱片', lyrics: '歌词', split: '双栏' };
export const STAGE_TONE_LABELS = { immersive: '沉浸暗场', theme: '跟随主题' };

/**
 * 首次打开的默认布局。
 * 桌面与手机的原生习惯不同:桌面过去就是「唱片 + 歌词」双栏,手机过去是唱片。
 * 所以默认值按断点分,而不是强行统一 —— 统一会让一端第一次打开就"不像原来那个应用"。
 * 断点与全站一致:lg = 1024px。
 */
export const defaultStageLayout = (desktop) => (desktop ? 'split' : 'disc');

/** 色板默认沉浸暗场:音乐播放页的常态是暗场(用户要的就是"沉浸式")。 */
export const defaultStageTone = () => 'immersive';

/** 非法布局一律收敛到该设备的默认值,绝不返回空(空会让 data 属性丢失、界面塌成一列)。 */
export const normalizeStageLayout = (value, desktop) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return STAGE_LAYOUTS.includes(text) ? text : defaultStageLayout(desktop);
};

export const normalizeStageTone = (value) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return STAGE_TONES.includes(text) ? text : defaultStageTone();
};

/** 这一档布局里歌词区是否可见。自动滚动/挂载判断都读它,不要各处再写一遍 === 判断。 */
export const stageShowsLyrics = (layout) => layout === 'lyrics' || layout === 'split';

/** 色板切换:两档来回切,未知值视为沉沉浸(默认档)。 */
export const stageToneNext = (tone) => (normalizeStageTone(tone) === 'immersive' ? 'theme' : 'immersive');

/**
 * 当前视口算不算"宽屏"(与全站 lg 断点一致:1024px)。
 *
 * 为什么不用 window.innerWidth:播放页首次挂载时可能处在过渡动画/隐藏容器里,
 * matchMedia 直接读的是媒体查询结果,与 CSS 里 `min-width: 1024px` 完全同一判据。
 * 非浏览器环境(契约测试)按宽屏处理 —— 宽屏默认是"双栏",校验默认值最直观。
 */
export const isWideViewport = (matchMedia = typeof globalThis !== 'undefined' ? globalThis.matchMedia : undefined) => {
  if (typeof matchMedia !== 'function') return true;
  try {
    return Boolean(matchMedia('(min-width: 1024px)').matches);
  } catch {
    return true;
  }
};

/** 取 localStorage;无痕/禁用存储时访问 getter 本身就可能抛,所以统一走这里。 */
export const safeStorage = (target = typeof window !== 'undefined' ? window : null) => {
  try {
    return target ? target.localStorage : null;
  } catch {
    return null;
  }
};

/** 切换按钮上的动作文案(读屏与鼠标悬停共用)。 */
export const stageToneActionLabel = (tone) => (
  tone === 'immersive' ? '切换为跟随主题' : '切换为沉浸暗场'
);

const readStored = (storage, key) => {
  try {
    if (!storage || typeof storage.getItem !== 'function') return null;
    return storage.getItem(key);
  } catch {
    // ignore-on-purpose: 无痕/禁用存储时读不到,回落默认即可,不能阻断播放页渲染
    return null;
  }
};

export const readStageLayout = (storage, desktop) => normalizeStageLayout(
  readStored(storage, STAGE_LAYOUT_KEY),
  desktop,
);

export const readStageTone = (storage) => normalizeStageTone(readStored(storage, STAGE_TONE_KEY));

/**
 * 写入一个偏好。写失败只代表"下次启动回到默认",当前会话仍然生效,
 * 所以吞掉异常并返回本次要用的值(调用方拿返回值做 state 也没问题)。
 */
export const persistStagePref = (storage, key, value) => {
  try {
    if (storage && typeof storage.setItem === 'function') storage.setItem(key, value);
  } catch {
    // ignore-on-purpose: 配额满/无痕模式下写不进去,不影响当前会话
  }
  return value;
};
