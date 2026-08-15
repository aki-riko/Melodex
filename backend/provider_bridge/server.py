"""HTTP entry point for the Melodex provider adapter."""

from __future__ import annotations

import json
import os
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
VENDOR_ROOT = BACKEND_ROOT / "third_party" / "charles-musicdl"
sys.path.insert(0, str(VENDOR_ROOT))

from provider_bridge.account import verify  # noqa: E402
from provider_bridge.app import search  # noqa: E402
from provider_bridge.collections import collection  # noqa: E402
from provider_bridge.qr import check as qr_check  # noqa: E402
from provider_bridge.qr import create as qr_create  # noqa: E402


def _required_environment(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "MelodexProvider/1"

    def do_GET(self):
        if self.path != "/health":
            self._write_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        self._write_json(HTTPStatus.OK, {
            "status": "ok",
            "provider": "CharlesPikachu/musicdl",
            "commit": "b4cecd9d450ede6f5c8d4df08763668256dfee58",
            "license": "Apache-2.0",
            "capabilities": ["search", "media", "lyrics", "collections", "qr_login", "account_verify"],
        })

    def do_POST(self):
        handlers = {
            "/v1/search": search,
            "/v1/collections": collection,
            "/v1/account/verify": verify,
            "/v1/qr/create": qr_create,
            "/v1/qr/check": qr_check,
        }
        handler = handlers.get(self.path)
        if handler is None:
            self._write_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 1024 * 1024:
                raise ValueError("invalid request size")
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("request body must be a JSON object")
            if handler is search:
                result = handler(payload, work_dir=self.server.work_dir)
            else:
                result = handler(payload)
        except ValueError as error:
            self._write_json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        except Exception as error:
            self.log_error("provider request failed: %s", error)
            self._write_json(HTTPStatus.BAD_GATEWAY, {"error": "provider request failed"})
            return
        self._write_json(HTTPStatus.OK, result)

    def _write_json(self, status: HTTPStatus, payload: dict):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status.value)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class ProviderServer(ThreadingHTTPServer):
    def __init__(self, address, handler, work_dir: str):
        super().__init__(address, handler)
        self.work_dir = work_dir


def main():
    host = _required_environment("MELODEX_PROVIDER_HOST")
    port = int(_required_environment("MELODEX_PROVIDER_PORT"))
    work_dir = _required_environment("MELODEX_PROVIDER_WORK_DIR")
    ProviderServer((host, port), RequestHandler, work_dir).serve_forever()


if __name__ == "__main__":
    main()
