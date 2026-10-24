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
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Iterable

import requests

from provider_bridge import qq_qrc
from provider_bridge.platform_http import PlatformHTTP
# 续期复用扫码登录那套"强登录"常量与 token 回退顺序(同一个上游接口)。
from provider_bridge.qq_login import (
    LOGIN_SERVER_METHOD,
    LOGIN_SERVER_MODULE,
    LOGIN_SERVER_URLS,
    MUSIC_REFERER,
    TOKEN_KEYS,
)


LOGGER = logging.getLogger(__name__)

QQ_CGI_URL = "https://u6.y.qq.com/cgi-bin/musicu.fcg"
# **带凭证**取地址必须走 u.y.qq.com, 走 u6 会被判定 invalidq。
#
# 2026-10 实测(同一份刚扫码登录、豪华绿钻 2030 到期的 cookie):
#   u6.y.qq.com + authst -> {"code":104009,"msg":"<本机IP>;invalidq;"}, purl 全空
#   u.y.qq.com  + authst -> code=0, purl 正常, 且能拿到 F000(FLAC 无损)
# 匿名模式在 u6 上一直可用, 所以这个问题此前被"失败后自动回退匿名"完全掩盖了 ——
# 表现为"VIP 凭证明明有效却总是拿不到无损", 同时因为退回匿名只剩 128k mp3, 大量歌曲
# 要逐档降级探活, 探活次数与耗时都翻几倍(这是 QQ 搜索抖动的真实来源)。
QQ_VKEY_AUTH_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg"
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

# QQ 搜歌接口的 search_type。实测 7 = 按歌词片段检索:搜「故事的小黄花」直接命中
# 晴天/周杰伦,搜「天青色等烟雨」命中青花瓷/周杰伦;而 0(普通搜歌)只会返回同名噪音。
SEARCH_TYPE_SONG = 0
SEARCH_TYPE_LYRIC = 7
VKEY_CT = 24
VKEY_CV = 4747474
VKEY_PLATFORM = "20"

DEFAULT_LIMIT = 20
MAX_LIMIT = 60
SONGS_PER_VKEY_REQUEST = 12
LYRIC_WORKERS = 6
# 探活并发。实测 limit=20 时需要 17~26 次探活, 单次 P50 82ms / 最慢 145ms:
# 并发 8 要跑 3~4 轮(≈0.4~0.6s), 并发 16 只需 2 轮 —— 这是"探活阶段 0.34~1.12s 波动"
# 的主要来源之一。提到 16 后理论耗时减半。
PROBE_CONCURRENCY = 16
# 探活超时。只做 Range: bytes=0-1 的存在性判断, 2s 足够宽裕(实测最慢 145ms);
# 早先的 8s 会让单个卡住的 CDN 节点拖住整层。
PROBE_TIMEOUT_SECONDS = 2
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

# 最近一次 QQ 请求的观测快照。QQ 之前整条失效时是完全静默的(搜索恒返回 0 首、日志里
# 什么都没有), 所以除了日志之外, 这里再留一份可被 /health 读到的状态, 便于巡检和监控。
_status_lock = threading.Lock()
_status: dict[str, Any] = {}


def _record_status(**fields: Any) -> None:
    with _status_lock:
        _status.update(fields)
        _status["updated_at"] = int(time.time())


def status() -> dict[str, Any]:
    """返回最近一次 QQ 请求的观测快照(未发生过请求时为空字典)。"""
    with _status_lock:
        return dict(_status)


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


