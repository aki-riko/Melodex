"""酷狗逐字歌词(KRC)取回与转换的测试。

KRC 的形状(4 字节头 + 固定密钥 XOR + zlib、"词时间相对行首")、候选字段名与
`duration`/`score` 是垃圾值这几点, 都来自对真实接口的实测; 这里用合成样本锁定,
避免联网就能回归。检测"一行是否逐字"的规则复刻前端 parseLRC。
"""

import base64
import json
import re
import tempfile
import unittest
import zlib
from unittest import mock

from provider_bridge import app as bridge_app
from provider_bridge import kugou_lyric


# 前端 frontend/src/contexts/playerLyrics.mjs 里 parseLRC 用的时间戳正则。
FRONTEND_TIMESTAMP_RE = re.compile(r"\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]")


def frontend_segments(line: str):
    """复刻前端 parseLRC 对单行的切分: 每个时间戳 + 其后到下一个时间戳之间的文字。"""
    segments = []
    previous_time = None
    previous_end = 0
    for match in FRONTEND_TIMESTAMP_RE.finditer(line):
        if previous_time is not None:
            segments.append((previous_time, line[previous_end:match.start()]))
        previous_time = (int(match.group(1)) * 60 + int(match.group(2))
                         + (int(match.group(3).ljust(3, "0")) / 1000 if match.group(3) else 0))
        previous_end = match.end()
    if previous_time is not None:
        segments.append((previous_time, line[previous_end:]))
    return segments


def encode_krc(text: str, *, header: bytes = b"\x0a\x0b\x0c\x0d") -> str:
    """按真实算法打包 KRC: 4 字节头 + XOR(zlib(明文)) 后 base64。"""
    plain = zlib.compress(text.encode("utf-8"))
    key = kugou_lyric.KRC_KEY
    body = bytes(byte ^ key[index % len(key)] for index, byte in enumerate(plain))
    return base64.b64encode(header + body).decode("ascii")


# 实测形状: 行头 [行起,行时长], 词时间是**相对行首**的毫秒。
SAMPLE_KRC = "\n".join([
    "[0,0]<0,0,0>"
    "",
    "[43256,3505]<0,472,0>故<472,392,0>事<864,480,0>的<1344,824,0>小<2168,488,0>黄<2656,849,0>花",
    "[188000,1200]没有词级的整行",
    "没有时间戳的噪音行",
    "@[json,元信息]不是歌词",
])


def long_krc(line_count: int = 16) -> str:
    """生成 line_count 行词级歌词, 用于验证"拿到够好的候选就不再试下一个"。"""
    lines = []
    for index in range(line_count):
        start = 1000 * (index + 1)
        lines.append(f"[{start},900]<0,300,0>甲<300,300,0>乙<600,300,0>丙")
    return "\n".join(lines)


class KrcDecodeTests(unittest.TestCase):
    def test_decodes_real_packing(self):
        self.assertEqual(kugou_lyric.decode_krc(encode_krc("你好")), "你好")

    def test_rejects_empty_and_short_payload(self):
        for raw in ("", "   ", base64.b64encode(b"\x01\x02").decode("ascii")):
            self.assertEqual(kugou_lyric.decode_krc(raw), "", repr(raw))

    def test_warns_on_undecodable_payload(self):
        # 4 字节头 + 随机字节: 不是 zlib 流, 必须留日志而不是静默返回空。
        payload = base64.b64encode(b"\x0a\x0b\x0c\x0d" + b"\xff" * 64).decode("ascii")
        with self.assertLogs("provider_bridge.kugou_lyric", level="WARNING"):
            self.assertEqual(kugou_lyric.decode_krc(payload), "")


