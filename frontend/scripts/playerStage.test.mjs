import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STAGE_LAYOUTS,
  STAGE_LAYOUT_KEY,
  STAGE_LAYOUT_LABELS,
  STAGE_TONES,
  STAGE_TONE_KEY,
  STAGE_TONE_LABELS,
  defaultStageLayout,
  defaultStageTone,
  isWideViewport,
  normalizeStageLayout,
  normalizeStageTone,
  persistStagePref,
  readStageLayout,
  readStageTone,
  safeStorage,
  stageShowsLyrics,
  stageToneActionLabel,
  stageToneNext,
} from '../src/contexts/playerStage.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptDir, '..');
const srcRoot = resolve(frontendRoot, 'src');
const css = readFileSync(resolve(srcRoot, 'index.css'), 'utf8');
const player = readFileSync(resolve(srcRoot, 'contexts', 'PlayerContext.js'), 'utf8');

// 播放舞台「可切换」契约。
//
// 为什么要有:布局三档与色板两档都属于「写错了构建不报错、只是界面不对」的一类 ——
// 默认值写反(手机打开是双栏)、存储里存了脏值(界面塌成一列)、
// 切档后歌词不滚(判断写了 === 却漏了 split)、沉浸档在浅色主题下变成白底白字。
// 这些都没有异常可抓,只能靠静态契约 + 纯函数断言锁住。

// ---- 1. 档位清单与文案必须一一对应 ----
assert.deepEqual(STAGE_LAYOUTS, ['disc', 'lyrics', 'split'], '布局三档必须是 唱片/歌词/双栏');
assert.deepEqual(STAGE_TONES, ['immersive', 'theme'], '色板两档必须是 沉浸暗场/跟随主题');
for (const id of STAGE_LAYOUTS) {
  const label = STAGE_LAYOUT_LABELS[id];
  assert.equal(typeof label, 'string', `布局 ${id} 缺中文名`);
  assert.ok(label.length > 0, `布局 ${id} 的中文名为空`);
}
for (const id of STAGE_TONES) {
  const label = STAGE_TONE_LABELS[id];
  assert.equal(typeof label, 'string', `色板 ${id} 缺中文名`);
  assert.ok(label.length > 0, `色板 ${id} 的中文名为空`);
}
// 档位与文案不能有一边多出来(否则界面上会出现"没有名字的档"或"点了没响应的名字")
assert.deepEqual(
  Object.keys(STAGE_LAYOUT_LABELS).sort(),
  [...STAGE_LAYOUTS].sort(),
  '布局文案的键与 STAGE_LAYOUTS 不一致',
);
assert.deepEqual(
  Object.keys(STAGE_TONE_LABELS).sort(),
  [...STAGE_TONES].sort(),
  '色板文案的键与 STAGE_TONES 不一致',
);

// ---- 2. 默认值:桌面双栏、手机唱片;色板默认沉浸 ----
assert.equal(defaultStageLayout(true), 'split', '桌面默认应保持原来的「唱片 + 歌词」双栏');
assert.equal(defaultStageLayout(false), 'disc', '手机默认应是唱片(原移动端就是封面)');
assert.equal(defaultStageTone(), 'immersive', '色板默认应为沉浸暗场(播放页的常态)');

// ---- 3. 非法值必须收敛,绝不返回空 ----
assert.equal(normalizeStageLayout('lyrics', true), 'lyrics', '合法值应原样返回');
assert.equal(normalizeStageLayout(' ', true), 'split', '空白应收敛到默认');
assert.equal(normalizeStageLayout(null, false), 'disc', 'null 应收敛到默认');
assert.equal(normalizeStageLayout(42, false), 'disc', '非字符串应收敛到默认');
assert.equal(normalizeStageLayout('DISC', false), 'disc', '大小写应被容忍');
assert.equal(normalizeStageTone('theme'), 'theme', '合法色板应原样返回');
assert.equal(normalizeStageTone('nope'), 'immersive', '未知色板应收敛到默认');
assert.equal(normalizeStageTone(null), 'immersive', 'null 色板应收敛到默认');

