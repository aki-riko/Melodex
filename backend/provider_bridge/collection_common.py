"""Provider-neutral payload builders for sidecar collection operations."""

from __future__ import annotations

import html
import re
from typing import Any, Iterable
from urllib.parse import parse_qs, urlparse


def string(value: Any) -> str:
    if value is None or value == "NULL":
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def integer(value: Any) -> int:
    try:
        return max(0, int(float(value or 0)))
    except (TypeError, ValueError):
        return 0


# ---------------------------------------------------------------------------
# 与上面两个**语义不同**的变体(2026-11 全库扫描收敛时补的)。
#
# 背景:app.py / qq_source.py / netease_source.py / kuwo_source.py /
# kugou_lyric.py / netease_chorus.py / netease_lyric.py 各自私有一份
# `_string` / `_integer`,七份 `_string` 与六份 `_integer` 逐字相同,
# 但**与上面的 string/integer 并不等价**。实测差异只有两处
# (由 tests/test_collection_common_strict.py 逐字节对照,勿凭直觉推测):
#   · strict_string(3.0) == "3.0",而 string(3.0) == "3"
#     —— 私有实现没有 float 特判;
#   · strict_integer("3.5") == 0,而 integer("3.5") == 3
#     —— 私有实现直接 int(),字符串小数让它抛 ValueError。
#   (注意 "200" 这种**整数字符串**两边都是 200,不是差异点。)
#
# 那为什么不直接把私有实现换成 string/integer?因为那**会改变行为**:
# 某些上游字段是浮点(如时长 200.0),换成 string() 会把 "200.0" 变成 "200";
# 而某些字段上游给字符串小数,换成 integer() 会从 0 变成截断值。
# 在没有任何失败证据的情况下改这两个语义,风险高于收益。
#
# 所以这里提供**严格等价**的两个函数,只消除"七份逐字相同的拷贝",
# 不改任何一处语义。将来若确认某个字段类型稳定,再单独把该调用点换成
# string/integer(那是一次独立的、可验证的行为变更)。
# ---------------------------------------------------------------------------


def strict_string(value: Any) -> str:
    """与各 provider 私有 `_string` 逐字等价(无 float 特判)。"""
    if value is None or value == "NULL":
        return ""
    return str(value).strip()


def strict_integer(value: Any) -> int:
    """与各 provider 私有 `_integer` 逐字等价(只接受数字类型,不解析字符串)。"""
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def list_value(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def object_value(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def at(value: Any, *keys: str) -> Any:
    current = value
    for key in keys:
        current = object_value(current).get(key)
        if current is None:
            return None
    return current


def first(raw: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = string(raw.get(key))
        if value:
            return value
    return ""


def first_integer(raw: dict[str, Any], *keys: str) -> int:
    for key in keys:
        value = integer(raw.get(key))
        if value:
            return value
    return 0


def join_names(value: Any, key: str = "name", separator: str = ", ") -> str:
    names = [string(object_value(item).get(key)) for item in list_value(value)]
    return separator.join(name for name in names if name)


def track_payload(
    *,
    identifier: str,
    source: str,
    name: str = "",
    artist: str = "",
    album: str = "",
    album_id: str = "",
    duration: int = 0,
    size: int = 0,
    bitrate: int = 0,
    ext: str = "",
    cover: str = "",
    link: str = "",
    extra: dict[str, str] | None = None,
) -> dict[str, Any]:
    return {
        "id": string(identifier),
        "source": string(source),
        "name": string(name),
        "artist": string(artist),
        "album": string(album),
        "album_id": string(album_id),
        "duration": integer(duration),
        "size": integer(size),
        "bitrate": integer(bitrate),
        "url": "",
        "ext": string(ext),
        "cover": string(cover),
        "link": string(link),
        "extra": {str(key): string(value) for key, value in (extra or {}).items()},
    }


def collection_payload(
    *,
    identifier: str,
    source: str,
    name: str = "",
    creator: str = "",
    description: str = "",
    cover: str = "",
    link: str = "",
    track_count: int = 0,
    play_count: int = 0,
    extra: dict[str, str] | None = None,
) -> dict[str, Any]:
    return {
        "id": string(identifier),
        "source": string(source),
        "name": string(name),
        "creator": string(creator),
        "description": string(description),
        "cover": string(cover),
        "link": string(link),
        "track_count": integer(track_count),
        "play_count": integer(play_count),
        "extra": {str(key): string(value) for key, value in (extra or {}).items()},
    }


def category_payload(
    *, identifier: str, source: str, name: str, group: str, hot: bool = False,
    extra: dict[str, str] | None = None,
) -> dict[str, Any]:
    return {
        "id": string(identifier), "source": string(source), "name": string(name),
        "group": string(group), "count": 0, "hot": bool(hot),
        "extra": {str(key): string(value) for key, value in (extra or {}).items()},
    }


def page_limit(page: Any, limit: Any, default: int = 30) -> tuple[int, int]:
    page_value = max(1, integer(page) or 1)
    limit_value = integer(limit) or default
    return page_value, min(max(limit_value, 1), 100)


def link_id(link: str, *query_keys: str) -> str:
    parsed = urlparse(string(link))
    query = parse_qs(parsed.query)
    for key in query_keys:
        values = query.get(key, [])
        if values and string(values[0]):
            return string(values[0])
    return parsed.path.rstrip("/").rsplit("/", 1)[-1]


def regex_link_id(link: str, patterns: Iterable[str]) -> str:
    for pattern in patterns:
        match = re.search(pattern, string(link), re.IGNORECASE)
        if match:
            return match.group(1)
    return ""


def normalize_kuwo_text(value: Any) -> str:
    return html.unescape(string(value).replace("&nbsp;", " ")).strip()

