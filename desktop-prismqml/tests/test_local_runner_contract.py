# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only

import unittest
from pathlib import Path


DESKTOP_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = DESKTOP_ROOT.parent


class LocalRunnerContractTests(unittest.TestCase):
    def test_local_machine_configuration_is_ignored(self) -> None:
        desktop_ignore = (DESKTOP_ROOT / ".gitignore").read_text(encoding="utf-8")

        self.assertIn("/run-local.config.psd1", desktop_ignore.splitlines())

    def test_runner_uses_one_local_config_and_stable_output_directories(self) -> None:
        runner = (DESKTOP_ROOT / "run-local.ps1").read_text(encoding="utf-8")
        example = (DESKTOP_ROOT / "run-local.config.example.psd1").read_text(
            encoding="utf-8"
        )

        self.assertIn("run-local.config.psd1", runner)
        self.assertIn("Import-PowerShellDataFile", runner)
        self.assertIn("LocalApplicationData", runner)
        self.assertIn("desktop-build", runner)
        self.assertIn("desktop-deploy", runner)
        self.assertIn("prism-sdk-cache", runner)
        self.assertIn("Copy-Item", runner)
        self.assertIn("%LOCALAPPDATA%\\Melodex\\desktop-build", example)
        self.assertIn("%LOCALAPPDATA%\\Melodex\\desktop-deploy", example)

        for committed_source in (runner, example):
            self.assertNotIn("D:\\Qt", committed_source)
            self.assertNotIn("C:\\Users\\Kotori", committed_source)
            self.assertNotIn("D:\\PrismQML", committed_source)

    def test_runner_enforces_full_build_test_deploy_restart_order(self) -> None:
        runner = (DESKTOP_ROOT / "run-local.ps1").read_text(encoding="utf-8")
        markers = (
            "'unittest', 'discover'",
            "'-S', $PSScriptRoot",
            "'--build', $buildDir",
            "'--test-dir', $buildDir",
            "Stop-Process -Force",
            "Wait-FileUnlocked -Path $deployedExe",
            "'--install', $buildDir",
            "Invoke-Native -Command $winDeployQt",
            "Remove-Item Env:PRISMQML_QML_DIR",
            "Start-Process -FilePath $deployedExe",
        )

        positions = [runner.index(marker) for marker in markers]
        self.assertEqual(sorted(positions), positions)
        self.assertIn("-Dprism_DIR:PATH=$prismConfigDir", runner)
        self.assertIn("share\\prism\\qml\\PrismQML\\qmldir", runner)
        self.assertIn("$configuredPrismSdkRoot", runner)
        self.assertIn("$prismSdkRoot", runner)
        self.assertIn("[IO.FileShare]::None", runner)

    def test_readme_exposes_direct_executable_as_the_single_daily_command(self) -> None:
        readme = (DESKTOP_ROOT / "README.md").read_text(encoding="utf-8")
        daily_section = readme.split("## 日常启动", 1)[1].split(
            "## 开发构建与完整验证", 1
        )[0]

        self.assertIn(
            '& "$env:LOCALAPPDATA\\Melodex\\desktop-deploy\\bin\\melodex_desktop.exe"',
            daily_section,
        )
        self.assertNotIn("run-local.ps1", daily_section)
        self.assertNotIn("run-local.cmd", readme)
        self.assertIn("不执行 Python 测试、CMake/CTest、安装或", daily_section)
        self.assertNotIn("MELODEX_BUILD_DIR", readme)
        self.assertNotIn("MELODEX_DEPLOY_DIR", readme)

    def test_agents_requires_the_same_launch_only_command(self) -> None:
        agents = (REPOSITORY_ROOT / "AGENTS.md").read_text(encoding="utf-8")
        command = (
            '& "$env:LOCALAPPDATA\\Melodex\\desktop-deploy\\bin\\melodex_desktop.exe"'
        )

        self.assertIn(command, agents)
        self.assertIn("不调用 Python、CMake、CTest、安装或部署", agents)
        self.assertIn("不得把它当成日常启动器", agents)


if __name__ == "__main__":
    unittest.main()
