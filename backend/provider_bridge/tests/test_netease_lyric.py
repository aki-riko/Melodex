"""网易逐字歌词(YRC)取回与转换的测试。

YRC 形状与"元信息行是 JSON"这两个前提都来自对真实接口的实测, 这里用合成样本锁定,
避免联网就能回归。
"""

import re
import tempfile
import unittest
from unittest import mock

from provider_bridge import app as bridge_app
from provider_bridge import netease_lyric


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


SAMPLE_YRC = "\n".join([
    '{"t":0,"c":[{"tx":"作词: "},{"tx":"唐恬"}]}',          # 元信息(JSON) → 必须跳过
    "[2310,5460](2310,3850,0)都 (6160,440,0)是(6600,330,0)勇(6930,290,0)敢(7220,550,0)的",
    "[9000,1000]没有词级的整行",                              # 无词单元 → 整行一个时间戳
    "",
    "整行没有时间戳的噪音",
])


class YRCConversionTests(unittest.TestCase):
    def test_converts_word_level_line_to_inline_timestamps(self):
        converted = netease_lyric.yrc_to_verbatim_lrc(SAMPLE_YRC)
        lines = converted.split("\n")
        self.assertEqual(lines[0], "[00:02.310]都 [00:06.160]是[00:06.600]勇[00:06.930]敢[00:07.220]的")
        # 无词级数据的行退化成整行一个时间戳(前端按行级高亮)。
        self.assertEqual(lines[1], "[00:09.000]没有词级的整行")
        self.assertEqual(len(lines), 2, "元信息 JSON 行与无时间戳噪音行都应被跳过")

    def test_output_satisfies_frontend_karaoke_contract(self):
        """前端只有在一行里切出 >=2 段时才做逐字填色, 这里按它的规则验证。"""
        converted = netease_lyric.yrc_to_verbatim_lrc(SAMPLE_YRC)
        first_line = converted.split("\n")[0]
        segments = frontend_segments(first_line)
        self.assertGreaterEqual(len(segments), 2)
        self.assertEqual([text for _t, text in segments], ["都 ", "是", "勇", "敢", "的"])
        self.assertAlmostEqual(segments[0][0], 2.31, places=3)
        self.assertAlmostEqual(segments[-1][0], 7.22, places=3)

    def test_timestamp_rolls_over_minutes(self):
        converted = netease_lyric.yrc_to_verbatim_lrc("[125000,1000](125000,500,0)甲(125500,500,0)乙")
        self.assertEqual(converted, "[02:05.000]甲[02:05.500]乙")

    def test_returns_empty_for_unusable_input(self):
        for raw in ("", "   ", '{"t":0,"c":[]}', "没有任何时间戳的文本"):
            self.assertEqual(netease_lyric.yrc_to_verbatim_lrc(raw), "", repr(raw))

    def test_fetch_returns_empty_on_failure(self):
        with mock.patch.object(netease_lyric.PlatformHTTP, "post_form", side_effect=RuntimeError("boom")):
            with self.assertLogs("provider_bridge.netease_lyric", level="WARNING"):
                self.assertEqual(netease_lyric.fetch_verbatim_lyric("1901371647"), "")

    def test_fetch_skips_non_numeric_song_id(self):
        self.assertEqual(netease_lyric.fetch_verbatim_lyric("loc:abc"), "")

    def test_fetch_converts_yrc_payload(self):
        payload = {"yrc": {"lyric": SAMPLE_YRC}}
        with mock.patch.object(netease_lyric.PlatformHTTP, "post_form", return_value=payload):
            converted = netease_lyric.fetch_verbatim_lyric("1901371647")
        self.assertIn("[00:02.310]都 ", converted)

    def test_kill_switch(self):
        with mock.patch.dict("os.environ", {"MELODEX_NETEASE_VERBATIM_LYRIC": "0"}):
            self.assertFalse(netease_lyric.verbatim_lyric_enabled())
        with mock.patch.dict("os.environ", {}, clear=False):
            self.assertTrue(netease_lyric.verbatim_lyric_enabled())


class FakeNeteaseSong:
    def todict(self):
        return {
            "identifier": "1901371647",
            "song_name": "孤勇者",
            "singers": "陈奕迅",
            "ext": "mp3",
            "download_url": "https://example.invalid/a.mp3",
            "lyric": "[00:02.000]行级歌词",
        }


class FakeNeteaseClient:
    def __init__(self, **kwargs):
        pass

    def search(self, keyword):
        return [FakeNeteaseSong()]


class NeteaseVerbatimWiringTests(unittest.TestCase):
    def _search(self):
        with tempfile.TemporaryDirectory() as work_dir:
            return bridge_app.search(
                {"source": "netease", "keyword": "孤勇者", "limit": 5, "cookie": ""},
                client_factory=FakeNeteaseClient,
                work_dir=work_dir,
            )

    def test_verbatim_lyric_replaces_line_level_lyric(self):
        with mock.patch.object(netease_lyric, "fetch_verbatim_lyric", return_value="[00:02.310]都 [00:06.160]是"):
            result = self._search()
        extra = result["songs"][0]["extra"]
        self.assertEqual(extra["lyric"], "[00:02.310]都 [00:06.160]是")
        self.assertEqual(extra["lyric_verbatim"], "1")

    def test_line_level_lyric_kept_when_no_verbatim(self):
        with mock.patch.object(netease_lyric, "fetch_verbatim_lyric", return_value=""):
            result = self._search()
        extra = result["songs"][0]["extra"]
        self.assertEqual(extra["lyric"], "[00:02.000]行级歌词")
        self.assertNotIn("lyric_verbatim", extra)

    def test_disabled_switch_keeps_line_level_lyric(self):
        with mock.patch.dict("os.environ", {"MELODEX_NETEASE_VERBATIM_LYRIC": "0"}):
            with mock.patch.object(netease_lyric, "fetch_verbatim_lyric") as fetch:
                result = self._search()
        fetch.assert_not_called()
        self.assertEqual(result["songs"][0]["extra"]["lyric"], "[00:02.000]行级歌词")


if __name__ == "__main__":
    unittest.main()
