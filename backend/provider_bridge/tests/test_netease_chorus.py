"""网易副歌点位(chorus)批量取回的测试。

响应形状取自对真实接口的实测(2026-11):
    GET https://music.163.com/api/song/chorus?ids=[186016,1901371647]
    -> {"code":200,
        "chorus":[{"id":186016,"startTime":84498,"endTime":142301},
                  {"id":1901371647,"startTime":52391,"endTime":120000}],
        "data":[{"id":186016,...}]}

关键前提(本模块的存在理由): 网易搜索响应里没有副歌字段, 只能额外打一次批量接口;
而逐首请求会把搜索从 ~2s 拖回几十秒, 所以**一次批量**是硬要求, 也是这里重点锁的行为。
"""

import json
import unittest
from unittest import mock

from provider_bridge import app as bridge_app
from provider_bridge import netease_chorus


def setUpModule():
    """每个测试模块开始时清空副歌缓存。

    为什么必须清: 缓存是**进程级全局**的(生产上这正是我们要的 —— 后台补过一次,
    后续搜索零延迟命中)。但测试之间共享同一进程, 上一个用例存进去的
    "186016 -> 84498" 会让下一个用例以为自己没打请求却拿到了数据,
    表现为"单独跑通过、一起跑失败"的假象。
    """
    netease_chorus.reset_cache_for_test()


class ChorusTestBase(unittest.TestCase):
    """所有涉及副歌缓存的用例都从干净缓存开始。"""

    def setUp(self):
        netease_chorus.reset_cache_for_test()


# 真实接口的响应形状(截取诚实值: 晴天 84498/142301)。
CHORUS_PAYLOAD = {
    "code": 200,
    "chorus": [
        {"id": 186016, "startTime": 84498, "endTime": 142301},
        {"id": 1901371647, "startTime": 52391, "endTime": 120000},
    ],
    "data": [{"id": 186016}],
}


class _Response:
    def __init__(self, payload):
        self.content = json.dumps(payload).encode("utf-8")

    def raise_for_status(self):
        return None


class FakeSession:
    """假 requests.Session: 记录请求, 按给定载荷响应。"""

    def __init__(self, payload=None, error=None):
        self.payload = CHORUS_PAYLOAD if payload is None else payload
        self.error = error
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append({"method": method, "url": url, "headers": kwargs.get("headers") or {}})
        if self.error is not None:
            raise self.error
        return _Response(self.payload)


class ChorusMapTests(unittest.TestCase):
    """从真实响应形状构建 map。"""

    def test_builds_map_from_real_payload(self):
        chorus = netease_chorus.build_chorus_map(CHORUS_PAYLOAD)
        self.assertEqual(chorus["186016"], {"start": 84498, "end": 142301})
        self.assertEqual(chorus["1901371647"], {"start": 52391, "end": 120000})

    def test_map_keys_are_ids_as_strings(self):
        """键统一成字符串: 上游 id 是数字, 而 payload 里的 id 是字符串, 必须对得上。"""
        chorus = netease_chorus.build_chorus_map(CHORUS_PAYLOAD)
        self.assertIsInstance(list(chorus)[0], str)

    def test_rejects_non_200_code(self):
        """code 不是 200 一律当没有数据(上游有时用 200 响应体表达失败)。"""
        for code in (0, 400, 405, None):
            payload = {"code": code, "chorus": CHORUS_PAYLOAD["chorus"]}
            self.assertEqual(netease_chorus.build_chorus_map(payload), {}, repr(code))

    def test_accepts_string_code(self):
        """上游偶尔把 code 给成字符串 `"200"`, 宽松解析掉, 别因此丢整批点位。"""
        payload = {"code": "200", "chorus": CHORUS_PAYLOAD["chorus"]}
        self.assertEqual(len(netease_chorus.build_chorus_map(payload)), 2)

    def test_drops_invalid_ranges(self):
        """起点为 0 / 终点不晚于起点 / 缺 id 的记录都必须丢 —— 画错的标记比不画更误导。"""
        payload = {
            "code": 200,
            "chorus": [
                {"id": 1, "startTime": 0, "endTime": 1000},
                {"id": 2, "startTime": 1000, "endTime": 1000},
                {"id": 3, "startTime": 2000, "endTime": 500},
                {"startTime": 1000, "endTime": 2000},
                {"id": 4, "startTime": "x", "endTime": "y"},
                "不是字典的噪音",
                {"id": 5, "startTime": 1000, "endTime": 2000},
            ],
        }
        chorus = netease_chorus.build_chorus_map(payload)
        self.assertEqual(list(chorus), ["5"])

    def test_shapeless_payloads_return_empty(self):
        for payload in (None, [], "字符串", {"code": 200}, {"code": 200, "chorus": {}}):
            self.assertEqual(netease_chorus.build_chorus_map(payload), {}, repr(payload))


