// 桌面歌词纯逻辑核心的回归测试。
//
// 每条断言都对着旧 PrismQML 实现的源码行：
//   - lyricIndexAt / secondaryLyricIndex / lineProgress → desktop-prismqml/cpp/Lyrics.cpp
//   - 逐字填充                                        → melodex_desktop/player.py
// 这些是"歌词看起来对不对"的根，单独测比在真机上肉眼找便宜得多。

import assert from 'node:assert/strict';
import {
  desktopLyricsDeviceWebSocketURL,
  lineProgress,
  lyricFrame,
  lyricIndexAt,
  lyricWordFill,
  secondaryLyricIndex,
} from './lyricsCore.js';

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
};

const lyrics = [
  { t: 1, end: 4, text: '从前从前' },
  { t: 4, end: 8, text: '有个人爱你很久' },
  { t: 8, end: 12, text: '但偏偏' },
];

test('WebSocket 地址按站点根派生', () => {
  assert.equal(
    desktopLyricsDeviceWebSocketURL('https://music.example.test/'),
    'wss://music.example.test/rest/desktop-lyrics/device',
  );
  assert.equal(
    desktopLyricsDeviceWebSocketURL('http://127.0.0.1:8329/'),
    'ws://127.0.0.1:8329/rest/desktop-lyrics/device',
  );
});

test('行索引：基础边界', () => {
  assert.equal(lyricIndexAt(lyrics, 0.5), -1, '还没到第一行');
  assert.equal(lyricIndexAt(lyrics, 4.5), 1);
  assert.equal(lyricIndexAt([], 5), -1, '空歌词');
  assert.equal(lyricIndexAt(lyrics, 1), 0, '恰好到行首应算该行');
});

test('行索引：同一时间戳必须回退到分组第一行（旧版 Lyrics.cpp:122-127）', () => {
  // 合唱/翻译行的典型形态：两行 t 完全相同。
  const grouped = [
    { t: 0, text: '前奏' },
    { t: 5, text: '原词第一句' },
    { t: 5, text: '翻译第一句' },
    { t: 9, text: '下一句' },
  ];
  // 二分先命中下标 2（最后一行 t<=9 里...注意 5 那两行都在），
  // 回退后必须停在 1，而不是 2。
  assert.equal(lyricIndexAt(grouped, 6), 1, '分组内必须停在第一行');
  assert.equal(lyricIndexAt(grouped, 5), 1, '恰好等于分组时间戳也停在第一行');
  assert.equal(lyricIndexAt(grouped, 9), 3, '进入下一组');
  // 三行同戳也只在第一行
  const triple = [
    { t: 2, text: 'a' },
    { t: 2, text: 'b' },
    { t: 2, text: 'c' },
  ];
  assert.equal(lyricIndexAt(triple, 2.5), 0);
  // 只有一行时不应越界回退到 -1
  assert.equal(lyricIndexAt([{ t: 1, text: 'only' }], 2), 0);
});

test('副行索引：三个边界与旧版一致', () => {
  // Lyrics.cpp:130-138
  assert.equal(secondaryLyricIndex([], 0), -1, '没有歌词');
  assert.equal(secondaryLyricIndex(lyrics, -1), 0, '还没开始唱时副行显示第一行');
  assert.equal(secondaryLyricIndex(lyrics, 0), 1);
  assert.equal(secondaryLyricIndex(lyrics, 2), -1, '最后一行没有副行');
  assert.equal(secondaryLyricIndex(lyrics, 5), -1, '越界');
});

test('lyricFrame 组装', () => {
  assert.deepEqual(lyricFrame(lyrics, 4.5), {
    index: 1,
    previous: lyrics[0],
    current: lyrics[1],
    next: lyrics[2],
  });
  // 还没开始时：current 为 null，但 next 必须是第一行（副行位置有内容）
  assert.deepEqual(lyricFrame(lyrics, 0.5), {
    index: -1,
    previous: null,
    current: null,
    next: lyrics[0],
  });
  // 最后一行：没有 next
  assert.equal(lyricFrame(lyrics, 10).next, null);
});

