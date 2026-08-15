"""NetEase QR login operations hosted by the provider sidecar."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlencode

import requests

from provider_bridge.collection_common import at, integer, string
from provider_bridge.platform_http import USER_AGENT


BASE_URL = "https://music.163.com"


def _request(path: str, form: dict[str, Any], *, session=None):
    client = session or requests.Session()
    response = client.post(
        BASE_URL + path,
        headers={"User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded"},
        data=form,
        timeout=30,
    )
    response.raise_for_status()
    payload = json.loads(response.content.decode("utf-8"))
    return payload, response.cookies


def create(payload: dict[str, Any], *, session=None) -> dict[str, Any]:
    if string(payload.get("source")).lower() != "netease":
        raise ValueError("unsupported QR login source")
    data, _ = _request("/api/login/qrcode/unikey", {"type": 1}, session=session)
    key = string(at(data, "unikey")) or string(at(data, "data", "unikey"))
    if not key:
        raise ValueError("netease QR endpoint returned no key")
    return {"challenge": {
        "source": "netease", "key": key,
        "url": "https://music.163.com/login?" + urlencode({"codekey": key}),
    }}


def check(payload: dict[str, Any], *, session=None) -> dict[str, Any]:
    source = string(payload.get("source")).lower()
    key = string(payload.get("key"))
    if source != "netease":
        raise ValueError("unsupported QR login source")
    if not key:
        raise ValueError("netease QR key is required")
    data, cookies = _request("/api/login/qrcode/client/login", {"key": key, "type": 1}, session=session)
    code = integer(data.get("code"))
    phase = {800: "expired", 801: "waiting", 802: "scanned", 803: "success"}.get(code, "failed")
    values = {item.name: item.value for item in cookies}
    raw_cookie = string(data.get("cookie")) or "; ".join(f"{name}={value}" for name, value in sorted(values.items()))
    result = {
        "source": "netease", "key": key, "status": phase,
        "message": string(data.get("message")), "cookies": values,
    }
    if raw_cookie:
        result["cookie"] = raw_cookie
    return {"result": result}
