"""网易逐字歌词(YRC)的原生取回与转换。

为什么需要它: Melodex 前端的卡拉OK逐字填色要求"每字带时间戳的内联 LRC"
(frontend/src/contexts/playerLyrics.mjs 的 parseLRC: 同一行里出现 >=2 个
`[mm:ss(.sss)]` 段才算逐字)。QQ 的逐字歌词(QRC)当前是新加密格式, 旧实现的
密钥与算法已解不开(实测 9 种组合全部失败, 载荷非 zlib/非明文), 重新逆向代价过高;
而网易的 YRC 是**明文**的逐字数据, 实测原唱类歌曲可用(如 孤勇者/陈奕迅 9868 字符),
因此逐字歌词改由网易 YRC 提供(同源: 只给网易的歌用网易的歌词, 不做跨源匹配)。

YRC 原始形状(实测):
    [行起,行时长](词起,词时长,保留位)文字(词起,词时长,保留位)文字...
    词起是**绝对毫秒**; 元信息行(作词/作曲等)是 JSON, 不是歌词, 直接跳过。

本模块不引用也不改动 third_party/charles-musicdl 快照。
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any

from provider_bridge.platform_http import PlatformHTTP


LOGGER = logging.getLogger(__name__)

NETEASE_LYRIC_URL = "https://music.163.com/api/song/lyric/v1"
NETEASE_REFERER = "https://music.163.com/"

# 与 snapshot/旧实现一致的解析形状: 行头 [start,dur], 词单元 (start,dur,extra)text。
YRC_LINE_RE = re.compile(r"^\[(\d+),(\d+)\](.*)$")
YRC_WORD_RE = re.compile(r"\((\d+),(\d+),\d+\)([^(\[]*)")

# 前端 parseLRC 认得的时间戳形状, 这里用毫秒三位小数保持一致。
TIMESTAMP_TEMPLATE = "[%02d:%02d.%03d]"


def _string(value: Any) -> str:
    if value is None or value == "NULL":
        return ""
    return str(value).strip()


def _timestamp(milliseconds: int) -> str:
    milliseconds = max(0, int(milliseconds))
    minutes, remainder = divmod(milliseconds, 60_000)
    seconds, millis = divmod(remainder, 1000)
    return TIMESTAMP_TEMPLATE % (minutes, seconds, millis)


def yrc_to_verbatim_lrc(raw: str) -> str:
    """把 YRC 逐字歌词转成前端卡拉OK所需的"每字带时间戳"内联 LRC。

    没有词级数据的行退化成"整行一个时间戳"(前端会按行级高亮), 元信息 JSON 行跳过。
    无法转换时返回空串, 调用方应保留原有歌词。
    """
    out: list[str] = []
    for raw_line in (raw or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        matched = YRC_LINE_RE.match(line)
        if matched is None:
            # 作词/作曲等元信息行是 JSON, 不是歌词。
            continue
        content = matched.group(3)
        segments: list[tuple[int, str]] = []
        for word in YRC_WORD_RE.finditer(content):
            text = word.group(3)
            if not text:
                continue
            segments.append((int(word.group(1)), text))
        if not segments:
            fallback = content.strip()
            if fallback:
                segments = [(int(matched.group(1)), fallback)]
        if not segments:
            continue
        out.append("".join(_timestamp(start) + text for start, text in segments))
    return "\n".join(out)


def verbatim_lyric_enabled() -> bool:
    raw = os.environ.get("MELODEX_NETEASE_VERBATIM_LYRIC", "").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def fetch_verbatim_lyric(song_id: str, *, session: Any | None = None) -> str:
    """取网易逐字歌词(YRC)并转成内联逐字 LRC; 没有词级数据或失败时返回空串。"""
    song_id = _string(song_id)
    if not song_id.isdigit():
        return ""
    try:
        client = PlatformHTTP("", session)
        payload = client.post_form(
            NETEASE_LYRIC_URL,
            {
                "id": song_id,
                "cp": "false",
                "lv": 0,
                "kv": 0,
                "tv": 0,
                "rv": 0,
                "yv": 0,
                "ytv": 0,
                "yrv": 0,
            },
            headers={"Referer": NETEASE_REFERER},
        )
    except Exception as error:  # 逐字歌词是增强项, 失败不能影响搜索本身
        LOGGER.warning("[netease] 逐字歌词请求失败 id=%s: %s", song_id, error)
        return ""
    node = payload.get("yrc")
    raw = _string(node.get("lyric")) if isinstance(node, dict) else ""
    if not raw:
        return ""
    converted = yrc_to_verbatim_lrc(raw)
    if not converted:
        LOGGER.debug("[netease] YRC 有内容但未解析出歌词 id=%s", song_id)
    return converted


__all__ = ["fetch_verbatim_lyric", "verbatim_lyric_enabled", "yrc_to_verbatim_lrc"]
