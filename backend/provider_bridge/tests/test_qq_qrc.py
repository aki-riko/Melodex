"""QQ 逐字歌词(QRC)解密与转换的测试。

关键用例直接用**真实抓取的密文**: tests/testdata/qq_qrc_fixture.json 是 2026-09 从
QQ `music.musichallSong.PlayLyricInfo/GetPlayLyricInfo`(qrc=1) 抓的 晴天/周杰伦 响应中
`lyric` 字段(9808 字符十六进制), 未做任何改动 —— 它同时是"这套 QQ 变体 DES 的移植是否
与上游等价"的判据: 移植里的位运算被改写成等价的序列/循环, 只有真密文能证明等价。
"""

import json
import pathlib
import unittest
from unittest import mock

from provider_bridge import qq_qrc


FIXTURE_PATH = pathlib.Path(__file__).with_name("testdata") / "qq_qrc_fixture.json"


def load_fixture() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def parse_plaintext_lines(plaintext: str):
    """按 QRC 明文形状解析出 (行起, 行时长, [(词起, 词时长, 文字)]) —— 用于校验时间基准。"""
    content = qq_qrc.lyric_content(plaintext)
    out = []
    for raw in content.splitlines():
        line = raw.strip()
        matched = qq_qrc._LINE_PATTERN.match(line)
        if matched is None:
            continue
        start, duration = int(matched.group(1)), int(matched.group(2))
        words = [
            (int(word.group("start")), int(word.group("duration")), word.group("content"))
            for word in qq_qrc._WORD_PATTERN.finditer(matched.group(3))
        ]
        if words:
            out.append((start, duration, words))
    return out


class RealFixtureDecryptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = load_fixture()
        cls.plaintext = qq_qrc.decrypt_qrc(cls.fixture["lyric_hex"])

    def test_fixture_is_the_real_hex_payload(self):
        self.assertEqual(self.fixture["name"], "晴天")
        self.assertEqual(self.fixture["artist"], "周杰伦")
        self.assertEqual(len(self.fixture["lyric_hex"]), 9808)
        self.assertTrue(all(c in "0123456789abcdefABCDEF" for c in self.fixture["lyric_hex"]))

    def test_decrypts_real_payload(self):
        """解密链路: 十六进制 -> QQ 变体 3DES -> zlib。当年按 base64 解 + 标准 3DES, 所以解不开。"""
        self.assertTrue(self.plaintext, "真实 QRC 没能解出明文")
        # 实测明文是 XML: <?xml ...?><QrcInfos>...<Lyric_1 LyricType="1" LyricContent="..."/>
        self.assertTrue(self.plaintext.startswith('<?xml version="1.0" encoding="utf-8"?>'))
        self.assertIn("<QrcInfos>", self.plaintext)
        self.assertIn('<Lyric_1 LyricType="1" LyricContent="', self.plaintext)
        self.assertIn("[ti:", self.plaintext)
        self.assertIn("晴天", self.plaintext)
        self.assertGreater(len(self.plaintext), 5000)

    def test_word_timestamps_are_absolute_within_line_span(self):
        """词时间必须是绝对毫秒: 每个词都要落在本行的 [行起, 行起+行时长] 内(留 3s 余量)。

        这条是"相对/绝对搞反"的判据 —— 网易 YRC 是绝对、酷狗 KRC 是相对, 弄错就整体错位。
        """
        lines = parse_plaintext_lines(self.plaintext)
        self.assertGreater(len(lines), 30, "真实歌词应有的词级行数不足")
        for start, duration, words in lines:
            for word_start, _word_duration, text in words:
                self.assertGreaterEqual(word_start, start, f"词早于行首: {text!r} @{word_start} < {start}")
                self.assertLessEqual(word_start, start + duration + 3000, f"词晚于行尾: {text!r} @{word_start}")

    def test_converts_real_payload_to_inline_verbatim_lrc(self):
        converted = qq_qrc.qrc_to_verbatim_lrc(self.plaintext)
        lines = [line for line in converted.splitlines() if line]
        self.assertGreater(len(lines), 30)
        word_level = [line for line in lines if line.count("[") >= 2]
        self.assertGreaterEqual(len(word_level), len(lines) - 2, "几乎每行都该是逐字行")
        # 标签行([ti:]/[ar:] 等)与纯时间戳行不能混进歌词。
        joined = "\n".join(lines)
        self.assertNotIn("[ti:", joined)
        self.assertNotIn("[ar:", joined)
        self.assertRegex(lines[0], r"^\[\d{2}:\d{2}\.\d{3}\]")

    def test_conversion_is_deterministic(self):
        self.assertEqual(
            qq_qrc.qrc_to_verbatim_lrc(self.plaintext),
            qq_qrc.qrc_to_verbatim_lrc(self.plaintext),
        )


