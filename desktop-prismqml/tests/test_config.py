# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only

import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from melodex_desktop.config import (
    DEFAULT_LYRICS_COLOR_SCHEME,
    DEFAULT_LYRICS_FONT_SIZE,
    DEFAULT_LYRICS_PLAYED_COLOR,
    DEFAULT_LYRICS_UNPLAYED_COLOR,
    LYRICS_FONT_SIZE_MAXIMUM,
    LYRICS_FONT_SIZE_MINIMUM,
    LYRICS_COLOR_SCHEMES,
    MACOS_LYRICS_FONT_FAMILY,
    UserSettings,
    WINDOWS_LYRICS_FONT_FAMILY,
    normalize_service_url,
)


class NormalizeServiceUrlTests(unittest.TestCase):
    def test_adds_https_and_normalizes_to_service_root(self) -> None:
        self.assertEqual(
            normalize_service_url(" music.example.com/path?q=1 "),
            "https://music.example.com/",
        )

    def test_allows_plain_http_for_loopback_development(self) -> None:
        self.assertEqual(
            normalize_service_url("http://127.0.0.1:8329"),
            "http://127.0.0.1:8329/",
        )
        self.assertEqual(
            normalize_service_url("http://[::1]:8329"),
            "http://[::1]:8329/",
        )

    def test_rejects_remote_http_and_embedded_credentials(self) -> None:
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            normalize_service_url("http://music.example.com")
        with self.assertRaisesRegex(ValueError, "账号或密码"):
            normalize_service_url("https://user:pass@music.example.com")

    def test_rejects_empty_or_non_http_address(self) -> None:
        with self.assertRaisesRegex(ValueError, "请填写"):
            normalize_service_url("  ")
        with self.assertRaisesRegex(ValueError, "格式"):
            normalize_service_url("ftp://music.example.com")


