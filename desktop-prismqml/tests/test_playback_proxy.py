# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only

import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from melodex_desktop.playback_proxy import AuthenticatedHttpProxy


class _TruncatedMediaHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    payload = b""
    truncate_at = 0
    requested_ranges: list[str] = []
    omit_content_length = False
    use_chunked_encoding = False

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler contract
        range_header = self.headers.get("Range", "")
        type(self).requested_ranges.append(range_header)
        start, end = self._requested_window(range_header)
        body = self.payload[start : end + 1]
        self.send_response(206 if range_header else 200)
        self.send_header("Content-Type", "audio/flac")
        if self.use_chunked_encoding:
            self.send_header("Transfer-Encoding", "chunked")
        elif not self.omit_content_length:
            self.send_header("Content-Length", str(len(body)))
        if range_header:
            self.send_header("Content-Range", f"bytes {start}-{end}/{len(self.payload)}")
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        if len(type(self).requested_ranges) == 1:
            truncated = self.payload[start : self.truncate_at]
            self._write_body(truncated, declared_length=len(body), complete=False)
            self.close_connection = True
        else:
            self._write_body(body, declared_length=len(body), complete=True)

    def _write_body(self, body: bytes, declared_length: int, complete: bool) -> None:
        if self.use_chunked_encoding:
            self.wfile.write(f"{declared_length:X}\r\n".encode("ascii"))
        self.wfile.write(body)
        if self.use_chunked_encoding and complete:
            self.wfile.write(b"\r\n0\r\n\r\n")
        self.wfile.flush()

    def _requested_window(self, range_header: str) -> tuple[int, int]:
        if not range_header:
            return 0, len(self.payload) - 1
        start_text, end_text = range_header.removeprefix("bytes=").split("-", 1)
        return int(start_text), int(end_text)

    def log_message(self, _format: str, *_args) -> None:
        return


class PlaybackProxyResumeTests(unittest.TestCase):
    # 本次真实失败响应：声明 37,543,529 字节，实际在 26,137,636 字节断开。
    _REAL_CONTENT_LENGTH = 37_543_529
    _REAL_TRUNCATION_OFFSET = 26_137_636
    # 第二次真实失败是无 Content-Length 的 206 分块响应。
    _RANGE_CONTENT_LENGTH = 42_522_279
    _RANGE_TRUNCATION_OFFSET = 27_131_904

    def setUp(self) -> None:
        _TruncatedMediaHandler.payload = self._payload(self._REAL_CONTENT_LENGTH)
        _TruncatedMediaHandler.truncate_at = self._REAL_TRUNCATION_OFFSET
        _TruncatedMediaHandler.requested_ranges = []
        _TruncatedMediaHandler.omit_content_length = False
        _TruncatedMediaHandler.use_chunked_encoding = False
        self.origin = ThreadingHTTPServer(("127.0.0.1", 0), _TruncatedMediaHandler)
        self.origin_thread = threading.Thread(target=self.origin.serve_forever, daemon=True)
        self.origin_thread.start()
        self.proxy = AuthenticatedHttpProxy()

    def tearDown(self) -> None:
        self.proxy.close()
        self.origin.shutdown()
        self.origin.server_close()
        self.origin_thread.join(timeout=2)

    @staticmethod
    def _payload(length: int) -> bytes:
        pattern = bytes(range(251))
        repeats = (length + len(pattern) - 1) // len(pattern)
        return (pattern * repeats)[:length]

    def test_resumes_exact_real_failure_shape_without_byte_gap(self) -> None:
        host, port = self.origin.server_address
        remote_url = f"http://{host}:{port}/track.flac"
        local_url = self.proxy.register(remote_url, "")

        with urllib.request.urlopen(local_url, timeout=10) as response:
            actual = response.read()

        self.assertEqual(actual, _TruncatedMediaHandler.payload)
        self.assertEqual(
            _TruncatedMediaHandler.requested_ranges,
            ["", f"bytes={self._REAL_TRUNCATION_OFFSET}-{self._REAL_CONTENT_LENGTH - 1}"],
        )

    def test_resumes_an_existing_player_range_from_absolute_offset(self) -> None:
        host, port = self.origin.server_address
        remote_url = f"http://{host}:{port}/track.flac"
        local_url = self.proxy.register(remote_url, "")
        initial_start = 25_000_000
        request = urllib.request.Request(
            local_url,
            headers={
                "Range": f"bytes={initial_start}-{self._REAL_CONTENT_LENGTH - 1}"
            },
        )

        with urllib.request.urlopen(request, timeout=10) as response:
            actual = response.read()

        self.assertEqual(actual, _TruncatedMediaHandler.payload[initial_start:])
        self.assertEqual(
            _TruncatedMediaHandler.requested_ranges,
            [
                f"bytes={initial_start}-{self._REAL_CONTENT_LENGTH - 1}",
                f"bytes={self._REAL_TRUNCATION_OFFSET}-{self._REAL_CONTENT_LENGTH - 1}",
            ],
        )

    def test_resumes_chunked_range_without_content_length(self) -> None:
        _TruncatedMediaHandler.payload = self._payload(self._RANGE_CONTENT_LENGTH)
        _TruncatedMediaHandler.truncate_at = self._RANGE_TRUNCATION_OFFSET
        _TruncatedMediaHandler.omit_content_length = True
        _TruncatedMediaHandler.use_chunked_encoding = True
        host, port = self.origin.server_address
        remote_url = f"http://{host}:{port}/track.flac"
        local_url = self.proxy.register(remote_url, "")
        initial_range = f"bytes=0-{self._RANGE_CONTENT_LENGTH - 1}"
        request = urllib.request.Request(local_url, headers={"Range": initial_range})

        with urllib.request.urlopen(request, timeout=10) as response:
            actual = response.read()

        self.assertEqual(actual, _TruncatedMediaHandler.payload)
        self.assertEqual(
            _TruncatedMediaHandler.requested_ranges,
            [
                initial_range,
                f"bytes={self._RANGE_TRUNCATION_OFFSET}-{self._RANGE_CONTENT_LENGTH - 1}",
            ],
        )


if __name__ == "__main__":
    unittest.main()
