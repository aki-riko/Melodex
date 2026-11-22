import json
import unittest
from types import SimpleNamespace
from unittest import mock

from provider_bridge import qr as qr_module
from provider_bridge.collections import collection
from provider_bridge.platforms.netease import NeteaseCollections
from provider_bridge.qr import check as qr_check
from provider_bridge.qr import create as qr_create


def patch_eapi_params():
    """打桩 eapi 加密: 单测环境不装快照的 AES 依赖, 生产镜像里才有。

    与 test_netease_source.py 的 patch_eapi_params 同一约定 —— 只替换加密这一步,
    请求路径/表单形状/Cookie 处理仍然真实执行, 这样测试才锁得住"换成 eapi 后还在用
    /eapi/ 路径和 params= 表单"。
    """
    return mock.patch.object(
        qr_module, "_eapi_params", side_effect=lambda path_api, payload: f"stub:{path_api}"
    )


class FakeResponse:
    def __init__(self, payload, cookies=()):
        self.content = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.cookies = [SimpleNamespace(name=name, value=value) for name, value in cookies]

    def raise_for_status(self):
        return None


class FakeSession:
    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        for prefix, payload in self.routes:
            if url.startswith(prefix):
                return FakeResponse(payload)
        raise AssertionError(f"unexpected request {method} {url}")

    def post(self, url, **kwargs):
        self.calls.append(("POST", url, kwargs))
        for prefix, payload in self.routes:
            if url.startswith(prefix):
                if isinstance(payload, tuple):
                    return FakeResponse(payload[0], payload[1])
                return FakeResponse(payload)
        raise AssertionError(f"unexpected request POST {url}")


class CollectionSidecarTests(unittest.TestCase):
    def test_netease_search_maps_collection(self):
        session = FakeSession([
            ("https://music.163.com/api/search/get/web", {
                "result": {"playlists": [{"id": 7, "name": "歌单", "coverImgUrl": "https://cover", "trackCount": 2}]}
            })
        ])
        result = NeteaseCollections("MUSIC_U=test", session).search_playlist("晴天")
        self.assertEqual(result[0]["id"], "7")
        self.assertEqual(result[0]["track_count"], 2)
        self.assertEqual(session.calls[0][2]["headers"]["Cookie"], "MUSIC_U=test")

    def test_collection_dispatches_detail(self):
        session = FakeSession([
            ("https://music.163.com/api/v6/playlist/detail", {
                "playlist": {"id": 7, "name": "歌单", "trackCount": 1},
            })
        ])
        result = collection({"source": "netease", "action": "playlist", "id": "7"}, session=session)
        self.assertEqual(result["collection"]["id"], "7")
        self.assertEqual(result["songs"], [])

    def test_qr_check_maps_state_and_cookie(self):
        session = FakeSession([
            ("https://interface3.music.163.com/eapi/login/qrcode/client/login",
             ({"code": 803}, (("MUSIC_U", "cookie"),)))
        ])
        with patch_eapi_params():
            result = qr_check({"source": "netease", "key": "key-1"}, session=session)
        self.assertEqual(result["result"]["status"], "success")
        self.assertEqual(result["result"]["cookie"], "MUSIC_U=cookie")

    def test_qr_create_encodes_key_in_verification_url(self):
        session = FakeSession([
            ("https://interface3.music.163.com/eapi/login/qrcode/unikey", {"unikey": "key/a?b"})
        ])
        with patch_eapi_params():
            result = qr_create({"source": "netease"}, session=session)
        self.assertEqual(result["challenge"]["url"], "https://music.163.com/login?codekey=key%2Fa%3Fb")

    def test_qr_uses_eapi_path_and_device_fingerprint(self):
        """协议层回归: 必须是 eapi 加密通道 + 设备指纹, 不能退回明文网页版。

        2026-11-23 真实事故: 扫码后返回 8821「请切换其他登录方式或升级新版本再试」,
        那是**网页版明文通道**的风控。改成 eapi(客户端协议)后必须:
          * 请求打在 interface3 域名的 /eapi/ 路径;
          * 参数走 params=(加密), 不再是明文字段;
          * 带设备 cookie(os/appver/deviceId), 缺了会被当成非客户端。
        """
        session = FakeSession([
            ("https://interface3.music.163.com/eapi/login/qrcode/unikey", {"unikey": "k1"})
        ])
        with patch_eapi_params():
            qr_create({"source": "netease"}, session=session)

        method, url, kwargs = session.calls[0]
        self.assertEqual(method, "POST")
        self.assertIn("/eapi/login/qrcode/unikey", url, "必须走 eapi 加密通道")
        self.assertNotIn("/api/login/qrcode/unikey", url, "不能退回明文网页版路径")
        self.assertIn("params", kwargs.get("data") or {}, "参数必须加密放进 params")
        self.assertNotIn("type", kwargs.get("data") or {}, "不能发送明文 type 字段")
        cookies = kwargs.get("cookies") or {}
        self.assertEqual(cookies.get("deviceId"), "pyncm!", "必须带设备指纹")

    def test_qr_risk_code_is_reported_with_guidance(self):
        """8821 风控码必须与"普通失败"区分开, 并给出可执行建议。

        旧实现把它归成 failed, 前端只能显示"登录失败，请重试" —— 用户照着重试
        依然失败, 因为这是风控而不是偶发错误。
        """
        session = FakeSession([
            ("https://interface3.music.163.com/eapi/login/qrcode/client/login",
             {"code": 8821, "message": "请切换其他登录方式或升级新版本再试"})
        ])
        with patch_eapi_params():
            result = qr_check({"source": "netease", "key": "k2"}, session=session)["result"]
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["extra"]["risk_code"], "8821")
        # 提示必须包含"怎么办", 不能只有上游原文
        self.assertIn("手填 Cookie", result["message"])
        self.assertIn("8821", result["message"])

    def test_qr_waiting_state_does_not_carry_cookie(self):
        """801 等待扫码不能带 cookie, 否则会被误判成登录成功并持久化空凭据。"""
        session = FakeSession([
            ("https://interface3.music.163.com/eapi/login/qrcode/client/login", {"code": 801})
        ])
        with patch_eapi_params():
            result = qr_check({"source": "netease", "key": "k3"}, session=session)["result"]
        self.assertEqual(result["status"], "waiting")
        self.assertNotIn("cookie", result)

    def test_unknown_collection_source_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "unsupported collection source"):
            collection({"source": "unknown", "action": "categories"})

    def test_migu_user_playlists_is_a_provider_error(self):
        with self.assertRaisesRegex(ValueError, "not supported"):
            collection({"source": "migu", "action": "user_playlists"})


if __name__ == "__main__":
    unittest.main()
