"""provider_bridge 的 QQ 原生实现测试。

覆盖的每条断言都对应一个在线探测确认过的 QQ 契约,或一个必须保持的既有行为:
端点必须是 u6.y.qq.com、vkey 必须用 req_1 信封 + g_tk、搜索 comm 必须带 QIMEI36、
过期凭证要自动切换模式、失败不能静默。
"""

import base64
import json
import os
import pathlib
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

    def __init__(self, search_items, purl_by_quality=None, lyrics=None, search_code=0, purl_plan=None,
                 qrc_payload=None):
        self.search_items = search_items
        self.purl_by_quality = purl_by_quality or {}
        self.lyrics = lyrics or {}
        self.search_code = search_code
        # qrc_payload: 带 qrc=1 的请求返回的 QRC 密文(十六进制); 不设则返回空 data。
        self.qrc_payload = qrc_payload
        # purl_plan: 每次 vkey 调用依次弹出一个 "该次返回哪些 mid 的 purl" 列表;用尽后返回空。
        self.purl_plan = list(purl_plan) if purl_plan is not None else None
        self.calls = []

    def __call__(self, client, payload):
        self.calls.append({"cookie": getattr(client, "cookie", ""), "payload": payload})
        if f"{qq_source.SEARCH_MODULE}.{qq_source.SEARCH_METHOD}" in payload:
            return search_response(self.search_items, self.search_code)
        module = (payload.get("req_1") or {}).get("module")
        if module == qq_source.LYRIC_MODULE:
            params = payload["req_1"]["param"] or {}
            mid = params.get("songMID", "")
            if params.get("qrc") == 1:
                if self.qrc_payload:
                    return {"req_1": {"code": 0, "data": {"lyric": self.qrc_payload}}}
                return {"req_1": {"code": 0, "data": {}}}
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
        with qq_source._status_lock:
            qq_source._status.clear()

    def run_search(self, backend, keyword="晴天", limit=20, cookie="", work_dir=None, probe=None):
        probe = probe or (lambda _url, _cookie: (True, 206))
        with mock.patch.object(qq_source, "_post", backend):
            with mock.patch.object(qq_source, "_probe_media_url", side_effect=probe):
                return qq_source.search(keyword, limit, cookie, work_dir=work_dir or self.work_dir)

    # ---- 端点与请求契约 ------------------------------------------------

    def test_lyric_search_type_is_forwarded(self):
        # 歌词片段检索靠 search_type=7 生效(实测搜「故事的小黄花」命中 晴天/周杰伦);
        # 普通搜歌维持 0。默认值必须是 0, 否则所有普通搜索都会被当成歌词检索。
        items = [song_item("AAA")]
        backend = FakeBackend(items, purl_by_quality={"quality": "M500"})
        with mock.patch.object(qq_source, "_post", backend):
            qq_source.search("故事的小黄花", 5, "", work_dir=self.work_dir,
                             search_type=qq_source.SEARCH_TYPE_LYRIC)
        param = backend.calls[0]["payload"][f"{qq_source.SEARCH_MODULE}.{qq_source.SEARCH_METHOD}"]["param"]
        self.assertEqual(param["search_type"], qq_source.SEARCH_TYPE_LYRIC)
        self.assertEqual(qq_source.SEARCH_TYPE_LYRIC, 7)
        self.assertEqual(qq_source.SEARCH_TYPE_SONG, 0)

    def test_default_search_type_is_song(self):
        items = [song_item("AAA")]
        backend = FakeBackend(items, purl_by_quality={"quality": "M500"})
        self.run_search(backend, limit=5)
        param = backend.calls[0]["payload"][f"{qq_source.SEARCH_MODULE}.{qq_source.SEARCH_METHOD}"]["param"]
        self.assertEqual(param["search_type"], qq_source.SEARCH_TYPE_SONG)

    def test_status_records_search_type(self):
        backend = FakeBackend([], search_code=2001)
        with mock.patch.object(qq_source, "_post", backend):
            qq_source.search("故事的小黄花", 5, "", work_dir=self.work_dir,
                             search_type=qq_source.SEARCH_TYPE_LYRIC)
        self.assertEqual(qq_source.status()["search_type"], qq_source.SEARCH_TYPE_LYRIC)

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
            with mock.patch.object(qq_source, "_probe_media_url", return_value=(True, 206)):
                songs = qq_source.search("晴天", 5, "", work_dir=self.work_dir)
        self.assertEqual(songs[0]["ext"], "flac")
        self.assertEqual(songs[0]["size"], 30000000)
        self.assertEqual(songs[0]["extra"]["has_lossless"], "1")

    def test_dead_higher_quality_falls_back_to_playable_lower_quality(self):
        items = [song_item("AAA")]

        def post_with_two_qualities(client, payload):
            if f"{qq_source.SEARCH_MODULE}.{qq_source.SEARCH_METHOD}" in payload:
                return search_response(items)
            mid = "AAA"
            return vkey_response([
                (f"O600{mid}{mid}.ogg", f"O600{mid}.ogg?guid=1&vkey=ogg"),
                (f"M500{mid}{mid}.mp3", f"M500{mid}.mp3?guid=1&vkey=mp3"),
            ])

        def probe(url, _cookie):
            if "/O600" in url:
                return False, 404
            return True, 206

        songs = self.run_search(
            post_with_two_qualities,
            limit=5,
            probe=probe,
        )
        self.assertEqual(len(songs), 1)
        self.assertEqual(songs[0]["ext"], "mp3")
        self.assertIn("/M500AAA.mp3", songs[0]["url"])

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

    # ---- 可观测性(/health 暴露的观测快照) ------------------------------

    def test_status_records_rate_limited_search(self):
        backend = FakeBackend([], search_code=2001)
        self.run_search(backend, limit=5)
        snapshot = qq_source.status()
        self.assertTrue(snapshot["rate_limited"])
        self.assertEqual(snapshot["search_code"], 2001)
        self.assertEqual(snapshot["candidates"], 0)
        self.assertTrue(snapshot["empty_reason"])
        self.assertIn("updated_at", snapshot)
        # 必须能直接进 /health 的 JSON 响应。
        json.dumps(snapshot)

    def test_status_records_playable_search(self):
        items = [song_item("AAA"), song_item("BBB")]
        backend = FakeBackend(items, purl_by_quality={"quality": "M500", "mid": "AAA"})
        with self.assertLogs("provider_bridge.qq_source", level="WARNING"):
            self.run_search(backend, limit=5)
        snapshot = qq_source.status()
        self.assertEqual(snapshot["candidates"], 2)
        self.assertEqual(snapshot["playable"], 1)
        self.assertEqual(snapshot["dropped"], 1)
        self.assertEqual(snapshot["mode"], "匿名")
        self.assertFalse(snapshot["rate_limited"])
        self.assertEqual(snapshot["empty_reason"], "")

    def test_status_reports_credential_expiry(self):
        expired = cookie_string(created_at=int(time.time()) - 40 * 86400, lifetime=259200)
        backend = FakeBackend([song_item("AAA")], purl_by_quality={"quality": "M500"})
        self.run_search(backend, cookie=expired, limit=5)
        snapshot = qq_source.status()
        self.assertTrue(snapshot["credential_expired"])
        self.assertTrue(snapshot["has_credential_key"])
        # 这份 cookie 里没有 refresh_token, 所以不可续期。
        self.assertFalse(snapshot["credential_refreshable"])
        self.assertIn("已过期", snapshot["credential"])

    def test_credential_state_detects_refresh_token(self):
        with_token = cookie_string(created_at=int(time.time()), lifetime=259200) + "; refresh_token=abc"
        self.assertTrue(qq_source.credential_state(with_token)["refreshable"])

    def test_app_exposes_source_status_for_health(self):
        backend = FakeBackend([], search_code=2001)
        self.run_search(backend, limit=5)
        payload = bridge_app.source_status()
        self.assertEqual(payload["qq"]["search_code"], 2001)
        json.dumps(payload)

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

    def test_both_credential_modes_failing_logs_once_and_reports_last_mode(self):
        # 两种模式都拿不到地址时: 只应有一条"切换"日志(不存在第三次尝试), 且末次模式准确。
        expired = cookie_string(created_at=int(time.time()) - 40 * 86400, lifetime=259200)
        backend = FakeBackend([song_item("AAA")], purl_by_quality={"quality": "M500"}, purl_plan=[[], []])
        with self.assertLogs("provider_bridge.qq_source", level="WARNING") as captured:
            songs = self.run_search(backend, cookie=expired, limit=5)
        self.assertEqual(songs, [])
        self.assertEqual(len(backend.vkey_calls), 2)
        switches = [line for line in captured.output if "切换" in line]
        self.assertEqual(len(switches), 1, "不应在最后一次尝试后宣称还要切换")
        self.assertTrue(any("都未取得任何下载地址" in line for line in captured.output))
        self.assertTrue(
            any("搜索没有任何可播歌曲" in line for line in captured.output),
            "整次搜索无结果时必须留下汇总日志",
        )

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
    #
    # 搜索**不再内联**歌词: 实测 5 个关键词带歌词 21.30s / 不带 7.84s(歌词占 63%),
    # 改为播放时按 mid 惰性取(见 fetch_lyric)。下面同时锁死"搜索不发歌词请求"
    # 和"惰性取词仍能拿到逐字 QRC"两端。

    def test_search_does_not_fetch_lyrics_inline(self):
        """搜索必须零歌词请求 —— 这是把 QQ 搜索从 4.26s 降到 1.57s 的关键。"""
        items = [song_item("AAA"), song_item("BBB")]
        backend = FakeBackend(items, purl_by_quality={"quality": "M500"},
                               lyrics={"AAA": "[00:01.00]晴天"})
        songs = self.run_search(backend, limit=5)
        self.assertEqual(backend.lyric_calls, [], "搜索阶段不得请求歌词")
        for song in songs:
            self.assertNotIn("lyric", song["extra"], "搜索结果不应带内联歌词")

    def test_inline_lyrics_still_available_via_opt_in(self):
        """需要旧行为时可显式开启(排障/回归对照用)。"""
        items = [song_item("AAA")]
        backend = FakeBackend(items, purl_by_quality={"quality": "M500"},
                               lyrics={"AAA": "[00:01.00]晴天"})
        with mock.patch.dict(os.environ, {"MELODEX_QQ_SEARCH_LYRICS": "1"}):
            songs = self.run_search(backend, limit=5)
        self.assertEqual(songs[0]["extra"]["lyric"], "[00:01.00]晴天")
        self.assertNotIn("lyric_verbatim", songs[0]["extra"], "行级歌词不能标成逐字")

    def test_lazy_lyric_uses_cached_meta_for_verbatim_qrc(self):
        """惰性取词: 搜索时缓存 mid->元数据, 播放时靠它走完整 QRC 逐字链路。

        QRC 请求必须带 songName/albumName/singerName(只传 mid 上游不给 QRC),
        这些字段只有搜索结果里有 —— 所以缓存元数据是逐字歌词不退化的前提。
        """
        fixture = json.loads(
            (pathlib.Path(__file__).with_name("testdata") / "qq_qrc_fixture.json").read_text(encoding="utf-8")
        )
        items = [song_item("AAA", title="晴天", artists=("周杰伦",), album_mid="000M")]
        backend = FakeBackend(items, purl_by_quality={"quality": "M500"},
                              qrc_payload=fixture["lyric_hex"])
        with mock.patch.object(qq_source, "_post", backend):
            with mock.patch.object(qq_source, "_probe_media_url", return_value=(True, 206)):
                qq_source.search("晴天", 5, "", work_dir=self.work_dir)
                lyric = qq_source.fetch_lyric("AAA")
        self.assertTrue(lyric.startswith("[00:00.000]晴"), lyric[:40])

    def test_lazy_lyric_falls_back_to_line_level_without_cache(self):
        """重启后直接播放历史歌单(无元数据缓存)时, 至少要拿到行级歌词。"""
        backend = FakeBackend([], lyrics={"UNKNOWN": "[00:01.00]行级歌词"})
        with mock.patch.object(qq_source, "_post", backend):
            lyric = qq_source.fetch_lyric("UNKNOWN")
        self.assertEqual(lyric, "[00:01.00]行级歌词")

    def test_lazy_lyric_empty_for_unknown_mid(self):
        backend = FakeBackend([])
        with mock.patch.object(qq_source, "_post", backend):
            self.assertEqual(qq_source.fetch_lyric(""), "")

    def test_lyric_failure_does_not_break_search(self):
        items = [song_item("AAA")]
        backend = FakeBackend(items, purl_by_quality={"quality": "M500"})

        def post(client, payload):
            if (payload.get("req_1") or {}).get("module") == qq_source.LYRIC_MODULE:
                raise RuntimeError("lyric endpoint down")
            return backend(client, payload)

        with mock.patch.object(qq_source, "_post", post):
            with mock.patch.object(qq_source, "_probe_media_url", return_value=(True, 206)):
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


