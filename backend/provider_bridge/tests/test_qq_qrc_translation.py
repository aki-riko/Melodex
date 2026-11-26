"""QQ 逐字歌词里「内联译文行」的剔除测试。

用户报的缺陷：双语歌曲（**深蓝泡沫 / Hotcell**）的逐字歌词会跑到翻译那边去 ——
播放页与桌面歌词都错。实测根因：QQ 把**译文也排成了独立的歌词行**，与原文行交错
写在同一份 LyricContent 里：

    [6900,1770]Call (6900,240)my (7140,60)name ...   ← 原文（英语）行
    [8730,1020]唤 (8730,180)我 (8910,60)姓 ...        ← 紧随其后的中文译文行

前端 parseLRC 把译文行也当成普通歌词行，逐字填色于是画到译文上。

判别依据是同一次响应的 `trans` 表（平台按行给出译文，不需要译文时写 `//`），
**不是**"猜哪行像中文" —— 中文/日文歌本身就是 CJK，那样必然误伤。

关键用例全部使用**真实抓取的密文**：tests/testdata/qq_qrc_translation_fixture.json
是同一次 GetPlayLyricInfo(qrc=1) 响应的 lyric + trans 载荷，未做任何改动。
"""

import json
import pathlib
import re
import unittest

from provider_bridge import qq_qrc


FIXTURE_PATH = pathlib.Path(__file__).with_name("testdata") / "qq_qrc_translation_fixture.json"
# 前端 frontend/src/contexts/playerLyrics.mjs 的 parseLRC 时间戳正则。
FRONTEND_TIMESTAMP_RE = re.compile(r"\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]")
HAN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
LATIN = re.compile(r"[A-Za-z]")


def load_fixture() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def plain_lines(lrc: str) -> list[str]:
    """去掉时间戳后的纯文本行 —— 用来比对"哪些行还在"。"""
    return [FRONTEND_TIMESTAMP_RE.sub("", line).strip() for line in lrc.splitlines() if line.strip()]


def squeezed(lrc: str) -> str:
    """去掉时间戳与所有空白，用于"这句原文还在不在"的内容断言。"""
    return "".join(plain_lines(lrc)).replace(" ", "")


def karaoke_line_count(lrc: str) -> int:
    """前端只在同一行切出 >= 2 个时间戳时才做逐字填色。"""
    return sum(1 for line in lrc.splitlines() if len(FRONTEND_TIMESTAMP_RE.findall(line)) >= 2)


