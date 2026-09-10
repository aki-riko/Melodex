"""逐字歌词的公共格式化层。

前端契约(Web 与桌面客户端共用同一份解析):
    frontend/src/contexts/playerLyrics.mjs 的 parseLRC —— 一行里切出 >= 2 个
    `[mm:ss(.sss)]` 时间段即判定为逐字行, 每个时间戳到下一个时间戳之间的文字就是
    该字的填色区间; 只有 1 段就是普通的整行高亮。
各平台的原始形状不同(网易 YRC 的词时间是**行内绝对毫秒**, 酷狗 KRC 是**相对行首的
毫秒**), 但转换后的目标形状只有一个: `[mm:ss.mmm]词[mm:ss.mmm]词...`。
所以各源只负责把原始数据解析成 [(绝对毫秒, 文字), ...] 的行序列, 格式化在这里统一做。
"""

from __future__ import annotations

from typing import Iterable, Sequence


# 毫秒三位小数: 与前端正则 `\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]` 完全匹配。
TIMESTAMP_TEMPLATE = "[%02d:%02d.%03d]"


def timestamp(milliseconds: int) -> str:
    """把绝对毫秒格式化成前端 parseLRC 认得的 `[mm:ss.mmm]`。"""
    milliseconds = max(0, int(milliseconds))
    minutes, remainder = divmod(milliseconds, 60_000)
    seconds, millis = divmod(remainder, 1000)
    return TIMESTAMP_TEMPLATE % (minutes, seconds, millis)


def inline_line(segments: Sequence[tuple[int, str]]) -> str:
    """把一行的 [(绝对毫秒, 文字)] 拼成内联逐字 LRC 行; 空文字段丢弃。"""
    return "".join(
        timestamp(start) + text for start, text in segments if text
    )


def inline_lrc(lines: Iterable[Sequence[tuple[int, str]]]) -> str:
    """把多行拼接成内联逐字 LRC; 空行丢弃, 全空时返回空串。"""
    rendered = [inline_line(line) for line in lines]
    return "\n".join(line for line in rendered if line)


__all__ = ["TIMESTAMP_TEMPLATE", "inline_lrc", "inline_line", "timestamp"]