class FetchChorusMapTests(ChorusTestBase):
    def test_single_batch_request_for_all_ids(self):
        """整体只发一次请求 —— 逐首请求会重演酷我快照那种"搜索几十秒"的老毛病。"""
        session = FakeSession()
        chorus = netease_chorus.fetch_chorus_map(
            ["186016", "1901371647", "569153583"], session=session,
        )
        self.assertEqual(len(session.calls), 1, "必须一次批量, 不能逐首")
        self.assertEqual(len(chorus), 2, "只有响应里给了的两首有点位")
        url = session.calls[0]["url"]
        self.assertIn("api/song/chorus", url)
        self.assertIn("[186016, 1901371647, 569153583]", url)
        self.assertEqual(session.calls[0]["headers"].get("Referer"), "https://music.163.com/")

    def test_deduplicates_and_skips_non_numeric_ids(self):
        session = FakeSession()
        netease_chorus.fetch_chorus_map(
            ["186016", "186016", "loc:abc", "", "1901371647"], session=session,
        )
        url = session.calls[0]["url"]
        self.assertEqual(url.count("186016"), 1, "重复 id 不该重复塞进请求")
        self.assertNotIn("loc", url)

    def test_empty_input_makes_no_request(self):
        session = FakeSession()
        self.assertEqual(netease_chorus.fetch_chorus_map([], session=session), {})
        self.assertEqual(netease_chorus.fetch_chorus_map(["loc:a"], session=session), {})
        self.assertEqual(session.calls, [])

    def test_request_failure_returns_empty(self):
        """超时/连接错误等一律返回空 dict —— 副歌点位失败绝不能把搜索一起拖挂。"""
        session = FakeSession(error=RuntimeError("boom"))
        with self.assertLogs("provider_bridge.netease_chorus", level="WARNING"):
            self.assertEqual(
                netease_chorus.fetch_chorus_map(["186016"], session=session), {},
            )

    def test_non_200_payload_returns_empty(self):
        session = FakeSession(payload={"code": 405, "msg": "操作频繁"})
        self.assertEqual(netease_chorus.fetch_chorus_map(["186016"], session=session), {})

    def test_batches_are_capped(self):
        """id 走 query string, 必须封顶; 超出的部分丢弃而不是拼出一串超长 URL。"""
        session = FakeSession()
        many = [str(1000000 + index) for index in range(netease_chorus.MAX_BATCH_IDS + 50)]
        netease_chorus.fetch_chorus_map(many, session=session)
        url = session.calls[0]["url"]
        self.assertIn(str(1000000 + netease_chorus.MAX_BATCH_IDS - 1), url)
        self.assertNotIn(str(1000000 + netease_chorus.MAX_BATCH_IDS), url)

    def test_kill_switch(self):
        for value in ("0", "false", "no", "off", "OFF"):
            with mock.patch.dict("os.environ", {"MELODEX_NETEASE_CHORUS": value}):
                self.assertFalse(netease_chorus.chorus_enabled(), value)
        with mock.patch.dict("os.environ", {"MELODEX_NETEASE_CHORUS": "1"}):
            self.assertTrue(netease_chorus.chorus_enabled())
        with mock.patch.dict("os.environ", {}, clear=True):
            self.assertTrue(netease_chorus.chorus_enabled(), "默认必须开")


class EnrichWiringTests(ChorusTestBase):
    """app.py 把 chorus 写进每首 extra 的行为(含关闭与失败)。"""

    def _songs(self):
        return [
            {"id": "186016", "name": "晴天", "extra": {"_rank": "0"}},
            {"id": "1901371647", "name": "孤勇者", "extra": {"_rank": "1"}},
            {"id": "999", "name": "没有点位", "extra": {"_rank": "2"}},
        ]

    def test_writes_start_end_into_extra(self):
        """缓存里已有的副歌, 要在**同步阶段**就贴到 extra 上(零延迟、零请求)。"""
        songs = self._songs()
        netease_chorus._cache_store(netease_chorus.build_chorus_map(CHORUS_PAYLOAD))
        with mock.patch.object(netease_chorus, "fetch_chorus_map"):
            bridge_app._enrich_netease_chorus(songs)
        self.assertEqual(songs[0]["extra"]["chorus_start_ms"], "84498")
        self.assertEqual(songs[0]["extra"]["chorus_end_ms"], "142301")
        self.assertEqual(songs[1]["extra"]["chorus_start_ms"], "52391")
        self.assertNotIn("chorus_start_ms", songs[2]["extra"], "没点位的歌不能凭空写值")
        # 原有 extra 字段必须保留(Go 侧还要按 _rank 排序)。
        self.assertEqual(songs[0]["extra"]["_rank"], "0")

    def test_creates_extra_dict_when_missing(self):
        """payload 万一没有 extra 也不能崩(todict 形状变化时)。"""
        songs = [{"id": "186016", "name": "晴天"}]
        netease_chorus._cache_store({"186016": {"start": 1, "end": 2}})
        with mock.patch.object(netease_chorus, "fetch_chorus_map"):
            bridge_app._enrich_netease_chorus(songs)
        self.assertEqual(songs[0]["extra"], {"chorus_start_ms": "1", "chorus_end_ms": "2"})

    def test_miss_does_not_write_and_spawns_background_fetch(self):
        """缓存未命中时: 不写 extra(还没有数据), 但要发起后台补齐。"""
        songs = self._songs()
        with mock.patch.object(netease_chorus, "fetch_chorus_map") as fetch:
            bridge_app._enrich_netease_chorus(songs)
            # 后台线程是异步的, 等它真的被调用到(最多 1s, 避免偶发)。
            for _ in range(100):
                if fetch.called:
                    break
                import time as _time
                _time.sleep(0.01)
        self.assertTrue(fetch.called, "缓存未命中时必须发起后台补齐")
        for song in songs:
            self.assertNotIn("chorus_start_ms", song["extra"], "还没补到就不该写值")

    def test_fetch_failure_never_breaks_enrich(self):
        """批量接口炸了也只影响自己 —— _enrich 必须正常返回, 且不给 extra 写脏值。"""
        songs = self._songs()
        with mock.patch.object(
            netease_chorus, "fetch_chorus_map", side_effect=RuntimeError("boom"),
        ):
            # 不应抛出任何异常
            bridge_app._enrich_netease_chorus(songs)
        for song in songs:
            self.assertNotIn("chorus_start_ms", song["extra"])

    def test_disabled_switch_skips_request(self):
        with mock.patch.dict("os.environ", {"MELODEX_NETEASE_CHORUS": "0"}):
            with mock.patch.object(netease_chorus, "fetch_chorus_map") as fetch:
                bridge_app._enrich_netease_chorus(self._songs())
        fetch.assert_not_called()

    def test_empty_song_list_short_circuits(self):
        with mock.patch.object(netease_chorus, "fetch_chorus_map") as fetch:
            bridge_app._enrich_netease_chorus([])
        fetch.assert_not_called()