class QQRefreshTests(unittest.TestCase):
    """musickey 只有 3 天寿命, 但长期凭据可换新 key —— 用户不必每 3~4 天重新扫码。

    实测(2026-10): 过期后 VIP/无损曲全部拿不到地址(可播率 10/10 → 2/10);
    用 pt_oauth_token/p_skey 走 QQConnectLogin.LoginServer/QQLogin 换新 key 后,
    立刻恢复 10/10 可播且 flac 1647kbps。
    """

    def test_returns_empty_without_uin(self):
        self.assertEqual(qq_source.refresh_musickey("musickey=abc"), {})

    def test_returns_empty_without_any_long_lived_token(self):
        cookie = cookie_string(uin="3058261811", musickey="abc")
        self.assertEqual(qq_source.refresh_musickey(cookie), {})

    def test_exchanges_long_lived_token_for_new_musickey(self):
        cookie = cookie_string(uin="3058261811", musickey="OLD")
        cookie += "; pt_oauth_token=TOKEN; openid=OPENID; access_token=AT"
        calls = []

        def fake_post(url, payload, **kwargs):
            calls.append(payload)
            req = payload["req"]
            self.assertEqual(req["module"], qq_source.LOGIN_SERVER_MODULE)
            self.assertEqual(req["method"], qq_source.LOGIN_SERVER_METHOD)
            self.assertEqual(req["param"]["token"], "TOKEN")
            return {"req": {"code": 0, "data": {
                "musickey": "NEWKEY", "musickeyCreateTime": 1792856360,
                "keyExpiresIn": 259200, "musicid": 3058261811,
            }}}

        with mock.patch.object(qq_source.PlatformHTTP, "post_json", side_effect=fake_post):
            result = qq_source.refresh_musickey(cookie)
        self.assertTrue(result)
        self.assertEqual(result["expires_in"], 259200)
        self.assertEqual(result["expires_at"], 1792856360 + 259200)
        # 三个别名都要写全, 取地址链路读任意一个。
        for name in ("musickey=NEWKEY", "qqmusic_key=NEWKEY", "qm_keyst=NEWKEY"):
            self.assertIn(name, result["cookie"])
        self.assertIn("keyExpiresIn=259200", result["cookie"])
        self.assertEqual(len(calls), 1)

    def test_falls_back_through_token_candidates(self):
        """QQ 不同登录态可用的 token 不同, 必须逐个试(当年扫码登录修过 5 次)。"""
        cookie = cookie_string(uin="3058261811", musickey="OLD")
        cookie += "; p_skey=PSKEY; superkey=SUPERKEY"
        tried = []

        def fake_post(url, payload, **kwargs):
            tried.append(payload["req"]["param"]["token"])
            if payload["req"]["param"]["token"] == "SUPERKEY":
                return {"req": {"code": 0, "data": {
                    "musickey": "KEY_FROM_SUPER", "musickeyCreateTime": 1792856360,
                    "keyExpiresIn": 259200,
                }}}
            return {"req": {"code": 40000}}

        with mock.patch.object(qq_source.PlatformHTTP, "post_json", side_effect=fake_post):
            result = qq_source.refresh_musickey(cookie)
        self.assertIn("PSKEY", tried)
        self.assertIn("SUPERKEY", tried)
        self.assertIn("musickey=KEY_FROM_SUPER", result["cookie"])

    def test_returns_empty_when_all_tokens_rejected(self):
        cookie = cookie_string(uin="3058261811", musickey="OLD") + "; p_skey=PSKEY"
        with mock.patch.object(qq_source.PlatformHTTP, "post_json",
                               return_value={"req": {"code": 40000}}):
            self.assertEqual(qq_source.refresh_musickey(cookie), {})

    def test_survives_last_session(self):
        """服务端切换(hk/tw 名单)时不应整个失败。"""
        cookie = cookie_string(uin="3058261811", musickey="OLD") + "; p_skey=PSKEY"
        attempted = []

        def fake_post(url, payload, **kwargs):
            attempted.append(1)
            if len(attempted) == 1:
                raise RuntimeError("primary down")
            return {"req": {"code": 0, "data": {
                "musickey": "NEWKEY", "musickeyCreateTime": 1, "keyExpiresIn": 259200,
            }}}

        with mock.patch.object(qq_source.PlatformHTTP, "post_json", side_effect=fake_post):
            result = qq_source.refresh_musickey(cookie)
        self.assertIn("musickey=NEWKEY", result.get("cookie", ""))


