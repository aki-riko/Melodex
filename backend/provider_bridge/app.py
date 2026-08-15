"""JSON mapping layer around the pinned CharlesPikachu/musicdl providers."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any, Callable


SOURCE_CLASSES = {
    "apple": "AppleMusicClient",
    "bilibili": "BilibiliMusicClient",
    "fivesing": "FiveSingMusicClient",
    "jamendo": "JamendoMusicClient",
    "joox": "JooxMusicClient",
    "kugou": "KugouMusicClient",
    "kuwo": "KuwoMusicClient",
    "migu": "MiguMusicClient",
    "netease": "NeteaseMusicClient",
    "qianqian": "QianqianMusicClient",
    "qq": "QQMusicClient",
    "soda": "SodaMusicClient",
}


def load_client_class(source: str):
    from musicdl.modules import sources

    return getattr(sources, SOURCE_CLASSES[source])


def _string(value: Any) -> str:
    if value is None or value == "NULL":
        return ""
    return str(value).strip()


def _integer(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def song_to_payload(song: Any, source: str, rank: int) -> dict[str, Any]:
    raw = song.todict() if hasattr(song, "todict") else dict(song)
    status = raw.get("download_url_status") or {}
    probe = status.get("probe_status") if isinstance(status, dict) else {}
    if not isinstance(probe, dict):
        probe = {}
    size = _integer(raw.get("file_size_bytes") or probe.get("file_size_bytes"))
    headers = raw.get("default_download_headers") or {}
    raw_data = raw.get("raw_data") or {}
    lyric = _string(raw.get("lyric"))
    ext = _string(raw.get("ext")).removeprefix(".").lower()
    extra = {
        "_rank": str(rank),
        "provider": "charles-musicdl",
        "provider_commit": "b4cecd9d450ede6f5c8d4df08763668256dfee58",
    }
    if lyric:
        extra["lyric"] = lyric
    if headers:
        extra["download_headers"] = json.dumps(headers, ensure_ascii=False, separators=(",", ":"))
    if isinstance(raw_data, dict) and _string(raw_data.get("play_auth")):
        extra["play_auth"] = _string(raw_data.get("play_auth"))
    if ext in {"flac", "wav", "alac", "ape", "wv", "tta", "dsf", "dff"}:
        extra["has_lossless"] = "1"
    return {
        "id": _string(raw.get("identifier")),
        "name": _string(raw.get("song_name")),
        "artist": _string(raw.get("singers")),
        "album": _string(raw.get("album")),
        "album_id": "",
        "duration": _integer(raw.get("duration_s")),
        "size": size,
        "bitrate": _integer(raw.get("bitrate")),
        "source": source,
        "url": _string(raw.get("download_url")),
        "ext": ext,
        "cover": _string(raw.get("cover_url")),
        "link": "",
        "extra": extra,
        "is_invalid": not bool(raw.get("download_url")),
        "is_vip": False,
    }


def search(
    payload: dict[str, Any],
    *,
    client_factory: Callable[..., Any] | None = None,
    work_dir: str,
) -> dict[str, Any]:
    source = _string(payload.get("source")).lower()
    keyword = _string(payload.get("keyword"))
    limit = min(max(_integer(payload.get("limit")) or 20, 1), 100)
    if source not in SOURCE_CLASSES:
        raise ValueError(f"unsupported source: {source}")
    if not keyword:
        raise ValueError("keyword is required")
    cookie = _string(payload.get("cookie"))
    if client_factory is None:
        client_factory = load_client_class(source)
    work_root = Path(work_dir)
    work_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="search-", dir=work_root) as search_work_dir:
        client = client_factory(
            search_size_per_source=limit,
            search_size_per_page=limit,
            default_search_cookies=cookie,
            default_download_cookies=cookie,
            disable_print=True,
            work_dir=search_work_dir,
        )
        songs = client.search(keyword=keyword)
        return {
            "songs": [
                song_to_payload(song, source, rank)
                for rank, song in enumerate(songs[:limit])
            ]
        }
