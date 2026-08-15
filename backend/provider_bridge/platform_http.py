"""HTTP helpers used by Melodex collection adapters inside the provider sidecar."""

from __future__ import annotations

import ast
import json
from typing import Any

import requests


USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36"
)


class PlatformHTTP:
    def __init__(self, cookie: str = "", session: Any | None = None):
        self.cookie = str(cookie or "").strip()
        self.session = session or requests.Session()

    def get(self, url: str, *, headers: dict[str, str] | None = None) -> dict[str, Any]:
        return self.request("GET", url, headers=headers)

    def post_form(
        self, url: str, data: dict[str, Any], *, headers: dict[str, str] | None = None
    ) -> dict[str, Any]:
        return self.request("POST", url, headers=headers, data=data)

    def post_json(
        self, url: str, payload: dict[str, Any], *, headers: dict[str, str] | None = None
    ) -> dict[str, Any]:
        return self.request("POST", url, headers=headers, json_body=payload)

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        data: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        request_headers = {"User-Agent": USER_AGENT, "Accept": "application/json, text/plain, */*"}
        request_headers.update(headers or {})
        if self.cookie:
            request_headers["Cookie"] = self.cookie
        response = self.session.request(
            method,
            url,
            headers=request_headers,
            data=data,
            json=json_body,
            timeout=30,
        )
        response.raise_for_status()
        raw = response.content
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("gb18030")
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            payload = ast.literal_eval(text)
        if not isinstance(payload, dict):
            raise ValueError("platform response must be a JSON object")
        return payload

