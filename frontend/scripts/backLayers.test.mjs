import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackLayerStack } from '../src/contexts/backLayers.js';
import { createHistoryBackGuard, sentinelState, SYSTEM_BACK_EVENT } from '../src/contexts/backNavigation.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptDir, '..');
const srcRoot = resolve(frontendRoot, 'src');

// ============================================================
// 一、返回栈核心语义
// ============================================================

{
  const stack = createBackLayerStack();
  assert.equal(stack.size(), 0);
  assert.equal(stack.handleBack(), 'passthrough', '空栈必须放行,否则用户永远退不出 App');

  const closed = [];
  stack.push({ id: 'sheet', name: '播放页', onBack: () => closed.push('sheet') });
  stack.push({ id: 'queue', name: '队列', onBack: () => closed.push('queue') });

  assert.equal(stack.top().id, 'queue', '栈顶必须是最新打开的那层');
  assert.equal(stack.handleBack(), 'handled');
  assert.deepEqual(closed, ['queue'], '返回键必须先收最上面一层,不能一次收两层');
  assert.equal(stack.size(), 1);

  stack.handleBack();
  assert.deepEqual(closed, ['queue', 'sheet']);
  assert.equal(stack.handleBack(), 'passthrough', '层都收完后必须放行');
}

// 幂等:StrictMode 双跑 effect 不能一按收两层
{
  const stack = createBackLayerStack();
  let count = 0;
  stack.push({ id: 'dlg', onBack: () => { count += 1; } });
  stack.push({ id: 'dlg', onBack: () => { count += 1; } });
  assert.equal(stack.size(), 1, '同 id 重复 push 必须幂等,否则一次返回收掉两层');
  stack.handleBack();
  assert.equal(count, 1);
  assert.equal(stack.size(), 0, '收完必须清空,不能残留幽灵层把人卡在页内');
}

// 按 id 精确移除
{
  const stack = createBackLayerStack();
  stack.push({ id: 'bottom', onBack: () => {} });
  stack.push({ id: 'top', onBack: () => {} });
  stack.remove('bottom');
  assert.deepEqual(stack.snapshot().map((l) => l.id), ['top'], '必须按 id 删,不能 pop() 删到栈顶');
  assert.equal(stack.remove('bottom'), false, '重复移除必须静默');
}

// 不可关闭的层挡住返回,且**不得调用**它的 onBack
{
  const stack = createBackLayerStack();
  let called = 0;
  stack.push({ id: 'mandatory', dismissable: false, onBack: () => { called += 1; return false; } });
  assert.equal(stack.handleBack(), 'blocked', '不可关闭的层必须吞掉返回,否则直接退站');
  assert.equal(called, 0, '不可关闭的层绝不能被调用 onBack —— 那等于把它关掉,违背"挡住"的语义');
  assert.equal(stack.size(), 1, '被挡住时该层必须还在');
}

// 不可关闭层挡住时,下面的层也不能被牵连
{
  const stack = createBackLayerStack();
  const closed = [];
  stack.push({ id: 'below', onBack: () => closed.push('below') });
  stack.push({ id: 'must', dismissable: false, onBack: () => closed.push('must') });
  assert.equal(stack.handleBack(), 'blocked');
  assert.deepEqual(closed, [], '挡住返回时不能连带关掉下层');
  assert.equal(stack.size(), 2);
}

// onBack 返回 false = 内部退一步,不删层
{
  const stack = createBackLayerStack();
  let step = 0;
  stack.push({ id: 'multi', onBack: () => { step += 1; return step >= 2 ? undefined : false; } });
  stack.handleBack();
  assert.equal(stack.size(), 1, '层不认返回时不能删掉它');
  stack.handleBack();
  assert.equal(stack.size(), 0);
}

// 订阅
{
  const stack = createBackLayerStack();
  const depths = [];
  const off = stack.subscribe((d) => depths.push(d));
  stack.push({ id: 'a', onBack: () => {} });
  stack.push({ id: 'b', onBack: () => {} });
  stack.push({ id: 'b', onBack: () => {} }); // 替换
  stack.handleBack();
  stack.remove('a');
  assert.deepEqual(depths, [1, 2, 1, 0], '订阅必须如实反映层数变化');
  off();
  stack.push({ id: 'c', onBack: () => {} });
  assert.deepEqual(depths, [1, 2, 1, 0], '退订后不应再收到通知');
}

// ============================================================
// 二、浏览器历史守卫
// ============================================================

const makeHistory = () => {
  const entries = [{}];
  let index = 0;
  return {
    get state() { return entries[index]; },
    pushState(state) { entries.splice(index + 1); entries.push(state); index += 1; },
    back() { if (index > 0) index -= 1; },
    length: () => entries.length,
    index: () => index,
  };
};

