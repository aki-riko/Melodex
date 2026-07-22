# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only
"""QML-facing collection state backed by Melodex's existing JSON routes."""

from __future__ import annotations

from typing import Any

from PySide6.QtCore import QObject, Property, Signal, Slot

from .api_client import ApiClient, encoded_query, normalize_song, song_query


def normalize_collection(value: dict[str, Any]) -> dict[str, Any]:
    """Normalize collection metadata without changing backend semantics."""

    collection = value or {}
    kind = str(collection.get("kind") or "manual").strip().lower()
    source = str(collection.get("source") or "local").strip().lower()
    return {
        **collection,
        "id": str(collection.get("id") or ""),
        "name": str(collection.get("name") or "未命名歌单").strip(),
        "description": str(collection.get("description") or "").strip(),
        "cover": str(collection.get("cover") or "").strip(),
        "kind": kind,
        "content_type": str(
            collection.get("content_type") or "playlist"
        ).strip().lower(),
        "source": source,
        "creator": str(collection.get("creator") or "").strip(),
        "track_count": int(collection.get("track_count") or 0),
    }


def song_write_payload(value: dict[str, Any]) -> dict[str, Any]:
    """Build the exact write contract accepted by /collections/:id/songs."""

    song = normalize_song(value)
    return {
        "id": song["id"],
        "source": song["source"],
        "name": song["name"],
        "artist": song["artist"],
        "album": song["album"],
        "album_id": str(value.get("album_id") or value.get("albumId") or ""),
        "cover": song["cover"],
        "duration": max(0, int(song["duration"])),
        "extra": song["extra"],
    }


