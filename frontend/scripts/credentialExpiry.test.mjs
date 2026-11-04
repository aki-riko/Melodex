// 凭证「有效期 / 能否自动续期」展示逻辑的契约测试。
//
// 为什么需要(用户反馈,2026-11):设置页 QQ 卡片显示「⚠ 剩 23 小时 34 分」,
// 用户以为要掉线了、准备重新扫码。但 QQ musickey 只有 72h,而 cookie 里
// 还有寿命几十天的授权 token,Provider sidecar 会在下次搜索时自动换出新 key
// (backend/provider_bridge/qq_source.py 的 refresh_musickey)。
//
// 所以要守住两件事:
//   A. 能自动续期时,文案必须明确说"会自动续期",且语气不能是催促用户重登;
//   B. 不能续期时,必须如实警告 —— 承诺一个做不到的自动续期比不提示更糟。
//
// 运行: node scripts/credentialExpiry.test.mjs   (或 npm run test:credential)

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  classifyCredentialNotices,
  credentialNoticeText,
  expiryBadge,
  expiryHint,
  formatRemaining,
  isAutoRefreshable,
} from '../src/utils/credentialExpiry.js';

// ---- 1. isAutoRefreshable:只认后端的明确 true ----

assert.equal(isAutoRefreshable({ auto_refreshable: true }), true);
assert.equal(isAutoRefreshable({ auto_refreshable: false }), false);
assert.equal(
  isAutoRefreshable({}),
  false,
  '旧后端没有 auto_refreshable 字段时必须按"不能续期"处理,宁可多提醒一次',
);
assert.equal(isAutoRefreshable(null), false);
assert.equal(
  isAutoRefreshable({ auto_refreshable: 'true' }),
  false,
  '只接受布尔 true;字符串不能当开关(后端序列化异常时不要误判成能续期)',
);

// ---- 2. formatRemaining:说人话 ----

assert.equal(formatRemaining(23 * 3600 + 34 * 60), '23 小时 34 分');
assert.equal(formatRemaining(3 * 86400 + 5 * 3600), '3 天 5 小时');
assert.equal(formatRemaining(90), '1 分钟', '不足 1 分钟也显示 1 分钟,不要出现 0');
assert.equal(formatRemaining(-100), '1 分钟', '负数取绝对值,表示"过期多久"');

// ---- 3. 徽章:expiring_soon ----

const soonRefreshable = expiryBadge({
  state: 'expiring_soon',
  expires_in_seconds: 23 * 3600 + 34 * 60,
  auto_refreshable: true,
});
assert.match(soonRefreshable.text, /自动续期/, '能续期时必须写明,否则用户会白扫一次码');
assert.match(soonRefreshable.text, /剩/, '仍要显示剩余时间');
assert.match(soonRefreshable.text, /23 小时 34 分/);
assert.ok(
  !/yellow/.test(soonRefreshable.className),
  '能自动续期不该用黄色警报配色 —— 那是信息,不是问题',
);
assert.equal(soonRefreshable.icon, 'refresh');

const soonPlain = expiryBadge({ state: 'expiring_soon', expires_in_seconds: 23 * 3600 });
assert.ok(!/自动续期/.test(soonPlain.text), '不能续期时不得出现"自动续期"字样');
assert.match(soonPlain.className, /yellow/, '不能续期的临期状态才是黄色警报');
assert.equal(soonPlain.icon, 'alert');

// ---- 4. 徽章:expired ----

const expiredRefreshable = expiryBadge({ state: 'expired', auto_refreshable: true });
assert.match(expiredRefreshable.text, /待续期/);
assert.ok(
  !/destructive/.test(expiredRefreshable.className),
  '已过期但能自愈时不该用红色 —— 红色会让用户立刻跑去重扫,那是多余的',
);

const expiredPlain = expiryBadge({ state: 'expired', auto_refreshable: false });
assert.equal(expiredPlain.text, '已过期');
assert.match(expiredPlain.className, /destructive/, '真正不可用时才是红色');

// ---- 5. 徽章:不显示的情况 ----

assert.equal(expiryBadge({ state: 'ok' }), null, 'ok 状态不打扰用户');
assert.equal(expiryBadge({ state: 'unknown' }), null, '无法判断时不猜');
assert.equal(expiryBadge(null), null);
assert.equal(expiryBadge({ state: 'missing' }), null);

// ---- 6. 说明文案:能续期 vs 不能续期 ----

const hintRefreshable = expiryHint({
  state: 'expiring_soon',
  expires_in_seconds: 23 * 3600,
  auto_refreshable: true,
});
assert.match(hintRefreshable, /自动续期/);
assert.ok(
  !/建议提前重新登录|请提前重新登录/.test(hintRefreshable),
  '能自动续期时绝不能催用户重新登录',
);

const hintPlain = expiryHint({ state: 'expiring_soon', expires_in_seconds: 23 * 3600 });
assert.match(hintPlain, /无法自动续期/, '不能续期时必须说清,否则用户不知道要动手');
assert.match(hintPlain, /提前/, '不能续期时才是该催促的场景');

const hintExpiredRefreshable = expiryHint({ state: 'expired', auto_refreshable: true });
assert.match(hintExpiredRefreshable, /自动续期/);
assert.match(
  hintExpiredRefreshable,
  /若续期失败再重新扫码/,
  '要给出兜底路径 —— 续期也可能被上游拒绝',
);

const hintOkRefreshable = expiryHint({
  state: 'ok',
  expires_in_seconds: 30 * 3600,
  auto_refreshable: true,
});
assert.match(hintOkRefreshable, /到期后会自动续期/);

