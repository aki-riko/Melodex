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
        # 会话 cookie 只在调用方**没有**显式给 Cookie 头时才补上。
        #
        # ★ 2026-11 全库扫描修正:原实现是无条件覆盖 ——
        #     request_headers.update(headers or {})
        #     if self.cookie:
        #         request_headers["Cookie"] = self.cookie      # ← 把调用方的冲掉了
        #   于是"会话 cookie + 额外 Cookie 头"这种组合必然丢掉后者。
        #   这个坑早有记录:netease_source._cookies_for 的注释里写着
        #   「必须显式传 Cookie 头而不是用 PlatformHTTP(cookie) —— 它的 request()
        #   会无条件用会话 cookie 覆盖调用方传进来的 Cookie 头, 那样设备 cookie 就丢了」。
        #   也就是说绕开方式是对的,但**根因一直没修**:任何新调用方想同时用两者
        #   都会静默丢掉一半 cookie,症状是设备指纹丢失、上游行为异常且不报错。
        #
        # 改成"调用方优先"而不是"两者拼接":拼接看似更周到,但同一 cookie 名
        # 出现两次时是未定义行为(服务端取哪个不确定),静默错乱比明确覆盖更难查。
        # 需要合并的场景由调用方自己拼好再传(netease 就是这么做的)。
        if self.cookie and "Cookie" not in request_headers:
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