def refresh_musickey(cookie: str, *, session: Any | None = None) -> dict[str, Any]:
    """用商品里的长期凭据换取新的 musickey, 返回可以直接替换的完整 cookie 串。

    背景: QQ 音乐的 **musickey 只有 3 天寿命**(`keyExpiresIn=259200`), 过期后所有
    VIP/无损曲目都拿不到地址(实测可播率从 10/10 掉到 2/10, 且全是试听档)。但同一份
    cookie 里的 `pt_oauth_token` / `p_skey` / `superkey` 寿命长得多(实测 access_token
    还有 37 天), 可以用它们重新走一遍扫码登录第 5 步的 `QQConnectLogin.LoginServer`/
    `QQLogin`, 换出全新的 musickey —— 用户不用每 3~4 天重新扫码。

    返回:
        成功时 `{"cookie": <新 cookie 串>, "expires_at": <秒级时间戳>, "expires_in": 259200}`;
        无可用凭据或上游拒绝时 `{}`(调用方保持原 cookie 不变)。

    token 回退顺序与 qq_login.TOKEN_KEYS 一致, 逐个试到出 key 为止 —— QQ 在不同登录态下
    可用的 token 不一样(当年扫码登录修过 5 次, 就是这个原因)。
    """
    cookies = cookie_map(cookie)
    uin = _first_present(
        cookies.get("str_musicid"), cookies.get("qqmusic_uin"),
        cookies.get("musicid"), cookies.get("uin"),
    )
    if not uin:
        return {}
    candidates = [cookies.get(name, "") for name in TOKEN_KEYS if cookies.get(name)]
    if not candidates:
        return {}
    access_token = _first_present(
        cookies.get("access_token"), cookies.get("psrf_qqaccess_token"),
    )
    openid = _first_present(
        cookies.get("openid"), cookies.get("wxopenid"), cookies.get("psrf_qqopenid"),
    )
    login_type = _first_present(cookies.get("loginType"), cookies.get("tmeLoginType")) or "2"
    client = PlatformHTTP("", session)
    for token in candidates:
        body = {
            "comm": {
                "ct": "11", "cv": str(APP_VERSION_CODE), "v": str(APP_VERSION_CODE),
                "os_ver": "15", "uin": uin, "tmeLoginType": login_type,
            },
            "req": {
                "module": LOGIN_SERVER_MODULE, "method": LOGIN_SERVER_METHOD,
                "param": {"token": token, "openid": openid, "access_token": access_token},
            },
        }
        for url in LOGIN_SERVER_URLS:
            try:
                payload = client.post_json(url, body, headers={"Referer": MUSIC_REFERER})
            except Exception as error:
                LOGGER.debug("[qq] 续期请求失败 url=%s: %s", url, error)
                continue
            data = (payload.get("req") or {}).get("data") if isinstance(payload, dict) else None
            if not isinstance(data, dict):
                continue
            musickey = _string(data.get("musickey"))
            created_at = _integer(data.get("musickeyCreateTime"))
            expires_in = _integer(data.get("keyExpiresIn"))
            if not musickey:
                continue
            refreshed = dict(cookies)
            # 三个别名都要写: 取地址链路读 musickey/qqmusic_key/qm_keyst 的任意一个。
            for name in ("musickey", "qqmusic_key", "qm_keyst"):
                refreshed[name] = musickey
            for name in ("musickeyCreateTime", "psrf_musickey_createtime"):
                if created_at:
                    refreshed[name] = str(created_at)
            if expires_in:
                refreshed["keyExpiresIn"] = str(expires_in)
            for key, name in (
                ("access_token", "access_token"), ("refresh_token", "refresh_token"),
                ("openid", "openid"), ("unionid", "unionid"),
            ):
                value = _string(data.get(key))
                if value:
                    refreshed[name] = value
            new_cookie = "; ".join(f"{key}={value}" for key, value in refreshed.items() if value)
            expires_at = created_at + expires_in if created_at and expires_in else 0
            LOGGER.info(
                "[qq] musickey 已自动续期(用 %s 换取), 新有效期至 %s",
                "长期凭据", time.strftime("%Y-%m-%d %H:%M", time.localtime(expires_at)) if expires_at else "未知",
            )
            return {"cookie": new_cookie, "expires_at": expires_at, "expires_in": expires_in}
    LOGGER.warning("[qq] musickey 自动续期失败: 所有长期凭据都被拒绝, 需要重新扫码")
    return {}


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


def _post(client: PlatformHTTP, payload: dict[str, Any], url: str = "") -> dict[str, Any]:
    return client.post_json(
        url or QQ_CGI_URL,
        payload,
        headers={"Referer": "https://y.qq.com/", "Origin": "https://y.qq.com/"},
    )


