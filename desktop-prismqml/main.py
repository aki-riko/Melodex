# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only
"""Melodex PrismQML desktop client entry point."""

from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ.setdefault("QT_LOGGING_RULES", "qt.text.font.db=false")
os.environ.setdefault("QML_XHR_ALLOW_FILE_READ", "1")


def _configure_console() -> None:
    """Keep Qt/PrismQML diagnostics readable on Windows Chinese paths."""

    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")


def _bootstrap_config(root: Path):
    # PrismQML 首次导入前设置 AUMID，保证 Windows 任务栏身份正确。
    from melodex_desktop.config import load_application_config

    config = load_application_config(root / "app_config.json")
    os.environ.setdefault("PRISMQML_APP_USER_MODEL_ID", config.application_id)
    return config


def _create_application(config):
    from prismqml import (
        App,
        Skin,
        Theme,
        setAccentColor,
        setSkin,
        setTheme,
    )

    setTheme(Theme.LIGHT)
    setSkin(Skin.FLUENT)
    setAccentColor(config.accent_color)
    app = App(sys.argv)
    app.setApplicationName(config.application_name)
    app.setApplicationVersion(config.application_version)
    return app


def _create_services(config, app):
    from melodex_desktop.api_client import ApiClient
    from melodex_desktop.collection_controller import CollectionController
    from melodex_desktop.config import UserSettings
    from melodex_desktop.desktop_state import DesktopState
    from melodex_desktop.player import PlayerController

    settings = UserSettings(config.application_name, app.qapp)
    api = ApiClient(settings, app.qapp)
    collections = CollectionController(api, app.qapp)
    player = PlayerController(api, app.qapp)
    desktop_state = DesktopState(settings, player, app.qapp)
    return settings, api, collections, player, desktop_state


def _publish_context(app, config, icon_path, services, self_test: bool) -> None:
    from PySide6.QtCore import QUrl

    settings, api, collections, player, desktop_state = services
    context = app.engine.rootContext()
    context.setContextProperty(
        "AppConfig",
        {
            "name": config.application_name,
            "version": config.application_version,
            "windowWidth": config.window.width,
            "windowHeight": config.window.height,
            "minimumWindowWidth": config.window.minimum_width,
            "minimumWindowHeight": config.window.minimum_height,
            "iconUrl": QUrl.fromLocalFile(str(icon_path)).toString(),
        },
    )
    context.setContextProperty("UserSettings", settings)
    context.setContextProperty("Api", api)
    context.setContextProperty("Collections", collections)
    context.setContextProperty("Player", player)
    context.setContextProperty("DesktopState", desktop_state)
    context.setContextProperty("HeadlessSelfTest", self_test)


def _load_main_window(app, qml_path):
    from PySide6.QtCore import QObject, QUrl

    app.engine.load(QUrl.fromLocalFile(str(qml_path)))
    if not app.engine.rootObjects():
        print("[ERROR] Melodex PrismQML 主界面加载失败", file=sys.stderr)
        return None
    qml_root = app.engine.rootObjects()[0]
    main_window = qml_root.findChild(QObject, "mainWindow")
    if main_window is None:
        print("[ERROR] 未找到 Melodex 主窗口", file=sys.stderr)
        return None
    return qml_root, main_window


def _show_initial_window(main_window) -> None:
    """Make the QML-owned window visible through Qt's public window API."""

    main_window.show()


def _attach_desktop_lyrics_window(qml_root, desktop_state) -> bool:
    """Attach the QML tool window to its explicit native visibility owner."""

    from PySide6.QtCore import QObject

    lyrics_window = qml_root.findChild(QObject, "desktopLyricsWindow")
    if lyrics_window is None:
        print("[ERROR] 未找到 Melodex 桌面歌词窗口", file=sys.stderr)
        return False
    desktop_state.attach_lyrics_window(lyrics_window)
    return True


def _restore_main_window(main_window) -> None:
    """Restore a tray-hidden window and its PrismQML paint state."""

    main_window.showNormal()
    main_window.restoreVisibleState()
    main_window.raise_()
    main_window.requestActivate()


def _install_tray(app, config, icon, main_window, settings):
    from prismqml import SystemTrayIcon

    def show_main_window() -> None:
        _restore_main_window(main_window)

    tray = SystemTrayIcon(
        icon=icon, parent=app.qapp, toolTip=config.application_name
    )
    _add_tray_actions(tray, app, config, settings, show_main_window)
    tray.show()
    return tray


def _add_tray_actions(tray, app, config, settings, show_main_window) -> None:
    tray.addAction(
        f"显示 {config.application_name}", triggered=show_main_window, actionId="show"
    )
    tray.addAction(
        "显示桌面歌词",
        triggered=settings.toggleLyricsVisible,
        actionId="lyrics-visible",
        checkable=True,
        checked=settings.lyricsVisible,
    )
    tray.addAction(
        "桌面歌词鼠标穿透",
        triggered=settings.toggleClickThrough,
        actionId="click-through",
        checkable=True,
        checked=settings.clickThrough,
    )
    tray.addSeparator()
    tray.addAction("退出", triggered=app.quit, actionId="quit")
    settings.clickThroughChanged.connect(
        lambda: tray.setActionChecked("click-through", settings.clickThrough)
    )
    settings.lyricsVisibleChanged.connect(
        lambda: tray.setActionChecked("lyrics-visible", settings.lyricsVisible)
    )


def _execute(
    app, config, icon, qml_root, main_window, settings, api, self_test: bool
) -> int:
    from PySide6.QtCore import QTimer

    tray = None
    if self_test:
        QTimer.singleShot(500, app.quit)
    else:
        _show_initial_window(main_window)
        tray = _install_tray(app, config, icon, main_window, settings)
        QTimer.singleShot(0, api.checkSession)
    _ = (tray, qml_root)  # Keep QML ownership and Python callbacks alive.
    return app.exec()


def main() -> int:
    _configure_console()
    root = Path(__file__).resolve().parent
    self_test = os.environ.get("MELODEX_DESKTOP_SELFTEST") == "1"
    config = _bootstrap_config(root)

    from PySide6.QtGui import QIcon

    app = _create_application(config)

    icon_path = root.parent / "frontend" / "public" / "logo512.png"
    icon = QIcon(str(icon_path))
    if not icon.isNull():
        app.setWindowIcon(icon)

    services = _create_services(config, app)
    settings, api, _collections, _player, desktop_state = services
    _publish_context(app, config, icon_path, services, self_test)
    loaded_window = _load_main_window(app, root / "qml" / "main.qml")
    if loaded_window is None:
        return -1
    qml_root, main_window = loaded_window
    if not _attach_desktop_lyrics_window(qml_root, desktop_state):
        return -1
    if not icon.isNull():
        main_window.setIcon(icon)

    return _execute(
        app, config, icon, qml_root, main_window, settings, api, self_test
    )


if __name__ == "__main__":
    raise SystemExit(main())
