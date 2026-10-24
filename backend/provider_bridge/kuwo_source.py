"""酷我搜索与播放地址(原生实现)。

为什么需要它: 快照 KuwoMusicClient 对**每一首**歌都跑 12 档 cenguigui + 5 档 yaohud +
5 档 mobi 音质阶梯, 每档还做一次音频探活, 实测 limit=20 要 **83.7s** —— 远超 app 侧扇出
预算, 常常整源被丢。而且它有两个正确性问题(2026-10 实测):

  1. **付费曲拿到的是 11 秒试听片段却标成可播**。搜索结果里 `PAY=0xFF00FF`
     (或 `fpay=1` / `refrain_start>0`) 的歌, 无 cookie 时 mobi.s 固定回一段
     `resp_rid=260839262` 的 11.35 秒 mp3, 但快照按"能连上、有内容"判定为
     valid, `size` 只是 0 不暴露问题 → 用户点开只响 11 秒就跳下一首。
  2. 音质阶梯用的是 `2000kflac` 这类**推测的**档位字符串, 而搜索结果 `MINFO` 里
     已经写明该曲真实可用的 `level:bitrate:format:size` 列表 —— 直接读它即可,
     无需逐档试探。

本实现每首只打 **2 次**请求(搜索 1 次 + 取址 1 次), 并且用三条独立信号判定
"这段音频是不是完整歌曲", 保证不会把试听片段当成可播曲交出去:
  - 搜索结果声明为付费(`fpay`/`refrain_start`/`PAY` 掩码);
  - mobi.s 返回的 `duration` 与搜索结果 `DURATION` 不符;
  - mobi.s 返回的 `rid` 与请求的 rid 不符(试听片段会回固定 rid)。

音频格式口径: 实测无 cookie 时即使请求 `2000kflac` 也给 aac(48kbps 档),
如实按返回的 `format`/`bitrate` 上报, 不假装无损。
"""

from __future__ import annotations

import logging
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from provider_bridge.platform_http import PlatformHTTP


LOGGER = logging.getLogger(__name__)

SEARCH_URL = "https://www.kuwo.cn/search/searchMusicBykeyWord"
MOBI_URL = "https://mobi.kuwo.cn/mobi.s"
LYRIC_URL = "https://m.kuwo.cn/newh5/singles/songinfoandlrc"

# 搜索参数取自快照 _constructsearchurls, 实测仍可用。
SEARCH_PARAMS = {
    "vipver": "1",
    "client": "kt",
    "ft": "music",
    "cluster": "0",
    "strategy": "2012",
    "encoding": "utf8",
    "rformat": "json",
    "mobi": "1",
    "issubtitle": "1",
    "show_copyright_off": "1",
}
# mobi.s 的客户端标识(取自快照, 换成别的一律拿不到地址)。
MOBI_SOURCE = "kwplayercar_ar_6.0.0.9_B_jiakong_vh.apk"
MOBI_USER = "C_APK_guanwang_12609069939969033731"
KUWO_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.kuwo.cn/",
}

# 付费曲在 PAY 位掩码里的标记。0xFF00FF 是 0x880088 的位超集, 高位为支付/会员权限。
PAID_PAY_MASK = 0xFF00FF
PAID_PAY_VALUE = 0x880088
# 时长容差: 试听片段只有 ~11s, 与真实时长差得远; 用 max(5s, 10%) 容差吸收编码误差。
DURATION_TOLERANCE_SECONDS = 5
DURATION_TOLERANCE_RATIO = 0.10

PROVIDER_COMMIT = "b4cecd9d450ede6f5c8d4df08763668256dfee58"
LOSSLESS_EXTENSIONS = {"flac", "wav", "alac", "ape", "wv", "tta", "dsf", "dff"}
# 只认这些"通用解码器能放"的格式。酷我的 mgg/mflac/mmp4/zp 是**加密专有容器**,
# 必须靠酷我自己的解密器才能还原成音频, ffmpeg/浏览器都打不开 —— 实测把它们交给
# ffprobe 直接报 "Invalid data found when processing input", 播放必然失败。
PLAYABLE_EXTENSIONS = LOSSLESS_EXTENSIONS | {"mp3", "aac", "m4a", "ogg", "wma"}
ENCRYPTED_EXTENSIONS = {"mgg", "mflac", "mmp4", "zp", "m4a_encrypted"}

# 最近一次请求的观测快照, 供 /health 暴露(与 qq_source/netease_source 同口径)。
_status_lock = threading.Lock()
_status: dict[str, Any] = {}


def _record_status(**fields: Any) -> None:
    with _status_lock:
        _status.update(fields)
        _status["updated_at"] = int(time.time())


def status() -> dict[str, Any]:
    """返回最近一次酷我请求的观测快照(未发生过请求时为空字典)。"""
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


