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
assert.deepEqual(STAGE_LAYOUTS, ['disc', 'lyrics', 'split'], '布局三档必须是 沉浸/歌词/封面');
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

// ---- 2. 默认值:桌面默认就是**沉浸档**(大封面 + 右侧歌词),色板默认沉浸暗场 ----
//
// 这条是本次重做的核心诉求:用户要的是"封面当主角、占半壁"的那种沉浸,
// 不是"深色底 + 小圆盘"。默认档搞错,用户打开第一眼就是错的。
assert.equal(
  defaultStageLayout(true),
  'disc',
  '桌面默认必须是沉浸档(大封面 + 右侧歌词)—— 打开播放页就该是用户点名要的那一屏',
);
assert.equal(defaultStageTone(), 'immersive', '色板默认应为沉浸暗场');
// 沉浸档必须真的带歌词区(否则"右侧歌词"就没了)
assert.equal(
  stageShowsLyrics(defaultStageLayout(true)),
  true,
  '默认档必须显示歌词区 —— 用户要的是"封面占半壁 + 右侧歌词",不是纯封面页',
);
// 档位中文名必须与语义一致(改名前叫"唱片/双栏",现在是"沉浸/歌词/封面")
assert.equal(STAGE_LAYOUT_LABELS.disc, '沉浸', 'disc 档的对外名称必须是「沉浸」');
assert.equal(STAGE_LAYOUT_LABELS.lyrics, '歌词');
assert.equal(STAGE_LAYOUT_LABELS.split, '封面', 'split 档是"只有大封面",不是"双栏"');

// ---- 3. 非法值必须收敛,绝不返回空 ----
assert.equal(normalizeStageLayout('lyrics', true), 'lyrics', '合法值应原样返回');
assert.equal(normalizeStageLayout(' ', true), 'disc', '空白应收敛到默认(沉浸)');
assert.equal(normalizeStageLayout(null, false), 'disc', 'null 应收敛到默认');
assert.equal(normalizeStageLayout(42, false), 'disc', '非字符串应收敛到默认');
assert.equal(normalizeStageLayout('DISC', false), 'disc', '大小写应被容忍');
assert.equal(normalizeStageTone('theme'), 'theme', '合法色板应原样返回');
assert.equal(normalizeStageTone('nope'), 'immersive', '未知色板应收敛到默认');
assert.equal(normalizeStageTone(null), 'immersive', 'null 色板应收敛到默认');

