# SPDX-License-Identifier: GPL-3.0-only
"""QQ 逐字歌词(QRC)的取回参数、解密与转换。

为什么需要它: 逐字歌词此前只有网易 YRC(覆盖稀)与酷狗 KRC(按歌名匹配); QQ 自己的
QRC 一直被认为"新加密解不开"——那个结论是错的, 真正的原因有三个(2026-09 实测更正):
  1. 请求参数不对: 只传 songMID 时响应里根本没有 qrc 数据, 必须带
     songName/albumName/singerName(base64)+ interval + qrc:1/crypt:1/ct:19 等一整套参数;
  2. 载荷是**十六进制字符串**, 不是 base64(当年按 base64 解, 拿到的是垃圾);
  3. 这套 DES 是 QQ 自家变体, 不是标准 DES —— 用 pycryptodome 的标准 3DES-ECB 拿同一把
     密钥解不出 zlib 流, 必须用下面的变体实现。
解密链路: hex 解码 -> QQ 变体 3DES(EDE, 解密) -> zlib -> 明文 QRC(XML 片段)。

``lyric`` 字段的十六进制长度实测 9808(晴天), 解出的是:
    <Lyric_1 LyricType="1" LyricContent="[ti:晴天]...[行起,行时长]文字(词起,词时长)文字..."/>
词级时间戳写在**文字之后**, 且是绝对毫秒。

算法来源(必须保留): 这套 DES 的位运算与置换表移植自
    chenmozhijin/LDDC 的 LDDC/core/decryptor/tripledes.py(GPL-3.0-only),
    而它本身移植自 WXRIW/QQMusicDecoder 的 DESHelper.cs / Decrypter.cs(C#)。
因为无法用标准库等价替代, 本文件按上游继续以 **GPL-3.0-only** 分发(与项目 AGPL-3.0
兼容, 见 backend/PROVENANCE.md), 不属于 third_party 快照, 也不改动快照。
"""

from __future__ import annotations

import base64
import html
import logging
import os
import re
import zlib
from typing import Any, Sequence

from provider_bridge.verbatim_lyric import inline_lrc


LOGGER = logging.getLogger(__name__)

# 与 LDDC 一致: 云端 QRC 用的 24 字节密钥(EDE 三段各 8 字节)。
QRC_KEY = b"!@#)(*$%123ZXC!@!@#)(NHL"
ENCRYPT = 1
DECRYPT = 0

# 明文形状: <Lyric_1 LyricType="1" LyricContent="..."/>
_QRC_PATTERN = re.compile(r'<Lyric_1 LyricType="1" LyricContent="(?P<content>.*?)"/>', re.DOTALL)
# 歌词行 [行起,行时长]...; [ti:..]/[ar:..] 这类标签行没有逗号, 天然不匹配。
_LINE_PATTERN = re.compile(r"^\[(\d+),(\d+)\](.*)$")
# 词单元: 文字在前, (词起,词时长) 在后。
_WORD_PATTERN = re.compile(r"(?:\[\d+,\d+\])?(?P<content>(?:(?!\(\d+,\d+\)).)*)\((?P<start>\d+),(?P<duration>\d+)\)")
_PURE_TIMESTAMP = re.compile(r"^\(\d+,\d+\)$")

# ---- 以下为 QQ 变体 DES 的移植(GPL-3.0-only, 见文件头) ----

SBOX = (
    (14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
     0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
     4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
     15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13),
    (15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
     3, 13, 4, 7, 15, 2, 8, 15, 12, 0, 1, 10, 6, 9, 11, 5,
     0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
     13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9),
    (10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
     13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
     13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
     1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12),
    (7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
     13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
     10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
     3, 15, 0, 6, 10, 10, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14),
    (2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
     14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
     4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
     11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3),
    (12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
     10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
     9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
     4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13),
    (4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
     13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
     1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
     6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12),
    (13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
     1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
     7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
     2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11),
)

_KEY_ROUND_SHIFT = (1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1)
_KEY_PERM_C = (56, 48, 40, 32, 24, 16, 8, 0, 57, 49, 41, 33, 25, 17, 9, 1,
               58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35)