{
  // 栈空不上膛
  const history = makeHistory();
  const guard = createHistoryBackGuard({
    history, location: { href: '/x' }, hasLayers: () => false, onBack: () => 'passthrough',
  });
  guard.sync();
  assert.equal(guard.isArmed(), false, '没有层时不能压哨兵,否则退不出页面');
  assert.equal(guard.handlePop(), false);
}

{
  // 有层上膛,连按多次都只收层不退站
  const history = makeHistory();
  let consumed = 0;
  const guard = createHistoryBackGuard({
    history, location: { href: '/x' }, hasLayers: () => true,
    onBack: () => { consumed += 1; return 'handled'; },
  });
  guard.sync();
  assert.equal(guard.isArmed(), true, '有层必须上膛');
  assert.equal(history.length(), 2, '上膛 = 压一条哨兵');
  assert.equal(guard.handlePop(), true);
  assert.equal(guard.isArmed(), true, '消费后必须重新上膛');
  assert.equal(guard.handlePop(), true);
  assert.equal(consumed, 2);
  assert.equal(guard.isArmed(), true, '连按返回不能把保护磨掉');
}

{
  // 回收哨兵时那次 pop 不能被当成用户返回
  const history = makeHistory();
  let layers = 1;
  let consumed = 0;
  const guard = createHistoryBackGuard({
    history, location: { href: '/x' }, hasLayers: () => layers > 0,
    onBack: () => { consumed += 1; return 'handled'; },
  });
  guard.sync();
  assert.equal(history.index(), 1);

  layers = 0;
  guard.sync(); // 回收 → 主动 back
  assert.equal(guard.isIgnoring(), true, '主动 back 必须标记忽略');
  assert.equal(consumed, 0, '回收哨兵不能触发层的 onBack');

  assert.equal(guard.handlePop(), false, '被标记忽略的 pop 必须返回 false');
  assert.equal(consumed, 0, '回收哨兵的 pop 绝不能消费一层');
  assert.equal(guard.isIgnoring(), false, '忽略标志只能用一次');
}

{
  // blocked 也必须重新上膛
  const history = makeHistory();
  const guard = createHistoryBackGuard({
    history, location: { href: '/x' }, hasLayers: () => true, onBack: () => 'blocked',
  });
  guard.sync();
  assert.equal(guard.handlePop(), true, 'blocked 必须吞掉返回');
  assert.equal(guard.isArmed(), true, 'blocked 后也要重新上膛');
}

assert.deepEqual(sentinelState(), { melodexBackLayer: true });
assert.equal(SYSTEM_BACK_EVENT, 'melodex:systemback');

// ---- 路由层回退:浮层清空后,非首页应回首页而不是退出 ----
//
// 真机实测过的坑:把「更多」改成一级页面(#more)后,在那里按返回会
// **直接退到桌面**。原因是返回键只问浮层栈,完全不知道"页面"这件事。
// 这条测试锁住:浮层清空 → 交给路由层 → 路由层消费掉这次返回。
{
  const history = makeHistory();
  let routed = 0;
  const guard = createHistoryBackGuard({
    history,
    location: { href: '/x' },
    hasLayers: () => true, // 假装还有页面级保护(哨兵上膛)
    onBack: () => 'passthrough', // 没有浮层
    onRouteBack: () => { routed += 1; return true; },
  });
  guard.sync();
  assert.equal(guard.handlePop(), true, '非首页时返回必须被路由层吃掉,不能退站/退 App');
  assert.equal(routed, 1);

  // 已在首页:路由层不消费 → 放行给系统退出。
  const history2 = makeHistory();
  const guard2 = createHistoryBackGuard({
    history: history2,
    location: { href: '/x' },
    hasLayers: () => true,
    onBack: () => 'passthrough',
    onRouteBack: () => false,
  });
  guard2.sync();
  assert.equal(guard2.handlePop(), false, '首页时返回必须放行,否则退不出去');
}

