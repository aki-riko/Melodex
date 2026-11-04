"""网易副歌起止点位(chorus)的批量取回。

为什么需要它: 酷我的搜索响应自带 `payInfo.refrain_start/refrain_end`(零额外请求), 网易
的 cloudsearch 响应里**没有**这类字段; 但网易有一条官方批量接口(实测):

    GET https://music.163.com/api/song/chorus?ids=[186016,1901371647]
    -> {"code":200,"chorus":[{"id":186016,"startTime":84498,"endTime":142301}],
        "data":[{"id":..., ...}]}

一次请求可覆盖整页候选(实测 9~10/10 有数据), 前端据此在播放进度条上画出副歌区间。
QQ 侧没有任何可用接口(500003 模块已不存在), 所以本源是这条路唯一的数据来源。

设计取舍:
  - **一次批量、绝不逐首**: 逐首请求会把搜索从 ~2s 拖回几十秒(酷我快照的老毛病),
    所以本模块只接受一个 id 列表, 内部就发一次请求。
  - **尽力而为**: 副歌点位是纯展示增强, 失败/超时/非 200/形状不对一律返回空 dict,
    由调用方当作"这批歌没有副歌数据"处理, 绝不能让搜索本身失败。
  - 不缓存: 结果是按本次搜索的候选算的, 全局缓存收益为零而键空间无穷。

本模块不引用也不改动 third_party/charles-musicdl 快照。
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Iterable

from provider_bridge.platform_http import PlatformHTTP


LOGGER = logging.getLogger(__name__)

NETEASE_CHORUS_URL = "https://music.163.com/api/song/chorus"
NETEASE_REFERER = "https://music.163.com/"

# 一次批量请求的 id 上限。实测单页候选 ≤ 100, 而整串 id 会进 query string ——
# 100 个 10 位数字约 1.1KB, 仍远在上游可接受范围内, 与搜索 limit 上限对齐即可。
MAX_BATCH_IDS = 100


def _string(value: Any) -> str:
    if value is None or value == "NULL":
        return ""
    return str(value).strip()


def _integer(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def chorus_enabled() -> bool:
    """开关: MELODEX_NETEASE_CHORUS=0/false/no/off 时整体关掉(默认开)。

    留这个开关是为了出问题能一键退回"不请求副歌接口"的状态 —— 它属于增强项,
    关掉只丢点位, 不影响搜索/播放。
    """
    raw = os.environ.get("MELODEX_NETEASE_CHORUS", "").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def _chorus_url(song_ids: list[int]) -> str:
    # 实测可用形式是整数数组字面量(与 song_details 的 ids 同口径); 数字已过 isdigit
    # 校验, 转换后既不会引入注入面, 也与真实请求逐字节一致。
    return NETEASE_CHORUS_URL + "?ids=" + json.dumps(song_ids)


def build_chorus_map(payload: Any) -> dict[str, dict[str, int]]:
    """从 /api/song/chorus 的响应里挑出可用点位, 键为歌曲 id 字符串。

    只保留能自证合理的记录(起点为正、终点晚于起点); 其余行直接丢弃 —— 前端要在
    进度条上画区间, 脏数据画出来的标记比不画更误导人。返回空 dict 表示这批歌没有数据。
    """
    if not isinstance(payload, dict) or _integer(payload.get("code")) != 200:
        return {}
    entries = payload.get("chorus")
    if not isinstance(entries, list):
        return {}
    out: dict[str, dict[str, int]] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        song_id = _string(entry.get("id"))
        start = _integer(entry.get("startTime"))
        end = _integer(entry.get("endTime"))
        if not song_id or start <= 0 or end <= start:
            continue
        out[song_id] = {"start": start, "end": end}
    return out


def fetch_chorus_map(
    song_ids: Iterable[Any],
    *,
    cookie: str = "",
    session: Any | None = None,
) -> dict[str, dict[str, int]]:
    """批量取副歌点位; 任何失败都返回空 dict(尽力而为, 绝不影响搜索)。

    参数是**id 的可迭代对象**, 非数字 id(如 `loc:` 开头的本地 id)直接跳过: 上游只
    认网易的数字 song id。整批只发一次请求, 失败即放弃(不做逐首重试, 那会拖慢搜索)。
    """
    numeric_ids: list[int] = []
    for value in song_ids or []:
        text = _string(value)
        if not text.isdigit():
            continue
        number = int(text)
        # 用字符串键去重, 保留首次出现的顺序(上游返回顺序不保证, 这里只关心数量)。
        if number not in numeric_ids:
            numeric_ids.append(number)
    if not numeric_ids:
        return {}
    numeric_ids = numeric_ids[:MAX_BATCH_IDS]
    try:
        client = PlatformHTTP(cookie, session)
        payload = client.get(_chorus_url(numeric_ids), headers={"Referer": NETEASE_REFERER})
    except Exception as error:  # 副歌点位是增强项, 失败不能影响搜索本身
        LOGGER.warning("[netease] 副歌点位请求失败(%d 首): %s", len(numeric_ids), error)
        return {}
    chorus = build_chorus_map(payload)
    if not chorus:
        LOGGER.debug("[netease] 副歌点位无可用数据(%d 首)", len(numeric_ids))
        return {}
    LOGGER.info("[netease] 副歌点位命中 %d/%d 首", len(chorus), len(numeric_ids))
    return chorus


__all__ = ["build_chorus_map", "chorus_enabled", "fetch_chorus_map"]
