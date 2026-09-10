"""网易歌词片段搜索(原生实现)的测试。

这里用到的响应形状都来自对真实接口的实测:
    /api/search/get/web  type=1006  -> {"result":{"songs":[{"id","name","artists",
        "album","duration","fee","alias","lyrics"}]}}
        实测搜「都 是勇敢的」第 1 名就是 孤勇者/陈奕迅原唱(而 type=1 全是同名垃圾)。
    /api/song/detail?ids=[...]      -> {"songs":[{"album":{"picUrl"},"duration"}]}
    eapi/song/enhance/player/url/v1 -> 请求最高档返回**实际**档位(level=exhigh + 320k mp3
        + size); 付费曲(fee=1)匿名 url 为空。
"""

import json
import os
import tempfile
import unittest
from unittest import mock

from provider_bridge import app as bridge_app
from provider_bridge import netease_source


SEARCH_PAYLOAD = {
    "code": 200,
    "result": {
        "songCount": 60,
        "songs": [
            {
                "id": 1901371647, "name": "孤勇者", "duration": 256000, "fee": 1,
                "artists": [{"id": 2116, "name": "陈奕迅"}],
                "album": {"id": 137142551, "name": "孤勇者"},
            },
            {
                "id": 569153583, "name": "北京残阳(In time Remix)", "duration": 265000, "fee": 0,
                "artists": [{"id": 1, "name": "辉子"}, {"id": 2, "name": "较劲白佳"}],
                "album": {"id": 99, "name": "北京残阳"},
            },
            {"id": 0, "name": "没有 id 的噪音"},
            "不是字典的噪音",
        ],
    },
}

DETAIL_PAYLOAD = {
    "code": 200,
    "songs": [
        {"id": 1901371647, "duration": 256000,
         "album": {"id": 137142551, "name": "孤勇者",
                   "picUrl": "https://p2.music.126.net/HXfXIIBCk5w96MiY1Wdsqw==/109951171836610847.jpg"}},
        {"id": 569153583, "duration": 265000, "album": {"id": 99, "name": "北京残阳", "picUrl": ""}},
    ],
}

# 与实测一致: 请求 lossless 拿到 exhigh/320k mp3 + 真实 size。
URL_PAYLOAD = {
    "code": 200,
    "data": [{"id": 569153583, "url": "https://m801.music.126.net/x/北京残阳.mp3",
              "size": 10627701, "br": 320000, "type": "mp3", "level": "exhigh", "fee": 0}],
}
PAID_URL_PAYLOAD = {"code": 200, "data": [{"id": 1901371647, "url": None, "size": 0, "br": 0, "fee": 1}]}


class FakeSession:
    """假的 requests.Session: 按 URL 返回预制响应, 并记录请求。"""

    def __init__(self, *, detail=..., urls=None, detail_error=False, url_error=False):
        self.detail = DETAIL_PAYLOAD if detail is ... else detail
        self.urls = urls or {}
        self.detail_error = detail_error
        self.url_error = url_error
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append({"method": method, "url": url, "headers": kwargs.get("headers") or {},
                           "data": kwargs.get("data") or {}})
        if "api/search/get/web" in url:
            return _Response(SEARCH_PAYLOAD)
        if "api/song/detail" in url:
            if self.detail_error:
                raise RuntimeError("detail boom")
            return _Response(self.detail)
        if "player/url/v1" in url:
            if self.url_error:
                raise RuntimeError("eapi boom")
            song_id = _song_id_from_params(kwargs.get("data") or {})
            return _Response(self.urls.get(song_id, PAID_URL_PAYLOAD))
        raise AssertionError(f"unexpected url {url}")


class _Response:
    def __init__(self, payload):
        self.content = json.dumps(payload).encode("utf-8")

    def raise_for_status(self):
        return None


def _song_id_from_params(data):
    """测试里把 _eapi_params 打桩成 'id=<数字>', 这里解析回来。"""
    raw = str((data or {}).get("params") or "")
    return raw.split("=", 1)[1] if raw.startswith("id=") else ""


def patch_eapi_params():
    return mock.patch.object(netease_source, "_eapi_params", side_effect=lambda sid: f"id={sid}")


