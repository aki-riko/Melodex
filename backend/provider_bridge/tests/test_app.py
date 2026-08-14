import tempfile
import unittest
from pathlib import Path

from provider_bridge.app import search, song_to_payload


class FakeSong:
    def todict(self):
        return {
            "identifier": "0039MnYb0qxYhV",
            "song_name": "晴天",
            "singers": "周杰伦",
            "album": "叶惠美",
            "duration_s": 269,
            "file_size_bytes": 12345678,
            "bitrate": 320,
            "ext": "flac",
            "cover_url": "https://example.invalid/cover.jpg",
            "download_url": "https://example.invalid/audio.flac",
            "download_url_status": {"ok": True},
            "default_download_headers": {"Referer": "https://y.qq.com/"},
            "lyric": "[00:00.00]晴天",
        }


class FakeClient:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

    def search(self, keyword):
        if keyword != "周杰伦 晴天":
            raise AssertionError(keyword)
        return [FakeSong()]


class ProviderBridgeTests(unittest.TestCase):
    def test_song_mapping_preserves_playback_fields(self):
        song = song_to_payload(FakeSong(), "qq", 0)
        self.assertEqual(song["id"], "0039MnYb0qxYhV")
        self.assertEqual(song["duration"], 269)
        self.assertEqual(song["ext"], "flac")
        self.assertEqual(song["extra"]["has_lossless"], "1")
        self.assertIn("Referer", song["extra"]["download_headers"])

    def test_search_uses_whitelisted_source(self):
        with tempfile.TemporaryDirectory() as work_dir:
            result = search(
                {"source": "qq", "keyword": "周杰伦 晴天", "limit": 5, "cookie": "uin=1"},
                client_factory=FakeClient,
                work_dir=work_dir,
            )
            self.assertEqual(list(Path(work_dir).iterdir()), [])
        self.assertEqual(len(result["songs"]), 1)
        self.assertEqual(result["songs"][0]["source"], "qq")

    def test_search_rejects_unknown_source(self):
        with self.assertRaisesRegex(ValueError, "unsupported source"):
            search(
                {"source": "unknown", "keyword": "test"},
                client_factory=FakeClient,
                work_dir="provider-test-output",
            )


if __name__ == "__main__":
    unittest.main()