// ---- 4. 「这一档显不显示歌词」是唯一判据 ----
// 自动滚动与滚动区挂载都读它。新语义:
//   disc(沉浸)= 大封面 + 右侧歌词 → 有歌词
//   lyrics      = 歌词独占 → 有歌词
//   split(封面)= 只有大封面 → 无歌词
// 写成 === 'lyrics' 会让默认的沉浸档不再自动居中(用户报的正是"歌词不跟"那一类)。
assert.equal(stageShowsLyrics('lyrics'), true, '歌词档必须有歌词');
assert.equal(stageShowsLyrics('disc'), true, '沉浸档有右侧歌词面板,必须为 true');
assert.equal(stageShowsLyrics('split'), false, '封面档不显示歌词');
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
  assert.equal(readStageLayout(storage, true), 'disc', '空存储应回落到默认(沉浸)');
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
  assert.equal(readStageLayout(null, true), 'disc', 'storage 为 null 时回落到默认');
  assert.equal(readStageTone(null), 'immersive', 'storage 为 null 时回落到默认');
  const throwing = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceeded'); },
  };
  assert.equal(readStageLayout(throwing, true), 'disc', 'getItem 抛错时必须回落默认(无痕模式不能崩)');
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
  /\.player-stage__backdrop\s*\{[^}]*pointer-events:\s*none/.test(css),
  '整屏封面层必须 pointer-events:none —— 否则它会把整屏的点击全部吃掉',
);
assert.ok(
  /\.player-stage__backdrop\s*\{[^}]*z-index:\s*0/.test(css),
  '整屏封面层需要确定的 z-index,内容层才能稳定压在上面',
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
// 两套断点舞台必须各在各位:移动端那张用 lg:hidden,桌面那张用 hidden lg:flex。
// 不按"连在一起的字符串"匹配 —— 移动端恢复旧版后类名顺序/内容都变了,按段落判更稳。
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

// ---- 9. 组件契约:切换控件只出现在**桌面端** ----
//
// 用户 2026-11 明确表态「只要桌面端(PWA)」,移动端整段保持重做前的原样。
// 所以这条不再是"两端各一处",而是"恰好一处,且在桌面端那段里"。
assert.match(player, /from '\.\/playerStage\.mjs'/, 'PlayerContext 必须从 playerStage.mjs 取档位规则');
assert.match(player, /from '\.\.\/components\/PlayerStageChrome'/, 'PlayerContext 必须用抽出来的切换控件');
assert.equal(
  (player.match(/<StageLayoutSwitch\b/g) || []).length,
  1,
  '切换控件只能出现一处(桌面端舞台)—— 两端都挂就等于又改成"两端一起做"了',
);
assert.equal(
  (player.match(/<StageToneToggle\b/g) || []).length,
  1,
  '色板切换同样只应有一处(桌面端)',
);
assert.equal(
  (player.match(/readStageLayout\(/g) || []).length,
  1,
  '布局初值只能有一处来源(useState 初始化),多处读会互相覆盖',
);
assert.match(player, /persistStagePref\(/, '切换必须落盘,否则刷新就回到默认');

// 切换控件必须落在**桌面端**那段(而不是移动端):以两段注释标题为界切片判断。
{
  const mobileStart = player.indexOf('移动端:全屏展开播放页');
  const desktopStart = player.indexOf('桌面端:全屏沉浸播放页');
  assert.ok(mobileStart > 0, '找不到移动端段落标题(移动端应保持旧版标题)');
  assert.ok(desktopStart > mobileStart, '找不到桌面端段落标题');
  const mobileBlock = player.slice(mobileStart, desktopStart);
  const desktopBlock = player.slice(desktopStart);
  assert.ok(
    !/StageLayoutSwitch|StageToneToggle/.test(mobileBlock),
    '移动端段落里不得出现舞台切换控件 —— 移动端要恢复成重做前的原样',
  );
  assert.ok(
    /StageLayoutSwitch/.test(desktopBlock),
    '桌面端段落里必须有布局切换控件',
  );
  // 移动端必须把旧的隐式切换找回来
  assert.match(mobileBlock, /setShowLyric/, '移动端必须恢复「封面 ↔ 歌词」隐式切换');
  assert.match(mobileBlock, /点击显示歌词/, '移动端必须恢复旧的切换提示文案');
}

// 移动端的歌词滚动仍读 showLyric,桌面端读舞台档位 —— 两者不可混用
assert.match(
  player,
  /const mobileLyricsVisible = expanded && showLyric/,
  '移动端歌词可见性必须仍由 showLyric 决定(保持旧行为)',
);
assert.match(
  player,
  /const desktopLyricsVisible = expanded && stageShowsLyrics\(stageLayout\)/,
  '桌面端歌词可见性必须由舞台布局档决定,且经 stageShowsLyrics 判断(双栏也有歌词区)',
);

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
  // ① 整屏封面层必须存在,且用 background-size:cover 铺满(不是 contain 露边)
  assert.ok(
    /\.player-stage__backdrop\s*\{/.test(css),
    '缺少 .player-stage__backdrop —— 封面必须是整屏铺满的背景层,不是一张卡片',
  );
  const backdropImg = css.match(/\.player-stage__backdrop-img\s*\{([\s\S]*?)\n\}/);
  assert.ok(backdropImg, '缺少 .player-stage__backdrop-img');
  assert.match(backdropImg[1], /background-size:\s*cover/, '封面必须 cover 铺满(contain 会露黑边,就不是整屏背景了)');
  // ★ 整屏封面**不得再模糊**(2026-11 第三次纠正:"专辑放大糊成啥样了")。
  //   整屏放大了数倍,哪怕 6px 的 blur 视觉上也等于十几像素的糊;叠加小尺寸源图就更明显。
  assert.ok(
    !/blur\(/.test(backdropImg[1]),
    '整屏封面层不得使用 blur —— 它是实图铺满,模糊会让"认不出是哪张专辑";'
    + '小图偏软是源图限制,应换更大的源(网易云支持 ?param=WxH),不要靠模糊掩盖',
  );
  // 也不要为了配 blur 而放大(放大既损失锐度又不必要)
  assert.ok(
    !/scale\(\s*1\.[0-9]/.test(backdropImg[1]),
    '整屏封面不得 scale 放大 —— inset:0 + cover 已铺满,放大只会更糊',
  );

  // ② 横向渐隐层:必须存在 90deg 的 linear-gradient,且左侧透明、右侧接近实心
  const scrim = css.match(/\.player-stage__scrim\s*\{([\s\S]*?)\n\}/);
  assert.ok(scrim, '缺少 .player-stage__scrim —— "一半不透明、一半渐隐"就是这一层');
  assert.match(
    scrim[1],
    /linear-gradient\(90deg/,
    '渐隐必须是**横向** 90deg 渐变(左清晰 → 右压暗),竖向压暗做不出"一半不透明"的效果',
  );
  // 左侧那一段必须几乎透明(封面原样可见)
  assert.match(
    scrim[1],
    /0\.0[0-9]/,
    '渐隐层最左侧必须接近透明(0.0x)—— 否则封面一开始就被压暗,看不出专辑',
  );
  // 右侧必须接近实心(歌词要读得清)
  assert.match(
    scrim[1],
    /0\.9[0-9]/,
    '渐隐层最右侧必须接近实心(0.9x)—— 否则亮封面会把歌词吞掉',
  );

  // ③ 操作全部在底栏:底栏必须有信息区 + 进度 + 控制三部分
  assert.match(player, /player-stage__dock-inner/, '底栏缺少内层容器(它承载三栏布局与半透明底)');
  assert.match(player, /player-stage__now-title/, '底栏缺少歌名(用户要求信息压进底栏)');
  const dockInner = css.match(/\.player-stage__dock-inner\s*\{([\s\S]*?)\n\}/);
  assert.ok(dockInner, '缺少 .player-stage__dock-inner 样式');
  assert.match(dockInner[1], /grid-template-columns/, '底栏三栏必须用 grid 分栏(用 flex+固定宽度会在窄窗换行)');
  assert.match(dockInner[1], /backdrop-filter:\s*blur/, '底栏应是半透明毛玻璃(让封面透出来一点)');

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

  // 沉浸档歌词落在右侧渐隐区
  const discLyrics = css.match(/\.player-stage--disc \.player-stage__lyrics--desktop\s*\{([\s\S]*?)\n\}/);
  assert.ok(discLyrics, '缺少沉浸档歌词区样式');
  assert.match(discLyrics[1], /text-align:\s*left/, '沉浸档歌词应左对齐');
  assert.match(discLyrics[1], /width:\s*min\(5[0-9]%/, '沉浸档歌词应占右侧约一半宽度(落在渐隐区上)');
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
  const pairs = [
    [
      '沉浸档',
      /\.player-stage__lyrics--desktop \.player-lyric-line \{\s*font-size:\s*([^;]+);/,
      /\.player-stage--disc \.player-stage__lyrics--desktop \.player-lyric-line\[data-active="true"\] \{\s*font-size:\s*([^;]+);/,
    ],
    [
      '歌词档',
      /\.player-stage--lyrics \.player-stage__lyrics--desktop \.player-lyric-line \{\s*font-size:\s*([^;]+);/,
      /\.player-stage--lyrics \.player-stage__lyrics--desktop \.player-lyric-line\[data-active="true"\] \{\s*font-size:\s*([^;]+);/,
    ],
  ];
  for (const [name, normalRe, activeRe] of pairs) {
    const normal = px(normalRe);
    const active = px(activeRe);
    assert.ok(normal != null, `${name}: 找不到普通行字号规则`);
    assert.ok(active != null, `${name}: 找不到当前行字号规则 —— 当前行不会变大`);
    assert.ok(
      active > normal,
      `${name}: 当前行 ${active}px 必须大于普通行 ${normal}px —— 否则整块歌词是一片均匀的灰`,
    );
  }
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
  const used = new Set();
  for (const src of [player, css]) {
    for (const m of src.matchAll(/(player-stage[a-zA-Z0-9_-]*)/g)) used.add(m[1]);
  }
  // 只审 JSX 侧的用法
  const usedInJsx = new Set();
  for (const m of player.matchAll(/(player-stage[a-zA-Z0-9_-]*)/g)) usedInJsx.add(m[1]);
  usedInJsx.delete('player-stage');
  usedInJsx.delete('player-stage--'); // 模板字符串拼接产生的前缀残片
  const missing = [...usedInJsx].filter((c) => !css.includes(`.${c}`)).sort();
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
  //   判据是"有没有布局声明",不是"必须 flex" —— 底栏用 grid 分三栏是更好的选择。
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

console.log('playerStage tests passed');
