import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STAGE_TONE_KEY,
  STAGE_TONE_LABELS,
  STAGE_TONES,
  defaultStageTone,
  normalizeStageTone,
  persistStagePref,
  readStageTone,
  safeStorage,
  stageToneActionLabel,
  stageToneNext,
} from '../src/contexts/playerStage.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptDir, '..');
const srcRoot = resolve(frontendRoot, 'src');
const css = readFileSync(resolve(srcRoot, 'index.css'), 'utf8');
const player = readFileSync(resolve(srcRoot, 'contexts', 'PlayerContext.js'), 'utf8');
const chrome = readFileSync(resolve(srcRoot, 'components', 'PlayerStageChrome.js'), 'utf8');

// 播放舞台契约。
//
// 为什么要有:色板两档属于「写错了构建不报错、只是界面不对」的一类 ——
// 默认值写反(打开是白底)、存储里存了脏值、浅色主题下变成白底白字。
// 这些都没有异常可抓,只能靠静态契约 + 纯函数断言锁住。
//
// ★ 2026-11 用户圈出顶栏那两颗「歌词」「封面」并要求「移除红框的这俩样式」,
//   选择的是「只留沉浸一档」。所以本文件从"三档布局"收缩为"布局恒定 + 色板两档",
//   并新增第 9 条**反向断言**:布局切换不得复活。

// ---- 1. 色板清单与文案必须一一对应 ----
assert.deepEqual(STAGE_TONES, ['immersive', 'theme'], '色板两档必须是 沉浸暗场/跟随主题');
for (const id of STAGE_TONES) {
  const label = STAGE_TONE_LABELS[id];
  assert.equal(typeof label, 'string', `色板 ${id} 缺中文名`);
  assert.ok(label.length > 0, `色板 ${id} 的中文名为空`);
}
// 档位与文案不能有一边多出来(否则界面上会出现"没有名字的档"或"点了没响应的名字")
assert.deepEqual(
  Object.keys(STAGE_TONE_LABELS).sort(),
  [...STAGE_TONES].sort(),
  '色板文案的键与 STAGE_TONES 不一致',
);

// ---- 2. 默认值:色板默认沉浸暗场 ----
assert.equal(defaultStageTone(), 'immersive', '色板默认应为沉浸暗场');

// ---- 3. 非法值必须收敛,绝不返回空 ----
assert.equal(normalizeStageTone('theme'), 'theme', '合法色板应原样返回');
assert.equal(normalizeStageTone('nope'), 'immersive', '未知色板应收敛到默认');
assert.equal(normalizeStageTone(null), 'immersive', 'null 色板应收敛到默认');
assert.equal(normalizeStageTone(' '), 'immersive', '空白应收敛到默认');
assert.equal(normalizeStageTone(42), 'immersive', '非字符串应收敛到默认');
// ⚠ 大小写**不做**归一化:normalizeStageTone 只做 trim + 白名单比对,
//    所以 'THEME' 属于非法值 → 收敛到默认。这是既有实现,本门禁只如实锁住它,
//    不擅自把它改写成"容忍大小写"(那属于改行为,得先问用户)。
assert.equal(normalizeStageTone('THEME'), 'immersive', '大写不在白名单内 → 收敛到默认(既有行为)');

// ---- 4. 两档来回切 ----
assert.equal(stageToneNext('immersive'), 'theme');
assert.equal(stageToneNext('theme'), 'immersive');
// 未知值先收敛到默认(immersive)再切,所以结果是 theme —— 关键是不能返回 undefined
assert.equal(stageToneNext('nope'), 'theme', '未知值应先收敛再切,绝不返回 undefined');
assert.equal(stageToneNext(null), 'theme', 'null 同样先收敛再切');
assert.equal(stageToneActionLabel('immersive'), '切换为跟随主题', '沉浸时按钮应说明"切到跟随主题"');
assert.equal(stageToneActionLabel('theme'), '切换为沉浸暗场', '跟随时按钮应说明"切到沉浸暗场"');

// ---- 5. 存储:读写、脏值、异常都不能崩 ----
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
  assert.equal(readStageTone(storage), 'immersive', '空存储应回落到沉浸');

  persistStagePref(storage, STAGE_TONE_KEY, 'theme');
  assert.equal(readStageTone(storage), 'theme', '切换色板必须能持久化');

  // 脏值
  const dirty = makeStorage({ [STAGE_TONE_KEY]: '' });
  assert.equal(readStageTone(dirty), 'immersive', '脏色板应回落到沉浸');

  // Storage 不可用 / 抛错:不能崩,也不能阻断播放页
  assert.equal(readStageTone(null), 'immersive', 'storage 为 null 时回落到默认');
  const throwing = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceeded'); },
  };
  assert.equal(readStageTone(throwing), 'immersive', 'getItem 抛错时必须回落默认');
  assert.equal(
    persistStagePref(throwing, STAGE_TONE_KEY, 'theme'),
    'theme',
    'setItem 抛错时仍应返回本次要用的值(当前会话照常生效)',
  );
  assert.equal(safeStorage(null), null, 'safeStorage 对空目标应返回 null');
  assert.equal(
    safeStorage({ get localStorage() { throw new Error('blocked'); } }),
    null,
    'localStorage getter 抛错时 safeStorage 必须返回 null 而不是抛出',
  );
}

