"""酷我原生搜索/取址实现的测试。

响应形状全部取自对真实接口的实测(2026-10):
    www.kuwo.cn/search/searchMusicBykeyWord -> {"abslist":[{"SONGNAME","ARTIST","ALBUM",
        "DURATION","MUSICRID","PAY","fpay","MINFO","hts_MVPIC","payInfo"}]}
    mobi.kuwo.cn/mobi.s?type=convert_url_with_sign -> {"code":200,"data":{"url","rid",
        "duration","format","bitrate"}}

关键现实约束(本实现的全部存在理由):
  - 快照对每首歌跑 22 档音质阶梯+逐档探活, limit=20 要 83.7s;
  - 快照把付费曲的 **11 秒试听片段**判为可播(实测 晴天/孤勇者/江南 原唱全部如此),
    用户点开只响 11 秒就跳下一首, 而 size=0 不暴露任何异常。
"""

import json
import unittest
from unittest import mock

from provider_bridge import app as bridge_app
from provider_bridge import kuwo_source


SEARCH_PAYLOAD = {
    "abslist": [
        {
            # 付费原唱: fpay=1, PAY=0xFF00FF。无 cookie 只能听试听片段。
            "SONGNAME": "晴天", "ARTIST": "周杰伦", "ALBUM": "叶惠美", "ALBUMID": "18905",
            "DURATION": "269", "MUSICRID": "MUSIC_228908", "PAY": "16711935", "fpay": "1",
            "MINFO": "level:ff,bitrate:2000,format:flac,size:52.83Mb;level:p,bitrate:320,format:mp3,size:10.29Mb",
            "hts_MVPIC": "1080/s4s1/13/3989187649.jpg",
            # 注意: refrain_start 非零是"副歌起点", 免费曲也有 —— 不能拿它判付费。
            "payInfo": {"refrain_start": "84346", "refrain_end": "142843"},
        },
        {
            # 免费曲: fpay=0, PAY=0x880088, 能拿到完整音频。
            "SONGNAME": "晴天+稻香 (Live)", "ARTIST": "群星", "ALBUM": "现场",
            "ALBUMID": "700", "DURATION": "462", "MUSICRID": "MUSIC_207227837",
            "PAY": "8913032", "fpay": "0",
            "MINFO": "level:h,bitrate:100,format:ogg,size:4.03Mb;level:s,bitrate:48,format:aac,size:2.69Mb",
            "hts_MVPIC": "500/s4s1/20/2222.jpg",
            "payInfo": {"refrain_start": "79683", "refrain_end": "135159"},
        },
        {"SONGNAME": "没有 MUSICRID 的噪音"},
        "不是字典的噪音",
    ],
}


class FakeSession:
    """假的 requests.Session: 按 URL 分流, 并记录请求。"""

    def __init__(self, *, search=None, mobi=None, lyric=None, search_error=False):
        self.search = SEARCH_PAYLOAD if search is None else search
        self.mobi = mobi or {}
        self.lyric = lyric if lyric is not None else {"data": {"lrclist": []}}
        self.search_error = search_error
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append({"method": method, "url": url, "data": kwargs.get("data") or {},
                           "headers": kwargs.get("headers") or {}})
        if "searchMusicBykeyWord" in url:
            if self.search_error:
                raise RuntimeError("search boom")
            return _Response(self.search)
        if "mobi.s" in url:
            rid = _query_value(url, "rid")
            return _Response(self.mobi.get(rid, {"code": 200, "data": {"url": ""}}))
        if "songinfoandlrc" in url:
            return _Response(self.lyric)
        raise AssertionError(f"unexpected url {url}")


class _Response:
    def __init__(self, payload):
        self.content = json.dumps(payload).encode("utf-8")

    def raise_for_status(self):
        return None


def _query_value(url, name):
    from urllib.parse import parse_qs, urlparse
    return (parse_qs(urlparse(url).query).get(name) or [""])[0]


def full_song(rid, duration, ext="aac", bitrate=48):
    """构造一条"完整歌曲"的 mobi 响应。"""
    return {
        "code": 200,
        "data": {
            "rid": int(rid), "duration": duration, "format": ext,
            "bitrate": bitrate, "url": f"https://kw-bj.kuwo.cn/x/{rid}.{ext}",
        },
    }


