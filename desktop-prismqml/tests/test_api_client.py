# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only

import unittest
from types import SimpleNamespace

from melodex_desktop.api_client import (
    ApiClient,
    encoded_query,
    normalize_song,
    resolve_playback_url,
    song_query,
)


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

    def test_song_query_strips_bulky_embedded_lyric(self) -> None:
        # 回归:QQ 逐字歌词整首 LRC 进查询串会撑爆反向代理请求行,流地址必须保持精简。
        bulky = "[00:00.00]街[00:00.01]角" + "晚风" * 4000
        query = song_query(
            {
                "id": "track-id",
                "source": "qq",
                "extra": {"lyric": bulky, "songmid": "mid-1", "lyric_verbatim": "1"},
            },
            stream="1",
        )
        items = dict(query.queryItems())
        self.assertEqual(items["extra"], '{"songmid":"mid-1","lyric_verbatim":"1"}')
        self.assertNotIn(bulky, encoded_query(query))

    def test_song_query_omits_extra_when_only_lyric_present(self) -> None:
        query = song_query(
            {"id": "track-id", "source": "qq", "extra": {"lyric": "[00:00.00]词"}},
            stream="1",
        )
        items = dict(query.queryItems())
        self.assertNotIn("extra", items)

    def test_embedded_lyrics_are_preserved_in_normalized_song(self) -> None:
        song = normalize_song(
            {
                "id": "track-id",
                "source": "qq",
                "name": "フレグランス",
                "extra": {"lyric": "[00:00.00]歌词"},
            }
        )
        self.assertEqual(song["extra"]["lyric"], "[00:00.00]歌词")

    def test_load_lyrics_uses_embedded_lyrics_without_network_request(self) -> None:
        captured = []

        class Harness:
            load_lyrics = ApiClient.load_lyrics

            @staticmethod
            def _root_url(_path):
                raise AssertionError("embedded lyrics should skip network setup")

            @staticmethod
            def _request(*_args, **_kwargs):
                raise AssertionError("embedded lyrics should skip network request")

            lyricLoaded = type("Signal", (), {"emit": lambda _self, *args: captured.append(args)})()

        Harness().load_lyrics(
            {
                "id": "track-id",
                "source": "qq",
                "extra": {"lyric": "  [00:00.00]歌词  "},
            }
        )
        self.assertEqual(captured, [("qq:track-id", "[00:00.00]歌词")])

    def test_encoded_query_escapes_nested_cover_url(self) -> None:
        query = song_query(
            {
                "id": "track-id",
                "source": "netease",
                "cover": "https://p1.music.126.net/cover.jpg?size=640&quality=90",
            }
        )

        encoded = encoded_query(query)

        self.assertIn("cover=https%3A%2F%2F", encoded)
        self.assertIn("%3Fsize%3D640%26quality%3D90", encoded)
        self.assertNotIn("cover=https://", encoded)

    def test_resolve_playback_url_accepts_only_configured_service_origin(self) -> None:
        resolved = resolve_playback_url(
            "https://music.example.invalid/",
            "/music/download?id=2140404278&stream=1&playback_token=signed",
        )
        self.assertEqual(
            resolved,
            "https://music.example.invalid/music/download?id=2140404278&stream=1&playback_token=signed",
        )

        with self.assertRaisesRegex(ValueError, "跨域播放地址"):
            resolve_playback_url(
                "https://music.example.invalid/",
                "https://attacker.example/download?id=2140404278",
            )

    def test_native_stream_requests_a_ticket_instead_of_a_loopback_proxy(self) -> None:
        captured = {}

        class Harness:
            request_stream_url = ApiClient.request_stream_url
            _settings = SimpleNamespace(serviceUrl="https://music.example.invalid/")

            @staticmethod
            def _request(method, path, callback, payload) -> None:
                captured.update(method=method, path=path, payload=payload)
                callback(
                    {
                        "url": (
                            "/music/download?id=2140404278&source=netease&stream=1"
                            "&playback_token=signed"
                        )
                    },
                    "",
                    200,
                )

        resolved = []
        Harness().request_stream_url(
            {"id": "2140404278", "source": "netease", "name": "海棠又落微雨时"},
            lambda url, error: resolved.append((url, error)),
        )

        self.assertEqual(captured["method"], "POST")
        self.assertEqual(captured["path"], "/api/v1/playback_ticket")
        self.assertIn("id=2140404278", captured["payload"]["query"])
        self.assertEqual(resolved[0][1], "")
        self.assertTrue(resolved[0][0].startswith("https://music.example.invalid/"))
        self.assertNotIn("127.0.0.1", resolved[0][0])


if __name__ == "__main__":
    unittest.main()
