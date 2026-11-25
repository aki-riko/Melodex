"""搜索补全(联想词)的权威元数据来源。

为什么需要它:Melodex 原来的 `/api/v1/search_suggestions` 只翻**自己的**搜索历史与
搜索缓存 —— 没搜过的东西一条也补不出来,对一个找歌应用等于没有补全。

这里接两个**平台官方的搜索联想接口**(不是我们爬页面,也不是第三方元数据库):

    QQ 音乐   https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg
              实测返回 song/singer/album/mv 四类,匿名可用;
   网易云音乐 https://music.163.com/api/search/suggest/web
              实测返回 songs/artists/albums/playlists,匿名可用。

两者都是"输入前缀 → 平台认为最可能的歌/歌手/专辑",这正是补全要的东西,比任何
第三方库都权威(它就是平台自己的索引)。

为什么不用 MusicBrainz / Discogs 这类:实测它们对中文歌的覆盖与排序都远不如
国内平台(搜「晴天 周杰伦」MusicBrainz 能返回 1072 条 recording,但排序里前几条
并非用户要的那首),而且它们没有中文歌的流行度信号。**补全的正确性依赖"平台认为
什么最匹配"**,所以用平台自己的联想接口。

设计要点:
  · 全部是**尽力而为**:任何一源失败都不抛错,返回其它源的结果(联想挂了绝不能让
    搜索框卡住或报错);
  · 每源独立超时,整体由调用方(Go 侧)再兜一层;
  · 词条去重按"规范化文本",保留首次出现的原始写法(用户看到的是平台原文)。
"""

from __future__ import annotations

import logging
from typing import Any
from urllib.parse import quote

from provider_bridge.collection_common import strict_string
from provider_bridge.platform_http import PlatformHTTP

LOGGER = logging.getLogger(__name__)

QQ_SUGGEST_URL = "https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg"
QQ_SUGGEST_REFERER = "https://y.qq.com/"

NETEASE_SUGGEST_URL = "https://music.163.com/api/search/suggest/web"
NETEASE_SUGGEST_REFERER = "https://music.163.com/"

# 单次请求的条目上限。联想是"边打字边请求"的高频接口,条目越多上游越慢、
# 也更可能被限流;8~10 条足够覆盖用户要看的前几个候选。
DEFAULT_LIMIT = 8
MAX_LIMIT = 20

# 词条类型。前端据此显示不同图标/分组,也决定了"点了以后搜什么"。
KIND_SONG = "song"
KIND_SINGER = "singer"
KIND_ALBUM = "album"


def _clamp_limit(limit: Any) -> int:
    try:
        value = int(limit)
    except (TypeError, ValueError):
        return DEFAULT_LIMIT
    if value <= 0:
        return DEFAULT_LIMIT
    return min(value, MAX_LIMIT)


def _normalized_key(text: str) -> str:
    """去重用的规范化:忽略大小写、空白与常见标点。

    「晴天 (Live)」与「晴天(Live)」在联想列表里会并排出现,对用户是同一个候选。
    """
    return "".join(
        character.lower()
        for character in str(text or "")
        if not character.isspace() and character not in "()（）[]【】·•.,，、-—_/\\"
    )


def _append_term(
    terms: list[dict[str, str]],
    seen: set[str],
    kind: str,
    name: str,
    detail: str = "",
    limit: int = DEFAULT_LIMIT,
) -> None:
    """按去重规则追加一个词条。"""
    if len(terms) >= limit:
        return
    name = strict_string(name).strip()
    if not name:
        return
    # 歌名与歌手名可能撞车(同名歌手/同名歌),去重键带上类型,两类都要能出现。
    key = kind + ":" + _normalized_key(name)
    if key == kind + ":" or key in seen:
        return
    seen.add(key)
    terms.append({"kind": kind, "name": name, "detail": strict_string(detail).strip()})


def _qq_terms(keyword: str, limit: int) -> list[dict[str, str]]:
    url = (
        QQ_SUGGEST_URL
        + "?key=" + quote(keyword, safe="")
        + "&format=json"
    )
    payload = PlatformHTTP("").get(url, headers={"Referer": QQ_SUGGEST_REFERER})
    if not isinstance(payload, dict):
        return []
    data = payload.get("data")
    if not isinstance(data, dict):
        return []

    terms: list[dict[str, str]] = []
    seen: set[str] = set()

    songs = (data.get("song") or {}).get("itemlist") or []
    singers = (data.get("singer") or {}).get("itemlist") or []
    albums = (data.get("album") or {}).get("itemlist") or []

    for item in songs if isinstance(songs, list) else []:
        if not isinstance(item, dict):
            continue
        _append_term(terms, seen, KIND_SONG, item.get("name"), item.get("singer"), limit)
    for item in singers if isinstance(singers, list) else []:
        if not isinstance(item, dict):
            continue
        _append_term(terms, seen, KIND_SINGER, item.get("name"), "", limit)
    for item in albums if isinstance(albums, list) else []:
        if not isinstance(item, dict):
            continue
        _append_term(terms, seen, KIND_ALBUM, item.get("name"), item.get("singer"), limit)
    return terms


