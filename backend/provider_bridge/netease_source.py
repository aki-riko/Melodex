"""网易歌词片段搜索(原生实现)。

为什么需要它: Melodex 的「按歌词片段搜歌」在 Go 侧走 `search_type=7`, 但真正把它当
**歌词检索**做的只有 QQ; 其余源(网易/酷我/咪咕)只是把关键词当歌名搜, 搜歌词会得到一堆
同名垃圾。而 QQ 会员凭证一失效, 这条功能对用户就等于不可用 —— 所以给网易补一条真实链路。

网易有一条**匿名可用**的歌词检索接口(实测):
    POST https://music.163.com/api/search/get/web   s=<片段>&type=1006
实测: 搜「都 是勇敢的」→ 第 1 名就是 孤勇者/陈奕迅 **原唱**;
      而 type=1(歌名搜索)返回的是「我们都是勇敢的 伴奏」这类同名垃圾。

播放地址沿用快照的 eapi 取地址方式(端点/参数/加密都取自
musicdl/modules/sources/netease.py:173-181 与 musicdl/modules/utils/neteaseutils.py,
只 import 不改动快照):
    POST https://interface3.music.163.com/eapi/song/enhance/player/url/v1
    data={'params': EapiCryptoUtils.encryptparams(url=..., payload={...})}
实测(关键, 省掉快照那样的 8 档阶梯): 请求最高档 lossless 时, 接口直接返回**实际**
给到的档位(如 level=exhigh + 320k mp3 + 真实 size), 所以每首歌只打一次地址请求。

付费曲(fee=1)匿名拿不到地址, 必须有管理员保存的网易 cookie —— 与快照行为一致:
没取到地址的候选标记 is_invalid, 前端验活会自动隐藏它们。
"""

from __future__ import annotations

import json
import logging
import os
import random
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from provider_bridge.platform_http import PlatformHTTP


LOGGER = logging.getLogger(__name__)


class NeteaseRateLimited(RuntimeError):
    """网易搜索接口限流(上游用 code=405 表达, 而非 HTTP 状态码)。"""


# 最近一次网易搜索的观测快照, 供 /health 暴露。限流和"真的没有这首歌"在日志里
# 长得完全不一样, 但都需要能在不进容器翻日志的情况下被巡检看到。
_status_lock = threading.Lock()
_status: dict[str, Any] = {}


def _record_status(**fields: Any) -> None:
    with _status_lock:
        _status.update(fields)
        _status["updated_at"] = int(time.time())


def status() -> dict[str, Any]:
    """返回最近一次网易搜索/取地址的观测快照(未发生过请求时为空字典)。"""
    with _status_lock:
        return dict(_status)


# 搜索接口: 必须用 cloudsearch(pc)。旧的 /api/search/get/web 已对**几乎所有调用方**
# 限流: 2026-10 实测连续请求无论带不带 cookie 都只回
#     {"code":405,"msg":"操作频繁，请稍候再试"}
# 上游不再返回 result.songs, 于是 search_songs 拿不到任何候选 → 播放时按歌名回查
# 必然 "provider returned no matching songs" → /music/playback_segment 502 →
# 前端 MSE 管线 6 次重试后报「连续播放缓冲异常」。cloudsearch 同一时刻 `code=200`
# 且 20/20 可取到播放地址(带 cookie 时含付费曲), 是本源唯一还能用的搜索入口。
#
# 历史: 这里原先还带 type=1006 的歌词检索(旧端点同一路径只换 type)。cloudsearch
# 也支持 type=1006 且返回形状一致(见 lyric_matches), 所以两个入口统一换过去。
SEARCH_URL = "https://music.163.com/api/cloudsearch/pc"
SONG_LYRIC_URL = "https://music.163.com/api/song/lyric/v1"
LYRIC_SEARCH_TYPE = 1006
SONG_SEARCH_TYPE = 1
# 上游限流时返回的 code(405=操作频繁); 用来把"被限流"和"真的没这首歌"区分开。
RATE_LIMIT_CODE = 405
SONG_DETAIL_URL = "https://music.163.com/api/song/detail"
EAPI_URL = "https://interface3.music.163.com/eapi/song/enhance/player/url/v1"
NETEASE_HEADERS = {"Referer": "https://music.163.com/"}

# 请求最高档即可: 实测接口返回的是实际给到的档位, 不需要逐档重试。
REQUEST_LEVEL = "lossless"
# eapi 要求的固定设备 cookie(取自快照 netease.py:178)。
EAPI_DEVICE_COOKIES = {"os": "pc", "appver": "", "osver": "", "deviceId": "pyncm!"}

