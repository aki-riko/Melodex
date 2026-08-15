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

