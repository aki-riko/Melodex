"""Melodex 自有的 QQ 音乐实现(不经过固定快照客户端的 QQ 路径)。

为什么 QQ 要单独实现,而不是继续用 ``charles-musicdl`` 快照里的 ``QQMusicClient``:

* QQ 已把歌曲 vkey(下载地址)下发迁到 ``u6.y.qq.com/cgi-bin/musicu.fcg``。快照仍打
  ``u.y.qq.com``,该主机现在对 ``music.vkey.GetVkey`` 只回 ``code=1000`` 且不发
  ``purl``;快照客户端又用 ``if not song_info.with_valid_download_url: continue``
  丢弃拿不到地址的歌,于是 QQ 搜索结果恒为 0 首。
* 快照解析一首歌的地址是"每个音质档位一次请求 + 两次探测请求"(单曲 15 次左右网络
  往返),20 首就是 200 多次串行请求,实测一次搜索要 200 秒上下。这里改成"多首 × 全
  档位一次批量请求",整次搜索降到 1 秒级。

本模块不含任何来自已删除 ``music-lib`` 的代码;下列请求/响应契约均由在线探测重新确定:

* 搜索 ``music.search.SearchCgiService/DoSearchForQQMusicMobile``:comm 必须带
  ``QIMEI36`` 字段(只校验存在与格式,不校验取值),否则返回 ``code=0`` 但 0 首歌。
* 取地址 ``music.vkey.GetVkey/UrlGetVkey``:必须用 ``req_1`` 信封 + ``g_tk`` /
  ``g_tk_new_20200303``(``hash33(musickey, 5381)``)/ ``loginflag`` / ``platform=20``。
* 歌词 ``music.musichallSong.PlayLyricInfo/GetPlayLyricInfo``:返回 base64 的 LRC。

设备号说明:``QIMEI36`` 只作为"这个客户端存在"的标记,QQ 不校验其真实性。本模块生成
并持久化一个本地随机设备号(可用 ``MELODEX_QQ_QIMEI36`` 覆盖),不采集任何真实设备信息,
也不依赖快照里硬编码的第三方设备号。
"""

from __future__ import annotations

import base64
import json
import logging
import os
import random
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Iterable

from provider_bridge.platform_http import PlatformHTTP


LOGGER = logging.getLogger(__name__)

QQ_CGI_URL = "https://u6.y.qq.com/cgi-bin/musicu.fcg"
MEDIA_BASE = "https://ws.stream.qqmusic.qq.com/"
COVER_BASE = "https://y.gtimg.cn/music/photo_new/T002R300x300M000{}.jpg"

SEARCH_MODULE = "music.search.SearchCgiService"
SEARCH_METHOD = "DoSearchForQQMusicMobile"
VKEY_MODULE = "music.vkey.GetVkey"
VKEY_METHOD = "UrlGetVkey"
LYRIC_MODULE = "music.musichallSong.PlayLyricInfo"
LYRIC_METHOD = "GetPlayLyricInfo"

APP_VERSION_CODE = 13020508
WEB_UID = "3931641530"
SEARCH_COOKIE_UI = "11"
VKEY_CT = 24
VKEY_CV = 4747474
VKEY_PLATFORM = "20"

DEFAULT_LIMIT = 20
MAX_LIMIT = 60
SONGS_PER_VKEY_REQUEST = 12
LYRIC_WORKERS = 6
DEVICE_ID_FILE = "qq-device-id"
DOWNLOAD_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
)

# 音质阶梯:从最好到最差。
# (档位码, 扩展名, 搜索响应 file 子对象里的体积字段, 该档位标称码率 kbps)
# 体积字段以 QQ 实际返回的键为准:有 size_flac / size_hires / size_dolby / size_192ogg /
# size_96ogg / size_320mp3 / size_128mp3, 但**没有** size_640ogg, 所以 O801 档只能拿到
# 标称码率、体积留 0 由前端验活补齐。标称码率为 0 表示该档位没有可用的标称值。
QUALITY_LADDER: tuple[tuple[str, str, str, int], ...] = (
    ("AI00", "flac", "size_hires", 0),
    ("Q000", "flac", "size_dolby", 0),
    ("F000", "flac", "size_flac", 0),
    ("O801", "ogg", "size_640ogg", 640),
    ("O600", "ogg", "size_192ogg", 192),
    ("M800", "mp3", "size_320mp3", 320),
    ("M500", "mp3", "size_128mp3", 128),
)
QUALITY_ORDER = {code: index for index, (code, _ext, _size, _nominal) in enumerate(QUALITY_LADDER)}
LOSSLESS_EXTENSIONS = {"flac", "wav", "alac", "ape", "wv", "tta", "dsf", "dff"}

