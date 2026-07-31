import json
import unittest
from pathlib import Path


DESKTOP_ROOT = Path(__file__).resolve().parents[1]


class AboutCardContractTests(unittest.TestCase):
    def test_about_card_uses_published_metadata_and_hyperlink_card(self) -> None:
        config = json.loads(
            (DESKTOP_ROOT / "app_config.json").read_text(encoding="utf-8")
        )
        source = (
            DESKTOP_ROOT / "qml" / "pages" / "SettingsPage.qml"
        ).read_text(encoding="utf-8")
        main_source = (DESKTOP_ROOT / "cpp" / "main.cpp").read_text(
            encoding="utf-8"
        )

        self.assertEqual(
            config["application_description"],
            "全网音乐搜索、播放与下载客户端",
        )
        self.assertEqual(
            config["project_homepage"],
            "https://github.com/aki-riko/Melodex",
        )
        self.assertIn(
            "type: Fluent.Enums.settingCard.type_hyperlink", source
        )
        self.assertIn(
            'title: AppConfig.name + " — " + AppConfig.description', source
        )
        self.assertIn('content: "版本 v" + AppConfig.version', source)
        self.assertIn('+ " · 基于 PrismQML 引擎构建。"', source)
        self.assertIn("url: AppConfig.projectHomepage", source)
        self.assertIn('linkText: "项目主页"', source)
        self.assertIn(
            '{QStringLiteral("description"), config.applicationDescription}',
            main_source,
        )
        self.assertIn(
            '{QStringLiteral("projectHomepage"), config.projectHomepage}',
            main_source,
        )


if __name__ == "__main__":
    unittest.main()
