# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only

import re
import unittest
from pathlib import Path


DESKTOP_ROOT = Path(__file__).resolve().parents[1]
QML_ROOT = DESKTOP_ROOT / "qml"


class NativeShellContractTests(unittest.TestCase):
    def test_prismqml_dependency_is_pinned_to_outside_drawer_release(self) -> None:
        requirements = (DESKTOP_ROOT / "requirements.txt").read_text(
            encoding="utf-8"
        )

        self.assertEqual("prismqml==0.3.2.1", requirements.strip())

    def test_main_window_uses_prismqml_navigation_shell(self) -> None:
        source = (QML_ROOT / "main.qml").read_text(encoding="utf-8")

        self.assertIn("Fluent.Windows {", source)
        self.assertNotIn("Fluent.WindowsCore {", source)
        self.assertIn('key: "page_4"', source)

    def test_native_shell_registers_all_five_pages(self) -> None:
        source = (QML_ROOT / "main.qml").read_text(encoding="utf-8")

        for object_name in (
            "homePage",
            "searchPage",
            "playlistsPage",
            "nowPlayingPage",
            "settingsPage",
        ):
            self.assertIn(f'objectName: "{object_name}"', source)

    def test_now_playing_uses_native_outside_queue_drawer(self) -> None:
        main = (QML_ROOT / "main.qml").read_text(encoding="utf-8")
        player = (QML_ROOT / "pages" / "NowPlayingPage.qml").read_text(
            encoding="utf-8"
        )
        drawer = (QML_ROOT / "components" / "PlaybackQueueDrawer.qml").read_text(
            encoding="utf-8"
        )
        header = (
            DESKTOP_ROOT / "cpp" / "include" / "melodex" / "PlayerController.h"
        ).read_text(encoding="utf-8")

        self.assertIn("signal queueRequested()", player)
        self.assertIn("Player.queue.length", player)
        self.assertIn("onQueueRequested: playbackQueueDrawer.open()", main)
        self.assertIn("parent: mainWindow.contentItem", main)
        self.assertIn("Fluent.Drawer {", drawer)
        self.assertIn("mode: Fluent.Enums.drawer.mode_outside", drawer)
        self.assertIn("position: Fluent.Enums.position.right", drawer)
        self.assertIn("model: Player.queue", drawer)
        self.assertIn("currentIndex: Player.queueIndex", drawer)
        self.assertIn("Player.playQueueIndex(index)", drawer)
        self.assertIn("Q_PROPERTY(QVariantList queue", header)
        self.assertIn("Q_PROPERTY(int queueIndex", header)
        self.assertIn("Q_INVOKABLE void playQueueIndex(int index)", header)

    def test_settings_copy_does_not_pin_library_version(self) -> None:
        source = (QML_ROOT / "pages" / "SettingsPage.qml").read_text(
            encoding="utf-8"
        )

        self.assertNotIn("0.3.1.34", source)
        self.assertIn("PrismQML 原生界面", source)

    def test_application_uses_light_fluent_skin(self) -> None:
        source = (DESKTOP_ROOT / "main.py").read_text(encoding="utf-8")

        self.assertIn("setTheme(Theme.LIGHT)", source)
        self.assertIn("setSkin(Skin.FLUENT)", source)
        self.assertNotIn("setTheme(Theme.DARK)", source)
        self.assertNotIn("setSkin(Skin.PRISM_DESIGN)", source)

    def test_cpp_tray_is_owned_and_rendered_by_prismqml(self) -> None:
        source = (DESKTOP_ROOT / "cpp" / "main.cpp").read_text(encoding="utf-8")

        self.assertIn("app.createSystemTrayIcon(", source)
        self.assertIn('showOptions.icon = QStringLiteral("Window")', source)
        self.assertIn('quitOptions.icon = QStringLiteral("Power")', source)
        self.assertNotIn("new prism::SystemTrayIcon", source)

    def test_startup_uses_published_prismqml_splash_screen(self) -> None:
        source = (QML_ROOT / "main.qml").read_text(encoding="utf-8")

        self.assertIn("Fluent.SplashScreen {", source)
        self.assertIn('_splashInstance: startupSplash', source)
        self.assertIn('objectName: "startupSplashScreen"', source)
        self.assertIn("parent: mainWindow.contentItem", source)

    def test_player_sliders_format_tooltips_for_their_units(self) -> None:
        source = (QML_ROOT / "components" / "PlayerBar.qml").read_text(
            encoding="utf-8"
        )

        self.assertIn('return (minutes < 10 ? "0" : "") + minutes', source)
        self.assertIn("displayValueFn: value => root.timeText(value)", source)
        self.assertIn(
            'displayValueFn: value => Math.round(value * 100) + "%"', source
        )

    def test_now_playing_lyrics_use_an_immersive_karaoke_focus(self) -> None:
        source = (QML_ROOT / "pages" / "NowPlayingPage.qml").read_text(
            encoding="utf-8"
        )

        self.assertIn('text: "同步歌词"', source)
        self.assertIn('text: Player.playing ? "自动跟随" : "已暂停"', source)
        self.assertIn("selectable: false", source)
        self.assertNotIn("selectable: true", source)
        self.assertIn("WordFill {", source)
        self.assertIn("FrameAnimation {", source)
        self.assertIn(
            "running: root.visible && Player.playing && Player.hasLyrics", source
        )
        self.assertIn(
            "onTriggered: root.lyricDisplayPosition = Player.visualPosition()", source
        )
        self.assertIn("Player.visualLyricIndex(lyricDisplayPosition)", source)
        self.assertIn(
            "Player.visualLyricProgress(displayLyricIndex, lyricDisplayPosition)",
            source,
        )
        self.assertIn("? root.displayLyricProgress : 0", source)
        self.assertNotIn("progress: Player.currentLyricProgress", source)
        self.assertIn("distanceFromCurrent", source)
        self.assertIn("Behavior on opacity", source)
        self.assertIn("Behavior on scale", source)
        self.assertIn("function centerCurrentLyric()", source)
        self.assertIn("currentIndex: -1", source)
        self.assertIn("scrollDuration: Fluent.Enums.duration.slower", source)
        self.assertIn("scrollEasing: Easing.OutCubic", source)
        self.assertIn("lyricList.smoothScrollTo(centeredY)", source)
        self.assertNotIn("positionViewAtIndex", source)

    def test_pages_reuse_published_prismqml_components(self) -> None:
        home = (QML_ROOT / "pages" / "HomePage.qml").read_text(encoding="utf-8")
        settings = (QML_ROOT / "pages" / "SettingsPage.qml").read_text(
            encoding="utf-8"
        )
        player = (QML_ROOT / "pages" / "NowPlayingPage.qml").read_text(
            encoding="utf-8"
        )
        playlists = (QML_ROOT / "pages" / "PlaylistsPage.qml").read_text(
            encoding="utf-8"
        )
        search = (QML_ROOT / "pages" / "SearchPage.qml").read_text(
            encoding="utf-8"
        )
        song_row = (QML_ROOT / "components" / "SongRow.qml").read_text(
            encoding="utf-8"
        )
        player_bar = (QML_ROOT / "components" / "PlayerBar.qml").read_text(
            encoding="utf-8"
        )
        lyrics_window = (
            QML_ROOT / "components" / "DesktopLyricsWindow.qml"
        ).read_text(encoding="utf-8")

        self.assertIn("Fluent.ScrollArea {", home)
        self.assertIn("Fluent.ScrollArea {", settings)
        self.assertIn("Fluent.ScrollArea {", player)
        self.assertIn("Fluent.SplitPane {", playlists)
        self.assertIn("Fluent.ListWidget {", playlists)
        self.assertIn("Fluent.ComboBox {", search)
        self.assertNotIn("Flickable {", home + settings)
        self.assertNotIn("ListView {", player)
        self.assertIn(
            "firstContent: Item {\n                anchors.fill: parent", player
        )
        self.assertIn(
            "secondContent: Item {\n                anchors.fill: parent", player
        )
        self.assertIn("Fluent.ImageWidget {", song_row)
        self.assertIn("Fluent.ImageWidget {", player_bar)
        self.assertIn("Fluent.WindowDragHandle {", lyrics_window)
        self.assertIn("Fluent.Card {", lyrics_window)
        self.assertIn("Item {\n        id: lyricSurface", lyrics_window)
        self.assertIn("id: lyricSurface", lyrics_window)
        self.assertNotIn("color: Qt.rgba(0.025, 0.035, 0.055", lyrics_window)
        self.assertIn("restingOpacity: 0.96", lyrics_window)
        self.assertIn("opacity: 0.92", lyrics_window)
        self.assertIn("readonly property bool controlsVisible", lyrics_window)
        self.assertIn("Fluent.Enums.icon.previous", lyrics_window)
        self.assertIn("Fluent.Enums.icon.desktop_cursor", lyrics_window)
        self.assertIn("Player.togglePlay()", lyrics_window)
        self.assertIn("UserSettings.setLyricsPosition(", lyrics_window)
        self.assertIn("UserSettings.lyricsFontSize", lyrics_window)
        self.assertIn("fontFamily: UserSettings.lyricsFontFamily", lyrics_window)
        self.assertIn('content: "宋体（固定） · 当前 "', settings)
        self.assertIn("FrameAnimation {", lyrics_window)
        self.assertIn(
            "running: lyricsWindow.visible && Player.playing && Player.hasLyrics",
            lyrics_window,
        )
        self.assertIn("Player.visualPosition()", lyrics_window)
        self.assertIn("Player.visualLyricIndex(displayPosition)", lyrics_window)
        self.assertIn("Player.visualLyricProgress(", lyrics_window)
        self.assertNotIn("interval: 16", lyrics_window)
        self.assertIn("bold: true", lyrics_window)
        self.assertIn("restingColor: UserSettings.lyricsUnplayedColor", lyrics_window)
        self.assertIn("activeColor: UserSettings.lyricsPlayedColor", lyrics_window)
        self.assertIn("outlineColor: Qt.rgba(0.02, 0.025, 0.03, 0.90)", lyrics_window)
        self.assertIn("shadowColor: Qt.rgba(0, 0, 0, 0.72)", lyrics_window)
        self.assertIn("shadowBlur: 0.18", lyrics_window)
        self.assertIn("shadowVerticalOffset: 2", lyrics_window)
        self.assertEqual(1, lyrics_window.count("layer.effect: Fluent.Shadow"))
        self.assertEqual(1, lyrics_window.count("renderType: Text.QtRendering"))
        self.assertEqual(1, lyrics_window.count("style: Text.Outline"))
        self.assertNotIn("renderType: Text.NativeRendering", lyrics_window)
        self.assertIn("id: positionSaveTimer", lyrics_window)
        self.assertIn('objectName: "desktopLyricsWindow"', lyrics_window)
        self.assertIn("visible: false", lyrics_window)
        self.assertNotIn("MouseArea {", lyrics_window)

        self.assertIn("Fluent.Enums.settingCard.type_range", settings)
        self.assertIn("Fluent.Enums.settingCard.type_combobox", settings)
        self.assertNotIn("Fluent.Enums.settingCard.type_color", settings)
        self.assertIn("UserSettings.setLyricsFontSize", settings)
        self.assertIn("UserSettings.setLyricsColorSchemeIndex", settings)
        self.assertNotIn("UserSettings.setLyricsUnplayedColor", settings)
        self.assertNotIn("UserSettings.setLyricsPlayedColor", settings)
        self.assertIn("UserSettings.resetLyricsPosition", settings)

        word_fill = (QML_ROOT / "components" / "WordFill.qml").read_text(
            encoding="utf-8"
        )
        self.assertIn("baseLabel.paintedWidth", word_fill)
        self.assertIn("root.textPaintedWidth * root.clampedProgress", word_fill)
        self.assertEqual(2, word_fill.count("font.family: root.fontFamily"))
        self.assertEqual(2, word_fill.count("renderType: Text.QtRendering"))
        self.assertEqual(2, word_fill.count("style: Text.Outline"))
        self.assertEqual(2, word_fill.count("styleColor: root.outlineColor"))
        self.assertEqual(2, word_fill.count("Text.VeryHighRenderTypeQuality"))
        self.assertEqual(1, word_fill.count("layer.effect: Fluent.Shadow"))
        self.assertNotIn("renderType: Text.NativeRendering", word_fill)
        self.assertNotIn("style: Text.Raised", word_fill)
        self.assertNotIn("id: shadowLabel", word_fill)
        self.assertNotIn("root.width * Math.max", word_fill)

        raw_visual_pattern = re.compile(
            r"^\s*(?:Rectangle|Flickable|ListView|GridView|ScrollView|Image|"
            r"Text|MouseArea|Button|TextField|Slider)\s*\{"
        )
        raw_visual_lines = [
            f"{path.relative_to(QML_ROOT)}:{line_number}:{line.strip()}"
            for path in QML_ROOT.rglob("*.qml")
            for line_number, line in enumerate(
                path.read_text(encoding="utf-8").splitlines(), start=1
            )
            if raw_visual_pattern.match(line)
        ]
        self.assertEqual([], raw_visual_lines)


if __name__ == "__main__":
    unittest.main()
