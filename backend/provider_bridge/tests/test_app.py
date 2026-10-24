import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from provider_bridge import app
from provider_bridge.app import search, song_to_payload


class FakeSong:
    def todict(self):
        return {
            "identifier": "0039MnYb0qxYhV",
            "song_name": "晴天",
            "singers": "周杰伦",
            "album": "叶惠美",
            "duration_s": 269,
            "file_size_bytes": 12345678,
            "bitrate": 320,
            "ext": "flac",
            "cover_url": "https://example.invalid/cover.jpg",
            "download_url": "https://example.invalid/audio.flac",
            "download_url_status": {"ok": True},
            "default_download_headers": {"Referer": "https://y.qq.com/"},
            "raw_data": {"play_auth": "soda-auth"},
            "lyric": "[00:00.00]晴天",
        }


class FakeClient:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

    def search(self, keyword):
        if keyword != "周杰伦 晴天":
            raise AssertionError(keyword)
        return [FakeSong()]


class FailingClient:
    def __init__(self, **kwargs):
        pass

    def search(self, keyword):
        # 复现线上 apple 的真实报错(Apple 的 JWT 头变成 eyJ0 开头, 快照写死的 (?=eyJh) 匹配不到)
        raise AttributeError("'NoneType' object has no attribute 'group'")


class ConstructorFailingClient:
    """复现 apple 的真实情况: 快照在 __init__ 里就访问上游并抛异常。"""

    def __init__(self, **kwargs):
        raise AttributeError("'NoneType' object has no attribute 'group'")

    def search(self, keyword):  # pragma: no cover - 构造阶段就失败了
        return []


class ProviderBridgeTests(unittest.TestCase):
    def test_search_logs_failure_raised_during_client_construction(self):
        """构造阶段的失败也必须被记录 —— apple 就是死在 __init__ 的 _fetchtoken 上。"""
        with tempfile.TemporaryDirectory() as work_dir:
            with self.assertLogs("provider_bridge.app", level="WARNING") as captured:
                with self.assertRaises(AttributeError):
                    search(
                        {"source": "apple", "keyword": "晴天", "limit": 5, "cookie": ""},
                        client_factory=ConstructorFailingClient,
                        work_dir=work_dir,
                    )
        joined = "\n".join(captured.output)
        self.assertIn("apple", joined)
        self.assertIn("NoneType", joined)
        self.assertIn("eyJ0", joined)
        self.assertIn("AudioPrev", joined)

    def test_search_logs_source_failure_with_hint(self):
        """上游失效时必须留下"哪个源、为什么", 而不是只有一句 Python 异常名。"""
        with tempfile.TemporaryDirectory() as work_dir:
            with self.assertLogs("provider_bridge.app", level="WARNING") as captured:
                with self.assertRaises(AttributeError):
                    search(
                        {"source": "apple", "keyword": "晴天", "limit": 5, "cookie": ""},
                        client_factory=FailingClient,
                        work_dir=work_dir,
                    )
        joined = "\n".join(captured.output)
        self.assertIn("apple", joined)
        self.assertIn("晴天", joined)
        self.assertIn("NoneType", joined)
        # apple 的已知根因必须出现在日志里。
        self.assertIn("eyJ0", joined)
        self.assertIn("AudioPrev", joined)

    def test_search_does_not_swallow_unknown_source_failure(self):
        """未知源的失败也要照原样抛出(调用方仍按 502 处理), 只是多了一条带源名的日志。"""
        with tempfile.TemporaryDirectory() as work_dir:
            with self.assertLogs("provider_bridge.app", level="WARNING"):
                with self.assertRaises(AttributeError):
                    search(
                        {"source": "kugou", "keyword": "晴天", "limit": 5, "cookie": ""},
                        client_factory=FailingClient,
                        work_dir=work_dir,
                    )

    def test_song_mapping_preserves_playback_fields(self):
        song = song_to_payload(FakeSong(), "qq", 0)
        self.assertEqual(song["id"], "0039MnYb0qxYhV")
        self.assertEqual(song["duration"], 269)
        self.assertEqual(song["ext"], "flac")
        self.assertEqual(song["extra"]["has_lossless"], "1")
        self.assertIn("Referer", song["extra"]["download_headers"])
        self.assertEqual(song["extra"]["play_auth"], "soda-auth")

    def test_search_uses_whitelisted_source(self):
        with tempfile.TemporaryDirectory() as work_dir:
            result = search(
                {"source": "qq", "keyword": "周杰伦 晴天", "limit": 5, "cookie": "uin=1"},
                client_factory=FakeClient,
                work_dir=work_dir,
            )
            self.assertEqual(list(Path(work_dir).iterdir()), [])
        self.assertEqual(len(result["songs"]), 1)
        self.assertEqual(result["songs"][0]["source"], "qq")

    def test_search_rejects_unknown_source(self):
        with self.assertRaisesRegex(ValueError, "unsupported source"):
            search(
                {"source": "unknown", "keyword": "test"},
                client_factory=FakeClient,
                work_dir="provider-test-output",
            )


