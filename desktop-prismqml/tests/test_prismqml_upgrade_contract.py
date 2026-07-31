# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only
"""PrismQML upgrade contracts. PrismQML 升级契约。"""

from pathlib import Path
import unittest


DESKTOP_ROOT = Path(__file__).resolve().parents[1]


class PrismQmlUpgradeContractTests(unittest.TestCase):
    def test_split_panes_use_per_side_minimum_sizes(self) -> None:
        cases = (
            ("qml/pages/PlaylistsPage.qml", 280),
            ("qml/pages/NowPlayingPage.qml", 320),
        )

        for relative_path, minimum_size in cases:
            with self.subTest(path=relative_path):
                source = (DESKTOP_ROOT / relative_path).read_text(encoding="utf-8")
                self.assertNotIn("minimumSize:", source)
                self.assertIn(f"firstMinimumSize: {minimum_size}", source)
                self.assertIn(f"secondMinimumSize: {minimum_size}", source)


if __name__ == "__main__":
    unittest.main()
