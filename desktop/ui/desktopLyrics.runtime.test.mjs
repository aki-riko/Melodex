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
// Range / 离屏 div 的宽度按文字长度估算（每字 ~18px），
// 让 fitScale 与溢出收敛逻辑有真实反馈，而不是恒定 400 掩盖问题。
const estimateWidth = (node) => {
  const text = typeof node === 'string'
    ? node
    : (node?.textContent ?? '');
  return text.length * 18;
};
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
      return { getContext: () => ({ font: '', measureText: (text) => ({ width: text.length * 18 }) }) };
    }
    return {
      style: { cssText: '' },
      textContent: '',
      getBoundingClientRect() { return { width: estimateWidth(this.textContent) }; },
      remove: () => {},
    };
  },
  createRange: () => {
    const range = {
      _node: null,
      selectNodeContents(node) { range._node = node; },
      getBoundingClientRect: () => ({ width: estimateWidth(range._node) }),
    };
    return range;
  },
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
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '"Microsoft YaHei UI"' });

// ★ requestAnimationFrame 必须**真的执行回调**（同步跑一次）。
//
// 踩过的坑：一开始写成 `() => 0`（只返回 id 从不回调），于是
// startLineTransition 的 step 永远不执行 → 切行动画从不"结束" →
// finishTransition 不被调用 → 旧行（outgoing）残留检测不到，
// 用它做的「切歌残留上一首歌词」测试形同虚设（突变验证时不会变红）。
// rAF 桩：**只挂起、不自动执行**。
//
// ★ 为什么不能"立刻执行回调"（踩过两次）：
//   ① 切歌残留测试需要"动画进行中"的画面，自动跑完会立刻 finishTransition 清空
//      outgoing，断言永远看到空的（突变验证时不会变红，测试形同虚设）；
//   ② renderLoop 现在是 `requestAnimationFrame(renderLoop)` 自递归，
//      桩里同步执行回调会**无限递归**（实测 RangeError: Maximum call stack size exceeded）。
//
// 所以：回调一律挂起，由测试在需要时显式 flush。
const pendingRaf = [];
let rafPaused = false;
globalThis.window.requestAnimationFrame = (cb) => {
  pendingRaf.push(cb);
  return pendingRaf.length;
};
globalThis.window.cancelAnimationFrame = () => {};
globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
globalThis.cancelAnimationFrame = () => {};

/** 把挂起的 rAF 跑 n 轮（模拟若干帧）。renderLoop 会再挂一轮，所以按轮数跑。 */
const flushAnimationFrames = (rounds = 1) => {
  for (let i = 0; i < rounds; i += 1) {
    const batch = pendingRaf.splice(0, pendingRaf.length);
    for (const cb of batch) cb(performance.now() + 10000);
  }
};

/**
 * 暂停 rAF：把回调挂起而不执行。
 *
 * ★ 切歌残留测试必须用这个（踩过两次）：
 *   rAF 若同步跑完，动画立刻结束 → finishTransition 清空 outgoing →
 *   断言时旧行已经是空的，**根本抓不到"把上一首歌词当旧行显示"这个 bug**
 *   （突变验证时两次都还是全绿，证明测试形同虚设）。
 *   挂起回调后，切歌那一刻的 outgoing 内容才是真实用户看到的画面。
 */
const setRafPaused = (paused) => { rafPaused = paused; };

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

  // ---------- 切歌不得残留上一首的歌词 ----------
  //
  // 用户实测：「甚至还会出现上一首歌曲的歌词」。
  // 根因：applyStateMessage 换 track 时只替换 playback.track/lyrics，
  // renderedLineIndex / renderedActiveText 仍是上一首的（比如唱到第 1 行）。
  // 新歌第一句 index=0，syncRenderedLyrics 拿 previousIndex=1 判
  // canAnimateForward，并把上一首的歌词文字当"旧行"传给 startLineTransition
  // → 屏幕上真的画出上一首那句歌词。
  //
  // ★ 复现要点：必须让上一首**先推进到至少第 2 行**（renderedLineIndex>=0
  //   且 renderedActiveText 非空），否则 canAnimateForward 第一句就 return false，
  //   走不到"把旧文字当旧行"的分支 —— 这正是第一版测试抓不住的原因。
  //   这里用两首歌的连续推包模拟：先 position=0 起第 0 行，再 position=12 起第 1 行。
  await sendTrack(0);
  await sendTrack(12); // 上一首推进到「五六七八」，renderedLineIndex=1
  const previousSongMain = elements.get('current-line-base')?.textContent;

  // ★ 切歌前暂停 rAF：让"动画进行中"的画面保留下来。
  //   否则动画瞬间跑完、finishTransition 清空 outgoing，抓不到残留（见 setRafPaused 注释）。
  setRafPaused(true);
  pushState({
    payload: {
      type: 'track',
      track: { id: 'y', source: 'netease', name: '另一首', artist: '另一个歌手' },
      lyrics: [{ t: 0, end: 10, text: '新歌第一句', words: null }],
      position: 0,
      duration: 100,
      paused: true,
      current_index: 0,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 40));

  const afterSwitch = elements.get('current-line-base')?.textContent;
  const outgoingAfter = elements.get('outgoing-line-base')?.textContent;
  const outgoingVisible = elements.get('outgoing-line')?.style?.visibility;
  setRafPaused(false);

  test('切歌后主行立刻是新歌的歌词，不带上一首残留', () => {
    if (previousSongMain !== '五六七八') {
      throw new Error(`前置条件不成立：切歌前主行应是上一首的「五六七八」，实际「${previousSongMain}」`);
    }
    if (afterSwitch !== '新歌第一句') {
      throw new Error(`切歌后主行应为「新歌第一句」，实际「${afterSwitch}」`);
    }
  });

  test('切歌后旧行（outgoing）不得显示上一首的歌词', () => {
    // 这是用户实际看到的症状：切歌瞬间屏幕上还挂着上一首那句歌词。
    // 判据直接比内容 —— 残留内容等于上一首歌词就是 bug。
    if (outgoingAfter && outgoingAfter === previousSongMain) {
      throw new Error(
        `切歌后旧行残留了上一首的歌词「${outgoingAfter}」（visibility=${outgoingVisible}）`,
      );
    }
    // 且旧行不该处于可见状态
    if (outgoingVisible === 'visible' && outgoingAfter) {
      throw new Error(`切歌后旧行仍可见且带文字「${outgoingAfter}」`);
    }
  });

  test('同一首歌重复推送（seek/歌词晚到）不得重置已渲染行', () => {
    // 判据用 trackKey(source+id)：同 key 不该触发重置，否则每次进度包都会清空当前行。
    // 这里推同一首歌、同一位置，主行文字必须保持稳定。
    const before = elements.get('current-line-base')?.textContent;
    pushState({
      payload: {
        type: 'track',
        track: { id: 'y', source: 'netease', name: '另一首', artist: '另一个歌手' },
        lyrics: [{ t: 0, end: 10, text: '新歌第一句', words: null }],
        position: 0,
        duration: 100,
        paused: true,
        current_index: 0,
      },
    });
    const after = elements.get('current-line-base')?.textContent;
    if (after !== before) {
      throw new Error(`同一首歌重复推送后主行从「${before}」变成「${after}」，不该重置`);
    }
  });

  console.log(`\ndesktop lyrics runtime tests passed (${passed})`);
} finally {
  rmSync(stageDir, { recursive: true, force: true });
}
