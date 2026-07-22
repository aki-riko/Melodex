# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only
"""Native Qt Multimedia player for the Melodex desktop client."""

from __future__ import annotations

from typing import Any

from PySide6.QtCore import QObject, Property, QUrl, Signal, Slot
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer

from .api_client import ApiClient, normalize_song
from .lyrics import current_lyric_index, parse_lrc


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

    def __init__(self, api: ApiClient, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._api = api
        self._audio = QAudioOutput(self)
        self._audio.setVolume(0.8)
        self._player = QMediaPlayer(self)
        self._player.setAudioOutput(self._audio)
        self._current_song: dict[str, Any] = {}
        self._queue: list[dict[str, Any]] = []
        self._queue_index = -1
        self._lyrics: list[dict[str, Any]] = []
        self._current_lyric_index = -1
        self._current_lyric_progress = 0.0
        self._error = ""

        self._player.playbackStateChanged.connect(lambda _state: self.playingChanged.emit())
        self._player.positionChanged.connect(self._on_position_changed)
        self._player.durationChanged.connect(lambda _value: self.durationChanged.emit())
        self._player.errorOccurred.connect(self._on_error)
        self._player.mediaStatusChanged.connect(self._on_media_status)
        self._audio.volumeChanged.connect(lambda _value: self.volumeChanged.emit())
        self._api.lyricLoaded.connect(self._apply_lyrics)

    def _song_key(self, song: dict[str, Any]) -> str:
        normalized = normalize_song(song)
        return f"{normalized['source']}:{normalized['id']}"

    @Slot("QVariantMap", "QVariantList")
    def playSong(self, song: dict[str, Any], queue: list[dict[str, Any]]) -> None:
        normalized = normalize_song(song)
        if not normalized["id"] or not normalized["source"]:
            self._set_error("歌曲缺少来源标识，无法播放")
            return
        self._queue = [normalize_song(item) for item in queue if isinstance(item, dict)]
        self._queue_index = next(
            (index for index, item in enumerate(self._queue) if self._song_key(item) == self._song_key(normalized)),
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
        self._player.setPosition(max(0, int(seconds * 1000)))

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
        if status == QMediaPlayer.EndOfMedia:
            self.next()

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
