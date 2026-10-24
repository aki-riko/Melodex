"""网易歌词片段搜索(原生实现)的测试。

这里用到的响应形状都来自对真实接口的实测:
    /api/cloudsearch/pc           -> {"result":{"songs":[{"id","name","duration",
        "artists","album","dt","fee","alias","lyrics"}]}}
        实测搜「都 是勇敢的」第 1 名就是 孤勇者/陈奕迅原唱(而 type=1 全是同名垃圾)。
        注意: 关键字搜索用的是 cloudsearch(pc), 不是旧的 /api/search/get/web ——
        后者现已对几乎所有调用方限流(code=405 操作频繁), 见 SEARCH_URL 上的注释。
    /api/song/detail?ids=[...]      -> {"songs":[{"album":{"picUrl"},"duration"}]}
    eapi/song/enhance/player/url/v1 -> 请求最高档返回**实际**档位(level=exhigh + 320k mp3
        + size); 付费曲(fee=1)匿名 url 为空。
"""

import ast
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
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
LYRIC_PAYLOAD = {
    "code": 200,
    "lrc": {"lyric": "[00:01.00]第一句\n[00:03.50]第二句"},
}
PAID_URL_PAYLOAD = {"code": 200, "data": [{"id": 1901371647, "url": None, "size": 0, "br": 0, "fee": 1}]}

# 超会账号请求 hires 时接口给到的 Hi-Res FLAC(实测真值是 96kHz/24bit 的 flac, br~1607000)。
HIRES_URL_PAYLOAD = {
    "code": 200,
    "data": [{"id": 569153583, "url": "https://m801.music.126.net/x/北京残阳-hires.flac",
              "size": 41389442, "br": 1607000, "type": "flac", "level": "hires", "fee": 0}],
}
# 请求 hires 但该账号只有 CD 无损权限: 接口返回实际档位 lossless(带真地址)。
LOSSLESS_URL_PAYLOAD = {
    "code": 200,
    "data": [{"id": 569153583, "url": "https://m801.music.126.net/x/北京残阳-lossless.flac",
              "size": 32123456, "br": 999000, "type": "flac", "level": "lossless", "fee": 0}],
}
# 空 data(部分曲目/凭证异常时上游会这么回)。
EMPTY_URL_PAYLOAD = {"code": 200, "data": []}


class FakeSession:
    """假的 requests.Session: 按 URL 返回预制响应, 并记录请求。

    player/url 的响应可以按档位给(`level_urls`), 不传则退回按歌曲(`urls`)给 ——
    后者是"无论请求哪一档都返回同一份"的历史写法, 用于不关心档位的用例。
    """

    def __init__(self, *, detail=..., urls=None, level_urls=None, detail_error=False,
                 url_error=False, lyric=None, search=None):
        self.detail = DETAIL_PAYLOAD if detail is ... else detail
        self.urls = urls or {}
        self.level_urls = level_urls or {}
        self.detail_error = detail_error
        self.url_error = url_error
        self.lyric = LYRIC_PAYLOAD if lyric is None else lyric
        self.search = SEARCH_PAYLOAD if search is None else search
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append({"method": method, "url": url, "headers": kwargs.get("headers") or {},
                           "data": kwargs.get("data") or {}})
        if "api/cloudsearch/pc" in url:
            return _Response(self.search)
        if "api/song/detail" in url:
            if self.detail_error:
                raise RuntimeError("detail boom")
            return _Response(self.detail)
        if "api/song/lyric/v1" in url:
            return _Response(self.lyric)
        if "player/url/v1" in url:
            if self.url_error:
                raise RuntimeError("eapi boom")
            song_id, level = _song_id_and_level_from_params(kwargs.get("data") or {})
            if (song_id, level) in self.level_urls:
                return _Response(self.level_urls[(song_id, level)])
            return _Response(self.urls.get(song_id, PAID_URL_PAYLOAD))
        raise AssertionError(f"unexpected url {url}")

    def requested_levels(self):
        """本次会话实际请求过的 (song_id, level) 序列, 按请求顺序。"""
        return [
            _song_id_and_level_from_params(call["data"])
            for call in self.calls
            if "player/url/v1" in call["url"]
        ]


