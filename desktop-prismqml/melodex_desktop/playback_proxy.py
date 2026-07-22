# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only
"""Loopback-only authenticated transport for Qt media and QML images."""

from __future__ import annotations

import http.client
import secrets
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, urlunsplit


@dataclass(frozen=True)
class _ProxyEntry:
    remote_url: str
    cookie_header: str


class _LoopbackServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, owner: "AuthenticatedHttpProxy") -> None:
        self.owner = owner
        super().__init__(("127.0.0.1", 0), _ProxyRequestHandler)


class _ProxyRequestHandler(BaseHTTPRequestHandler):
    server: _LoopbackServer
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler contract
        self._forward(include_body=True)

    def do_HEAD(self) -> None:  # noqa: N802 - stdlib handler contract
        self._forward(include_body=False)

    def _forward(self, include_body: bool) -> None:
        entry = self.server.owner.lookup(self.path)
        if entry is None:
            self.send_error(404)
            return

        connection: http.client.HTTPConnection | None = None
        response_started = False
        try:
            connection, target = self._remote_connection(entry.remote_url)
            connection.request(
                self.command, target, headers=self._remote_headers(entry)
            )
            response = connection.getresponse()
            self.send_response(response.status, response.reason)
            response_started = True
            self._forward_response_headers(response)
            if include_body:
                self._copy_response(response)
        except (BrokenPipeError, ConnectionResetError) as exc:
            print(f"[INFO] 播放器已取消当前媒体读取：{exc}")
        except (OSError, ValueError, http.client.HTTPException) as exc:
            print(f"[WARN] 本机认证媒体转发失败：{exc}")
            if not response_started:
                self.send_error(502)
        finally:
            if connection is not None:
                connection.close()

    @staticmethod
    def _remote_connection(
        remote_url: str,
    ) -> tuple[http.client.HTTPConnection, str]:
        parsed = urlsplit(remote_url)
        connection_type = (
            http.client.HTTPSConnection
            if parsed.scheme == "https"
            else http.client.HTTPConnection
        )
        connection = connection_type(parsed.hostname, parsed.port, timeout=30)
        target = urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
        return connection, target

    def _remote_headers(self, entry: _ProxyEntry) -> dict[str, str]:
        headers = {
            "Accept": self.headers.get("Accept", "*/*"),
            "Connection": "close",
            "User-Agent": "MelodexDesktop",
        }
        if entry.cookie_header:
            headers["Cookie"] = entry.cookie_header
        if range_value := self.headers.get("Range"):
            headers["Range"] = range_value
        return headers

    def _forward_response_headers(self, response: http.client.HTTPResponse) -> None:
        for header_name in (
            "Content-Type",
            "Content-Length",
            "Content-Range",
            "Accept-Ranges",
            "Cache-Control",
            "ETag",
            "Last-Modified",
        ):
            if header_value := response.getheader(header_name):
                self.send_header(header_name, header_value)
        self.send_header("Connection", "close")
        self.end_headers()

    def _copy_response(self, response: http.client.HTTPResponse) -> None:
        while chunk := response.read(64 * 1024):
            self.wfile.write(chunk)

    def log_message(self, _format: str, *_args) -> None:
        # 正常媒体 Range 请求非常密集，不写逐请求访问日志。
        return


class AuthenticatedHttpProxy:
    """Expose authenticated same-service URLs through a private loopback route."""

    _MAX_ENTRIES = 256

    def __init__(self) -> None:
        self._token = secrets.token_urlsafe(32)
        self._entries: dict[str, _ProxyEntry] = {}
        self._reverse: dict[_ProxyEntry, str] = {}
        self._lock = threading.RLock()
        self._server = _LoopbackServer(self)
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            kwargs={"poll_interval": 0.2},
            name="melodex-authenticated-media",
            daemon=True,
        )
        self._thread.start()

    def register(self, remote_url: str, cookie_header: str) -> str:
        entry = _ProxyEntry(remote_url=remote_url, cookie_header=cookie_header)
        with self._lock:
            if existing := self._reverse.get(entry):
                return self._local_url(existing)
            entry_id = secrets.token_urlsafe(18)
            self._entries[entry_id] = entry
            self._reverse[entry] = entry_id
            while len(self._entries) > self._MAX_ENTRIES:
                oldest_id = next(iter(self._entries))
                oldest_entry = self._entries.pop(oldest_id)
                self._reverse.pop(oldest_entry, None)
            return self._local_url(entry_id)

    def lookup(self, request_path: str) -> _ProxyEntry | None:
        prefix = f"/{self._token}/"
        path = urlsplit(request_path).path
        if not path.startswith(prefix):
            return None
        entry_id = path[len(prefix) :]
        with self._lock:
            return self._entries.get(entry_id)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._reverse.clear()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=2)

    def _local_url(self, entry_id: str) -> str:
        host, port = self._server.server_address
        return f"http://{host}:{port}/{self._token}/{entry_id}"
