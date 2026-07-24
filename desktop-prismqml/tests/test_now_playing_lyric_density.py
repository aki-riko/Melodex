# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only

import unittest
from pathlib import Path


NOW_PLAYING_QML = (
    Path(__file__).resolve().parents[1] / "qml" / "pages" / "NowPlayingPage.qml"
)


class NowPlayingLyricDensityTests(unittest.TestCase):
    def test_lyrics_use_compact_single_line_metrics(self) -> None:
        source = NOW_PLAYING_QML.read_text(encoding="utf-8")

        self.assertIn("itemHeight: 52", source)
        self.assertIn("listSpacing: Fluent.Enums.spacing.xxs", source)
        self.assertIn("pixelSize: Fluent.Enums.typography.titleLarge", source)
        self.assertIn("minimumPixelSize: Fluent.Enums.typography.body", source)
        self.assertIn("type: Fluent.Enums.label.type_body", source)
        self.assertIn("wrapMode: Text.NoWrap", source)
        self.assertIn("maximumLineCount: 1", source)
        self.assertNotIn("itemHeight: 76", source)
        self.assertNotIn("pixelSize: Fluent.Enums.typography.displayLarge", source)


if __name__ == "__main__":
    unittest.main()
