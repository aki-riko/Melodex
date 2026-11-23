// 桌面歌词窗的**运行期**冒烟测试。
//
// 与 lyricsSettings.test.mjs 的区别：那一份做静态断言（读源码正则匹配），
// 这一份用最小 DOM/Tauri 桩把 overlay.js **真的执行一遍**，验证行为而不是字面量。
//
// 为什么需要它（2026-11-23 用户报「桌面歌词一坨屎」时抓到）：
//   有两个缺陷静态断言完全看不出来，必须跑起来才能确认：
//   ① 「整行一次性亮」—— render() 把只有 text 的残缺对象喂给进度函数，
//      lineProgress 读不到 t/end/words，播放 5 秒后进度恒为 1。
//      静态看代码"调用了 lineProgress"，只有跑起来才能发现进度不随位置变化。
//   ② 「没放歌时留一个看不见的空框挡鼠标」—— 可见性只看用户开关。
//      这是真机实测才发现的（窗口全透明、TOPMOST、不穿透）。
//
// 用法：node desktopLyrics.runtime.test.mjs

import { readFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const stageDir = join(here, '.runtime-stage');
mkdirSync(stageDir, { recursive: true });
copyFileSync(join(here, 'lyricsCore.js'), join(stageDir, 'lyricsCore.js'));
copyFileSync(join(here, 'overlay.js'), join(stageDir, 'overlay.js'));

const html = readFileSync(join(here, 'overlay.html'), 'utf8');
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);

// ---------- 最小 DOM 桩 ----------
const elements = new Map();
const makeElement = (id) => {
  const props = new Map();
  const el = {
    id,
    textContent: '',
    title: '',
    dataset: {},
    clientWidth: 800,
    style: {
      setProperty: (key, value) => props.set(key, value),
      getPropertyValue: (key) => props.get(key) ?? '',
      _props: props,
    },
    classList: { toggle: () => {} },
    addEventListener: () => {},
    closest: () => null,
  };
  elements.set(id, el);
  return el;
};

const rootVars = new Map();
globalThis.document = {
  documentElement: {
    style: {
      setProperty: (key, value) => rootVars.set(key, value),
      getPropertyValue: (key) => rootVars.get(key) ?? '',
    },
  },
  body: { classList: { toggle: () => {} }, appendChild: () => {} },
  getElementById: (id) => elements.get(id) || makeElement(id),
  createElement: (tag) => {
    if (tag === 'canvas') {
      // 宽高比按 ~18px/字，与 36px 中文字号量级相当
      return { getContext: () => ({ font: '', measureText: (text) => ({ width: text.length * 18 }) }) };
    }
    return {
      style: { cssText: '' },
      textContent: '',
      getBoundingClientRect: () => ({ width: 400 }),
      remove: () => {},
    };
  },
  createRange: () => ({
    selectNodeContents: () => {},
    getBoundingClientRect: () => ({ width: 400 }),
  }),
};

// ---------- 最小 Tauri 桩 ----------
const listeners = new Map();
const invokes = [];
globalThis.window = {
  __TAURI__: {
    core: {
      invoke: async (command, args) => {
        invokes.push({ command, args });
        if (command === 'lyrics_settings_get') {
          return {
            visible: true,
            click_through: false,
            font_size: 36,
            color_scheme: '珊瑚绯',
            played_color: '#FFC6C6',
            unplayed_color: '#EEEEEE',
            font_family: 'Microsoft YaHei UI',
          };
        }
        if (command === 'lyrics_resize_to_content') return true;
        return null;
      },
    },
    event: {
      listen: (name, handler) => {
        listeners.set(name, handler);
        return Promise.resolve(() => {});
      },
    },
  },
  addEventListener: () => {},
  setInterval: () => 0,
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '"Microsoft YaHei UI"' });
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

for (const id of ids) makeElement(id);

