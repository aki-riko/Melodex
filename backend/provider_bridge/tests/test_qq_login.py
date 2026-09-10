"""QQ 音乐扫码登录的测试。

流程与参数照搬 2026-08-15 脱钩重构里被删掉的 backend/third_party/music-lib/qq/login.go
(那份实现当年为 check_sig 修过 5 次), 这里用真实的 ptuiCB / LoginServer 响应形状锁定:
  - hash33(QR 的 ptqrtoken 与 authorize 的 g_tk 都用它)
  - ptuiCB 解析: ptsigx 必须逐字节保留(url 解码会把 '+' 变成空格, 当年就是这么坏的)
  - 状态码 0/65/66/67 -> success/expired/waiting/scanned
  - LoginServer 的 data -> QQ 音乐 cookie 的别名映射
"""

import base64
import json
import unittest
from unittest import mock

from provider_bridge import qq_login
from provider_bridge import qr as qr_module


PTUI_SUCCESS = (
    "ptuiCB('0','0','https://ptlogin2.graph.qq.com/check_sig?uin=1152921504&service=ptqrlogin"
    "&nodirect=0&ptsigx=abc+def/ghi=&s_url=https%3A%2F%2Fgraph.qq.com%2Foauth2.0%2Flogin_jump"
    "&f_url=&ptlang=2052','0','登录成功！', '昵称')"
)
PTUI_WAITING = "ptuiCB('66','0','','0','二维码未失效。', '')"
PTUI_SCANNED = "ptuiCB('67','0','','0','二维码已失效。', '')"
PTUI_EXPIRED = "ptuiCB('65','0','','0','二维码已失效。', '')"

LOGIN_SERVER_DATA = {
    "musicid": 1152921504,
    "musickey": "Q_H_L_abc123",
    "musickeyCreateTime": 1789054295,
    "keyExpiresIn": 259200,
    "refresh_key": "refresh-key-1",
    "refresh_token": "refresh-token-1",
    "openid": "openid-1",
    "unionid": "unionid-1",
    "access_token": "access-1",
    "str_musicid": "1152921504",
    "encryptUin": "euin-1",
    "loginType": 2,
}


class _Response:
    def __init__(self, *, content=b"", text="", status=200, headers=None, cookies=None):
        self.content = content
        self.text = text
        self.status_code = status
        self.headers = headers or {}
        self.cookies = cookies or {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"http {self.status_code}")

    def json(self):
        return json.loads(self.text)


class FakeSession:
    """按 URL 应答的假会话; 记录每次请求。"""

    def __init__(self, *, qr_show=None, qr_check=None, check_sig=None, authorize=None, login_server=None):
        self.qr_show = qr_show
        self.qr_check = qr_check or _Response(text=PTUI_WAITING, headers={})
        self.check_sig = check_sig or _Response(status=302, headers={"Location": "https://y.qq.com/"})
        self.authorize = authorize or _Response(status=302, headers={"Location": "https://y.qq.com/portal/wx_redirect.html?code=AUTHCODE&state=state"})
        self.login_server = login_server or _Response(text=json.dumps({"code": 0, "req": {"code": 0, "data": LOGIN_SERVER_DATA}}))
        self.calls = []
        self.cookies = _FakeCookieJar()

    def get(self, url, **kwargs):
        self.calls.append(("GET", url, kwargs))
        if url.startswith(qq_login.QR_SHOW_URL):
            return self.qr_show
        if url.startswith(qq_login.QR_CHECK_URL):
            return self.qr_check
        return self.check_sig

    def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        if url.startswith(qq_login.AUTHORIZE_URL):
            return self.authorize
        return self.login_server


class _FakeCookieJar:
    def __init__(self):
        self._values = {}

    def set(self, name, value, **kwargs):
        self._values[name] = value

    def __iter__(self):
        return iter([])

    def as_dict(self):
        return dict(self._values)