class LyricMatchTests(unittest.TestCase):
    def test_requests_lyric_search_type(self):
        session = FakeSession()
        with patch_eapi_params():
            matches = netease_source.lyric_matches(netease_source.PlatformHTTP("", session), "都 是勇敢的", 6)
        call = session.calls[0]
        self.assertIn("api/search/get/web", call["url"])
        self.assertEqual(call["data"]["type"], 1006, "必须用歌词检索 type=1006, 不是歌名搜索")
        self.assertEqual(call["data"]["s"], "都 是勇敢的")
        self.assertEqual([m["id"] for m in matches], [1901371647, 569153583], "无 id / 非字典的条目必须丢弃")

    def test_details_are_batched_in_one_request(self):
        session = FakeSession()
        details = netease_source.song_details(netease_source.PlatformHTTP("", session), ["1901371647", "569153583"])
        self.assertEqual(len([c for c in session.calls if "song/detail" in c["url"]]), 1)
        self.assertIn("[1901371647, 569153583]", session.calls[0]["url"], "实测可用的形式是整数数组")
        self.assertEqual(details["1901371647"]["album"]["picUrl"],
                         "https://p2.music.126.net/HXfXIIBCk5w96MiY1Wdsqw==/109951171836610847.jpg")

    def test_details_failure_is_not_fatal(self):
        session = FakeSession(detail_error=True)
        self.assertEqual(netease_source.song_details(netease_source.PlatformHTTP("", session), ["1"]), {})


class CookiesTests(unittest.TestCase):
    def test_merges_device_and_account_cookies(self):
        header = netease_source._cookies_for("MUSIC_U=abc; __csrf=def")
        self.assertIn("deviceId=pyncm!", header, "eapi 要求的设备 cookie 不能丢")
        self.assertIn("os=pc", header)
        self.assertIn("MUSIC_U=abc", header)
        self.assertIn("__csrf=def", header)

    def test_device_cookies_only_without_account(self):
        header = netease_source._cookies_for("")
        self.assertIn("deviceId=pyncm!", header)
        self.assertNotIn("MUSIC_U", header)


class ResolveUrlTests(unittest.TestCase):
    def test_returns_empty_when_no_url(self):
        session = FakeSession()
        with patch_eapi_params():
            self.assertEqual(netease_source.resolve_play_url("1901371647", "", session), {})

    def test_returns_resolution_when_url_present(self):
        session = FakeSession(urls={"569153583": URL_PAYLOAD})
        with patch_eapi_params():
            item = netease_source.resolve_play_url("569153583", "", session)
        self.assertEqual(item["size"], 10627701)
        self.assertEqual(item["level"], "exhigh")

    def test_cookie_header_reaches_eapi(self):
        session = FakeSession(urls={"569153583": URL_PAYLOAD})
        with patch_eapi_params():
            netease_source.resolve_play_url("569153583", "MUSIC_U=secret; __csrf=x", session)
        headers = session.calls[0]["headers"]
        self.assertIn("MUSIC_U=secret", headers["Cookie"])
        self.assertIn("deviceId=pyncm!", headers["Cookie"])

    def test_encryption_failure_returns_empty(self):
        with mock.patch.object(netease_source, "_eapi_params", side_effect=RuntimeError("no musicdl")):
            with self.assertLogs("provider_bridge.netease_source", level="WARNING"):
                self.assertEqual(netease_source.resolve_play_url("1", ""), {})


class PayloadTests(unittest.TestCase):
    def test_builds_snapshot_shaped_payload(self):
        raw = SEARCH_PAYLOAD["result"]["songs"][1]
        detail = DETAIL_PAYLOAD["songs"][1]
        item = netease_source.build_payload(raw, detail, URL_PAYLOAD["data"][0], 2)
        self.assertEqual(item["id"], "569153583")
        self.assertEqual(item["name"], "北京残阳(In time Remix)")
        self.assertEqual(item["artist"], "辉子, 较劲白佳")
        self.assertEqual(item["album"], "北京残阳")
        self.assertEqual(item["duration"], 265, "duration 必须是秒(快照 payload 同口径)")
        self.assertEqual(item["size"], 10627701)
        self.assertEqual(item["bitrate"], 320)
        self.assertEqual(item["ext"], "mp3")
        self.assertEqual(item["source"], "netease")
        self.assertFalse(item["is_invalid"])
        self.assertEqual(item["extra"]["_rank"], "2")
        self.assertNotIn("has_lossless", item["extra"])

    def test_lossless_extension_is_flagged(self):
        raw = SEARCH_PAYLOAD["result"]["songs"][1]
        resolution = {"url": "https://m8.music.126.net/x/y.flac", "size": 1, "br": 900000, "type": "flac"}
        item = netease_source.build_payload(raw, {}, resolution, 0)
        self.assertEqual(item["ext"], "flac")
        self.assertEqual(item["extra"]["has_lossless"], "1")

    def test_missing_url_is_invalid_but_kept(self):
        raw = SEARCH_PAYLOAD["result"]["songs"][0]
        item = netease_source.build_payload(raw, DETAIL_PAYLOAD["songs"][0], {}, 0)
        self.assertTrue(item["is_invalid"])
        self.assertEqual(item["url"], "")
        self.assertEqual(item["size"], 0)
        self.assertEqual(item["cover"], "https://p2.music.126.net/HXfXIIBCk5w96MiY1Wdsqw==/109951171836610847.jpg")

    def test_extension_falls_back_to_level_type(self):
        raw = SEARCH_PAYLOAD["result"]["songs"][1]
        item = netease_source.build_payload(raw, {}, {"url": "https://m8.music.126.net/stream", "type": "flac"}, 0)
        self.assertEqual(item["ext"], "flac")


