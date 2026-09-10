"""酷狗逐字歌词(KRC)的原生取回与转换。

为什么需要它: 逐字歌词原本只有网易 YRC 一路, 但实测 YRC 覆盖很稀(周杰伦 晴天/稻香/
七里香/青花瓷/夜曲、起风了、漠河舞厅、海阔天空 全都没有 yrc 字段), 而酷狗 KRC 恰好
覆盖这些主流中文原唱(实测 晴天 55 个词级行 / 稻香 42 个), 两者互补。QQ 的 QRC 已是
新加密格式(9 种旧密钥组合全部解不开), 暂不可用。

取回链路(端点与参数取自快照 musicdl/modules/sources/kugou.py:145-153, **只把 fmt 由
lrc 换成 krc**):
    GET  https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=&duration=&hash=
         -> {"status":200,"candidates":[{"id","accesskey","song","singer",...}]}
    GET  https://lyrics.kugou.com/download?ver=1&client=pc&id=&accesskey=&fmt=krc&charset=utf8
         -> {"content": base64(KRC 密文)}

KRC 密文 = 4 字节头 + (正文 XOR 16 字节固定密钥) 的 zlib 流; 解出来是明文:
    [行起,行时长]<词起,词时长,保留位>词<词起,词时长,保留位>词...
其中**词起是相对行首的毫秒**(YRC 是绝对毫秒), 所以要先加行起再交给前端。

挑选候选的坑(实测): candidates 里的 `duration`/`score` 都是垃圾值(晴天首条 duration 只有
116000ms 而歌长 269s), 快照直接取 candidates[0] 并不可靠; 这里按 song/singer 归一化匹配
排序, 取第一个能解出足够词级行的候选, 最多试 MAX_TRY_CANDIDATES 个。

本模块不引用也不改动 third_party/charles-musicdl 快照。
"""

from __future__ import annotations

import base64
import binascii
import logging
import os
import re
import unicodedata
import urllib.parse
import zlib
from typing import Any

from provider_bridge.platform_http import PlatformHTTP
from provider_bridge.verbatim_lyric import inline_lrc


LOGGER = logging.getLogger(__name__)

KRC_SEARCH_URL = "https://lyrics.kugou.com/search"
KRC_DOWNLOAD_URL = "https://lyrics.kugou.com/download"

# 4 字节头之后是 XOR 密钥加密的 zlib 流(XOR 密钥循环使用)。
KRC_HEADER_BYTES = 4
KRC_KEY = bytes((
    0x40, 0x47, 0x61, 0x77, 0x5E, 0x32, 0x74, 0x47,
    0x51, 0x36, 0x31, 0x2D, 0xCE, 0xD2, 0x6E, 0x69,
))

# KRC 明文形状: 行头 [start,dur], 词单元 <start,dur,extra>text。
KRC_LINE_RE = re.compile(r"^\[(\d+),(\d+)\](.*)$")
KRC_WORD_RE = re.compile(r"<(\d+),(\d+),\d+>([^<\[]*)")
# 前端判定"逐字行"的规则: 一行里 >= 2 个时间戳。
TIMESTAMP_RE = re.compile(r"\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]")

# 一个候选就算"够好"的词级行数(实测 晴天 55 行 / 稻香 42 行, 取 15 避免为凑数多打请求)。
GOOD_ENOUGH_WORD_LINES = 15
MAX_TRY_CANDIDATES = 3


def _string(value: Any) -> str:
    if value is None or value == "NULL":
        return ""
    return str(value).strip()


