"""provider_bridge 的 QQ 原生实现测试。

覆盖的每条断言都对应一个在线探测确认过的 QQ 契约,或一个必须保持的既有行为:
端点必须是 u6.y.qq.com、vkey 必须用 req_1 信封 + g_tk、搜索 comm 必须带 QIMEI36、
过期凭证要自动切换模式、失败不能静默。
"""

import base64
import json
import os
import tempfile
import time
import unittest
from unittest import mock

from provider_bridge import app as bridge_app
from provider_bridge import qq_source


def search_response(items, code=0):
    return {
        f"{qq_source.SEARCH_MODULE}.{qq_source.SEARCH_METHOD}": {
            "code": code,
            "data": {"body": {"item_song": items}},
        }
    }


def vkey_response(purls, code=0):
    return {
        "req_1": {
            "code": code,
            "data": {"midurlinfo": [{"filename": name, "purl": purl} for name, purl in purls]},
        }
    }


def lyric_response(text):
    encoded = base64.b64encode(text.encode("utf-8")).decode("ascii")
    return {"req_1": {"code": 0, "data": {"lyric": encoded}}}


def song_item(mid, title="晴天", artists=("周杰伦",), album_mid="000MkMni19ClKG", file_info=None):
    return {
        "mid": mid,
        "title": title,
        "interval": 269,
        "singer": [{"name": name} for name in artists],
        "album": {"mid": album_mid, "name": "叶惠美"},
        "file": file_info or {"size_128mp3": 4317292, "size_flac": 30000000},
        "pay": {"pay_play": 1, "pay_month": 1},
    }


def cookie_string(uin="3058261811", musickey="MUSICKEY", created_at=None, lifetime=None):
    parts = ["uin=%s" % uin, "qqmusic_uin=%s" % uin, "str_musicid=%s" % uin]
    if musickey:
        parts.append("musickey=%s" % musickey)
    if created_at is not None:
        parts.append("musickeyCreateTime=%d" % created_at)
    if lifetime is not None:
        parts.append("keyExpiresIn=%d" % lifetime)
    return "; ".join(parts)


class FakeBackend:
    """按请求内容应答的假后端,同时记录每次调用用的 cookie 与请求体。"""

    def __init__(self, search_items, purl_by_quality=None, lyrics=None, search_code=0, purl_plan=None):
        self.search_items = search_items
        self.purl_by_quality = purl_by_quality or {}
        self.lyrics = lyrics or {}
        self.search_code = search_code
        # purl_plan: 每次 vkey 调用依次弹出一个 "该次返回哪些 mid 的 purl" 列表;用尽后返回空。
        self.purl_plan = list(purl_plan) if purl_plan is not None else None
        self.calls = []

    def __call__(self, client, payload):
        self.calls.append({"cookie": getattr(client, "cookie", ""), "payload": payload})
        if f"{qq_source.SEARCH_MODULE}.{qq_source.SEARCH_METHOD}" in payload:
            return search_response(self.search_items, self.search_code)
        module = (payload.get("req_1") or {}).get("module")
        if module == qq_source.LYRIC_MODULE:
            mid = (payload["req_1"]["param"] or {}).get("songMID", "")
            text = self.lyrics.get(mid)
            return lyric_response(text) if text else {"req_1": {"code": 0, "data": {}}}
        if module == qq_source.VKEY_MODULE:
            params = payload["req_1"]["param"]
            filenames = params["filename"]
            # filename 与 songmid 一一对应(同一 mid 依次展开各音质档位),直接用请求自带字段配对。
            pairs_in = list(zip(filenames, params["songmid"]))
            wanted = None
            if self.purl_plan is not None:
                wanted = self.purl_plan.pop(0) if self.purl_plan else []
            pairs = []
            for name, mid in pairs_in:
                quality = name[:4]
                if wanted is not None and mid not in wanted:
                    continue
                if quality != self.purl_by_quality.get("quality", "M500"):
                    continue
                if self.purl_by_quality.get("mid") and mid != self.purl_by_quality["mid"]:
                    continue
                pairs.append((name, "%s%s.vkey" % (quality, mid)))
            return vkey_response(pairs)
        raise AssertionError("unexpected payload: %s" % json.dumps(payload)[:200])

    @property
    def vkey_calls(self):
        return [c for c in self.calls if (c["payload"].get("req_1") or {}).get("module") == qq_source.VKEY_MODULE]

    @property
    def lyric_calls(self):
        return [c for c in self.calls if (c["payload"].get("req_1") or {}).get("module") == qq_source.LYRIC_MODULE]


