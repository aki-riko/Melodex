# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only

import os
import unittest
from unittest.mock import Mock, call, patch

from PySide6.QtCore import Property, QCoreApplication, QObject, Signal

import main
from melodex_desktop.desktop_state import DesktopState


class _FakeSettings(QObject):
    lyricsVisibleChanged = Signal()
    clickThroughChanged = Signal()

    def __init__(self) -> None:
        super().__init__()
        self.lyricsVisible = True

    def toggleClickThrough(self) -> None:
        return

    def toggleLyricsVisible(self) -> None:
        self.lyricsVisible = not self.lyricsVisible
        self.lyricsVisibleChanged.emit()


class _FakePlayer(QObject):
    currentSongChanged = Signal()

    def __init__(self) -> None:
        super().__init__()
        self._current_song = {}

    def get_current_song(self) -> dict:
        return self._current_song

    currentSong = Property("QVariantMap", get_current_song, notify=currentSongChanged)


class StartupWindowTests(unittest.TestCase):
    def test_qt_ffmpeg_logging_cannot_expose_signed_playback_urls(self) -> None:
        with patch.dict(os.environ, {"QT_LOGGING_RULES": "custom.category=true"}):
            main._configure_qt_logging()
            rules = os.environ["QT_LOGGING_RULES"].split(";")

        self.assertIn("custom.category=true", rules)
        self.assertIn("qt.multimedia.ffmpeg=false", rules)
        self.assertIn("qt.multimedia.ffmpeg.*=false", rules)

    def test_initial_window_is_explicitly_shown(self) -> None:
        window = Mock()

        main._show_initial_window(window)

        window.show.assert_called_once_with()
        window.showNormal.assert_not_called()
        window.requestActivate.assert_not_called()

    def test_tray_restore_recovers_paint_state_and_focus(self) -> None:
        window = Mock()

        main._restore_main_window(window)

        self.assertEqual(
            window.method_calls,
            [
                call.showNormal(),
                call.restoreVisibleState(),
                call.raise_(),
                call.requestActivate(),
            ],
        )

    def test_desktop_lyrics_window_is_explicitly_shown_and_hidden(self) -> None:
        application = QCoreApplication.instance() or QCoreApplication([])
        settings = _FakeSettings()
        player = _FakePlayer()
        window = Mock()
        state = DesktopState(settings, player)

        state.attach_lyrics_window(window)
        window.hide.assert_called_once_with()

        window.reset_mock()
        player._current_song = {"id": "real-song"}
        player.currentSongChanged.emit()
        application.processEvents()
        window.show.assert_called_once_with()

        window.reset_mock()
        settings.toggleLyricsVisible()
        application.processEvents()
        window.hide.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
