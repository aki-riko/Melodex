"""Account checks used by the Go cookie status API."""

from __future__ import annotations

from typing import Any

from provider_bridge.collection_common import at, integer, string
from provider_bridge.platform_http import PlatformHTTP


def verify(payload: dict[str, Any], *, session=None) -> dict[str, Any]:
    source = string(payload.get("source")).lower()
    if source != "netease":
        raise ValueError("account verification is unsupported for this source")
    cookie = string(payload.get("cookie"))
    if not cookie:
        raise ValueError("provider account verification requires cookie")
    data = PlatformHTTP(cookie, session).get("https://music.163.com/api/nuser/account/get")
    if not string(at(data, "account", "id")):
        raise ValueError("netease login cookie is invalid")
    return {"vip": integer(at(data, "profile", "vipType")) > 0 or integer(at(data, "account", "vipType")) > 0}