class QQSourceTests(unittest.TestCase):
    def setUp(self):
        self.work_dir = tempfile.mkdtemp(prefix="qq-test-")

    def run_search(self, backend, keyword="晴天", limit=20, cookie="", work_dir=None):
        with mock.patch.object(qq_source, "_post", backend):
            return qq_source.search(keyword, limit, cookie, work_dir=work_dir or self.work_dir)

    # ---- 端点与请求契约 ------------------------------------------------

    def test_endpoint_is_u6_host(self):
        # QQ 已把 vkey 迁到 u6;打 u.y 只会得到 code=1000 且无 purl。
        self.assertEqual(qq_source.QQ_CGI_URL, "https://u6.y.qq.com/cgi-bin/musicu.fcg")

    def test_search_comm_carries_device_id(self):
        backend = FakeBackend([song_item("AAA")], purl_by_quality={"quality": "M500"})
        self.run_search(backend, limit=5)
        search_payload = backend.calls[0]["payload"]
        comm = search_payload["comm"]
        self.assertEqual(len(comm["QIMEI36"]), 36)
        self.assertEqual(comm["ct"], "11")
        self.assertIn("tmeAppID", comm)
        # 搜索这一步不带凭证(实测形状),凭证只在取地址时使用。
        self.assertEqual(backend.calls[0]["cookie"], "")

    def test_vkey_uses_req1_envelope_and_gtk(self):
        cookie = cookie_string(created_at=int(time.time()), lifetime=259200)
        backend = FakeBackend([song_item("AAA")], purl_by_quality={"quality": "M500"})
        self.run_search(backend, cookie=cookie, limit=5)
        vkey_payload = backend.vkey_calls[0]["payload"]
        request = vkey_payload["req_1"]
        self.assertEqual(request["module"], qq_source.VKEY_MODULE)
        self.assertEqual(request["method"], qq_source.VKEY_METHOD)
        comm = vkey_payload["comm"]
        self.assertEqual(comm["g_tk"], qq_source._hash33("MUSICKEY", 5381))
        self.assertEqual(comm["g_tk_new_20200303"], comm["g_tk"])
        self.assertEqual(comm["qq"], "3058261811")
        self.assertEqual(comm["authst"], "MUSICKEY")
        self.assertEqual(request["param"]["loginflag"], 1)
        self.assertEqual(request["param"]["platform"], "20")
        self.assertEqual(backend.vkey_calls[0]["cookie"], cookie)

    def test_vkey_batches_whole_ladder_in_one_request(self):
        items = [song_item("AAA"), song_item("BBB")]
        backend = FakeBackend(items, purl_by_quality={"quality": "M500"})
        songs = self.run_search(backend, limit=5)
        self.assertEqual(len(backend.vkey_calls), 1)
        params = backend.vkey_calls[0]["payload"]["req_1"]["param"]
        filenames = params["filename"]
        self.assertEqual(len(filenames), 2 * len(qq_source.QUALITY_LADDER))
        self.assertEqual(len(params["songmid"]), len(filenames))
        self.assertEqual(sorted(set(params["songmid"])), ["AAA", "BBB"])
        for mid in ("AAA", "BBB"):
            tiers = [name[:4] for name, song in zip(filenames, params["songmid"]) if song == mid]
            self.assertEqual(
                sorted(tiers),
                sorted(code for code, _ext, _size, _nominal in qq_source.QUALITY_LADDER),
            )
        self.assertEqual(len(songs), 2)

    # ---- 结果映射 ------------------------------------------------------

    def test_payload_mapping(self):
        items = [song_item("AAA")]
        backend = FakeBackend(items, purl_by_quality={"quality": "M500"})
        songs = self.run_search(backend, limit=5)
        song = songs[0]
        self.assertEqual(song["id"], "AAA")
        self.assertEqual(song["name"], "晴天")
        self.assertEqual(song["artist"], "周杰伦")
        self.assertEqual(song["album"], "叶惠美")
        self.assertEqual(song["duration"], 269)
        self.assertEqual(song["source"], "qq")
        self.assertEqual(song["ext"], "mp3")
        self.assertEqual(song["size"], 4317292)
        self.assertGreater(song["bitrate"], 0)
        self.assertTrue(song["url"].startswith(qq_source.MEDIA_BASE))
        self.assertEqual(song["cover"], qq_source.COVER_BASE.format("000MkMni19ClKG"))
        self.assertFalse(song["is_invalid"])
        self.assertEqual(song["extra"]["_rank"], "0")
        self.assertEqual(song["extra"]["provider"], "melodex-native")
        self.assertEqual(song["extra"]["provider_lookup"], "晴天 周杰伦")
        self.assertIn("Referer", json.loads(song["extra"]["download_headers"]))
        self.assertNotIn("has_lossless", song["extra"])

    def test_best_returned_quality_wins(self):
        items = [song_item("AAA")]
        backend = FakeBackend(items, purl_by_quality={"quality": "M500"})

        def post_with_two_tiers(client, payload):
            backend.calls.append({"cookie": getattr(client, "cookie", ""), "payload": payload})
            if f"{qq_source.SEARCH_MODULE}.{qq_source.SEARCH_METHOD}" in payload:
                return search_response(items)
            filenames = payload["req_1"]["param"]["filename"]
            pairs = [
                (name, "f000.vkey") for name in filenames if name.startswith("F000")
            ] + [
                (name, "m500.vkey") for name in filenames if name.startswith("M500")
            ]
            return vkey_response(pairs)

        with mock.patch.object(qq_source, "_post", post_with_two_tiers):
            songs = qq_source.search("晴天", 5, "", work_dir=self.work_dir)
        self.assertEqual(songs[0]["ext"], "flac")
        self.assertEqual(songs[0]["size"], 30000000)
        self.assertEqual(songs[0]["extra"]["has_lossless"], "1")

    def test_missing_size_key_falls_back_to_nominal_bitrate(self):
        # QQ 的 file 子对象里没有 size_640ogg, 所以 O801 档只能给出标称码率, 体积留 0 由验活补齐。
        items = [song_item("AAA")]
        backend = FakeBackend(items, purl_by_quality={"quality": "O801"})
        songs = self.run_search(backend, limit=5)
        self.assertEqual(songs[0]["ext"], "ogg")
        self.assertEqual(songs[0]["size"], 0)
        self.assertEqual(songs[0]["bitrate"], 640)

    def test_size_key_uses_qq_real_field_names(self):
        # 实测 file 子对象的键名:有 size_flac/size_hires/size_dolby, 无 size_640ogg。
        keys = {size_key for _code, _ext, size_key, _nominal in qq_source.QUALITY_LADDER}
        self.assertIn("size_flac", keys)
        self.assertIn("size_hires", keys)
        self.assertIn("size_192ogg", keys)
        self.assertIn("size_320mp3", keys)
        self.assertEqual(
            len(keys), len(qq_source.QUALITY_LADDER),
            "每个档位必须映射到不同的体积字段",
        )

    def test_payload_keys_match_go_track_json_contract(self):
        # 这些键名是 internal/provider/model.Track 的 JSON 契约, 写错会静默丢字段。
        items = [song_item("AAA")]
        backend = FakeBackend(items, purl_by_quality={"quality": "M500"})
        song = self.run_search(backend, limit=5)[0]
        self.assertEqual(
            set(song),
            {"id", "name", "artist", "album", "album_id", "duration", "size", "bitrate",
             "source", "url", "ext", "cover", "link", "extra", "is_invalid", "is_vip"},
        )
        self.assertTrue(all(isinstance(value, str) for value in song["extra"].values()))

    def test_unplayable_songs_are_dropped_with_warning(self):
        items = [song_item("AAA"), song_item("BBB")]
        backend = FakeBackend(items, purl_by_quality={"quality": "M500", "mid": "AAA"})
        with self.assertLogs("provider_bridge.qq_source", level="WARNING") as captured:
            songs = self.run_search(backend, limit=5)
        self.assertEqual([song["id"] for song in songs], ["AAA"])
        self.assertTrue(any("未取得下载地址" in line for line in captured.output))

    def test_rate_limited_search_warns_and_returns_empty(self):
        backend = FakeBackend([], search_code=2001)
        with self.assertLogs("provider_bridge.qq_source", level="WARNING") as captured:
            songs = self.run_search(backend, limit=5)
        self.assertEqual(songs, [])
        self.assertTrue(any("2001" in line for line in captured.output))
        self.assertEqual(len(backend.vkey_calls), 0)

    def test_empty_keyword_returns_empty_without_requests(self):
        backend = FakeBackend([song_item("AAA")], purl_by_quality={"quality": "M500"})
        self.assertEqual(self.run_search(backend, keyword="   "), [])
        self.assertEqual(backend.calls, [])

    # ---- 凭证模式 ------------------------------------------------------

    def test_expired_credential_tries_anonymous_first_then_authenticated(self):
        expired = cookie_string(
            created_at=int(time.time()) - 40 * 86400,
            lifetime=259200,
        )
        items = [song_item("AAA")]
        # 第一次(匿名) 不给 purl, 第二次(带凭证) 给 —— 用于验证自动切换。
        backend = FakeBackend(items, purl_by_quality={"quality": "M500"}, purl_plan=[[], ["AAA"]])
        with self.assertLogs("provider_bridge.qq_source", level="WARNING") as captured:
            songs = self.run_search(backend, cookie=expired, limit=5)
        self.assertEqual(len(backend.vkey_calls), 2)
        self.assertEqual(backend.vkey_calls[0]["cookie"], "")
        self.assertNotIn("g_tk", backend.vkey_calls[0]["payload"]["comm"])
        self.assertEqual(backend.vkey_calls[0]["payload"]["comm"]["uin"], "0")
        self.assertEqual(backend.vkey_calls[1]["cookie"], expired)
        self.assertIn("g_tk", backend.vkey_calls[1]["payload"]["comm"])
        self.assertEqual(len(songs), 1)
        self.assertTrue(any("切换" in line for line in captured.output))

    def test_valid_credential_is_used_first(self):
        fresh = cookie_string(created_at=int(time.time()), lifetime=259200)
        backend = FakeBackend([song_item("AAA")], purl_by_quality={"quality": "M500"})
        self.run_search(backend, cookie=fresh, limit=5)
        self.assertEqual(len(backend.vkey_calls), 1)
        self.assertEqual(backend.vkey_calls[0]["cookie"], fresh)
        self.assertIn("g_tk", backend.vkey_calls[0]["payload"]["comm"])

    def test_credential_state_reports_expiry(self):
        expired = qq_source.credential_state(
            cookie_string(created_at=int(time.time()) - 10 * 86400, lifetime=259200)
        )
        self.assertTrue(expired["expired"])
        self.assertTrue(expired["has_key"])
        self.assertIn("已过期", expired["summary"])
        fresh = qq_source.credential_state(cookie_string(created_at=int(time.time()), lifetime=259200))
        self.assertFalse(fresh["expired"])
        self.assertIn("有效", fresh["summary"])
        missing = qq_source.credential_state("uin=1")
        self.assertFalse(missing["has_key"])
        self.assertIn("缺失", missing["summary"])

    # ---- 歌词 ----------------------------------------------------------

    def test_lyrics_are_attached_to_returned_songs(self):
        items = [song_item("AAA")]
        backend = FakeBackend(items, purl_by_quality={"quality": "M500"}, lyrics={"AAA": "[00:01.00]晴天"})
        songs = self.run_search(backend, limit=5)
        self.assertEqual(songs[0]["extra"]["lyric"], "[00:01.00]晴天")
        self.assertEqual(len(backend.lyric_calls), 1)
        self.assertEqual(backend.lyric_calls[0]["payload"]["req_1"]["module"], qq_source.LYRIC_MODULE)

    def test_lyrics_can_be_disabled(self):
        items = [song_item("AAA")]
        backend = FakeBackend(items, purl_by_quality={"quality": "M500"}, lyrics={"AAA": "[00:01.00]晴天"})
        with mock.patch.dict(os.environ, {"MELODEX_QQ_SEARCH_LYRICS": "0"}):
            songs = self.run_search(backend, limit=5)
        self.assertNotIn("lyric", songs[0]["extra"])
        self.assertEqual(backend.lyric_calls, [])

    def test_lyric_failure_does_not_break_search(self):
        items = [song_item("AAA")]
        backend = FakeBackend(items, purl_by_quality={"quality": "M500"})

        def post(client, payload):
            if (payload.get("req_1") or {}).get("module") == qq_source.LYRIC_MODULE:
                raise RuntimeError("lyric endpoint down")
            return backend(client, payload)

        with mock.patch.object(qq_source, "_post", post):
            songs = qq_source.search("晴天", 5, "", work_dir=self.work_dir)
        self.assertEqual(len(songs), 1)
        self.assertNotIn("lyric", songs[0]["extra"])

    # ---- 设备号 --------------------------------------------------------

    def test_device_id_is_persisted_and_reused(self):
        with mock.patch.object(qq_source, "_device_cache", ""):
            first = qq_source._device_id(self.work_dir)
            with mock.patch.object(qq_source, "_device_cache", ""):
                second = qq_source._device_id(self.work_dir)
        self.assertEqual(first, second)
        self.assertRegex(first, r"^[0-9a-f]{36}$")
        self.assertTrue((__import__("pathlib").Path(self.work_dir) / qq_source.DEVICE_ID_FILE).exists())

    def test_device_id_env_override(self):
        with mock.patch.dict(os.environ, {"MELODEX_QQ_QIMEI36": "a" * 36}):
            self.assertEqual(qq_source._device_id(self.work_dir), "a" * 36)