let passed = 0;
// ★ 注意：test() 必须是**同步**执行体。
//   早期写成 `test('...', async () => { await sendTrack(...); assert })`，
//   而 test() 内部不 await —— 断言在 test() 已经"通过"之后才异步跑，
//   失败只会变成未捕获的 rejection，看起来是"4 项全过但退出码 1"。
//   所以异步准备（sendTrack）一律先 await 好，再把纯断言交给 test()。
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
};

try {
  await import(`file:///${join(stageDir, 'overlay.js').replace(/\\/g, '/')}`);
  await new Promise((resolve) => setTimeout(resolve, 60));

  const pushState = listeners.get('melodex:lyrics-state');
  if (typeof pushState !== 'function') {
    throw new Error('overlay.js 没有注册 melodex:lyrics-state 监听');
  }

  // 逐字歌词：第 0 行 0..10s，两个 word 各占 2 字
  const lyrics = [
    {
      t: 0,
      end: 10,
      text: '一二三四',
      words: [{ t: 0, end: 5, s: '一二' }, { t: 5, end: 10, s: '三四' }],
    },
    { t: 10, end: 20, text: '五六七八', words: null },
  ];

  const sendTrack = async (position, paused = true, trackOverride) => {
    pushState({
      payload: {
        type: 'track',
        track: trackOverride === undefined
          ? { id: 'x', source: 'qq', name: '测试歌', artist: '测试歌手' }
          : trackOverride,
        lyrics,
        position,
        duration: 200,
        paused,
        current_index: 0,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
  };

  const fillRatio = () => Number(
    elements.get('current-line-wrap')?.style._props.get('--fill-ratio'),
  );
  const lastOverlayVisible = () => {
    const calls = invokes.filter((call) => call.command === 'set_overlay_visible');
    return calls.length ? calls[calls.length - 1].args.visible : null;
  };

  await sendTrack(2.5);
  const quarter = fillRatio();
  await sendTrack(7.5);
  const threeQuarters = fillRatio();

  test('逐字填色进度随播放位置变化（不是恒为 1）', () => {
    // 修复前：lineProgress 收到 { text } 这种残缺行，start=0/end=5，
    // 播放 5 秒后恒为 1 —— 整行一次性亮，逐字填色完全看不出来。
    if (Math.abs(quarter - 0.25) > 0.02) {
      throw new Error(`position=2.5s 的填色进度应为 ≈0.25，实际 ${quarter}`);
    }
    if (Math.abs(threeQuarters - 0.75) > 0.02) {
      throw new Error(`position=7.5s 的填色进度应为 ≈0.75，实际 ${threeQuarters}`);
    }
    if (quarter === threeQuarters) {
      throw new Error('两个位置的进度相同，说明进度没有跟随播放位置');
    }
  });

  // 无歌：先把状态推进去，再同步断言
  invokes.length = 0;
  await sendTrack(0, true, null);
  const visibleWhenNoTrack = lastOverlayVisible();
  test('无歌时隐藏窗口（不留看不见的空框挡鼠标）', () => {
    if (visibleWhenNoTrack !== false) {
      throw new Error(`无歌时应隐藏窗口，实际 visible=${visibleWhenNoTrack}`);
    }
  });

  // 有歌：同上
  invokes.length = 0;
  await sendTrack(0, true);
  const visibleWithTrack = lastOverlayVisible();
  test('有歌时显示窗口', () => {
    if (visibleWithTrack !== true) {
      throw new Error(`有歌时应显示窗口，实际 visible=${visibleWithTrack}`);
    }
  });

  await sendTrack(12);
  const mainText = elements.get('current-line-base')?.textContent;
  const nextText = elements.get('next-line')?.textContent;
  test('换行后主行文字与副行文字取对', () => {
    if (mainText !== '五六七八') throw new Error(`主行应为「五六七八」，实际「${mainText}」`);
    // 第 1 行是最后一行 → 副行索引 -1 → 回退到歌手名
    if (nextText !== '测试歌手') throw new Error(`副行应回退到歌手名，实际「${nextText}」`);
  });

  console.log(`\ndesktop lyrics runtime tests passed (${passed})`);
} finally {
  rmSync(stageDir, { recursive: true, force: true });
}
