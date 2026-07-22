# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only
"""Asynchronous Qt network client for the Melodex JSON API."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlencode

from PySide6.QtCore import (
    QByteArray,
    QCoreApplication,
    QObject,
    Property,
    QUrl,
    QUrlQuery,
    Signal,
    Slot,
)
from PySide6.QtNetwork import (
    QNetworkAccessManager,
    QNetworkReply,
    QNetworkRequest,
)

from .config import UserSettings, normalize_service_url
from .cookie_jar import PersistentCookieJar
from .playback_proxy import AuthenticatedHttpProxy


def _as_float(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError) as exc:
        print(f"[WARN] 忽略无效歌曲时长 {value!r}：{exc}")
        return 0.0


def normalize_song(value: dict[str, Any]) -> dict[str, Any]:
    """Normalize source field variants into the desktop-client contract."""

    song = value or {}
    extra = song.get("extra") if isinstance(song.get("extra"), dict) else {}
    return {
        **song,
        "id": str(song.get("id") or song.get("song_id") or song.get("ID") or ""),
        "source": str(song.get("source") or song.get("Source") or ""),
        "name": str(song.get("name") or song.get("Name") or "").strip(),
        "artist": str(song.get("artist") or song.get("Artist") or "").strip(),
        "album": str(song.get("album") or song.get("Album") or extra.get("album") or "").strip(),
        "cover": str(song.get("cover") or song.get("Cover") or "").strip(),
        "duration": _as_float(song.get("duration") or song.get("Duration") or 0),
        "extra": extra,
    }


def song_query(song: dict[str, Any], **extra_values: str) -> QUrlQuery:
    """Build the query contract used by lyrics, streaming and downloads."""

    normalized = normalize_song(song)
    query = QUrlQuery()
    for key in ("id", "source", "name", "artist", "album", "duration", "cover"):
        value = normalized.get(key)
        if value not in (None, "", 0, 0.0):
            query.addQueryItem(key, str(value))
    if normalized["extra"]:
        query.addQueryItem(
            "extra", json.dumps(normalized["extra"], ensure_ascii=False, separators=(",", ":"))
        )
    for key, value in extra_values.items():
        query.addQueryItem(key, value)
    return query


def encoded_query(query: QUrlQuery) -> str:
    """Serialize a Qt query with nested URLs safely escaped for reverse proxies."""

    return urlencode(query.queryItems())


def resolve_playback_url(service_url: str, raw_url: str) -> str:
    """Resolve a server-issued media URL while enforcing the configured origin."""

    base = QUrl(service_url)
    resolved = base.resolved(QUrl(str(raw_url or "").strip()))
    default_ports = {"http": 80, "https": 443}

    def origin(url: QUrl) -> tuple[str, str, int]:
        scheme = url.scheme().lower()
        return scheme, url.host().lower(), url.port(default_ports.get(scheme, -1))

    if not resolved.isValid() or origin(resolved) != origin(base):
        raise ValueError("服务端返回了跨域播放地址，已拒绝加载")
    if resolved.userName() or resolved.password() or resolved.fragment():
        raise ValueError("服务端返回的播放地址包含不安全字段")
    return resolved.toString(QUrl.FullyEncoded)


class ApiClient(QObject):
    """Expose Melodex authentication, search and lyric requests to QML."""

    authenticatedChanged = Signal()
    currentUserChanged = Signal()
    busyChanged = Signal()
    errorChanged = Signal()
    searchResultsChanged = Signal()
    lyricLoaded = Signal(str, str)

    def __init__(self, settings: UserSettings, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._settings = settings
        self._network = QNetworkAccessManager(self)
        self._cookie_jar = PersistentCookieJar(
            settings.storage_path("session-cookies.txt"), self._network
        )
        self._network.setCookieJar(self._cookie_jar)
        self._authenticated_proxy = AuthenticatedHttpProxy()
        self._authenticated = False
        self._current_user: dict[str, Any] = {}
        self._busy = False
        self._error = ""
        self._search_results: list[dict[str, Any]] = []
        application = QCoreApplication.instance()
        if application is not None:
            application.aboutToQuit.connect(self._authenticated_proxy.close)

    def _root_url(self, path: str) -> QUrl:
        base = self._settings.serviceUrl
        if not base:
            raise ValueError("请先填写 Melodex 服务地址")
        return QUrl(base).resolved(QUrl(path.lstrip("/")))

    def _set_busy(self, value: bool) -> None:
        value = bool(value)
        if value != self._busy:
            self._busy = value
            self.busyChanged.emit()

    def _set_error(self, message: str) -> None:
        if message != self._error:
            self._error = message
            self.errorChanged.emit()

    def _request(
        self,
        method: str,
        path: str,
        callback,
        payload: dict[str, Any] | None = None,
        expect_text: bool = False,
    ) -> None:
        try:
            request = QNetworkRequest(self._root_url(path))
        except ValueError as exc:
            self._set_error(str(exc))
            return
        request.setRawHeader(b"Accept", b"text/plain" if expect_text else b"application/json")
        request.setRawHeader(b"X-Requested-With", b"XMLHttpRequest")
        body = QByteArray()
        if payload is not None:
            request.setHeader(QNetworkRequest.ContentTypeHeader, "application/json")
            body = QByteArray(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        if method == "GET":
            reply = self._network.get(request)
        elif method == "POST":
            reply = self._network.post(request, body)
        elif method == "DELETE":
            reply = self._network.deleteResource(request)
        else:
            self._set_error(f"不支持的请求方法：{method}")
            return
        reply.finished.connect(lambda: self._finish(reply, callback, expect_text))

    def request_json(
        self,
        method: str,
        path: str,
        callback,
        payload: dict[str, Any] | None = None,
    ) -> None:
        """Share the authenticated JSON transport with feature controllers."""

        self._request(method, path, callback, payload)

    def _finish(self, reply: QNetworkReply, callback, expect_text: bool) -> None:
        try:
            status = reply.attribute(QNetworkRequest.HttpStatusCodeAttribute) or 0
            raw = bytes(reply.readAll())
            content_type = bytes(reply.rawHeader("Content-Type")).decode(
                "ascii", errors="ignore"
            )
            self._save_cookies()
            if reply.error() != QNetworkReply.NoError or not 200 <= int(status) < 300:
                callback(
                    None,
                    self._response_error(reply, raw, content_type),
                    int(status),
                )
                return
            payload, error = self._decode_response(raw, content_type, expect_text)
            callback(payload, error, int(status))
        finally:
            reply.deleteLater()

    def _save_cookies(self) -> None:
        try:
            self._cookie_jar.save()
        except OSError as exc:
            print(f"[WARN] 保存桌面会话失败：{exc}")

    @staticmethod
    def _response_error(
        reply: QNetworkReply, raw: bytes, content_type: str
    ) -> str:
        if "text/html" in content_type:
            return "服务被前置登录网关拦截，桌面客户端尚未取得访问授权"
        message = reply.errorString()
        try:
            payload = json.loads(raw.decode("utf-8"))
            return str(payload.get("error") or message)
        except (UnicodeDecodeError, ValueError, AttributeError) as exc:
            print(f"[INFO] 错误响应不是 Melodex JSON：{exc}")
            return message

    @staticmethod
    def _decode_response(
        raw: bytes, content_type: str, expect_text: bool
    ) -> tuple[Any | None, str]:
        if expect_text:
            return raw.decode("utf-8", errors="replace"), ""
        try:
            return json.loads(raw.decode("utf-8")), ""
        except (UnicodeDecodeError, ValueError) as exc:
            print(f"[WARN] Melodex 响应解析失败：{exc}")
            if "text/html" in content_type:
                return None, "服务被前置登录网关拦截，桌面客户端尚未取得访问授权"
            return None, "服务返回了无法解析的数据"

    @Slot()
    def checkSession(self) -> None:
        if not self._settings.serviceUrl:
            return
        self._set_busy(True)
        self._set_error("")

        def completed(payload, error: str, _status: int) -> None:
            self._set_busy(False)
            if error or not payload or not payload.get("user"):
                self._set_authenticated(False, {})
                if error and _status not in {401, 0}:
                    self._set_error(error)
                return
            self._set_authenticated(True, payload["user"])

        self._request("GET", "/api/v1/me", completed)

    @Slot(str, str, str)
    def login(self, service_url: str, username: str, password: str) -> None:
        self._set_busy(True)
        self._set_error("")
        try:
            normalized = normalize_service_url(service_url)
            if normalized != self._settings.serviceUrl:
                self._authenticated_proxy.clear()
            self._settings.setServiceUrl(normalized)
        except ValueError as exc:
            self._set_busy(False)
            self._set_error(str(exc))
            return

        def completed(payload, error: str, _status: int) -> None:
            self._set_busy(False)
            if error or not payload or not payload.get("user"):
                self._set_authenticated(False, {})
                self._set_error(error or "登录响应缺少用户信息")
                return
            self._set_authenticated(True, payload["user"])

        self._request(
            "POST",
            "/api/v1/auth/login",
            completed,
            {"username": username.strip(), "password": password},
        )

    @Slot()
    def logout(self) -> None:
        def completed(_payload, _error: str, _status: int) -> None:
            try:
                self._cookie_jar.clear()
            except OSError as exc:
                print(f"[WARN] 清理桌面会话失败：{exc}")
            self._authenticated_proxy.clear()
            self._set_authenticated(False, {})
            if _error:
                self._set_error(_error)

        self._request("POST", "/api/v1/auth/logout", completed, {})

    def _set_authenticated(self, authenticated: bool, user: dict[str, Any]) -> None:
        if bool(authenticated) != self._authenticated:
            self._authenticated = bool(authenticated)
            self.authenticatedChanged.emit()
        if user != self._current_user:
            self._current_user = dict(user)
            self.currentUserChanged.emit()

    @Slot(str)
    def search(self, keyword: str) -> None:
        keyword = keyword.strip()
        if not keyword:
            self._set_error("请输入歌名或歌手")
            return
        query = QUrlQuery()
        query.addQueryItem("q", keyword)
        query.addQueryItem("type", "song")
        self._set_busy(True)
        self._set_error("")

        def completed(payload, error: str, _status: int) -> None:
            self._set_busy(False)
            if error:
                self._set_error(error)
                return
            if isinstance(payload, dict) and payload.get("error"):
                self._set_error(str(payload["error"]))
                return
            songs = payload.get("songs", []) if isinstance(payload, dict) else []
            self._search_results = [normalize_song(song) for song in songs if isinstance(song, dict)]
            self.searchResultsChanged.emit()

        self._request("GET", f"/api/v1/search?{encoded_query(query)}", completed)

    def request_stream_url(self, song: dict[str, Any], callback) -> None:
        """Request one query-bound direct URL for the native Qt media engine."""

        query = encoded_query(song_query(song, stream="1"))

        def completed(payload, error: str, _status: int) -> None:
            if error:
                callback("", error)
                return
            raw_url = payload.get("url") if isinstance(payload, dict) else ""
            if not raw_url:
                callback("", "服务端未返回原生播放地址")
                return
            try:
                callback(resolve_playback_url(self._settings.serviceUrl, str(raw_url)), "")
            except ValueError as exc:
                callback("", str(exc))

        self._request(
            "POST",
            "/api/v1/playback_ticket",
            completed,
            {"query": query},
        )

    def cover_url(self, song: dict[str, Any]) -> str:
        normalized = normalize_song(song)
        if not normalized["cover"]:
            return ""
        if normalized["cover"].startswith("/"):
            url = self._root_url(normalized["cover"])
        else:
            url = self._root_url("/music/cover_proxy")
            query = QUrlQuery()
            query.addQueryItem("url", normalized["cover"])
            query.addQueryItem("source", normalized["source"])
            url.setQuery(encoded_query(query))
        return self._authenticated_url(url)

    def _authenticated_url(self, url: QUrl) -> str:
        cookie_header = "; ".join(
            bytes(cookie.toRawForm()).decode("latin-1", errors="replace")
            for cookie in self._cookie_jar.cookiesForUrl(url)
        )
        return self._authenticated_proxy.register(
            url.toString(QUrl.FullyEncoded), cookie_header
        )

    def load_lyrics(self, song: dict[str, Any]) -> None:
        normalized = normalize_song(song)
        key = f"{normalized['source']}:{normalized['id']}"
        url = self._root_url("/music/lyric")
        url.setQuery(encoded_query(song_query(normalized)))
        relative = url.toString(QUrl.FullyEncoded).removeprefix(self._settings.serviceUrl)

        def completed(payload, error: str, _status: int) -> None:
            if error:
                print(f"[WARN] 加载歌词失败：{error}")
                self.lyricLoaded.emit(key, "")
                return
            self.lyricLoaded.emit(key, str(payload or ""))

        self._request("GET", relative, completed, expect_text=True)

    @Slot("QVariantMap", result=str)
    def coverUrl(self, song: dict[str, Any]) -> str:
        try:
            return self.cover_url(song)
        except ValueError as exc:
            print(f"[WARN] 无法生成封面地址：{exc}")
            return ""

    def get_authenticated(self) -> bool:
        return self._authenticated

    def get_current_user(self) -> dict[str, Any]:
        return self._current_user

    def get_busy(self) -> bool:
        return self._busy

    def get_error(self) -> str:
        return self._error

    def get_search_results(self) -> list[dict[str, Any]]:
        return self._search_results

    authenticated = Property(bool, get_authenticated, notify=authenticatedChanged)
    currentUser = Property("QVariantMap", get_current_user, notify=currentUserChanged)
    busy = Property(bool, get_busy, notify=busyChanged)
    error = Property(str, get_error, notify=errorChanged)
    searchResults = Property("QVariantList", get_search_results, notify=searchResultsChanged)