class UserSettingsLyricsTests(unittest.TestCase):
    @staticmethod
    def _write_settings(config_root: Path, payload: dict[str, object]) -> None:
        settings_path = config_root / "MelodexTest" / "desktop-settings.json"
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        settings_path.write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8"
        )

    def test_lyrics_size_and_preset_persist_and_reload(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            config_root = Path(temporary_directory)
            settings = UserSettings("MelodexTest", config_root=config_root)

            settings.setLyricsFontSize(48)
            preset_index = list(LYRICS_COLOR_SCHEMES).index("樱雾")
            self.assertTrue(settings.setLyricsColorSchemeIndex(preset_index))

            restored = UserSettings("MelodexTest", config_root=config_root)
            self.assertEqual(48, restored.lyricsFontSize)
            self.assertEqual("樱雾", restored.lyricsColorScheme)
            self.assertEqual("#FFFDD6EB", restored.lyricsPlayedColor)
            self.assertEqual("#FFEEEEEE", restored.lyricsUnplayedColor)

    def test_font_size_is_clamped_to_supported_range(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            config_root = Path(temporary_directory)
            settings = UserSettings("MelodexTest", config_root=config_root)
            settings.setLyricsFontSize(999)
            self.assertEqual(LYRICS_FONT_SIZE_MAXIMUM, settings.lyricsFontSize)
            settings.setLyricsFontSize(-1)
            self.assertEqual(LYRICS_FONT_SIZE_MINIMUM, settings.lyricsFontSize)

    def test_invalid_saved_appearance_falls_back_with_warnings(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            config_root = Path(temporary_directory)
            self._write_settings(
                config_root,
                {
                    "desktop_lyrics_font_size": "很大",
                    "desktop_lyrics_color_scheme": "不存在的方案",
                },
            )
            warnings = io.StringIO()
            with redirect_stdout(warnings):
                restored = UserSettings("MelodexTest", config_root=config_root)

            self.assertEqual(DEFAULT_LYRICS_FONT_SIZE, restored.lyricsFontSize)
            self.assertEqual(
                DEFAULT_LYRICS_UNPLAYED_COLOR, restored.lyricsUnplayedColor
            )
            self.assertEqual(DEFAULT_LYRICS_PLAYED_COLOR, restored.lyricsPlayedColor)
            self.assertEqual(
                DEFAULT_LYRICS_COLOR_SCHEME, restored.lyricsColorScheme
            )
            self.assertIn("无效桌面歌词字号", warnings.getvalue())
            self.assertIn("无效桌面歌词配色方案", warnings.getvalue())

    def test_font_family_and_preset_colors_are_not_user_editable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            config_root = Path(temporary_directory)
            settings = UserSettings("MelodexTest", config_root=config_root)

            expected_family = (
                MACOS_LYRICS_FONT_FAMILY
                if sys.platform == "darwin"
                else WINDOWS_LYRICS_FONT_FAMILY
            )
            self.assertEqual(expected_family, settings.lyricsFontFamily)
            self.assertFalse(hasattr(settings, "setLyricsFontFamily"))
            self.assertFalse(hasattr(settings, "setLyricsPlayedColor"))
            self.assertFalse(hasattr(settings, "setLyricsUnplayedColor"))

    def test_reference_color_schemes_use_sampled_swatch_colors(self) -> None:
        expected = {
            "珊瑚绯": ("#FFFFC6C6", "#FFEEEEEE"),
            "暮霞": ("#FFEEC1D1", "#FFEEEEEE"),
            "樱雾": ("#FFFDD6EB", "#FFEEEEEE"),
            "晴澜": ("#FFC7E4F1", "#FFEEEEEE"),
            "青芽": ("#FFE6FAD0", "#FFEEEEEE"),
            "藤影": ("#FFE7E3FB", "#FFEEEEEE"),
            "杏月": ("#FFFCE8C2", "#FFEEEEEE"),
            "雾银": ("#FFD3D2D2", "#FFEEEEEE"),
        }

        self.assertEqual(expected, LYRICS_COLOR_SCHEMES)

    def test_color_scheme_applies_both_colors_and_persists(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            config_root = Path(temporary_directory)
            settings = UserSettings("MelodexTest", config_root=config_root)
            names = list(LYRICS_COLOR_SCHEMES)
            sky_blue_index = names.index("晴澜")

            self.assertTrue(settings.setLyricsColorSchemeIndex(sky_blue_index))
            self.assertEqual("晴澜", settings.lyricsColorScheme)
            self.assertEqual("#FFC7E4F1", settings.lyricsPlayedColor)
            self.assertEqual(DEFAULT_LYRICS_UNPLAYED_COLOR, settings.lyricsUnplayedColor)

            restored = UserSettings("MelodexTest", config_root=config_root)
            self.assertEqual("晴澜", restored.lyricsColorScheme)
            self.assertEqual(sky_blue_index, restored.lyricsColorSchemeIndex)
            self.assertEqual("#FFC7E4F1", restored.lyricsPlayedColor)

    def test_legacy_color_scheme_names_migrate_to_new_names(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            config_root = Path(temporary_directory)
            self._write_settings(
                config_root, {"desktop_lyrics_color_scheme": "可爱粉"}
            )
            restored = UserSettings("MelodexTest", config_root=config_root)
            self.assertEqual("樱雾", restored.lyricsColorScheme)

            self._write_settings(
                config_root, {"desktop_lyrics_color_scheme": "自定义"}
            )
            custom = UserSettings("MelodexTest", config_root=config_root)
            self.assertEqual(DEFAULT_LYRICS_COLOR_SCHEME, custom.lyricsColorScheme)

    def test_lyrics_position_persists_and_can_be_reset(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            config_root = Path(temporary_directory)
            settings = UserSettings("MelodexTest", config_root=config_root)
            settings.setLyricsPosition(-1280, 420)

            restored = UserSettings("MelodexTest", config_root=config_root)
            self.assertTrue(restored.lyricsPositionSet)
            self.assertEqual(-1280, restored.lyricsX)
            self.assertEqual(420, restored.lyricsY)

            restored.resetLyricsPosition()
            reset = UserSettings("MelodexTest", config_root=config_root)
            self.assertFalse(reset.lyricsPositionSet)
            self.assertEqual(0, reset.lyricsX)
            self.assertEqual(0, reset.lyricsY)

    def test_invalid_saved_position_is_ignored_with_warning(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            config_root = Path(temporary_directory)
            settings_path = (
                config_root / "MelodexTest" / "desktop-settings.json"
            )
            settings_path.parent.mkdir(parents=True)
            settings_path.write_text(
                json.dumps(
                    {
                        "desktop_lyrics_position_set": True,
                        "desktop_lyrics_x": "left",
                        "desktop_lyrics_y": 240,
                    }
                ),
                encoding="utf-8",
            )
            warnings = io.StringIO()
            with redirect_stdout(warnings):
                settings = UserSettings("MelodexTest", config_root=config_root)

            self.assertFalse(settings.lyricsPositionSet)
            self.assertIn("无效桌面歌词位置", warnings.getvalue())


if __name__ == "__main__":
    unittest.main()