PROVIDER_COMMIT = "b4cecd9d450ede6f5c8d4df08763668256dfee58"
LOSSLESS_EXTENSIONS = {"flac", "wav", "alac", "ape", "wv", "tta", "dsf", "dff"}


def _string(value: Any) -> str:
    if value is None or value == "NULL":
        return ""
    return str(value).strip()


def _integer(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _eapi_params(song_id: str) -> str:
    """用快照的 EapiCryptoUtils 加密参数(快照只被 import, 不修改)。"""
    from musicdl.modules.utils.neteaseutils import EapiCryptoUtils

    payload = {
        "ids": [song_id],
        "level": REQUEST_LEVEL,
        "encodeType": "flac",
        "header": json.dumps({
            "os": "pc",
            "appver": "",
            "osver": "",
            "deviceId": "pyncm!",
            "requestId": str(random.randrange(20000000, 30000000)),
        }),
    }
    return EapiCryptoUtils.encryptparams(url=EAPI_URL, payload=payload)


def _cookies_for(cookie: str) -> str:
    """设备 cookie(eapi 需要) + 管理员保存的账号 cookie 合成一个 Cookie 头。

    注意: 这里必须显式传 Cookie 头而不是用 PlatformHTTP(cookie) —— 它的 request()
    会无条件用会话 cookie 覆盖调用方传进来的 Cookie 头(platform_http.py:47-48),
    那样设备 cookie 就丢了。
    """
    cookies = dict(EAPI_DEVICE_COOKIES)
    for part in (cookie or "").split(";"):
        name, separator, value = part.partition("=")
        if separator and name.strip():
            cookies[name.strip()] = value.strip()
    return "; ".join(f"{name}={value}" for name, value in cookies.items())


def _artists(raw: dict[str, Any]) -> str:
    names = [
        _string(artist.get("name"))
        for artist in (raw.get("artists") or raw.get("ar") or [])
        if isinstance(artist, dict) and _string(artist.get("name"))
    ]
    return ", ".join(names)


def _album(raw: dict[str, Any]) -> dict[str, Any]:
    album = raw.get("album") or raw.get("al") or {}
    return album if isinstance(album, dict) else {}


def lyric_matches(client: PlatformHTTP, keyword: str, limit: int) -> list[dict[str, Any]]:
    """歌词片段检索; 失败时抛异常由调用方决定降级。"""
    return _search(client, keyword, limit, LYRIC_SEARCH_TYPE)


def song_matches(client: PlatformHTTP, keyword: str, limit: int) -> list[dict[str, Any]]:
    """普通搜歌(type=1)。"""
    return _search(client, keyword, limit, SONG_SEARCH_TYPE)


def fetch_lyric(song_id: str, *, cookie: str = "", session: Any | None = None) -> str:
    """按网易歌曲 ID 取行级 LRC。

    原生搜歌为了保持低延迟不会给每个候选额外请求歌词；播放页按需取歌词时
    再走这条接口，避免把“搜索结果没有 lyric”误当成“歌曲没有歌词”。
    """
    song_id = _string(song_id)
    if not song_id.isdigit():
        return ""
    client = PlatformHTTP(cookie, session)
    try:
        payload = client.post_form(
            SONG_LYRIC_URL,
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
            headers=NETEASE_HEADERS,
        )
    except Exception as error:
        LOGGER.warning("[netease] 按 ID 取歌词失败 id=%s: %s", song_id, error)
        return ""
    node = payload.get("lrc") if isinstance(payload, dict) else None
    lyric = _string(node.get("lyric")) if isinstance(node, dict) else ""
    return lyric


def _search(client: PlatformHTTP, keyword: str, limit: int, search_type: int) -> list[dict[str, Any]]:
    payload = client.post_form(
        SEARCH_URL,
        {"s": keyword, "type": search_type, "limit": limit, "offset": 0},
        headers=NETEASE_HEADERS,
    )
    if isinstance(payload, dict) and _integer(payload.get("code")) == RATE_LIMIT_CODE:
        # 上游把"限流"也塞进 200 响应里(旧端点尤其如此)。这里必须显式抛出去:
        # 静默返回 [] 会和"真的没这首歌"混成一个日志, 让人误判成搜索/匹配逻辑坏了。
        raise NeteaseRateLimited(
            f"网易搜索被限流: {_string(payload.get('msg')) or '操作频繁'}"
        )
    songs = (payload.get("result") or {}).get("songs") if isinstance(payload, dict) else None
    if not isinstance(songs, list):
        return []
    return [song for song in songs if isinstance(song, dict) and _integer(song.get("id"))]


def song_details(client: PlatformHTTP, song_ids: list[str]) -> dict[str, dict[str, Any]]:
    """批量取详情(封面/时长); 拿不到就当没有, 不影响主流程。"""
    if not song_ids:
        return {}
    # 实测可用的形式是整数数组(ids=[1901371647, 569153583]); 数字串已过 isdigit 校验,
    # 转换后既不会引入注入面, 也与实测请求完全一致。
    numeric_ids = [int(sid) for sid in song_ids if sid.isdigit()]
    if not numeric_ids:
        return {}
    url = SONG_DETAIL_URL + "?ids=" + json.dumps(numeric_ids)
    try:
        payload = client.get(url, headers=NETEASE_HEADERS)
    except Exception as error:
        LOGGER.warning("[netease] 歌词搜索取详情失败: %s", error)
        return {}
    songs = payload.get("songs") if isinstance(payload, dict) else None
    if not isinstance(songs, list):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for song in songs:
        if isinstance(song, dict) and _string(song.get("id")):
            out[_string(song.get("id"))] = song
    return out


def resolve_play_url(song_id: str, cookie: str, session: Any | None = None) -> dict[str, Any]:
    """取播放地址; 返回 {} 表示这个账号/凭证拿不到(付费曲匿名必然拿不到)。"""
    try:
        params = _eapi_params(song_id)
    except Exception as error:  # 快照工具不可用(如未安装)时不能拖垮搜索
        LOGGER.warning("[netease] eapi 参数加密失败: %s", error)
        return {}
    client = PlatformHTTP("", session)
    try:
        payload = client.post_form(
            EAPI_URL, {"params": params}, headers={**NETEASE_HEADERS, "Cookie": _cookies_for(cookie)}
        )
    except Exception as error:
        LOGGER.warning("[netease] 歌词搜索取地址失败 id=%s: %s", song_id, error)
        return {}
    data = payload.get("data") if isinstance(payload, dict) else None
    item = data[0] if isinstance(data, list) and data and isinstance(data[0], dict) else None
    if not item or not _string(item.get("url")):
        return {}
    return item


def _extension(url: str, level: dict[str, Any]) -> str:
    path = urllib.parse.urlparse(url).path
    suffix = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    if suffix and len(suffix) <= 5 and suffix.isalnum():
        return suffix
    return _string(level.get("type")).lower()


def build_payload(
    raw: dict[str, Any],
    detail: dict[str, Any] | None,
    resolution: dict[str, Any] | None,
    rank: int,
) -> dict[str, Any]:
    """与快照 song_to_payload 形状对齐的 payload(前端/Go 侧按同一套字段消费)。"""
    resolution = resolution or {}
    detail = detail or {}
    song_id = _string(raw.get("id"))
    url = _string(resolution.get("url"))
    ext = _extension(url, resolution) if url else ""
    # 搜索结果里的 album 只有 id/name(没有 picUrl), 封面要取详情那份。
    album = _album(raw)
    detail_album = _album(detail)
    cover = _string(album.get("picUrl")) or _string(detail_album.get("picUrl"))
    album_name = _string(album.get("name")) or _string(detail_album.get("name"))
    extra: dict[str, str] = {
        "_rank": str(rank),
        "provider": "charles-musicdl",
        "provider_commit": PROVIDER_COMMIT,
    }
    if ext in LOSSLESS_EXTENSIONS:
        extra["has_lossless"] = "1"
    # 时长口径: 旧搜索接口用 `duration`, cloudsearch(pc) 用 `dt`, 详情接口又回到
    # `duration` —— 三者都是毫秒。按序取第一个非零值, 否则详情请求失败时时长会丢。
    duration_ms = (
        _integer(raw.get("duration"))
        or _integer(raw.get("dt"))
        or _integer(detail.get("duration"))
        or _integer(detail.get("dt"))
    )
    return {
        "id": song_id,
        "name": _string(raw.get("name")),
        "artist": _artists(raw),
        "album": album_name,
        "album_id": "",
        "duration": _integer(duration_ms / 1000),
        "size": _integer(resolution.get("size")),
        "bitrate": _integer(resolution.get("br")) // 1000,
        "source": "netease",
        "url": url,
        "ext": ext,
        "cover": cover,
        "link": "",
        "extra": extra,
        "is_invalid": not url,
        "is_vip": False,
    }


def _payloads_for(
    client: PlatformHTTP,
    matches: list[dict[str, Any]],
    cookie: str,
    session: Any | None,
) -> list[dict[str, Any]]:
    song_ids = [_string(song.get("id")) for song in matches]
    details = song_details(client, song_ids)
    with ThreadPoolExecutor(max_workers=min(6, len(song_ids))) as pool:
        resolutions = list(pool.map(lambda sid: resolve_play_url(sid, cookie, session), song_ids))
    return [
        build_payload(raw, details.get(_string(raw.get("id"))), resolution, rank)
        for rank, (raw, resolution) in enumerate(zip(matches, resolutions))
    ]


def playable_ratio(payloads: list[dict[str, Any]]) -> float:
    """可播比例; 凭证失效时网易付费曲会整片拿不到地址, 用它决定要不要退回快照实现。"""
    if not payloads:
        return 0.0
    return sum(1 for item in payloads if not item["is_invalid"]) / len(payloads)


def search_by_lyric(
    keyword: str,
    limit: int = 20,
    *,
    cookie: str = "",
    session: Any | None = None,
) -> list[dict[str, Any]]:
    """按歌词片段搜歌, 返回与普通搜索同形状的 payload 列表。"""
    keyword = _string(keyword)
    limit = min(max(_integer(limit) or 20, 1), 100)
    if not keyword:
        return []
    client = PlatformHTTP(cookie, session)
    matches = lyric_matches(client, keyword, limit)[:limit]
    if not matches:
        LOGGER.info("[netease] 歌词片段检索无命中 keyword=%r", keyword)
        _record_status(keyword=keyword, mode="lyric", candidates=0, playable=0, empty_reason="no_match")
        return []
    payloads = _payloads_for(client, matches, cookie, session)
    playable = sum(1 for item in payloads if not item["is_invalid"])
    LOGGER.info(
        "[netease] 歌词片段检索命中 %d 首, 取到地址 %d 首 keyword=%r",
        len(payloads), playable, keyword,
    )
    _record_status(
        keyword=keyword, mode="lyric", candidates=len(payloads),
        playable=playable, empty_reason="",
    )
    return payloads


def native_search_enabled() -> bool:
    """原生搜歌开关(MELODEX_NETEASE_NATIVE_SEARCH=0 可退回快照实现)。"""
    raw = os.environ.get("MELODEX_NETEASE_NATIVE_SEARCH", "").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def search_songs(
    keyword: str,
    limit: int = 20,
    *,
    cookie: str = "",
    session: Any | None = None,
) -> list[dict[str, Any]]:
    """原生普通搜歌。

    为什么需要它: 快照的 netease 客户端每首歌都要跑 8 档音质阶梯 + 探测下载地址,
    实测 limit=20 要 **131.7s**(而 QQ 只要 1.7s) —— 超过 app 侧扇出预算就被整源丢掉,
    用户既等得久又拿不到网易结果。本实现每首只打 **一次** eapi 地址请求(实测接口会
    直接返回实际档位, 不需要逐档重试), 配上并发后整体 ~2s。

    限流(NeteaseRateLimited)必须向上抛而不是吞成空列表: 播放时按歌名回查走的是
    同一条路径, 吞掉之后 Go 侧只会看到 "no matching songs", 表现成"这首歌没货",
    真实原因(被上游限流)就彻底丢了。
    """
    keyword = _string(keyword)
    limit = min(max(_integer(limit) or 20, 1), 100)
    if not keyword:
        return []
    client = PlatformHTTP(cookie, session)
    try:
        matches = song_matches(client, keyword, limit)[:limit]
    except NeteaseRateLimited as error:
        LOGGER.warning("[netease] 原生搜歌被限流 keyword=%r: %s", keyword, error)
        _record_status(keyword=keyword, mode="song", candidates=0, playable=0,
                       rate_limited=True, empty_reason="rate_limited")
        raise
    if not matches:
        LOGGER.info("[netease] 原生搜歌无命中 keyword=%r", keyword)
        _record_status(keyword=keyword, mode="song", candidates=0, playable=0, empty_reason="no_match")
        return []
    payloads = _payloads_for(client, matches, cookie, session)
    playable = sum(1 for item in payloads if not item["is_invalid"])
    LOGGER.info(
        "[netease] 原生搜歌命中 %d 首, 取到地址 %d 首 keyword=%r",
        len(payloads), playable, keyword,
    )
    _record_status(
        keyword=keyword, mode="song", candidates=len(payloads), playable=playable,
        rate_limited=False, empty_reason="",
    )
    return payloads


__all__ = [
    "NeteaseRateLimited",
    "build_payload",
    "fetch_lyric",
    "lyric_matches",
    "native_search_enabled",
    "playable_ratio",
    "resolve_play_url",
    "search_by_lyric",
    "search_songs",
    "song_details",
    "song_matches",
    "status",
]