// 非过期状态且无剩余秒数时不该编造文案
assert.equal(expiryHint({ state: 'ok' }), '');
assert.equal(expiryHint(null), '');

// ---- 7. 防止逻辑回退:能续期必须与"催促重扫"互斥 ----

const cases = [
  { state: 'expiring_soon', expires_in_seconds: 3600, auto_refreshable: true },
  { state: 'expired', auto_refreshable: true },
  { state: 'ok', expires_in_seconds: 7200, auto_refreshable: true },
];
for (const detail of cases) {
  const hint = expiryHint(detail);
  assert.ok(
    !/建议提前重新登录|请提前重新登录/.test(hint),
    `${detail.state}: 可自动续期时不允许出现催促重登的措辞,得到「${hint}」`,
  );
}

// ---- 8. 全局提示条分类:三个桶的边界 ----
//
// 这里最容易被写错的一条:把"能自动续期"一律当成"不提示"。
// 那会让 expired 且续期失败的用户彻底失去提示,退回"音质悄悄变差没人知道"的老问题。
// 正确规则是按**用户要不要动手**分,不是按"能不能续"分。

{
  const eight = classifyCredentialNotices({
    qq: { state: 'expiring_soon', auto_refreshable: true },       // 正常,下次就续上 → 不提示
    netease: { state: 'expiring_soon', auto_refreshable: false }, // 临期且不能续 → 该提醒
  });
  assert.deepEqual(eight.expired, []);
  assert.deepEqual(eight.expiringSoon, ['netease'], '临期+可续期不该进该提醒桶');
  assert.deepEqual(eight.autoRetry, [], '还没过期就不该进 autoRetry');

  const expiredRefreshable = classifyCredentialNotices({
    qq: { state: 'expired', auto_refreshable: true },
  });
  assert.deepEqual(expiredRefreshable.expired, [], '能续期的不算"必须自己动手"');
  assert.deepEqual(
    expiredRefreshable.autoRetry,
    ['qq'],
    '已过期且可续期必须单独成桶并仍然提示 —— 续期可能被上游拒绝',
  );

  const expiredPlain = classifyCredentialNotices({
    qq: { state: 'expired', auto_refreshable: false },
  });
  assert.deepEqual(expiredPlain.expired, ['qq']);

  // missing / 空 / 其他状态一律不进桶
  const noise = classifyCredentialNotices({
    a: { state: 'missing' },
    b: { state: 'ok' },
    c: { state: 'unknown' },
    d: null,
    e: undefined,
  });
  assert.deepEqual(noise, { expired: [], expiringSoon: [], autoRetry: [] });
  assert.deepEqual(classifyCredentialNotices(null), { expired: [], expiringSoon: [], autoRetry: [] });
}

// ---- 9. 提示条文案:优先级 + 措辞 ----

{
  const nameOf = (source) => ({ qq: 'QQ 音乐', netease: '网易云音乐' }[source] || source);

  assert.equal(credentialNoticeText({}, nameOf), '', '空桶不出文案');

  const errorText = credentialNoticeText(
    { expired: ['netease'], autoRetry: ['qq'] },
    nameOf,
  );
  assert.match(errorText, /网易云音乐/, '真的不可用的源优先');
  assert.match(errorText, /重新扫码/);

  const autoText = credentialNoticeText({ autoRetry: ['qq'] }, nameOf);
  assert.match(autoText, /自动续期/, '要说清会自动续期');
  assert.match(autoText, /若续期失败/, '必须给兜底路径 —— 续期不是百分百成功');
  assert.ok(
    !/音质已不可用/.test(autoText),
    '还没确定失败时不能说"已不可用"',
  );

  const soonText = credentialNoticeText({ expiringSoon: ['netease'] }, nameOf);
  assert.match(soonText, /无法自动续期/, '临期不可续时必须说清原因');
  assert.match(soonText, /提前/);

  // 兜底:不传 nameOf 时用原始 source,不能崩
  assert.match(credentialNoticeText({ expired: ['qq'] }), /qq/);
}

// ---- 10. 软门禁:Settings 与 CredentialNotice 必须复用这套逻辑 ----

const settingsSource = await readFile(new URL('../src/components/Settings.js', import.meta.url), 'utf8');
assert.match(
  settingsSource,
  /from '\.\.\/utils\/credentialExpiry'/,
  'Settings.js 必须复用 utils/credentialExpiry,不要留着第二份过期文案实现',
);
assert.ok(
  !/建议提前重新登录以保证无损可用/.test(settingsSource),
  'Settings.js 里不应再残留旧的催促文案(它不认识"可自动续期")',
);

const noticeSource = await readFile(new URL('../src/components/CredentialNotice.js', import.meta.url), 'utf8');
assert.match(
  noticeSource,
  /classifyCredentialNotices/,
  'CredentialNotice 必须复用纯逻辑分类 —— 否则会催能自愈的源去重新扫码',
);
assert.match(
  noticeSource,
  /credentialNoticeText/,
  '提示条文案必须来自纯逻辑,不要在校验不到的组件内联拼接',
);
// 门禁的核心:组件里不得再手写一套"按 state 分桶"的循环。
// 那正是把 auto_refreshable 漏掉的写法,而且没有任何测试能覆盖到它的分支。
assert.ok(
  !/detail\.state === 'expired'/.test(noticeSource),
  'CredentialNotice 里不应再手写分桶逻辑,统一走 classifyCredentialNotices',
);

console.log('credentialExpiry: all assertions passed');
