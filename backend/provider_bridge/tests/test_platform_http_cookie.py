"""PlatformHTTP 的 Cookie 头优先级契约(2026-11 全库扫描补的)。

真实缺陷:request() 原先在 `request_headers.update(headers)` **之后**无条件
`request_headers["Cookie"] = self.cookie`,于是"会话 cookie + 额外 Cookie 头"
这种组合必然丢掉后者。

这个坑在 netease_source._cookies_for 的注释里有记录("必须显式传 Cookie 头
而不是用 PlatformHTTP(cookie) —— 它会无条件覆盖")—— 也就是说绕开方式是对的,
但根因一直没修:任何新调用方想同时用两者都会静默丢掉一半 cookie,
症状是设备指纹丢失、上游行为异常且不报错。

修法:调用方显式给的 Cookie 头优先;只有它没给时才补会话 cookie。
"""

from __future__ import annotations

import unittest
from unittest import mock

from provider_bridge.platform_http import PlatformHTTP


class _FakeResponse:
    status_code = 200
    content = b'{"ok": true}'

    def raise_for_status(self):
        return None


class PlatformHTTPCookieTest(unittest.TestCase):
    def _capture_headers(self, platform, *, headers=None):
        """跑一次 request(),返回实际发出去的 headers。"""
        with mock.patch.object(platform.session, "request", return_value=_FakeResponse()) as fake:
            platform.request("GET", "https://example.test/api", headers=headers)
        return fake.call_args.kwargs["headers"]

    def test_session_cookie_used_when_caller_gives_none(self):
        platform = PlatformHTTP(cookie="SESSION=abc")
        sent = self._capture_headers(platform)
        self.assertEqual(sent["Cookie"], "SESSION=abc")

    def test_caller_cookie_wins_over_session_cookie(self):
        """核心修复点:调用方显式给的 Cookie 必须不被覆盖。"""
        platform = PlatformHTTP(cookie="SESSION=abc")
        sent = self._capture_headers(platform, headers={"Cookie": "DEVICE=xyz"})
        self.assertEqual(
            sent["Cookie"], "DEVICE=xyz",
            "调用方显式给的 Cookie 被会话 cookie 覆盖了 —— 这正是本次修的缺陷",
        )

    def test_empty_session_cookie_does_not_inject_header(self):
        platform = PlatformHTTP(cookie="")
        sent = self._capture_headers(platform)
        self.assertNotIn("Cookie", sent)

    def test_other_headers_still_pass_through(self):
        """修复不能顺手影响别的头。"""
        platform = PlatformHTTP(cookie="SESSION=abc")
        sent = self._capture_headers(
            platform, headers={"Referer": "https://example.test/", "Cookie": "DEVICE=xyz"}
        )
        self.assertEqual(sent["Referer"], "https://example.test/")
        self.assertEqual(sent["Cookie"], "DEVICE=xyz")
        self.assertIn("User-Agent", sent)

    def test_caller_can_merge_both_explicitly(self):
        """需要"会话 + 设备"两者时,调用方自己拼好再传 —— 这是推荐做法。"""
        platform = PlatformHTTP(cookie="SESSION=abc")
        sent = self._capture_headers(platform, headers={"Cookie": "SESSION=abc; DEVICE=xyz"})
        self.assertEqual(sent["Cookie"], "SESSION=abc; DEVICE=xyz")


if __name__ == "__main__":
    unittest.main()