class Hash33Tests(unittest.TestCase):
    def test_matches_algorithm_definition(self):
        # h += (h << 5) + ord(c), 最后 & 0x7fffffff
        self.assertEqual(qq_login.hash33(""), 0)
        self.assertEqual(qq_login.hash33("ab"), 97 + (97 << 5) + 98)
        self.assertEqual(qq_login.hash33("ab", 5381), (5381 + (5381 << 5) + 97 + ((5381 + (5381 << 5) + 97) << 5) + 98) & 0x7FFFFFFF)

    def test_is_masked_to_31_bits(self):
        self.assertLess(qq_login.hash33("long-token-" * 20), 1 << 31)


class PtuiCbTests(unittest.TestCase):
    def test_parses_success_with_uin_and_sigx(self):
        code, message, redirect, uin, sigx = qq_login.parse_ptui_cb(PTUI_SUCCESS)
        self.assertEqual(code, "0")
        self.assertEqual(message, "登录成功！")
        self.assertEqual(uin, "1152921504")
        # 关键: sigx 必须保持原样, 不能被 url 解码(否则 '+' 会变成空格 -> check_sig 失败)
        self.assertEqual(sigx, "abc+def/ghi=")

    def test_parses_non_terminal_states(self):
        self.assertEqual(qq_login.parse_ptui_cb(PTUI_WAITING)[0], "66")
        self.assertEqual(qq_login.parse_ptui_cb(PTUI_SCANNED)[0], "67")
        self.assertEqual(qq_login.parse_ptui_cb(PTUI_EXPIRED)[0], "65")

    def test_unparsable_body_stays_failed(self):
        code, message, redirect, uin, sigx = qq_login.parse_ptui_cb("mystery")
        self.assertEqual((code, redirect, uin, sigx), ("", "", "", ""))


class CookieMappingTests(unittest.TestCase):
    def test_login_server_data_maps_to_music_cookies(self):
        cookies = qq_login.data_cookies(LOGIN_SERVER_DATA)
        self.assertEqual(cookies["musicid"], "1152921504")
        self.assertEqual(cookies["musickey"], "Q_H_L_abc123")
        self.assertEqual(cookies["qqmusic_key"], "Q_H_L_abc123")
        self.assertEqual(cookies["qm_keyst"], "Q_H_L_abc123")
        self.assertEqual(cookies["refresh_key"], "refresh-key-1")
        self.assertEqual(cookies["musickeyCreateTime"], "1789054295")
        self.assertEqual(cookies["keyExpiresIn"], "259200")

    def test_normalize_fills_aliases(self):
        cookies = qq_login.normalize_cookies({"uin": "123", "p_skey": "token"})
        self.assertEqual(cookies["musicid"], "123")
        self.assertEqual(cookies["qqmusic_uin"], "123")
        self.assertEqual(cookies["musickey"], "token")
        self.assertEqual(cookies["qm_keyst"], "token")

    def test_header_round_trip(self):
        raw = qq_login.cookie_header({"a": "1", "b": "2"})
        self.assertEqual(qq_login.parse_cookie_header(raw), {"a": "1", "b": "2"})


class CreateTests(unittest.TestCase):
    def test_returns_data_uri_and_session_key(self):
        png = b"\x89PNG\r\n\x1a\n" + b"0" * 32
        session = FakeSession(qr_show=_Response(content=png, cookies={"qrsig": "QR-SIG-1"}))
        session.cookies.set("qrsig", "QR-SIG-1")
        with mock.patch.object(qq_login, "_session_cookies", return_value={"qrsig": "QR-SIG-1", "pt_login_sig": "x"}):
            payload = qq_login.create(session=session)
        challenge = payload["challenge"]
        self.assertEqual(challenge["source"], "qq")
        self.assertTrue(challenge["image_url"].startswith("data:image/png;base64,"))
        self.assertEqual(base64.b64decode(challenge["image_url"].split(",", 1)[1]), png)
        # key 必须带上会话 cookie, 否则轮询时算不出 ptqrtoken 对应的会话
        from urllib.parse import parse_qs
        decoded = parse_qs(challenge["key"])
        self.assertEqual(decoded["qrsig"][0], "QR-SIG-1")
        self.assertIn("pt_login_sig=x", decoded["cookies"][0])

    def test_missing_qrsig_is_an_error(self):
        session = FakeSession(qr_show=_Response(content=b"png", cookies={}))
        with mock.patch.object(qq_login, "_session_cookies", return_value={}):
            with self.assertRaisesRegex(ValueError, "qrsig"):
                qq_login.create(session=session)


