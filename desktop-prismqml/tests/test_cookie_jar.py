# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only

import tempfile
import unittest
from pathlib import Path

from PySide6.QtNetwork import QNetworkCookie

from melodex_desktop.cookie_jar import PersistentCookieJar


class PersistentCookieJarTests(unittest.TestCase):
    def test_round_trips_session_cookie(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "session-cookies.txt"
            cookie = QNetworkCookie(b"melodex_session", b"signed-value")
            cookie.setDomain("music.example.com")
            cookie.setPath("/")

            source = PersistentCookieJar(path)
            source.setAllCookies([cookie])
            source.save()

            restored = PersistentCookieJar(path)
            cookies = restored.allCookies()
            self.assertEqual(len(cookies), 1)
            self.assertEqual(bytes(cookies[0].name()), b"melodex_session")
            self.assertEqual(bytes(cookies[0].value()), b"signed-value")
            self.assertEqual(cookies[0].domain(), "music.example.com")
            self.assertEqual(cookies[0].path(), "/")


if __name__ == "__main__":
    unittest.main()
