# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only

import json
import tempfile
import unittest
from pathlib import Path

from PySide6.QtCore import QCoreApplication, QObject, Signal
from PySide6.QtMultimedia import QMediaPlayer

from melodex_desktop.player import PlayerController
from melodex_desktop.playback_state import PlaybackStateStore


class _FakeSettings:
    def __init__(self, root: Path, service_url: str) -> None:
        self._root = root
        self._service_url = service_url

    def storage_path(self, filename: str) -> Path:
        return self._root / filename

    def get_service_url(self) -> str:
        return self._service_url


class _FakeApi(QObject):
    lyricLoaded = Signal(str, str)
    currentUserChanged = Signal()

    def __init__(self, settings: _FakeSettings) -> None:
        super().__init__()
        self._settings = settings
        self._authenticated = False
        self._current_user = {}
        self.lyric_requests = []

    def get_authenticated(self) -> bool:
        return self._authenticated

    def get_current_user(self) -> dict:
        return self._current_user

    def sign_in(self, user_id: int, username: str) -> None:
        self._authenticated = True
        self._current_user = {"id": user_id, "username": username}
        self.currentUserChanged.emit()

    def sign_out(self) -> None:
        self._authenticated = False
        self._current_user = {}
        self.currentUserChanged.emit()

    def stream_url(self, song: dict) -> str:
        return f"{self._settings.get_service_url()}stream/{song['id']}"

    def load_lyrics(self, song: dict) -> None:
        self.lyric_requests.append(song["id"])


class _FakeAudioOutput(QObject):
    volumeChanged = Signal(float)

    def __init__(self) -> None:
        super().__init__()
        self._volume = 0.0

    def setVolume(self, volume: float) -> None:
        self._volume = volume
        self.volumeChanged.emit(volume)

    def volume(self) -> float:
        return self._volume


class _FakeMediaPlayer(QObject):
    playbackStateChanged = Signal(object)
    positionChanged = Signal(int)
    durationChanged = Signal(int)
    errorOccurred = Signal(object, str)
    mediaStatusChanged = Signal(object)
    seekableChanged = Signal(bool)

    def __init__(self) -> None:
        super().__init__()
        self._state = QMediaPlayer.StoppedState
        self._position = 0
        self._duration = 0
        self._seekable = False
        self.source = None
        self.audio_output = None
        self.play_calls = 0

    def setAudioOutput(self, output) -> None:
        self.audio_output = output

    def setSource(self, source) -> None:
        self.source = source
        self._position = 0
        self._duration = 0
        self._seekable = False
        self.positionChanged.emit(0)

    def play(self) -> None:
        self.play_calls += 1
        self._state = QMediaPlayer.PlayingState
        self.playbackStateChanged.emit(self._state)

    def pause(self) -> None:
        self._state = QMediaPlayer.PausedState
        self.playbackStateChanged.emit(self._state)

    def stop(self) -> None:
        self._state = QMediaPlayer.StoppedState
        self.playbackStateChanged.emit(self._state)

    def playbackState(self):
        return self._state

    def setPosition(self, position: int) -> None:
        self._position = position
        self.positionChanged.emit(position)

    def position(self) -> int:
        return self._position

    def duration(self) -> int:
        return self._duration

    def isSeekable(self) -> bool:
        return self._seekable

    def mark_loaded(self, duration: int) -> None:
        self._duration = duration
        self._seekable = True
        self.durationChanged.emit(duration)
        self.seekableChanged.emit(True)
        self.mediaStatusChanged.emit(QMediaPlayer.LoadedMedia)


def _song(song_id: str, name: str) -> dict:
    return {
        "id": song_id,
        "source": "qq",
        "name": name,
        "artist": "周杰伦",
        "duration": 240,
    }


def _snapshot(song: dict, position: float) -> dict:
    return {
        "current_song": song,
        "queue": [song],
        "queue_index": 0,
        "position_seconds": position,
    }


