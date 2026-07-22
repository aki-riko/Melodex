# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only

import unittest
from pathlib import Path


QML_ROOT = Path(__file__).resolve().parents[1] / "qml"


class NativeShellContractTests(unittest.TestCase):
    def test_main_window_uses_prismqml_navigation_shell(self) -> None:
        source = (QML_ROOT / "main.qml").read_text(encoding="utf-8")

        self.assertIn("Fluent.Windows {", source)
        self.assertNotIn("Fluent.WindowsCore {", source)
        self.assertIn('key: "page_3"', source)

    def test_native_shell_registers_all_four_pages(self) -> None:
        source = (QML_ROOT / "main.qml").read_text(encoding="utf-8")

        for object_name in (
            "homePage",
            "searchPage",
            "nowPlayingPage",
            "settingsPage",
        ):
            self.assertIn(f'objectName: "{object_name}"', source)

    def test_settings_copy_does_not_pin_library_version(self) -> None:
        source = (QML_ROOT / "pages" / "SettingsPage.qml").read_text(
            encoding="utf-8"
        )

        self.assertNotIn("0.3.1.34", source)
        self.assertIn("PrismQML 原生界面", source)


if __name__ == "__main__":
    unittest.main()