class DecryptRobustnessTests(unittest.TestCase):
    def test_accepts_raw_bytes(self):
        fixture = load_fixture()
        blob = bytes.fromhex(fixture["lyric_hex"])
        self.assertEqual(qq_qrc.decrypt_qrc(blob), qq_qrc.decrypt_qrc(fixture["lyric_hex"]))

    def test_rejects_empty_and_truncated_payloads(self):
        for payload in ("", "   ", "zz", "0011223344"):
            with self.assertLogs("provider_bridge.qq_qrc", level="WARNING"):
                self.assertEqual(qq_qrc.decrypt_qrc(payload), "", repr(payload))

    def test_rejects_valid_length_but_not_zlib(self):
        payload = bytes(range(64)).hex()
        with self.assertLogs("provider_bridge.qq_qrc", level="WARNING"):
            self.assertEqual(qq_qrc.decrypt_qrc(payload), "")

    def test_qrc_bytes_prefers_hex_then_base64(self):
        self.assertEqual(qq_qrc.qrc_bytes("41424344"), b"ABCD")
        self.assertEqual(qq_qrc.qrc_bytes("QUJDRA=="), b"ABCD")


class ConversionEdgeCaseTests(unittest.TestCase):
    def test_unescapes_xml_attribute_entities(self):
        text = '<Lyric_1 LyricType="1" LyricContent="[0,1000]Rock &amp; Roll(0,500)是(500,500)我"/>'
        converted = qq_qrc.qrc_to_verbatim_lrc(text)
        self.assertIn("Rock & Roll", converted)

    def test_line_without_word_units_falls_back_to_line_level(self):
        text = '<Lyric_1 LyricType="1" LyricContent="[5000,2000]整行没有词单元"/>'
        self.assertEqual(qq_qrc.qrc_to_verbatim_lrc(text), "[00:05.000]整行没有词单元")

    def test_skips_tags_and_pure_timestamp_lines(self):
        text = (
            '<Lyric_1 LyricType="1" LyricContent="[ti:歌名]\n[ar:歌手]\n[1000,500](1000,500)\n'
            '[2000,1000]甲(2000,400)乙(2400,600)"/>'
        )
        converted = qq_qrc.qrc_to_verbatim_lrc(text)
        self.assertEqual(converted, "[00:02.000]甲[00:02.400]乙")

    def test_returns_empty_for_unusable_input(self):
        for raw in ("", "   ", "没有任何结构", "<Lyric_1 LyricType=\"1\" LyricContent=\"\"/>"):
            self.assertEqual(qq_qrc.qrc_to_verbatim_lrc(raw), "", repr(raw))


class RequestParamTests(unittest.TestCase):
    def test_param_set_matches_what_produced_the_fixture(self):
        param = qq_qrc.qrc_request_param("0039MnYb0qxYhV", song_id=97773, name="晴天",
                                        artist="周杰伦", album="叶惠美", duration_s=269)
        self.assertEqual(param["qrc"], 1)
        self.assertEqual(param["crypt"], 1)
        self.assertEqual(param["ct"], 19)
        self.assertEqual(param["interval"], 269)
        self.assertEqual(param["songMID"], "0039MnYb0qxYhV")
        self.assertEqual(param["songID"], 97773)
        # 缺了这三个 base64 字段, 响应里就不会带 QRC 数据(实测)。
        self.assertEqual(__import__("base64").b64decode(param["songName"]).decode(), "晴天")
        self.assertEqual(__import__("base64").b64decode(param["singerName"]).decode(), "周杰伦")
        self.assertEqual(__import__("base64").b64decode(param["albumName"]).decode(), "叶惠美")

    def test_handles_missing_fields(self):
        param = qq_qrc.qrc_request_param("", song_id=0)
        self.assertEqual(param["songMID"], "")
        self.assertEqual(param["songID"], 0)
        self.assertEqual(param["interval"], 0)


class KillSwitchTests(unittest.TestCase):
    def test_disabled_by_env(self):
        with mock.patch.dict("os.environ", {"MELODEX_QQ_VERBATIM_LYRIC": "0"}):
            self.assertFalse(qq_qrc.verbatim_enabled())
        with mock.patch.dict("os.environ", {}, clear=False):
            self.assertTrue(qq_qrc.verbatim_enabled())


if __name__ == "__main__":
    unittest.main()
