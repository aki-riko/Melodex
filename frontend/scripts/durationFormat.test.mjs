// 时长格式化口径契约(2026-11 全库扫描补充)。
//
// 为什么要有:displayFormat.js 头部注释早就写着"历史问题:同一件事有 3 套口径
// 并存",并点名批评"播放器自己算 '75:03'(不折小时)"—— 但当年只统一了列表,
// 播放器自身的私有 fmtTime 一直留着。结果是 75 分钟的合集在播放条显示 75:03,
// 同一屏的 SongRow 显示 1:15:03。
//
// 这条门禁锁两件事:
//   1. 播放器不得再出现自己的时长格式化实现;
//   2. formatPlaybackTime 的边界(0 / 非法 / 负数 → '0:00',>1 小时折成 h:mm:ss)。
//
// 运行: node scripts/durationFormat.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(scriptDir, '..');
const srcRoot = resolve(frontendRoot, 'src');

const { formatDuration, formatPlaybackTime } = await import(
  new URL('../src/utils/displayFormat.js', import.meta.url)
);

// ---- 1. 播放器时间口径:超过 1 小时必须折成 h:mm:ss ----
assert.equal(formatPlaybackTime(4503), '1:15:03', '75 分钟的合集在播放条应显示 1:15:03,不是 75:03');
assert.equal(formatPlaybackTime(59), '0:59');
assert.equal(formatPlaybackTime(60), '1:00');
assert.equal(formatPlaybackTime(3599), '59:59');
assert.equal(formatPlaybackTime(3600), '1:00:00');

// ---- 2. 未开始/非法值给 '0:00'(播放器语义,不是列表的 '—') ----
for (const bad of [0, undefined, null, NaN, -5, 'abc']) {
  assert.equal(
    formatPlaybackTime(bad),
    '0:00',
    `播放器对 ${String(bad)} 应显示 '0:00' —— 显示 '— / —' 会被当成故障`,
  );
}

// ---- 3. 列表口径保持 '—'(不要为了播放器把列表也改掉) ----
assert.equal(formatDuration(0), '0:00', 'formatDuration(0) 本来就是 0:00(合法值)');
assert.equal(formatDuration(NaN), '—', '列表对非法值给中文破折号,不是 N/A');
assert.equal(formatDuration(-1), '—');

// ---- 4. 播放器不得再自建时长格式化 ----
const playerContext = readFileSync(resolve(srcRoot, 'contexts/PlayerContext.js'), 'utf8');
assert.doesNotMatch(
  playerContext,
  /Math\.floor\(\s*\w+\s*\/\s*60\s*\)/,
  'PlayerContext 不得再手写 "秒 → 分" 的取整逻辑 —— 统一用 utils/displayFormat.formatPlaybackTime',
);
assert.match(
  playerContext,
  /formatPlaybackTime/,
  '播放器时间必须走 formatPlaybackTime',
);

// ---- 5. 全库扫:不允许再有第三套时长格式化 ----
const offenders = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs);
    else if (/\.(js|jsx|mjs)$/.test(entry)) {
      const rel = abs.replace(frontendRoot, '').replace(/\\/g, '/');
      // displayFormat 自身与 sleepTimer(倒计时语义)除外
      if (rel.includes('utils/displayFormat') || rel.includes('playerSleepTimer')) continue;
      const source = readFileSync(abs, 'utf8');
      if (/Math\.floor\([^)]*\/\s*60\s*\)/.test(source) && /padStart\(\s*2/.test(source)) {
        offenders.push(rel);
      }
    }
  }
};
walk(srcRoot);
assert.deepEqual(
  offenders,
  [],
  `只允许一处时长格式化(utils/displayFormat.js);发现重复实现: ${offenders.join(', ') || '(无)'}`,
);

console.log(
  '时长格式化契约通过:播放器已归一到 formatPlaybackTime(>1h 折小时、未开始给 0:00),'
  + '列表口径保持 formatDuration(非法值给 —),全库无第三套实现。',
);
