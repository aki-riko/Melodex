# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only

import unittest
from pathlib import Path


DESKTOP_ROOT = Path(__file__).resolve().parents[1]


class PlaylistCoverContractTests(unittest.TestCase):
    def test_playlist_header_falls_back_to_first_song_cover(self) -> None:
        source = (DESKTOP_ROOT / "qml" / "pages" / "PlaylistsPage.qml").read_text(
            encoding="utf-8"
        )

        self.assertIn("readonly property string playlistCoverSource", source)
        self.assertIn("if (selected.cover) return Api.coverUrl(selected)", source)
        self.assertIn(
            "if (Collections.songs.length > 0) return Api.coverUrl(Collections.songs[0])",
            source,
        )
        self.assertIn("source: root.playlistCoverSource", source)


if __name__ == "__main__":
    unittest.main()