// ---- 6. 样式契约:CSS 里必须有沉浸档的 token 覆盖,否则白底白字 ----
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
  /\.player-stage__backdrop\s*\{[^}]*pointer-events:\s*none/.test(css),
  '整屏封面层必须 pointer-events:none —— 否则它会把整屏的点击全部吃掉',
);
assert.ok(
  /\.player-stage__backdrop\s*\{[^}]*z-index:\s*0/.test(css),
  '整屏封面层需要确定的 z-index,内容层才能稳定压在上面',
);

// ---- 7. 舞台根规则不得声明 display / position / flex-direction ----
//
// 真实陷阱:index.css 的绝大多数规则**不在 @layer 里**,
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
// 两套断点舞台必须各在各位:移动端那张用 lg:hidden,桌面那张用 hidden lg:flex。
{
  const mobileStart = player.indexOf('<div className={`lg:hidden');
  assert.ok(mobileStart > 0, '移动端舞台根节点必须带 lg:hidden(否则手机上会跟桌面那张一起显示)');
  assert.equal(
    (player.match(/className=\{`hidden lg:flex player-stage/g) || []).length,
    1,
    '桌面舞台根节点必须是 hidden lg:flex + player-stage',
  );
}
// 舞台根节点必须仍然是"固定整屏 + 语义层级"
assert.equal(
  (player.match(/fixed inset-0 z-sheet/g) || []).length,
  2,
  '两套舞台都必须 fixed inset-0 z-sheet —— 缺一个就不是沉浸式覆盖层',
);

// ---- 8. 组件契约:桌面舞台恒定沉浸档,顶栏只剩色板切换 ----
//
// 用户 2026-11 明确表态「只要桌面端(PWA)」,移动端整段保持重做前的原样。
// 本次再收缩一次:布局切换整体移除,所以桌面舞台的 class 里必须写死 disc,
// 且不得再从任何"当前档位"派生 —— 否则删了按钮却留下一个空状态,反而更难懂。
assert.match(player, /from '\.\/playerStage\.mjs'/, 'PlayerContext 必须从 playerStage.mjs 取色板规则');
assert.match(player, /from '\.\.\/components\/PlayerStageChrome'/, 'PlayerContext 必须用抽出来的色板控件');
assert.equal(
  (player.match(/<StageToneToggle\b/g) || []).length,
  1,
  '色板切换只应有一处(桌面端)',
);
assert.equal(
  (player.match(/readStageTone\(/g) || []).length,
  1,
  '色板初值只能有一处来源(useState 初始化),多处读会互相覆盖',
);
assert.match(player, /persistStagePref\(/, '切换必须落盘,否则刷新就回到默认');
// 舞台根节点的布局档必须是常量 disc —— 不再有 `player-stage--${stageLayout}` 这种模板拼接
//
// ⚠ 判据必须**剥掉注释**:PlayerContext 里刻意留了一段说明「不再有 stageLayout 状态」,
//   直接对全文 /stageLayout/ 会把那段注释当成残留代码(error 一次,已修)。
const playerCode = player
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');
assert.match(
  player,
  /player-stage--\$\{stageTone\} player-stage--disc /,
  '桌面舞台必须写死 player-stage--disc —— 布局已恒定,不得再从状态派生',
);
assert.ok(
  !/stageLayout/.test(playerCode),
  'PlayerContext 里不得再残留 stageLayout 状态 —— 布局切换已移除,残留状态只会误导后来人',
);

// 切换控件必须落在**桌面端**那段(而不是移动端):以两段注释标题为界切片判断。
{
  const mobileStart = player.indexOf('移动端:全屏展开播放页');
  const desktopStart = player.indexOf('桌面端:全屏沉浸播放页');
  assert.ok(mobileStart > 0, '找不到移动端段落标题(移动端应保持旧版标题)');
  assert.ok(desktopStart > mobileStart, '找不到桌面端段落标题');
  const mobileBlock = player.slice(mobileStart, desktopStart);
  const desktopBlock = player.slice(desktopStart);
  assert.ok(
    !/StageToneToggle/.test(mobileBlock),
    '移动端段落里不得出现色板切换控件 —— 移动端要恢复成重做前的原样',
  );
  assert.ok(
    /StageToneToggle/.test(desktopBlock),
    '桌面端段落里必须有色板切换控件',
  );
  // 移动端必须把旧的隐式切换找回来
  assert.match(mobileBlock, /setShowLyric/, '移动端必须恢复「封面 ↔ 歌词」隐式切换');
  assert.match(mobileBlock, /点击显示歌词/, '移动端必须恢复旧的切换提示文案');
}

// 移动端的歌词滚动仍读 showLyric,桌面端恒定可见 —— 两者不可混用
assert.match(
  player,
  /const mobileLyricsVisible = expanded && showLyric/,
  '移动端歌词可见性必须仍由 showLyric 决定(保持旧行为)',
);
assert.match(
  player,
  /const desktopLyricsVisible = expanded;/,
  '桌面端沉浸档恒定显示歌词区,可见性必须只剩 expanded',
);

// ---- 9. 反向断言:布局切换不得复活 ----
//
// 这条是本次移除的"防回滚"闸门。只删 JSX 但留下状态/样式/样式类,
// 界面看着没问题、构建也过,可下次有人照着旧代码又接回来。
// 所以要求四处同时干净:纯逻辑模块、控件组件、PlayerContext、index.css。
{
  const stageModule = readFileSync(resolve(srcRoot, 'contexts', 'playerStage.mjs'), 'utf8');
  // 三处源码判据统一**剥注释**再断言:这几处都刻意留了「已移除」的说明文字,
  // 直接对全文匹配会把自己写的注释当成残留(error 三次后统一处理)。
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const stageModuleCode = stripComments(stageModule);
  const chromeCode = stripComments(chrome);
  const playerNoComment = stripComments(player);
  for (const [name, why] of [
    ['STAGE_LAYOUTS', 'playerStage.mjs 不得再有布局档清单'],
    ['readStageLayout', 'playerStage.mjs 不得再读布局偏好'],
    ['stageShowsLyrics', 'playerStage.mjs 不得再有"这一档显不显示歌词"的判据'],
  ]) {
    assert.ok(!stageModuleCode.includes(name), `${why}(${name} 已随布局切换一并移除)`);
  }
  assert.ok(
    !/StageLayoutSwitch/.test(chromeCode),
    'PlayerStageChrome.js 不得再导出布局切换控件 —— 用户要求移除那两颗',
  );
  assert.ok(
    !/STAGE_LAYOUT_KEY/.test(playerNoComment),
    'PlayerContext 不得再引用布局存储键',
  );
  // CSS:三档里只有 disc 有自己的样式;lyrics / split 的选择器必须全部消失
  for (const dead of ['.player-stage--lyrics', '.player-stage--split', '.player-stage-switch']) {
    assert.ok(
      !css.includes(dead),
      `index.css 仍残留 ${dead} —— 布局切换已移除,这类选择器不会再被任何元素命中`,
    );
  }
}

// ---- 10. 沉浸档的结构:整屏封面铺满 + 横向渐隐 + 歌词落在渐隐区 + 操作全在底栏 ----
//
// 这条对应两轮真实纠正(2026-11):
//   第一版:「深色底 + 嵌在黑胶里的小圆盘」→ 用户「你那算个几把的沉浸」;
//   第二版:「左边一张封面卡片 + 右边歌词列表」→ 用户「你这做的啥啊,
//           人家的沉浸是把条+操作压缩到底栏,整个背景是专辑(大概一半不透明),
//           剩下一半是渐隐的,渐隐那部分才是歌词」。
// 所以现在锁死的是**结构**,不是某个尺寸数字:
//   ① 封面是**整屏铺满的背景层**,不是"一张卡片";
//   ② 有一层**横向**渐变(左清晰 → 右压暗),歌词落在右侧;
//   ③ 歌名/进度/操作**全部**在底栏里,中部除歌词外不放控件。
{
  // ① 整屏封面:两层分工(接续底色 + 完整显示的封面)
  assert.ok(
    /\.player-stage__backdrop\s*\{/.test(css),
    '缺少 .player-stage__backdrop —— 封面必须是整屏铺满的背景层,不是一张卡片',
  );
  // 上层:高度完整显示,不得 cover 裁切
  const art = css.match(/\.player-stage__backdrop-art\s*\{([\s\S]*?)\n\}/);
  assert.ok(art, '缺少 .player-stage__backdrop-art —— 封面必须"高度完整显示"那一层');
  assert.match(
    art[1],
    /background-size:\s*auto 100%/,
    '封面必须 background-size: auto 100%(高度撑满、宽度按比例)—— '
    + '用 cover 会在 16:9 屏上把正方形封面上下各裁掉约 14%,用户报「上面感觉被裁剪了」',
  );
  assert.ok(
    !/background-size:\s*cover/.test(art[1]),
    '完整显示那一层不得用 cover —— 那就是裁切的来源',
  );
  assert.match(art[1], /background-repeat:\s*no-repeat/, '完整显示的封面不得平铺');
  assert.match(art[1], /background-position:\s*left/, '封面贴左(左边留给清晰封面,右边交给渐隐与歌词)');
  // 底层:接续底色用 cover 铺满并压暗
  const fill = css.match(/\.player-stage__backdrop-fill\s*\{([\s\S]*?)\n\}/);
  assert.ok(fill, '缺少 .player-stage__backdrop-fill —— 封面宽度之外需要接续底色,否则右侧突然变纯黑');
  assert.match(fill[1], /background-size:\s*cover/, '接续底色用 cover 铺满(裁切无所谓)');
  assert.match(fill[1], /brightness\(0?\.\d+\)/, '接续底色必须压暗,不能与真封面抢视线');
  // 接续底色的亮度上限:太亮会在渐隐区继续贡献亮部,看起来像"没隐干净"
  {
    const b = fill[1].match(/brightness\(\s*([\d.]+)\s*\)/);
    assert.ok(b, '接续底色必须有明确的 brightness 值');
    assert.ok(
      Number(b[1]) <= 0.7,
      `接续底色 brightness=${b[1]} 偏亮 —— 它会在渐隐区透出封面的亮部,`
      + '表现为用户报的「渐隐没有隐到完全透明」',
    );
  }

  // 整屏封面层不得模糊(第三次纠正)
  assert.ok(
    !/\.player-stage__backdrop-art\s*\{[^}]*blur\(/.test(css),
    '整屏封面层不得使用 blur —— 它是实图,模糊会让"认不出是哪张专辑"',
  );

  // ② 渐隐层:**以 50% 为中心的柔和渐变**(不是硬边)
  //
  // 这条改过两次,别再来回折腾:
  //   ① 用户「就是50%就要分界线了」+ 圈图 → 意思是歌词区**从 50% 开始**;
  //      我误做成 CSS 硬切(49.9%/50% 成对色标),用户回「不是特么让你直接硬切啊」。
  //   ② 网易云截图:封面是**平滑没入暗处**的,没有任何刀切边。
  // 所以判据是:50% 处 alpha 约在一半左右(过渡中点),且**相邻色标之间不出现大跳变**。
  const scrim = css.match(/\.player-stage__scrim\s*\{([\s\S]*?)\n\}/);
  assert.ok(scrim, '缺少 .player-stage__scrim —— "一半不透明、一半渐隐"就是这一层');
  assert.match(
    scrim[1],
    /linear-gradient\(90deg/,
    '分界必须是**横向** 90deg 渐变(左清晰 → 右压暗)',
  );
  {
    const lines = scrim[1].split('\n');
    let inH = false;
    const stops = [];
    for (const line of lines) {
      if (line.includes('linear-gradient(90deg')) { inH = true; continue; }
      if (inH && line.includes('linear-gradient(180deg')) break;
      if (!inH) continue;
      const at = line.match(/([\d.]+)%\s*,?\s*$/);
      const a = line.match(/\/\s*([\d.]+)\s*\)/);
      if (at && a) stops.push({ at: Number(at[1]), alpha: Number(a[1]) });
    }
    assert.ok(stops.length >= 5, `渐隐层色标太少(${stops.length} 个),过渡会显得生硬`);

    // ① 必须有跨越 50% 的过渡:找到 50% 前后最近的色标并插值
    const before = [...stops].reverse().find((s) => s.at <= 50);
    const after = stops.find((s) => s.at >= 50);
    assert.ok(before && after, '必须有跨越 50% 的色标(过渡中心要在正中)');
    const midAlpha = before.at === after.at
      ? before.alpha
      : before.alpha + ((50 - before.at) / (after.at - before.at)) * (after.alpha - before.alpha);
    assert.ok(
      midAlpha >= 0.45 && midAlpha <= 0.8,
      `50% 处 alpha≈${midAlpha.toFixed(2)} 不在 0.45~0.8 —— 过渡中心应大约"一半不透明"`,
    );

    // ② 不得有硬切:相邻色标的 alpha 跳变必须温和(硬切那次是 +0.82)
    for (let i = 1; i < stops.length; i += 1) {
      const jump = stops[i].alpha - stops[i - 1].alpha;
      assert.ok(
        jump <= 0.4,
        `${stops[i - 1].at}%→${stops[i].at}% 处 alpha 跳变 ${jump.toFixed(2)} 太大 —— 那是硬切,`
        + '网易云是平滑过渡(「不是特么让你直接硬切啊」)',
      );
    }

    // ③ 两端方向:左端要清晰(封面可辨),右端必须**彻底压死**
    //
    // 这条来自第三次纠正:「渐隐没有隐到完全透明吗」——右侧仍透出封面橙色亮部。
    // 根因量过:封面用 auto 100%,其右边缘在屏幕 56%~60%(1080/1920=56.3%);
    // 旧色标 72% 才 .95、100% 才 .97,.95 依然透光。
    // 所以判据收紧:右端必须**恰好 1.0**,并且从"封面右边缘之后"(62%)起就保持 1.0。
    assert.ok(stops[0].alpha <= 0.15, `左端 alpha=${stops[0].alpha} 偏大 —— 封面一开始就被压暗`);
    const last = stops[stops.length - 1];
    assert.ok(
      last.alpha >= 0.999,
      `右端 alpha=${last.alpha} 不是完全不透明 —— 会像用户报的「渐隐没有隐到完全透明」那样漏出封面亮部`,
    );
    // 必须有一个 >=62% 且 alpha=1 的色标(封面右边缘之后立刻彻底压死)
    const sealed = stops.find((s) => s.at >= 60 && s.at <= 70 && s.alpha >= 0.999);
    assert.ok(
      sealed,
      '在 60~70% 之间必须出现 alpha=1 的色标 —— 封面右边缘(约 56~60%)之后要立刻压死,'
      + '否则右侧仍会透出亮部',
    );
    // 62% 之后到结尾必须全是 1.0(不能又降回去)
    const afterSeal = stops.filter((s) => s.at >= sealed.at);
    for (const s of afterSeal) {
      assert.ok(
        s.alpha >= 0.999,
        `${s.at}% 处 alpha=${s.alpha} —— 彻底压死之后不得再变透明`,
      );
    }
    // ④ 单调递增(不能忽明忽暗)
    for (let i = 1; i < stops.length; i += 1) {
      assert.ok(
        stops[i].alpha >= stops[i - 1].alpha - 0.01,
        `${stops[i].at}% 处比前一色标更透明 —— 渐隐出现回跳`,
      );
    }
  }

  // ②b 歌词区必须**从屏幕 50% 开始**(与过渡中点重合)
  const discLyrics = css.match(/\.player-stage--disc \.player-stage__lyrics--desktop\s*\{([\s\S]*?)\n\}/);
  assert.ok(discLyrics, '缺少沉浸档歌词区样式');
  assert.match(discLyrics[1], /text-align:\s*left/, '沉浸档歌词应左对齐');
  assert.match(
    discLyrics[1],
    /width:\s*50vw/,
    '歌词区宽度必须是 50vw —— 用 % 是相对(去掉了 padding 的)父容器算的,'
    + '起点会偏离屏幕正中',
  );
  const discBody = css.match(/\.player-stage--disc \.player-stage__body\s*\{([\s\S]*?)\n\}/);
  assert.ok(discBody, '缺少沉浸档 body 规则');
  assert.match(
    discBody[1],
    /padding:\s*0/,
    '沉浸档 body 必须 padding:0 —— 留着左右 padding 会让歌词起点偏离 50%',
  );

  // ③ 操作全部在底栏:底栏必须有信息区 + 进度的通栏轨道 + 控制三部分
  assert.match(player, /player-stage__dock-inner/, '底栏缺少内层容器(它承载三段布局)');
  assert.match(player, /player-stage__now-title/, '底栏缺少歌名(用户要求信息压进底栏)');
  const dockInner = css.match(/\.player-stage__dock-inner\s*\{([\s\S]*?)\n\}/);
  assert.ok(dockInner, '缺少 .player-stage__dock-inner 样式');
  // 2026-11 网易云式重做:中间那组必须**真正居中**,所以三段用 flex
  // (左右两条各 flex:1 等分,中间 flex-shrink:0 —— 几何中心恒定)。
  // 旧版用 grid 三等分,中间会被左右栏宽度差异推偏。
  assert.match(
    dockInner[1],
    /display:\s*flex/,
    '底栏三段必须用 flex(左右各 flex:1 等分,中间才落在几何中心)',
  );
  assert.match(player, /player-stage__controls--desktop/, '底栏缺少中间控制组');
  assert.match(player, /player-stage__tools/, '底栏缺少右工具组');
  // 左右两条必须**等分弹性宽度**(flex:1 1 0),否则中间那组会被推偏
  const nowRule = css.match(/\.player-stage__now\s*\{([^}]*)\}/);
  assert.ok(nowRule, '缺少 .player-stage__now —— 左信息区');
  assert.match(nowRule[1], /flex:\s*1\s+1\s+0/, '左信息必须 flex:1 1 0(与右工具等分,中间才居中)');
  const toolsRule = css.match(/\.player-stage__tools\s*\{([^}]*)\}/);
  assert.ok(toolsRule, '缺少 .player-stage__tools —— 右工具组');
  assert.match(toolsRule[1], /flex:\s*1\s+1\s+0/, '右工具必须 flex:1 1 0(与左信息等分)');

  // 中部不得再放大封面卡片 —— 封面已在背景里
  const desktopStart = player.indexOf('桌面端:全屏沉浸播放页');
  assert.ok(desktopStart > 0, '找不到桌面舞台段落');
  const desktopBlock = player.slice(desktopStart);
  assert.ok(
    !/player-stage__art-frame|player-stage__art-img/.test(desktopBlock),
    '桌面舞台不得再有"封面卡片"结构 —— 封面必须是整屏背景层,不是左半边一张图',
  );
  assert.ok(
    !/vinyl-wrap|turntable|tonearm/.test(desktopBlock),
    '桌面舞台不得出现黑胶圆盘(vinyl-wrap/turntable/tonearm)',
  );
  // 沉浸档歌词区的位置与宽度已在 ②b 校验(50vw + 与 50% 分界线重合),此处不重复。
}

// ---- 11. 歌词"当前行"必须比普通行更大更亮(沉浸感的来源) ----
//
// 用户给了网易云参考图,那里最显眼的特征就是**当前行明显更大更亮**。
// 只改颜色不改字号,整块歌词看起来是"一片均匀的灰",没有正在唱的那一句。
// 这里直接把两条规则算成 px 互相比 —— 比较的是真实 CSS 值,不是写死的期望数字。
{
  const px = (selectorRe) => {
    const m = css.match(selectorRe);
    if (!m) return null;
    const raw = m[1].trim();
    const num = parseFloat(raw);
    if (!Number.isFinite(num)) return null;
    return raw.endsWith('rem') ? num * 16 : num;
  };
  const normal = px(/\.player-stage__lyrics--desktop \.player-lyric-line \{\s*font-size:\s*([^;]+);/);
  const active = px(/\.player-stage--disc \.player-stage__lyrics--desktop \.player-lyric-line\[data-active="true"\] \{\s*font-size:\s*([^;]+);/);
  assert.ok(normal != null, '找不到普通行字号规则');
  assert.ok(active != null, '找不到当前行字号规则 —— 当前行不会变大');
  assert.ok(
    active > normal,
    `当前行 ${active}px 必须大于普通行 ${normal}px —— 否则整块歌词是一片均匀的灰`,
  );
  // 当前行还要更亮:普通行带透明度,当前行不带
  const normalColor = css.match(/\.player-stage \.player-lyric-line\s*\{[^}]*color:\s*hsl\(var\(--foreground\) \/ ([\d.]+)\)/);
  assert.ok(normalColor, '普通歌词行必须带透明度(压暗),当前行才显得突出');
  const alpha = Number(normalColor[1]);
  assert.ok(
    alpha > 0.3 && alpha < 0.7,
    `普通行透明度 ${alpha} 不在合理区间(0.3~0.7);太小=看不见,太大=当前行不突出`,
  );
  assert.match(
    css,
    /\.player-stage \.player-lyric-line\[data-active="true"\] \{\s*color:\s*hsl\(var\(--foreground\)\)/,
    '当前行必须是不透明的纯前景色',
  );
}

// ---- 12. 舞台类必须都有样式:不能"JSX 用了、CSS 没有" ----
//
// 真实事故(2026-11,上线后用户截图"？？？？？？？？"):大段重写舞台 CSS 时,
// `.player-stage__controls` 的**基础块**被整个漏掉,只剩 `--desktop` 修饰类。
// 后果:控制行失去 display:flex,收藏/模式/定时/上下首/播放/音量各占一行堆在左下角,
// 整个底部塌掉。当时 grep 只搜到第 941 行的共享选择器(z-index 那一组),
// 看起来"它还在",实际只是参与了一条无关规则。
// 同类漏掉的还有 __title / __artist / __body--desktop。
// 构建、其他门禁全都不报 —— 只有人眼看得见。所以这里静态扫。
{
  // 只审 JSX 侧的用法
  const usedInJsx = new Set();
  for (const m of player.matchAll(/(player-stage[a-zA-Z0-9_-]*)/g)) usedInJsx.add(m[1]);
  usedInJsx.delete('player-stage');
  usedInJsx.delete('player-stage--'); // 模板字符串拼接产生的前缀残片
  // ★ 模板拼接 `player-stage--${stageTone}` 的产物在 JSX 里只是变量名,
  //   实际类名由 STAGE_TONES 决定;这里显式排除那个变量名本身。
  usedInJsx.delete('player-stage--${stageTone}');
  const missing = [...usedInJsx]
    .filter((c) => !c.includes('${'))
    .filter((c) => !css.includes(`.${c}`))
    .sort();
  assert.deepEqual(
    missing,
    [],
    `这些舞台类在 JSX 里用了、CSS 里却从未出现(裸渲染):${missing.join(', ')}`,
  );

  // 控制行基础块必须自带 display:flex(那次事故的直接成因)
  const controlsRule = css.match(/\.player-stage__controls\s*\{([^}]*)\}/);
  assert.ok(controlsRule, '缺少 .player-stage__controls 基础块 —— 控制按钮会堆成多行');
  assert.match(
    controlsRule[1],
    /display:\s*flex/,
    '.player-stage__controls 必须自带 display:flex —— 只写 --desktop 修饰类不会让它变成一行',
  );

  // ★ 所有布局区块都必须自带 display(flex 或 grid)。
  //   这批块曾经**一起**被重写脚本吃掉(它们作为 z-index 共享选择器出现在一处,
  //   grep 只看到那一处就会误判"还在")。逐个列出来,漏一个就红。
  const mustDisplay = [
    ['__top', '.player-stage__top'],
    ['__body', '.player-stage__body'],
    ['__controls', '.player-stage__controls'],
    ['__progress--wide', '.player-stage__progress--wide'],
    ['__dock-inner', '.player-stage__dock-inner'],
  ];
  for (const [name, selector] of mustDisplay) {
    const rule = css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
    assert.ok(rule, `缺少 ${selector} 的独立声明块 —— 它只出现在共享选择器里等于没有样式`);
    assert.match(
      rule[1],
      /display:\s*(flex|grid)/,
      `${selector} 必须自带 display:flex|grid(否则 ${name} 会塌成竖排/堆叠)`,
    );
  }
  // __progress / __dock 不一定要 flex/grid,但必须有独立块(不能被吃成空壳)
  for (const selector of ['.player-stage__progress', '.player-stage__dock']) {
    assert.ok(
      css.includes(`${selector} {`) || css.includes(`${selector}{`),
      `缺少 ${selector} 的独立声明块 —— 它只出现在共享选择器里等于没有样式`,
    );
  }

  // 舞台里的标题/歌手也要有样式(移动队列会用)
  assert.ok(css.includes('.player-stage__title'), '缺少 .player-stage__title —— 队列标题会裸渲染');
  assert.ok(css.includes('.player-stage__artist'), '缺少 .player-stage__artist');
}

// 播放页仍必须能被返回键收掉(这条是 backLayers 门禁的补充,防止重做时漏挂)
assert.match(player, /useBackLayer\(\{[\s\S]{0,200}?name:\s*'player-sheet'/, '舞台必须仍挂返回栈');

// ---- 13. 底栏「按网易云图2 重做」的结构契约 ----
//
// 用户给的网易云截图里,那条底栏有四个一眼可辨的特征。这里逐条钉死 ——
// 它们全是「画错了界面上立刻看得出来、但构建/单测全都不报」的一类:
//   ① **通栏贴底 + 直角 + 实色**:不是浮在封面上的圆角毛玻璃卡片;
//   ② **进度线在顶边、通栏整宽**:不是中间一段短滑块;
//   ③ **进度点与时间胶囊**都跟着同一个进度值走(两份各算会错位);
//   ④ **三段分布**,中间那组几何居中(左右两条等分弹性宽度)。
{
  // ⚠ .player-stage__dock 在 CSS 里出现**两次**:一次是 z-index 共享选择器组
  //   (__top/__body/__dock 三者共用),一次是它自己的样式块。
  //   按"第一个匹配"取会拿到共享块(只有 position/z-index),断言全部落空。
  //   所以这里取**最后一个**带 background 的块 —— 也就是真正定义外观的那个。
  const dockBlocks = [...css.matchAll(/\.player-stage__dock\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(dockBlocks.length >= 2, `.player-stage__dock 应有共享块 + 样式块两处,实际 ${dockBlocks.length} 处`);
  const dockBody = dockBlocks.find((b) => b.includes('background')) || '';
  assert.ok(dockBody, '找不到 .player-stage__dock 的样式块(带 background 的那一块)');
  assert.ok(
    !/border-radius/.test(dockBody),
    '底栏不得有圆角 —— 网易云图2 是通栏贴底的直边条,不是浮起的圆角卡片',
  );
  assert.ok(
    !/backdrop-filter/.test(dockBody),
    '底栏不得是毛玻璃 —— 图里那条是实色,不透出封面',
  );
  assert.match(
    dockBody,
    /background-color:\s*hsl\(var\(--background\)\)/,
    '底栏必须是纯色背景(不是带 alpha 的半透明)',
  );

  // ② 进度线
  assert.ok(/\.player-stage__rail\s*\{/.test(css), '缺少 .player-stage__rail —— 通栏进度线');
  const rail = css.match(/\.player-stage__rail\s*\{([^}]*)\}/);
  assert.match(rail[1], /height:\s*var\(--rail-height\)/, '进度线高度必须走 --rail-height 变量');
  assert.match(rail[1], /overflow:\s*visible/, '进度线容器不得裁切 —— 时间胶囊要探到线的上方');
  assert.match(player, /--rail-progress/, '进度百分比必须由 rail 容器统一给出(圆点与胶囊共用同一源值)');
  assert.equal(
    (player.match(/'--rail-progress':/g) || []).length,
    1,
    '--rail-progress 只能有一处**赋值** —— 写两份会让圆点与胶囊错位',
  );

  // ③ 进度点 / 时间胶囊
  const knob = css.match(/\.player-stage__rail-knob\s*\{([^}]*)\}/);
  assert.ok(knob, '缺少 .player-stage__rail-knob —— 白色进度点');
  assert.match(knob[1], /pointer-events:\s*none/, '进度点不得吃事件(要和底下透明的 input 抢拖动)');
  assert.match(knob[1], /clamp\(/, '进度点位置必须 clamp 两端 —— 否则 0%/100% 有半个圆被裁掉');
  const pill = css.match(/\.player-stage__time-pill\s*\{([^}]*)\}/);
  assert.ok(pill, '缺少 .player-stage__time-pill —— 黑底时间胶囊');
  assert.match(pill[1], /hsl\(0 0% 0%/, '时间胶囊必须是黑底(与参考图一致,不用主题色)');
  assert.match(pill[1], /clamp\(/, '时间胶囊位置必须 clamp 两端,靠近 0%/100% 时不得溢出');
  // 胶囊在**线的上方**(参考图实测:胶囊 y=4..44,线 y=60..71)
  assert.match(
    pill[1],
    /bottom:\s*calc\(100%/,
    '时间胶囊必须悬在进度线**上方**(bottom: calc(100% + …));写成 top 会压住歌名那一行',
  );

  // ④ 三段 + 中间居中
  const nowRule = css.match(/\.player-stage__now\s*\{([^}]*)\}/);
  const toolsRule2 = css.match(/\.player-stage__tools\s*\{([^}]*)\}/);
  assert.ok(nowRule && toolsRule2, '底栏必须有左信息(.player-stage__now)与右工具(.player-stage__tools)');
  assert.match(nowRule[1], /flex:\s*1\s+1\s+0/, '左信息必须 flex:1 1 0');
  assert.match(toolsRule2[1], /flex:\s*1\s+1\s+0/, '右工具必须 flex:1 1 0(与左信息等分,中间才居中)');
  const ctrlDesktop = css.match(/\.player-stage__controls--desktop\s*\{([^}]*)\}/);
  assert.ok(ctrlDesktop, '缺少 .player-stage__controls--desktop');
  assert.match(ctrlDesktop[1], /justify-content:\s*center/, '中间控制组必须居中(网易云那五颗就钉在正中)');

  // 音质徽章:参考图右侧「极高」那个描边小框
  assert.match(player, /player-stage__quality/, '底栏右工具组缺少音质徽章(参考图的「极高」位置)');
  const quality = css.match(/\.player-stage__quality\s*\{([^}]*)\}/);
  assert.ok(quality, '缺少 .player-stage__quality 样式');
  assert.match(quality[1], /border:\s*1px solid/, '音质徽章必须是描边方框(与参考图一致)');

  // 舞台队列浮层:这颗按钮在底栏里,浮层必须真的存在,否则点了什么都不出现
  assert.match(player, /player-stage__queue-pop/, '舞台队列按钮必须配一个实际渲染的浮层(否则点了没反应)');
  const queuePop = css.match(/\.player-stage__queue-pop\s*\{([^}]*)\}/);
  assert.ok(queuePop, '缺少 .player-stage__queue-pop 样式');
  assert.match(queuePop[1], /max-height/, '队列浮层必须有最大高度(否则长队列会撑出屏幕)');
  assert.match(queuePop[1], /overflow-y:\s*auto/, '队列浮层必须可滚');
}

console.log('playerStage tests passed');
