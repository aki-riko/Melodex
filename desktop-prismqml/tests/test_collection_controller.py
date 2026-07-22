# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only

import unittest

from PySide6.QtCore import QObject, Signal

from melodex_desktop.collection_controller import (
    CollectionController,
    normalize_collection,
    song_write_payload,
)


class FakeApi(QObject):
    authenticatedChanged = Signal()

    def __init__(self, authenticated: bool = True) -> None:
        super().__init__()
        self.authenticated = authenticated
        self.requests = []

    def request_json(self, method, path, callback, payload=None) -> None:
        self.requests.append(
            {
                "method": method,
                "path": path,
                "callback": callback,
                "payload": payload,
            }
        )

    def complete(self, index: int, payload, error: str = "", status: int = 200) -> None:
        self.requests[index]["callback"](payload, error, status)

    def set_authenticated(self, value: bool) -> None:
        self.authenticated = value
        self.authenticatedChanged.emit()


class CollectionContractTests(unittest.TestCase):
    def test_normalizes_collection_and_song_write_contract(self) -> None:
        collection = normalize_collection(
            {
                "id": 7,
                "name": " 我喜欢 ",
                "kind": "favorite",
                "track_count": 12,
            }
        )
        payload = song_write_payload(
            {
                "id": "song-1",
                "source": "qq",
                "name": "晴天",
                "artist": "周杰伦",
                "duration": 269.8,
                "extra": {"quality": "flac"},
            }
        )

        self.assertEqual(collection["id"], "7")
        self.assertEqual(collection["name"], "我喜欢")
        self.assertEqual(collection["source"], "local")
        self.assertEqual(payload["duration"], 269)
        self.assertEqual(payload["extra"], {"quality": "flac"})

    def test_loads_all_collection_kinds_and_selected_songs(self) -> None:
        api = FakeApi()
        controller = CollectionController(api)

        self.assertEqual(api.requests[0]["path"], "/music/collections?include_imported=1")
        api.complete(
            0,
            [
                {"id": 9, "name": "网易收藏", "kind": "imported", "source": "netease"},
                {"id": 3, "name": "我喜欢", "kind": "favorite"},
                {"id": 2, "name": "夜路", "kind": "manual"},
            ],
        )

        self.assertEqual(len(controller.get_collections()), 3)
        self.assertEqual(controller.get_selected_collection()["id"], "3")
        self.assertEqual(controller.get_writable_collection_names(), ["我喜欢", "夜路"])
        self.assertEqual(controller.get_target_index(), 0)
        self.assertEqual(api.requests[1]["path"], "/music/collections/3/songs")

        api.complete(
            1,
            [{"id": "song-1", "source": "qq", "name": "七里香"}],
        )
        self.assertEqual(controller.get_songs()[0]["name"], "七里香")

    def test_logout_discards_stale_collection_response(self) -> None:
        api = FakeApi()
        controller = CollectionController(api)

        api.set_authenticated(False)
        api.complete(0, [{"id": 1, "name": "不应串入", "kind": "manual"}])

        self.assertEqual(controller.get_collections(), [])
        self.assertEqual(controller.get_songs(), [])

    def test_switching_collection_replaces_stale_song_busy_state(self) -> None:
        api = FakeApi()
        controller = CollectionController(api)
        api.complete(
            0,
            [
                {"id": 9, "name": "慢平台歌单", "kind": "imported"},
                {"id": 3, "name": "我喜欢", "kind": "favorite"},
            ],
        )

        controller.selectCollectionIndex(0)
        controller.selectCollectionIndex(1)
        self.assertTrue(controller.get_busy())
        api.complete(3, [{"id": "song-1", "source": "qq", "name": "晴天"}])

        self.assertFalse(controller.get_busy())
        self.assertEqual(controller.get_selected_collection()["name"], "我喜欢")
        self.assertEqual(controller.get_songs()[0]["name"], "晴天")

        api.complete(2, [], "旧请求已取消", 499)
        self.assertFalse(controller.get_busy())
        self.assertEqual(controller.get_songs()[0]["name"], "晴天")

    def test_create_and_add_song_use_existing_backend_routes(self) -> None:
        api = FakeApi()
        controller = CollectionController(api)
        api.complete(
            0,
            [
                {"id": 3, "name": "我喜欢", "kind": "favorite"},
                {"id": 2, "name": "夜路", "kind": "manual"},
            ],
        )
        api.complete(1, [])

        controller.createCollection("通勤")
        create_request = api.requests[2]
        self.assertEqual(create_request["method"], "POST")
        self.assertEqual(create_request["path"], "/music/collections")
        self.assertEqual(create_request["payload"], {"name": "通勤"})

        controller.addSong(
            {
                "id": "track-id",
                "source": "qq",
                "name": "晴天",
                "artist": "周杰伦",
                "duration": 269,
            }
        )
        add_request = api.requests[3]
        self.assertEqual(add_request["method"], "POST")
        self.assertEqual(add_request["path"], "/music/collections/3/songs")
        self.assertEqual(add_request["payload"]["id"], "track-id")
        self.assertIsInstance(add_request["payload"]["duration"], int)

        api.complete(3, {"status": "ok"})
        download_request = api.requests[4]
        self.assertEqual(download_request["method"], "POST")
        self.assertIn("/music/download?", download_request["path"])
        self.assertIn("embed=1", download_request["path"])
        self.assertIn("save_local=1", download_request["path"])


if __name__ == "__main__":
    unittest.main()