AAC_LEVEL = {"level": "s", "bitrate": 48, "ext": "aac", "size": 4_500_000}
MP3_LEVEL = {"level": "h", "bitrate": 128, "ext": "mp3", "size": 12_000_000}


def preview_clip(rid):
    """构造试听片段: 回固定的另一个 rid + 11 秒时长(实测上游行为)。"""
    return {
        "code": 200,
        "data": {
            "rid": 260839262, "duration": 11, "format": "mp3",
            "bitrate": 24, "url": "https://kw-er.kuwo.cn/x/preview.mp3",
        },
    }


class PaidDetectionTests(unittest.TestCase):
    """付费曲判定: 只认 fpay 与 PAY 掩码, 不能用 refrain_start。"""

    def test_fpay_marks_paid(self):
        self.assertTrue(kuwo_source._is_paid_item(SEARCH_PAYLOAD["abslist"][0]))

    def test_free_song_is_not_paid(self):
        self.assertFalse(
            kuwo_source._is_paid_item(SEARCH_PAYLOAD["abslist"][1]),
            "免费曲 fpay=0 / PAY=0x880088 不得判成付费",
        )

    def test_refrain_start_alone_does_not_mean_paid(self):
        """refrain_start 是副歌起点, 每首歌都有(实测免费曲也有 79683ms)。

        早先版本把它当试听区间, 结果 10 首全被判成付费 —— 这条测试锁死该回归。
        """
        item = {
            "SONGNAME": "免费曲", "MUSICRID": "MUSIC_1",
            "DURATION": "200", "fpay": "0", "PAY": "8913032",
            "payInfo": {"refrain_start": "79683", "refrain_end": "135159"},
        }
        self.assertFalse(kuwo_source._is_paid_item(item))

    def test_pay_mask_superset_is_paid(self):
        item = {"MUSICRID": "MUSIC_2", "DURATION": "100", "PAY": "16711935"}
        self.assertTrue(kuwo_source._is_paid_item(item))
        self.assertFalse(kuwo_source._is_paid_item({"MUSICRID": "MUSIC_3", "PAY": "8913032"}))
        self.assertFalse(kuwo_source._is_paid_item({"MUSICRID": "MUSIC_4", "PAY": "0"}))


class MinfoTests(unittest.TestCase):
    """MINFO 直接给出真实可用档位, 无需像快照那样逐档试探。"""

    def test_parses_levels(self):
        levels = kuwo_source._minfo_levels(SEARCH_PAYLOAD["abslist"][0])
        self.assertEqual([lv["level"] for lv in levels], ["ff", "p"])
        self.assertEqual(levels[0]["ext"], "flac")
        self.assertEqual(levels[0]["bitrate"], 2000)
        self.assertGreater(levels[0]["size"], 50 * 1024 * 1024)

    def test_picks_lossless_first(self):
        level = kuwo_source._pick_level(SEARCH_PAYLOAD["abslist"][0])
        self.assertEqual(level["ext"], "flac")

    def test_returns_empty_level_when_minfo_missing(self):
        """没有 MINFO 就没有可信档位; 返回空档位让上层判不可播, 而不是瞎猜一个。"""
        level = kuwo_source._pick_level({"SONGNAME": "无 MINFO"})
        self.assertEqual(level["ext"], "")
        self.assertEqual(kuwo_source._level_param(level), "")

    def test_skips_encrypted_formats_only(self):
        """MINFO 只有加密专有格式时, 不该挑出任何可解码档位。"""
        item = {"SONGNAME": "加密曲", "MINFO": "level:zp,bitrate:20000,format:zp,size:zpMb"}
        self.assertEqual(kuwo_source._pick_level(item)["ext"], "")

    def test_size_parsing(self):
        self.assertEqual(kuwo_source._parse_size_bytes("52.83Mb"), int(52.83 * 1024 * 1024))
        self.assertEqual(kuwo_source._parse_size_bytes(""), 0)
        self.assertEqual(kuwo_source._parse_size_bytes("垃圾"), 0)


