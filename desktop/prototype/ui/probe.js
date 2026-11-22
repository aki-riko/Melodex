// 阶段 0 探针页面。只做检测与打点，不写任何持久状态。
// 结果统一通过 http://127.0.0.1:47821/report 回传给 Rust 侧日志。

const $ = (id) => document.getElementById(id);
const REPORT_URL = 'http://127.0.0.1:47821/report';

const report = (payload) => {
  try {
    fetch(REPORT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'probe-ui', ...payload }),
    }).catch(() => {});
  } catch (error) {
    console.warn('上报失败', error);
  }
};

const logTo = (el, message) => {
  const line = `${new Date().toLocaleTimeString()} ${message}`;
  el.textContent = `${line}\n${el.textContent}`.slice(0, 6000);
};

const setVerdict = (badge, verdict, text, tone) => {
  if (badge) badge.textContent = verdict;
  if (text) {
    tone.className = tone;
    tone.textContent = text;
  }
};

// ---------- 测试音频：现场合成柔和正弦波，不引入二进制资源 ----------
const buildWavBlob = (seconds, frequency) => {
  const sampleRate = 44100;
  const samples = Math.floor(sampleRate * seconds);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const writeText = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i += 1) {
    const t = i / sampleRate;
    const fadeIn = Math.min(1, t * 6);
    const fadeOut = Math.min(1, (seconds - t) * 6);
    const envelope = Math.max(0, Math.min(fadeIn, fadeOut));
    const sample = Math.sin(2 * Math.PI * frequency * t) * 0.22 * envelope;
    view.setInt16(44 + i * 2, Math.round(sample * 32767), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
};

const audio = $('r1-audio');
const r1Log = $('r1-log');
let handlersArmed = false;

const setupMediaSession = () => {
  if (!('mediaSession' in navigator)) {
    logTo(r1Log, 'navigator.mediaSession 不存在');
    report({ r1: 'mediaSession-missing' });
    return false;
  }
  if (handlersArmed) return true;
  const handlers = {
    play: () => { audio.play(); logTo(r1Log, '★ SMTC -> play handler 收到'); report({ r1: 'handler-play' }); },
    pause: () => { audio.pause(); logTo(r1Log, '★ SMTC -> pause handler 收到'); report({ r1: 'handler-pause' }); },
    previoustrack: () => { logTo(r1Log, '★ SMTC -> previoustrack handler 收到'); report({ r1: 'handler-prev' }); },
    nexttrack: () => { logTo(r1Log, '★ SMTC -> nexttrack handler 收到'); report({ r1: 'handler-next' }); },
    stop: () => { logTo(r1Log, '★ SMTC -> stop handler 收到'); report({ r1: 'handler-stop' }); },
  };
  Object.entries(handlers).forEach(([action, handler]) => {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch (error) {
      logTo(r1Log, `setActionHandler(${action}) 失败: ${error}`);
    }
  });
  try {
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: 'SMTC 探针测试音',
      artist: 'Melodex 原型',
      album: '阶段 0 验证',
      artwork: [{ src: 'icon-256.png', sizes: '256x256', type: 'image/png' }],
    });
    handlersArmed = true;
    logTo(r1Log, 'metadata 已设置, handlers 已挂载');
    report({ r1: 'metadata-set' });
  } catch (error) {
    logTo(r1Log, `设置 metadata 失败: ${error}`);
  }
  return true;
};

const playTone = async () => {
  try {
    if (!audio.dataset.ready) {
      audio.src = URL.createObjectURL(buildWavBlob(30, 220));
      audio.loop = true;
      audio.volume = 0.2;
      audio.dataset.ready = '1';
    }
    setupMediaSession();
    await audio.play();
    navigator.mediaSession.playbackState = 'playing';
    logTo(r1Log, `★ play() 成功, paused=${audio.paused}, currentTime=${audio.currentTime.toFixed(2)}`);
    report({ r1: 'playing', currentTime: audio.currentTime, duration: audio.duration || null });
    setVerdict($('r1-badge'), '播放中', '已发起播放。请用外部 SMTC 探针确认是否出现 WebView2 会话。', 'unk');
  } catch (error) {
    logTo(r1Log, `play() 失败: ${error}`);
    report({ r1: 'play-failed', error: String(error) });
    setVerdict($('r1-badge'), '不通过', `播放被拒绝: ${error}`, 'fail');
  }
};