def _is_paid_item(item: dict[str, Any]) -> bool:
    """判断搜索结果是否为"无 cookie 只能听试听片段"的付费曲。

    只认两个信号(宁可漏判成可播, 也不能把 11 秒片段当整曲交付):
      - `fpay == 1`: 上游直接给的付费标志, 实测与真实可播性 100% 对应;
      - `PAY` 位掩码包含 0x880088 之外的支付位(0xFF00FF 是它的超集)。

    注意 **不能用 `payInfo.refrain_start`**: 那是"副歌起点"(卡拉OK跳转用), 每首歌
    都有非零值(实测连免费曲也有 79683ms), 误用它会把所有歌都判成付费。
    """
    if _integer(item.get("fpay")) > 0:
        return True
    pay = _integer(item.get("PAY"))
    if pay:
        return (pay & PAID_PAY_MASK) > (PAID_PAY_VALUE & PAID_PAY_MASK)
    return False


def _minfo_levels(item: dict[str, Any]) -> list[dict[str, Any]]:
    """解析搜索结果里的 MINFO —— 该曲真实可用的档位列表。

    形如 `level:ff,bitrate:2000,format:flac,size:52.83Mb;level:p,bitrate:320,...`。
    比快照那样自己编 `2000kflac` 去试探准确得多, 且零额外请求。
    """
    levels: list[dict[str, Any]] = []
    for entry in _string(item.get("MINFO")).split(";"):
        fields: dict[str, str] = {}
        for part in entry.split(","):
            name, separator, value = part.partition(":")
            if separator:
                fields[name.strip()] = value.strip()
        level = fields.get("level", "")
        if not level:
            continue
        ext = fields.get("format", "").lower()
        levels.append({
            "level": level,
            "bitrate": _integer(fields.get("bitrate")),
            "ext": ext,
            "size": _parse_size_bytes(fields.get("size", "")),
        })
    return levels


def _parse_size_bytes(raw: str) -> int:
    """把 `52.83Mb` 之类的字符串换算成字节(拿不到就返回 0)。"""
    text = _string(raw)
    for suffix, factor in (("Mb", 1024 * 1024), ("MB", 1024 * 1024), ("KB", 1024), ("kb", 1024)):
        if text.endswith(suffix):
            try:
                return int(float(text[: -len(suffix)].strip()) * factor)
            except ValueError:
                return 0
    return 0


def _pick_level(item: dict[str, Any]) -> dict[str, Any]:
    """挑最高可用档位(无损优先, 再按 bitrate 降序)。

    只挑**通用可解码格式**: MINFO 里还会出现 `mgg`/`mflac`/`mmp4`/`zp*` 这些酷我
    加密专有格式(需要专有解密器才能解), ffmpeg/浏览器都放不了, 必须排除, 否则会把
    "看似可播、实际是加密容器"的歌交给前端(ffprobe 会直接报 Invalid data)。
    """
    decodable = [
        lv for lv in _minfo_levels(item)
        if lv["ext"] in PLAYABLE_EXTENSIONS
    ]
    if not decodable:
        return {"level": "", "bitrate": 0, "ext": "", "size": 0}
    decodable.sort(
        key=lambda lv: (
            0 if lv["ext"] in LOSSLESS_EXTENSIONS else 1,
            -lv["bitrate"],
        )
    )
    return decodable[0]


def _mobi_url(song_id: str, level: str) -> str:
    query = urllib.parse.urlencode({
        "f": "web",
        "source": MOBI_SOURCE,
        "from": "PC",
        "type": "convert_url_with_sign",
        "br": level,
        "rid": song_id,
        "user": MOBI_USER,
    })
    return f"{MOBI_URL}?{query}"


def _level_param(level: dict[str, Any]) -> str:
    """把 MINFO 的一道档位拼成 mobi.s 的 `br` 参数。

    **必须是 `<bitrate>k<format>` 形式**(如 `100kogg` / `48kaac` / `128kmp3`)。
    实测传 `ogg`/`aac`/`mp3` 这类裸格式名, 或传 MINFO 里的 `level` 值(`h`/`s`/`ff`),
    上游会回 **mgg 加密容器** —— 看着 200 成功, 实际 ffmpeg 解不开, 播放必然失败。
    仅当拿不到 bitrate 时才退化为纯数字(`128` 实测也能拿到 mp3)。
    """
    bitrate = _integer(level.get("bitrate"))
    ext = _string(level.get("ext")).lower()
    if not bitrate:
        return ""
    if ext:
        return f"{bitrate}k{ext}"
    return str(bitrate)