class RealBilingualFixtureTests(unittest.TestCase):
    """真实样本：深蓝泡沫 / Hotcell。"""

    @classmethod
    def setUpClass(cls):
        cls.fixture = load_fixture()
        cls.lyric_plain = qq_qrc.decrypt_qrc(cls.fixture["lyric_hex"])
        cls.trans_plain = qq_qrc.decrypt_qrc(cls.fixture["trans_hex"])
        cls.before = qq_qrc.qrc_to_verbatim_lrc(cls.lyric_plain)
        cls.after = qq_qrc.qrc_to_verbatim_lrc(cls.lyric_plain, cls.trans_plain)

    def test_fixture_is_the_real_payload_for_the_reported_song(self):
        self.assertEqual(self.fixture["name"], "深蓝泡沫")
        self.assertTrue(self.lyric_plain, "真实 QRC 没能解出明文")
        self.assertTrue(self.trans_plain, "真实 trans 表没能解出明文")
        # 未修复时译文行确实内联在载荷里（否则这个用例就没有意义了）。
        self.assertIn("唤", self.lyric_plain)
        self.assertIn("Call", self.lyric_plain)

    def test_translation_lines_are_dropped(self):
        before, after = plain_lines(self.before), plain_lines(self.after)
        dropped = [text for text in before if text not in after]
        self.assertGreater(len(dropped), 50, f"应剔除 50+ 条译文行，实际 {len(dropped)}")
        # ★ 核心断言：被剔除的必须是译文行 —— 一条拉丁字母都不许删，
        #   否则就是在删原文（那正是本次要修的缺陷反向发生）。
        self.assertEqual(
            [text for text in dropped if LATIN.search(text)], [],
            "剔除译文行时误删了原文（拉丁）行",
        )
        self.assertTrue(all(HAN.search(text) for text in dropped), "被剔除的行都应是译文行")

    def test_source_language_lines_are_all_kept(self):
        before, after = plain_lines(self.before), plain_lines(self.after)
        source_before = [text for text in before if LATIN.search(text) and not HAN.search(text)]
        source_after = [text for text in after if LATIN.search(text) and not HAN.search(text)]
        self.assertEqual(source_before, source_after, "原文行必须一条不少、顺序不变")
        self.assertGreater(len(source_after), 40, "这首歌的原文行应有 40+ 条")

    def test_reported_lyric_content_still_present(self):
        """用户实际会看到的几句原文必须还在（防止"修好后整首歌没了"）。"""
        content = squeezed(self.after)
        for expected in (
            "CallmynameI'mfadingfadingfading",
            "thestarsarefallingsilently",
            "Intothedeep",
            "Soquietly",
        ):
            self.assertIn(expected, content, f"原文歌词缺失: {expected}")

    def test_output_stays_karaoke_shaped(self):
        """剔除后仍然是逐字 LRC：前端靠"一行 >=2 个时间戳"判定逐字。"""
        self.assertGreaterEqual(karaoke_line_count(self.after), 40)
        self.assertGreater(karaoke_line_count(self.after), karaoke_line_count(self.before) / 2)

    def test_translation_table_markers_are_understood(self):
        table = qq_qrc.translation_table(self.trans_plain)
        self.assertGreater(len(table), 100)
        self.assertIn("//", table.values(), "平台用 // 表示该行不需要译文")
        self.assertIn("唤我姓名 我正逐渐消散 消散 消散", table.values())

    def test_conversion_is_deterministic(self):
        self.assertEqual(
            qq_qrc.qrc_to_verbatim_lrc(self.lyric_plain, self.trans_plain),
            self.after,
        )

    def test_empty_translation_table_keeps_legacy_behaviour(self):
        """不传译文表（老调用点/译文解密失败）必须与旧行为逐字一致。"""
        self.assertEqual(qq_qrc.qrc_to_verbatim_lrc(self.lyric_plain), self.before)
        self.assertEqual(qq_qrc.qrc_to_verbatim_lrc(self.lyric_plain, ""), self.before)


class UntouchedSongTests(unittest.TestCase):
    """没有内联译文行的歌曲必须一行都不动（中文/日文/欧美歌一律不得被误伤）。"""

    def test_chinese_song_without_trans_table_is_unchanged(self):
        content = (
            '[ti:晴天]\n[ar:周杰伦]\n'
            '[29264,3446]故(29264,700)事(29964,600)的(30564,600)小(31164,700)黄(31864,846)花\n'
            '[32710,3537]从(32710,700)出(33410,700)生(34110,700)那(34810,800)年(35610,637)就(36247,600)飘(36847,600)着\n'
        )
        plain = f'<Lyric_1 LyricType="1" LyricContent="{content}"/>'
        converted = qq_qrc.qrc_to_verbatim_lrc(plain)
        self.assertIn("[00:29.264]故", converted)
        self.assertIn("[00:32.710]从", converted)
        self.assertEqual(len(plain_lines(converted)), 2)

    def test_japanese_song_with_sparse_trans_is_unchanged(self):
        """日文原唱（Lemon 形态）：trans 只有零星几条译文，不是"内联译文"形态。"""
        content = (
            '[ti:Lemon]\n'
            '[1547,1152]夢(1547,165)な(1712,223)ら(1935,377)ば(2312,387)\n'
            '[2880,4002]ど(2880,168)れ(3048,176)ほ(3224,184)ど(3408,304)\n'
        )
        trans = "[ti:]\n[00:01.54]如果只是一场梦\n[00:02.88]那该有多好\n"
        converted = qq_qrc.qrc_to_verbatim_lrc(
            f'<Lyric_1 LyricType="1" LyricContent="{content}"/>', trans,
        )
        self.assertEqual(len(plain_lines(converted)), 2, "日文歌的逐字行不能被当成译文删掉")

    def test_english_song_with_full_trans_is_unchanged(self):
        """欧美歌（Shape of You 形态）：译文表齐全是齐，但译文并没有内联进歌词行。"""
        content = (
            "[ti:Shape of You]\n"
            "[9551,2445]The(9551,126)club(9677,143)isn't(9820,175)the(9995,225)best(10220,200)place\n"
            "[11996,3010]So(11996,113)the(12109,221)bar(12330,223)is(12553,304)where(12857,200)I(13057,199)go\n"
        )
        trans = "[ti:]\n[00:09.55]俱乐部不是找另一半的绝佳场所\n[00:11.99]所以酒吧很适合我\n"
        converted = qq_qrc.qrc_to_verbatim_lrc(
            f'<Lyric_1 LyricType="1" LyricContent="{content}"/>', trans,
        )
        self.assertEqual(len(plain_lines(converted)), 2)
        self.assertIn("Theclubisn'tthebest", squeezed(converted))


