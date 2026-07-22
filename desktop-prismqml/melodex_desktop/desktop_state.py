# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only
"""Native desktop-window and tray coordination."""

from __future__ import annotations

from PySide6.QtCore import QObject, QTimer, Slot

from .config import UserSettings


class DesktopState(QObject):
    """Small QML-facing coordinator for window-level preferences."""

    def __init__(
        self,
        settings: UserSettings,
        player: QObject,
        parent: QObject | None = None,
    ) -> None:
        super().__init__(parent)
        self._settings = settings
        self._player = player
        self._lyrics_window: QObject | None = None
        self._settings.lyricsVisibleChanged.connect(self._queue_lyrics_window_sync)
        self._settings.clickThroughChanged.connect(self._queue_lyrics_window_sync)
        self._player.currentSongChanged.connect(self._queue_lyrics_window_sync)

    def attach_lyrics_window(self, window: QObject) -> None:
        """Own the explicit show/hide lifecycle of the QML lyrics window."""

        self._lyrics_window = window
        self._sync_lyrics_window()

    def _queue_lyrics_window_sync(self) -> None:
        # Changing native flags (for click-through) can hide a QWindow. Run after
        # QML has applied every binding triggered by the same preference signal.
        QTimer.singleShot(0, self._sync_lyrics_window)

    def _sync_lyrics_window(self) -> None:
        if self._lyrics_window is None:
            return
        current_song = self._player.property("currentSong") or {}
        should_show = self._settings.lyricsVisible and bool(current_song.get("id"))
        if should_show:
            self._lyrics_window.show()
        else:
            self._lyrics_window.hide()

    @Slot()
    def toggleClickThrough(self) -> None:
        self._settings.toggleClickThrough()

    @Slot()
    def toggleLyricsVisible(self) -> None:
        self._settings.toggleLyricsVisible()
