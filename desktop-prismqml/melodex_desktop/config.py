# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only
"""Application and user configuration for the Melodex desktop client."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from PySide6.QtCore import QObject, Property, QStandardPaths, Signal, Slot


@dataclass(frozen=True)
class WindowConfig:
    width: int
    height: int
    minimum_width: int
    minimum_height: int


@dataclass(frozen=True)
class ApplicationConfig:
    application_name: str
    application_version: str
    application_id: str
    accent_color: str
    window: WindowConfig


def load_application_config(path: Path) -> ApplicationConfig:
    """Load required application metadata from a repository-owned JSON file."""

    payload = json.loads(path.read_text(encoding="utf-8"))
    window = payload["window"]
    return ApplicationConfig(
        application_name=str(payload["application_name"]),
        application_version=str(payload["application_version"]),
        application_id=str(payload["application_id"]),
        accent_color=str(payload["accent_color"]),
        window=WindowConfig(
            width=int(window["width"]),
            height=int(window["height"]),
            minimum_width=int(window["minimum_width"]),
            minimum_height=int(window["minimum_height"]),
        ),
    )


def normalize_service_url(raw_value: str) -> str:
    """Normalize one Melodex server root while rejecting unsafe remote HTTP."""

    value = raw_value.strip()
    if not value:
        raise ValueError("请填写 Melodex 服务地址")
    if "://" not in value:
        value = f"https://{value}"
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("服务地址格式不正确")
    if parsed.username or parsed.password:
        raise ValueError("服务地址不能包含账号或密码")
    loopback_hosts = {"localhost", "127.0.0.1", "::1"}
    if parsed.scheme == "http" and parsed.hostname.lower() not in loopback_hosts:
        raise ValueError("非本机服务必须使用 HTTPS")
    netloc = parsed.hostname
    if ":" in netloc and not netloc.startswith("["):
        netloc = f"[{netloc}]"
    if parsed.port is not None:
        netloc = f"{netloc}:{parsed.port}"
    return urlunsplit((parsed.scheme, netloc, "/", "", ""))


class UserSettings(QObject):
    """Persist non-secret desktop preferences in the platform config directory."""

    serviceUrlChanged = Signal()
    clickThroughChanged = Signal()
    lyricsVisibleChanged = Signal()

    def __init__(self, app_name: str, parent: QObject | None = None) -> None:
        super().__init__(parent)
        config_root = Path(QStandardPaths.writableLocation(QStandardPaths.AppConfigLocation))
        self._path = config_root / app_name / "desktop-settings.json"
        self._service_url = ""
        self._click_through = True
        self._lyrics_visible = True
        self._load()

    def _load(self) -> None:
        if not self._path.exists():
            return
        try:
            payload = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            print(f"[WARN] 读取桌面客户端设置失败：{exc}")
            return
        raw_url = str(payload.get("service_url", ""))
        if raw_url:
            try:
                self._service_url = normalize_service_url(raw_url)
            except ValueError as exc:
                print(f"[WARN] 忽略无效服务地址：{exc}")
        self._click_through = bool(payload.get("desktop_lyrics_click_through", True))
        self._lyrics_visible = bool(payload.get("desktop_lyrics_visible", True))

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "service_url": self._service_url,
            "desktop_lyrics_click_through": self._click_through,
            "desktop_lyrics_visible": self._lyrics_visible,
        }
        temporary = self._path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        os.replace(temporary, self._path)
        if os.name != "nt":
            os.chmod(self._path, 0o600)

    def get_service_url(self) -> str:
        return self._service_url

    @Slot(str, result=bool)
    def setServiceUrl(self, value: str) -> bool:
        normalized = normalize_service_url(value)
        if normalized == self._service_url:
            return True
        self._service_url = normalized
        self._save()
        self.serviceUrlChanged.emit()
        return True

    def get_click_through(self) -> bool:
        return self._click_through

    @Slot(bool)
    def setClickThrough(self, enabled: bool) -> None:
        enabled = bool(enabled)
        if enabled == self._click_through:
            return
        self._click_through = enabled
        self._save()
        self.clickThroughChanged.emit()

    @Slot()
    def toggleClickThrough(self) -> None:
        self.setClickThrough(not self._click_through)

    def get_lyrics_visible(self) -> bool:
        return self._lyrics_visible

    @Slot(bool)
    def setLyricsVisible(self, visible: bool) -> None:
        visible = bool(visible)
        if visible == self._lyrics_visible:
            return
        self._lyrics_visible = visible
        self._save()
        self.lyricsVisibleChanged.emit()

    @Slot()
    def toggleLyricsVisible(self) -> None:
        self.setLyricsVisible(not self._lyrics_visible)

    def storage_path(self, filename: str) -> Path:
        """Return a private per-user data path owned by this client."""

        return self._path.parent / filename

    serviceUrl = Property(str, get_service_url, notify=serviceUrlChanged)
    clickThrough = Property(bool, get_click_through, notify=clickThroughChanged)
    lyricsVisible = Property(bool, get_lyrics_visible, notify=lyricsVisibleChanged)