class _Response:
    def __init__(self, payload):
        self.content = json.dumps(payload).encode("utf-8")

    def raise_for_status(self):
        return None


def _song_id_and_level_from_params(data):
    """测试里把 _eapi_params 打桩成 'id=<数字>|level=<档位>', 这里解析回来。"""
    raw = str((data or {}).get("params") or "")
    song_id, _, level = raw.partition("|level=")
    song_id = song_id.split("=", 1)[1] if song_id.startswith("id=") else ""
    return song_id, level


def patch_eapi_params():
    """打桩 eapi 加密(避免测试依赖快照的 AES 依赖)。"""
    return mock.patch.object(
        netease_source, "_eapi_params",
        side_effect=lambda sid, level=None: f"id={sid}|level={level or netease_source.request_level()}",
    )


class DefaultLevelTestCase(unittest.TestCase):
    """断言"默认档位"的用例: 清掉外部环境变量, 避免跑测试的机器上真配了这个 env。"""

    def setUp(self):
        patcher = mock.patch.dict("os.environ", {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop(netease_source.REQUEST_LEVEL_ENV, None)


class LyricMatchTests(unittest.TestCase):
    def test_fetches_line_lyric_by_song_id(self):
        session = FakeSession()
        lyric = netease_source.fetch_lyric(
            "2110700883", cookie="MUSIC_U=test", session=session
        )
        self.assertEqual(lyric, LYRIC_PAYLOAD["lrc"]["lyric"])
        call = next(call for call in session.calls if "api/song/lyric/v1" in call["url"])
        self.assertEqual(call["data"]["id"], "2110700883")
        self.assertIn("MUSIC_U=test", call["headers"]["Cookie"])

    def test_requests_lyric_search_type(self):
        session = FakeSession()
        with patch_eapi_params():
            matches = netease_source.lyric_matches(netease_source.PlatformHTTP("", session), "都 是勇敢的", 6)
        call = session.calls[0]
        self.assertIn("api/cloudsearch/pc", call["url"])
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


class RequestLevelConfigTests(DefaultLevelTestCase):
    """请求档位可配: 默认 hires(不再是封顶的 lossless), 非法/空值回退默认。"""

    def test_default_level_is_hires(self):
        self.assertEqual(netease_source.request_level(), "hires")
        self.assertEqual(
            netease_source.request_levels(), ["hires", "lossless", "exhigh"],
            "默认回退链必须是 hires → lossless → exhigh(最多 3 次)",
        )

    def test_env_override_takes_effect(self):
        for level in ("jymaster", "dolby", "sky", "jyeffect", "hires"):
            with mock.patch.dict("os.environ", {netease_source.REQUEST_LEVEL_ENV: level}):
                self.assertEqual(netease_source.request_level(), level)

    def test_invalid_or_empty_env_falls_back_to_default(self):
        for raw in ("", "   ", "not-a-level", "flac", "320k", "HIRES-NOT", "hires,lossless"):
            with mock.patch.dict("os.environ", {netease_source.REQUEST_LEVEL_ENV: raw}):
                self.assertEqual(
                    netease_source.request_level(), "hires",
                    f"非法值 {raw!r} 必须回退默认 hires, 不能把非法档位发给上游",
                )

    def test_env_value_is_case_and_space_insensitive(self):
        with mock.patch.dict("os.environ", {netease_source.REQUEST_LEVEL_ENV: "  HiRes  "}):
            self.assertEqual(netease_source.request_level(), "hires")

    def test_lower_configured_level_never_steps_back_up(self):
        """配置比 lossless 更低(如 exhigh)时不许"回退"到更高的档位。"""
        with mock.patch.dict("os.environ", {netease_source.REQUEST_LEVEL_ENV: "exhigh"}):
            self.assertEqual(netease_source.request_levels(), ["exhigh"])
        with mock.patch.dict("os.environ", {netease_source.REQUEST_LEVEL_ENV: "standard"}):
            self.assertEqual(netease_source.request_levels(), ["standard"])

    def test_ladder_matches_pinned_snapshot(self):
        """档位阶梯必须与固定快照 neteaseutils.py:22 一致(只读取快照, 不改动它)。

        这里刻意不 import musicdl: 单测环境不必装齐快照的加密依赖(生产镜像里有),
        直接读源文件里的 MUSIC_QUALITIES 常量即可锁定"阶梯没抄错/没漂移"。
        """
        snapshot = (
            Path(__file__).resolve().parents[2]
            / "third_party" / "charles-musicdl" / "musicdl" / "modules" / "utils" / "neteaseutils.py"
        )
        source = snapshot.read_text(encoding="utf-8")
        match = re.search(r"^MUSIC_QUALITIES\s*=\s*(\[[^\]]*\])", source, re.MULTILINE)
        self.assertIsNotNone(match, f"快照里找不到 MUSIC_QUALITIES: {snapshot}")
        self.assertEqual(
            list(netease_source.NETEASE_QUALITY_LADDER), ast.literal_eval(match.group(1))
        )


class RequestLevelFallbackTests(DefaultLevelTestCase):
    """回退链: 首档无 url 才依次尝试 lossless → exhigh, 任一拿到地址立即停止。"""

    def test_default_request_asks_for_hires(self):
        session = FakeSession(level_urls={("569153583", "hires"): HIRES_URL_PAYLOAD})
        with patch_eapi_params():
            item = netease_source.resolve_play_url("569153583", "", session)
        self.assertEqual(session.requested_levels(), [("569153583", "hires")],
                         "超会账号首档就该拿到 Hi-Res, 只打一次请求")
        self.assertEqual(item["level"], "hires")
        self.assertEqual(item["br"], 1607000)
        self.assertEqual(netease_source._extension(item["url"], item), "flac")

    def test_hires_missing_falls_back_to_lossless(self):
        session = FakeSession(level_urls={
            ("569153583", "hires"): PAID_URL_PAYLOAD,
            ("569153583", "lossless"): LOSSLESS_URL_PAYLOAD,
        })
        with patch_eapi_params():
            with self.assertLogs("provider_bridge.netease_source", level="INFO") as captured:
                item = netease_source.resolve_play_url("569153583", "", session)
        self.assertEqual(
            session.requested_levels(),
            [("569153583", "hires"), ("569153583", "lossless")],
            "lossless 拿到地址必须立即停止, 不能再打 exhigh",
        )
        self.assertEqual(item["level"], "lossless")
        self.assertEqual(item["url"], LOSSLESS_URL_PAYLOAD["data"][0]["url"])
        logged = "\n".join(captured.output)
        self.assertIn("音质回退", logged, "回退必须留一条日志便于巡检")
        self.assertIn("hires", logged)
        self.assertIn("lossless", logged, "日志必须标明最终档位")

    def test_hires_and_lossless_missing_falls_back_to_exhigh(self):
        session = FakeSession(level_urls={
            ("569153583", "hires"): EMPTY_URL_PAYLOAD,
            ("569153583", "lossless"): PAID_URL_PAYLOAD,
            ("569153583", "exhigh"): URL_PAYLOAD,
        })
        with patch_eapi_params():
            with self.assertLogs("provider_bridge.netease_source", level="INFO"):
                item = netease_source.resolve_play_url("569153583", "", session)
        self.assertEqual(
            [level for _sid, level in session.requested_levels()],
            ["hires", "lossless", "exhigh"],
            "最多 3 次请求, 不许退化成快照的 8 档阶梯",
        )
        self.assertEqual(item["level"], "exhigh")

    def test_all_levels_missing_returns_empty(self):
        session = FakeSession()
        with patch_eapi_params():
            self.assertEqual(netease_source.resolve_play_url("1901371647", "", session), {})
        self.assertEqual(
            [level for _sid, level in session.requested_levels()],
            ["hires", "lossless", "exhigh"],
            "全部档位都无 url 时也只试 3 档",
        )

    def test_all_levels_missing_marks_song_invalid(self):
        """取不到地址照旧 is_invalid, 前端验活会隐藏 —— 失败语义不能变。"""
        session = FakeSession()
        with patch_eapi_params():
            payloads = netease_source.search_songs("周杰伦 晴天", 6, cookie="", session=session)
        self.assertEqual([p["id"] for p in payloads], ["1901371647", "569153583"])
        self.assertTrue(all(p["is_invalid"] for p in payloads))
        self.assertTrue(all(p["url"] == "" for p in payloads))

    def test_env_override_changes_actual_requested_level(self):
        session = FakeSession(level_urls={("569153583", "jymaster"): HIRES_URL_PAYLOAD})
        with mock.patch.dict("os.environ", {netease_source.REQUEST_LEVEL_ENV: "jymaster"}):
            with patch_eapi_params():
                item = netease_source.resolve_play_url("569153583", "", session)
        self.assertEqual(session.requested_levels()[0], ("569153583", "jymaster"),
                         "env 覆盖必须真的改变发给上游的档位")
        self.assertTrue(item)

    def test_transport_error_does_not_multiply_requests(self):
        """传输异常不是"这一档没货": 不许把一次上游故障放大成 3 次请求(与改动前一致)。"""
        session = FakeSession(url_error=True)
        with patch_eapi_params():
            with self.assertLogs("provider_bridge.netease_source", level="WARNING") as captured:
                self.assertEqual(netease_source.resolve_play_url("569153583", "", session), {})
        self.assertEqual(
            session.requested_levels(), [("569153583", "hires")],
            "请求异常时直接放弃, 不回退",
        )
        self.assertEqual(len(captured.output), 1, "一次失败只该有一条日志, 不能刷三条")

    def test_no_fallback_log_when_first_level_succeeds(self):
        session = FakeSession(level_urls={("569153583", "hires"): HIRES_URL_PAYLOAD})
        with patch_eapi_params():
            with self.assertNoLogs("provider_bridge.netease_source", level="INFO"):
                netease_source.resolve_play_url("569153583", "", session)


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

    def test_search_does_not_prefetch_verbatim_lyrics(self):
        """搜索不再为每首候选预取逐字歌词(实测 +0.5s/次), 改由 play 时按 id 懒取。"""
        native = [{"id": "1", "name": "孤勇者", "source": "netease", "extra": {}}]
        with mock.patch.object(netease_source, "search_by_lyric", return_value=native):
            with mock.patch.object(
                bridge_app.netease_lyric, "fetch_verbatim_lyric", return_value="[00:01.000]都"
            ) as fetch:
                with tempfile.TemporaryDirectory() as work_dir:
                    result = bridge_app.search(
                        {"source": "netease", "keyword": "都 是勇敢的", "limit": 8,
                         "search_type": 7, "cookie": ""},
                        work_dir=work_dir,
                    )
        fetch.assert_not_called()
        self.assertNotIn("lyric", result["songs"][0]["extra"])

    def test_lyric_endpoint_prefers_verbatim_then_falls_back(self):
        """懒加载必须保住逐字能力: 有 YRC 就给逐字, 没有才退回行级。"""
        with mock.patch.object(
            bridge_app.netease_lyric, "fetch_verbatim_lyric", return_value="[00:01.000]都[00:01.500]是"
        ) as verbatim:
            with mock.patch.object(bridge_app.netease_source, "fetch_lyric") as line:
                result = bridge_app.lyric({"source": "netease", "id": "1901371647", "cookie": ""})
        self.assertEqual(result["lyric"], "[00:01.000]都[00:01.500]是")
        verbatim.assert_called_once()
        line.assert_not_called()

    def test_lyric_endpoint_falls_back_to_line_level(self):
        with mock.patch.object(bridge_app.netease_lyric, "fetch_verbatim_lyric", return_value=""):
            with mock.patch.object(
                bridge_app.netease_source, "fetch_lyric", return_value="[00:01.00]行级"
            ):
                result = bridge_app.lyric({"source": "netease", "id": "1", "cookie": ""})
        self.assertEqual(result["lyric"], "[00:01.00]行级")


class NativeSongSearchTests(DefaultLevelTestCase):
    """原生普通搜歌(type=1): 存在的理由就是快照实现太慢(limit=20 实测 131.7s)。"""

    def test_uses_song_search_type_and_one_request_per_playable_song(self):
        session = FakeSession(urls={"569153583": URL_PAYLOAD})
        with patch_eapi_params():
            payloads = netease_source.search_songs("周杰伦 晴天", 6, cookie="", session=session)
        search_calls = [c for c in session.calls if "api/cloudsearch/pc" in c["url"]]
        self.assertEqual(len(search_calls), 1)
        self.assertEqual(search_calls[0]["data"]["type"], 1, "普通搜歌必须用 type=1")
        # 能拿到地址的歌只请求 1 次(首档); 拿不到地址的付费曲才会走满 3 档。
        self.assertEqual(
            session.requested_levels(),
            [("1901371647", "hires"), ("1901371647", "lossless"), ("1901371647", "exhigh"),
             ("569153583", "hires")],
            "常规路径只 1 次请求, 无地址才按 lossless→exhigh 回退(每首最多 3 次)",
        )
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


# 实测旧端点 /api/search/get/web 被限流时的完整响应(没有 result 字段)。
RATE_LIMIT_PAYLOAD = {"code": 405, "msg": "操作频繁，请稍候再试", "message": "操作频繁，请稍候再试"}

# cloudsearch(pc) 的真实形状: 时长字段叫 dt(毫秒), 歌手/专辑在 ar/al 里。
CLOUDSEARCH_PAYLOAD = {
    "code": 200,
    "result": {
        "songCount": 2,
        "songs": [
            {
                "id": 233888, "name": "爱情讯息", "dt": 280680, "fee": 1,
                "ar": [{"id": 6452, "name": "郭静"}],
                "al": {"id": 23492, "name": "下一个天亮", "picUrl": "https://p1.music.126.net/x/cover.jpg"},
            },
            {"id": 0, "name": "没有 id 的噪音"},
        ],
    },
}


class RateLimitTests(unittest.TestCase):
    """限流必须显式抛出, 不能被吞成"没有这首歌"。

    现场事故(2026-10): 旧搜索端点开始对 NAS 出口 IP 限流, search_songs 静默返回 [],
    于是播放时按歌名回查 → Go 侧 "provider returned no matching songs" →
    /music/playback_segment 502 → 前端 MSE 重试 6 次后提示「连续播放缓冲异常」。
    真实原因(限流)在整个链路里完全不可见。
    """

    def test_search_raises_on_rate_limit_instead_of_returning_empty(self):
        session = FakeSession(search=RATE_LIMIT_PAYLOAD)
        with self.assertLogs("provider_bridge.netease_source", level="WARNING") as captured:
            with self.assertRaises(netease_source.NeteaseRateLimited):
                netease_source.search_songs("爱情讯息 郭静", 20, session=session)
        self.assertIn("限流", "\n".join(captured.output))

    def test_rate_limit_status_is_recorded_for_health(self):
        session = FakeSession(search=RATE_LIMIT_PAYLOAD)
        with self.assertRaises(netease_source.NeteaseRateLimited):
            netease_source.search_songs("爱情讯息 郭静", 20, session=session)
        snapshot = netease_source.status()
        self.assertTrue(snapshot.get("rate_limited"))
        self.assertEqual(snapshot.get("empty_reason"), "rate_limited")
        self.assertEqual(snapshot.get("keyword"), "爱情讯息 郭静")

    def test_genuine_no_match_is_not_reported_as_rate_limited(self):
        session = FakeSession(search={"code": 200, "result": {"songs": []}})
        self.assertEqual(netease_source.search_songs("不存在的歌", 20, session=session), [])
        snapshot = netease_source.status()
        self.assertFalse(snapshot.get("rate_limited", False))
        self.assertEqual(snapshot.get("empty_reason"), "no_match")

    def test_lyric_search_also_raises_on_rate_limit(self):
        session = FakeSession(search=RATE_LIMIT_PAYLOAD)
        with self.assertRaises(netease_source.NeteaseRateLimited):
            netease_source.search_by_lyric("都 是勇敢的", 6, session=session)


class CloudsearchPayloadShapeTests(unittest.TestCase):
    """cloudsearch 用 dt/ar/al, 旧实现只认 duration/artists/album —— 换端点后必须都认。"""

    def test_reads_dt_ar_al_shape(self):
        raw = CLOUDSEARCH_PAYLOAD["result"]["songs"][0]
        item = netease_source.build_payload(raw, {}, {}, 0)
        self.assertEqual(item["id"], "233888")
        self.assertEqual(item["name"], "爱情讯息")
        self.assertEqual(item["artist"], "郭静", "cloudsearch 的歌手字段是 ar")
        self.assertEqual(item["album"], "下一个天亮", "cloudsearch 的专辑字段是 al")
        self.assertEqual(item["cover"], "https://p1.music.126.net/x/cover.jpg")
        self.assertEqual(item["duration"], 280, "cloudsearch 的时长字段是 dt(毫秒), 必须换算成秒")

    def test_matches_are_filtered_from_cloudsearch_shape(self):
        session = FakeSession(search=CLOUDSEARCH_PAYLOAD)
        with patch_eapi_params():
            matches = netease_source.song_matches(netease_source.PlatformHTTP("", session), "爱情讯息 郭静", 20)
        self.assertEqual([m["id"] for m in matches], [233888])


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

    def test_unplayable_native_results_never_fall_back_to_snapshot(self):
        """拿不到地址也**不许**退回快照。

        实测 林俊杰 江南 在无会员 cookie 时可播率 0.40, 早先"可播率低于 0.5 就回退"的设计把它
        从 1s 变成 132.0s; 而 is_invalid 的歌前端验活本来就会隐藏, 直接返回原生结果又快又一致。
        """
        dead = [{"id": "1", "name": "江南", "source": "netease", "extra": {}, "is_invalid": True}]
        with mock.patch.object(netease_source, "search_songs", return_value=dead):
            with mock.patch.object(bridge_app.netease_lyric, "fetch_verbatim_lyric", return_value=""):
                with tempfile.TemporaryDirectory() as work_dir:
                    # 注意不要传 client_factory: 传了就绕过原生分支, 测不到这条路径。
                    result = bridge_app.search(
                        {"source": "netease", "keyword": "林俊杰 江南", "limit": 5, "cookie": ""},
                        work_dir=work_dir,
                    )
        self.assertEqual(result["songs"], dead, "必须直接返回原生结果, 不能回退到快照")

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

    def test_rate_limit_surfaces_as_error_not_empty_result(self):
        """限流必须在 app.search 层变成可上报的错误, 不能变成 songs: []。"""
        with mock.patch.object(
            netease_source, "search_songs",
            side_effect=netease_source.NeteaseRateLimited("操作频繁"),
        ):
            with tempfile.TemporaryDirectory() as work_dir:
                with self.assertRaises(ValueError) as caught:
                    bridge_app.search(
                        {"source": "netease", "keyword": "爱情讯息", "limit": 5, "cookie": ""},
                        work_dir=work_dir,
                    )
        self.assertIn("rate limited", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
