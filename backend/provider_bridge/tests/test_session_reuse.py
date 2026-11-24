"""一次搜索只应创建一个 requests.Session(2026-11 全库扫描修正)。

真实缺陷:session 从 search_* 一路传到 resolve_play_url 始终是 None,于是
PlatformHTTP 在**每首歌**上都新建一个 requests.Session()。20 首候选 = 20 个
独立连接池,每首都重新 TCP+TLS 握手;sidecar 又是 ThreadingHTTPServer,
多请求叠加时对上游就是「N 首 × M 并发」条新连接,与本项目"绝不提高上游并发"
的纪律方向相反。

修法:入口处用 _shared_session() 建一个,沿调用链传下去。

这条测试数 session 的创建次数 —— 不数连接、不数请求,只数 "requests.Session()
被调了几次",因为那正是缺陷本身。
"""

from __future__ import annotations

import unittest
from unittest import mock

from provider_bridge import netease_source


class _FakeResponse:
    status_code = 200
    content = b'{"code": 200, "data": {}}'

    def raise_for_status(self):
        return None


class SharedSessionTest(unittest.TestCase):
    def test_helper_creates_once_when_none(self):
        with mock.patch.object(netease_source.requests, "Session") as fake:
            fake.return_value = "SESSION"
            first = netease_source._shared_session(None)
            self.assertEqual(first, "SESSION")
            self.assertEqual(fake.call_count, 1)

    def test_helper_reuses_given_session(self):
        with mock.patch.object(netease_source.requests, "Session") as fake:
            got = netease_source._shared_session("EXISTING")
            self.assertEqual(got, "EXISTING")
            self.assertEqual(fake.call_count, 0, "已有 session 时不该再新建")

    def test_search_songs_creates_at_most_one_session(self):
        """核心断言:一次 search_songs 全程只建一个 Session。

        修复前:6 个候选 → 6 次 requests.Session()(每首一个)。
        修复后:1 次。
        """
        matches = [{"id": str(i), "name": "歌%d" % i} for i in range(6)]

        with mock.patch.object(netease_source.requests, "Session") as fake_session, \
                mock.patch.object(netease_source, "song_matches", return_value=matches), \
                mock.patch.object(netease_source, "song_details", return_value={}), \
                mock.patch.object(netease_source, "resolve_play_url", return_value={}) as fake_resolve:
            fake_session.return_value.request = mock.Mock(return_value=_FakeResponse())
            netease_source.search_songs("测试", 6, cookie="")

            self.assertEqual(
                fake_session.call_count, 1,
                "一次搜索应只建 1 个 requests.Session,实测 %d 次" % fake_session.call_count,
            )
            # resolve_play_url 收到的 session 必须是同一个非 None 对象
            self.assertGreaterEqual(fake_resolve.call_count, 1)
            passed_sessions = {id(call.args[2]) for call in fake_resolve.call_args_list if len(call.args) > 2}
            self.assertEqual(
                len(passed_sessions), 1,
                "并发取址应共享同一个 session 对象,实测 %d 个不同对象" % len(passed_sessions),
            )
            self.assertNotIn(id(None), passed_sessions, "传入的 session 不能是 None")


if __name__ == "__main__":
    unittest.main()
