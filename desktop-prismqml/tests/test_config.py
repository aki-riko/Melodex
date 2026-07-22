# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only

import unittest

from melodex_desktop.config import normalize_service_url


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


if __name__ == "__main__":
    unittest.main()
