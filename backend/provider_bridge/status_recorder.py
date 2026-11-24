"""Provider 观测快照的公共实现(2026-11 全库扫描收敛)。

背景:qq_source / netease_source / kuwo_source 各自实现了一套
`_status_lock` + `_status` + `_record_status` + `status()` 的"最近一次请求
观测快照",供 `/health` 暴露。骨架逐字相同,但**细节不一样**:

  · qq / kuwo:update(fields) + updated_at,status() 直接返回副本;
  · netease:额外维护 rate_limited 的"每次请求重置"语义,且 status() 里
    还要叠加实时的冷却窗剩余时间。

所以这里**不强行统一成一个函数**,而是抽出一个 StatusRecorder 承担三者
真正共有的部分(加锁、update、updated_at、返回副本),各家独有的语义
用钩子保留:

    _status = StatusRecorder()
    def _record_status(**fields): _status.record(**fields)
    def status(): return _status.snapshot()

netease 那种需要"每次请求重置某字段"的,用 reset_each_record 参数表达;
需要"快照时叠加实时信息"的,自己拿到 snapshot() 之后再补 ——
不该为了统一而把不同语义硬塞进一个函数。

★ 为什么用类而不是模块级函数 + 全局变量:三份实现都靠模块级
`_status_lock` / `_status` 两个全局量配对使用,任何人只改其中一个就会
出并发 bug。封成对象后,锁与数据不可能被拆开。
"""

from __future__ import annotations

import threading
import time
from typing import Any


class StatusRecorder:
    """线程安全的"最近一次请求观测快照"。

    语义与原来三份手写实现逐条一致:
      · record(**fields) —— 合并字段并刷新 updated_at(秒级 unix 时间);
      · snapshot()       —— 返回副本(调用方改它不会污染内部状态);
      · reset_each_record —— 每次 record 前把这些键重置为给定值。

    reset_each_record 是为 netease 的 rate_limited 设计的:它必须"每次请求
    都显式重写",否则一旦撞过一次 405 就会永久显示 rate_limited=True,
    后面明明搜成功 /health 还在报限流,巡检会被假信号带偏。
    """

    def __init__(self, reset_each_record: dict[str, Any] | None = None) -> None:
        self._lock = threading.Lock()
        self._data: dict[str, Any] = {}
        self._reset_each_record = dict(reset_each_record or {})

    def record(self, **fields: Any) -> None:
        with self._lock:
            self._data.update(fields)
            for key, value in self._reset_each_record.items():
                # 调用方没显式给这个字段时,按预设值重置。
                # (显式给了就以调用方为准 —— update 已经在上面写进去了。)
                if key not in fields:
                    self._data[key] = value
            self._data["updated_at"] = int(time.time())

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._data)

    def clear(self) -> None:
        """清空快照(测试用;生产里没有"重置观测状态"的需求)。

        提供这个而不是让测试直接摸 `_status_lock` / `_status`:后者是封装
        之前的状态,测试依赖它会把"锁与数据必须成对使用"这个约束又漏回测试侧。
        """
        with self._lock:
            self._data.clear()