class QQRefreshWiringTests(unittest.TestCase):
    """续期必须真的生效并可被上层持久化。"""

    def setUp(self):
        self.work_dir = tempfile.mkdtemp(prefix="qq-refresh-")

    def test_search_refreshes_expired_credential_and_reports_cookie(self):
        expired = cookie_string(uin="3058261811", musickey="OLD",
                                created_at=1700000000, lifetime=259200)
        expired += "; pt_oauth_token=TOKEN"
        new_cookie = expired.replace("musickey=OLD", "musickey=NEW")
        refreshed = {}

        def fake_refresh(cookie, session=None):
            return {"cookie": new_cookie, "expires_at": 1, "expires_in": 259200}

        # 用真实 cookie 让 credential_state 自然判定"过期", 只打桩网络层与搜索。
        with mock.patch.object(qq_source, "refresh_musickey", side_effect=fake_refresh) as refresh:
            with mock.patch.object(qq_source, "_search_items", return_value=([], 0)):
                result = qq_source.search(
                    "晴天", 5, expired, work_dir=self.work_dir,
                    refreshed_cookie_sink=refreshed,
                )
        refresh.assert_called_once()
        self.assertEqual(refreshed.get("cookie"), new_cookie)
        self.assertEqual(result, [])

    def test_app_propagates_refreshed_cookie(self):
        sentinel = [{"id": "AAA", "source": "qq"}]

        def fake_search(*args, **kwargs):
            kwargs["refreshed_cookie_sink"]["cookie"] = "musickey=NEW"
            return sentinel

        with mock.patch.object(bridge_app.qq_source, "search", side_effect=fake_search):
            result = bridge_app.search(
                {"source": "qq", "keyword": "晴天", "limit": 5, "cookie": "uin=1"},
                work_dir=self.work_dir,
            )
        self.assertEqual(result["songs"], sentinel)
        self.assertEqual(result["refreshed_cookie"], "musickey=NEW")

    def test_app_omits_refreshed_cookie_when_not_refreshed(self):
        sentinel = [{"id": "AAA", "source": "qq"}]
        with mock.patch.object(bridge_app.qq_source, "search", return_value=sentinel):
            result = bridge_app.search(
                {"source": "qq", "keyword": "晴天", "limit": 5, "cookie": "uin=1"},
                work_dir=self.work_dir,
            )
        self.assertEqual(result, {"songs": sentinel})