_KEY_PERM_D = (62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5,
               60, 52, 44, 36, 28, 20, 12, 4, 27, 19, 11, 3)
_KEY_COMPRESSION = (13, 16, 10, 23, 0, 4, 2, 27, 14, 5, 20, 9, 22, 18, 11, 3,
                    25, 7, 15, 6, 26, 19, 12, 1, 40, 51, 30, 36, 46, 54, 29, 39,
                    50, 44, 32, 47, 43, 48, 38, 55, 33, 52, 45, 41, 49, 35, 28, 31)


def _bit_indexed(data: Any, position: int, shift: int) -> int:
    """按 QQ 变体的字节顺序取位(每 4 字节组内字节序反转)。"""
    byte = data[(position // 32) * 4 + 3 - (position % 32) // 8]
    return ((byte >> (7 - position % 8)) & 1) << shift


def _bit_from_int_r(value: int, position: int, shift: int) -> int:
    return ((value >> (31 - position)) & 1) << shift


def _bit_from_int_l(value: int, position: int, shift: int) -> int:
    return ((value << position) & 0x80000000) >> shift


def _sbox_bit(value: int) -> int:
    return (value & 32) | ((value & 31) >> 1) | ((value & 1) << 4)


def _initial_permutation(data: Any) -> tuple[int, int]:
    left_order = (57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
                  61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7)
    right_order = (56, 48, 40, 32, 24, 16, 8, 0, 58, 50, 42, 34, 26, 18, 10, 2,
                   60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6)
    left = sum(_bit_indexed(data, position, 31 - index) for index, position in enumerate(left_order))
    right = sum(_bit_indexed(data, position, 31 - index) for index, position in enumerate(right_order))
    return left, right


def _inverse_permutation(left: int, right: int) -> bytearray:
    out = bytearray(8)
    order = (3, 2, 1, 0, 7, 6, 5, 4)
    for index, target in enumerate(order):
        out[target] = (
            _bit_from_int_r(right, 7 - index, 7) | _bit_from_int_r(left, 7 - index, 6)
            | _bit_from_int_r(right, 15 - index, 5) | _bit_from_int_r(left, 15 - index, 4)
            | _bit_from_int_r(right, 23 - index, 3) | _bit_from_int_r(left, 23 - index, 2)
            | _bit_from_int_r(right, 31 - index, 1) | _bit_from_int_r(left, 31 - index, 0)
        )
    return out


def _feistel(state: int, key: list[int]) -> int:
    t1 = (_bit_from_int_l(state, 31, 0) | ((state & 0xf0000000) >> 1) | _bit_from_int_l(state, 4, 5)
          | _bit_from_int_l(state, 3, 6) | ((state & 0x0f000000) >> 3) | _bit_from_int_l(state, 8, 11)
          | _bit_from_int_l(state, 7, 12) | ((state & 0x00f00000) >> 5) | _bit_from_int_l(state, 12, 17)
          | _bit_from_int_l(state, 11, 18) | ((state & 0x000f0000) >> 7) | _bit_from_int_l(state, 16, 23))
    t2 = (_bit_from_int_l(state, 15, 0) | ((state & 0x0000f000) << 15) | _bit_from_int_l(state, 20, 5)
          | _bit_from_int_l(state, 19, 6) | ((state & 0x00000f00) << 13) | _bit_from_int_l(state, 24, 11)
          | _bit_from_int_l(state, 23, 12) | ((state & 0x000000f0) << 11) | _bit_from_int_l(state, 28, 17)
          | _bit_from_int_l(state, 27, 18) | ((state & 0x0000000f) << 9) | _bit_from_int_l(state, 0, 23))
    chunk = (
        (t1 >> 24) & 0xff, (t1 >> 16) & 0xff, (t1 >> 8) & 0xff,
        (t2 >> 24) & 0xff, (t2 >> 16) & 0xff, (t2 >> 8) & 0xff,
    )
    chunk = [chunk[i] ^ key[i] for i in range(6)]
    state = ((SBOX[0][_sbox_bit(chunk[0] >> 2)] << 28)
             | (SBOX[1][_sbox_bit(((chunk[0] & 0x03) << 4) | (chunk[1] >> 4))] << 24)
             | (SBOX[2][_sbox_bit(((chunk[1] & 0x0f) << 2) | (chunk[2] >> 6))] << 20)
             | (SBOX[3][_sbox_bit(chunk[2] & 0x3f)] << 16)
             | (SBOX[4][_sbox_bit(chunk[3] >> 2)] << 12)
             | (SBOX[5][_sbox_bit(((chunk[3] & 0x03) << 4) | (chunk[4] >> 4))] << 8)
             | (SBOX[6][_sbox_bit(((chunk[4] & 0x0f) << 2) | (chunk[5] >> 6))] << 4)
             | SBOX[7][_sbox_bit(chunk[5] & 0x3f)])
    order = (15, 6, 19, 20, 28, 11, 27, 16, 0, 14, 22, 25, 4, 17, 30, 9,
             1, 7, 23, 13, 31, 26, 2, 8, 18, 12, 29, 5, 21, 10, 3, 24)
    return sum(_bit_from_int_l(state, position, index) for index, position in enumerate(order))


def _crypt(data: Any, key: list[list[int]]) -> bytearray:
    left, right = _initial_permutation(data)
    for index in range(15):
        left, right = right, _feistel(right, key[index]) ^ left
    left = _feistel(right, key[15]) ^ left
    return _inverse_permutation(left, right)


def _key_schedule(key: bytes, mode: int) -> list[list[int]]:
    schedule = [[0] * 6 for _ in range(16)]
    c = sum(_bit_indexed(key, _KEY_PERM_C[i], 31 - i) for i in range(28))
    d = sum(_bit_indexed(key, _KEY_PERM_D[i], 31 - i) for i in range(28))
    for i in range(16):
        shift = _KEY_ROUND_SHIFT[i]
        c = ((c << shift) | (c >> (28 - shift))) & 0xfffffff0
        d = ((d << shift) | (d >> (28 - shift))) & 0xfffffff0
        target = 15 - i if mode == DECRYPT else i
        for j in range(24):
            schedule[target][j // 8] |= _bit_from_int_r(c, _KEY_COMPRESSION[j], 7 - (j % 8))
        for j in range(24, 48):
            schedule[target][j // 8] |= _bit_from_int_r(d, _KEY_COMPRESSION[j] - 27, 7 - (j % 8))
    return schedule


def key_setup(key: bytes = QRC_KEY, mode: int = DECRYPT) -> list[list[list[int]]]:
    """三段子密钥; 加解密对称, 解密时按 16/8/0 的顺序取。"""
    if mode == ENCRYPT:
        return [_key_schedule(key[0:], ENCRYPT), _key_schedule(key[8:], DECRYPT), _key_schedule(key[16:], ENCRYPT)]
    return [_key_schedule(key[16:], DECRYPT), _key_schedule(key[8:], ENCRYPT), _key_schedule(key[0:], DECRYPT)]


_DECRYPT_SCHEDULE: list[list[list[int]]] | None = None


def _decrypt_schedule() -> list[list[list[int]]]:
    global _DECRYPT_SCHEDULE
    if _DECRYPT_SCHEDULE is None:
        _DECRYPT_SCHEDULE = key_setup(QRC_KEY, DECRYPT)
    return _DECRYPT_SCHEDULE


def _triple_decrypt_block(schedule: list[list[list[int]]], block: bytearray) -> bytearray:
    for stage in range(3):
        block = _crypt(block, schedule[stage])
    return block


# ---- QRC 载荷处理 ----

def qrc_bytes(payload: Any) -> bytes:
    """QRC 载荷既可能是十六进制字符串, 也可能是已解码的字节。"""
    if isinstance(payload, (bytes, bytearray)):
        return bytes(payload)
    text = str(payload or "").strip()
    if not text:
        return b""
    if len(text) % 2 == 0 and all(char in "0123456789abcdefABCDEF" for char in text):
        return bytes.fromhex(text)
    try:
        return base64.b64decode(text, validate=True)
    except Exception:
        return b""


def decrypt_qrc(payload: Any) -> str:
    """解密 QRC 载荷; 失败返回空串(调用方应保留原有行级歌词)。"""
    blob = qrc_bytes(payload)
    if len(blob) < 16 or len(blob) % 8 != 0:
        LOGGER.warning("[qq] QRC 载荷长度不可用: %d 字节", len(blob))
        return ""
    schedule = _decrypt_schedule()
    plain = bytearray()
    for offset in range(0, len(blob), 8):
        plain += _triple_decrypt_block(schedule, bytearray(blob[offset:offset + 8]))
    try:
        return zlib.decompress(bytes(plain)).decode("utf-8", "replace")
    except zlib.error as error:
        LOGGER.warning("[qq] QRC 解压失败(%d 字节): %s", len(plain), error)
        return ""


def lyric_content(plaintext: str) -> str:
    """取出 <Lyric_1 .../> 里的 LyricContent(XML 属性已转义)。"""
    matched = _QRC_PATTERN.search(plaintext or "")
    if matched is None:
        return ""
    return html.unescape(matched.group("content"))


# ---- 多语言歌曲: 剔除内联译文行 ----
#
# 实测(2026-11, 「深蓝泡沫」/ Hotcell, 129 行): QQ 的双语歌曲会把**译文也排成独立的
# 歌词行**, 和原文行交错写在同一份 LyricContent 里:
#     [6900,1770]Call (6900,240)my (7140,60)name ...   ← 原文(英语)行
#     [8730,1020]唤 (8730,180)我 (8910,60)姓 ...        ← 紧随其后的中文译文行
# 前端 parseLRC 于是把译文行也当成普通歌词行, 逐字填色跑到译文上
# (用户报「多语言逐字歌词跑到翻译那边去」, 播放页与桌面歌词同一个根因)。
#
# 判别依据**不是**"猜哪行像中文" —— 那靠不住, 中文/日文歌本身就是 CJK。
# 真凭实据是同一次响应的 trans 表: 平台按 QRC 行逐行给出译文, 该行不需要译文时写 `//`。
# 所以内联译文行的特征是三条同时成立:
#   ① 本行在 trans 表里**没有**真译文(`//` 或缺失);
#   ② 紧跟在一条源语言行之后(有真译文的原文行, 或另一条已是源语言脚本的行);
#   ③ 本行的文字脚本与源语言脚本**完全不相交**(如纯拉丁 vs 纯汉字)。
# 保守取值刻意留了余量, 因此:
#   · trans 表为空(晴天/夜曲/孤勇者等绝大多数中文歌) → 一行都不动;
#   · trans 只有稀疏译文(Shape of You / Lemon / 打上花火 实测均为 0 条内联译文行) → 不动;
#   · 原文里本就混着别的脚本(中文歌里的英文和声、中英混排标题) → 脚本相交, 不剔除。

_TRANSLATION_TIMESTAMP = re.compile(r"^\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]")
_TRANSLATION_TAG = re.compile(r"^\[[A-Za-z]+:")
# 平台用 `//` 表示"这一行不需要译文"。
_EMPTY_TRANSLATION = {"", "//"}
# trans 的时间戳只保留到 10ms, 与 QRC 行首常有几毫秒误差(实测 Lemon 1547 vs 1540)。
_TRANSLATION_TOLERANCE_MS = 40
# 只有译文表几乎逐行覆盖时才认为这首歌是"内联译文"形态, 否则一律不动。
_INLINE_TRANSLATION_COVERAGE = 0.8
# 文字脚本。只用"脚本是否相交"判断语种差异, 不做语言识别。
_SCRIPT_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("latin", re.compile(r"[A-Za-z]")),
    ("kana", re.compile(r"[\u3040-\u30ff]")),
    ("hangul", re.compile(r"[\uac00-\ud7af\u1100-\u11ff]")),
    ("han", re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")),
)


def _scripts_in(text: str) -> frozenset[str]:
    """一行的文字脚本集合; 纯数字/符号行返回空集合(不参与判断)。"""
    return frozenset(name for name, pattern in _SCRIPT_PATTERNS if pattern.search(text or ""))


def translation_table(plaintext: str) -> dict[int, str]:
    """把 trans 明文(行级 LRC)解析成 {毫秒: 译文}; 标签行跳过, `//` 保留。"""
    table: dict[int, str] = {}
    for raw_line in (plaintext or "").splitlines():
        line = raw_line.strip()
        if not line or _TRANSLATION_TAG.match(line):
            continue
        matched = _TRANSLATION_TIMESTAMP.match(line)
        if matched is None:
            continue
        milliseconds = (int(matched.group(1)) * 60 + int(matched.group(2))) * 1000
        fraction = matched.group(3)
        if fraction:
            milliseconds += int(fraction.ljust(3, "0"))
        # 同一毫秒只保留第一条: 后续重复交给容差匹配, 避免译文被重复使用。
        table.setdefault(milliseconds, line[matched.end():].strip())
    return table


def _match_translations(starts: Sequence[int], table: dict[int, str]) -> list[str | None]:
    """把 QRC 行首与译文表做成**一对一**匹配, 顺带避免邻居的译文被张冠李戴。

    先精确命中, 再对剩余行在 ±_TRANSLATION_TOLERANCE_MS 内取最近的**未使用**条目。
    一对一很关键: 译文行之间可能只差 33ms, 若允许重复使用, 元信息行会捡到邻行译文,
    被误判成"原文行", 于是紧跟其后的译文行反而删不掉。
    """
    matched: list[str | None] = [None] * len(starts)
    used: set[int] = set()
    for index, start in enumerate(starts):
        if start in table:
            matched[index] = table[start]
            used.add(start)
    pending = [milliseconds for milliseconds in table if milliseconds not in used]
    if not pending:
        return matched
    pending.sort()
    for index, start in enumerate(starts):
        if matched[index] is not None:
            continue
        best: int | None = None
        for milliseconds in pending:
            if milliseconds in used:
                continue
            distance = abs(milliseconds - start)
            if distance > _TRANSLATION_TOLERANCE_MS:
                if milliseconds > start + _TRANSLATION_TOLERANCE_MS:
                    break
                continue
            if best is None or distance < abs(best - start):
                best = milliseconds
        if best is not None:
            matched[index] = table[best]
            used.add(best)
    return matched


def strip_inline_translation_lines(
    rows: Sequence[tuple[int, int, str, list[tuple[int, str]]]],
    trans_plaintext: str,
) -> tuple[list[tuple[int, int, str, list[tuple[int, str]]]], int]:
    """剔除 QRC 里内联的译文行, 只留源语言行(见上面的实测说明)。

    rows 的元素是 `(行首毫秒, 行时长毫秒, 纯文本, [(词起毫秒, 文字)])`。
    返回 (保留的行, 剔除行数); 任何一项前提不成立时原样返回。
    """
    table = translation_table(trans_plaintext)
    if not rows or not table:
        return list(rows), 0

    labels = _match_translations([row[0] for row in rows], table)
    covered = sum(1 for label in labels if label is not None)
    if covered / len(rows) < _INLINE_TRANSLATION_COVERAGE:
        return list(rows), 0

    return strip_labelled_translation_rows(rows, labels)


def strip_labelled_translation_rows(
    rows: Sequence[tuple[int, int, str, list[tuple[int, str]]]],
    labels: Sequence[str | None],
) -> tuple[list[tuple[int, int, str, list[tuple[int, str]]]], int]:
    """QQ 的按时间配对表和酷狗的按行配对表共用这一判据。"""
    def has_translation(label: str | None) -> bool:
        return label is not None and label.strip() not in _EMPTY_TRANSLATION

    # 源语言脚本 = 有真译文那些行里最常见的脚本组合。
    tally: dict[frozenset[str], int] = {}
    for index, row in enumerate(rows):
        if not has_translation(labels[index]):
            continue
        signature = _scripts_in(row[2])
        if signature:
            tally[signature] = tally.get(signature, 0) + 1
    if not tally:
        return list(rows), 0
    source_scripts = max(tally.items(), key=lambda item: item[1])[0]

    kept: list[tuple[int, int, str, list[tuple[int, str]]]] = []
    dropped = 0
    previous_is_source = False
    for index, row in enumerate(rows):
        signature = _scripts_in(row[2])
        anchor = has_translation(labels[index])
        is_source_line = bool(signature) and signature == source_scripts
        # 译文行: 非原文锚点 + 紧跟源语言行 + 脚本与源语言完全不相交。
        if (
            not anchor
            and previous_is_source
            and signature
            and signature.isdisjoint(source_scripts)
        ):
            dropped += 1
            # ★ 删掉后**保持** previous_is_source: 连续多行译文要能一起删掉()
            #   实测「深蓝泡沫」是原文/译文严格交替, 但连删更稳妥; 不会误伤原文 ——
            #   真正的原文行 signature == source_scripts, 不可能与 source_scripts 不相交。
            continue
        kept.append(row)
        previous_is_source = anchor or is_source_line
    return kept, dropped


def qrc_to_verbatim_lrc(plaintext: str, trans_plaintext: str = "", *, translations_only: bool = False) -> str:
    """QRC 明文转成前端卡拉OK所需的"每字带时间戳"内联 LRC。

    QRC 的词单元写作 `文字(词起,词时长)`, 词起是**绝对毫秒**(与行头同基准)。
    无词单元的行退化成"整行一个时间戳"; 无时间戳的标签行([ti:]/[ar:] 等)跳过。

    `trans_plaintext` 是同一响应里的行级译文表。传进来时会把内联的译文行剔掉
    (双语歌曲里 QQ 把译文也排成了独立歌词行, 逐字填色会跑到译文上 —— 详见
    `strip_inline_translation_lines` 的实测说明)。不传则完全保持旧行为。
    """
    content = lyric_content(plaintext) or (plaintext or "")
    rows: list[tuple[int, int, str, list[tuple[int, str]]]] = []
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        matched = _LINE_PATTERN.match(line)
        if matched is None:
            continue
        line_start = int(matched.group(1))
        body = matched.group(3)
        if _PURE_TIMESTAMP.match(body.strip()):
            continue
        segments: list[tuple[int, str]] = []
        for word in _WORD_PATTERN.finditer(body):
            text = word.group("content")
            if not text:
                continue
            segments.append((int(word.group("start")), text))
        if not segments:
            fallback = body.strip()
            if fallback:
                segments = [(line_start, fallback)]
        if segments:
            rows.append((line_start, int(matched.group(2)), "".join(text for _t, text in segments), segments))

    if translations_only or trans_plaintext:
        kept, _ = strip_inline_translation_lines(rows, trans_plaintext)
        if translations_only:
            source_lines = {(start, text) for start, _, text, _ in kept}
            rows = [row for row in rows if (row[0], row[2]) not in source_lines]
        else:
            rows = kept
    return inline_lrc([segments for _start, _duration, _text, segments in rows])


def qrc_request_param(
    mid: str,
    *,
    song_id: int = 0,
    name: str = "",
    artist: str = "",
    album: str = "",
    duration_s: int = 0,
) -> dict[str, Any]:
    """GetPlayLyricInfo 的 QRC 参数集(实测: 少了 songName/albumName/singerName 与 qrc=1
    这一整套, 响应里就不会带 QRC 数据)。"""
    encode = lambda value: base64.b64encode(str(value or "").encode()).decode()
    return {
        "albumName": encode(album),
        "crypt": 1,
        "ct": 19,
        "interval": max(0, int(duration_s)),
        "lrc_t": 0,
        "qrc": 1,
        "qrc_t": 0,
        "roma": 1,
        "roma_t": 0,
        "singerName": encode(artist),
        "songID": max(0, int(song_id)),
        "songMID": str(mid or ""),
        "songName": encode(name),
        "trans": 1,
        "trans_t": 0,
    }


def verbatim_enabled() -> bool:
    """QRC 逐字歌词开关(MELODEX_QQ_VERBATIM_LYRIC=0 可关)。"""
    raw = os.environ.get("MELODEX_QQ_VERBATIM_LYRIC", "").strip().lower()
    return raw not in {"0", "false", "no", "off"}


__all__ = [
    "DECRYPT",
    "ENCRYPT",
    "QRC_KEY",
    "decrypt_qrc",
    "key_setup",
    "lyric_content",
    "qrc_bytes",
    "qrc_request_param",
    "qrc_to_verbatim_lrc",
    "verbatim_enabled",
]