class PlaybackStateStoreTests(unittest.TestCase):
    def test_isolates_same_user_id_between_services(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = PlaybackStateStore(Path(temporary) / "playback-state.json")
            first_service = "https://first.example.invalid/"
            second_service = "https://second.example.invalid/"
            store.save(first_service, "7", _snapshot(_song("a", "晴天"), 12))
            store.save(second_service, "7", _snapshot(_song("b", "夜曲"), 34))

            self.assertEqual(
                store.load(first_service, "7")["current_song"]["id"], "a"
            )
            self.assertEqual(
                store.load(second_service, "7")["current_song"]["id"], "b"
            )

    def test_corrupt_file_is_logged_and_safely_replaced(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "playback-state.json"
            path.write_text("{broken", encoding="utf-8")
            store = PlaybackStateStore(path)

            self.assertIsNone(store.load("https://example.invalid/", "1"))
            store.save(
                "https://example.invalid/", "1", _snapshot(_song("a", "晴天"), 8)
            )

            payload = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(payload["version"], 1)
            self.assertFalse(path.with_suffix(".json.tmp").exists())


class PlayerPersistenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.application = QCoreApplication.instance() or QCoreApplication([])

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.service_url = "https://music.example.invalid/"
        self.settings = _FakeSettings(self.root, self.service_url)
        self.api = _FakeApi(self.settings)
        self.media = _FakeMediaPlayer()
        self.audio = _FakeAudioOutput()
        self.store = PlaybackStateStore(self.root / "playback-state.json")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _create_player(self) -> PlayerController:
        return PlayerController(
            self.api,
            self.settings,
            media_player=self.media,
            audio_output=self.audio,
        )

    def test_login_restores_song_queue_and_position_without_autoplay(self) -> None:
        song = _song("track-a", "晴天")
        self.store.save(self.service_url, "1", _snapshot(song, 42))
        player = self._create_player()

        self.api.sign_in(1, "alice")

        self.assertEqual(player.get_current_song()["id"], "track-a")
        self.assertEqual(player._queue_index, 0)
        self.assertEqual(self.api.lyric_requests, ["track-a"])
        self.assertEqual(self.media.play_calls, 0)
        self.assertFalse(player.get_playing())

        self.media.mark_loaded(240_000)

        self.assertEqual(self.media.position(), 42_000)
        self.assertEqual(player.get_position(), 42)

    def test_account_switch_saves_old_progress_and_loads_new_account(self) -> None:
        first_song = _song("track-a", "晴天")
        second_song = _song("track-b", "夜曲")
        self.store.save(self.service_url, "1", _snapshot(first_song, 10))
        self.store.save(self.service_url, "2", _snapshot(second_song, 15))
        player = self._create_player()

        self.api.sign_in(1, "alice")
        self.media.mark_loaded(240_000)
        self.media.setPosition(73_000)
        self.api.sign_in(2, "bob")

        saved_first = self.store.load(self.service_url, "1")
        self.assertEqual(saved_first["position_seconds"], 73)
        self.assertEqual(player.get_current_song()["id"], "track-b")
        self.assertEqual(self.media.play_calls, 0)

        self.media.mark_loaded(240_000)
        self.assertEqual(self.media.position(), 15_000)

    def test_pause_and_explicit_flush_persist_current_position(self) -> None:
        player = self._create_player()
        self.api.sign_in(1, "alice")
        song = _song("track-a", "晴天")
        player.playSong(song, [song])
        self.media.setPosition(61_000)

        self.media.pause()
        saved = self.store.load(self.service_url, "1")
        self.assertEqual(saved["position_seconds"], 61)

        self.media.setPosition(82_000)
        player.flushPlaybackState()
        saved = self.store.load(self.service_url, "1")
        self.assertEqual(saved["position_seconds"], 82)

    def test_logout_preserves_snapshot_then_clears_visible_player(self) -> None:
        player = self._create_player()
        self.api.sign_in(1, "alice")
        song = _song("track-a", "晴天")
        player.playSong(song, [song])
        self.media.setPosition(27_000)

        self.api.sign_out()

        saved = self.store.load(self.service_url, "1")
        self.assertEqual(saved["position_seconds"], 27)
        self.assertEqual(player.get_current_song(), {})


if __name__ == "__main__":
    unittest.main()
