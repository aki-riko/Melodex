# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only
"""Native desktop-window and tray coordination."""

from __future__ import annotations

from PySide6.QtCore import QObject, Slot

from .config import UserSettings


class DesktopState(QObject):
    """Small QML-facing coordinator for window-level preferences."""

    def __init__(self, settings: UserSettings, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._settings = settings

    @Slot()
    def toggleClickThrough(self) -> None:
        self._settings.toggleClickThrough()

    @Slot()
    def toggleLyricsVisible(self) -> None:
        self._settings.toggleLyricsVisible()