class CheckTests(unittest.TestCase):
    KEY = "qrsig=QR-SIG-1&cookies=qrsig%3DQR-SIG-1"

    def test_waiting_state_needs_no_more_requests(self):
        session = FakeSession(qr_check=_Response(text=PTUI_WAITING))
        result = qq_login.check(self.KEY, session=session)["result"]
        self.assertEqual(result["status"], "waiting")
        # 提示沿用 QQ 原文, 不自己编
        self.assertEqual(result["message"], "二维码未失效。")
        self.assertEqual(result["extra"]["code"], "66")
        self.assertNotIn("cookie", result)
        self.assertEqual(len(session.calls), 1)

    def test_expired_and_scanned(self):
        for body, phase in ((PTUI_EXPIRED, "expired"), (PTUI_SCANNED, "scanned")):
            session = FakeSession(qr_check=_Response(text=body))
            self.assertEqual(qq_login.check(self.KEY, session=session)["result"]["status"], phase)

    def test_success_runs_strong_login_and_returns_cookie(self):
        session = FakeSession(qr_check=_Response(text=PTUI_SUCCESS))
        with mock.patch.object(qq_login, "_check_sig_cookies", return_value={"p_skey": "pskey-1"}) as check_sig, \
             mock.patch.object(qq_login, "_authorize_code", return_value=("AUTHCODE", "p_skey")) as authorize, \
             mock.patch.object(qq_login, "_login_server_cookies", return_value=dict(LOGIN_SERVER_DATA and qq_login.data_cookies(LOGIN_SERVER_DATA))):
            result = qq_login.check(self.KEY, session=session)["result"]
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["extra"]["credential_source"], "qq_connect_login")
        self.assertEqual(result["extra"]["authorize_token"], "p_skey")
        self.assertIn("musickey", result["cookies"])
        self.assertIn("musickey=Q_H_L_abc123", result["cookie"])
        self.assertIn("musicid=1152921504", result["cookie"])
        check_sig.assert_called_once()
        authorize.assert_called_once()

    def test_strong_login_failure_keeps_qr_session_cookies(self):
        session = FakeSession(qr_check=_Response(text=PTUI_SUCCESS))
        with mock.patch.object(qq_login, "_check_sig_cookies", return_value={"skey": "skey-1"}), \
             mock.patch.object(qq_login, "_authorize_code", side_effect=RuntimeError("authorize boom")):
            result = qq_login.check(self.KEY, session=session)["result"]
        self.assertEqual(result["status"], "success")
        self.assertIn("authorize boom", result["extra"]["strong_login_error"])
        self.assertEqual(result["cookies"]["musickey"], "skey-1")

    def test_key_without_qrsig_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "qrsig"):
            qq_login.check("cookies=x%3D1")


class QrDispatchTests(unittest.TestCase):
    def test_qq_routes_to_qq_login(self):
        with mock.patch.object(qq_login, "create", return_value={"challenge": {"source": "qq"}}) as create, \
             mock.patch.object(qq_login, "check", return_value={"result": {"source": "qq"}}) as check:
            self.assertEqual(qr_module.create({"source": "qq"}), {"challenge": {"source": "qq"}})
            self.assertEqual(qr_module.check({"source": "qq", "key": "k"}), {"result": {"source": "qq"}})
        create.assert_called_once()
        check.assert_called_once_with("k", session=None)

    def test_netease_path_unchanged(self):
        with mock.patch.object(qr_module, "_request", return_value=({"unikey": "KEY1"}, {})):
            payload = qr_module.create({"source": "netease"})
        self.assertEqual(payload["challenge"]["key"], "KEY1")
        self.assertIn("codekey=KEY1", payload["challenge"]["url"])

    def test_unknown_source_still_rejected(self):
        for source in ("kugou", "soda", ""):
            with self.assertRaisesRegex(ValueError, "unsupported"):
                qr_module.create({"source": source})


if __name__ == "__main__":
    unittest.main()