// ---- 4. 「这一档显不显示歌词」是唯一判据 ----
// 自动滚动与滚动区挂载都读它;写成 === 'lyrics' 会让 split 档的歌词不再自动居中。
assert.equal(stageShowsLyrics('lyrics'), true);
assert.equal(stageShowsLyrics('split'), true, '双栏档也有歌词区,必须为 true');
assert.equal(stageShowsLyrics('disc'), false, '唱片档没有歌词区');
assert.equal(stageShowsLyrics(undefined), false, '未知档位不得抛错');

// ---- 5. 两档来回切 ----
assert.equal(stageToneNext('immersive'), 'theme');
assert.equal(stageToneNext('theme'), 'immersive');
// 未知值先收敛到默认(immersive)再切,所以结果是 theme —— 关键是不能返回 undefined
assert.equal(stageToneNext('nope'), 'theme', '未知值应先收敛再切,绝不返回 undefined');
assert.equal(stageToneNext(null), 'theme', 'null 同样先收敛再切');
assert.equal(stageToneActionLabel('immersive'), '切换为跟随主题', '沉浸时按钮应说明"切到跟随主题"');
assert.equal(stageToneActionLabel('theme'), '切换为沉浸暗场', '跟随时按钮应说明"切到沉浸暗场"');

// ---- 6. 存储:读写、脏值、异常都不能崩 ----
{
  const makeStorage = (initial = {}) => {
    const map = new Map(Object.entries(initial));
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => { map.set(k, v); },
      _map: map,
    };
  };

  const storage = makeStorage();
  assert.equal(readStageLayout(storage, true), 'split', '空存储应回落到桌面默认');
  assert.equal(readStageTone(storage), 'immersive', '空存储应回落到沉浸');

  persistStagePref(storage, STAGE_LAYOUT_KEY, 'lyrics');
  assert.equal(storage._map.get(STAGE_LAYOUT_KEY), 'lyrics', '切换布局必须写进存储(否则刷新就丢)');
  assert.equal(readStageLayout(storage, true), 'lyrics', '写过之后应读回用户的选择');

  persistStagePref(storage, STAGE_TONE_KEY, 'theme');
  assert.equal(readStageTone(storage), 'theme', '切换色板必须能持久化');

  // 脏值
  const dirty = makeStorage({ [STAGE_LAYOUT_KEY]: 'bogus', [STAGE_TONE_KEY]: '' });
  assert.equal(readStageLayout(dirty, false), 'disc', '脏布局应回落到该设备的默认值');
  assert.equal(readStageTone(dirty), 'immersive', '脏色板应回落到沉浸');

  // Storage 不可用 / 抛错:不能崩,也不能阻断播放页
  assert.equal(readStageLayout(null, true), 'split', 'storage 为 null 时回落到默认');
  assert.equal(readStageTone(null), 'immersive', 'storage 为 null 时回落到默认');
  const throwing = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceeded'); },
  };
  assert.equal(readStageLayout(throwing, true), 'split', 'getItem 抛错时必须回落默认(无痕模式不能崩)');
  assert.equal(readStageTone(throwing), 'immersive', 'getItem 抛错时必须回落默认');
  assert.equal(
    persistStagePref(throwing, STAGE_LAYOUT_KEY, 'split'),
    'split',
    'setItem 抛错时仍应返回本次要用的值(当前会话照常生效)',
  );
  assert.equal(safeStorage(null), null, 'safeStorage 对空目标应返回 null');
  assert.equal(
    safeStorage({ get localStorage() { throw new Error('blocked'); } }),
    null,
    'localStorage getter 抛错时 safeStorage 必须返回 null 而不是抛出',
  );
}