class QQSourceRoutingTests(unittest.TestCase):
    def setUp(self):
        self.work_dir = tempfile.mkdtemp(prefix="qq-route-")

    def test_app_routes_qq_to_native_module(self):
        sentinel = [{"id": "AAA", "source": "qq"}]
        with mock.patch.object(bridge_app.qq_source, "search", return_value=sentinel) as native:
            result = bridge_app.search(
                {"source": "qq", "keyword": "晴天", "limit": 5, "cookie": "uin=1"},
                work_dir=self.work_dir,
            )
        native.assert_called_once()
        self.assertEqual(result, {"songs": sentinel})

    def test_app_keeps_snapshot_path_when_factory_injected(self):
        class FakeSong:
            def todict(self):
                return {"identifier": "X", "song_name": "晴天", "download_url": "https://example.invalid/a.mp3"}

        class FakeClient:
            def __init__(self, **kwargs):
                pass

            def search(self, keyword):
                return [FakeSong()]

        result = bridge_app.search(
            {"source": "qq", "keyword": "晴天", "limit": 5, "cookie": "uin=1"},
            client_factory=FakeClient,
            work_dir=self.work_dir,
        )
        self.assertEqual(len(result["songs"]), 1)
        self.assertEqual(result["songs"][0]["source"], "qq")


if __name__ == "__main__":
    unittest.main()