def _integer(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _normalize(value: Any) -> str:
    """归一化用于比对: 去空白/标点/全半角差异, 大小写不敏感。"""
    text = unicodedata.normalize("NFKC", _string(value)).casefold()
    return "".join(char for char in text if char.isalnum())


def decode_krc(content: str) -> str:
    """解 base64 -> 去 4 字节头 -> 固定密钥 XOR -> zlib, 得到 KRC 明文。"""
    raw = _string(content)
    if not raw:
        return ""
    try:
        blob = base64.b64decode(raw, validate=False)
    except (binascii.Error, ValueError) as error:
        LOGGER.warning("[kugou] KRC base64 解码失败: %s", error)
        return ""
    if len(blob) <= KRC_HEADER_BYTES:
        LOGGER.warning("[kugou] KRC 载荷过短(%d 字节)", len(blob))
        return ""
    body = blob[KRC_HEADER_BYTES:]
    key = KRC_KEY
    plain = bytes(byte ^ key[index % len(key)] for index, byte in enumerate(body))
    for decompress in (zlib.decompress, lambda data: zlib.decompressobj(-15).decompress(data)):
        try:
            return decompress(plain).decode("utf-8", errors="replace")
        except zlib.error:
            continue
    LOGGER.warning("[kugou] KRC zlib 解压失败(%d 字节)", len(plain))
    return ""


def _segments(content: str, line_start: int) -> list[tuple[int, str]]:
    """解析一行词单元; 词时间是**相对行首**的毫秒, 这里换算成绝对毫秒。"""
    segments: list[tuple[int, str]] = []
    for word in KRC_WORD_RE.finditer(content):
        text = word.group(3)
        if not text:
            continue
        segments.append((line_start + int(word.group(1)), text))
    if segments:
        return segments
    fallback = KRC_WORD_RE.sub("", content).strip()
    return [(line_start, fallback)] if fallback else []


def krc_to_verbatim_lrc(raw: str) -> str:
    """把 KRC 明文转成前端卡拉OK所需的"每字带时间戳"内联 LRC。

    无词单元的行退化成"整行一个时间戳"(前端按行级高亮), 无时间戳的行跳过。
    无法转换时返回空串, 调用方应保留原有歌词。
    """
    lines: list[list[tuple[int, str]]] = []
    for raw_line in (raw or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        matched = KRC_LINE_RE.match(line)
        if matched is None:
            continue
        segments = _segments(matched.group(3), int(matched.group(1)))
        if segments:
            lines.append(segments)
    return inline_lrc(lines)


def word_level_line_count(lrc: str) -> int:
    """统计内联 LRC 里会被前端做成逐字填色的行数(>= 2 个时间戳)。"""
    count = 0
    for line in (lrc or "").splitlines():
        if len(TIMESTAMP_RE.findall(line)) >= 2:
            count += 1
    return count


def _rank_candidates(candidates: list[Any], name: str, artist: str) -> list[dict[str, Any]]:
    """按 song/singer 与目标歌名歌手的匹配度排序候选。

    candidates 的 `score`/`duration` 字段实测是垃圾值, 不可作为依据, 所以自己算匹配分;
    没有任何候选匹配上时退回原顺序(至少与快照的 candidates[0] 行为一致)。
    """
    target_name = _normalize(name)
    target_artist = _normalize(artist)
    scored: list[tuple[int, int, dict[str, Any]]] = []
    for index, candidate in enumerate(candidates):
        if not isinstance(candidate, dict):
            continue
        song = _normalize(candidate.get("song") or candidate.get("soundname"))
        singer = _normalize(candidate.get("singer"))
        score = 0
        if target_name and song:
            if song == target_name:
                score += 4
            elif target_name in song or song in target_name:
                score += 2
        if target_artist and singer:
            if singer == target_artist:
                score += 3
            elif target_artist in singer or singer in target_artist:
                score += 1
        scored.append((score, index, candidate))
    matched = [item for item in scored if item[0] > 0]
    ordered = matched or scored
    ordered.sort(key=lambda item: (-item[0], item[1]))
    return [item[2] for item in ordered]


def _download_url(identifier: str, accesskey: str) -> str:
    """KRC 下载地址; 参数与快照一致, 只把 fmt 由 lrc 换成 krc。"""
    query = urllib.parse.urlencode({
        "ver": "1",
        "client": "pc",
        "id": identifier,
        "accesskey": accesskey,
        "fmt": "krc",
        "charset": "utf8",
    })
    return f"{KRC_DOWNLOAD_URL}?{query}"


def _candidate_krc(client: PlatformHTTP, candidate: dict[str, Any]) -> str:
    """取单个候选的 KRC 并转成内联逐字 LRC; 失败返回空串。"""
    identifier = _string(candidate.get("id"))
    accesskey = _string(candidate.get("accesskey"))
    if not identifier or not accesskey:
        return ""
    try:
        payload = client.get(_download_url(identifier, accesskey))
    except Exception as error:
        LOGGER.warning("[kugou] KRC 下载失败 id=%s: %s", identifier, error)
        return ""
    if not isinstance(payload, dict):
        return ""
    raw = decode_krc(_string(payload.get("content")))
    if not raw:
        return ""
    return krc_to_verbatim_lrc(raw)


def fetch_verbatim_lyric(
    name: str,
    artist: str = "",
    *,
    duration_s: int = 0,
    file_hash: str = "",
    session: Any | None = None,
) -> str:
    """按歌名/歌手取酷狗逐字歌词(KRC); 取不到词级数据或失败时返回空串。"""
    name = _string(name)
    artist = _string(artist)
    if not name:
        return ""
    # 关键词形状与快照一致(它用的是搜索结果里的 filename, 形如 "歌手 - 歌名")。
    keyword = f"{artist} - {name}" if artist else name
    query = {"ver": "1", "man": "yes", "client": "pc", "keyword": keyword}
    if _integer(duration_s):
        query["duration"] = str(_integer(duration_s))
    if _string(file_hash):
        query["hash"] = _string(file_hash)
    try:
        client = PlatformHTTP("", session)
        payload = client.get(f"{KRC_SEARCH_URL}?{urllib.parse.urlencode(query)}")
    except Exception as error:  # 逐字歌词是增强项, 失败不能影响搜索本身
        LOGGER.warning("[kugou] 逐字歌词检索失败 keyword=%r: %s", keyword, error)
        return ""
    candidates = payload.get("candidates") if isinstance(payload, dict) else None
    if not isinstance(candidates, list) or not candidates:
        LOGGER.debug("[kugou] 无歌词候选 keyword=%r", keyword)
        return ""
    best = ""
    best_lines = 0
    for candidate in _rank_candidates(candidates, name, artist)[:MAX_TRY_CANDIDATES]:
        converted = _candidate_krc(client, candidate)
        lines = word_level_line_count(converted)
        if lines > best_lines:
            best, best_lines = converted, lines
        if best_lines >= GOOD_ENOUGH_WORD_LINES:
            break
    if not best_lines:
        LOGGER.debug("[kugou] 候选都无词级歌词 keyword=%r", keyword)
    return best


def verbatim_lyric_enabled() -> bool:
    raw = os.environ.get("MELODEX_KUGOU_VERBATIM_LYRIC", "").strip().lower()
    return raw not in {"0", "false", "no", "off"}


__all__ = [
    "decode_krc",
    "fetch_verbatim_lyric",
    "krc_to_verbatim_lrc",
    "verbatim_lyric_enabled",
    "word_level_line_count",
]
