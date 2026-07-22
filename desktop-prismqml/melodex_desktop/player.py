# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only
"""Native Qt Multimedia player for the Melodex desktop client."""

from __future__ import annotations

from typing import Any

from PySide6.QtCore import QCoreApplication, QObject, Property, QTimer, QUrl, Signal, Slot
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer

from .api_client import ApiClient, normalize_song
from .config import UserSettings
from .lyrics import current_lyric_index, parse_lrc
from .playback_state import PlaybackStateStore


PLAYBACK_SAVE_INTERVAL_MS = 5_000


class PlayerController(QObject):
    """Own one native audio player, queue and synchronized lyric state."""

    currentSongChanged = Signal()
    playingChanged = Signal()
    positionChanged = Signal()
    durationChanged = Signal()
    volumeChanged = Signal()
    lyricsChanged = Signal()
    currentLyricIndexChanged = Signal()
    currentLyricProgressChanged = Signal()
    errorChanged = Signal()

    def __init__(
        self,
        api: ApiClient,
        settings: UserSettings,
        parent: QObject | None = None,
        *,
        media_player: QMediaPlayer | None = None,
        audio_output: QAudioOutput | None = None,
    ) -> None:
        super().__init__(parent)
        self._api = api
        self._settings = settings
        self._state_store = PlaybackStateStore(
            settings.storage_path("playback-state.json")
        )
        self._audio = audio_output or QAudioOutput(self)
        self._audio.setVolume(0.8)
        self._player = media_player or QMediaPlayer(self)
        self._player.setAudioOutput(self._audio)
        self._current_song: dict[str, Any] = {}
        self._queue: list[dict[str, Any]] = []
        self._queue_index = -1
        self._lyrics: list[dict[str, Any]] = []
        self._current_lyric_index = -1
        self._current_lyric_progress = 0.0
        self._error = ""
        self._active_identity: tuple[str, str] | None = None
        self._pending_restore_position_ms: int | None = None
        self._restoring_state = False
        self._save_timer = QTimer(self)
        self._save_timer.setSingleShot(True)
        self._save_timer.setInterval(PLAYBACK_SAVE_INTERVAL_MS)
        self._save_timer.timeout.connect(self.flushPlaybackState)

        self._player.playbackStateChanged.connect(self._on_playback_state_changed)
        self._player.positionChanged.connect(self._on_position_changed)
        self._player.durationChanged.connect(self._on_duration_changed)
        self._player.errorOccurred.connect(self._on_error)
        self._player.mediaStatusChanged.connect(self._on_media_status)
        self._player.seekableChanged.connect(self._on_seekable_changed)
        self._audio.volumeChanged.connect(lambda _value: self.volumeChanged.emit())
        self._api.lyricLoaded.connect(self._apply_lyrics)
        self._api.currentUserChanged.connect(self._on_current_user_changed)
        application = QCoreApplication.instance()
        if application is not None:
            application.aboutToQuit.connect(self.flushPlaybackState)

    def _song_key(self, song: dict[str, Any]) -> str:
        normalized = normalize_song(song)
        return f"{normalized['source']}:{normalized['id']}"

    @Slot("QVariantMap", "QVariantList")
    def playSong(self, song: dict[str, Any], queue: list[dict[str, Any]]) -> None:
        normalized = normalize_song(song)
        if not normalized["id"] or not normalized["source"]:
            self._set_error("歌曲缺少来源标识，无法播放")
            return
        self._pending_restore_position_ms = None
        self._restoring_state = False
        self._queue = [normalize_song(item) for item in queue if isinstance(item, dict)]
        self._queue_index = next(
            (
                index
                for index, item in enumerate(self._queue)
                if self._song_key(item) == self._song_key(normalized)
            ),
            -1,
        )
        self._current_song = normalized
        self._lyrics = []
        self._current_lyric_index = -1
        self._set_error("")
        self.currentSongChanged.emit()
        self.lyricsChanged.emit()
        self.currentLyricIndexChanged.emit()
        self.currentLyricProgressChanged.emit()
        try:
            self._player.setSource(QUrl(self._api.stream_url(normalized)))
        except ValueError as exc:
            self._set_error(str(exc))
            return
        self._player.play()
        self._api.load_lyrics(normalized)
        self._save_playback_state(position_seconds=0.0)

    @Slot()
    def togglePlay(self) -> None:
        if self._player.playbackState() == QMediaPlayer.PlayingState:
            self._player.pause()
        elif self._current_song:
            self._player.play()

    @Slot()
    def next(self) -> None:
        if not self._queue:
            return
        next_index = (self._queue_index + 1) % len(self._queue)
        self.playSong(self._queue[next_index], self._queue)

    @Slot()
    def previous(self) -> None:
        if not self._queue:
            return
        if self._player.position() > 5000:
            self._player.setPosition(0)
            return
        previous_index = (self._queue_index - 1) % len(self._queue)
        self.playSong(self._queue[previous_index], self._queue)

    @Slot(float)
    def seek(self, seconds: float) -> None:
        self._pending_restore_position_ms = None
        self._restoring_state = False
        self._player.setPosition(max(0, int(seconds * 1000)))
        self._save_playback_state(position_seconds=max(0.0, float(seconds)))

    @Slot(float)
    def setVolume(self, volume: float) -> None:
        self._audio.setVolume(max(0.0, min(1.0, float(volume))))

    def _on_position_changed(self, _milliseconds: int) -> None:
        self.positionChanged.emit()
        index = current_lyric_index(self._lyrics, self.get_position())
        if index != self._current_lyric_index:
            self._current_lyric_index = index
            self.currentLyricIndexChanged.emit()
        progress = self._calculate_lyric_progress(index, self.get_position())
        if abs(progress - self._current_lyric_progress) >= 0.005:
            self._current_lyric_progress = progress
            self.currentLyricProgressChanged.emit()
        if not self._restoring_state:
            self._schedule_playback_save()

    def _on_playback_state_changed(self, state) -> None:
        self.playingChanged.emit()
        if state != QMediaPlayer.PlayingState:
            self._save_playback_state()

    def _on_duration_changed(self, _milliseconds: int) -> None:
        self.durationChanged.emit()
        self._apply_pending_restore_position()

    def _on_seekable_changed(self, _seekable: bool) -> None:
        self._apply_pending_restore_position()

    def _calculate_lyric_progress(self, index: int, position: float) -> float:
        if index < 0 or index >= len(self._lyrics):
            return 0.0
        line = self._lyrics[index]
        words = line.get("words") or []
        if words:
            total_chars = sum(max(1, len(str(word.get("s", "")))) for word in words)
            completed_chars = 0.0
            for word in words:
                char_count = max(1, len(str(word.get("s", ""))))
                start = float(word.get("t", line["t"]))
                end = float(word.get("end", line["end"]))
                if position >= end:
                    completed_chars += char_count
                    continue
                if position > start and end > start:
                    completed_chars += char_count * (position - start) / (end - start)
                break
            return max(0.0, min(1.0, completed_chars / max(1, total_chars)))
        start = float(line.get("t", 0))
        end = float(line.get("end", start + 5))
        if end <= start:
            return 1.0
        return max(0.0, min(1.0, (position - start) / (end - start)))

    def _on_error(self, _error, message: str) -> None:
        self._set_error(message or "播放失败")

    def _on_media_status(self, status: QMediaPlayer.MediaStatus) -> None:
        if status in {QMediaPlayer.LoadedMedia, QMediaPlayer.BufferedMedia}:
            self._apply_pending_restore_position()
        if status == QMediaPlayer.EndOfMedia:
            self.next()

    def _on_current_user_changed(self) -> None:
        self._save_playback_state()
        self._save_timer.stop()
        self._active_identity = None
        self._clear_playback()

        identity = self._authenticated_identity()
        if identity is None:
            return
        self._active_identity = identity
        self._restore_playback_state()

    def _authenticated_identity(self) -> tuple[str, str] | None:
        if not self._api.get_authenticated():
            return None
        user = self._api.get_current_user()
        raw_user_id = user.get("id") if isinstance(user, dict) else None
        user_id = str(raw_user_id).strip() if raw_user_id is not None else ""
        service_url = self._settings.get_service_url().strip()
        if not service_url or not user_id or user_id == "0":
            print("[WARN] 已认证会话缺少服务地址或用户 ID，无法恢复播放状态")
            return None
        return service_url, user_id

    def _restore_playback_state(self) -> None:
        if self._active_identity is None:
            return
        service_url, user_id = self._active_identity
        snapshot = self._state_store.load(service_url, user_id)
        if not snapshot:
            return

        raw_song = snapshot.get("current_song")
        if not isinstance(raw_song, dict):
            print("[WARN] 忽略缺少当前歌曲的桌面播放状态")
            return
        current_song = normalize_song(raw_song)
        if not current_song["id"] or not current_song["source"]:
            print("[WARN] 忽略来源标识不完整的桌面播放状态")
            return

        raw_queue = snapshot.get("queue")
        queue = [
            normalize_song(item)
            for item in raw_queue
            if isinstance(item, dict)
        ] if isinstance(raw_queue, list) else []
        queue = [item for item in queue if item["id"] and item["source"]]
        queue_index = self._restored_queue_index(
            queue, snapshot.get("queue_index"), current_song
        )
        position_ms = self._restored_position_ms(
            snapshot.get("position_seconds"), current_song
        )

        self._current_song = current_song
        self._queue = queue
        self._queue_index = queue_index
        self._lyrics = []
        self._current_lyric_index = -1
        self._current_lyric_progress = 0.0
        self._pending_restore_position_ms = position_ms
        self._restoring_state = position_ms > 0
        self._set_error("")
        self.currentSongChanged.emit()
        self.lyricsChanged.emit()
        self.currentLyricIndexChanged.emit()
        self.currentLyricProgressChanged.emit()

        try:
            self._player.setSource(QUrl(self._api.stream_url(current_song)))
        except ValueError as exc:
            self._restoring_state = False
            self._set_error(str(exc))
            return
        self._api.load_lyrics(current_song)
        if position_ms == 0:
            self._pending_restore_position_ms = None
            self.positionChanged.emit()

    def _restored_queue_index(
        self,
        queue: list[dict[str, Any]],
        raw_index: Any,
        current_song: dict[str, Any],
    ) -> int:
        try:
            index = int(raw_index)
        except (TypeError, ValueError):
            index = -1
        current_key = self._song_key(current_song)
        if 0 <= index < len(queue) and self._song_key(queue[index]) == current_key:
            return index
        return next(
            (
                queue_index
                for queue_index, item in enumerate(queue)
                if self._song_key(item) == current_key
            ),
            -1,
        )

    @staticmethod
    def _restored_position_ms(raw_position: Any, song: dict[str, Any]) -> int:
        try:
            position = max(0.0, float(raw_position or 0))
        except (TypeError, ValueError) as exc:
            print(f"[WARN] 忽略无效播放进度 {raw_position!r}：{exc}")
            position = 0.0
        duration = max(0.0, float(song.get("duration") or 0))
        if duration > 0:
            position = min(position, duration)
        return int(position * 1000)

    def _apply_pending_restore_position(self) -> None:
        if self._pending_restore_position_ms is None:
            return
        if not self._player.isSeekable() and self._player.duration() <= 0:
            return
        target = self._pending_restore_position_ms
        duration = self._player.duration()
        if duration > 0:
            target = min(target, duration)
        self._player.setPosition(target)
        self._pending_restore_position_ms = None
        self._restoring_state = False
        self.positionChanged.emit()

    def _schedule_playback_save(self) -> None:
        if (
            self._active_identity is not None
            and self._current_song
            and not self._save_timer.isActive()
        ):
            self._save_timer.start()

    @Slot()
    def flushPlaybackState(self) -> None:
        self._save_playback_state()

    def _save_playback_state(self, position_seconds: float | None = None) -> None:
        self._save_timer.stop()
        if self._active_identity is None or not self._current_song:
            return
        if position_seconds is None:
            if self._pending_restore_position_ms is not None:
                position_seconds = self._pending_restore_position_ms / 1000
            else:
                position_seconds = self.get_position()
        snapshot = {
            "current_song": self._current_song,
            "queue": self._queue,
            "queue_index": self._queue_index,
            "position_seconds": max(0.0, float(position_seconds)),
        }
        try:
            self._state_store.save(*self._active_identity, snapshot)
        except (OSError, TypeError, ValueError) as exc:
            print(f"[WARN] 保存桌面播放状态失败：{exc}")

    def _clear_playback(self) -> None:
        self._pending_restore_position_ms = None
        self._restoring_state = False
        self._player.stop()
        self._player.setSource(QUrl())
        self._current_song = {}
        self._queue = []
        self._queue_index = -1
        self._lyrics = []
        self._current_lyric_index = -1
        self._current_lyric_progress = 0.0
        self._set_error("")
        self.currentSongChanged.emit()
        self.positionChanged.emit()
        self.durationChanged.emit()
        self.lyricsChanged.emit()
        self.currentLyricIndexChanged.emit()
        self.currentLyricProgressChanged.emit()

    @Slot(str, str)
    def _apply_lyrics(self, song_key: str, raw: str) -> None:
        if song_key != self._song_key(self._current_song):
            return
        self._lyrics = parse_lrc(raw)
        self._current_lyric_index = current_lyric_index(self._lyrics, self.get_position())
        self._current_lyric_progress = self._calculate_lyric_progress(
            self._current_lyric_index, self.get_position()
        )
        self.lyricsChanged.emit()
        self.currentLyricIndexChanged.emit()
        self.currentLyricProgressChanged.emit()

    def _set_error(self, message: str) -> None:
        if message != self._error:
            self._error = message
            self.errorChanged.emit()

    def get_current_song(self) -> dict[str, Any]:
        return self._current_song

    def get_playing(self) -> bool:
        return self._player.playbackState() == QMediaPlayer.PlayingState

    def get_position(self) -> float:
        return self._player.position() / 1000

    def get_duration(self) -> float:
        return self._player.duration() / 1000

    def get_volume(self) -> float:
        return self._audio.volume()

    def get_lyrics(self) -> list[dict[str, Any]]:
        return self._lyrics

    def get_current_lyric_index(self) -> int:
        return self._current_lyric_index

    def get_has_lyrics(self) -> bool:
        return bool(self._current_song and self._lyrics)

    def get_current_lyric_progress(self) -> float:
        return self._current_lyric_progress

    def get_error(self) -> str:
        return self._error

    currentSong = Property("QVariantMap", get_current_song, notify=currentSongChanged)
    playing = Property(bool, get_playing, notify=playingChanged)
    position = Property(float, get_position, notify=positionChanged)
    duration = Property(float, get_duration, notify=durationChanged)
    volume = Property(float, get_volume, notify=volumeChanged)
    lyrics = Property("QVariantList", get_lyrics, notify=lyricsChanged)
    currentLyricIndex = Property(int, get_current_lyric_index, notify=currentLyricIndexChanged)
    currentLyricProgress = Property(
        float, get_current_lyric_progress, notify=currentLyricProgressChanged
    )
    hasLyrics = Property(bool, get_has_lyrics, notify=lyricsChanged)
    error = Property(str, get_error, notify=errorChanged)
