// 播放失败原因头的编解码契约(2026-11-23 用户截图真实事故)。
//
// 事故: 播放条显示 `「一万零一次沉溺」å½åæé³ä¹æº...，正在自动换源…`, 只有中间那段烂掉。
// 根因: 后端把中文原因写进 HTTP 响应头; 按 Fetch 规范响应头是字节序列, headers.get()
// 按「一字节 → 一码点」同构解码, 不按 UTF-8 解 → 「当」(e5 bd 93) 变成 å½。
//
// 这个测试锁定三件事(任一回归都会让用户重新看到乱码):
//   1. 后端百分号编码的中文能解回原句(正常路径);
//   2. 纯 ASCII 原因/未编码原因原样返回(旧后端兼容, 不引入新行为);
//   3. 已经烂成 latin1 同构乱码的旧响应也能救回来(用户端不残留 å½)。
import assert from 'node:assert/strict';
import net from 'node:net';
import { decodePlaybackReason, __test } from '../src/utils/playbackReason.js';

const REASON = '当前音乐源没有返回可播放地址（可能是已下架、付费曲或版权受限）';

// ---- 1. 正常路径: 与后端 encodePlaybackReasonHeader(url.QueryEscape) 严格对应 ----
// Node 的 encodeURIComponent 与 Go url.QueryEscape 的差异只在空格(+/%20)与少量符号,
// 中文在这两边都产出 %E5%BD%93 形式, 故用 encodeURIComponent 模拟后端编码。
const encoded = encodeURIComponent(REASON);
assert.equal(decodePlaybackReason(encoded), REASON, '百分号编码必须无损解回中文原句');
assert.ok(
  [...encoded].every((ch) => ch.charCodeAt(0) < 0x7f),
  '编码后必须是纯 ASCII —— 否则中文字节仍会被前端读成 å½',
);

// ---- 2. 纯 ASCII / 未编码原因不能改变(旧行为保持) ----
assert.equal(decodePlaybackReason('Failed to get URL'), 'Failed to get URL', '纯 ASCII 原样返回');
assert.equal(decodePlaybackReason('playback failed'), 'playback failed', '英文原样返回');
assert.equal(decodePlaybackReason(''), '', '空值返回空串,调用方回退通用文案');
assert.equal(decodePlaybackReason(null), '', 'null 不抛错');
assert.equal(decodePlaybackReason(undefined), '', 'undefined 不抛错');
// 百分号但不是合法转义(如 100% 这类)不能抛错打断播放流程
assert.equal(decodePlaybackReason('100% broken'), '100% broken', '非法百分号序列不抛错');
assert.equal(decodePlaybackReason('%E0%A4%A'), '%E0%A4%A', '截断的转义序列不抛错');

// ---- 3. 旧数据兼容: 已烂掉的 latin1 同构乱码要能救回 ----
const mojibake = Buffer.from(REASON, 'utf8').toString('latin1'); // 等价于浏览器 headers.get() 的产物
assert.notEqual(mojibake, REASON, '构造的乱码必须与原文不同(否则测试无意义)');
assert.ok(__test.looksLikeMojibake(mojibake), '必须识别出这是 latin1 同构乱码');
assert.equal(decodePlaybackReason(mojibake), REASON, '乱码必须能还原成中文原句');

// 正常中文不应被误判成乱码并"修复"坏(否则会把好数据改烂)
assert.equal(__test.looksLikeMojibake(REASON), false, '正常中文不能被误判为乱码');
assert.equal(decodePlaybackReason(REASON), REASON, '已经正常的中文必须原样保留');

// 纯西文音译不能被改坏
assert.equal(__test.looksLikeMojibake('Beyoncé'), false, '西文人名不能被误判');

// ---- 4. 端到端: 真实裸 HTTP 响应头里放 UTF-8 中文, 观察 fetch 读到什么 ----
// 这一条复现的是 bug 本身: 证明"后端不编码"就会产生乱码, 而不是我们凭空猜测。
const rawServerReason = await new Promise((resolve, reject) => {
  const reasonBytes = Buffer.from(REASON, 'utf8');
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    sock.once('data', () => {
      sock.end(Buffer.concat([
        Buffer.from('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n'),
        Buffer.from('X-Melodex-Playback-Reason: '), reasonBytes, Buffer.from('\r\n\r\n'),
      ]));
    });
  });
  server.listen(0, '127.0.0.1', async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
      const value = res.headers.get('x-melodex-playback-reason');
      await res.text();
      resolve(value);
    } catch (err) {
      reject(err);
    } finally {
      server.close();
    }
  });
});

assert.notEqual(rawServerReason, REASON, '未编码的中文响应头会被 fetch 读成乱码 —— 这正是事故根因');
assert.equal(rawServerReason, mojibake, 'fetch 读到的必须正是 latin1 同构解码的结果');
assert.equal(decodePlaybackReason(rawServerReason), REASON, '我们的解码器必须能把这层乱码救回来');

console.log('playbackReason tests passed');
