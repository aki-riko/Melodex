// 音量控件的纯逻辑(不碰 DOM,便于 Node 契约测试)。
//
// 背景:原先桌面端与全屏播放页各放一根**水平** `<input type="range">`,宽度被挤在
// 120/130px 里。用户反馈「要么大要么小」—— 轨道太短时每像素对应约 0.8% 音量,
// 手一抖就跨过一大段,中间档根本停不住。
//
// 现在改成「悬停弹出的垂直长条 + 滚轮微调」,所以需要三样纯计算:
//   1. 滚轮位移 → 音量步数(带累积,触控板才不会一划就飞);
//   2. 步数 → 新音量(夹到 [0,1],并抹掉浮点尾巴);
//   3. 音量 → 百分比文案。
// 抽出来是因为这些边界(累积余量、上限、NaN、deltaMode)最容易被写错,而写错的表现
// 只是"手感怪",构建和肉眼都看不出来。

/** 滚轮累计多少像素位移算走一步。Chrome 一格滚轮 deltaY≈100,即一格约 2 步。 */
export const VOLUME_WHEEL_UNIT = 40;

/** 一次滚轮事件最多走几步。触控板惯性会连发几十个事件,不封顶会瞬间拉到底。 */
export const VOLUME_WHEEL_MAX_STEPS = 2;

/** 一步的音量增量。2 步 = 10%,0→100% 约 10 格滚轮。 */
export const VOLUME_WHEEL_STEP = 0.05;

/** 悬停进入多久才弹出面板。挡掉"鼠标划过去"的误触。 */
export const VOLUME_HOVER_OPEN_DELAY_MS = 90;

/** 离开后多久收起。必须大于 0 且给足时间,否则移到面板上时会先关再开。 */
export const VOLUME_HOVER_CLOSE_DELAY_MS = 260;

/** 键盘/拖动的最小步进,与滑块的 step 属性保持一致。 */
export const VOLUME_SLIDER_STEP = 0.01;

const finiteOr = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** 夹到 [0,1]。非数字按 0 处理(audio.volume 赋 NaN 会静默失效)。 */
export const clampVolume = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
};

/** 抹掉 0.05 累加产生的浮点尾巴(0.30000000000000004 → 0.3)。 */
export const roundVolume = (value) => Math.round(clampVolume(value) * 1000) / 1000;

/**
 * 把滚轮位移归一到"像素"。
 *
 * wheel 事件的 deltaY 单位由 deltaMode 决定:0=像素、1=行、2=页。
 * Firefox 默认是行(一次滚轮 deltaY=3),不归一会比 Chrome 慢几十倍。
 * 行高按 16px、页按 400px 估算 —— 这里只需要量级正确,不需要像素级精确。
 */
export const normalizeWheelDelta = (deltaY, deltaMode = 0) => {
  const delta = finiteOr(deltaY, 0);
  switch (Number(deltaMode) || 0) {
    case 1: return delta * 16;
    case 2: return delta * 400;
    default: return delta;
  }
};

/**
 * 滚轮累积 → 步数。
 *
 * @param {number} accumulator 上次尚未走满一步的余量(像素,带符号)
 * @param {number} deltaY 本次归一后的位移(像素,向下为正)
 * @param {object} [options]
 * @returns {{steps:number, rest:number}} steps 正数=增大音量;rest 是留给下次的余量
 *
 * 两点容易写错:
 *   · 余量必须**按方向保留符号**,否则向上滚完再向下滚会立刻反向多走一步;
 *   · 超出上限的部分要丢掉而不是继续攒着,不然惯性结束时一次连跳好几格。
 */
export const wheelVolumeSteps = (accumulator, deltaY, options = {}) => {
  const unit = Math.max(1, finiteOr(options.unit, VOLUME_WHEEL_UNIT));
  const maxSteps = Math.max(1, Math.floor(finiteOr(options.maxSteps, VOLUME_WHEEL_MAX_STEPS)));
  const carried = finiteOr(accumulator, 0);
  const delta = finiteOr(deltaY, 0);

  if (delta === 0) return { steps: 0, rest: carried };

  const total = carried + delta;
  const rawSteps = Math.trunc(total / unit);
  const steps = Math.max(-maxSteps, Math.min(maxSteps, rawSteps));
  // 被上限截掉的部分直接丢弃(夹在 ±unit 内),不留给下一次。
  const rest = Math.max(-unit, Math.min(unit, total - steps * unit));
  return { steps, rest };
};

/** 步数 → 新音量。滚轮向上(deltaY<0)给正 steps。 */
export const volumeAfterSteps = (volume, steps, stepSize = VOLUME_WHEEL_STEP) =>
  roundVolume(clampVolume(volume) + finiteOr(steps, 0) * finiteOr(stepSize, VOLUME_WHEEL_STEP));

/** 垂直滑块的取值 → 百分比文案。四舍五入到整数,避免出现 63.99999%。 */
export const formatVolumePercent = (volume) => `${Math.round(clampVolume(volume) * 100)}%`;

/**
 * 图标档位:0 → 静音图标,低音量 → 单波,高音量 → 双波。
 * 阈值用 0.5 与原先一致,不趁这次改动悄悄换掉视觉语义。
 */
export const volumeIconTier = (effectiveVolume) => {
  const v = clampVolume(effectiveVolume);
  if (v <= 0) return 'muted';
  return v < 0.5 ? 'low' : 'high';
};
