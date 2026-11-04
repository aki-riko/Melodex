"""`chorus_lookup`(按身份补副歌)的测试。

重点锁三件事, 它们都是用户"并发别加高"硬约束的直接体现:
  1. 网易走**一次**批量请求, 绝不逐首;
  2. 网易已缓存的歌**不再发请求**(先吃 `cached_chorus_for`);
  3. 酷我**串行 + 每批最多 MAX_KUWO_LOOKUPS 首**, 且首次失败即停。
"""

import unittest
from unittest import mock

from provider_bridge import chorus_lookup, kuwo_source, netease_chorus


def _netease_point(start=84498, end=142301):
    return {"start": start, "end": end}


class NeteaseChorusTests(unittest.TestCase):
    """网易: 一次批量 + 缓存优先。"""

    def setUp(self):
        netease_chorus.reset_cache_for_test()

    def tearDown(self):
        netease_chorus.reset_cache_for_test()

    def test_single_batch_request_for_many_ids(self):
        """整批 id 只发一次请求 —— 逐首会把列表刷新放大成上百次往返。"""
        with mock.patch.object(
            netease_chorus, "fetch_chorus_map", return_value={"186016": _netease_point()},
        ) as fetch:
            result = chorus_lookup.chorus({
                "source": "netease", "ids": ["186016", "185811", "1901371647"],
            })
        self.assertEqual(fetch.call_count, 1)
        called_ids = fetch.call_args.args[0]
        self.assertEqual(len(called_ids), 3)
        self.assertEqual(result["chorus"]["186016"], _netease_point())

    def test_cached_ids_are_not_requested_again(self):
        """已在缓存里的 id 不再进请求批次(部分命中时也要拆分)。"""
        # 先用真实接口形状塞一条进进程内缓存。
        netease_chorus._cache_store({"186016": _netease_point()})
        with mock.patch.object(
            netease_chorus, "fetch_chorus_map", return_value={"185811": _netease_point(1, 2)},
        ) as fetch:
            result = chorus_lookup.chorus({
                "source": "netease", "ids": ["186016", "185811"],
            })
        self.assertEqual(fetch.call_count, 1)
        pending = fetch.call_args.args[0]
        self.assertNotIn("186016", pending, "已缓存的歌不应进入上游请求")
        self.assertIn("185811", pending)
        self.assertEqual(result["chorus"]["186016"], _netease_point())
        self.assertEqual(result["chorus"]["185811"], _netease_point(1, 2))

    def test_all_cached_means_zero_upstream_requests(self):
        """全部命中时一个请求都不该发。"""
        netease_chorus._cache_store({"186016": _netease_point()})
        with mock.patch.object(netease_chorus, "fetch_chorus_map") as fetch:
            result = chorus_lookup.chorus({"source": "netease", "ids": ["186016"]})
        fetch.assert_not_called()
        self.assertEqual(result["chorus"]["186016"], _netease_point())

    def test_upstream_failure_degrades_to_empty(self):
        """上游异常只降级为空 map, 绝不抛给调用方。"""
        with mock.patch.object(netease_chorus, "fetch_chorus_map", side_effect=RuntimeError("boom")):
            result = chorus_lookup.chorus({"source": "netease", "ids": ["186016"]})
        self.assertEqual(result, {"chorus": {}})

    def test_switch_off_means_no_request(self):
        """MELODEX_NETEASE_CHORUS=0 时连请求都不该发。"""
        with mock.patch.dict("os.environ", {"MELODEX_NETEASE_CHORUS": "0"}), \
                mock.patch.object(netease_chorus, "fetch_chorus_map") as fetch:
            result = chorus_lookup.chorus({"source": "netease", "ids": ["186016"]})
        fetch.assert_not_called()
        self.assertEqual(result, {"chorus": {}})

    def test_batch_is_capped(self):
        """超过上限的 id 被截断, 不让单次请求规模失控。"""
        ids = [str(1000000 + index) for index in range(chorus_lookup.MAX_NETEASE_BATCH_IDS + 20)]
        with mock.patch.object(netease_chorus, "fetch_chorus_map", return_value={}) as fetch:
            chorus_lookup.chorus({"source": "netease", "ids": ids})
        self.assertEqual(
            len(fetch.call_args.args[0]), chorus_lookup.MAX_NETEASE_BATCH_IDS,
        )