class LayeredProbeTests(unittest.TestCase):
    """探活必须分层: 最高档成功就不再探其余档位。

    早先的实现把每首歌 7 个档位**全部**探一遍(20 首 ≈140 次 HTTP), 即使 flac 已经可用
    也要等所有档位探完; 实测这一步占 QQ 搜索耗时的大头。分层后正常只探 1 档。
    """

    def test_probes_only_best_quality_when_it_works(self):
        candidates = {
            "AAA": [("F000", "flac", "https://m/flac"), ("M800", "mp3", "https://m/320"),
                    ("M500", "mp3", "https://m/128")],
            "BBB": [("F000", "flac", "https://m2/flac"), ("M500", "mp3", "https://m2/128")],
        }
        probed = []

        def probe(url, _cookie):
            probed.append(url)
            return (True, 206)

        with mock.patch.object(qq_source, "_probe_media_url", side_effect=probe):
            selected = qq_source._select_working_media(candidates, "")
        self.assertEqual(len(probed), 2, "最高档都成功时每首只探 1 次, 共 2 次")
        self.assertEqual(selected["AAA"][0], "F000")
        self.assertEqual(selected["BBB"][0], "F000")

    def test_falls_back_to_lower_quality_only_for_failing_songs(self):
        candidates = {
            "AAA": [("F000", "flac", "https://a/flac"), ("M800", "mp3", "https://a/320")],
            "BBB": [("F000", "flac", "https://b/flac"), ("M800", "mp3", "https://b/320")],
        }
        probed = []

        def probe(url, _cookie):
            probed.append(url)
            return (True, 206) if "320" in url else (False, 404)

        with mock.patch.object(qq_source, "_probe_media_url", side_effect=probe):
            selected = qq_source._select_working_media(candidates, "")
        self.assertEqual(selected["AAA"][0], "M800")
        self.assertEqual(selected["BBB"][0], "M800")
        self.assertEqual(len(probed), 4, "每首只探 2 次(降一档), 不探第三档")

    def test_unusable_song_is_dropped(self):
        candidates = {"AAA": [("F000", "flac", "https://a/flac")]}
        with mock.patch.object(qq_source, "_probe_media_url", return_value=(False, 403)):
            selected = qq_source._select_working_media(candidates, "")
        self.assertEqual(selected, {})

    def test_probe_exception_is_treated_as_failure(self):
        candidates = {"AAA": [("F000", "flac", "https://a/flac"), ("M500", "mp3", "https://a/128")]}

        def probe(url, _cookie):
            if "flac" in url:
                raise RuntimeError("probe boom")
            return (True, 206)

        with mock.patch.object(qq_source, "_probe_media_url", side_effect=probe):
            selected = qq_source._select_working_media(candidates, "")
        self.assertEqual(selected["AAA"][0], "M500")