if __name__ == "__main__":
    unittest.main()


class SingleFlightTests(unittest.TestCase):
    """并发等价搜索只打一次上游。

    现场事故(2026-10): 前端搜索会并发发 type=song / lyric / album 三个请求, song 和
    lyric 的源集合重叠(qq/netease), 于是同一关键词在上游被查了 3 遍 —— 搜「亲爱的，
    热爱的」时 3 秒内 QQ 被搜 3 次(3.47s/4.19s/0.95s), 用户端到端 5s。
    """

    def test_concurrent_equivalent_searches_share_one_upstream_call(self):
        calls = []
        release = threading.Event()

        def slow_impl(payload, *, client_factory=None, work_dir):
            calls.append(payload["keyword"])
            release.wait(timeout=5)
            return {"songs": [{"id": "1", "name": "x"}]}

        payload = {"source": "qq", "keyword": "亲爱的，热爱的", "limit": 20, "search_type": 0}
        results = []

        def worker():
            results.append(app.search(dict(payload), work_dir="/tmp"))

        with mock.patch.object(app, "_search_impl", side_effect=slow_impl):
            threads = [threading.Thread(target=worker) for _ in range(3)]
            for thread in threads:
                thread.start()
            deadline = time.time() + 3
            while len(calls) < 1 and time.time() < deadline:
                time.sleep(0.01)
            time.sleep(0.15)
            release.set()
            for thread in threads:
                thread.join(timeout=5)

        self.assertEqual(len(calls), 1, "3 个并发等价请求只应打一次上游")
        self.assertEqual(len(results), 3, "所有等待者都必须拿到结果")
        for result in results:
            self.assertEqual(result["songs"][0]["id"], "1")

    def test_sequential_searches_are_not_cached(self):
        """合并只作用于"同一时刻重叠"的请求, 不能退化成搜索缓存。"""
        calls = []

        def impl(payload, *, client_factory=None, work_dir):
            calls.append(1)
            return {"songs": []}

        payload = {"source": "qq", "keyword": "晴天", "limit": 20, "search_type": 0}
        with mock.patch.object(app, "_search_impl", side_effect=impl):
            app.search(dict(payload), work_dir="/tmp")
            app.search(dict(payload), work_dir="/tmp")
        self.assertEqual(len(calls), 2, "先后两次搜索必须各打一次上游")

    def test_different_search_type_is_not_merged(self):
        calls = []

        def impl(payload, *, client_factory=None, work_dir):
            calls.append(payload["search_type"])
            return {"songs": []}

        with mock.patch.object(app, "_search_impl", side_effect=impl):
            app.search({"source": "qq", "keyword": "晴天", "limit": 20, "search_type": 0}, work_dir="/tmp")
            app.search({"source": "qq", "keyword": "晴天", "limit": 20, "search_type": 7}, work_dir="/tmp")
        self.assertEqual(sorted(calls), [0, 7], "不同 search_type 是不同请求, 不能合并")

    def test_error_propagates_to_waiters(self):
        release = threading.Event()
        attempts = []

        def failing(payload, *, client_factory=None, work_dir):
            attempts.append(1)
            release.wait(timeout=5)
            raise ValueError("upstream boom")

        errors = []

        def worker():
            try:
                app.search({"source": "qq", "keyword": "晴天", "limit": 20, "search_type": 0},
                           work_dir="/tmp")
            except ValueError as error:
                errors.append(str(error))

        with mock.patch.object(app, "_search_impl", side_effect=failing):
            threads = [threading.Thread(target=worker) for _ in range(3)]
            for thread in threads:
                thread.start()
            time.sleep(0.2)
            release.set()
            for thread in threads:
                thread.join(timeout=5)

        self.assertEqual(len(attempts), 1, "失败也只打一次上游")
        self.assertEqual(errors, ["upstream boom"] * 3, "错误必须传播给所有等待者")

    def test_injected_client_factory_bypasses_merge(self):
        """测试注入 factory 时不合并, 否则不同用例会互相串结果。"""
        calls = []

        class FakeClient:
            def __init__(self, **kwargs):
                pass

            def search(self, keyword):
                calls.append(keyword)
                return []

        with tempfile.TemporaryDirectory() as work_dir:
            for _ in range(2):
                app.search({"source": "qq", "keyword": "晴天", "limit": 5, "cookie": ""},
                           client_factory=FakeClient, work_dir=work_dir)
        self.assertEqual(len(calls), 2, "带 client_factory 的调用不参与合并")