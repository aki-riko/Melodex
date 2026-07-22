# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only
"""Application and user configuration for the Melodex desktop client."""

from __future__ import annotations

import json
import math
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from PySide6.QtCore import QObject, Property, QStandardPaths, Signal, Slot


LYRICS_FONT_SIZE_MINIMUM = 20
LYRICS_FONT_SIZE_MAXIMUM = 64
DEFAULT_LYRICS_FONT_SIZE = 36
DEFAULT_LYRICS_COLOR_SCHEME = "珊瑚绯"
DEFAULT_LYRICS_UNPLAYED_COLOR = "#FFEEEEEE"
# Each pair is (played, unplayed). Played colors are midpoint samples from the
# reference swatches; the unplayed swatch is the sampled neutral #EEEEEE.
LYRICS_COLOR_SCHEMES: dict[str, tuple[str, str]] = {
    "珊瑚绯": ("#FFFFC6C6", DEFAULT_LYRICS_UNPLAYED_COLOR),
    "暮霞": ("#FFEEC1D1", DEFAULT_LYRICS_UNPLAYED_COLOR),
    "樱雾": ("#FFFDD6EB", DEFAULT_LYRICS_UNPLAYED_COLOR),
    "晴澜": ("#FFC7E4F1", DEFAULT_LYRICS_UNPLAYED_COLOR),
    "青芽": ("#FFE6FAD0", DEFAULT_LYRICS_UNPLAYED_COLOR),
    "藤影": ("#FFE7E3FB", DEFAULT_LYRICS_UNPLAYED_COLOR),
    "杏月": ("#FFFCE8C2", DEFAULT_LYRICS_UNPLAYED_COLOR),
    "雾银": ("#FFD3D2D2", DEFAULT_LYRICS_UNPLAYED_COLOR),
}
DEFAULT_LYRICS_PLAYED_COLOR = LYRICS_COLOR_SCHEMES[
    DEFAULT_LYRICS_COLOR_SCHEME
][0]
LEGACY_LYRICS_COLOR_SCHEMES = {
    "自定义": DEFAULT_LYRICS_COLOR_SCHEME,
    "网易红": "珊瑚绯",
    "落日晖": "暮霞",
    "可爱粉": "樱雾",
    "天际蓝": "晴澜",
    "清新绿": "青芽",
    "活力紫": "藤影",
    "温柔黄": "杏月",
    "低调灰": "雾银",
}
WINDOWS_LYRICS_FONT_FAMILY = "SimSun"
MACOS_LYRICS_FONT_FAMILY = "Songti SC"


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


def normalize_lyrics_font_size(raw_value: object) -> int:
    """Return a supported whole-pixel lyrics size."""

    if isinstance(raw_value, bool):
        raise ValueError("歌词字号必须是整数")
    try:
        numeric_value = float(raw_value)
    except (TypeError, ValueError) as exc:
        raise ValueError("歌词字号必须是整数") from exc
    if not math.isfinite(numeric_value) or not numeric_value.is_integer():
        raise ValueError("歌词字号必须是整数")
    return max(
        LYRICS_FONT_SIZE_MINIMUM,
        min(LYRICS_FONT_SIZE_MAXIMUM, int(numeric_value)),
    )


def normalize_window_coordinate(raw_value: object) -> int:
    """Validate one persisted native-window coordinate."""

    if isinstance(raw_value, bool):
        raise ValueError("窗口坐标必须是整数")
    try:
        numeric_value = float(raw_value)
    except (TypeError, ValueError) as exc:
        raise ValueError("窗口坐标必须是整数") from exc
    if not math.isfinite(numeric_value) or not numeric_value.is_integer():
        raise ValueError("窗口坐标必须是整数")
    return int(numeric_value)