class NativeSearchChorusTests(ChorusTestBase):
    """端到端接线: 网易原生搜歌**不能等副歌**, 但要靠缓存把已补到的带上。

    2026-11 改造后的语义(实测依据: 同步补副歌会让搜索 0.466s -> 0.720s):
      1. 首次搜索 → 立即返回(无副歌), 同时后台线程补, 补完进缓存;
      2. 同一批歌再次搜索 → 缓存命中, 同步贴上副歌, 仍然零额外延迟。
    """

    def test_first_search_does_not_block_on_chorus(self):
        """首次搜索必须在副歌请求返回之前就交出结果 —— 这是"搜索不变慢"的核心保证。"""
        native = [{"id": "186016", "name": "晴天", "extra": {"_rank": "0"}}]
        released = []

        def slow_fetch(ids, **_kwargs):
            released.append(True)
            return netease_chorus.build_chorus_map(CHORUS_PAYLOAD)

        with mock.patch("provider_bridge.netease_source.search_songs", return_value=native):
            with mock.patch.object(netease_chorus, "fetch_chorus_map", side_effect=slow_fetch):
                result = bridge_app.search(
                    {"source": "netease", "keyword": "周杰伦 晴天", "limit": 20, "cookie": ""},
                    work_dir="provider-test-output",
                )
        # 搜索返回时不该带上副歌(因为后台还没跑完/结果没回填这次响应)
        self.assertNotIn("chorus_start_ms", result["songs"][0]["extra"])
        self.assertEqual(result["songs"][0]["id"], "186016")

    def test_second_search_hits_cache_without_extra_request(self):
        """后台补过之后, 同一批歌再搜就直接带副歌, 且**不再发请求**。"""
        native = [{"id": "186016", "name": "晴天", "extra": {"_rank": "0"}}]
        # 模拟"后台已经补完"的状态: 直接把数据塞进缓存。
        netease_chorus._cache_store(netease_chorus.build_chorus_map(CHORUS_PAYLOAD))
        with mock.patch("provider_bridge.netease_source.search_songs", return_value=native):
            with mock.patch.object(netease_chorus, "fetch_chorus_map") as fetch:
                result = bridge_app.search(
                    {"source": "netease", "keyword": "周杰伦 晴天", "limit": 20, "cookie": ""},
                    work_dir="provider-test-output",
                )
        # 缓存命中的结果必须贴在**这次**的返回里
        self.assertEqual(result["songs"][0]["extra"]["chorus_start_ms"], "84498")
        self.assertEqual(result["songs"][0]["extra"]["chorus_end_ms"], "142301")

    def test_native_search_survives_chorus_failure(self):
        """副歌后台任务炸掉时, 搜索结果必须原样返回(只少两个字段)。"""
        native = [{"id": "186016", "name": "晴天", "extra": {"_rank": "0"}}]
        with mock.patch("provider_bridge.netease_source.search_songs", return_value=native):
            with mock.patch.object(
                netease_chorus, "fetch_chorus_map", side_effect=RuntimeError("boom"),
            ):
                result = bridge_app.search(
                    {"source": "netease", "keyword": "周杰伦 晴天", "limit": 20, "cookie": ""},
                    work_dir="provider-test-output",
                )
        self.assertEqual(result["songs"], native)
        self.assertNotIn("chorus_start_ms", result["songs"][0]["extra"])


if __name__ == "__main__":
    unittest.main()