$('r1-play').addEventListener('click', playTone);

$('r1-pause').addEventListener('click', () => {
  audio.pause();
  navigator.mediaSession.playbackState = 'paused';
  logTo(r1Log, '已暂停');
  report({ r1: 'paused' });
});

$('r1-next').addEventListener('click', () => {
  logTo(r1Log, '已请求 nexttrack（真实按键路径需手动按键盘）');
});

$('r1-auto').addEventListener('change', (event) => {
  if (event.target.checked) playTone();
  else audio.pause();
});

audio.addEventListener('playing', () => {
  navigator.mediaSession.playbackState = 'playing';
  logTo(r1Log, 'audio 事件: playing');
  report({ r1: 'event-playing' });
  if (audio.duration && Number.isFinite(audio.duration)) {
    navigator.mediaSession.setPositionState?.({
      duration: audio.duration,
      playbackRate: 1,
      position: Math.min(audio.currentTime, audio.duration),
    });
  }
});
audio.addEventListener('pause', () => {
  navigator.mediaSession.playbackState = 'paused';
  logTo(r1Log, 'audio 事件: pause');
});
audio.addEventListener('error', () => logTo(r1Log, `audio 事件: error ${audio.error?.code}`));

// ---------- R3 ----------
$('r3-check').addEventListener('click', () => {
  const info = {
    supported: 'serviceWorker' in navigator,
    secure: window.isSecureContext,
    origin: location.origin,
    controller: navigator.serviceWorker?.controller?.scriptURL || null,
  };
  logTo($('r3-log'), JSON.stringify(info, null, 2));
  report({ r3: info });
  setVerdict($('r3-badge'), info.supported ? '支持' : '不支持', '远程 origin 结果以 Rust 日志中的 REPORT_BODY kind=sw 为准。', info.supported ? 'unk' : 'fail');
});

$('r3-register').addEventListener('click', async () => {
  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    logTo($('r3-log'), `注册成功 scope=${registration.scope}`);
  } catch (error) {
    logTo($('r3-log'), `注册失败: ${error}`);
  }
});

// ---------- 环境信息 ----------
const env = {
  userAgent: navigator.userAgent,
  isSecureContext: window.isSecureContext,
  origin: location.origin,
  mediaSession: 'mediaSession' in navigator,
  mediaMetadata: 'MediaMetadata' in window,
  serviceWorker: 'serviceWorker' in navigator,
  storageEstimate: 'storage' in navigator && 'estimate' in navigator.storage,
  tauriGlobal: typeof window.__TAURI__ !== 'undefined',
  language: navigator.language,
};
$('env-log').textContent = JSON.stringify(env, null, 2);
report({ env });

// 无条件心跳：先证明「本脚本确实执行了、上报通道确实通」，
// 之后若 autoplay-result 缺失，才能判定是播放环节没走到，而不是通道坏了。
report({ r1: 'script-alive' });

if (!('mediaSession' in navigator)) {
  setVerdict($('r1-badge'), '不通过', 'navigator.mediaSession 完全不存在，R1 直接判不通过。', 'fail');
}

// 阶段 0 自动尝试：页面加载后立刻发起一次播放，用于在无人值守时观察
// WebView2 是否会建立 SMTC 会话。自动播放被策略拦截是预期可能结果之一，
// 拦截本身也会被记录，不静默吞掉。
if (new URLSearchParams(location.search).get('autoplay') !== '0') {
  setTimeout(async () => {
    try {
      await playTone();
    } catch (error) {
      report({ r1: 'autoplay-threw', error: String(error) });
    }
    setTimeout(() => {
      const state = {
        paused: audio.paused,
        currentTime: Number(audio.currentTime.toFixed(2)),
        readyState: audio.readyState,
        networkState: audio.networkState,
        errorCode: audio.error?.code ?? null,
        autoplayBlocked: audio.paused && audio.currentTime === 0,
      };
      logTo(r1Log, `自动播放结果 ${JSON.stringify(state)}`);
      report({ r1: 'autoplay-result', ...state });
    }, 3000);
  }, 1200);
}