class ResolvePlayUrlTests(unittest.TestCase):
    """四条"能不能用"信号, 任一不满足都必须拒收。"""

    def test_accepts_complete_song(self):
        session = FakeSession(mobi={"207227837": full_song("207227837", 462)})
        result = kuwo_source.resolve_play_url(
            "207227837", expected_duration_seconds=462, level=AAC_LEVEL, session=session,
        )
        self.assertEqual(result["duration"], 462)
        self.assertEqual(result["url"], "https://kw-bj.kuwo.cn/x/207227837.aac")
        self.assertEqual(result["ext"], "aac")

    def test_level_param_must_be_bitrate_plus_format(self):
        """`br` 必须是 `<bitrate>k<format>`; 裸格式名或 MINFO 的 level 值会拿到 mgg。"""
        self.assertEqual(kuwo_source._level_param(AAC_LEVEL), "48kaac")
        self.assertEqual(kuwo_source._level_param(MP3_LEVEL), "128kmp3")
        self.assertEqual(
            kuwo_source._level_param({"level": "h", "bitrate": 100, "ext": "ogg"}),
            "100kogg",
        )
        self.assertEqual(kuwo_source._level_param({"bitrate": 0, "ext": "mp3"}), "")

    def test_rejects_encrypted_container(self):
        """mgg/mflac 等加密专有格式必须拒收 —— ffmpeg 解不开, 交给前端必然播放失败。

        现场证据(2026-10): 请求 br=flac 时上游回 mgg, ffprobe 报
        "Invalid data found when processing input"。
        """
        session = FakeSession(mobi={"152809941": {
            "code": 200, "data": {
                "rid": 152809941, "duration": 787, "format": "mgg", "bitrate": 22000,
                "url": "https://kw-er.kuwo.cn/x/a.mgg",
            },
        }})
        self.assertEqual(
            kuwo_source.resolve_play_url(
                "152809941", expected_duration_seconds=787, level=AAC_LEVEL, session=session,
            ),
            {},
            "加密容器格式不得当作可播",
        )

    def test_preview_clip_is_rejected_by_rid(self):
        """试听片段会回固定的另一个 rid —— 这是最硬的信号。"""
        session = FakeSession(mobi={"228908": preview_clip("228908")})
        result = kuwo_source.resolve_play_url(
            "228908", expected_duration_seconds=269, level=MP3_LEVEL, session=session,
        )
        self.assertEqual(result, {}, "rid 不符时必须判为试听片段")

    def test_duration_mismatch_is_rejected(self):
        mismatched = {"code": 200, "data": {
            "rid": 228908, "duration": 11, "format": "mp3", "bitrate": 24,
            "url": "https://kw-er.kuwo.cn/x/clip.mp3",
        }}
        session = FakeSession(mobi={"228908": mismatched})
        self.assertEqual(
            kuwo_source.resolve_play_url(
                "228908", expected_duration_seconds=269, level=MP3_LEVEL, session=session,
            ),
            {},
            "时长 11s vs 声明 269s 必须判为试听片段",
        )

    def test_tolerates_small_duration_delta(self):
        """aac 编码会让实际时长略短(实测 269 声明 → 253 实际), 不能误杀。"""
        close = {"code": 200, "data": {
            "rid": 228908, "duration": 253, "format": "aac", "bitrate": 48,
            "url": "https://kw-bj.kuwo.cn/x/a.aac",
        }}
        session = FakeSession(mobi={"228908": close})
        self.assertNotEqual(
            kuwo_source.resolve_play_url(
                "228908", expected_duration_seconds=269, level=AAC_LEVEL, session=session,
            ),
            {},
        )

    def test_empty_url_is_rejected(self):
        session = FakeSession()
        self.assertEqual(
            kuwo_source.resolve_play_url("1", level=AAC_LEVEL, session=session), {},
        )

    def test_empty_id_short_circuits(self):
        self.assertEqual(
            kuwo_source.resolve_play_url("", level=AAC_LEVEL, session=FakeSession()), {},
        )

    def test_missing_level_short_circuits(self):
        self.assertEqual(
            kuwo_source.resolve_play_url("1", level={}, session=FakeSession()), {},
            "拿不到可用档位时不该发请求",
        )