class CollectionController(QObject):
    """Own collection lists, selection and add-to-playlist operations."""

    collectionsChanged = Signal()
    selectedCollectionChanged = Signal()
    selectedIndexChanged = Signal()
    songsChanged = Signal()
    writableCollectionsChanged = Signal()
    targetIndexChanged = Signal()
    busyChanged = Signal()
    errorChanged = Signal()
    noticeChanged = Signal()
    collectionCreated = Signal(str)

    def __init__(self, api: ApiClient, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._api = api
        self._collections: list[dict[str, Any]] = []
        self._selected_collection: dict[str, Any] = {}
        self._songs: list[dict[str, Any]] = []
        self._target_id = ""
        self._preferred_collection_id = ""
        self._active_requests: set[str] = set()
        self._request_token_serial = 0
        self._error = ""
        self._notice = ""
        self._session_generation = 0
        self._list_serial = 0
        self._songs_serial = 0
        self._api.authenticatedChanged.connect(self._on_authentication_changed)
        if self._api.authenticated:
            self.refresh()

    def _begin_request(self, scope: str, replace: bool = True) -> str:
        was_busy = bool(self._active_requests)
        if replace:
            prefix = scope + ":"
            self._active_requests = {
                token for token in self._active_requests if not token.startswith(prefix)
            }
        self._request_token_serial += 1
        token = f"{scope}:{self._request_token_serial}"
        self._active_requests.add(token)
        if not was_busy:
            self.busyChanged.emit()
        return token

    def _end_request(self, token: str) -> None:
        was_busy = bool(self._active_requests)
        self._active_requests.discard(token)
        if was_busy and not self._active_requests:
            self.busyChanged.emit()

    def _set_error(self, message: str) -> None:
        if message != self._error:
            self._error = message
            self.errorChanged.emit()

    def _set_notice(self, message: str) -> None:
        if message != self._notice:
            self._notice = message
            self.noticeChanged.emit()

    def _clear_state(self) -> None:
        self._collections = []
        self._selected_collection = {}
        self._songs = []
        self._target_id = ""
        self._preferred_collection_id = ""
        self._active_requests.clear()
        self._error = ""
        self._notice = ""
        self.collectionsChanged.emit()
        self.selectedCollectionChanged.emit()
        self.selectedIndexChanged.emit()
        self.songsChanged.emit()
        self.writableCollectionsChanged.emit()
        self.targetIndexChanged.emit()
        self.busyChanged.emit()
        self.errorChanged.emit()
        self.noticeChanged.emit()

    @Slot()
    def _on_authentication_changed(self) -> None:
        self._session_generation += 1
        self._list_serial += 1
        self._songs_serial += 1
        self._clear_state()
        if self._api.authenticated:
            self.refresh()

    @Slot()
    def refresh(self) -> None:
        if not self._api.authenticated:
            return
        self._list_serial += 1
        serial = self._list_serial
        generation = self._session_generation
        previous_id = self._preferred_collection_id or str(
            self._selected_collection.get("id") or ""
        )
        self._preferred_collection_id = ""
        self._set_error("")
        request_token = self._begin_request("collections")

        def completed(payload, error: str, _status: int) -> None:
            self._end_request(request_token)
            if generation != self._session_generation or serial != self._list_serial:
                return
            if error:
                self._set_error(error)
                return
            previous_target_index = self.get_target_index()
            values = payload if isinstance(payload, list) else []
            self._collections = [
                normalize_collection(item) for item in values if isinstance(item, dict)
            ]
            self.collectionsChanged.emit()
            self.writableCollectionsChanged.emit()
            self._sync_target_collection(previous_target_index)
            selected_index = self._collection_index(previous_id)
            if selected_index < 0 and self._collections:
                selected_index = next(
                    (
                        index
                        for index, item in enumerate(self._collections)
                        if item["kind"] == "favorite"
                    ),
                    0,
                )
            self._select_index(selected_index)
            self.selectedIndexChanged.emit()

        self._api.request_json(
            "GET", "/music/collections?include_imported=1", completed
        )

    def _collection_index(self, collection_id: str) -> int:
        return next(
            (
                index
                for index, item in enumerate(self._collections)
                if item["id"] == collection_id
            ),
            -1,
        )

    def _writable_collections(self) -> list[dict[str, Any]]:
        return [item for item in self._collections if item["kind"] != "imported"]

    def _sync_target_collection(self, previous_index: int) -> None:
        writable = self._writable_collections()
        if not any(item["id"] == self._target_id for item in writable):
            favorite = next(
                (item for item in writable if item["kind"] == "favorite"), None
            )
            self._target_id = str((favorite or (writable[0] if writable else {})).get("id") or "")
        if previous_index != self.get_target_index():
            self.targetIndexChanged.emit()

    @Slot(int)
    def selectCollectionIndex(self, index: int) -> None:
        self._select_index(index)

    def _select_index(self, index: int) -> None:
        next_collection = (
            dict(self._collections[index])
            if 0 <= index < len(self._collections)
            else {}
        )
        if next_collection != self._selected_collection:
            self._selected_collection = next_collection
            self.selectedCollectionChanged.emit()
            self.selectedIndexChanged.emit()
        self._load_selected_songs()

    @Slot()
    def refreshSongs(self) -> None:
        self._load_selected_songs()

    def _load_selected_songs(self) -> None:
        self._songs_serial += 1
        serial = self._songs_serial
        generation = self._session_generation
        collection_id = str(self._selected_collection.get("id") or "")
        self._songs = []
        self.songsChanged.emit()
        if not collection_id:
            return
        self._set_error("")
        request_token = self._begin_request("songs")

        def completed(payload, error: str, _status: int) -> None:
            self._end_request(request_token)
            if generation != self._session_generation or serial != self._songs_serial:
                return
            if collection_id != str(self._selected_collection.get("id") or ""):
                return
            if error:
                self._set_error(error)
                return
            values = payload.get("songs", []) if isinstance(payload, dict) else payload
            if not isinstance(values, list):
                values = []
            self._songs = [
                normalize_song(item) for item in values if isinstance(item, dict)
            ]
            self.songsChanged.emit()

        self._api.request_json(
            "GET", f"/music/collections/{collection_id}/songs", completed
        )

    @Slot(str)
    def createCollection(self, name: str) -> None:
        name = name.strip()
        if not name:
            self._set_error("请输入歌单名称")
            return
        generation = self._session_generation
        self._set_error("")
        self._set_notice("")
        request_token = self._begin_request("create", replace=False)

        def completed(payload, error: str, _status: int) -> None:
            self._end_request(request_token)
            if generation != self._session_generation:
                return
            if error:
                self._set_error(error)
                return
            collection_id = str((payload or {}).get("id") or "")
            self._preferred_collection_id = collection_id
            self._set_notice(f"已创建歌单「{name}」")
            self.collectionCreated.emit(collection_id)
            self.refresh()

        self._api.request_json(
            "POST", "/music/collections", completed, {"name": name}
        )

    @Slot(int)
    def setTargetCollectionIndex(self, index: int) -> None:
        writable = self._writable_collections()
        if not 0 <= index < len(writable):
            return
        next_id = writable[index]["id"]
        if next_id != self._target_id:
            self._target_id = next_id
            self.targetIndexChanged.emit()

    @Slot("QVariantMap")
    def addSong(self, song: dict[str, Any]) -> None:
        target = next(
            (item for item in self._writable_collections() if item["id"] == self._target_id),
            None,
        )
        if target is None:
            self._set_error("请先创建或选择一个可写歌单")
            return
        payload = song_write_payload(song)
        if not payload["id"] or not payload["source"]:
            self._set_error("歌曲缺少来源标识，无法加入歌单")
            return
        generation = self._session_generation
        target_id = target["id"]
        target_name = target["name"]
        self._set_error("")
        self._set_notice("")
        request_token = self._begin_request("add", replace=False)

        def completed(_payload, error: str, _status: int) -> None:
            self._end_request(request_token)
            if generation != self._session_generation:
                return
            if error:
                self._set_error(error)
                return
            self._set_notice(f"已加入「{target_name}」")
            self._download_added_song(song)
            if target_id == str(self._selected_collection.get("id") or ""):
                self._load_selected_songs()

        self._api.request_json(
            "POST", f"/music/collections/{target_id}/songs", completed, payload
        )

    def _download_added_song(self, song: dict[str, Any]) -> None:
        path = "/music/download?" + encoded_query(
            song_query(song, embed="1", save_local="1")
        )

        def completed(_payload, error: str, _status: int) -> None:
            if error:
                print(f"[WARN] 歌曲已加入歌单，但后台下载到服务器失败：{error}")

        self._api.request_json("POST", path, completed)

    @Slot()
    def clearMessages(self) -> None:
        self._set_error("")
        self._set_notice("")

    def get_collections(self) -> list[dict[str, Any]]:
        return self._collections

    def get_selected_collection(self) -> dict[str, Any]:
        return self._selected_collection

    def get_selected_index(self) -> int:
        return self._collection_index(str(self._selected_collection.get("id") or ""))

    def get_songs(self) -> list[dict[str, Any]]:
        return self._songs

    def get_writable_collection_names(self) -> list[str]:
        return [item["name"] for item in self._writable_collections()]

    def get_target_index(self) -> int:
        return next(
            (
                index
                for index, item in enumerate(self._writable_collections())
                if item["id"] == self._target_id
            ),
            -1,
        )

    def get_busy(self) -> bool:
        return bool(self._active_requests)

    def get_error(self) -> str:
        return self._error

    def get_notice(self) -> str:
        return self._notice

    collections = Property("QVariantList", get_collections, notify=collectionsChanged)
    selectedCollection = Property(
        "QVariantMap", get_selected_collection, notify=selectedCollectionChanged
    )
    selectedIndex = Property(int, get_selected_index, notify=selectedIndexChanged)
    songs = Property("QVariantList", get_songs, notify=songsChanged)
    writableCollectionNames = Property(
        "QVariantList",
        get_writable_collection_names,
        notify=writableCollectionsChanged,
    )
    targetIndex = Property(int, get_target_index, notify=targetIndexChanged)
    busy = Property(bool, get_busy, notify=busyChanged)
    error = Property(str, get_error, notify=errorChanged)
    notice = Property(str, get_notice, notify=noticeChanged)