class DetectionRuleTests(unittest.TestCase):
    """把判定规则本身钉死，避免以后被"看起来更聪明"的启发式改坏。"""

    def _rows(self, content: str, trans: str):
        plain = f'<Lyric_1 LyricType="1" LyricContent="{content}"/>'
        rows = []
        for raw in qq_qrc.lyric_content(plain).splitlines():
            matched = qq_qrc._LINE_PATTERN.match(raw.strip())
            if matched is None:
                continue
            body = matched.group(3)
            words = [(int(w.group("start")), w.group("content"))
                     for w in qq_qrc._WORD_PATTERN.finditer(body)]
            rows.append((int(matched.group(1)), int(matched.group(2)),
                         "".join(w[1] for w in words), words))
        return rows, trans

    def test_keeps_source_lines_and_drops_translation_lines(self):
        content = (
            "[6900,1770]Call(6900,240) my(7140,60) name(7200,240)\n"
            "[8730,1020]唤(8730,180)我(8910,60)姓(8970,60)名\n"
            "[9840,450]Ooh(9840,30) we're(9870,60) slowly(9930,150)\n"
            "[10350,480]噢(10350,60)我(10410,60)们(10470,60)\n"
        )
        trans = "[00:06.90]唤我姓名\n[00:08.73]//\n[00:09.84]噢 我们\n[00:10.35]//\n"
        rows, trans_text = self._rows(content, trans)
        kept, dropped = qq_qrc.strip_inline_translation_lines(rows, trans_text)
        self.assertEqual(dropped, 2)
        self.assertEqual([row[2] for row in kept], ["Call my name", "Ooh we're slowly"])

    def test_does_not_use_the_neighbours_translation(self):
        """译文行之间只差 33ms：一对一匹配，元信息行不许抢到邻行译文。"""
        content = (
            "[0,24]深(0,6)蓝(6,6)泡(12,6)沫(18,6)\n"
            "[33,24]歌(33,8)手(41,8)：Hotcell(49,8)\n"
            "[300,600]企(300,60)划(360,60)：果汁(420,60)\n"
            "[6900,1770]Call(6900,240) my(7140,60) name(7200,240)\n"
            "[8730,1020]唤(8730,180)我(8910,60)姓(8970,60)名(9030,120)\n"
        )
        trans = (
            "[00:00.00]//\n[00:00.03]//\n[00:00.30]//\n"
            "[00:06.90]唤我姓名\n[00:08.73]//\n"
        )
        rows, trans_text = self._rows(content, trans)
        kept, dropped = qq_qrc.strip_inline_translation_lines(rows, trans_text)
        self.assertEqual(dropped, 1, "只该删掉那条真正的中文译文行")
        kept_texts = [row[2] for row in kept]
        self.assertEqual(len(kept_texts), 4)
        self.assertIn("Call my name", kept_texts)
        self.assertIn("歌手：Hotcell", kept_texts, "元信息行不许抢到邻行译文")
        self.assertNotIn("唤我姓名", kept_texts)

    def test_requires_high_translation_coverage(self):
        """trans 只覆盖少数几行时不认为整首是"内联译文"形态 → 一行都不动。

        ★ 必须让"被删的行"真的凑成候选形态（脚本不相交 + 紧跟原文行），
          只放无关行的话，门槛去掉后结果照样不变（本文件踩过）。
          这里 4 行里只有 1 行有条目 → 覆盖 25% < 80%，整首跳过。
        """
        content = (
            "[1000,500]Call(1000,100) my(1100,100)\n"
            "[1500,500]唤(1500,100)我(1600,100)\n"
            "[2000,500]Next(2000,100) line(2100,100)\n"
            "[2500,500]下(2500,100)一(2600,100)\n"
        )
        trans = "[00:01.00]唤我\n"
        rows, trans_text = self._rows(content, trans)
        kept, dropped = qq_qrc.strip_inline_translation_lines(rows, trans_text)
        self.assertEqual(dropped, 0)
        self.assertEqual(len(kept), 4, "覆盖率不足时一行都不许动")

    def test_translation_entry_is_never_reused_by_two_rows(self):
        """译文条目一对一匹配：一条译文不能同时盖在两条 QRC 行上。

        真实数据里行首挨得很近（实测元信息行 33ms/66ms 相隔），覆盖率门槛算的是
        "匹配上了几条"。允许复用的话，一条译文能把好几行都标成"有译文"，
        形态判断随之走偏，真正的译文行反而判不出来。
        """
        table = qq_qrc.translation_table("[00:01.00]唤我姓名\n")
        starts = [1000, 1030, 1060]
        matched = qq_qrc._match_translations(starts, table)
        labelled = [label for label in matched if label is not None]
        self.assertEqual(labelled, ["唤我姓名"], "同一条译文只能被匹配一次")
        self.assertEqual(matched.count(None), 2)

    def test_translation_entries_are_matched_one_to_one(self):
        """译文条目一对一匹配：同一条译文不能被两行都拿去用。

        `_match_translations` 分两阶段：先精确命中，再对剩余条目做 ±40ms 的最近匹配。
        要验证的是**第二阶段**的独占性。

        实测有效的判别样本（前两组无论是否复用结果都一样，区分不出来）：
          starts=[1000, 1080, 1120]，table={1000:A, 1100:B}
          不复用 → [A, B, None]   1120 拿不到（B 已被 1080 占掉）
          复用   → [A, B, B]      1120 也拿到 B

        为什么这条重要：1120 若是纯汉字行，被误标成"有译文"就永远删不掉；
        反过来，若去掉独占性，覆盖率也会被虚高，形态判断随之走偏。
        """
        table = qq_qrc.translation_table("[00:01.00]唤我\n[00:01.10]姓名\n")
        labels = qq_qrc._match_translations([1000, 1080, 1120], table)
        self.assertEqual(
            labels, ["唤我", "姓名", None],
            f"1120ms 的行不许复用 1100 的译文（实际 {labels}）",
        )

    def test_consecutive_translation_lines_are_all_dropped(self):
        """原文行后面连着两条译文行时，两条都要删掉（不能只删第一条就停）。

        样本必须让"最后一行"是原文锚点，否则它自己也会被当成译文行删掉
        （纯汉字 + 紧跟拉丁行 + 无译文 = 就是译文行的形态）。
        """
        content = (
            "[1000,500]Call(1000,100) my(1100,100)\n"       # 原文
            "[1500,500]唤(1500,100)我(1600,100)姓(1700,100)\n"  # 译文 1
            "[2000,500]名(2000,100)字(2100,100)啊(2200,100)\n"  # 译文 2
            "[2500,500]Next(2500,100) line(2600,100)\n"      # 原文
        )
        trans = "[00:01.00]唤我\n[00:01.50]//\n[00:02.00]//\n[00:02.50]下一句\n"
        rows, trans_text = self._rows(content, trans)
        kept, dropped = qq_qrc.strip_inline_translation_lines(rows, trans_text)
        kept_texts = [row[2] for row in kept]
        self.assertEqual(dropped, 2, "连续两条译文行必须都删掉")
        self.assertEqual(kept_texts, ["Call my", "Next line"], f"实际保留 {kept_texts}")

    def test_mixed_script_lines_are_never_dropped(self):
        """原文里本来就混着别的脚本（中文歌的英文和声）→ 脚本相交，不剔除。

        ★ 这个用例必须**同时**含一条"真该删的纯译文行"做对照：
          只断言"混排行还在"的话，规则就算被整条改坏也照样通过（本文件踩过）。
        ★ 也要求每行都有译文表条目，否则覆盖率门槛（>=80%）会把整首直接跳过。
        ★ 混排行必须**紧跟**在原文行之后（真实数据的形态），否则它根本走不到判定分支。
        """
        content = (
            "[1000,500]Call(1000,100) my(1100,100) name\n"       # 原文（拉丁），有译文
            "[1500,500]Oh(1500,100) 就这样吧(1600,100)\n"        # 中英混排，无译文 → 保留
            "[2000,500]Next(2000,100) line(2100,100) here\n"      # 原文（拉丁），有译文
            "[2500,500]下(2500,100)一(2600,100)句(2700,100)\n"    # 纯汉字，无译文 → 剔除
        )
        trans = "[00:01.00]唤我姓名\n[00:01.50]//\n[00:02.00]下一句\n[00:02.50]//\n"
        rows, trans_text = self._rows(content, trans)
        kept, dropped = qq_qrc.strip_inline_translation_lines(rows, trans_text)
        kept_texts = [row[2] for row in kept]
        self.assertEqual(dropped, 1, "纯汉字无译文行应被剔除")
        self.assertEqual(len(kept_texts), 3)
        self.assertIn("Call my", kept_texts)
        self.assertIn("Oh 就这样吧", kept_texts, "中英混排行是原文，不能删")
        self.assertIn("Next line", kept_texts)
        self.assertNotIn("下一句", kept_texts)

    def test_timestamp_tolerance_matches_real_drift(self):
        """trans 时间戳只到 10ms，实测与 QRC 行首差 7ms（Lemon 1547 vs 1540）。"""
        content = "[1547,1152]夢(1547,165)な(1712,223)ら(1935,377)\n"
        trans = "[00:01.54]如果只是一场梦\n"
        starts = [1547]
        matched = qq_qrc._match_translations(starts, qq_qrc.translation_table(trans))
        self.assertEqual(matched, ["如果只是一场梦"])

    def test_same_timestamp_pinyin_line_is_never_dropped(self):
        """同一时间戳的拼音行（双语歌词的另一种形态）不能被当成"译文行"删掉。

        这类行与原文行**同戳**，是行内并列的另一种读法，不是"紧跟其后的独立译文行"。
        实测数据见 `playerLyrics.test.mjs` 的 `qqBilingual`（44.88 原文 + 44.88 拼音）。
        判据里的"一对一匹配"保证同戳译文已被原文行占掉，拼音行拿不到真译文；
        但它与原文**同戳** ⇒ 这里显式断言它仍在。

        ★ 样本必须**每行**都有译文表条目（见 test_mixed_script_lines_are_never_dropped）。
        """
        content = (
            "[44880,6230]冲(44880,190)得(45070,210)破(45280,380)盲(45660,370)点(46030,740)\n"
            "[44880,6230]cong(44880,190) da(45070,210) po(45280,380) mang(45660,370)\n"
            "[51110,1230]TWINS(51110,620)：\n"
            "[52140,2390]让(52140,200)二(52340,280)人(52620,340)划(52960,310)破(53270,270)黑(53540,400)夜(53940,590)\n"
        )
        trans = (
            "[00:44.88]冲得破盲点\n[00:44.88]cong da po mang\n"
            "[00:51.11]TWINS：\n[00:52.14]让二人划破黑夜\n"
        )
        rows, trans_text = self._rows(content, trans)
        kept, dropped = qq_qrc.strip_inline_translation_lines(rows, trans_text)
        kept_texts = [row[2] for row in kept]
        self.assertEqual(dropped, 0, "同戳拼音行与原文行都必须保留")
        self.assertEqual(len(kept_texts), 4)
        self.assertIn("冲得破盲点", kept_texts)
        self.assertIn("cong da po mang", kept_texts)

    def test_no_trans_table_is_a_noop(self):
        content = "[1000,500]第一行(1000,500)\n[2000,500]第二行(2000,500)\n"
        rows, _ = self._rows(content, "")
        for table in ("", "   ", "[ti:只有标签]"):
            kept, dropped = qq_qrc.strip_inline_translation_lines(rows, table)
            self.assertEqual((len(kept), dropped), (2, 0))

    def test_kept_lines_keep_their_original_word_timestamps(self):
        """剔除译文行只删行，**不能动**保留行的词时间（填色节奏原样保留）。"""
        content = (
            "[6900,1770]Call(6900,240) my(7140,60) name(7200,240)\n"
            "[8730,1020]唤(8730,180)我(8910,60)姓(8970,60)名(9030,120)\n"
            "[9840,450]Ooh(9840,30) we're(9870,60) slowly(9930,150)\n"
        )
        trans = "[00:06.90]唤我姓名\n[00:08.73]//\n[00:09.84]噢 我们\n"
        rows, trans_text = self._rows(content, trans)
        kept, dropped = qq_qrc.strip_inline_translation_lines(rows, trans_text)
        self.assertEqual(dropped, 1)
        self.assertEqual(
            [segments for _start, _duration, _text, segments in kept],
            [
                [(6900, "Call"), (7140, " my"), (7200, " name")],
                [(9840, "Ooh"), (9870, " we're"), (9930, " slowly")],
            ],
            "保留行的词时间必须逐项不变（改动会让逐字填色节奏错位）",
        )


if __name__ == "__main__":
    unittest.main()