class SearchTests(unittest.TestCase):
    def test_paid_song_is_invalid_and_not_resolved(self):
        """付费曲连取址请求都不该发(省往返 + 防误收片段)。"""
        session = FakeSession(mobi={"207227837": full_song("207227837", 462)})
        songs = kuwo_source.search("周杰伦 晴天", 10, session=session)
        paid = next(s for s in songs if s["id"] == "228908")
        free = next(s for s in songs if s["id"] == "207227837")
        self.assertTrue(paid["is_invalid"])
        self.assertTrue(paid["is_vip"])
        self.assertEqual(paid["extra"].get("needs_vip"), "1")
        self.assertFalse(free["is_invalid"])
        mobi_calls = [c for c in session.calls if "mobi.s" in c["url"]]
        self.assertEqual(len(mobi_calls), 1, "付费曲不应发取址请求")

    def test_drops_items_without_musicrid(self):
        session = FakeSession()
        songs = kuwo_source.search("周杰伦 晴天", 10, session=session)
        self.assertEqual([s["id"] for s in songs], ["228908", "207227837"])

    def test_empty_keyword_short_circuits(self):
        self.assertEqual(kuwo_source.search("   ", 5), [])

    def test_payload_shape_matches_snapshot(self):
        session = FakeSession(mobi={"207227837": full_song("207227837", 462)})
        songs = kuwo_source.search("周杰伦 晴天", 10, session=session)
        free = next(s for s in songs if s["id"] == "207227837")
        for key in ("id", "name", "artist", "album", "duration", "size", "bitrate",
                    "source", "url", "ext", "cover", "extra", "is_invalid", "is_vip"):
            self.assertIn(key, free)
        self.assertEqual(free["source"], "kuwo")
        self.assertEqual(free["artist"], "群星")
        self.assertEqual(free["duration"], 462)
        self.assertTrue(free["cover"].startswith("https://"))

    def test_logs_playable_and_paid_counts(self):
        session = FakeSession(mobi={"207227837": full_song("207227837", 462)})
        with self.assertLogs("provider_bridge.kuwo_source", level="INFO") as captured:
            kuwo_source.search("周杰伦 晴天", 10, session=session)
        joined = "\n".join(captured.output)
        self.assertIn("命中 2 首", joined)
        self.assertIn("取到地址 1 首", joined)

    def test_search_error_records_status_and_reraises(self):
        session = FakeSession(search_error=True)
        with self.assertRaises(RuntimeError):
            kuwo_source.search("周杰伦 晴天", 5, session=session)
        self.assertEqual(kuwo_source.status().get("empty_reason"), "search_error")

    def test_no_match_records_status(self):
        kuwo_source.search("不存在的歌", 5, session=FakeSession(search={"abslist": []}))
        self.assertEqual(kuwo_source.status().get("empty_reason"), "no_match")


class LyricTests(unittest.TestCase):
    def test_formats_lrclist_into_lrc(self):
        session = FakeSession(lyric={"data": {"lrclist": [
            {"time": "0", "lineLyric": "第一句"},
            {"time": "3.5", "lineLyric": "第二句"},
            {"time": "", "lineLyric": ""},
        ]}})
        lyric = kuwo_source.fetch_lyric("228908", session=session)
        self.assertEqual(lyric, "[00:00.00]第一句\n[00:03.50]第二句")

    def test_missing_data_returns_empty(self):
        session = FakeSession(lyric={"data": None, "status": 301, "msg": "音乐查询失败"})
        self.assertEqual(kuwo_source.fetch_lyric("763236", session=session), "")


class WiringTests(unittest.TestCase):
    def test_search_routes_to_native_implementation(self):
        native = [{"id": "1", "name": "晴天", "source": "kuwo", "extra": {}}]
        with mock.patch.object(kuwo_source, "search", return_value=native) as search:
            result = bridge_app.search(
                {"source": "kuwo", "keyword": "晴天", "limit": 8, "cookie": ""},
                work_dir="/tmp",
            )
        self.assertEqual(result["songs"], native)
        search.assert_called_once_with("晴天", 8, cookie="")

    def test_lyric_routes_to_kuwo(self):
        with mock.patch.object(kuwo_source, "fetch_lyric", return_value="[00:01.00]x") as fetch:
            result = bridge_app.lyric({"source": "kuwo", "id": "228908", "cookie": ""})
        self.assertEqual(result["lyric"], "[00:01.00]x")
        fetch.assert_called_once_with("228908", cookie="")

    def test_health_exposes_kuwo_status(self):
        with mock.patch.object(kuwo_source, "status", return_value={"playable": 3}):
            self.assertEqual(bridge_app.source_status()["kuwo"], {"playable": 3})


if __name__ == "__main__":
    unittest.main()
