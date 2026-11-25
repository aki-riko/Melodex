"""suggest 模块的单元测试。

重点是**契约**而不是网络可用性：
  · 一源失败必须仍返回另一源的结果（联想是增强项，绝不能因为某个平台抖动就整条挂掉）；
  · 同名词条（song 与 album 同名）必须合并成一条，否则用户看到两条点了发同一个搜索；
  · limit 必须夹取，避免前端传大数把上游打穿；
  · 响应形状固定给 Go 侧。

不发真实网络请求：两个 _xxx_terms 都被替换成桩。
"""

from __future__ import annotations

import unittest
from unittest import mock

from provider_bridge import suggest


class AppendTermTests(unittest.TestCase):
    def test_skips_blank_and_respects_limit(self) -> None:
        terms: list[dict[str, str]] = []
        seen: set[str] = set()
        suggest._append_term(terms, seen, suggest.KIND_SONG, "   ", "", 5)
        suggest._append_term(terms, seen, suggest.KIND_SONG, "晴天", "周杰伦", 5)
        suggest._append_term(terms, seen, suggest.KIND_SONG, "晴天", "别的歌手", 5)
        self.assertEqual(len(terms), 1, "空白丢弃、同名同类型去重")
        self.assertEqual(terms[0], {"kind": "song", "name": "晴天", "detail": "周杰伦"})

    def test_same_name_different_kind_kept_at_source_level(self) -> None:
        """源内保留类型区分：解析层不替聚合层做决定。"""
        terms: list[dict[str, str]] = []
        seen: set[str] = set()
        suggest._append_term(terms, seen, suggest.KIND_SONG, "晴天", "", 5)
        suggest._append_term(terms, seen, suggest.KIND_ALBUM, "晴天", "", 5)
        self.assertEqual(len(terms), 2)


class LimitTests(unittest.TestCase):
    def test_clamp(self) -> None:
        self.assertEqual(suggest._clamp_limit(5), 5)
        self.assertEqual(suggest._clamp_limit(0), suggest.DEFAULT_LIMIT)
        self.assertEqual(suggest._clamp_limit(-3), suggest.DEFAULT_LIMIT)
        self.assertEqual(suggest._clamp_limit("abc"), suggest.DEFAULT_LIMIT)
        self.assertEqual(suggest._clamp_limit(None), suggest.DEFAULT_LIMIT)
        self.assertEqual(suggest._clamp_limit(10_000), suggest.MAX_LIMIT)


class SuggestTests(unittest.TestCase):
    def setUp(self) -> None:
        self._qq_patch = mock.patch.object(suggest, "_qq_terms")
        self._ne_patch = mock.patch.object(suggest, "_netease_terms")
        self.qq = self._qq_patch.start()
        self.netease = self._ne_patch.start()
        self.addCleanup(self._qq_patch.stop)
        self.addCleanup(self._ne_patch.stop)

    def test_merges_sources_and_orders_qq_first(self) -> None:
        self.qq.return_value = [
            {"kind": "song", "name": "晴天", "detail": "周杰伦"},
            {"kind": "album", "name": "晴天", "detail": "周杰伦"},
        ]
        self.netease.return_value = [
            {"kind": "song", "name": "晴天", "detail": "周杰伦"},
            {"kind": "song", "name": "晴天和猫", "detail": "花粥"},
        ]
        result = suggest.suggest({"keyword": "晴天", "limit": 10})
        self.assertEqual(result["sources"], ["qq", "netease"])
        self.assertEqual(result["errors"], {})
        names = [term["name"] for term in result["terms"]]
        self.assertEqual(
            names, ["晴天", "晴天和猫"],
            "同名 song/album 必须合并，跨源同名也合并",
        )
        self.assertEqual(result["terms"][0]["kind"], "song", "保留先出现的那条(song 带歌手)")

    def test_one_source_failure_still_returns_other(self) -> None:
        self.qq.side_effect = RuntimeError("boom")
        self.netease.return_value = [{"kind": "song", "name": "晴天", "detail": "周杰伦"}]
        result = suggest.suggest({"keyword": "晴天", "limit": 5})
        self.assertEqual(result["sources"], ["netease"])
        self.assertIn("qq", result["errors"])
        self.assertEqual(len(result["terms"]), 1)

    def test_all_sources_failure_returns_empty_not_raise(self) -> None:
        self.qq.side_effect = RuntimeError("qq down")
        self.netease.side_effect = RuntimeError("netease down")
        result = suggest.suggest({"keyword": "晴天", "limit": 5})
        self.assertEqual(result["terms"], [])
        self.assertEqual(result["sources"], [])
        self.assertEqual(set(result["errors"]), {"qq", "netease"})

    def test_empty_keyword_short_circuits_without_calling_upstream(self) -> None:
        for keyword in ("", "   ", None):
            result = suggest.suggest({"keyword": keyword})
            self.assertEqual(result, {"terms": [], "sources": [], "errors": {}})
        self.qq.assert_not_called()
        self.netease.assert_not_called()

    def test_limit_caps_total_terms(self) -> None:
        self.qq.return_value = [{"kind": "song", "name": f"歌{i}", "detail": ""} for i in range(10)]
        self.netease.return_value = [{"kind": "song", "name": f"别的{i}", "detail": ""} for i in range(10)]
        result = suggest.suggest({"keyword": "歌", "limit": 3})
        self.assertEqual(len(result["terms"]), 3)

    def test_normalized_key_ignores_case_space_and_punctuation(self) -> None:
        self.assertEqual(
            suggest._normalized_key("晴天 (Live)"), suggest._normalized_key("晴天(Live)"),
        )
        self.assertEqual(suggest._normalized_key("Hello World"), suggest._normalized_key("helloworld"))


if __name__ == "__main__":
    unittest.main()