class KuwoChorusTests(unittest.TestCase):
    """酷我: 串行 + 严格上限 + 失败即停。"""

    def _song(self, song_id, start=84346, end=142843):
        return {
            "id": song_id,
            "extra": {"chorus_start_ms": str(start), "chorus_end_ms": str(end)},
        }

    def test_lookups_are_capped(self):
        """超过 MAX_KUWO_LOOKUPS 的 id 根本不查 —— 这是保护上游的闸门。"""
        ids = [str(228900 + index) for index in range(12)]
        hints = {song_id: f"歌{song_id} 歌手" for song_id in ids}
        with mock.patch.object(kuwo_source, "search", return_value=[]) as search:
            chorus_lookup.chorus({
                "source": "kuwo", "ids": ids, "kuwo_hints": hints,
            })
        self.assertEqual(search.call_count, chorus_lookup.MAX_KUWO_LOOKUPS)

    def test_lookups_are_sequential(self):
        """必须串行: 任何时刻只能有 1 个反查在跑。"""
        ids = ["228901", "228902", "228903"]
        hints = {song_id: f"歌{song_id} 歌手" for song_id in ids}
        concurrent = {"current": 0, "peak": 0}

        def fake_search(keyword, limit=20, *, cookie="", session=None):
            concurrent["current"] += 1
            concurrent["peak"] = max(concurrent["peak"], concurrent["current"])
            concurrent["current"] -= 1
            return []

        with mock.patch.object(kuwo_source, "search", side_effect=fake_search):
            chorus_lookup.chorus({"source": "kuwo", "ids": ids, "kuwo_hints": hints})
        self.assertEqual(concurrent["peak"], 1, "酷我反查必须串行")

    def test_failure_stops_the_batch(self):
        """首次失败即停: 不把"上游抖了一下"放大成持续施压。"""
        ids = ["228901", "228902", "228903"]
        hints = {song_id: f"歌{song_id} 歌手" for song_id in ids}
        with mock.patch.object(kuwo_source, "search", side_effect=RuntimeError("boom")) as search:
            result = chorus_lookup.chorus({"source": "kuwo", "ids": ids, "kuwo_hints": hints})
        self.assertEqual(search.call_count, 1)
        self.assertEqual(result, {"chorus": {}})

    def test_matches_by_id_not_first_hit(self):
        """必须按 id 精确匹配, 不能取第一条(否则会把翻唱/伴奏的点位标错)。"""
        with mock.patch.object(
            kuwo_source, "search",
            return_value=[self._song("999999", 1, 2), self._song("228908")],
        ):
            result = chorus_lookup.chorus({
                "source": "kuwo", "ids": ["228908"],
                "kuwo_hints": {"228908": "晴天 周杰伦"},
            })
        self.assertEqual(result["chorus"]["228908"], {"start": 84346, "end": 142843})

    def test_no_hint_means_no_lookup(self):
        """拿不到歌名/歌手就不查(rid 不是搜索词)。"""
        with mock.patch.object(kuwo_source, "search") as search:
            chorus_lookup.chorus({"source": "kuwo", "ids": ["228908"]})
        search.assert_not_called()

    def test_keyword_limit_is_small(self):
        """反查只取很少候选: 要的是精确命中, 不需要整页。"""
        with mock.patch.object(kuwo_source, "search", return_value=[]) as search:
            chorus_lookup.chorus({
                "source": "kuwo", "ids": ["228908"],
                "kuwo_hints": {"228908": "晴天 周杰伦"},
            })
        self.assertEqual(search.call_args.kwargs.get("limit"), chorus_lookup.MAX_KUWO_KEYWORD_LIMIT)


class SourceRoutingTests(unittest.TestCase):
    """不支持副歌的源必须一个请求都不发。"""

    def test_qq_is_skipped_entirely(self):
        """QQ 没有任何可用接口(500003), 连试都不试。"""
        with mock.patch.object(netease_chorus, "fetch_chorus_map") as netease_fetch, \
                mock.patch.object(kuwo_source, "search") as kuwo_search:
            result = chorus_lookup.chorus({"source": "qq", "ids": ["003abc"]})
        netease_fetch.assert_not_called()
        kuwo_search.assert_not_called()
        self.assertEqual(result, {"chorus": {}})

    def test_unknown_source_is_skipped(self):
        """其他源(soda/kugou/migu/qianqian)一律跳过。"""
        for source in ("soda", "kugou", "migu", "qianqian"):
            self.assertEqual(
                chorus_lookup.chorus({"source": source, "ids": ["1"]}), {"chorus": {}},
            )

    def test_missing_source_is_an_error(self):
        """缺 source 是调用方的编程错误, 应该明确报出来。"""
        with self.assertRaises(ValueError):
            chorus_lookup.chorus({"ids": ["1"]})

    def test_empty_ids_make_no_request(self):
        with mock.patch.object(netease_chorus, "fetch_chorus_map") as fetch:
            self.assertEqual(chorus_lookup.chorus({"source": "netease", "ids": []}), {"chorus": {}})
        fetch.assert_not_called()


class ValidationTests(unittest.TestCase):
    """点位必须是真值, 脏数据不能流出。"""

    def test_invalid_netease_points_are_dropped(self):
        """起点<=0 或终点<=起点 一律丢弃(脏标记比不标记更误导)。"""
        payload = {
            "code": 200,
            "chorus": [
                {"id": 1, "startTime": 0, "endTime": 100},
                {"id": 2, "startTime": 500, "endTime": 100},
                {"id": 3, "startTime": 100, "endTime": 200},
            ],
        }
        self.assertEqual(list(netease_chorus.build_chorus_map(payload).keys()), ["3"])

    def test_kuwo_invalid_points_are_dropped(self):
        bad = {"id": "228908", "extra": {"chorus_start_ms": "0", "chorus_end_ms": "100"}}
        with mock.patch.object(kuwo_source, "search", return_value=[bad]):
            result = chorus_lookup.chorus({
                "source": "kuwo", "ids": ["228908"], "kuwo_hints": {"228908": "x y"},
            })
        self.assertEqual(result, {"chorus": {}})


if __name__ == "__main__":
    unittest.main()