def resolve_play_url(
    song_id: str,
    *,
    expected_duration_seconds: int = 0,
    level: dict[str, Any] | None = None,
    cookie: str = "",
    session: Any | None = None,
) -> dict[str, Any]:
    """取播放地址; 返回 {} 表示这首拿不到可用音频。

    判定"能不能用"的四条信号(任一不满足都返回 {}, 由调用方标记 is_invalid):
      1. `br` 必须按 MINFO 档位精确构造, 否则上游回 mgg 加密容器;
      2. 返回的 `format` 必须是通用可解码格式(加密容器直接拒收);
      3. 返回的 `rid` 必须与请求一致(试听片段回固定 rid);
      4. 返回的 `duration` 必须与搜索声明吻合(试听片段只有 11 秒)。
    """
    song_id = _string(song_id)
    if not song_id:
        return {}
    level = level or {}
    br = _level_param(level)
    if not br:
        return {}
    client = PlatformHTTP(cookie, session)
    url = _mobi_url(song_id, br)
    try:
        payload = client.get(url, headers=KUWO_HEADERS)
    except Exception as error:
        LOGGER.warning("[kuwo] 取播放地址失败 id=%s: %s", song_id, error)
        return {}
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return {}
    download_url = _string(data.get("url"))
    if not download_url:
        return {}
    ext = _extension_from(data.get("format"), download_url)
    if ext in ENCRYPTED_EXTENSIONS or ext not in PLAYABLE_EXTENSIONS:
        # 加密专有格式: 拿到的字节 ffmpeg/浏览器解不开, 宁可标不可播也不能交给前端。
        LOGGER.info("[kuwo] 拒收非通用格式 id=%s format=%s", song_id, ext or "unknown")
        return {}
    response_rid = _string(data.get("rid"))
    if response_rid and response_rid != song_id:
        # 试听片段固定回另一个 rid(实测恒为 260839262), 说明这不是我们要的那首。
        LOGGER.info("[kuwo] 返回片段与请求不符 id=%s 实际=%s(判定为试听)", song_id, response_rid)
        return {}
    duration = _integer(data.get("duration"))
    if expected_duration_seconds > 0 and duration > 0:
        tolerance = max(
            DURATION_TOLERANCE_SECONDS,
            int(expected_duration_seconds * DURATION_TOLERANCE_RATIO),
        )
        if abs(duration - expected_duration_seconds) > tolerance:
            LOGGER.info(
                "[kuwo] 时长不符 id=%s 声明=%ds 返回=%ds(判定为试听)",
                song_id, expected_duration_seconds, duration,
            )
            return {}
    return {
        "url": download_url,
        "duration": duration,
        "ext": ext,
        "bitrate": _integer(data.get("bitrate")) or _integer(level.get("bitrate")),
        "size": _integer(level.get("size")),
    }


def _extension_from(raw_format: Any, url: str) -> str:
    """确定音频扩展名: 优先用响应 `format`, 退回 URL 后缀。"""
    ext = _string(raw_format).lower()
    if ext:
        return ext
    path = urllib.parse.urlparse(url).path
    return path.rsplit(".", 1)[-1].lower() if "." in path else ""


def _search_items(client: PlatformHTTP, keyword: str, limit: int) -> list[dict[str, Any]]:
    params = dict(SEARCH_PARAMS)
    params["all"] = keyword
    params["pn"] = "0"
    params["rn"] = str(max(1, min(limit, 100)))
    payload = client.get(f"{SEARCH_URL}?{urllib.parse.urlencode(params)}", headers=KUWO_HEADERS)
    items = payload.get("abslist") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        return []
    return [
        item for item in items
        if isinstance(item, dict) and _string(item.get("MUSICRID"))
    ]


def build_payload(
    item: dict[str, Any],
    resolution: dict[str, Any] | None,
    rank: int,
) -> dict[str, Any]:
    """与快照 song_to_payload 形状对齐的 payload(Go/前端按同一套字段消费)。"""
    resolution = resolution or {}
    raw_id = _string(item.get("MUSICRID")).removeprefix("MUSIC_")
    duration = _integer(item.get("DURATION"))
    level = _pick_level(item)
    url = _string(resolution.get("url"))
    # 如实上报真实给到的格式与码率(拿不到地址时退回 MINFO 的最佳可解码档位做展示值)。
    ext = _string(resolution.get("ext")) or level["ext"]
    bitrate = _integer(resolution.get("bitrate")) or level["bitrate"]
    size = _integer(resolution.get("size")) or level["size"]
    cover = _string(item.get("hts_MVPIC")) or _string(item.get("web_albumpic_short"))
    if cover and not cover.startswith("http"):
        cover = f"https://img4.kuwo.cn/star/albumcover/{cover}" if not cover.startswith("/") else f"https://img4.kuwo.cn{cover}"
    extra: dict[str, str] = {
        "_rank": str(rank),
        "provider": "melodex-native",
        "provider_commit": PROVIDER_COMMIT,
        "provider_lookup": " ".join(
            part for part in (_string(item.get("SONGNAME")), _string(item.get("ARTIST"))) if part
        ),
    }
    if ext in LOSSLESS_EXTENSIONS:
        extra["has_lossless"] = "1"
    if _is_paid_item(item):
        # 付费曲无 cookie 必然只有试听片段; 明确标记, 前端据此提示"需登录会员"。
        extra["needs_vip"] = "1"
    return {
        "id": raw_id,
        "name": _string(item.get("SONGNAME")) or _string(item.get("NAME")),
        "artist": _string(item.get("ARTIST")),
        "album": _string(item.get("ALBUM")),
        "album_id": _string(item.get("ALBUMID")),
        "duration": duration,
        "size": size,
        "bitrate": bitrate,
        "source": "kuwo",
        "url": url,
        "ext": ext,
        "cover": cover,
        "link": "",
        "extra": extra,
        "is_invalid": not url,
        "is_vip": _is_paid_item(item),
    }


