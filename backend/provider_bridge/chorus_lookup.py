"""按歌曲身份取副歌起止点位(给「已下载」本地库补副歌用)。

## 为什么需要独立的入口

搜索链路里副歌是"顺手捎带"的:
  - 网易走一次批量接口(`netease_chorus.fetch_chorus_map`, 搜索侧已接在 `app.py`);
  - 酷我搜索响应自带 `payInfo.refrain_start/refrain_end`, 零额外请求。
但本地库(`/music/local_music`)手上只有**磁盘文件** + `download_records` 里的
`(source, song_id)`, 既没有搜索响应也没有候选列表, 所以需要一条能"按身份反查"的路。

## 并发纪律(用户明确下达的硬约束, 不要放宽)

这是新增的上游请求路径, **宁可覆盖小、宁可慢, 也绝不能打爆上游**:

  - **网易**: 走已有的单次批量接口, 一个 source 一次请求覆盖整批 id。这是最优路径。
  - **酷我**: 上游只能按关键词搜(`searchMusicBykeyWord` 没有"给 rid 列表返回副歌点位"的
    接口), 所以只能"用歌名+歌手反查"。这条路径**串行 + 每批最多前 MAX_KUWO_LOOKUPS 首**,
    且首次失败立刻停手(不重试、不并发)。上游一旦开始抖动就整批放弃。
  - **QQ / 其他源**: 没有任何可用接口。QQ 连搜索链路都拿不到副歌(实测多个模块
    500003 不存在), 这里直接跳过, 不做"试一试"。

## 为什么酷我不能像网易那样批量

酷我的副歌点位只出现在**搜索响应**的 `payInfo` 里, 没有按 id 批量取点位的接口。
单曲接口(`songinfoandlrc` 之类)给的是歌词而不是副歌区间, 所以只能退回关键词检索 ——
这也正是它必须被严格限流的原因。

## 为什么没有模块级状态

sidecar 是 `ThreadingHTTPServer`, 同一时刻可能有多个请求。任何"这次请求的上下文"都必须
通过参数传递, 绝不能放模块级变量 —— 那既是数据竞争, 也会把上一批的歌名/歌手泄漏给
下一批请求(串歌)。

本模块不引用也不改动 third_party/charles-musicdl 快照。
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Iterable

from provider_bridge import kuwo_source, netease_chorus

LOGGER = logging.getLogger(__name__)

# 网易批量接口一次能带多少 id。与 netease_chorus.MAX_BATCH_IDS 对齐即可:
# 两者是同一个上游接口, 别在这里定一个更大的数把它绕过去。
MAX_NETEASE_BATCH_IDS = netease_chorus.MAX_BATCH_IDS

# 酷我关键词反查的**硬上限**。这不是"性能参数"而是保护上游的闸门:
# 每次反查都是一次完整搜索请求, 命中与否全看歌名歌手拼得准不准。
# 取 5 是因为本地库一页里通常只有零星几首来自酷我(生产 631 条里仅 26 条),
# 5 次串行足够覆盖常见情况, 又不会让任何一次列表刷新变成"对拷酷我搜索接口"。
MAX_KUWO_LOOKUPS = 5

# 酷我反查时每次只取很少的候选: 我们要的是"精确命中这首 id", 不需要整页结果。
# 取 5 是因为同名曲(原唱/伴奏/Live)在前几条内即可分辨, 再多只是白拉数据。
MAX_KUWO_KEYWORD_LIMIT = 5

# 酷我反查是全局串行的: 即使 sidecar 同时收到多个列表刷新请求, 也不允许它们各自
# 串行地并发打酷我 —— 那样上游看到的就是 N 路并发。这把锁把酷我反查排队成一条流,
# 是"绝不提高上游并发"这条硬约束在 sidecar 侧的最后一道保证。
#
# 用普通 Lock 而不是信号量: 持有时间短(最多 5 次串行搜索), 宁可让后来的请求排队等,
# 也不给它"最多 2 个并发"这种可被叠加放大的空间。
_KUWO_LOOKUP_LOCK = threading.Lock()


def _valid_point(start: Any, end: Any) -> dict[str, int] | None:
    """校验副歌点位是否可信: 起点为正、终点晚于起点。

    与 netease_chorus.build_chorus_map / kuwo_source._chorus_range 同一套判据,
    这里在出口再守一道: 前端要在进度条上画区间, 脏数据画出来的标记比不画更误导人。
    """
    try:
        begin = int(start or 0)
        finish = int(end or 0)
    except (TypeError, ValueError):
        return None
    if begin <= 0 or finish <= begin:
        return None
    return {"start": begin, "end": finish}


def _netease_chorus(ids: list[str], cookie: str) -> dict[str, dict[str, int]]:
    """网易: 先吃进程内缓存, 只对没命中的部分发**一次**批量请求。

    这是整条链路里唯一"有批量形态"的源, 也是本功能的主力覆盖(生产 631 条里 126 条)。

    为什么要先查 `cached_chorus_for`: 搜索链路的后台补全(`app.py:_enrich_netease_chorus`)
    会把搜过的歌补进同一个进程内缓存。用户往往是"先搜过再下载", 所以本地库列表这一批
    里很可能大部分已经缓存过了 —— 先过滤一遍能让这次批量请求的 id 数变少, 甚至完全不发。
    这是"缓存命中时零上游请求"在 sidecar 侧的落实。

    注意 `fetch_chorus_map` 自带的缓存要求**整批全命中**才短路(见其 `_cache_lookup`),
    部分命中时它会把整批再发一次。所以这里必须自己做一次"已命中/未命中"拆分,
    否则部分命中的页会白白把已缓存的歌再问一遍。
    """
    if not ids:
        return {}
    try:
        cached = netease_chorus.cached_chorus_for(ids)
    except Exception as error:  # 缓存层异常也不能挡住后面的真实请求
        LOGGER.warning("[chorus] 网易缓存查询异常: %s", error)
        cached = {}
    pending = [song_id for song_id in ids if song_id not in cached]
    if not pending:
        LOGGER.debug("[chorus] 网易 %d 首全部缓存命中, 零上游请求", len(ids))
        return cached
    try:
        fetched = netease_chorus.fetch_chorus_map(pending, cookie=cookie)
    except Exception as error:  # 增强项: 失败只留痕, 绝不影响列表本身
        LOGGER.warning("[chorus] 网易批量取副歌失败(%d 首): %s", len(pending), error)
        return cached
    merged = dict(cached)
    merged.update(fetched or {})
    return merged


def _kuwo_chorus(
    ids: list[str],
    cookie: str,
    hints: dict[str, str],
) -> dict[str, dict[str, int]]:
    """酷我: 只能按"歌名+歌手"反查, 因此严格串行 + 每批最多 MAX_KUWO_LOOKUPS 首。

    为什么逐首而不是并发: 酷我搜索是这条链路里唯一没有批量形态的上游接口。
    为它开并发, 每次打开本地库列表就会变成对酷我搜索接口的一串并发请求 ——
    那正是用户明令禁止的事。串行 + 首次失败即停, 宁可少补几首。

    为什么失败即停而不是继续试下一首: 连续失败通常意味着上游在限流/不可用。
    继续逐个尝试只会把"上游抖了一下"放大成"对上游持续施压"。
    """
    chorus: dict[str, dict[str, int]] = {}
    targets = ids[:MAX_KUWO_LOOKUPS]
    if not targets:
        return chorus
    with _KUWO_LOOKUP_LOCK:
        for song_id in targets:
            keyword = str(hints.get(song_id, "")).strip()
            if not keyword:
                # 拿不到歌名/歌手就无法反查; 跳过而不是用 id 硬搜(rid 不是搜索词)。
                continue
            try:
                songs = kuwo_source.search(keyword, limit=MAX_KUWO_KEYWORD_LIMIT, cookie=cookie)
            except Exception as error:
                LOGGER.warning(
                    "[chorus] 酷我反查失败 id=%s keyword=%r: %s", song_id, keyword, error,
                )
                break
            point = _pick_kuwo_match(songs, song_id)
            if point is not None:
                chorus[song_id] = point
    return chorus


def _pick_kuwo_match(songs: Iterable[dict[str, Any]], song_id: str) -> dict[str, int] | None:
    """从酷我搜索候选里找出**同一首**(同 id)并取它的副歌点位。

    必须按 id 精确匹配, 不能"取第一条": 反查词是"歌名+歌手", 搜出来的第一条
    可能是翻唱/伴奏 —— 把它的副歌点位标到用户这首歌上, 比不标更糟。
    """
    target = str(song_id).strip()
    for song in songs:
        if not isinstance(song, dict):
            continue
        if str(song.get("id") or "").strip() != target:
            continue
        extra = song.get("extra")
        if not isinstance(extra, dict):
            return None
        return _valid_point(extra.get("chorus_start_ms"), extra.get("chorus_end_ms"))
    return None


def chorus(payload: dict[str, Any]) -> dict[str, Any]:
    """按 (source, ids) 取副歌点位; 返回 {"chorus": {id: {start, end}}}。

    请求体形状:
        {"source": "netease", "ids": ["186016", ...], "cookie": "..."}
        {"source": "kuwo", "ids": ["228908", ...], "cookie": "...",
         "kuwo_hints": {"228908": "晴天 周杰伦"}}   # 酷我必须带歌名/歌手才能反查

    任何上游失败都不抛异常: 副歌是纯展示增强, 列表接口不能因为它失败或变慢。
    上游真出错时返回空 map, 调用方据此当作"这批歌没有副歌数据"。
    """
    source = str(payload.get("source") or "").strip().lower()
    ids = _clean_ids(payload.get("ids"))
    cookie = str(payload.get("cookie") or "").strip()
    if not source:
        raise ValueError("source is required")
    if not ids:
        return {"chorus": {}}

    if source == "netease":
        if not netease_chorus.chorus_enabled():
            return {"chorus": {}}
        return {"chorus": _netease_chorus(ids[:MAX_NETEASE_BATCH_IDS], cookie)}

    if source == "kuwo":
        hints: dict[str, str] = {}
        raw_hints = payload.get("kuwo_hints")
        if isinstance(raw_hints, dict):
            for key, value in raw_hints.items():
                text = str(value or "").strip()
                if text:
                    hints[str(key).strip()] = text
        return {"chorus": _kuwo_chorus(ids, cookie, hints)}

    # QQ 没有任何可用接口(搜索侧已实测确认), 其他源也没有。
    # 静默返回空而不是报错 —— 调用方按源批量请求时, "这个源不支持"是正常情况。
    LOGGER.debug("[chorus] 源 %s 无副歌接口, 跳过", source)
    return {"chorus": {}}


def _clean_ids(raw: Any) -> list[str]:
    """去空、去重且保序; 非字符串元素一律转成字符串后判断。"""
    if not isinstance(raw, (list, tuple)):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for value in raw:
        text = str(value or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out


__all__ = ["MAX_KUWO_LOOKUPS", "MAX_NETEASE_BATCH_IDS", "chorus"]