def _netease_terms(keyword: str, limit: int) -> list[dict[str, str]]:
    # GET 与 POST 表单实测都可用(两者返回一致),这里用 GET —— 联想是高频调用,
    # 少一次 body 编码、也让"有没有副作用"一眼可见(纯读接口)。
    url = (
        NETEASE_SUGGEST_URL
        + "?csrf_token=&limit=" + str(limit)
        + "&s=" + quote(keyword, safe="")
    )
    payload = PlatformHTTP("").get(url, headers={"Referer": NETEASE_SUGGEST_REFERER})
    if not isinstance(payload, dict):
        return []
    result_payload = payload.get("result")
    if not isinstance(result_payload, dict):
        return []

    terms: list[dict[str, str]] = []
    seen: set[str] = set()

    songs = result_payload.get("songs") or []
    artists = result_payload.get("artists") or []
    albums = result_payload.get("albums") or []

    for item in songs if isinstance(songs, list) else []:
        if not isinstance(item, dict):
            continue
        artist_names = item.get("artists") if isinstance(item.get("artists"), list) else []
        artist = ", ".join(
            strict_string(entry.get("name")) for entry in artist_names
            if isinstance(entry, dict) and strict_string(entry.get("name"))
        )
        _append_term(terms, seen, KIND_SONG, item.get("name"), artist, limit)
    for item in artists if isinstance(artists, list) else []:
        if not isinstance(item, dict):
            continue
        _append_term(terms, seen, KIND_SINGER, item.get("name"), "", limit)
    for item in albums if isinstance(albums, list) else []:
        if not isinstance(item, dict):
            continue
        album_artist = item.get("artist") if isinstance(item.get("artist"), dict) else {}
        _append_term(
            terms, seen, KIND_ALBUM, item.get("name"),
            strict_string(album_artist.get("name")) if isinstance(album_artist, dict) else "",
            limit,
        )
    return terms


def suggest(payload: dict[str, Any]) -> dict[str, Any]:
    """搜索联想:聚合各源,返回去重后的词条列表。

    响应形状(Go 侧按此反序列化):
        {"terms": [{"kind": "song|singer|album", "name": "...", "detail": "..."}],
         "sources": ["qq", "netease"], "errors": {"netease": "..."}}

    terms 里**不带 source**:同一个歌名在多个平台都能搜到,联想要给的是"该搜什么词",
    而不是"去哪搜"。真正搜歌时仍然走多源并发搜索。
    """
    keyword = strict_string(payload.get("keyword")).strip()
    limit = _clamp_limit(payload.get("limit"))
    if not keyword:
        return {"terms": [], "sources": [], "errors": {}}

    # 逐源独立:一源失败不影响另一源。顺序固定(qq 先)保证同样的输入返回同样的顺序。
    providers = (("qq", _qq_terms), ("netease", _netease_terms))
    terms: list[dict[str, str]] = []
    seen: set[str] = set()
    used: list[str] = []
    errors: dict[str, str] = {}

    for source, fetch in providers:
        try:
            source_terms = fetch(keyword, limit)
        except Exception as error:  # 联想是增强项,失败绝不能让搜索框报错
            LOGGER.warning("[suggest] %s 联想失败 keyword=%r: %s", source, keyword, error)
            errors[source] = str(error)
            continue
        if source_terms:
            used.append(source)
        for term in source_terms:
            # 聚合层的去重**只看名字**（不看 kind）。
            #
            # 原因：同一个词在联想列表里既是 song 又是 album 时（实测「晴天」同时出现在
            # QQ 的 song 与 album 组里），用户点这两条发出去的搜索词完全一样，列表上却是
            # 两条占位 —— 纯属噪声。联想只回答"该搜什么词"，类型只是给前端挑图标的提示，
            # 所以按名字合并、保留先出现的那条（song 优先，因为它带歌手信息）。
            key = _normalized_key(term["name"])
            if key in seen:
                continue
            seen.add(key)
            terms.append(term)
            if len(terms) >= limit:
                break
        if len(terms) >= limit:
            break

    return {"terms": terms, "sources": used, "errors": errors}


__all__ = ["suggest", "KIND_SONG", "KIND_SINGER", "KIND_ALBUM", "DEFAULT_LIMIT", "MAX_LIMIT"]