def search(
    keyword: str,
    limit: int = 20,
    *,
    cookie: str = "",
    session: Any | None = None,
) -> list[dict[str, Any]]:
    """原生搜歌: 每首 1 次取址请求, 付费曲/试听片段明确标为不可播。"""
    keyword = _string(keyword)
    limit = min(max(_integer(limit) or 20, 1), 100)
    if not keyword:
        return []
    client = PlatformHTTP(cookie, session)
    try:
        items = _search_items(client, keyword, limit)[:limit]
    except Exception as error:
        LOGGER.warning("[kuwo] 搜索失败 keyword=%r: %s", keyword, error)
        _record_status(keyword=keyword, candidates=0, playable=0, empty_reason="search_error")
        raise
    if not items:
        LOGGER.info("[kuwo] 原生搜歌无命中 keyword=%r", keyword)
        _record_status(keyword=keyword, candidates=0, playable=0, empty_reason="no_match")
        return []

    def resolve(item: dict[str, Any]) -> dict[str, Any]:
        song_id = _string(item.get("MUSICRID")).removeprefix("MUSIC_")
        if _is_paid_item(item):
            # 付费曲连取址请求都不发: 省一次往返, 且防止把固定试听片段当整曲。
            return {}
        level = _pick_level(item)
        if not level.get("level") and not level.get("ext"):
            # MINFO 里没有任何通用可解码档位(只剩加密专有格式), 直接判不可播。
            return {}
        return resolve_play_url(
            song_id,
            expected_duration_seconds=_integer(item.get("DURATION")),
            level=level,
            cookie=cookie,
            session=session,
        )

    with ThreadPoolExecutor(max_workers=min(6, len(items))) as pool:
        resolutions = list(pool.map(resolve, items))
    payloads = [
        build_payload(item, resolution, rank)
        for rank, (item, resolution) in enumerate(zip(items, resolutions))
    ]
    playable = sum(1 for payload in payloads if not payload["is_invalid"])
    paid = sum(1 for payload in payloads if payload["is_vip"])
    LOGGER.info(
        "[kuwo] 原生搜歌命中 %d 首, 取到地址 %d 首(付费/需会员 %d 首) keyword=%r",
        len(payloads), playable, paid, keyword,
    )
    _record_status(
        keyword=keyword, candidates=len(payloads), playable=playable,
        paid=paid, empty_reason="",
    )
    return payloads


def fetch_lyric(song_id: str, *, cookie: str = "", session: Any | None = None) -> str:
    """按 rid 取行级 LRC(尽力而为; 失败的曲目上游返回 status=301)。"""
    song_id = _string(song_id)
    if not song_id:
        return ""
    client = PlatformHTTP(cookie, session)
    try:
        payload = client.get(
            f"{LYRIC_URL}?{urllib.parse.urlencode({'musicId': song_id, 'httpsStatus': '1'})}",
            headers=KUWO_HEADERS,
        )
    except Exception as error:
        LOGGER.warning("[kuwo] 取歌词失败 id=%s: %s", song_id, error)
        return ""
    data = payload.get("data") if isinstance(payload, dict) else None
    entries = data.get("lrclist") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        return ""
    lines: list[str] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        text = _string(entry.get("lineLyric"))
        if not text:
            continue
        try:
            seconds = float(entry.get("time") or 0)
        except (TypeError, ValueError):
            seconds = 0.0
        minutes, rest = divmod(seconds, 60)
        lines.append("[%02d:%05.2f]%s" % (int(minutes), rest, text))
    return "\n".join(lines)


__all__ = [
    "build_payload",
    "fetch_lyric",
    "resolve_play_url",
    "search",
    "status",
]