class SearchByLyricTests(unittest.TestCase):
    def _search(self, **kwargs):
        session = FakeSession(**kwargs)
        with patch_eapi_params():
            return netease_source.search_by_lyric("都 是勇敢的", 6, cookie="", session=session), session

    def test_returns_playable_first_and_keeps_order(self):
        payloads, _session = self._search(urls={"569153583": URL_PAYLOAD})
        self.assertEqual([p["id"] for p in payloads], ["1901371647", "569153583"])
        self.assertTrue(payloads[0]["is_invalid"], "付费曲匿名拿不到地址 → 标记不可播(前端验活会隐藏)")
        self.assertFalse(payloads[1]["is_invalid"])

    def test_url_failure_marks_all_invalid(self):
        payloads, _session = self._search(url_error=True)
        self.assertEqual(len(payloads), 2)
        self.assertTrue(all(p["is_invalid"] for p in payloads))

    def test_empty_keyword_short_circuits(self):
        self.assertEqual(netease_source.search_by_lyric("   ", 5), [])

    def test_logs_hit_and_playable_counts(self):
        with self.assertLogs("provider_bridge.netease_source", level="INFO") as captured:
            self._search(urls={"569153583": URL_PAYLOAD})
        joined = "\n".join(captured.output)
        self.assertIn("命中 2 首", joined)
        self.assertIn("取到地址 1 首", joined)


class FakeSong:
    def todict(self):
        return {
            "identifier": "123", "song_name": "普通搜索的歌", "singers": "某人",
            "ext": "mp3", "download_url": "https://example.invalid/a.mp3", "lyric": "",
        }


class FakeClient:
    def __init__(self, **kwargs):
        pass

    def search(self, keyword):
        return [FakeSong()]


class NeteaseLyricSearchWiringTests(unittest.TestCase):
    def test_lyric_type_uses_native_lyric_search(self):
        native = [{"id": "1", "name": "孤勇者", "source": "netease", "extra": {}}]
        with mock.patch.object(netease_source, "search_by_lyric", return_value=native) as search:
            with mock.patch.object(bridge_app.netease_lyric, "fetch_verbatim_lyric", return_value=""):
                with tempfile.TemporaryDirectory() as work_dir:
                    result = bridge_app.search(
                        {"source": "netease", "keyword": "都 是勇敢的", "limit": 8,
                         "search_type": 7, "cookie": "MUSIC_U=x"},
                        work_dir=work_dir,
                    )
        self.assertEqual(result["songs"], native)
        search.assert_called_once_with("都 是勇敢的", 8, cookie="MUSIC_U=x")

    def test_normal_song_search_still_uses_snapshot_client(self):
        with mock.patch.object(netease_source, "search_by_lyric") as search:
            with mock.patch.object(bridge_app.netease_lyric, "fetch_verbatim_lyric", return_value=""):
                with tempfile.TemporaryDirectory() as work_dir:
                    result = bridge_app.search(
                        {"source": "netease", "keyword": "晴天", "limit": 5, "search_type": 0, "cookie": ""},
                        client_factory=FakeClient,
                        work_dir=work_dir,
                    )
        search.assert_not_called()
        self.assertEqual(result["songs"][0]["name"], "普通搜索的歌")

    def test_verbatim_lyric_enrichment_still_applies(self):
        native = [{"id": "1", "name": "孤勇者", "source": "netease", "extra": {}}]
        with mock.patch.object(netease_source, "search_by_lyric", return_value=native):
            with mock.patch.object(
                bridge_app.netease_lyric, "fetch_verbatim_lyric", return_value="[00:01.000]都[00:01.500]是"
            ):
                with tempfile.TemporaryDirectory() as work_dir:
                    result = bridge_app.search(
                        {"source": "netease", "keyword": "都 是勇敢的", "limit": 8,
                         "search_type": 7, "cookie": ""},
                        work_dir=work_dir,
                    )
        extra = result["songs"][0]["extra"]
        self.assertEqual(extra["lyric"], "[00:01.000]都[00:01.500]是")
        self.assertEqual(extra["lyric_verbatim"], "1")


