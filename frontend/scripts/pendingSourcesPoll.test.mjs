import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createPendingSourcesPoller,
  PENDING_REFETCH_DELAY_MS,
  PENDING_REFETCH_MAX,
} from '../src/hooks/pendingSourcesPoll.js';

// 慢源自动补拉的**运行期**门禁。
//
// 为什么必须运行期:2026-11-27 用户报「提示说结果会自动刷新,实际上并没有刷新」。
// 旧实现"每 25 秒补拉一次"的下一轮依赖 React effect 的依赖 `[pendingSourcesKey]`,
// 而补拉回来的 pending_sources 与上一轮一模一样(后台还没跑完)→ key 不变 → effect
// 不重跑 → 计时器再也不被安排。**生产日志里只出现了一次补拉,之后再无请求**,
// 而后台其实已经补齐成功。
//
// 这类 bug 静态正则完全看不出来:代码里明明写着 setTimeout 和 refetch。
// 所以这里用一个假的计时器把控制器**真的跑起来**,数它到底触发了几次。

// 假计时器:只在我们手动 advance 时推进,不依赖真实时间。
const createFakeClock = () => {
  let now = 0;
  let seq = 0;
  const tasks = new Map(); // id -> { due, fn }
  return {
    setTimeoutFn(fn, ms) {
      seq += 1;
      tasks.set(seq, { due: now + ms, fn });
      return seq;
    },
    clearTimeoutFn(id) {
      tasks.delete(id);
    },
    // 推进 ms 毫秒,按到期顺序逐个执行(执行中新排进来的任务也在本次范围内生效)。
    advance(ms) {
      const target = now + ms;
      let guard = 0;
      for (;;) {
        guard += 1;
        if (guard > 10000) throw new Error('假计时器疑似死循环:任务不断自我重新安排');
        let nextId = null;
        let nextDue = Infinity;
        for (const [id, task] of tasks) {
          if (task.due <= target && task.due < nextDue) {
            nextDue = task.due;
            nextId = id;
          }
        }
        if (nextId === null) break;
        const task = tasks.get(nextId);
        tasks.delete(nextId);
        now = task.due;
        task.fn();
      }
      now = target;
      return this;
    },
    get pending() { return tasks.size; },
    get now() { return now; },
  };
};

