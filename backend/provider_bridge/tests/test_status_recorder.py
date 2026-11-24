"""StatusRecorder 的契约(2026-11 全库扫描收敛时补的)。

它替代了 qq_source / netease_source / kuwo_source 各自手写的
`_status_lock` + `_status` 两份全局量。这条测试锁住三件收敛时必须保真的事:
  ① snapshot() 返回副本 —— 调用方改它不会污染内部状态;
  ② reset_each_record 的"每次请求重置"语义(netease 的 rate_limited 依赖它);
  ③ 并发 record/snapshot 不炸(锁真的生效)。
"""

from __future__ import annotations

import threading
import unittest

from provider_bridge.status_recorder import StatusRecorder


class StatusRecorderTest(unittest.TestCase):
    def test_record_merges_and_stamps_updated_at(self):
        recorder = StatusRecorder()
        recorder.record(stage="search", count=3)
        snap = recorder.snapshot()
        self.assertEqual(snap["stage"], "search")
        self.assertEqual(snap["count"], 3)
        self.assertIn("updated_at", snap)
        self.assertIsInstance(snap["updated_at"], int)

    def test_snapshot_returns_isolated_copy(self):
        recorder = StatusRecorder()
        recorder.record(stage="search")
        first = recorder.snapshot()
        first["stage"] = "被外部改坏了"
        first["injected"] = True

        second = recorder.snapshot()
        self.assertEqual(second["stage"], "search", "内部状态被 snapshot 的返回值篡改")
        self.assertNotIn("injected", second)

    def test_reset_each_record_rewrites_field(self):
        """netease 的 rate_limited 语义:每次请求都要显式重写。

        只 update 不重置的话,一旦撞过一次 405 就永久显示 rate_limited=True,
        后面明明搜成功 /health 还在报限流 —— 巡检会被假信号带偏。
        """
        recorder = StatusRecorder(reset_each_record={"rate_limited": False})

        recorder.record(rate_limited=True)
        self.assertIs(recorder.snapshot()["rate_limited"], True)

        # 下一次请求没提 rate_limited → 应被重置为 False
        recorder.record(stage="search")
        self.assertIs(recorder.snapshot()["rate_limited"], False)

        # 显式传值时以调用方为准
        recorder.record(rate_limited=True)
        self.assertIs(recorder.snapshot()["rate_limited"], True)

    def test_clear_empties_snapshot(self):
        recorder = StatusRecorder()
        recorder.record(stage="search")
        recorder.clear()
        self.assertEqual(recorder.snapshot(), {})

    def test_concurrent_record_and_snapshot_is_safe(self):
        """并发写读不炸、且每次 snapshot 都是自洽的字典副本。"""
        recorder = StatusRecorder()
        errors = []

        def writer(n):
            try:
                for i in range(200):
                    recorder.record(stage="w%d" % n, seq=i)
            except Exception as exc:  # noqa: BLE001 - 测试里要把任何异常都记下来
                errors.append(exc)

        def reader():
            try:
                for _ in range(200):
                    snap = recorder.snapshot()
                    # snapshot 必须是 dict 且值可读(锁保护下不会读到半写入状态)
                    self.assertIsInstance(snap, dict)
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [threading.Thread(target=writer, args=(i,)) for i in range(4)]
        threads += [threading.Thread(target=reader) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(errors, [], "并发 record/snapshot 抛异常: %r" % (errors[:3],))


if __name__ == "__main__":
    unittest.main()