class KrcConversionTests(unittest.TestCase):
    def test_word_time_is_relative_to_line_start(self):
        """酷狗词时间是相对行首的毫秒, 必须换算成绝对毫秒(与网易 YRC 不同)。"""
        converted = kugou_lyric.krc_to_verbatim_lrc(SAMPLE_KRC)
        lines = converted.split("\n")
        self.assertEqual(
            lines[0],
            "[00:43.256]故[00:43.728]事[00:44.120]的[00:44.600]小[00:45.424]黄[00:45.912]花",
        )
        # 无词单元的行退化成整行一个时间戳(前端按行级高亮)。
        self.assertEqual(lines[1], "[03:08.000]没有词级的整行")
        self.assertEqual(len(lines), 2, "空行/噪音行/元信息行都应被跳过")

    def test_output_satisfies_frontend_karaoke_contract(self):
        """前端只有在一行里切出 >= 2 段时才做逐字填色, 这里按它的规则验证。"""
        converted = kugou_lyric.krc_to_verbatim_lrc(SAMPLE_KRC)
        first_line = converted.split("\n")[0]
        segments = frontend_segments(first_line)
        self.assertGreaterEqual(len(segments), 2)
        self.assertEqual([text for _t, text in segments], ["故", "事", "的", "小", "黄", "花"])
        self.assertAlmostEqual(segments[0][0], 43.256, places=3)
        self.assertAlmostEqual(segments[-1][0], 45.912, places=3)

    def test_word_level_line_count_matches_frontend_rule(self):
        converted = kugou_lyric.krc_to_verbatim_lrc(SAMPLE_KRC)
        self.assertEqual(kugou_lyric.word_level_line_count(converted), 1)
        self.assertEqual(
            kugou_lyric.word_level_line_count(converted),
            sum(1 for line in converted.split("\n") if len(frontend_segments(line)) >= 2),
        )

    def test_returns_empty_for_unusable_input(self):
        for raw in ("", "   ", "没有时间戳的文本", "[0,0]<0,0,0>"):
            self.assertEqual(kugou_lyric.krc_to_verbatim_lrc(raw), "", repr(raw))


def candidate(identifier, accesskey, song, singer):
    return {"id": identifier, "accesskey": accesskey, "song": song, "singer": singer}


class FakeSession:
    """假的 requests.Session: 记录请求 URL 并按队列返回 JSON。"""

    def __init__(self, search_payload, downloads):
        self.search_payload = search_payload
        self.downloads = downloads
        self.urls = []

    def request(self, method, url, **kwargs):
        self.urls.append(url)
        payload = self.search_payload if "lyrics.kugou.com/search" in url else self.downloads.pop(0)

        class Response:
            def __init__(self, body):
                self.content = body.encode("utf-8")

            def raise_for_status(self):
                return None

        return Response(json.dumps(payload))


class KrcFetchTests(unittest.TestCase):
    def test_fetch_converts_downloaded_krc(self):
        session = FakeSession(
            {"status": 200, "candidates": [candidate("699230137", "KEY1", "晴天", "周杰伦")]},
            [{"content": encode_krc(SAMPLE_KRC)}],
        )
        converted = kugou_lyric.fetch_verbatim_lyric(
            "晴天", "周杰伦", duration_s=269, file_hash="abc123", session=session,
        )
        self.assertIn("[00:43.256]故", converted)
        self.assertIn("keyword=" + "%E5%91%A8%E6%9D%B0%E4%BC%A6+-+%E6%99%B4%E5%A4%A9", session.urls[0])
        self.assertIn("duration=269", session.urls[0])
        self.assertIn("hash=abc123", session.urls[0])
        self.assertIn("fmt=krc", session.urls[1])
        self.assertIn("id=699230137", session.urls[1])
        self.assertIn("accesskey=KEY1", session.urls[1])

    def test_picks_name_matching_candidate_over_first(self):
        """快照盲取 candidates[0]; 实测首条常是片段/翻唱, 必须按歌名歌手挑。

        命中一个词级行足够的候选后必须立刻停止(每首歌默认只打一次歌词下载请求)。
        """
        session = FakeSession(
            {
                "status": 200,
                "candidates": [
                    candidate("1", "K1", "晴天 (吉他版)", "某某"),
                    candidate("2", "K2", "晴天", "周杰伦"),
                ],
            },
            [{"content": encode_krc(long_krc())}],
        )
        converted = kugou_lyric.fetch_verbatim_lyric("晴天", "周杰伦", session=session)
        self.assertEqual(kugou_lyric.word_level_line_count(converted), 16)
        self.assertEqual(len(session.urls), 2, "只该下载命中的那一个候选")
        self.assertIn("id=2", session.urls[1])

    def test_reuses_first_candidate_when_nothing_matches_by_name(self):
        """一个候选都匹配不上时退回原顺序(与快照 candidates[0] 的行为一致), 而不是空手而归。"""
        session = FakeSession(
            {"status": 200, "candidates": [candidate("7", "K7", "别的歌", "别人")]},
            [{"content": encode_krc(long_krc())}],
        )
        converted = kugou_lyric.fetch_verbatim_lyric("晴天", "周杰伦", session=session)
        self.assertIn("id=7", session.urls[1])
        self.assertEqual(kugou_lyric.word_level_line_count(converted), 16)

    def test_tries_next_candidate_when_first_has_no_word_level_data(self):
        session = FakeSession(
            {
                "status": 200,
                "candidates": [candidate("1", "K1", "稻香", "周杰伦"), candidate("2", "K2", "稻香", "周杰伦")],
            },
            [
                {"content": encode_krc("[0,0]没有词级的整行")},
                {"content": encode_krc(SAMPLE_KRC)},
            ],
        )
        converted = kugou_lyric.fetch_verbatim_lyric("稻香", "周杰伦", session=session)
        self.assertEqual(kugou_lyric.word_level_line_count(converted), 1)
        self.assertIn("id=1", session.urls[1], "第一个候选要先试")
        self.assertIn("id=2", session.urls[2], "第一个候选没有词级数据时必须试下一个")

    def test_returns_empty_without_candidates(self):
        session = FakeSession({"status": 200, "candidates": []}, [])
        self.assertEqual(kugou_lyric.fetch_verbatim_lyric("孤勇者", "陈奕迅", session=session), "")

    def test_returns_empty_when_search_fails(self):
        with mock.patch.object(kugou_lyric.PlatformHTTP, "get", side_effect=RuntimeError("boom")):
            with self.assertLogs("provider_bridge.kugou_lyric", level="WARNING"):
                self.assertEqual(kugou_lyric.fetch_verbatim_lyric("晴天", "周杰伦"), "")

    def test_returns_empty_without_song_name(self):
        self.assertEqual(kugou_lyric.fetch_verbatim_lyric("", "周杰伦"), "")

    def test_kill_switch(self):
        with mock.patch.dict("os.environ", {"MELODEX_KUGOU_VERBATIM_LYRIC": "0"}):
            self.assertFalse(kugou_lyric.verbatim_lyric_enabled())
        with mock.patch.dict("os.environ", {}, clear=False):
            self.assertTrue(kugou_lyric.verbatim_lyric_enabled())