test('逐字填充：单词语义', () => {
  assert.equal(lyricWordFill({ t: 2, end: 4 }, 1), 0);
  assert.equal(lyricWordFill({ t: 2, end: 4 }, 3), 0.5);
  assert.equal(lyricWordFill({ t: 2, end: 4 }, 5), 1);
  // 退化输入不抛错：零长度词在起点仍算未开始（`position <= start` 先判），
  // 越过起点后立刻满格。旧 PrismQML 没有独立词填充函数，
  // 整行观感由 lineProgress 决定，所以这里只锁「不崩、不越界」。
  assert.equal(lyricWordFill({ t: 2, end: 2 }, 2), 0);
  assert.equal(lyricWordFill({ t: 2, end: 2 }, 2.1), 1);
  // 空输入只要求不抛错且落在 [0,1]（不锁具体值：这是防御性输入，非真实场景）
  const degenerate = lyricWordFill(null, 3);
  assert.ok(Number.isFinite(degenerate) && degenerate >= 0 && degenerate <= 1);
});

test('行进度：无 words 时按 t/end 线性插值', () => {
  const line = { t: 10, end: 20, text: '一行' };
  assert.equal(lineProgress(line, 10), 0);
  assert.equal(lineProgress(line, 15), 0.5);
  assert.equal(lineProgress(line, 20), 1);
  assert.equal(lineProgress(line, 30), 1, '过行尾保持满格');
  // 早于行首 → 0（不能出现负数）
  assert.equal(lineProgress(line, 5), 0);
  // end <= start 时旧版直接返回 1（Lyrics.cpp:167-168）
  assert.equal(lineProgress({ t: 10, end: 10 }, 10), 1);
  assert.equal(lineProgress({ t: 10, end: 5 }, 10), 1);
});

test('行进度：有 words 时按**视觉宽度**加权（空格不再算整字）', () => {
  // ★ 与旧版 `Lyrics.cpp:lyricProgress` 的**有意差异**：
  //   旧版按字符数加权，把空格也算成 1 整字；但空格渲染宽度只有汉字的约 0.28。
  //   用户实测「逐字歌词有时候会跳着显示，主要在空格之后」。
  //
  //   实测偏差（「眉目缱绻中 飘零 随风」词时间均匀）：
  //     按字数 0.454 / 0.727 / 1.000
  //     按像素 0.523 / 0.761 / 1.000  → 最大偏差 0.66em
  //   无空格的行两者完全一致，这也解释了为什么问题总出在空格后。
  //
  // 纯中文（无空格/字母）时结果与旧版**完全相同**，不影响原观感：
  const line = {
    t: 0,
    end: 4,
    text: 'ab中文歌词',
    words: [
      { t: 0, end: 1, s: 'ab' }, // 2 个拉丁字符 → 宽度 1.10
      { t: 1, end: 4, s: '中文歌词' }, // 4 个汉字 → 宽度 4.0
    ],
  };
  const total = 2 * 0.55 + 4; // 1.10 + 4.0 = 5.10
  // 时间到 1：第一词满格 → 1.10/5.10
  assert.ok(Math.abs(lineProgress(line, 1) - 1.1 / total) < 1e-9);
  // 时间到 2.5：第一词 + 第二词半程(4*0.5=2) → 3.10/5.10
  assert.ok(Math.abs(lineProgress(line, 2.5) - 3.1 / total) < 1e-9);
  // 结束 → 1
  assert.equal(lineProgress(line, 4), 1);
  // 早于第一个词 → 0
  assert.equal(lineProgress(line, -1), 0);

  // 纯汉字行：与旧版的"按字数"结果**一致**（回归保护）
  const pureCjk = {
    t: 0,
    end: 3,
    text: '一二三五六',
    words: [
      { t: 0, end: 1, s: '一二' },
      { t: 1, end: 3, s: '三五六' },
    ],
  };
  // 纯汉字每字宽度都是 1.0 → 到时间 1 时 2/5
  assert.ok(Math.abs(lineProgress(pureCjk, 1) - 2 / 5) < 1e-9);

  // 长词比短词权重大
  const lopsided = {
    t: 0,
    end: 3,
    text: 'a很长很长很长',
    words: [
      { t: 0, end: 1, s: 'a' },
      { t: 1, end: 3, s: '很长很长很长' },
    ],
  };
  // 'a' 宽 0.55，汉字 6 个字宽 6.0 → 总 6.55
  assert.ok(Math.abs(lineProgress(lopsided, 1) - 0.55 / 6.55) < 1e-9);
});