// 静态:AppShell 必须注册路由回退,否则 #more 之类页面按返回会直接退出 App
{
  const app = readFileSync(resolve(frontendRoot, 'src/App.js'), 'utf8');
  assert.ok(
    /setRouteBackResolver\s*\(/.test(app),
    'AppShell 必须调用 setRouteBackResolver —— 否则在 #more/#settings 等页面按返回会直接退出 App(真机实测踩到过)',
  );
  assert.ok(
    /navigateRef\.current\?\.\('Home'\)/.test(app),
    '路由回退必须真的导航回 Home,只注册不导航等于没做',
  );
}

// 原生侧不得再用 webView.canGoBack() 判断:外壳加载远端站时它常年为 true,
// 会退成"在 WebView 历史里倒退"而退不出去。站内是否还有上一页必须由 JS 回答。
{
  const kt = readFileSync(
    resolve(frontendRoot, '..', 'android/app/src/main/java/life/nineli/melodex/SystemBackPlugin.kt'),
    'utf8',
  );
  const code = kt.split(/\r?\n/).filter((line) => !/^\s*(\*|\/\/)/.test(line)).join('\n');
  assert.ok(
    !/canGoBack\(\)/.test(code),
    'SystemBackPlugin 不得用 webView.canGoBack() 判断站内历史 —— 必须由 JS 的哈希路由回答',
  );
}

// ============================================================
// 三、静态契约:原生与 JS 的事件名必须一致
// ============================================================
//
// 这两边一个是 Kotlin 字符串、一个是 JS 常量,改一边忘另一边会静默失效:
// 表现为"返回键完全没反应"(原生派发了没人听)或"一按就直接退出"(JS 听了
// 但原生没派发)。构建都不会报错,所以必须静态对齐。
{
  const kt = readFileSync(
    resolve(frontendRoot, '..', 'android/app/src/main/java/life/nineli/melodex/SystemBackPlugin.kt'),
    'utf8',
  );
  assert.ok(
    kt.includes(`'${SYSTEM_BACK_EVENT}'`) || kt.includes(`"${SYSTEM_BACK_EVENT}"`),
    `SystemBackPlugin.kt 里派发的事件名必须与 JS 的 SYSTEM_BACK_EVENT(${SYSTEM_BACK_EVENT})一致`,
  );
  assert.ok(
    kt.includes('moveTaskToBack'),
    '栈空时必须 moveTaskToBack(退到后台),不能 finish —— 后者会中断播放并丢掉 MediaSession',
  );
  // 只查真实调用,注释里提到 finish() 是解释为什么不用它,不算违规。
  const ktWithoutComments = kt
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\*|\/\/)/.test(line))
    .join('\n');
  assert.ok(
    !/\bfinish\(\)/.test(ktWithoutComments),
    '禁止用 finish() 退出:音乐 App 被杀会中断播放并丢掉 MediaSession',
  );
}

// ============================================================
// 四、静态契约:主要覆盖层都必须接返回栈
// ============================================================
//
// 这条锁的是"新增弹层忘记接返回键"这个必然发生的回归:
// 纯逻辑测试对"某个组件根本没注册"是瞎的。
{
  const mustHandleBack = [
    ['src/ui/Dialog.js', '统一对话框(加入歌单/导入歌单/下载确认等)'],
    ['src/components/SleepTimerControl.js', '睡眠定时面板'],
    ['src/components/TopBar.js', '全局搜索建议'],
    ['src/components/SongRow.js', '歌曲行「更多操作」菜单'],
    ['src/contexts/PlayerContext.js', '全屏播放页 / 播放队列'],
    ['src/contexts/FeedbackContext.js', '确认/输入对话框'],
    ['src/components/MyPlaylist.js', '歌单页「更多操作」菜单'],
  ];
  const missing = mustHandleBack
    .filter(([file]) => {
      const source = readFileSync(resolve(frontendRoot, file), 'utf8');
      // 必须检查**调用**而不是标识符是否出现:import 那一行本身就含 useBackLayer,
      // 只查 includes('useBackLayer') 的话,把实际调用删掉也照样通过 ——
      // 这条门禁就形同虚设(已用突变验证踩到过)。
      const withoutImports = source
        .split(/\r?\n/)
        .filter((line) => !/^\s*import\b/.test(line))
        .join('\n');
      return !/useBackLayer\s*\(/.test(withoutImports);
    })
    .map(([file, what]) => `${file}(${what}) 没有真正调用 useBackLayer —— 按下返回键会直接退站/退 App`);
  assert.deepEqual(missing, [], `这些覆盖层必须能响应返回键:\n${missing.join('\n')}`);
}

// 播放页不能再自己维护 playerExpanded 历史条 —— 两套机制并存会互相顶掉。
{
  const player = readFileSync(resolve(frontendRoot, 'src/contexts/PlayerContext.js'), 'utf8');
  assert.ok(
    !player.includes('playerExpanded'),
    '播放页不能再自己 pushState(playerExpanded):历史哨兵已统一由返回栈维护,两套并存会互相顶掉',
  );
}

// App 根部必须挂一次接线
{
  const app = readFileSync(resolve(frontendRoot, 'src/App.js'), 'utf8');
  assert.ok(/useBackNavigation\(\)/.test(app), 'App.js 必须挂 useBackNavigation() 一次,否则返回键完全不生效');
}

console.log('backLayers tests passed');