class UserSettings(QObject):
    """Persist non-secret desktop preferences in the platform config directory."""

    serviceUrlChanged = Signal()
    clickThroughChanged = Signal()
    lyricsVisibleChanged = Signal()
    lyricsFontSizeChanged = Signal()
    lyricsColorSchemeChanged = Signal()
    lyricsPositionChanged = Signal()

    def __init__(
        self,
        app_name: str,
        parent: QObject | None = None,
        *,
        config_root: Path | None = None,
    ) -> None:
        super().__init__(parent)
        resolved_root = config_root or Path(
            QStandardPaths.writableLocation(QStandardPaths.AppConfigLocation)
        )
        self._path = resolved_root / app_name / "desktop-settings.json"
        self._service_url = ""
        self._click_through = True
        self._lyrics_visible = True
        self._lyrics_font_size = DEFAULT_LYRICS_FONT_SIZE
        self._lyrics_color_scheme = DEFAULT_LYRICS_COLOR_SCHEME
        self._lyrics_position_set = False
        self._lyrics_x = 0
        self._lyrics_y = 0
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
        self._load_lyrics_appearance(payload)
        self._load_lyrics_position(payload)

    def _load_lyrics_appearance(self, payload: dict[str, object]) -> None:
        try:
            self._lyrics_font_size = normalize_lyrics_font_size(
                payload.get("desktop_lyrics_font_size", DEFAULT_LYRICS_FONT_SIZE)
            )
        except ValueError as exc:
            print(f"[WARN] 忽略无效桌面歌词字号：{exc}")
        self._lyrics_color_scheme = self._load_lyrics_color_scheme(payload)

    def _load_lyrics_color_scheme(self, payload: dict[str, object]) -> str:
        scheme = str(
            payload.get(
                "desktop_lyrics_color_scheme", DEFAULT_LYRICS_COLOR_SCHEME
            )
        )
        scheme = LEGACY_LYRICS_COLOR_SCHEMES.get(scheme, scheme)
        if scheme not in LYRICS_COLOR_SCHEMES:
            print(f"[WARN] 忽略无效桌面歌词配色方案：{scheme}")
            return DEFAULT_LYRICS_COLOR_SCHEME
        return scheme

    def _load_lyrics_position(self, payload: dict[str, object]) -> None:
        if not bool(payload.get("desktop_lyrics_position_set", False)):
            return
        try:
            lyrics_x = normalize_window_coordinate(payload["desktop_lyrics_x"])
            lyrics_y = normalize_window_coordinate(payload["desktop_lyrics_y"])
        except (KeyError, ValueError) as exc:
            print(f"[WARN] 忽略无效桌面歌词位置：{exc}")
            return
        self._lyrics_x = lyrics_x
        self._lyrics_y = lyrics_y
        self._lyrics_position_set = True

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "service_url": self._service_url,
            "desktop_lyrics_click_through": self._click_through,
            "desktop_lyrics_visible": self._lyrics_visible,
            "desktop_lyrics_font_size": self._lyrics_font_size,
            "desktop_lyrics_color_scheme": self._lyrics_color_scheme,
            "desktop_lyrics_position_set": self._lyrics_position_set,
            "desktop_lyrics_x": self._lyrics_x,
            "desktop_lyrics_y": self._lyrics_y,
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

    def get_lyrics_font_size(self) -> int:
        return self._lyrics_font_size

    @Slot(int)
    def setLyricsFontSize(self, value: int) -> None:
        normalized = normalize_lyrics_font_size(value)
        if normalized == self._lyrics_font_size:
            return
        self._lyrics_font_size = normalized
        self._save()
        self.lyricsFontSizeChanged.emit()

    def get_lyrics_font_family(self) -> str:
        if sys.platform == "darwin":
            return MACOS_LYRICS_FONT_FAMILY
        return WINDOWS_LYRICS_FONT_FAMILY

    def get_lyrics_unplayed_color(self) -> str:
        return LYRICS_COLOR_SCHEMES[self._lyrics_color_scheme][1]

    def get_lyrics_played_color(self) -> str:
        return LYRICS_COLOR_SCHEMES[self._lyrics_color_scheme][0]

    def get_lyrics_color_scheme(self) -> str:
        return self._lyrics_color_scheme

    def get_lyrics_color_scheme_index(self) -> int:
        return list(LYRICS_COLOR_SCHEMES).index(self._lyrics_color_scheme)

    @Slot(int, result=bool)
    def setLyricsColorSchemeIndex(self, index: int) -> bool:
        names = list(LYRICS_COLOR_SCHEMES)
        if index < 0 or index >= len(names):
            print(f"[WARN] 拒绝无效桌面歌词配色索引：{index}")
            return False
        return self._set_lyrics_color_scheme(names[index])

    def _set_lyrics_color_scheme(self, scheme: str) -> bool:
        if scheme == self._lyrics_color_scheme:
            return True
        self._lyrics_color_scheme = scheme
        self._save()
        self.lyricsColorSchemeChanged.emit()
        return True

    def get_lyrics_position_set(self) -> bool:
        return self._lyrics_position_set

    def get_lyrics_x(self) -> int:
        return self._lyrics_x

    def get_lyrics_y(self) -> int:
        return self._lyrics_y

    @Slot(int, int)
    def setLyricsPosition(self, x: int, y: int) -> None:
        normalized_x = normalize_window_coordinate(x)
        normalized_y = normalize_window_coordinate(y)
        if (
            self._lyrics_position_set
            and normalized_x == self._lyrics_x
            and normalized_y == self._lyrics_y
        ):
            return
        self._lyrics_x = normalized_x
        self._lyrics_y = normalized_y
        self._lyrics_position_set = True
        self._save()
        self.lyricsPositionChanged.emit()

    @Slot()
    def resetLyricsPosition(self) -> None:
        if not self._lyrics_position_set:
            return
        self._lyrics_position_set = False
        self._lyrics_x = 0
        self._lyrics_y = 0
        self._save()
        self.lyricsPositionChanged.emit()

    def storage_path(self, filename: str) -> Path:
        """Return a private per-user data path owned by this client."""

        return self._path.parent / filename

    serviceUrl = Property(str, get_service_url, notify=serviceUrlChanged)
    clickThrough = Property(bool, get_click_through, notify=clickThroughChanged)
    lyricsVisible = Property(bool, get_lyrics_visible, notify=lyricsVisibleChanged)
    lyricsFontSize = Property(int, get_lyrics_font_size, notify=lyricsFontSizeChanged)
    lyricsFontSizeMinimum = Property(
        int, lambda _self: LYRICS_FONT_SIZE_MINIMUM, constant=True
    )
    lyricsFontSizeMaximum = Property(
        int, lambda _self: LYRICS_FONT_SIZE_MAXIMUM, constant=True
    )
    lyricsFontFamily = Property(str, get_lyrics_font_family, constant=True)
    lyricsUnplayedColor = Property(
        str, get_lyrics_unplayed_color, notify=lyricsColorSchemeChanged
    )
    lyricsPlayedColor = Property(
        str, get_lyrics_played_color, notify=lyricsColorSchemeChanged
    )
    lyricsColorSchemeNames = Property(
        "QVariantList", lambda _self: list(LYRICS_COLOR_SCHEMES), constant=True
    )
    lyricsColorScheme = Property(
        str, get_lyrics_color_scheme, notify=lyricsColorSchemeChanged
    )
    lyricsColorSchemeIndex = Property(
        int, get_lyrics_color_scheme_index, notify=lyricsColorSchemeChanged
    )
    lyricsPositionSet = Property(
        bool, get_lyrics_position_set, notify=lyricsPositionChanged
    )
    lyricsX = Property(int, get_lyrics_x, notify=lyricsPositionChanged)
    lyricsY = Property(int, get_lyrics_y, notify=lyricsPositionChanged)
