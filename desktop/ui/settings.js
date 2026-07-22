const { invoke } = window.__TAURI__.core;

const form = document.getElementById('pair-form');
const serviceURL = document.getElementById('service-url');
const pairCode = document.getElementById('pair-code');
const pairButton = document.getElementById('pair-button');
const feedback = document.getElementById('feedback');
const deviceEmpty = document.getElementById('device-empty');
const deviceInfo = document.getElementById('device-info');
const deviceName = document.getElementById('device-name');
const deviceURL = document.getElementById('device-url');
const connectionDot = document.getElementById('connection-dot');
const clearButton = document.getElementById('clear-button');

const setFeedback = (message, type = '') => {
  feedback.textContent = message || '';
  feedback.className = `feedback ${type}`.trim();
};

const renderConfig = (config) => {
  const paired = Boolean(config?.device_id);
  deviceEmpty.hidden = paired;
  deviceInfo.hidden = !paired;
  connectionDot.classList.toggle('active', paired);
  if (!paired) return;
  deviceName.textContent = config.device_name || '桌面歌词助手';
  deviceURL.textContent = config.base_url || '';
  serviceURL.value = config.base_url || serviceURL.value;
};

const refreshConfig = async () => {
  try {
    renderConfig(await invoke('public_device_config'));
  } catch (error) {
    console.warn('读取桌面歌词助手配置失败', error);
    setFeedback(String(error), 'error');
  }
};

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  pairButton.disabled = true;
  setFeedback('正在安全配对…');
  try {
    const config = await invoke('pair_device', {
      serviceUrl: serviceURL.value,
      code: pairCode.value,
    });
    pairCode.value = '';
    renderConfig(config);
    setFeedback('配对成功。浏览器开始播放后会自动出现透明歌词。', 'success');
  } catch (error) {
    console.warn('桌面歌词助手配对失败', error);
    setFeedback(String(error), 'error');
  } finally {
    pairButton.disabled = false;
  }
});

clearButton.addEventListener('click', async () => {
  if (!window.confirm('清除本机配对后，需要在 Melodex Web 设置页重新生成配对码。继续吗？')) return;
  clearButton.disabled = true;
  try {
    await invoke('clear_pairing');
    renderConfig(null);
    setFeedback('本机配对已清除。', 'success');
  } catch (error) {
    console.warn('清除桌面歌词助手配对失败', error);
    setFeedback(String(error), 'error');
  } finally {
    clearButton.disabled = false;
  }
});

refreshConfig();
