// 全屏播放页「舞台」的展示偏好纯逻辑 —— 无 React、无 DOM,便于 Node 契约测试直接 import。
//
// ---- 现状(2026-11 用户要求):只剩一件事 ----
//   色板两档:immersive(沉浸暗场)/ theme(跟随当前主题)
//
// ★ 布局档位(原「沉浸 / 歌词 / 封面」三档切换)**已整体移除**:
//   用户圈出顶栏那两颗并明确要求「播放页移除红框的这俩样式」,选择的是
//   「只留沉浸一档」。现在播放页恒定是沉浸档 —— 整屏封面当背景 + 右侧歌词面板,
//   顶栏不再有布局切换控件(只留右侧那颗色板按钮)。
//
//   · 老用户 localStorage 里的 `melodex_stage_layout` **不再读取**。
//     残留值无害(不参与任何渲染),所以不做清理逻辑 —— 为了一个废弃键
//     去写迁移代码反而增加出错面。
//   · 想恢复多档:先恢复本文件里的档位清单,再恢复 PlayerStageChrome 里的
//     StageLayoutSwitch 与 index.css 的 `.player-stage--lyrics/--split` 分支,
//     三处缺一不可(playerStage.test.mjs 会盯着)。

export const STAGE_TONES = ['immersive', 'theme'];

export const STAGE_TONE_KEY = 'melodex_stage_tone';

/** 色板两档的中文名。 */
export const STAGE_TONE_LABELS = { immersive: '沉浸暗场', theme: '跟随主题' };

/** 色板默认沉浸暗场:音乐播放页的常态是暗场(用户要的就是"沉浸式")。 */
export const defaultStageTone = () => 'immersive';

/** 非法色板一律收敛到默认值,绝不返回空(空会让 data 属性丢失、界面掉回浅底)。 */
export const normalizeStageTone = (value) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return STAGE_TONES.includes(text) ? text : defaultStageTone();
};

/** 色板切换:两档来回切,未知值视为沉浸(默认档)。 */
export const stageToneNext = (tone) => (normalizeStageTone(tone) === 'immersive' ? 'theme' : 'immersive');

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