def _search_request(keyword: str, limit: int, device_id: str, search_type: int = SEARCH_TYPE_SONG) -> dict[str, Any]:
    return {
        "comm": _search_comm(device_id),
        f"{SEARCH_MODULE}.{SEARCH_METHOD}": {
            "module": SEARCH_MODULE,
            "method": SEARCH_METHOD,
            "param": {
                "searchid": _random_search_id(),
                "query": keyword,
                "search_type": search_type,
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


def _search_items(
    client: PlatformHTTP,
    keyword: str,
    limit: int,
    device_id: str,
    search_type: int = SEARCH_TYPE_SONG,
) -> tuple[list[dict[str, Any]], int]:
    response = _post(client, _search_request(keyword, limit, device_id, search_type))
    node = response.get(f"{SEARCH_MODULE}.{SEARCH_METHOD}") or {}
    code = _integer(node.get("code"))
    items = ((node.get("data") or {}).get("body") or {}).get("item_song") or []
    return [item for item in items if isinstance(item, dict)], code


def _probe_media_url(url: str, cookie: str) -> tuple[bool, int]:
    """确认 QQ vkey 返回的地址仍存在，再交给 Go 播放/下载链路。

    超时只给 2s: 这是 `Range: bytes=0-1` 的极小请求, 实测 P50 82ms / 最慢 145ms。
    早先给 8s, 一旦某个 CDN 节点卡住, 分层探活会**整层等齐**才降档 —— 单个慢请求就能
    把整次搜索拖长 0.5~1s(实测探活阶段在 0.34~1.12s 之间波动, 而网络侧 vkey 稳定在 0.2s)。
    探活只用于判断"地址可用", 宁可 2s 判超时当作不可用, 也不要拖住整轮。
    """
    headers = {
        "Referer": "https://y.qq.com/",
        "User-Agent": DOWNLOAD_USER_AGENT,
        "Range": "bytes=0-1",
    }
    if cookie:
        headers["Cookie"] = cookie
    response = None
    try:
        response = requests.get(url, headers=headers, timeout=PROBE_TIMEOUT_SECONDS, stream=True)
        status = int(response.status_code)
        return status in (200, 206), status
    except requests.RequestException:
        return False, 0
    finally:
        if response is not None:
            response.close()


def _vkey_pass(
    mids: list[str],
    state: dict[str, Any],
    cookie: str,
    *,
    use_auth: bool,
    session: Any | None,
) -> dict[str, tuple[str, str, str]]:
    """分片批量取地址。返回 {mid: (音质档位, 扩展名, 完整播放地址)}。"""
    chunks = list(_chunks(mids, SONGS_PER_VKEY_REQUEST))
    if not chunks:
        return {}
    # 同一轮的多个分片共用同一个 client(只读会话, 并发发请求是安全的)。
    client = PlatformHTTP(cookie if use_auth else "", session)

    def fetch_chunk(chunk: list[str]) -> tuple[list[tuple[str, str, str, str]], int]:
        sent: dict[str, tuple[str, str, str]] = {}
        filenames: list[str] = []
        songmids: list[str] = []
        for mid in chunk:
            for quality, ext, _size_key, _nominal in QUALITY_LADDER:
                name = "%s%s%s.%s" % (quality, mid, mid, ext)
                sent[name] = (mid, quality, ext)
                filenames.append(name)
                songmids.append(mid)
        # 带凭证必须走 u.y.qq.com(u6 会回 104009 invalidq); 匿名仍走 u6。
        endpoint = QQ_VKEY_AUTH_URL if use_auth else QQ_CGI_URL
        response = _post(
            client,
            _vkey_request(filenames, songmids, state, use_auth, _random_guid()),
            url=endpoint,
        )
        node = response.get("req_1") or {}
        code = _integer(node.get("code"))
        entries = ((node.get("data") or {}).get("midurlinfo") or [])
        resolved: list[tuple[str, str, str, str]] = []
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
            resolved.append((mid, quality, ext, MEDIA_BASE + purl))
        return resolved, code

    candidates: dict[str, list[tuple[str, str, str]]] = {}
    # 分片并行: SONGS_PER_VKEY_REQUEST=12, 20 首候选会切成 12+8 两片。串行要等两个往返,
    # 并行只要一个 —— 实测能省掉约一次 RTT(100~200ms)。
    with ThreadPoolExecutor(max_workers=min(4, len(chunks))) as pool:
        unit_results = list(pool.map(fetch_chunk, chunks))
    for (resolved, code), chunk in zip(unit_results, chunks):
        if code:
            LOGGER.warning("[qq] vkey 返回非 0 code=%s(本片 %d 首)", code, len(chunk))
        for mid, quality, ext, url in resolved:
            candidates.setdefault(mid, []).append((quality, ext, url))

    if not candidates:
        return {}
    return _select_working_media(candidates, cookie)


def _select_working_media(
    candidates: dict[str, list[tuple[str, str, str]]],
    cookie: str,
) -> dict[str, tuple[str, str, str]]:
    """为每首歌挑出**第一个真正可下载**的档位。

    为什么分层而不是一次全探: 早先的实现把每首歌 7 个档位的地址**全部**探一遍(20 首
    ≈140 次 HTTP), 即使最高档 flac 已经成功也要等其余档位探完才返回。实测这一步占了
    QQ 搜索 1.0~1.8s 中的大头。改成按音质从高到低分层: 每层只探"还没成功"的歌,
    一旦某首歌在当前层拿到可用地址就再也不会被探 —— 正常情况下只探 1 层(≈20 次请求),
    只有某首最高档真的不可用时才降到下一档, 与原来的选择结果完全等价。
    """
    ordered_by_mid: dict[str, list[tuple[str, str, str]]] = {
        mid: sorted(values, key=lambda value: QUALITY_ORDER.get(value[0], 99))
        for mid, values in candidates.items()
    }
    collected: dict[str, tuple[str, str, str]] = {}
    failures: dict[str, list[str]] = {mid: [] for mid in ordered_by_mid}

    # 流水线调度: 单一任务队列 + 固定并发池, 探活完成就立刻为"该歌的下一档"排新任务。
    #
    # 早先是"分层 + 每层等齐": 第 N 层所有探活都完成后才进入第 N+1 层。实测大量歌曲
    # 会逐档降级(日志里 14~16/20 首需要回退), 于是同步点很多 —— 探活阶段因此在
    # 0.34~1.29s 之间抖动。改成流水线后没有层间同步点, 总耗时≈总次数×单次延迟/并发。
    # 选择结果与分层版完全等价: 每首歌仍然是"从最高档往下找第一个可用地址"。
    next_index: dict[str, int] = {mid: 0 for mid in ordered_by_mid}

    with ThreadPoolExecutor(max_workers=PROBE_CONCURRENCY) as pool:
        inflight: dict[Any, str] = {}
        dispatch_queue = list(ordered_by_mid)

        def dispatch() -> None:
            """尽量把队列里的歌排满, 直到达到并发上限。"""
            while dispatch_queue and len(inflight) < PROBE_CONCURRENCY:
                mid = dispatch_queue.pop()
                index = next_index[mid]
                values = ordered_by_mid[mid]
                if mid in collected or index >= len(values):
                    continue
                inflight[pool.submit(_probe_media_url, values[index][2], cookie)] = mid

        dispatch()
        while inflight:
            # 收集"此刻已经完成"的全部任务(不阻塞在单个 future 上), 逐批处理, 逐批补位。
            done = [future for future in inflight if future.done()]
            if not done:
                # 没有已完成的任务时才阻塞等一个, 避免忙等。
                done = [next(as_completed(inflight))]
            for future in done:
                mid = inflight.pop(future)
                values = ordered_by_mid[mid]
                index = next_index[mid]
                quality, ext, url = values[index]
                try:
                    ok, status = future.result()
                except Exception as error:
                    LOGGER.warning("[qq] 媒体地址探测异常 mid=%s: %s", mid, error)
                    ok, status = False, 0
                if ok:
                    collected[mid] = (quality, ext, url)
                    continue
                failures[mid].append(f"{quality}:{status}")
                next_index[mid] = index + 1
                if next_index[mid] < len(values):
                    # 该歌还有更低的档位可试: 重新入队, 由 dispatch 按并发余量继续排。
                    dispatch_queue.append(mid)
            dispatch()

    for mid in ordered_by_mid:
        if mid not in collected:
            LOGGER.warning("[qq] 所有媒体地址不可用 mid=%s probes=%s", mid, ",".join(failures[mid]))
    return collected


# 带凭证取址的熔断状态。
#
# 实测两种"整轮带凭证拿不到 purl"的情形, 两者都值得熔断(否则每次搜索白跑一趟):
#   1. `invalidq` —— 上游对本机 IP + 该凭证组合的风控判定(实测: 同一份新鲜 cookie 在
#      02:41 能带凭证拿到 20/20 全无损, 之后被判定 invalidq, 匿名却始终正常)。
#      换 musickey **无效**(实测续期后立刻重试仍是 invalidq), 只能等风控解除。
#   2. code=104009 但没有 invalidq 标记 —— 该凭证当次无 VIP 权益。
# 熔断键用 **uin**(不是 musickey): 续期会换新 key 但换不掉风控, 用 musickey 作键会
# 让熔断"刚生效就失效", 每次搜索又白跑 0.4s。到点自动重探, 风控解除/VIP 恢复后可自愈。
_auth_suppress_lock = threading.Lock()
_auth_suppress_until = 0.0
_auth_suppress_key = ""
AUTH_SUPPRESS_SECONDS = 600


def _state_fingerprint(state: dict[str, Any]) -> str:
    """用 uin 标明"这个账号"; 续期换 key 不影响熔断(见上方注释)。"""
    return _string(state.get("uin"))


def _auth_pass_suppressed(state: dict[str, Any]) -> bool:
    with _auth_suppress_lock:
        if not _auth_suppress_key or _auth_suppress_key != _state_fingerprint(state):
            return False
        return time.monotonic() < _auth_suppress_until


def _suppress_auth_pass(state: dict[str, Any]) -> None:
    global _auth_suppress_until, _auth_suppress_key
    with _auth_suppress_lock:
        _auth_suppress_key = _state_fingerprint(state)
        _auth_suppress_until = time.monotonic() + AUTH_SUPPRESS_SECONDS


def _clear_auth_suppression() -> None:
    global _auth_suppress_until, _auth_suppress_key
    with _auth_suppress_lock:
        _auth_suppress_until = 0.0
        _auth_suppress_key = ""


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
    if attempts[0] and _auth_pass_suppressed(state):
        # 带凭证模式刚被上游整轮拒绝过(实测 code=104009 且一个 purl 都不发)。再用同一个
        # key 重试几乎必然还是空, 却要白付一次往返 —— 短期直接跳过, 到点自动恢复探测。
        attempts = [attempt for attempt in attempts if not attempt]
    last_mode = "匿名"
    for index, use_auth in enumerate(attempts):
        last_mode = "带凭证" if use_auth else "匿名"
        collected = _vkey_pass(mids, state, cookie, use_auth=use_auth, session=session)
        if collected:
            if use_auth:
                _clear_auth_suppression()
            return collected, last_mode
        if use_auth:
            _suppress_auth_pass(state)
        # 只有确实还有下一次尝试时才说"切换", 否则会留下误导性的日志。
        if index + 1 < len(attempts):
            LOGGER.warning(
                "[qq] %s模式未取到任何下载地址, 切换%s模式重试 (凭证=%s)",
                last_mode,
                "匿名" if use_auth else "带凭证",
                state["summary"],
            )
    LOGGER.warning(
        "[qq] %s未取得任何下载地址(候选 %d 首), 凭证=%s%s",
        "两种凭证模式都" if len(attempts) > 1 else "匿名模式",
        len(mids),
        state["summary"],
        ", 会员 key 已过期, 高音质歌曲不会发放地址" if state["has_key"] and state["expired"] else "",
    )
    return {}, last_mode


def _qrc_lyric(client: PlatformHTTP, item: dict[str, Any]) -> str:
    """取 QQ 逐字歌词(QRC)并转成内联逐字 LRC; 拿不到则空串(调用方回退行级歌词)。

    注意参数必须带上 songName/albumName/singerName(base64) 与 qrc=1 这一整套 —— 实测只传
    songMID 时响应里根本不带 QRC 数据(这也是"QRC 解不开"这个错误结论的来源之一)。
    """
    album = item.get("album") if isinstance(item.get("album"), dict) else {}
    singers = item.get("singer") if isinstance(item.get("singer"), list) else []
    artist = ", ".join(
        _string(singer.get("name")) for singer in singers
        if isinstance(singer, dict) and _string(singer.get("name"))
    )
    param = qq_qrc.qrc_request_param(
        _string(item.get("mid")),
        song_id=_integer(item.get("id")),
        name=_string(item.get("title")) or _string(item.get("name")),
        artist=artist,
        album=_string(album.get("name")),
        duration_s=_integer(item.get("interval")),
    )
    response = _post(client, {
        "comm": _plain_comm(),
        "req_1": {"module": LYRIC_MODULE, "method": LYRIC_METHOD, "param": param},
    })
    payload = ((response.get("req_1") or {}).get("data") or {}).get("lyric")
    if not payload:
        return ""
    plaintext = qq_qrc.decrypt_qrc(payload)
    if not plaintext:
        return ""
    return qq_qrc.qrc_to_verbatim_lrc(plaintext)


def _lyric(item: dict[str, Any], cookie: str) -> tuple[str, bool]:
    """返回 (歌词, 是否逐字)。逐字优先走 QRC, 失败回退 base64 行级 LRC。"""
    mid = _string(item.get("mid"))
    try:
        client = PlatformHTTP(cookie)
        if qq_qrc.verbatim_enabled():
            verbatim = _qrc_lyric(client, item)
            if verbatim:
                return verbatim, True
        response = _post(client, _lyric_request(mid))
        node = response.get("req_1") or {}
        raw = _string((node.get("data") or {}).get("lyric"))
        if not raw:
            return "", False
        # 带 qrc=1 的响应里 lyric 是十六进制 QRC 载荷, 不能按 base64 解 —— 上面已单独处理。
        return base64.b64decode(raw).decode("utf-8", "ignore").strip(), False
    except Exception as error:  # 歌词是尽力而为,失败不影响搜索
        LOGGER.debug("[qq] 歌词获取失败 mid=%s: %s", mid, error)
        return "", False


# 搜索时记下 mid -> 原始 item。惰性取歌词(QRC 逐字)需要 songName/albumName/singerName
# 才能让上游返回 QRC 载荷, 只凭 mid 拿不到 —— 这些元数据在搜索结果里本来就全有, 顺手存一份
# 就能在播放时按 mid 精确取回逐字歌词, 不必让搜索为每首歌都多打两次请求。
_song_meta_lock = threading.Lock()
_song_meta: dict[str, dict[str, Any]] = {}
SONG_META_LIMIT = 2000


def _remember_song_meta(items: list[dict[str, Any]]) -> None:
    if not items:
        return
    with _song_meta_lock:
        for item in items:
            mid = _string(item.get("mid")) if isinstance(item, dict) else ""
            if mid:
                _song_meta[mid] = item
        while len(_song_meta) > SONG_META_LIMIT:
            _song_meta.pop(next(iter(_song_meta)))


def fetch_lyric(song_id: str, *, cookie: str = "") -> str:
    """按 songmid 取歌词(惰性路径, 供 /v1/lyric 调用)。

    优先用搜索时缓存的元数据走完整 QRC 逐字链路; 缓存未命中(比如重启后直接播放历史歌单)
    时退回只凭 mid 的行级 LRC —— 拿不到逐字, 但不会没有歌词。
    """
    mid = _string(song_id)
    if not mid:
        return ""
    with _song_meta_lock:
        item = _song_meta.get(mid)
    if item is not None:
        text, _verbatim = _lyric(item, cookie)
        if text:
            return text
    try:
        client = PlatformHTTP(cookie)
        response = _post(client, _lyric_request(mid))
        raw = _string(((response.get("req_1") or {}).get("data") or {}).get("lyric"))
        if not raw:
            return ""
        return base64.b64decode(raw).decode("utf-8", "ignore").strip()
    except Exception as error:
        LOGGER.debug("[qq] 按 mid 取歌词失败 mid=%s: %s", mid, error)
        return ""


def _lyrics_for(items: list[dict[str, Any]], cookie: str) -> dict[str, tuple[str, bool]]:
    mids = [_string(item.get("mid")) for item in items]
    # 默认**不**在搜索里内联歌词: 实测 5 个关键词带歌词 21.30s / 不带 7.84s, 歌词占了
    # 63% 的搜索耗时(每首一次 QRC + 一次行级请求)。而用户很少会读搜索列表里的每一首歌词,
    # 真正播放时前端会按需调 /music/lyric 再取 —— 与网易原生实现的懒加载口径一致。
    # 需要旧行为可设 MELODEX_QQ_SEARCH_LYRICS=1。
    if not mids or not _bool_env("MELODEX_QQ_SEARCH_LYRICS", False):
        return {}
    lyrics: dict[str, tuple[str, bool]] = {}
    try:
        with ThreadPoolExecutor(max_workers=min(LYRIC_WORKERS, len(items))) as pool:
            for mid, result in zip(mids, pool.map(lambda entry: _lyric(entry, cookie), items)):
                text = result[0] if isinstance(result, tuple) else result
                if text:
                    lyrics[mid] = (text, bool(result[1]) if isinstance(result, tuple) else False)
    except Exception as error:
        LOGGER.warning("[qq] 歌词批量获取异常: %s", error)
    return lyrics


def _payload(
    item: dict[str, Any],
    rank: int,
    resolved: tuple[str, str, str],
    lyric: str,
    lyric_verbatim: bool = False,
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
        if lyric_verbatim:
            extra["lyric_verbatim"] = "1"
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


def _record_search_status(
    *,
    keyword: str,
    limit: int,
    state: dict[str, Any],
    code: int,
    started: float,
    **extra: Any,
) -> None:
    snapshot: dict[str, Any] = {
        "keyword": keyword,
        "limit": limit,
        "credential": state["summary"],
        "credential_expired": state["expired"],
        "credential_refreshable": state["refreshable"],
        "has_credential_key": state["has_key"],
        "search_code": code,
        # QQ 用 2001 表示这次搜索被限流, 是"搜不出东西"里最常见、也最容易被误判成故障的一种。
        "rate_limited": code == 2001,
        "elapsed_ms": int((time.monotonic() - started) * 1000),
    }
    snapshot.update(extra)
    _record_status(**snapshot)


def search(
    keyword: str,
    limit: int,
    cookie: str,
    *,
    work_dir: str,
    session: Any | None = None,
    search_type: int = SEARCH_TYPE_SONG,
    refreshed_cookie_sink: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    keyword = _string(keyword)
    if not keyword:
        return []
    limit = min(max(_integer(limit) or DEFAULT_LIMIT, 1), MAX_LIMIT)
    state = credential_state(cookie)
    # musickey 只有 3 天寿命, 过期后 VIP/无损曲全部拿不到地址(实测可播率 10/10 → 2/10)。
    # 但 cookie 里的 pt_oauth_token/p_skey 寿命长得多, 可以自动换出新 key, 用户不必
    # 每 3~4 天重新扫码。续期成功时把新 cookie 通过 sink 交给上层持久化。
    if state["has_key"] and state["expired"] and cookie.strip():
        refreshed = refresh_musickey(cookie, session=session)
        if refreshed.get("cookie"):
            cookie = refreshed["cookie"]
            state = credential_state(cookie)
            if refreshed_cookie_sink is not None:
                refreshed_cookie_sink["cookie"] = cookie
            LOGGER.info("[qq] 搜索前已自动续期凭证, 当前状态=%s", state["summary"])
    device_id = _device_id(work_dir)
    started = time.monotonic()
    # 搜索这一步按实测形状走匿名请求(不需要也不发送凭证);凭证只在取地址时使用。
    client = PlatformHTTP("", session)

    items, code = _search_items(client, keyword, limit, device_id, search_type)
    if not items:
        # 不允许静默返回空:被限流/被拒绝时必须留下可排查痕迹。
        LOGGER.warning(
            "[qq] 搜索无结果 keyword=%r limit=%d type=%d code=%s 凭证=%s 耗时=%.2fs",
            keyword, limit, search_type, code, state["summary"], time.monotonic() - started,
        )
        _record_search_status(
            keyword=keyword, limit=limit, state=state, code=code, started=started,
            search_type=search_type,
            candidates=0, playable=0, dropped=0, mode="未知", empty_reason="搜索未返回歌曲",
        )
        return []

    mids = [_string(item.get("mid")) for item in items]
    mids = [mid for mid in mids if mid]
    # 记下元数据, 供播放时按 mid 惰性取逐字歌词(见 fetch_lyric)。
    _remember_song_meta([item for item in items if isinstance(item, dict)])
    resolved, mode = _resolve_urls(mids, state, cookie, session=session)

    playable = [mid for mid in mids if mid in resolved]
    missing = [mid for mid in mids if mid not in resolved]
    lyrics = _lyrics_for([item for item in items if _string(item.get("mid")) in resolved], cookie)

    songs: list[dict[str, Any]] = []
    for rank, item in enumerate(items):
        mid = _string(item.get("mid"))
        quality = resolved.get(mid)
        if quality is None:
            continue
        lyric, lyric_verbatim = lyrics.get(mid, ("", False))
        songs.append(_payload(item, rank, quality, lyric, lyric_verbatim))

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
    _record_search_status(
        keyword=keyword, limit=limit, state=state, code=code, started=started,
        search_type=search_type,
        candidates=len(mids), playable=len(playable), dropped=len(missing), mode=mode,
        empty_reason="" if songs else "没有任何歌曲取得下载地址",
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
    "fetch_lyric",
    "search",
    "status",
]
