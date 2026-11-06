import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROUTE_DEPTH_KEY,
  canGoBackInApp,
  goBackInApp,
  pushRouteEntry,
  readRouteDepth,
} from '../src/contexts/routeHistory.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptDir, '..');
const read = (rel) => readFileSync(resolve(frontendRoot, rel), 'utf8');

// 「返回上一页」必须是**沿历史后退**,不能猜一个固定目标。
//
// 真实 bug(用户报的):点进歌单后按返回,**直接掉回首页**。
// 原因就是上一版把路由回退写死成 `navigate('Home')` ——
// "上一页"被替换成了"首页",从 #more → 歌单 → 返回时路径被抹平。
// 这条测试锁住:回退沿历史走、且只有真的存在站内上一页时才后退。

// 最小 history 模拟(带 state 与真实回退)。
const makeHistory = (initialState = null) => {
  // 入口页自身也算一条,它的 state 决定"还能不能退"。
  const entries = [{ state: initialState }];
  let index = 0;
  const api = {
    get state() { return entries[index].state; },
    pushState(state, _title, url) {
      entries.splice(index + 1);
      entries.push({ state, url });
      index += 1;
    },
    back() {
      if (index <= 0) return false;
      index -= 1;
      api.onPop?.();
      return true;
    },
    onPop: null,
    depth: () => index,
    length: () => entries.length,
    currentUrl: () => entries[index].url,
  };
  return api;
};

// ---- 1. 入口页(深链接/刷新)没有站内上一页 ----
{
  const history = makeHistory(null);
  assert.equal(readRouteDepth(history), 0, '没有深度标记时必须是 0');
  assert.equal(canGoBackInApp(history), false, '入口页不应声称能后退 —— 否则用户退不出去');
  assert.equal(goBackInApp(history), false, '入口页后退必须返回 false,交给系统退出');
  assert.equal(history.depth(), 0, '入口页不得真的移动历史指针');
}

// ---- 2. 每前进一页深度 +1,并能真的后退 ----
{
  const history = makeHistory(null);
  assert.equal(pushRouteEntry('home', { history }), 1);
  assert.equal(readRouteDepth(history), 1);
  assert.equal(canGoBackInApp(history), true, '进过一页后必须能后退');

  assert.equal(pushRouteEntry('more', { history }), 2);
  assert.equal(pushRouteEntry('myplaylist/7', { history }), 3);
  assert.equal(history.depth(), 3);

  // 后退一步应回到 #more,而不是跳回 #home。
  assert.equal(goBackInApp(history), true);
  assert.equal(history.depth(), 2);
  assert.equal(history.currentUrl(), '#more', '从歌单返回必须回到来路(#more),不能跳到首页');

  // 再退一步到 #home —— 此时深度仍是 1(入口页之上的一层),所以还能再退一次。
  assert.equal(goBackInApp(history), true);
  assert.equal(history.currentUrl(), '#home');
  assert.equal(readRouteDepth(history), 1, '停在 #home 时深度为 1(我们是从入口页前进过来的)');

  // 最后一步退回到入口页:深度归 0,此后不得再退。
  assert.equal(goBackInApp(history), true);
  assert.equal(readRouteDepth(history), 0, '回到入口页后深度必须归 0');
  assert.equal(
    goBackInApp(history),
    false,
    '深度为 0 时必须返回 false,交给系统退出 —— 否则用户永远退不出 App',
  );
}

// ---- 3. pushRouteEntry 必须写 hash 进 URL,也要写深度进 state ----
{
  const history = makeHistory(null);
  pushRouteEntry('myplaylist/42', { history });
  assert.equal(history.currentUrl(), '#myplaylist/42', 'URL hash 必须正确,否则刷新会丢页面');
  assert.equal(history.state[ROUTE_DEPTH_KEY], 1, 'state 里必须有深度标记');
  // 传进来的 hash 带不带 # 都要能用
  const h2 = makeHistory(null);
  pushRouteEntry('#settings', { history: h2 });
  assert.equal(h2.currentUrl(), '#settings', '带 # 前缀的入参不应产生 ##settings');
}

// ---- 4. 不能依赖 history.length ----
// 外壳加载远端站的 APK 里,length 包含跳转前的外部页面与重定向,几乎永远 > 1。
// 这条锁住"判断只能用我们自己的深度标记"。
{
  const fakeHistory = { state: null, length: 99, pushState() {}, back() { return true; } };
  assert.equal(
    canGoBackInApp(fakeHistory),
    false,
    'history.length 很大但没有我们的标记时,必须判为"不能后退" —— 用 length 判断会在 APK 里永远退不出去',
  );
}

// ---- 5. 路由回退必须来自历史,而不是写死某个目标 ----
{
  const app = read('src/App.js');
  assert.ok(
    /goBackInApp\(/.test(app),
    'App.js 的返回处理必须调用 goBackInApp(沿历史后退)',
  );
  assert.ok(
    !/navigateRef\.current\?\.\('Home'\)/.test(app),
    "禁止再出现写死的 navigate('Home') —— 那正是「点进歌单按返回掉回首页」的成因",
  );
  assert.ok(
    /pushRouteEntry\(/.test(app),
    'navigate 必须用 pushRouteEntry 记录深度,否则返回时不知道有没有上一页',
  );
}

// ---- 6. 其他入口不得再绕过深度记录直接改 hash ----
// 直接 `location.hash =` 不会写 state,跳过去之后深度还是旧的,返回行为会错。
{
  const direct = [];
  for (const rel of [
    'src/App.js',
    'src/components/MyPlaylist.js',
    'src/components/LocalMusic.js',
    'src/components/DesktopLyricsBridge.js',
  ]) {
    const source = read(rel);
    const code = source
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join('\n');
    if (/window\.location\.hash\s*=/.test(code)) direct.push(rel);
  }
  assert.deepEqual(
    direct,
    [],
    `这些文件仍用 location.hash= 直接跳转,会绕过深度记录导致返回行为错误:\n${direct.join('\n')}`,
  );
}

// ---- 7. 路由必须同时监听 popstate ----
//
// 这条是硬性要求,不是可选优化:用 pushState 写的历史,在后退/前进时
// **只派发 popstate,不派发 hashchange**。只监听 hashchange 的话,
// 按返回键 URL 变了、页面却停在原处 —— 看起来就是"返回键没反应"。
{
  const app = read('src/App.js');
  assert.ok(
    /addEventListener\('popstate'/.test(app),
    "App.js 必须监听 popstate:navigate 用 pushState 写历史,后退时只会派发 popstate",
  );
  assert.ok(
    /addEventListener\('hashchange'/.test(app),
    'App.js 仍需监听 hashchange:深链接与手动改 hash 不会派发 popstate',
  );
}

// ---- 8. 服务端/外部跳转式的 hash 写入不受影响 ----
// 深度标记只是在 history.state 上附加信息,不改 URL 形态(#section/sub 仍是唯一真相),
// 因此刷新页面仍能正确还原路由。
{
  const history = makeHistory(null);
  pushRouteEntry('myplaylist/3', { history });
  assert.equal(history.currentUrl(), '#myplaylist/3');
  // 模拟刷新:新会话从 URL 解析,state 为空 → 深度 0(入口页,不能后退)
  const fresh = makeHistory(null);
  assert.equal(
    canGoBackInApp(fresh),
    false,
    '刷新后 history.state 会丢失(深度归 0):此时不能后退,否则会退到站外',
  );
}

console.log('routeHistory tests passed');