test('行进度：空格不再被算成整字（用户报「空格后会跳」）', () => {
  // 构造「中文 + 空格 + 中文」，词时间均匀分布
  const segments = ['眉目缱绻中', ' ', '飘零'];
  const totalLen = segments.reduce((s, x) => s + x.length, 0);
  let t = 0;
  const words = segments.map((s) => {
    const w = { t, end: t + (10 / totalLen) * s.length, s };
    t = w.end;
    return w;
  });
  const line = { t: 0, end: 10, text: segments.join(''), words };

  // 第一段结束时刻的进度
  const p1 = lineProgress(line, words[0].end - 0.001);
  // 按视觉宽度：第一段 5 个汉字 = 5.0，空格 0.28，最后 2 字 = 2.0 → 总 7.28
  const expected = 5.0 / 7.28;
  assert.ok(
    Math.abs(p1 - expected) < 1e-3,
    `空格前的段应填到 ${expected.toFixed(4)}，实际 ${p1.toFixed(4)}`,
  );

  // 若仍按字数算，会是 5/8 = 0.625（旧行为），两者差异明显 → 这条测试能抓住回归
  const oldBehavior = 5 / 8;
  assert.ok(
    Math.abs(p1 - oldBehavior) > 0.05,
    '进度的算法必须与"按字数"明显不同，否则修复没生效',
  );

  // 空格自身的宽度权重应接近 0.28 而非 1
  const pSpace = lineProgress(line, words[1].end - 0.001);
  const expectedAfterSpace = (5.0 + 0.28) / 7.28;
  assert.ok(
    Math.abs(pSpace - expectedAfterSpace) < 1e-3,
    `空格后应填到 ${expectedAfterSpace.toFixed(4)}，实际 ${pSpace.toFixed(4)}`,
  );
  // 空格造成的推进量应该很小（0.28/7.28 ≈ 0.038），不是 1/8 = 0.125
  const spaceAdvance = pSpace - p1;
  assert.ok(
    spaceAdvance < 0.06,
    `空格的推进量应很小（约 0.038），实际 ${spaceAdvance.toFixed(4)}`,
  );
});

test('行进度：空/异常输入不抛错', () => {
  assert.equal(lineProgress(null, 5), 0);
  assert.equal(lineProgress(undefined, 5), 0);
  // 缺 end 时旧版取 `start + 5` 兜底（Lyrics.cpp:166）。
  // 此时 position=5 恰好等于兜底 end → 比值为 1，与旧版一致。
  const bared = {};
  assert.equal(lineProgress(bared, 0), 0, '在起点');
  assert.equal(lineProgress(bared, 2.5), 0.5, '兜底 end = t+5 的中点');
  assert.equal(lineProgress(bared, 5), 1, '到达兜底 end');
  // words 里的空字符串词至少算 1 字，不会把总字数算成 0
  const empty = { t: 0, end: 1, text: '', words: [{ t: 0, end: 1, s: '' }] };
  assert.equal(lineProgress(empty, 0.5), 0.5);
});

console.log(`\ndesktop lyrics core tests passed (${passed})`);