class AuthPassBreakerTests(unittest.TestCase):
    """带凭证模式整轮被拒时短期跳过它, 避免每次搜索白付一次往返。

    实测: 凭证有效(musickey 剩 70 小时)但 vkey 一律回 code=104009 且不发 purl,
    带凭证那轮耗时 ~0.39s 却什么都拿不到, 匿名模式反而可用。
    """

    def setUp(self):
        qq_source._clear_auth_suppression()

    def tearDown(self):
        qq_source._clear_auth_suppression()

    def test_auth_pass_is_skipped_after_suppression(self):
        state = {"has_key": True, "expired": False, "musickey": "KEY1", "uin": "1",
                 "summary": "有效"}
        calls = []

        def vkey_pass(mids, state, cookie, *, use_auth, session):
            calls.append(use_auth)
            return {} if use_auth else {"AAA": ("M500", "mp3", "https://m/128")}

        with mock.patch.object(qq_source, "_vkey_pass", side_effect=vkey_pass):
            qq_source._resolve_urls(["AAA"], state, "c", session=None)
            self.assertEqual(calls, [True, False], "首次应带凭证再匿名")

            calls.clear()
            qq_source._resolve_urls(["AAA"], state, "c", session=None)
            self.assertEqual(calls, [False], "熔断后应直接匿名, 不再白跑带凭证那轮")

    def test_new_musickey_invalidates_suppression(self):
        old = {"has_key": True, "expired": False, "musickey": "KEY1", "uin": "1", "summary": "有效"}
        new = {"has_key": True, "expired": False, "musickey": "KEY2", "uin": "1", "summary": "有效"}
        calls = []

        def vkey_pass(mids, state, cookie, *, use_auth, session):
            calls.append(use_auth)
            return {} if use_auth else {"AAA": ("M500", "mp3", "https://m/128")}

        with mock.patch.object(qq_source, "_vkey_pass", side_effect=vkey_pass):
            qq_source._resolve_urls(["AAA"], old, "c", session=None)
            qq_source._resolve_urls(["AAA"], old, "c", session=None)
            calls.clear()
            # 自动续期换出新 key 后必须重新试探带凭证(可能恢复 VIP 高音质)。
            qq_source._resolve_urls(["AAA"], new, "c", session=None)
            self.assertEqual(calls, [True, False])

    def test_successful_auth_clears_suppression(self):
        state = {"has_key": True, "expired": False, "musickey": "KEY1", "uin": "1", "summary": "有效"}
        qq_source._suppress_auth_pass(state)
        self.assertTrue(qq_source._auth_pass_suppressed(state))
        qq_source._clear_auth_suppression()
        self.assertFalse(qq_source._auth_pass_suppressed(state))


if __name__ == "__main__":
    unittest.main()