const buildPoller = (clock) => {
  const calls = [];
  const poller = createPendingSourcesPoller({
    refetch: () => calls.push(clock.now),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  return { poller, calls };
};

// ---------- ① 核心回归:名单一直不变时,必须**每一轮**都继续补拉 ----------
// 这正是旧实现的死因:数据一模一样,却必须继续等。
{
  const clock = createFakeClock();
  const { poller, calls } = buildPoller(clock);
  const stuck = 'qq,kugou,migu,qianqian';

  poller.update({ identity: '爱乐之城\u00000', pendingKey: stuck });
  // 模拟后端连着三次都还报同一批慢源(后台 2.5 分钟还没跑完的真实情形)。
  for (let round = 1; round <= 3; round += 1) {
    clock.advance(PENDING_REFETCH_DELAY_MS);
    assert.equal(calls.length, round, `第 ${round} 轮补拉没有触发 —— 名单不变时轮询又停摆了`);
    poller.update({ identity: '爱乐之城\u00000', pendingKey: stuck });
  }
  assert.deepEqual(
    calls,
    [25000, 50000, 75000],
    '补拉必须按 25s 节奏连续发生,而不是只跑一圈',
  );
}

// ---------- ② 次数上限真的生效(不会无限重试) ----------
{
  const clock = createFakeClock();
  const { poller, calls } = buildPoller(clock);
  const stuck = 'kugou,kuwo,migu';

  poller.update({ identity: 'x\u00000', pendingKey: stuck });
  // 名单一直不变 → 上限用完后必须停下。
  for (let i = 0; i < PENDING_REFETCH_MAX + 5; i += 1) {
    clock.advance(PENDING_REFETCH_DELAY_MS);
    poller.update({ identity: 'x\u00000', pendingKey: stuck });
  }
  assert.equal(calls.length, PENDING_REFETCH_MAX, `补拉次数必须封顶在 ${PENDING_REFETCH_MAX}`);
  assert.equal(poller.armed, false, '到达上限后不该还留着计时器');
}

// ---------- ③ 补完了(名单变空)必须立刻停表 ----------
{
  const clock = createFakeClock();
  const { poller, calls } = buildPoller(clock);

  poller.update({ identity: 'x\u00000', pendingKey: 'kugou' });
  clock.advance(PENDING_REFETCH_DELAY_MS);
  assert.equal(calls.length, 1);
  poller.update({ identity: 'x\u00000', pendingKey: '' });
  assert.equal(poller.armed, false, '没有待补齐源时不该继续计时');
  clock.advance(PENDING_REFETCH_DELAY_MS * 4);
  assert.equal(calls.length, 1, '补完之后不该再有任何补拉');
}

// ---------- ④ 换搜索 / 同一个词重搜:次数必须清零 ----------
// 旧实现把计数放在一个永不重置的 ref 里,后一次搜索会继承上一次用剩的次数,
// 表现为"新搜索的补齐提示没多久就自己停了"。
{
  const clock = createFakeClock();
  const { poller, calls } = buildPoller(clock);
  const stuck = 'kugou,kuwo';

  poller.update({ identity: 'A\u00000', pendingKey: stuck });
  for (let i = 0; i < PENDING_REFETCH_MAX; i += 1) {
    clock.advance(PENDING_REFETCH_DELAY_MS);
  }
  assert.equal(calls.length, PENDING_REFETCH_MAX, '第一次搜索先用满上限');

  // 换一个关键词 → 全新的身份 → 次数清零。
  poller.update({ identity: 'B\u00000', pendingKey: 'migu' });
  assert.equal(poller.attempts, 0, '换搜索必须把补拉次数清零');
  clock.advance(PENDING_REFETCH_DELAY_MS);
  assert.equal(calls.length, PENDING_REFETCH_MAX + 1, '新搜索必须能继续补拉');

  // 同一个词但 nonce 变了(用户又点了一次搜索)= 也是新身份。
  poller.update({ identity: 'B\u00001', pendingKey: 'migu' });
  assert.equal(poller.attempts, 0, '同一个词重搜(nonce 变化)也必须清零');
}

// ---------- ⑤ 名单有进展(少了几个源)时重新给满次数 ----------
{
  const clock = createFakeClock();
  const { poller } = buildPoller(clock);
  poller.update({ identity: 'x\u00000', pendingKey: 'a,b,c' });
  clock.advance(PENDING_REFETCH_DELAY_MS);
  poller.update({ identity: 'x\u00000', pendingKey: 'a,b,c' });
  clock.advance(PENDING_REFETCH_DELAY_MS);
  assert.equal(poller.attempts, 2);
  poller.update({ identity: 'x\u00000', pendingKey: 'a' });
  assert.equal(poller.attempts, 0, '有源补齐回来(名单变化)时应重新给满次数');
}

// ---------- ⑥ refetch 抛异常也不能把整条链路掐断 ----------
{
  const clock = createFakeClock();
  let count = 0;
  const poller = createPendingSourcesPoller({
    refetch: () => {
      count += 1;
      throw new Error('网络抖动');
    },
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  poller.update({ identity: 'x', pendingKey: 'kugou' });
  // update 之外的调用方(React effect)不会包 try,这里必须自己兜住异常继续。
  assert.throws(() => clock.advance(PENDING_REFETCH_DELAY_MS), /网络抖动/);
  assert.equal(count, 1);
  assert.equal(poller.armed, true, '单次 refetch 失败后必须仍安排了下一轮');
  assert.throws(() => clock.advance(PENDING_REFETCH_DELAY_MS), /网络抖动/);
  assert.equal(count, 2, '失败之后仍然要能继续重试');
}

// ---------- ⑦ stop 之后彻底安静 ----------
{
  const clock = createFakeClock();
  const { poller, calls } = buildPoller(clock);
  poller.update({ identity: 'x', pendingKey: 'kugou' });
  poller.stop();
  assert.equal(poller.armed, false);
  clock.advance(PENDING_REFETCH_DELAY_MS * 3);
  assert.equal(calls.length, 0, 'stop 之后不该再补拉');
}

// ---------- ⑧ 窗口必须够长:实测后台补齐要 ~2.5 分钟 ----------
// 2026-11-27 实测:lyric 2m0s + song 35.4s(受 background concurrency=1 排队)≈ 155s。
// 旧配置 6 × 25s = 150s, 正好卡在边界外侧 —— 于是"永远差几秒"。
{
  const windowMs = PENDING_REFETCH_MAX * PENDING_REFETCH_DELAY_MS;
  assert.ok(
    windowMs >= 240000,
    `补拉总窗口 ${windowMs}ms 太短:实测后台补齐约 155s,必须留足余量(当前仅 ${windowMs / 1000}s)`,
  );
  assert.ok(
    PENDING_REFETCH_DELAY_MS >= 20000,
    '单轮间隔不能太密:后台任务本身受并发限流,太密只是空转打后端',
  );
}

// ---------- ⑨ 源码接线:Download.js 必须真的用这个控制器 ----------
{
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(scriptDir, '..');
  const { readFileSync } = await import('node:fs');
  const downloadSrc = readFileSync(resolve(root, 'src/components/Download.js'), 'utf8');

  assert.match(
    downloadSrc,
    /createPendingSourcesPoller/,
    'Download.js 必须使用运行期可测的补拉控制器,而不是自己写 setTimeout',
  );
  assert.doesNotMatch(
    downloadSrc,
    /pendingRefetchCountRef/,
    '旧的 pendingRefetchCountRef 计数器已被控制器取代,不应残留',
  );
  // 关键:update 必须把"搜索身份"传进去,否则换搜索时计数不会清零。
  assert.match(
    downloadSrc,
    /pendingPollerRef\.current\?\.update\(\{ identity: searchIdentity, pendingKey: pendingSourcesKey \}\)/,
    'update 必须同时传 identity(搜索身份)与 pendingKey(待补齐源)',
  );
  // effect 依赖必须含 searchIdentity,否则换搜索时不会重新 update。
  assert.match(
    downloadSrc,
    /\}, \[searchIdentity, pendingSourcesKey\]\);/,
    'effect 依赖必须包含 searchIdentity,否则换搜索/重搜时控制器收不到新身份',
  );
}

console.log('慢源自动补拉门禁通过:9 组(含「名单不变也必须继续补拉」的运行期回归)');
