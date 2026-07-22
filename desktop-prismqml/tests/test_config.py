# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from melodex_desktop.config import (
    CUSTOM_LYRICS_COLOR_SCHEME,
    DEFAULT_LYRICS_FONT_SIZE,
    DEFAULT_LYRICS_PLAYED_COLOR,
    DEFAULT_LYRICS_UNPLAYED_COLOR,
    LYRICS_FONT_SIZE_MAXIMUM,
    LYRICS_FONT_SIZE_MINIMUM,
    LYRICS_COLOR_SCHEMES,
    UserSettings,
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

    def test_lyrics_preferences_persist_and_reload_independently(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            config_root = Path(temporary_directory)
            settings = UserSettings("MelodexTest", config_root=config_root)

            settings.setLyricsFontSize(48)
            self.assertTrue(settings.setLyricsUnplayedColor("#112233"))
            self.assertTrue(settings.setLyricsPlayedColor("#80445566"))

            restored = UserSettings("MelodexTest", config_root=config_root)
            self.assertEqual(48, restored.lyricsFontSize)
            self.assertEqual("#FF112233", restored.lyricsUnplayedColor)
            self.assertEqual("#80445566", restored.lyricsPlayedColor)

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
                    "desktop_lyrics_unplayed_color": "not-a-color",
                    "desktop_lyrics_played_color": None,
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
                CUSTOM_LYRICS_COLOR_SCHEME, restored.lyricsColorScheme
            )
            self.assertIn("无效桌面歌词字号", warnings.getvalue())
            self.assertIn("无效未播放歌词颜色", warnings.getvalue())
            self.assertIn("无效已播放歌词颜色", warnings.getvalue())
            self.assertIn("无效桌面歌词配色方案", warnings.getvalue())

    def test_invalid_color_update_is_rejected_without_changing_saved_value(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            config_root = Path(temporary_directory)
            settings = UserSettings("MelodexTest", config_root=config_root)
            warnings = io.StringIO()

            with redirect_stdout(warnings):
                accepted = settings.setLyricsPlayedColor("definitely-invalid")

            self.assertFalse(accepted)
            self.assertEqual(DEFAULT_LYRICS_PLAYED_COLOR, settings.lyricsPlayedColor)
            self.assertIn("拒绝无效桌面歌词颜色", warnings.getvalue())

    def test_reference_color_schemes_use_sampled_swatch_colors(self) -> None:
        expected = {
            "自定义": None,
            "网易红": "#FFFFC6C6",
            "落日晖": "#FFEEC1D1",
            "可爱粉": "#FFFDD6EB",
            "天际蓝": "#FFC7E4F1",
            "清新绿": "#FFE6FAD0",
            "活力紫": "#FFE7E3FB",
            "温柔黄": "#FFFCE8C2",
            "低调灰": "#FFD3D2D2",
        }

        self.assertEqual(expected, LYRICS_COLOR_SCHEMES)

    def test_color_scheme_applies_played_color_and_persists(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            config_root = Path(temporary_directory)
            settings = UserSettings("MelodexTest", config_root=config_root)
            names = list(LYRICS_COLOR_SCHEMES)
            sky_blue_index = names.index("天际蓝")

            self.assertTrue(settings.setLyricsColorSchemeIndex(sky_blue_index))
            self.assertEqual("天际蓝", settings.lyricsColorScheme)
            self.assertEqual("#FFC7E4F1", settings.lyricsPlayedColor)
            self.assertEqual(DEFAULT_LYRICS_UNPLAYED_COLOR, settings.lyricsUnplayedColor)

            restored = UserSettings("MelodexTest", config_root=config_root)
            self.assertEqual("天际蓝", restored.lyricsColorScheme)
            self.assertEqual(sky_blue_index, restored.lyricsColorSchemeIndex)
            self.assertEqual("#FFC7E4F1", restored.lyricsPlayedColor)

            restored.setLyricsUnplayedColor("#ABCDEF")
            self.assertEqual("天际蓝", restored.lyricsColorScheme)
            restored.setLyricsPlayedColor("#123456")
            custom = UserSettings("MelodexTest", config_root=config_root)
            self.assertEqual(CUSTOM_LYRICS_COLOR_SCHEME, custom.lyricsColorScheme)
            self.assertEqual("#FF123456", custom.lyricsPlayedColor)

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
