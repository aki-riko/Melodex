# SPDX-License-Identifier: AGPL-3.0-only

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


def card_blocks(source: str) -> list[str]:
    marker = "Fluent.Card {"
    blocks: list[str] = []
    cursor = 0

    while True:
        start = source.find(marker, cursor)
        if start < 0:
            return blocks

        opening_brace = source.find("{", start)
        depth = 0
        for index in range(opening_brace, len(source)):
            if source[index] == "{":
                depth += 1
            elif source[index] == "}":
                depth -= 1
                if depth == 0:
                    blocks.append(source[start : index + 1])
                    cursor = index + 1
                    break
        else:
            raise AssertionError("Fluent.Card 块缺少闭合大括号")


class CardPaddingContractTests(unittest.TestCase):
    def test_every_card_owns_exactly_one_explicit_content_inset(self):
        expected = {
            "qml/pages/LoginPage.qml": ["Fluent.Enums.spacing.xxxl"],
            "qml/pages/NowPlayingPage.qml": ["Fluent.Enums.spacing.xxl"],
            "qml/pages/PlaylistsPage.qml": [
                "Fluent.Enums.spacing.xl",
                "Fluent.Enums.spacing.xl",
            ],
            "qml/components/PlayerBar.qml": ["Fluent.Enums.spacing.xxl"],
            "qml/components/SongRow.qml": ["Fluent.Enums.spacing.l"],
            "qml/components/PlaybackQueueDrawer.qml": ["Fluent.Enums.spacing.l"],
            "qml/components/DesktopLyricsWindow.qml": ["Fluent.Enums.spacing.none"],
        }

        card_count = 0
        for relative_path, expected_paddings in expected.items():
            source = (ROOT / relative_path).read_text(encoding="utf-8")
            blocks = card_blocks(source)
            self.assertEqual(
                len(blocks),
                len(expected_paddings),
                f"{relative_path} 的 Card 数量发生变化，请同步更新内边距契约",
            )

            for block, padding in zip(blocks, expected_paddings, strict=True):
                self.assertEqual(block.count("contentPadding:"), 1, relative_path)
                self.assertIn(f"contentPadding: {padding}", block, relative_path)
            card_count += len(blocks)

        self.assertEqual(card_count, 8)


if __name__ == "__main__":
    unittest.main()
