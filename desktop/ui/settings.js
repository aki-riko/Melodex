// 桌面歌词设置页。
//
// 6 项与旧 PrismQML 实现（desktop-prismqml/qml/pages/SettingsPage.qml:44-122）逐项对齐：
//   显示桌面歌词 / 锁定桌面歌词 / 字体预设 / 歌词字号 / 配色方案 / 桌面歌词位置
//
// 设置的唯一真相源在 Rust 侧（`lyrics_settings.rs`），本页只负责渲染与提交补丁。
// 提交 `lyrics_settings_update` 时只带**改动的那个字段**，其它字段由壳侧保留。

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const SETTINGS_EVENT = 'melodex:lyrics-settings';

const visibleToggle = document.getElementById('setting-visible');
const lockedToggle = document.getElementById('setting-locked');
const fontSelect = document.getElementById('setting-font');
const sizeRange = document.getElementById('setting-size');
const sizeLabel = document.getElementById('font-size-label');
const colorSelect = document.getElementById('setting-color');
const positionLabel = document.getElementById('position-label');
const resetButton = document.getElementById('reset-position');
const feedback = document.getElementById('feedback');

/** 当前设置快照，供「同值不重复提交」判断。 */
let current = null;
/** 防止程序化写控件值时触发 change 事件造成回环。 */
let suppressEvents = false;

const setFeedback = (message, type = '') => {
  feedback.textContent = message || '';
  feedback.className = `feedback ${type}`.trim();
};

const describePosition = (settings) => {
  if (!settings.position_set) return '解锁后拖动歌词窗口即可自动保存';
  return `已保存到 ${settings.position_x}, ${settings.position_y}`;
};

/** 渲染一份设置快照到全部控件。 */
const render = (settings) => {
  if (!settings) return;
  current = settings;
  suppressEvents = true;

  visibleToggle.checked = Boolean(settings.visible);
  lockedToggle.checked = Boolean(settings.click_through);

  // 选项清单来自壳侧，避免 JS 再抄一份清单（两份必然分叉）。
  if (fontSelect.options.length === 0) {
    for (const item of settings.font_presets || []) {
      const option = document.createElement('option');
      option.value = item.name;
      option.textContent = `${item.name}（${item.family}）`;
      option.style.fontFamily = `"${item.family}", sans-serif`;
      fontSelect.appendChild(option);
    }
  }
  if (colorSelect.options.length === 0) {
    for (const item of settings.color_schemes || []) {
      const option = document.createElement('option');
      option.value = item.name;
      option.textContent = item.name;
      colorSelect.appendChild(option);
    }
  }

  fontSelect.value = settings.font_preset;
  colorSelect.value = settings.color_scheme;

  sizeRange.min = String(settings.font_size_min ?? 20);
  sizeRange.max = String(settings.font_size_max ?? 64);
  sizeRange.value = String(settings.font_size);
  sizeLabel.textContent = `当前 ${settings.font_size} px`;

  positionLabel.textContent = describePosition(settings);

  suppressEvents = false;
};

/** 提交局部更新。失败时如实提示，并把控件恢复成壳侧的真实状态。 */
const commit = async (patch, successMessage) => {
  try {
    const updated = await invoke('lyrics_settings_update', { patch });
    render(updated);
    if (successMessage) setFeedback(successMessage, 'success');
  } catch (error) {
    console.warn('保存歌词设置失败', error);
    setFeedback(`保存失败：${error}`, 'error');
    // 重新拉一次真实状态，避免界面停留在未保存的值上。
    try {
      render(await invoke('lyrics_settings_get'));
    } catch (reloadError) {
      console.warn('重新读取歌词设置失败', reloadError);
    }
  }
};

// ---------- 事件 ----------

visibleToggle.addEventListener('change', () => {
  if (suppressEvents) return;
  commit({ visible: visibleToggle.checked }, visibleToggle.checked ? '已显示桌面歌词' : '已关闭桌面歌词');
});

lockedToggle.addEventListener('change', () => {
  if (suppressEvents) return;
  commit(
    { click_through: lockedToggle.checked },
    lockedToggle.checked ? '已锁定（鼠标穿透）' : '已解锁，可拖动歌词窗口',
  );
});

fontSelect.addEventListener('change', () => {
  if (suppressEvents) return;
  commit({ font_preset: fontSelect.value }, `字体已切换为 ${fontSelect.value}`);
});

// 滑块拖动过程中会连续触发 input；用 rAF 节流，避免每一步都写盘与广播。
let pendingSize = null;
let sizeFrame = 0;
const flushSize = () => {
  sizeFrame = 0;
  if (pendingSize == null) return;
  const value = pendingSize;
  pendingSize = null;
  commit({ font_size: value });
};

sizeRange.addEventListener('input', () => {
  if (suppressEvents) return;
  const value = Number(sizeRange.value);
  sizeLabel.textContent = `当前 ${value} px`;
  pendingSize = value;
  if (!sizeFrame) sizeFrame = window.requestAnimationFrame(flushSize);
});

sizeRange.addEventListener('change', () => {
  if (suppressEvents) return;
  // 松手立刻落盘，不等下一帧，保证即使快速关闭窗口也已保存。
  pendingSize = Number(sizeRange.value);
  if (sizeFrame) {
    window.cancelAnimationFrame(sizeFrame);
    sizeFrame = 0;
  }
  flushSize();
});

colorSelect.addEventListener('change', () => {
  if (suppressEvents) return;
  commit({ color_scheme: colorSelect.value }, `配色已切换为 ${colorSelect.value}`);
});

resetButton.addEventListener('click', async () => {
  resetButton.disabled = true;
  try {
    const updated = await invoke('lyrics_reset_position');
    render(updated);
    setFeedback('位置已重置为默认', 'success');
  } catch (error) {
    console.warn('重置歌词位置失败', error);
    setFeedback(`重置失败：${error}`, 'error');
  } finally {
    resetButton.disabled = false;
  }
});

// 别的窗口（歌词窗按钮、托盘）改了设置时同步本页控件。
//
// ★ listen() 返回 Promise 且**可能 reject**（ACL 未授予 core:event:allow-listen、
//   或事件运行时未就绪）。不接住就是一条 unhandled rejection：GUI 应用没有
//   可见控制台，表现成「设置页永远不随托盘/歌词窗变化」，而日志里什么都没有。
//   同类事故本项目已经踩过一次（见 AGENTS.md 里 lyrics_send_command 授错窗口那段）。
listen(SETTINGS_EVENT, (event) => render(event.payload)).catch((error) => {
  console.warn(`订阅桌面歌词设置同步失败: ${SETTINGS_EVENT}`, error);
});

// ---------- 启动 ----------

const load = async () => {
  try {
    render(await invoke('lyrics_settings_get'));
  } catch (error) {
    console.warn('读取歌词设置失败', error);
    setFeedback(`读取设置失败：${error}`, 'error');
  }
};

load();