class NativeSongSearchTests(unittest.TestCase):
    """原生普通搜歌(type=1): 存在的理由就是快照实现太慢(limit=20 实测 131.7s)。"""

    def test_uses_song_search_type_and_resolves_once_per_song(self):
        session = FakeSession(urls={"569153583": URL_PAYLOAD})
        with patch_eapi_params():
            payloads = netease_source.search_songs("周杰伦 晴天", 6, cookie="", session=session)
        search_calls = [c for c in session.calls if "api/search/get/web" in c["url"]]
        self.assertEqual(len(search_calls), 1)
        self.assertEqual(search_calls[0]["data"]["type"], 1, "普通搜歌必须用 type=1")
        url_calls = [c for c in session.calls if "player/url/v1" in c["url"]]
        self.assertEqual(len(url_calls), 2, "每首歌只打一次地址请求(不做音质阶梯)")
        self.assertEqual([p["id"] for p in payloads], ["1901371647", "569153583"])

    def test_playable_ratio_drives_snapshot_fallback(self):
        session = FakeSession(urls={"569153583": URL_PAYLOAD})
        with patch_eapi_params():
            payloads = netease_source.search_songs("周杰伦 晴天", 6, cookie="", session=session)
        # 付费曲拿不到地址(匿名) -> 可播率 0.5; 有 cookie 时网易会给出无损地址
        self.assertAlmostEqual(netease_source.playable_ratio(payloads), 0.5, places=3)

    def test_playable_ratio_of_empty_is_zero(self):
        self.assertEqual(netease_source.playable_ratio([]), 0.0)

    def test_empty_keyword_short_circuits(self):
        self.assertEqual(netease_source.search_songs("   ", 5), [])

    def test_kill_switch(self):
        with mock.patch.dict("os.environ", {"MELODEX_NETEASE_NATIVE_SEARCH": "0"}):
            self.assertFalse(netease_source.native_search_enabled())
        with mock.patch.dict("os.environ", {}, clear=False):
            self.assertTrue(netease_source.native_search_enabled())


class NativeSearchWiringTests(unittest.TestCase):
    def test_song_search_prefers_native_implementation(self):
        native = [{"id": "1", "name": "晴天", "source": "netease", "extra": {}, "is_invalid": False}]
        with mock.patch.object(netease_source, "search_songs", return_value=native) as search:
            with mock.patch.object(bridge_app.netease_lyric, "fetch_verbatim_lyric", return_value=""):
                with tempfile.TemporaryDirectory() as work_dir:
                    result = bridge_app.search(
                        {"source": "netease", "keyword": "晴天", "limit": 8, "cookie": "MUSIC_U=x"},
                        work_dir=work_dir,
                    )
        self.assertEqual(result["songs"], native)
        search.assert_called_once_with("晴天", 8, cookie="MUSIC_U=x")

    def test_low_playable_ratio_falls_back_to_snapshot(self):
        """凭证失效时网易付费曲整片拿不到地址, 必须退回快照而不是给用户一片不可播。"""
        dead = [{"id": "1", "name": "孤勇者", "source": "netease", "extra": {}, "is_invalid": True}]
        with mock.patch.object(netease_source, "search_songs", return_value=dead):
            with mock.patch.object(bridge_app.netease_lyric, "fetch_verbatim_lyric", return_value=""):
                with tempfile.TemporaryDirectory() as work_dir:
                    result = bridge_app.search(
                        {"source": "netease", "keyword": "孤勇者", "limit": 5, "cookie": ""},
                        client_factory=FakeClient,
                        work_dir=work_dir,
                    )
        self.assertEqual(result["songs"][0]["name"], "普通搜索的歌", "应回退到快照客户端")

    def test_kill_switch_uses_snapshot(self):
        with mock.patch.dict("os.environ", {"MELODEX_NETEASE_NATIVE_SEARCH": "0"}):
            with mock.patch.object(netease_source, "search_songs") as search:
                with mock.patch.object(bridge_app.netease_lyric, "fetch_verbatim_lyric", return_value=""):
                    with tempfile.TemporaryDirectory() as work_dir:
                        result = bridge_app.search(
                            {"source": "netease", "keyword": "晴天", "limit": 5, "cookie": ""},
                            client_factory=FakeClient,
                            work_dir=work_dir,
                        )
        search.assert_not_called()
        self.assertEqual(result["songs"][0]["name"], "普通搜索的歌")


if __name__ == "__main__":
    unittest.main()