DEVICE_ID_PATTERN = re.compile(r"^[0-9a-f]{36}$")
_device_lock = threading.Lock()
_device_cache = ""


def _string(value: Any) -> str:
    if value is None or value == "NULL":
        return ""
    return str(value).strip()


def _integer(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _bool_env(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if raw == "":
        return default
    return raw not in {"0", "false", "no", "off"}


def _chunks(values: list[str], size: int) -> Iterable[list[str]]:
    for index in range(0, len(values), size):
        yield values[index:index + size]


def _hash33(value: str, seed: int = 5381) -> int:
    """QQ 的 g_tk 算法(hash * 33 + c 变体)。"""
    result = seed
    for char in value:
        result += (result << 5) + ord(char)
    return result & 0x7FFFFFFF


def _random_search_id() -> str:
    exponent = random.randint(1, 20)
    base = exponent * 18014398509481984
    tail = random.randint(0, 4194304) * 4294967296
    clock = round(time.time() * 1000) % (24 * 60 * 60 * 1000)
    return str(base + tail + clock)


def _random_guid() -> str:
    return str(random.randint(1000000000, 9999999999))


def cookie_map(cookie: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for part in str(cookie or "").split(";"):
        if "=" not in part:
            continue
        name, value = part.strip().split("=", 1)
        name = name.strip()
        if name:
            values[name] = value.strip()
    return values


def _first_present(*values: Any) -> str:
    for value in values:
        text = _string(value)
        if text:
            return text
    return ""


def credential_state(cookie: str) -> dict[str, Any]:
    """解析 QQ 凭证并判断其是否仍然有效。

    ``keyExpiresIn`` / ``musickeyCreateTime`` 是 QQ 自己写进 cookie 的有效期字段,
    据此可以在不请求任何接口的前提下判断会员 key 是否过期(旧实现就是这么做的)。
    """
    cookies = cookie_map(cookie)
    uin = _first_present(
        cookies.get("str_musicid"),
        cookies.get("qqmusic_uin"),
        cookies.get("musicid"),
        cookies.get("uin"),
    )
    musickey = _first_present(
        cookies.get("musickey"),
        cookies.get("qqmusic_key"),
        cookies.get("qm_keyst"),
    )
    created_at = _integer(
        _first_present(cookies.get("musickeyCreateTime"), cookies.get("psrf_musickey_createtime"))
    )
    lifetime = _integer(cookies.get("keyExpiresIn"))
    expires_at = created_at + lifetime if created_at and lifetime else 0
    now = int(time.time())
    expired = bool(expires_at and now >= expires_at)
    refreshable = bool(_first_present(cookies.get("refresh_token"), cookies.get("psrf_qqrefresh_token")))
    if not musickey:
        summary = "缺失会员key"
    elif not expires_at:
        summary = "有会员key但无有效期字段"
    elif expired:
        summary = "已过期(%d 天前)" % max(1, (now - expires_at) // 86400)
    else:
        summary = "有效(剩 %d 小时)" % max(1, (expires_at - now) // 3600)
    return {
        "uin": uin or "0",
        "musickey": musickey,
        "login_type": _first_present(cookies.get("loginType"), cookies.get("tmeLoginType")),
        "created_at": created_at,
        "expires_at": expires_at,
        "expired": expired,
        "refreshable": refreshable,
        "has_key": bool(musickey),
        "summary": summary,
    }


def _device_id(work_dir: str) -> str:
    """返回本机稳定的 QQ 客户端设备号(env 覆盖 → 持久化文件 → 现场生成)。"""
    configured = _string(os.environ.get("MELODEX_QQ_QIMEI36")).lower()
    if configured:
        return configured
    global _device_cache
    with _device_lock:
        if _device_cache:
            return _device_cache
        path = Path(work_dir or ".") / DEVICE_ID_FILE
        try:
            existing = path.read_text(encoding="utf-8").strip().lower()
            if DEVICE_ID_PATTERN.match(existing):
                _device_cache = existing
                return existing
        except OSError:
            pass
        generated = "".join(random.choice("0123456789abcdef") for _ in range(36))
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(generated, encoding="utf-8")
        except OSError as error:
            LOGGER.warning("[qq] 设备号无法持久化,本次进程内使用临时值: %s", error)
        _device_cache = generated
        return generated


def _search_comm(device_id: str) -> dict[str, Any]:
    return {
        "cv": APP_VERSION_CODE,
        "v": APP_VERSION_CODE,
        "QIMEI36": device_id,
        "ct": SEARCH_COOKIE_UI,
        "tmeAppID": "qqmusic",
        "format": "json",
        "inCharset": "utf-8",
        "outCharset": "utf-8",
        "uid": WEB_UID,
    }


def _plain_comm(uin: str = "0") -> dict[str, Any]:
    return {
        "cv": VKEY_CV,
        "ct": VKEY_CT,
        "format": "json",
        "inCharset": "utf-8",
        "outCharset": "utf-8",
        "notice": 0,
        "platform": "yqq.json",
        "needNewCode": 1,
        "uin": uin,
    }


def _vkey_comm(state: dict[str, Any], use_auth: bool) -> dict[str, Any]:
    uin = state["uin"] if use_auth else "0"
    comm = _plain_comm(uin)
    if use_auth and state["musickey"]:
        token = _hash33(state["musickey"], 5381)
        comm.update({
            "g_tk": token,
            "g_tk_new_20200303": token,
            "qq": state["uin"],
            "authst": state["musickey"],
        })
    return comm


def _post(client: PlatformHTTP, payload: dict[str, Any]) -> dict[str, Any]:
    return client.post_json(
        QQ_CGI_URL,
        payload,
        headers={"Referer": "https://y.qq.com/", "Origin": "https://y.qq.com/"},
    )


def _search_request(keyword: str, limit: int, device_id: str) -> dict[str, Any]:
    return {
        "comm": _search_comm(device_id),
        f"{SEARCH_MODULE}.{SEARCH_METHOD}": {
            "module": SEARCH_MODULE,
            "method": SEARCH_METHOD,
            "param": {
                "searchid": _random_search_id(),
                "query": keyword,
                "search_type": 0,
                "num_per_page": limit,
                "page_num": 1,
                "highlight": 1,
                "grp": 1,
            },
        },
    }


def _vkey_request(
    filenames: list[str],
    songmids: list[str],
    state: dict[str, Any],
    use_auth: bool,
    guid: str,
) -> dict[str, Any]:
    """构造取地址请求。

    ``songmid`` 必须与 ``filename`` 逐项对齐(每首歌按音质阶梯展开若干条),
    QQ 按这个对齐关系回填 ``midurlinfo[].purl``。
    """
    uin = state["uin"] if use_auth else "0"
    return {
        "comm": _vkey_comm(state, use_auth),
        "req_1": {
            "module": VKEY_MODULE,
            "method": VKEY_METHOD,
            "param": {
                "guid": guid,
                "songmid": songmids,
                "songtype": [0] * len(songmids),
                "uin": uin,
                "loginflag": 1,
                "platform": VKEY_PLATFORM,
                "filename": filenames,
            },
        },
    }


def _lyric_request(mid: str) -> dict[str, Any]:
    return {
        "comm": _plain_comm(),
        "req_1": {
            "module": LYRIC_MODULE,
            "method": LYRIC_METHOD,
            "param": {"songMID": mid, "songID": 0},
        },
    }


def _search_items(client: PlatformHTTP, keyword: str, limit: int, device_id: str) -> tuple[list[dict[str, Any]], int]:
    response = _post(client, _search_request(keyword, limit, device_id))
    node = response.get(f"{SEARCH_MODULE}.{SEARCH_METHOD}") or {}
    code = _integer(node.get("code"))
    items = ((node.get("data") or {}).get("body") or {}).get("item_song") or []
    return [item for item in items if isinstance(item, dict)], code


def _vkey_pass(
    mids: list[str],
    state: dict[str, Any],
    cookie: str,
    *,
    use_auth: bool,
    session: Any | None,
) -> dict[str, tuple[str, str, str]]:
    """分片批量取地址。返回 {mid: (音质档位, 扩展名, 完整播放地址)}。"""
    collected: dict[str, tuple[str, str, str]] = {}
    for chunk in _chunks(mids, SONGS_PER_VKEY_REQUEST):
        sent: dict[str, tuple[str, str, str]] = {}
        filenames: list[str] = []
        songmids: list[str] = []
        for mid in chunk:
            for quality, ext, _size_key, _nominal in QUALITY_LADDER:
                name = "%s%s%s.%s" % (quality, mid, mid, ext)
                sent[name] = (mid, quality, ext)
                filenames.append(name)
                songmids.append(mid)
        client = PlatformHTTP(cookie if use_auth else "", session)
        response = _post(client, _vkey_request(filenames, songmids, state, use_auth, _random_guid()))
        node = response.get("req_1") or {}
        code = _integer(node.get("code"))
        entries = ((node.get("data") or {}).get("midurlinfo") or [])
        if code:
            LOGGER.warning("[qq] vkey 返回非 0 code=%s(本片 %d 首)", code, len(chunk))
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            purl = _string(entry.get("purl")) or _string(entry.get("wifiurl"))
            if not purl:
                continue
            target = sent.get(_string(entry.get("filename")))
            if target is None:
                continue
            mid, quality, ext = target
            previous = collected.get(mid)
            if previous and QUALITY_ORDER.get(previous[0], 99) <= QUALITY_ORDER.get(quality, 99):
                continue
            collected[mid] = (quality, ext, MEDIA_BASE + purl)
    return collected


def _resolve_urls(
    mids: list[str],
    state: dict[str, Any],
    cookie: str,
    *,
    session: Any | None,
) -> tuple[dict[str, tuple[str, str, str]], str]:
    """决定用哪种凭证模式取地址,并在拿不到任何地址时自动切换另一种模式。"""
    if state["has_key"] and not state["expired"]:
        attempts = [True, False]
    elif state["has_key"]:
        # 过期 key 可能让 QQ 连匿名能播的歌都不发 purl,所以优先匿名,失败再带凭证试。
        attempts = [False, True]
    else:
        attempts = [False]
    last_mode = "匿名"
    for index, use_auth in enumerate(attempts):
        last_mode = "带凭证" if use_auth else "匿名"
        collected = _vkey_pass(mids, state, cookie, use_auth=use_auth, session=session)
        if collected:
            return collected, last_mode
        # 只有确实还有下一次尝试时才说"切换", 否则会留下误导性的日志。
        if index + 1 < len(attempts):
            LOGGER.warning(
                "[qq] %s模式未取到任何下载地址, 切换%s模式重试 (凭证=%s)",
                last_mode,
                "匿名" if use_auth else "带凭证",
                state["summary"],
            )
    LOGGER.warning(
        "[qq] %s 都未取得任何下载地址(候选 %d 首), 凭证=%s%s",
        "两种凭证模式" if len(attempts) > 1 else "匿名模式",
        len(mids),
        state["summary"],
        ", 会员 key 已过期, 高音质歌曲不会发放地址" if state["has_key"] and state["expired"] else "",
    )
    return {}, last_mode


def _lyric(mid: str, cookie: str) -> str:
    try:
        client = PlatformHTTP(cookie)
        response = _post(client, _lyric_request(mid))
        node = response.get("req_1") or {}
        raw = _string((node.get("data") or {}).get("lyric"))
        if not raw:
            return ""
        return base64.b64decode(raw).decode("utf-8", "ignore").strip()
    except Exception as error:  # 歌词是尽力而为,失败不影响搜索
        LOGGER.debug("[qq] 歌词获取失败 mid=%s: %s", mid, error)
        return ""


def _lyrics_for(mids: list[str], cookie: str) -> dict[str, str]:
    if not mids or not _bool_env("MELODEX_QQ_SEARCH_LYRICS", True):
        return {}
    lyrics: dict[str, str] = {}
    try:
        with ThreadPoolExecutor(max_workers=min(LYRIC_WORKERS, len(mids))) as pool:
            for mid, text in zip(mids, pool.map(lambda item: _lyric(item, cookie), mids)):
                if text:
                    lyrics[mid] = text
    except Exception as error:
        LOGGER.warning("[qq] 歌词批量获取异常: %s", error)
    return lyrics


def _payload(
    item: dict[str, Any],
    rank: int,
    resolved: tuple[str, str, str],
    lyric: str,
) -> dict[str, Any]:
    mid = _string(item.get("mid"))
    duration = _integer(item.get("interval"))
    file_info = item.get("file") if isinstance(item.get("file"), dict) else {}
    album = item.get("album") if isinstance(item.get("album"), dict) else {}
    singers = item.get("singer") if isinstance(item.get("singer"), list) else []
    artist = ", ".join(
        _string(singer.get("name")) for singer in singers
        if isinstance(singer, dict) and _string(singer.get("name"))
    )
    quality_code, ext, download_url = resolved
    size_key, nominal_bitrate = next(
        ((key, nominal) for code, _ext, key, nominal in QUALITY_LADDER if code == quality_code),
        ("", 0),
    )
    size = _integer(file_info.get(size_key)) if size_key else 0
    # 有真实体积时按体积/时长反算码率(更准), 否则退回该档位的标称码率, 都不假装知道。
    bitrate = nominal_bitrate
    if size and duration > 0:
        bitrate = int(round(size * 8 / duration / 1000))
    album_mid = _string(album.get("mid"))
    extra: dict[str, Any] = {
        "_rank": str(rank),
        "provider": "melodex-native",
        "provider_lookup": " ".join(part for part in (item.get("title"), artist) if part).strip(),
        "download_headers": json.dumps(
            {"Referer": "https://y.qq.com/", "User-Agent": DOWNLOAD_USER_AGENT},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
    }
    if lyric:
        extra["lyric"] = lyric
    if ext in LOSSLESS_EXTENSIONS:
        extra["has_lossless"] = "1"
    return {
        "id": mid,
        "name": _string(item.get("title")) or _string(item.get("name")),
        "artist": artist,
        "album": _string(album.get("name")),
        "album_id": "",
        "duration": duration,
        "size": size,
        "bitrate": bitrate,
        "source": "qq",
        "url": download_url,
        "ext": ext,
        "cover": COVER_BASE.format(album_mid) if album_mid else "",
        "link": "",
        "extra": extra,
        "is_invalid": False,
        "is_vip": False,
    }


def search(
    keyword: str,
    limit: int,
    cookie: str,
    *,
    work_dir: str,
    session: Any | None = None,
) -> list[dict[str, Any]]:
    keyword = _string(keyword)
    if not keyword:
        return []
    limit = min(max(_integer(limit) or DEFAULT_LIMIT, 1), MAX_LIMIT)
    state = credential_state(cookie)
    device_id = _device_id(work_dir)
    started = time.monotonic()
    # 搜索这一步按实测形状走匿名请求(不需要也不发送凭证);凭证只在取地址时使用。
    client = PlatformHTTP("", session)

    items, code = _search_items(client, keyword, limit, device_id)
    if not items:
        # 不允许静默返回空:被限流/被拒绝时必须留下可排查痕迹。
        LOGGER.warning(
            "[qq] 搜索无结果 keyword=%r limit=%d code=%s 凭证=%s 耗时=%.2fs",
            keyword, limit, code, state["summary"], time.monotonic() - started,
        )
        return []

    mids = [_string(item.get("mid")) for item in items]
    mids = [mid for mid in mids if mid]
    resolved, mode = _resolve_urls(mids, state, cookie, session=session)

    playable = [mid for mid in mids if mid in resolved]
    missing = [mid for mid in mids if mid not in resolved]
    lyrics = _lyrics_for(playable, cookie)

    songs: list[dict[str, Any]] = []
    for rank, item in enumerate(items):
        mid = _string(item.get("mid"))
        quality = resolved.get(mid)
        if quality is None:
            continue
        songs.append(_payload(item, rank, quality, lyrics.get(mid, "")))

    LOGGER.info(
        "[qq] 搜索 keyword=%r limit=%d 候选=%d 可播=%d 丢弃=%d 模式=%s code=%s 凭证=%s 耗时=%.2fs",
        keyword, limit, len(mids), len(playable), len(missing), mode, code,
        state["summary"], time.monotonic() - started,
    )
    if missing:
        LOGGER.warning(
            "[qq] %d/%d 首未取得下载地址(keyword=%r); 凭证状态=%s%s",
            len(missing), len(mids), keyword, state["summary"],
            ", 请刷新 QQ 会员凭证以恢复高音质" if state["expired"] or not state["has_key"] else "",
        )
    if not songs:
        LOGGER.warning(
            "[qq] 本次搜索没有任何可播歌曲 keyword=%r 凭证=%s", keyword, state["summary"]
        )
    return songs


def credential_summary(cookie: str) -> str:
    """给日志/运维用的单行凭证描述。"""
    return credential_state(cookie)["summary"]


__all__ = [
    "QQ_CGI_URL",
    "QUALITY_LADDER",
    "credential_state",
    "credential_summary",
    "cookie_map",
    "search",
]
