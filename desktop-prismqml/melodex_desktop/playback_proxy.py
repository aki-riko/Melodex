# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only
"""Loopback-only authenticated transport for Qt media and QML images."""

from __future__ import annotations

import http.client
import re
import secrets
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, urlunsplit


@dataclass(frozen=True)
class _ProxyEntry:
    remote_url: str
    cookie_header: str


@dataclass(frozen=True)
class _ResponseWindow:
    absolute_start: int
    body_length: int
    total_length: int
    etag: str
    last_modified: str

    @property
    def absolute_end(self) -> int:
        return self.absolute_start + self.body_length - 1


class _LoopbackServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, owner: "AuthenticatedHttpProxy") -> None:
        self.owner = owner
        super().__init__(("127.0.0.1", 0), _ProxyRequestHandler)


class _ProxyRequestHandler(BaseHTTPRequestHandler):
    server: _LoopbackServer
    protocol_version = "HTTP/1.1"
    _COPY_CHUNK_SIZE = 64 * 1024
    _MAX_RESUME_ATTEMPTS = 4
    _CONTENT_RANGE_PATTERN = re.compile(r"^bytes (\d+)-(\d+)/(\d+|\*)$")

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
            connection, response = self._open_remote_response(entry)
            self.send_response(response.status, response.reason)
            response_started = True
            self._forward_response_headers(response)
            if include_body:
                self._copy_response(entry, response)
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

    def _open_remote_response(
        self,
        entry: _ProxyEntry,
        range_override: str | None = None,
        if_range: str = "",
    ) -> tuple[http.client.HTTPConnection, http.client.HTTPResponse]:
        connection, target = self._remote_connection(entry.remote_url)
        headers = self._remote_headers(entry, range_override)
        if if_range:
            headers["If-Range"] = if_range
        try:
            connection.request(self.command, target, headers=headers)
            return connection, connection.getresponse()
        except Exception as exc:
            print(f"[WARN] 无法建立远端媒体连接：{exc}")
            connection.close()
            raise

    def _remote_headers(
        self, entry: _ProxyEntry, range_override: str | None = None
    ) -> dict[str, str]:
        headers = {
            "Accept": self.headers.get("Accept", "*/*"),
            "Accept-Encoding": "identity",
            "Connection": "close",
            "User-Agent": "MelodexDesktop",
        }
        if entry.cookie_header:
            headers["Cookie"] = entry.cookie_header
        range_value = range_override or self.headers.get("Range")
        if range_value:
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

    def _copy_response(
        self, entry: _ProxyEntry, response: http.client.HTTPResponse
    ) -> None:
        window = self._response_window(response)
        if window is None:
            self._copy_until_eof(response)
            return
        self._copy_expected_body(entry, response, window)

    def _copy_until_eof(self, response: http.client.HTTPResponse) -> None:
        while chunk := response.read(self._COPY_CHUNK_SIZE):
            self.wfile.write(chunk)

    def _copy_expected_body(
        self,
        entry: _ProxyEntry,
        response: http.client.HTTPResponse,
        window: _ResponseWindow,
    ) -> None:
        sent = 0
        attempt = 0
        active_response = response
        resume_connection: http.client.HTTPConnection | None = None
        try:
            while sent < window.body_length:
                copied, read_error = self._copy_next_chunk(
                    active_response, window.body_length - sent
                )
                sent += copied
                if sent >= window.body_length:
                    return
                if read_error is None and copied:
                    continue
                failure = read_error or http.client.IncompleteRead(
                    b"", window.body_length - sent
                )
                attempt += 1
                if attempt > self._MAX_RESUME_ATTEMPTS:
                    raise failure
                if resume_connection is not None:
                    resume_connection.close()
                resume_connection, active_response = self._resume_response(
                    entry, window, sent, attempt
                )
        finally:
            if resume_connection is not None:
                resume_connection.close()

    def _copy_next_chunk(
        self, response: http.client.HTTPResponse, remaining: int
    ) -> tuple[int, Exception | None]:
        chunk, read_error = self._read_chunk(
            response, min(self._COPY_CHUNK_SIZE, remaining)
        )
        if chunk:
            self.wfile.write(chunk)
        return len(chunk), read_error

    @staticmethod
    def _read_chunk(
        response: http.client.HTTPResponse, size: int
    ) -> tuple[bytes, Exception | None]:
        try:
            return response.read(size), None
        except http.client.IncompleteRead as exc:
            return exc.partial, exc
        except (OSError, http.client.HTTPException) as exc:
            return b"", exc

    def _resume_response(
        self,
        entry: _ProxyEntry,
        window: _ResponseWindow,
        sent: int,
        attempt: int,
    ) -> tuple[http.client.HTTPConnection, http.client.HTTPResponse]:
        resume_start = window.absolute_start + sent
        range_value = f"bytes={resume_start}-{window.absolute_end}"
        validator = (
            window.etag
            if window.etag and not window.etag.startswith("W/")
            else window.last_modified
        )
        print(
            "[WARN] 远端媒体提前结束，"
            f"从字节 {resume_start} 续传（{attempt}/{self._MAX_RESUME_ATTEMPTS}）"
        )
        connection, response = self._open_remote_response(
            entry, range_override=range_value, if_range=validator
        )
        try:
            self._validate_resume_response(response, window, resume_start)
        except Exception as exc:
            print(f"[WARN] 远端媒体续传响应校验失败：{exc}")
            connection.close()
            raise
        return connection, response

    def _response_window(
        self, response: http.client.HTTPResponse
    ) -> _ResponseWindow | None:
        length_header = response.getheader("Content-Length")
        if response.status == 206:
            try:
                absolute_start, absolute_end, total_length = self._parse_content_range(
                    response
                )
            except http.client.HTTPException as exc:
                print(f"[INFO] 远端媒体不支持安全续传：{exc}")
                return None
            body_length = absolute_end - absolute_start + 1
            if length_header:
                try:
                    declared_length = int(length_header)
                except ValueError:
                    print("[INFO] 远端媒体不支持安全续传：响应长度无效")
                    return None
                if declared_length != body_length:
                    print("[INFO] 远端媒体不支持安全续传：响应长度与范围不一致")
                    return None
        elif response.status == 200 and length_header:
            try:
                body_length = int(length_header)
            except ValueError:
                return None
            absolute_start = 0
            total_length = body_length
        else:
            return None
        if body_length <= 0:
            return None
        return _ResponseWindow(
            absolute_start=absolute_start,
            body_length=body_length,
            total_length=total_length,
            etag=response.getheader("ETag", ""),
            last_modified=response.getheader("Last-Modified", ""),
        )

    def _validate_resume_response(
        self,
        response: http.client.HTTPResponse,
        window: _ResponseWindow,
        resume_start: int,
    ) -> None:
        if response.status != 206:
            raise http.client.HTTPException(
                f"远端拒绝媒体续传，HTTP 状态为 {response.status}"
            )
        actual_start, actual_end, total_length = self._parse_content_range(response)
        if actual_start != resume_start or actual_end > window.absolute_end:
            raise http.client.HTTPException("远端媒体续传范围与请求不一致")
        length_header = response.getheader("Content-Length", "")
        if length_header and int(length_header) != actual_end - actual_start + 1:
            raise http.client.HTTPException(
                "远端媒体续传 Content-Length 与 Content-Range 不一致"
            )
        if total_length != window.total_length:
            raise http.client.HTTPException("远端媒体在续传期间长度发生变化")
        if window.etag and response.getheader("ETag", window.etag) != window.etag:
            raise http.client.HTTPException("远端媒体在续传期间 ETag 发生变化")
        if (
            window.last_modified
            and response.getheader("Last-Modified", window.last_modified)
            != window.last_modified
        ):
            raise http.client.HTTPException("远端媒体在续传期间修改时间发生变化")

    def _parse_content_range(
        self, response: http.client.HTTPResponse
    ) -> tuple[int, int, int]:
        value = response.getheader("Content-Range", "")
        match = self._CONTENT_RANGE_PATTERN.fullmatch(value.strip())
        if match is None or match.group(3) == "*":
            raise http.client.HTTPException("远端媒体 Content-Range 无效")
        start, end, total = (int(part) for part in match.groups())
        if start > end or end >= total:
            raise http.client.HTTPException("远端媒体 Content-Range 越界")
        return start, end, total

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