class FakeKugouSong:
    def todict(self):
        return {
            "identifier": "9d2b73c2f0a1b3c4d5e6f708192a3b4c",
            "song_name": "晴天",
            "singers": "周杰伦",
            "duration_s": 269,
            "ext": "mp3",
            "download_url": "https://example.invalid/a.mp3",
            "lyric": "[00:02.000]行级歌词",
        }


class FakeKugouClient:
    def __init__(self, **kwargs):
        pass

    def search(self, keyword):
        return [FakeKugouSong()]


class KugouVerbatimWiringTests(unittest.TestCase):
    def _search(self):
        with tempfile.TemporaryDirectory() as work_dir:
            return bridge_app.search(
                {"source": "kugou", "keyword": "周杰伦 晴天", "limit": 5, "cookie": ""},
                client_factory=FakeKugouClient,
                work_dir=work_dir,
            )

    def test_verbatim_lyric_replaces_line_level_lyric(self):
        with mock.patch.object(
            kugou_lyric, "fetch_verbatim_lyric", return_value="[00:43.256]故[00:43.728]事"
        ) as fetch:
            result = self._search()
        extra = result["songs"][0]["extra"]
        self.assertEqual(extra["lyric"], "[00:43.256]故[00:43.728]事")
        self.assertEqual(extra["lyric_verbatim"], "1")
        # 歌名/歌手/时长/hash(identifier)都要传下去。
        self.assertEqual(fetch.call_args.args[:2], ("晴天", "周杰伦"))
        self.assertEqual(fetch.call_args.kwargs["duration_s"], 269)
        self.assertEqual(fetch.call_args.kwargs["file_hash"], "9d2b73c2f0a1b3c4d5e6f708192a3b4c")

    def test_line_level_lyric_kept_when_no_verbatim(self):
        with mock.patch.object(kugou_lyric, "fetch_verbatim_lyric", return_value=""):
            result = self._search()
        extra = result["songs"][0]["extra"]
        self.assertEqual(extra["lyric"], "[00:02.000]行级歌词")
        self.assertNotIn("lyric_verbatim", extra)

    def test_disabled_switch_keeps_line_level_lyric(self):
        with mock.patch.dict("os.environ", {"MELODEX_KUGOU_VERBATIM_LYRIC": "0"}):
            with mock.patch.object(kugou_lyric, "fetch_verbatim_lyric") as fetch:
                result = self._search()
        fetch.assert_not_called()
        self.assertEqual(result["songs"][0]["extra"]["lyric"], "[00:02.000]行级歌词")

    def test_other_sources_are_not_enriched(self):
        """逐字歌词只给自己的源用, 不做跨源匹配 —— QQ 的歌不能被塞进酷狗歌词。"""
        with mock.patch.object(kugou_lyric, "fetch_verbatim_lyric") as fetch:
            with tempfile.TemporaryDirectory() as work_dir:
                bridge_app.search(
                    {"source": "migu", "keyword": "周杰伦 晴天", "limit": 5, "cookie": ""},
                    client_factory=FakeKugouClient,
                    work_dir=work_dir,
                )
        fetch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
