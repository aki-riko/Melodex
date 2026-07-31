# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only

import unittest

from melodex_desktop.lyrics import (
    current_lyric_index,
    parse_lrc,
    secondary_lyric_index,
)


class LyricsTests(unittest.TestCase):
    def test_parses_line_and_word_timestamps(self) -> None:
        lines = parse_lrc(
            "[ar:周杰伦]\n"
            "[00:01.00]第一行\n"
            "[00:04.50]第[00:04.90]二[00:05.20]行\n"
        )
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0]["text"], "第一行")
        self.assertEqual(lines[0]["words"], [])
        self.assertEqual(lines[0]["end"], 4.5)

        self.assertEqual(lines[1]["text"], "第二行")
        self.assertEqual([word["s"] for word in lines[1]["words"]], ["第", "二", "行"])
        self.assertEqual(lines[1]["words"][0]["end"], 4.9)
        self.assertEqual(lines[1]["words"][-1]["end"], 9.5)

    def test_sorts_lines_and_ignores_empty_metadata(self) -> None:
        lines = parse_lrc("[00:08]后\n[ti:标题]\n[00:02.25]前\n")
        self.assertEqual([line["text"] for line in lines], ["前", "后"])
        self.assertEqual([line["t"] for line in lines], [2.25, 8.0])

    def test_finds_current_line_boundaries(self) -> None:
        lines = parse_lrc("[00:01]一\n[00:03]二\n[00:05]三")
        self.assertEqual(current_lyric_index(lines, 0.99), -1)
        self.assertEqual(current_lyric_index(lines, 1.0), 0)
        self.assertEqual(current_lyric_index(lines, 4.99), 1)
        self.assertEqual(current_lyric_index(lines, 99), 2)

    def test_same_timestamp_group_keeps_real_qq_source_order(self) -> None:
        lines = parse_lrc(
            "[00:44.88]冲[00:45.07]得[00:45.28]破[00:45.66]盲[00:46.03]点"
            "[00:46.77] [00:46.77]找[00:47.40]到[00:47.70]光[00:48.34]点[00:50.78]\n"
            "[00:44.88]cong [00:45.07]da [00:45.28]po [00:45.66]mang "
            "[00:46.03]din [00:46.77] [00:46.77]zou [00:47.40]dou "
            "[00:47.70]guong [00:48.34]din [00:50.78]\n"
            "[00:51.11]TWINS：[00:51.73]\n"
            "[00:52.14]让[00:52.34]二[00:52.62]人[00:52.96]划[00:53.27]破"
            "[00:53.54]黑[00:53.94]夜[00:54.53]\n"
        )

        self.assertEqual(
            [line["text"] for line in lines],
            [
                "冲得破盲点 找到光点",
                "cong da po mang din  zou dou guong din",
                "TWINS：",
                "让二人划破黑夜",
            ],
        )
        active_index = current_lyric_index(lines, 45.0)
        self.assertEqual(active_index, 0)
        self.assertEqual(secondary_lyric_index(lines, active_index), 1)
        self.assertEqual(current_lyric_index(lines, 51.2), 2)
        self.assertEqual(secondary_lyric_index(lines, 2), 3)
        self.assertAlmostEqual(lines[0]["end"], 51.11)
        self.assertAlmostEqual(lines[1]["end"], 51.11)

    def test_same_timestamp_group_does_not_force_companion_position(self) -> None:
        lines = parse_lrc(
            "[00:01.00]原文在前\n"
            "[00:01.00]translation after\n"
            "[00:03.00]translation before\n"
            "[00:03.00]原文在后\n"
        )

        first_group = current_lyric_index(lines, 1.5)
        self.assertEqual(lines[first_group]["text"], "原文在前")
        self.assertEqual(lines[secondary_lyric_index(lines, first_group)]["text"], "translation after")

        second_group = current_lyric_index(lines, 3.5)
        self.assertEqual(lines[second_group]["text"], "translation before")
        self.assertEqual(lines[secondary_lyric_index(lines, second_group)]["text"], "原文在后")

    def test_empty_input_returns_empty_lines(self) -> None:
        self.assertEqual(parse_lrc(""), [])
        self.assertEqual(parse_lrc(None), [])


if __name__ == "__main__":
    unittest.main()
