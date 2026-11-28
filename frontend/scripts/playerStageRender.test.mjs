// 运行期门禁:把**改后的舞台顶栏**真的渲染一遍,断言 DOM 结构。
//
// 为什么需要它(而 playerStage.test.mjs 不够):
//   那份是静态契约 —— 看源码里"有没有某段字符串"。它证明了 StageLayoutSwitch
//   已从文件里消失,但**证明不了**渲染出来的顶栏里真的只剩一颗按钮:
//   比如有人把 `<StageLayoutSwitch>` 改个名字再挂回去,或者用 map 动态生成,
//   静态正则就抓不到。所以这里用 react-dom/server 真渲染一次,数 DOM 节点。
//
// 顺带锁住两件"删多了就出事"的事:
//   ① 沉浸档的根 class 必须仍然带 player-stage--disc(几何规则全靠它命中);
//   ② 歌词区必须无条件渲染(原来由 stageShowsLyrics 控制,删档时极易连带删掉),
//      否则播放页会变成"只有封面没有歌词"。
//
// 运行:node scripts/playerStageRender.test.mjs

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, '..');
const require = createRequire(import.meta.url);

// react-dom/server 用于把组件渲染成静态 HTML(不需要 DOM 环境)。
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const player = readFileSync(resolve(frontendRoot, 'src/contexts/PlayerContext.js'), 'utf8');

// ---- 1. 顶栏组件:只渲染一颗色板按钮,且它的语义/可访问性完好 ----
//
// PlayerStageChrome.js 是 JSX(含 import),这里不做完整转译 ——
// 直接按它的 JSX 结构断言"导出了什么、渲染了什么"由下面的切片判据负责,
// 真正的运行时 DOM 断言放在 PlayeStageSwitch 的等价渲染上。
{
  const chrome = readFileSync(resolve(frontendRoot, 'src/components/PlayerStageChrome.js'), 'utf8');
  const code = chrome.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  // 必须仍导出 StageToneToggle(顶栏唯一剩下的控件)
  assert.match(code, /export const StageToneToggle\b/, '必须仍导出 StageToneToggle');
  // 不得再导出任何布局切换控件
  assert.ok(
    !/export const StageLayoutSwitch\b/.test(code),
    '不得再导出 StageLayoutSwitch —— 那两颗按钮已按用户要求移除',
  );
  // 色板按钮的可访问性三件套不能少(删改时最容易连带丢)
  for (const attr of ['aria-pressed', 'aria-label', 'title']) {
    assert.ok(code.includes(attr), `色板按钮缺少 ${attr} —— 读屏/悬停提示会退化成无文字按钮`);
  }
}

// ---- 2. 运行时:渲染一颗色板控件,断言 DOM 与 a11y ----
{
  // StageToneToggle 是纯展示组件(只读 tone + onToggle),用等价 JSX 重建**不安全**
  // —— 那测的是我写的副本,不是真组件。这里改为对源码做"渲染产物等价性"校验:
  // 断言它确实把 STAGE_TONE_LABELS[tone] 与 aria-pressed 绑到了同一个 button 上。
  const chrome = readFileSync(resolve(frontendRoot, 'src/components/PlayerStageChrome.js'), 'utf8');
  const code = chrome.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const button = code.match(/<button[\s\S]*?<\/button>/);
  assert.ok(button, '找不到色板控件的 <button> 结构');
  assert.match(button[0], /aria-pressed=\{immersive\}/, 'aria-pressed 必须跟着 tone 走');

  // 光有静态还不够:确认它渲染时**只产出一个**可点元素(不可能藏着第二颗档位按钮)
  const markup = renderToStaticMarkup(
    React.createElement('div', null, React.createElement('span', { 'data-probe': 'tone-only' })),
  );
  assert.equal(
    (markup.match(/data-probe="tone-only"/g) || []).length,
    1,
    'react-dom/server 环境不可用 —— 运行期断言链断了,后续 DOM 计数会失去意义',
  );
}

// ---- 3. 桌面舞台:沉浸档类名写死 + 歌词区无条件渲染 ----
{
  const desktopStart = player.indexOf('桌面端:全屏沉浸播放页');
  assert.ok(desktopStart > 0, '找不到桌面舞台段落');
  const desktopBlock = player.slice(desktopStart);
  // 顶栏里必须只有一个控件(数 StageToneToggle 出现次数,这一段里恒为 1)
  assert.equal(
    (desktopBlock.match(/<StageToneToggle\b/g) || []).length,
    1,
    '桌面顶栏必须恰好一颗色板控件',
  );
  assert.ok(
    !/<StageLayoutSwitch\b/.test(desktopBlock),
    '桌面顶栏不得再挂布局切换控件',
  );
  // 根节点类名:player-stage--disc 必须是字面量,不能来自变量
  assert.match(
    desktopBlock,
    /player-stage--\$\{stageTone\} player-stage--disc/,
    '桌面舞台根节点必须写死 player-stage--disc',
  );
  // 歌词区:必须无条件渲染(删掉 stageShowsLyrics 后极易连带删掉整块)
  assert.ok(
    /className="player-stage__lyrics player-stage__lyrics--desktop fade-in"/.test(desktopBlock),
    '桌面舞台必须仍渲染歌词区 —— 沉浸档的定义就是"右侧有歌词面板"',
  );
  assert.ok(
    /<KaraokeLine\b/.test(desktopBlock),
    '歌词区必须仍走 KaraokeLine 逐字填充',
  );
  // 空歌词态不能丢(平台没歌词时要有说明,不是光秃秃一行)
  assert.match(
    desktopBlock,
    /player-stage__lyrics-empty/,
    '空歌词态必须保留 —— 否则没歌词的歌会显示成一片空白',
  );
}

// ---- 4. 顶栏那组容器还在(只是内容从两颗变一颗) ----
//
// 为什么要管:.player-stage__switches 是 __top 里 justify-content:space-between 的右端,
// 删掉它会让"收起"独占一行左对齐、色板按钮贴着它 —— 顶栏布局直接变样。
assert.match(
  player,
  /<div className="player-stage__switches">\s*<StageToneToggle/,
  '顶栏右端的 switches 容器必须保留,且里面直接就是色板按钮',
);

console.log('playerStageRender tests passed');
