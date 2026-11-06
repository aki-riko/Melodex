import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptDir, '..');
const read = (rel) => readFileSync(resolve(frontendRoot, rel), 'utf8');

// 「更多」页的形态契约。
//
// 背景:它原本是底部 Tab 弹出的半屏抽屉(fixed bottom sheet)。抽屉要同时装
// 导航入口和**我的歌单全列表**,歌单一多就被 75vh 高度上限逼成嵌套滚动,
// 而且没有真实 URL(不能直达/刷新/前进后退)。改成一级页面 #more 后这些都不成立。
//
// 这条测试锁的就是"别又改回抽屉":抽屉形态会重新引入上述三个问题,
// 而构建和视觉检查都发现不了(它看起来一样能点)。

const shell = read('src/components/Sidebar.js');
const app = read('src/App.js');
const more = read('src/components/MorePage.js');

// ---- 1. 路由必须认识 More ----
assert.ok(
  /VALID_SECTIONS\s*=\s*\[[^\]]*'More'/.test(app),
  "App.js 的 VALID_SECTIONS 必须包含 'More' —— 否则 #more 解析不出来会被兜底回首页",
);
assert.ok(
  /section === 'More' && <MorePage/.test(app),
  'App.js 必须真的渲染 <MorePage> —— 只加进 VALID_SECTIONS 但没渲染会是空白页',
);

// ---- 2. 底部 Tab 的「更多」必须是链接(页面切换),不是按钮(弹层) ----
assert.ok(
  /href="#more"/.test(shell),
  '底部 Tab 的「更多」必须是 href="#more" 的链接,才能直达/刷新/前进后退',
);
// 锁「移动 Tab 组件内部」没有任何 aria-expanded:
// 页面切换的表达是 aria-current,aria-expanded 专属于"弹层展开"。
// 不写 aria-expanded={moreOpen} 这种具体形式 —— 突变时改写成 {false}
// 就会漏过去(实测踩到过),必须锁住这个属性本身。
// 注意只检查 MobileTabBar 那一段:桌面侧栏 PlaylistNav 的「+」菜单是**真正的
// 弹出菜单**,那里用 aria-expanded 是正确语义,不能一并禁掉。
const tabBarStart = shell.indexOf('export function MobileTabBar');
assert.ok(tabBarStart >= 0, '找不到 MobileTabBar,测试需要更新锚点');
// 必须先剥注释:本文件里就有解释"为什么不用 aria-expanded"的注释,
// 直接正则扫会把说明文字当成违规(实测踩到过,测试自伤)。
const stripComments = (text) => text
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
const tabBarSection = stripComments(shell.slice(tabBarStart));
assert.ok(
  !/aria-expanded/.test(tabBarSection),
  '「更多」已是页面,MobileTabBar 里不得出现 aria-expanded —— 那是"弹层已展开"的语义,页面切换应该用 aria-current',
);
assert.ok(
  !/setMoreOpen/.test(shell),
  'Sidebar 里不应再有 moreOpen 状态:改成页面后没有"打开/关闭"这回事',
);

// ---- 3. 不得残留抽屉的浮层结构 ----
assert.ok(
  !/max-h-\[75vh\]/.test(shell) && !/rounded-t-2xl/.test(shell),
  'Sidebar 里不得残留底部抽屉容器(max-h-[75vh] / rounded-t-2xl)',
);
// 抽屉是 aria-modal 的对话框;页面不该有这个语义。
assert.ok(
  !/role="dialog"/.test(tabBarSection),
  'MobileTabBar 里不应带 role="dialog"/aria-modal(那是模态浮层的语义)',
);

// ---- 4. 页面本身要承接原抽屉的全部内容 ----
for (const label of ['最近播放', '设置', '帮助']) {
  assert.ok(more.includes(label), `MorePage 必须保留导航项「${label}」`);
}
assert.ok(more.includes('用户管理'), 'MorePage 必须保留「用户管理」(仅管理员可见)');
assert.ok(/isAdmin/.test(more), '「用户管理」必须按 isAdmin 条件渲染,不能对普通用户露出');
assert.ok(more.includes('我的歌单'), 'MorePage 必须保留「我的歌单」分组');
assert.ok(
  /collections\.map/.test(more),
  'MorePage 必须列出全部歌单(这正是它取代抽屉的理由:抽屉高度装不下)',
);
assert.ok(
  /requestOpenPlaylist/.test(more),
  '点歌单必须经 requestOpenPlaylist 通知详情页打开,参数与桌面侧栏保持一致',
);
assert.ok(
  /logout/.test(more) && /退出/.test(more),
  'MorePage 必须保留退出登录入口(原先在抽屉头部)',
);

// ---- 5. 只在移动端出现 ----
// 桌面左侧栏已经平铺了同样的内容,再给一个「更多」页属于重复导航。
assert.ok(
  /lg:hidden/.test(more),
  'MorePage 必须 lg:hidden —— 桌面端由左侧栏承担,避免重复导航',
);

console.log('morePage tests passed');
