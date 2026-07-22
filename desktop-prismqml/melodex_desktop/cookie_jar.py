# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only
"""Small persistent Qt cookie jar for automatic Melodex reconnection."""

from __future__ import annotations

import base64
import os
from pathlib import Path

from PySide6.QtCore import QByteArray
from PySide6.QtNetwork import QNetworkCookie, QNetworkCookieJar


class PersistentCookieJar(QNetworkCookieJar):
    """Persist session cookies under the current user's application directory."""

    def __init__(self, path: Path, parent=None) -> None:
        super().__init__(parent)
        self._path = path
        self._load()

    def _load(self) -> None:
        if not self._path.exists():
            return
        try:
            encoded_lines = self._path.read_text(encoding="ascii").splitlines()
        except OSError as exc:
            print(f"[WARN] 读取桌面会话失败：{exc}")
            return

        cookies: list[QNetworkCookie] = []
        for encoded in encoded_lines:
            try:
                raw = base64.b64decode(encoded, validate=True)
            except (ValueError, TypeError) as exc:
                print(f"[WARN] 忽略损坏的桌面会话记录：{exc}")
                continue
            cookies.extend(QNetworkCookie.parseCookies(QByteArray(raw)))
        self.setAllCookies(cookies)

    def save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        lines = [
            base64.b64encode(bytes(cookie.toRawForm(QNetworkCookie.Full))).decode("ascii")
            for cookie in self.allCookies()
        ]
        temporary = self._path.with_suffix(".tmp")
        temporary.write_text("\n".join(lines), encoding="ascii")
        os.replace(temporary, self._path)
        if os.name != "nt":
            os.chmod(self._path, 0o600)

    def clear(self) -> None:
        self.setAllCookies([])
        self.save()
