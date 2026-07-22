# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only

import unittest

from melodex_desktop.api_client import normalize_song, song_query


class NormalizeSongTests(unittest.TestCase):
    def test_normalizes_current_backend_fields(self) -> None:
        song = normalize_song(
            {
                "id": 123,
                "source": "qq",
                "name": "  晴天 ",
                "artist": " 周杰伦 ",
                "album": "叶惠美",
                "cover": "https://example.com/cover.jpg",
                "duration": 269,
                "extra": {"quality": "flac"},
            }
        )
        self.assertEqual(song["id"], "123")
        self.assertEqual(song["source"], "qq")
        self.assertEqual(song["name"], "晴天")
        self.assertEqual(song["artist"], "周杰伦")
        self.assertEqual(song["duration"], 269.0)
        self.assertEqual(song["extra"], {"quality": "flac"})

    def test_accepts_legacy_field_case_and_invalid_duration(self) -> None:
        song = normalize_song(
            {
                "ID": "legacy-id",
                "Source": "netease",
                "Name": "夜曲",
                "Artist": "周杰伦",
                "Duration": "not-a-number",
                "extra": {"album": "十一月的萧邦"},
            }
        )
        self.assertEqual(song["id"], "legacy-id")
        self.assertEqual(song["album"], "十一月的萧邦")
        self.assertEqual(song["duration"], 0.0)

    def test_song_query_matches_backend_contract(self) -> None:
        query = song_query(
            {
                "id": "track-id",
                "source": "qq",
                "name": "晴天",
                "artist": "周杰伦",
                "duration": 269,
                "extra": {"quality": "flac"},
            },
            stream="1",
        )
        items = dict(query.queryItems())
        self.assertEqual(items["id"], "track-id")
        self.assertEqual(items["source"], "qq")
        self.assertEqual(items["stream"], "1")
        self.assertEqual(items["extra"], '{"quality":"flac"}')


if __name__ == "__main__":
    unittest.main()