// ---- 7. 断点判据与全站一致 ----
assert.equal(
  isWideViewport(() => ({ matches: true })),
  true,
  '宽屏时应按桌面处理',
);
assert.equal(isWideViewport(() => ({ matches: false })), false, '窄屏时应按手机处理');
assert.equal(isWideViewport(undefined), true, '非浏览器环境按宽屏处理');
assert.equal(
  isWideViewport(() => { throw new Error('boom'); }),
  true,
  'matchMedia 抛错时回落宽屏,不能阻断渲染',
);
// CSS 的 lg 断点必须还是 1024 —— 与 isWideViewport 里的字符串对应
assert.match(
  player,
  /isWideViewport\(\)/,
  'PlayerContext 必须用 isWideViewport 决定默认档位(按 innerWidth 自己算会与 CSS 断点漂移)',
);

// ---- 8. 样式契约:CSS 里必须有沉浸档的 token 覆盖,否则白底白字 ----
assert.ok(/\.player-stage--immersive\s*\{/.test(css), '缺少 .player-stage--immersive —— 沉浸档没有自己的颜色');
{
  const block = css.match(/\.player-stage--immersive\s*\{([\s\S]*?)\n\}/);
  assert.ok(block, '取不到沉浸档样式块');
  for (const token of ['--background', '--foreground', '--muted-foreground', '--primary', '--border']) {
    assert.ok(
      block[1].includes(`${token}:`),
      `沉浸档必须重定义 ${token} —— 舞台里所有 Tailwind 类都读这些 token,漏一个就会"深底上出现浅底主题的字色"`,
    );
  }
  // 沉浸档的底色必须是深色,不能沿用浅色主题的 95%
  const bg = block[1].match(/--background:\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
  assert.ok(bg, '沉浸档的 --background 必须是 h s% l% 形式');
  assert.ok(Number(bg[3]) <= 20, `沉浸档 --background 亮度 ${bg[3]}% 太亮 —— 那就不是"沉浸"了`);
  // 前景必须是亮色,才能压在深底上
  const fg = block[1].match(/--foreground:\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
  assert.ok(fg, '沉浸档的 --foreground 必须是 h s% l% 形式');
  assert.ok(Number(fg[3]) >= 90, `沉浸档 --foreground 亮度 ${fg[3]}% 太暗 —— 深底上会看不见字`);

  // 沉浸档的强调色不能沿用浅色主题的深蓝(深底上几乎看不见)
  const primary = block[1].match(/--primary:\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
  assert.ok(primary, '沉浸档的 --primary 必须是 h s% l% 形式');
  assert.ok(
    Number(primary[3]) >= 55,
    `沉浸档 --primary 亮度 ${primary[3]}% 太暗 —— 深底上的图标/链接会看不清(浅色主题的 #004F99 = 30%)`,
  );
}

// 「跟随主题」档不得重定义颜色 token —— 它的定义就是"什么都不改"
{
  const themeBlock = css.match(/\.player-stage--theme\s*\{([\s\S]*?)\n\}/);
  assert.ok(themeBlock, '缺少 .player-stage--theme');
  assert.ok(
    !/--background\s*:/.test(themeBlock[1]),
    '跟随主题档不得改写 --background —— 它必须原样沿用当前主题,否则浅色主题也不会跟着变',
  );
}

// 背景层必须不吃点击、有确定层级
assert.ok(
  /\.player-stage__bg\s*\{[^}]*pointer-events:\s*none/.test(css),
  '背景层必须 pointer-events:none —— 否则它会把整屏的点击全部吃掉',
);
assert.ok(
  /\.player-stage__bg\s*\{[^}]*z-index:\s*0/.test(css),
  '背景层需要确定的 z-index,内容层才能稳定压在上面',
);

// ---- 8b. 舞台根规则不得声明 display / position / flex-direction ----
//
// 真实陷阱(本鱼写这一版时实实在在踩了两次):index.css 的绝大多数规则**不在 @layer 里**,
// 而未分层样式的优先级高于 @layer 中的 Tailwind utilities —— 特异性相同时也由源码顺序决定。
//   · `.player-stage { display:flex }` → 压过 `hidden`,两套断点舞台同时显示;
//   · `.player-stage { position:relative }` → 压过 `fixed`,舞台不再黏住视口。
// 两者都只在真机上看得见,构建、单测、门禁全都不报。所以这里把它们钉死。
{
  const stageRoot = css.match(/\n\.player-stage\s*\{([\s\S]*?)\n\}/);
  assert.ok(stageRoot, '找不到 .player-stage 根规则');
  for (const [prop, why] of [
    ['display', '压过 hidden:两套断点舞台会同时显示'],
    ['position', '压过 fixed(fixed/absolute/relative 同在 tailwind utilities 层):舞台不再黏住视口'],
    ['flex-direction', '应由 JSX 的 flex-col 负责'],
    ['inset', '应由 JSX 的 inset-0 负责'],
    ['z-index', '应由 JSX 的 z-sheet 负责'],
  ]) {
    assert.ok(
      !(new RegExp(`(^|\\n)\\s*${prop}\\s*:`)).test(stageRoot[1]),
      `.player-stage 不得声明 ${prop} —— 它会${why}。这类冲突只在真机上看得见,构建与门禁都不报`,
    );
  }
}
// 两套舞台的断点类必须仍在(重做时最容易漏成"两端都渲染")
assert.equal(
  (player.match(/lg:hidden player-stage/g) || []).length,
  1,
  '移动舞台必须带 lg:hidden',
);
assert.equal(
  (player.match(/hidden lg:flex player-stage/g) || []).length,
  1,
  '桌面舞台必须带 hidden lg:flex',
);
// 舞台根节点必须仍然是"固定整屏 + 语义层级"
assert.equal(
  (player.match(/fixed inset-0 z-sheet/g) || []).length,
  2,
  '两套舞台都必须 fixed inset-0 z-sheet —— 缺一个就不是沉浸式覆盖层',
);

// ---- 9. 组件契约:两套舞台都必须真的用上切换控件与档位 ----
assert.match(player, /from '\.\/playerStage\.mjs'/, 'PlayerContext 必须从 playerStage.mjs 取档位规则');
assert.match(player, /from '\.\.\/components\/PlayerStageChrome'/, 'PlayerContext 必须用抽出来的切换控件');
assert.equal(
  (player.match(/<StageLayoutSwitch\b/g) || []).length,
  2,
  '两套舞台(桌面 / 手机)各要一处布局切换 —— 少一处说明有一端还切不了',
);
assert.equal(
  (player.match(/<StageToneToggle\b/g) || []).length,
  2,
  '两套舞台各要一处色板切换',
);
assert.equal(
  (player.match(/readStageLayout\(/g) || []).length,
  1,
  '布局初值只能有一处来源(useState 初始化),多处读会互相覆盖',
);
assert.match(player, /persistStagePref\(/, '切换必须落盘,否则刷新就回到默认');

// 旧的隐式切换(点整块封面↔歌词)必须已经删除:
// 三档布局之后它会造成"点歌词就跳回唱片档",与顶部控件互相打架。
assert.ok(
  !/setShowLyric\b/.test(player),
  '不得再保留 showLyric 隐式切换 —— 布局已由顶部控件显式决定,两套机制并存会互相顶掉',
);
assert.ok(
  !/点击显示封面|点击显示歌词/.test(player),
  '不得再出现"点击显示封面/歌词"的提示 —— 那套隐式交互已由显式三档取代',
);

// 舞台的歌词滚动必须读 stageShowsLyrics(而不是只认 lyrics 档)
assert.match(
  player,
  /stageShowsLyrics\(stageLayout\)/,
  '歌词滚动与挂载都必须经 stageShowsLyrics 判断,否则双栏档的歌词不会自动居中',
);

// 播放页仍必须能被返回键收掉(这条是 backLayers 门禁的补充,防止重做时漏挂)
assert.match(player, /useBackLayer\(\{[\s\S]{0,200}?name:\s*'player-sheet'/, '舞台必须仍挂返回栈');

console.log('playerStage tests passed');
