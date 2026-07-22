# coding: utf-8
# SPDX-License-Identifier: AGPL-3.0-only

import http.client
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from melodex_desktop.playback_proxy import AuthenticatedHttpProxy


class _TruncatedMediaHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    payload = b""
    truncate_offsets: list[int] = []
    requested_ranges: list[str] = []
    requested_if_ranges: list[str] = []
    omit_content_length = False
    use_chunked_encoding = False
    drop_before_headers: set[int] = set()
    status_by_request: dict[int, int] = {}
    range_start_delta_by_request: dict[int, int] = {}
    total_delta_by_request: dict[int, int] = {}
    range_end_delta_by_request: dict[int, int] = {}
    etag_by_request: dict[int, str | None] = {}
    last_modified_by_request: dict[int, str | None] = {}

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler contract
        request_index = len(type(self).requested_ranges)
        range_header = self.headers.get("Range", "")
        type(self).requested_ranges.append(range_header)
        type(self).requested_if_ranges.append(self.headers.get("If-Range", ""))
        if request_index in self.drop_before_headers:
            self.close_connection = True
            return
        if status := self.status_by_request.get(request_index):
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.end_headers()
            return

        start, end = self._requested_window(range_header)
        body = self.payload[start : end + 1]
        self.send_response(206 if range_header else 200)
        self.send_header("Content-Type", "audio/flac")
        if self.use_chunked_encoding:
            self.send_header("Transfer-Encoding", "chunked")
        elif not self.omit_content_length:
            self.send_header("Content-Length", str(len(body)))
        if range_header:
            range_start = start + self.range_start_delta_by_request.get(request_index, 0)
            range_end = end + self.range_end_delta_by_request.get(request_index, 0)
            total = len(self.payload) + self.total_delta_by_request.get(request_index, 0)
            self.send_header("Content-Range", f"bytes {range_start}-{range_end}/{total}")
        if etag := self.etag_by_request.get(request_index):
            self.send_header("ETag", etag)
        last_modified = self.last_modified_by_request.get(
            request_index, "Mon, 20 Jul 2026 00:44:57 GMT"
        )
        if last_modified is not None:
            self.send_header("Last-Modified", last_modified)
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        truncate_at = (
            self.truncate_offsets[request_index]
            if request_index < len(self.truncate_offsets)
            else None
        )
        if truncate_at is not None and start < truncate_at <= end:
            truncated = self.payload[start:truncate_at]
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
        if not start_text:
            suffix_length = int(end_text)
            return max(0, len(self.payload) - suffix_length), len(self.payload) - 1
        start = int(start_text)
        end = int(end_text) if end_text else len(self.payload) - 1
        return start, end

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
        _TruncatedMediaHandler.truncate_offsets = [self._REAL_TRUNCATION_OFFSET]
        _TruncatedMediaHandler.requested_ranges = []
        _TruncatedMediaHandler.requested_if_ranges = []
        _TruncatedMediaHandler.omit_content_length = False
        _TruncatedMediaHandler.use_chunked_encoding = False
        _TruncatedMediaHandler.drop_before_headers = set()
        _TruncatedMediaHandler.status_by_request = {}
        _TruncatedMediaHandler.range_start_delta_by_request = {}
        _TruncatedMediaHandler.total_delta_by_request = {}
        _TruncatedMediaHandler.range_end_delta_by_request = {}
        _TruncatedMediaHandler.etag_by_request = {}
        _TruncatedMediaHandler.last_modified_by_request = {}
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
        _TruncatedMediaHandler.truncate_offsets = [self._RANGE_TRUNCATION_OFFSET]
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

    def test_recovers_after_two_consecutive_truncations(self) -> None:
        _TruncatedMediaHandler.payload = self._payload(2_000_000)
        _TruncatedMediaHandler.truncate_offsets = [500_000, 1_250_000]
        actual = self._read_all("bytes=0-")

        self.assertEqual(actual, _TruncatedMediaHandler.payload)
        self.assertEqual(
            _TruncatedMediaHandler.requested_ranges,
            ["bytes=0-", "bytes=500000-1999999", "bytes=1250000-1999999"],
        )

    def test_retries_when_first_resume_connection_drops_before_headers(self) -> None:
        _TruncatedMediaHandler.payload = self._payload(1_000_000)
        _TruncatedMediaHandler.truncate_offsets = [300_000]
        _TruncatedMediaHandler.drop_before_headers = {1}
        actual = self._read_all("bytes=0-")

        self.assertEqual(actual, _TruncatedMediaHandler.payload)
        self.assertEqual(
            _TruncatedMediaHandler.requested_ranges,
            ["bytes=0-", "bytes=300000-999999", "bytes=300000-999999"],
        )

    def test_retries_temporary_resume_status(self) -> None:
        for status in (408, 425, 429, 500, 502, 503, 504):
            with self.subTest(status=status):
                self._reset_request_observations()
                _TruncatedMediaHandler.payload = self._payload(1_000_000)
                _TruncatedMediaHandler.truncate_offsets = [300_000]
                _TruncatedMediaHandler.status_by_request = {1: status}
                actual = self._read_all("bytes=0-")

                self.assertEqual(actual, _TruncatedMediaHandler.payload)
                self.assertEqual(
                    _TruncatedMediaHandler.requested_ranges,
                    [
                        "bytes=0-",
                        "bytes=300000-999999",
                        "bytes=300000-999999",
                    ],
                )

    def test_stops_after_resume_retry_budget_is_exhausted(self) -> None:
        _TruncatedMediaHandler.payload = self._payload(1_000_000)
        _TruncatedMediaHandler.truncate_offsets = [300_000]
        _TruncatedMediaHandler.status_by_request = {
            request_index: 503 for request_index in range(1, 5)
        }

        with self.assertRaises(http.client.IncompleteRead):
            self._read_all("bytes=0-")

        self.assertEqual(
            _TruncatedMediaHandler.requested_ranges,
            ["bytes=0-"] + ["bytes=300000-999999"] * 4,
        )

    def test_does_not_retry_permanent_resume_status(self) -> None:
        _TruncatedMediaHandler.payload = self._payload(1_000_000)
        _TruncatedMediaHandler.truncate_offsets = [300_000]
        _TruncatedMediaHandler.status_by_request = {1: 416}

        with self.assertRaises(http.client.IncompleteRead):
            self._read_all("bytes=0-")

        self.assertEqual(
            _TruncatedMediaHandler.requested_ranges,
            ["bytes=0-", "bytes=300000-999999"],
        )

    def test_initial_connection_failure_returns_bad_gateway(self) -> None:
        _TruncatedMediaHandler.drop_before_headers = {0}

        with self.assertRaises(urllib.error.HTTPError) as raised:
            self._read_all("bytes=0-")

        self.assertEqual(raised.exception.code, 502)
        self.assertEqual(_TruncatedMediaHandler.requested_ranges, ["bytes=0-"])

    def test_open_ended_and_suffix_ranges_resume_from_absolute_offsets(self) -> None:
        _TruncatedMediaHandler.payload = self._payload(2_000_000)
        _TruncatedMediaHandler.truncate_offsets = [750_000]
        open_ended = self._read_all("bytes=500000-")
        self.assertEqual(open_ended, _TruncatedMediaHandler.payload[500_000:])
        self.assertEqual(
            _TruncatedMediaHandler.requested_ranges,
            ["bytes=500000-", "bytes=750000-1999999"],
        )

        _TruncatedMediaHandler.requested_ranges = []
        _TruncatedMediaHandler.requested_if_ranges = []
        _TruncatedMediaHandler.truncate_offsets = [1_700_000]
        suffix = self._read_all("bytes=-500000")
        self.assertEqual(suffix, _TruncatedMediaHandler.payload[1_500_000:])
        self.assertEqual(
            _TruncatedMediaHandler.requested_ranges,
            ["bytes=-500000", "bytes=1700000-1999999"],
        )

    def test_rejects_mismatched_resume_range_without_retrying(self) -> None:
        for mutation in ("start", "end"):
            with self.subTest(mutation=mutation):
                self._reset_request_observations()
                _TruncatedMediaHandler.payload = self._payload(1_000_000)
                _TruncatedMediaHandler.truncate_offsets = [300_000]
                _TruncatedMediaHandler.range_start_delta_by_request = (
                    {1: 1} if mutation == "start" else {}
                )
                _TruncatedMediaHandler.range_end_delta_by_request = (
                    {1: -1} if mutation == "end" else {}
                )
                with self.assertRaises(http.client.IncompleteRead):
                    self._read_all("bytes=0-")
                self.assertEqual(
                    _TruncatedMediaHandler.requested_ranges,
                    ["bytes=0-", "bytes=300000-999999"],
                )

    def test_rejects_changed_or_missing_resource_identity(self) -> None:
        cases = {
            "total_changed": ({}, {}, {1: 1}),
            "last_modified_changed": (
                {},
                {1: "Tue, 21 Jul 2026 00:44:57 GMT"},
                {},
            ),
            "last_modified_missing": ({}, {1: None}, {}),
            "etag_changed": ({0: '"v1"', 1: '"v2"'}, {}, {}),
            "etag_missing": ({0: '"v1"', 1: None}, {}, {}),
        }
        for mutation, (etags, modification_dates, total_deltas) in cases.items():
            with self.subTest(mutation=mutation):
                self._reset_request_observations()
                _TruncatedMediaHandler.payload = self._payload(1_000_000)
                _TruncatedMediaHandler.truncate_offsets = [300_000]
                _TruncatedMediaHandler.etag_by_request = etags
                _TruncatedMediaHandler.last_modified_by_request = modification_dates
                _TruncatedMediaHandler.total_delta_by_request = total_deltas

                with self.assertRaises(http.client.IncompleteRead):
                    self._read_all("bytes=0-")

                self.assertEqual(len(_TruncatedMediaHandler.requested_ranges), 2)
                expected_validator = (
                    '"v1"'
                    if etags
                    else "Mon, 20 Jul 2026 00:44:57 GMT"
                )
                self.assertEqual(
                    _TruncatedMediaHandler.requested_if_ranges,
                    ["", expected_validator],
                )

    @staticmethod
    def _reset_request_observations() -> None:
        _TruncatedMediaHandler.requested_ranges = []
        _TruncatedMediaHandler.requested_if_ranges = []
        _TruncatedMediaHandler.drop_before_headers = set()
        _TruncatedMediaHandler.status_by_request = {}
        _TruncatedMediaHandler.range_start_delta_by_request = {}
        _TruncatedMediaHandler.range_end_delta_by_request = {}
        _TruncatedMediaHandler.total_delta_by_request = {}
        _TruncatedMediaHandler.etag_by_request = {}
        _TruncatedMediaHandler.last_modified_by_request = {}

    def _read_all(self, range_header: str) -> bytes:
        host, port = self.origin.server_address
        remote_url = f"http://{host}:{port}/track.flac"
        local_url = self.proxy.register(remote_url, "")
        request = urllib.request.Request(local_url, headers={"Range": range_header})
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.read()


if __name__ == "__main__":
    unittest.main()
