# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only

import unittest

from melodex_desktop.lyrics import current_lyric_index, parse_lrc


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

    def test_empty_input_returns_empty_lines(self) -> None:
        self.assertEqual(parse_lrc(""), [])
        self.assertEqual(parse_lrc(None), [])


if __name__ == "__main__":
    unittest.main()
