"""JSON mapping layer around the pinned CharlesPikachu/musicdl providers."""

from __future__ import annotations

import json
import logging
import tempfile
from pathlib import Path
from typing import Any, Callable

from provider_bridge import qq_source


LOGGER = logging.getLogger(__name__)

# 已知的"上游自己变了"的源:失败原因写清楚, 免得只留一句 'NoneType' 让人去猜。
SOURCE_FAILURE_HINTS = {
    "apple": (
        "Apple 的 JWT 头已由 {\"alg\":...}(eyJh 开头) 变成 {\"typ\":\"JWT\",\"alg\":...}(eyJ0 开头), "
        "快照写死的 (?=eyJh) 匹配不到 → token_match=None → 这里报 AttributeError; "
        "该源已从默认搜索源摘除(另实测: 没有 media-user-token 时下载地址只有 AudioPrev 试听片段, "
        "要恢复需先有 Apple 会员登录态)"
    ),
}


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


def source_status() -> dict[str, Any]:
    """各源最近一次请求的观测状态, 供 /health 暴露。

    QQ 之前整条失效时是完全静默的, 光靠日志需要人去翻; 放到 /health 里之后, 巡检和
    监控也能直接看到"这个源在被限流 / 凭证过期 / 一首都没取到地址"。
    """
    return {"qq": qq_source.status()}


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
    # search_type 由 Go 侧传入: 0=普通搜歌, 7=按歌词片段检索(仅 QQ 原生支持)。
    search_type = _integer(payload.get("search_type"))
    # QQ 走 Melodex 自有实现(见 qq_source 模块说明):快照的 QQ 取地址链路打的是 QQ 已
    # 停用的 u.y.qq.com,拿不到 purl 就会把所有 QQ 歌曲当作不可播丢弃,导致 QQ 源恒为空。
    if source == "qq" and client_factory is None:
        work_root = Path(work_dir)
        work_root.mkdir(parents=True, exist_ok=True)
        return {"songs": qq_source.search(
            keyword, limit, cookie, work_dir=work_dir, search_type=search_type,
        )}
    if client_factory is None:
        client_factory = load_client_class(source)
    work_root = Path(work_dir)
    work_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="search-", dir=work_root) as search_work_dir:
        # 注意: 必须连客户端构造一起包住。快照里不少源在 __init__ 阶段就要访问上游
        # (apple 就在构造 authorization 头时调 _fetchtoken), 只包 search() 会漏掉它们。
        try:
            client = client_factory(
                search_size_per_source=limit,
                search_size_per_page=limit,
                default_search_cookies=cookie,
                default_download_cookies=cookie,
                disable_print=True,
                work_dir=search_work_dir,
            )
            songs = client.search(keyword=keyword)
        except Exception as error:
            # 不允许静默失败: 上游失效时必须留下"哪个源、为什么"的痕迹, 而不是只有
            # 一句 Python 异常名让排查的人自己猜。
            hint = SOURCE_FAILURE_HINTS.get(source, "")
            LOGGER.warning(
                "[%s] 搜索失败 keyword=%r limit=%d: %s: %s%s",
                source, keyword, limit, type(error).__name__, error,
                " —— " + hint if hint else "",
            )
            raise
        return {
            "songs": [
                song_to_payload(song, source, rank)
                for rank, song in enumerate(songs[:limit])
            ]
        }
