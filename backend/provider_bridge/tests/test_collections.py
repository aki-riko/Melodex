import json
import unittest
from types import SimpleNamespace

from provider_bridge.collections import collection
from provider_bridge.platforms.netease import NeteaseCollections
from provider_bridge.qr import check as qr_check
from provider_bridge.qr import create as qr_create


class FakeResponse:
    def __init__(self, payload, cookies=()):
        self.content = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.cookies = [SimpleNamespace(name=name, value=value) for name, value in cookies]

    def raise_for_status(self):
        return None


class FakeSession:
    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        for prefix, payload in self.routes:
            if url.startswith(prefix):
                return FakeResponse(payload)
        raise AssertionError(f"unexpected request {method} {url}")

    def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        for prefix, payload in self.routes:
            if url.startswith(prefix):
                if isinstance(payload, tuple):
                    return FakeResponse(payload[0], payload[1])
                return FakeResponse(payload)
        raise AssertionError(f"unexpected request POST {url}")


class CollectionSidecarTests(unittest.TestCase):
    def test_netease_search_maps_collection(self):
        session = FakeSession([
            ("https://music.163.com/api/search/get/web", {
                "result": {"playlists": [{"id": 7, "name": "歌单", "coverImgUrl": "https://cover", "trackCount": 2}]}
            })
        ])
        result = NeteaseCollections("MUSIC_U=test", session).search_playlist("晴天")
        self.assertEqual(result[0]["id"], "7")
        self.assertEqual(result[0]["track_count"], 2)
        self.assertEqual(session.calls[0][2]["headers"]["Cookie"], "MUSIC_U=test")

    def test_collection_dispatches_detail(self):
        session = FakeSession([
            ("https://music.163.com/api/v6/playlist/detail", {
                "playlist": {"id": 7, "name": "歌单", "trackCount": 1},
            })
        ])
        result = collection({"source": "netease", "action": "playlist", "id": "7"}, session=session)
        self.assertEqual(result["collection"]["id"], "7")
        self.assertEqual(result["songs"], [])

    def test_qr_check_maps_state_and_cookie(self):
        session = FakeSession([
            ("https://music.163.com/api/login/qrcode/client/login", ({"code": 803}, (("MUSIC_U", "cookie"),)))
        ])
        result = qr_check({"source": "netease", "key": "key-1"}, session=session)
        self.assertEqual(result["result"]["status"], "success")
        self.assertEqual(result["result"]["cookie"], "MUSIC_U=cookie")

    def test_qr_create_encodes_key_in_verification_url(self):
        session = FakeSession([
            ("https://music.163.com/api/login/qrcode/unikey", {"unikey": "key/a?b"})
        ])
        result = qr_create({"source": "netease"}, session=session)
        self.assertEqual(result["challenge"]["url"], "https://music.163.com/login?codekey=key%2Fa%3Fb")

    def test_unknown_collection_source_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "unsupported collection source"):
            collection({"source": "unknown", "action": "categories"})

    def test_migu_user_playlists_is_a_provider_error(self):
        with self.assertRaisesRegex(ValueError, "not supported"):
            collection({"source": "migu", "action": "user_playlists"})


if __name__ == "__main__":
    unittest.main()
