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

    # ── QQ 歌单/专辑不得谎报 has_lossless ──────────────────────────────────────
    #
    # 真机事故(2026-11-25, NAS 生产日志, 已逐条取证):
    #   付费单曲「深蓝泡沫 - Hotcell」(qq mid=0008mqT01SeqJC, is_paid=1)从歌单进入,
    #   QQ 歌单接口返回 sizeflac > 0(平台上确实存在 FLAC 版本), 于是被打上
    #   has_lossless=1。但这条曲付费, 实际取址只能拿到 640k OGG。
    #   后果链:
    #     ① stream_quality.go 认为「副本有损、在线无损」→ 放弃本地副本回源;
    #     ② 上游给的仍是**同一个**文件(17,095,734 字节, 与副本一字节不差);
    #     ③ 每次播放白传 16.3 MB, 音质分毫未涨。日志原文:
    #        [stream] 副本为有损(ogg),在线源声明无损,改走在线 rel="深蓝泡沫 - Hotcell.ogg"
    #        [stream-range] resolved ... total=17095734 ext="ogg"
    #
    # has_lossless 的**契约**是「已解析出真实下载地址, 且其扩展名是无损格式」——
    # 歌单/专辑接口根本不解析下载地址(url 恒为空), 此刻对格式一无所知, 无权断言。
    # 该键同时被 stream_quality.go 与前端 playerAutoDownload.js 当硬证据消费, 一旦
    # 谎报就同时污染「要不要回源」与「要不要重下」两个决策。
    #
    # 下方两条为此断言: 有 sizeflac 也只能写 lossless_available(纯展示),
    # **绝不能**写 has_lossless。

    def test_qq_collection_songs_do_not_claim_has_lossless_from_sizeflac(self):
        """QQ 歌单返回 sizeflac>0 时, 不得写 has_lossless(必须写 lossless_available)。"""
        session = FakeSession([
            ("https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg", {
                "cdlist": [{
                    "dissid": "123", "dissname": "歌单",
                    "songlist": [{
                        "songmid": "0008mqT01SeqJC", "songname": "深蓝泡沫",
                        "albummid": "004BYFnE3KDCpq", "albumname": "深蓝泡沫",
                        "interval": 219, "sizeflac": 45712849,
                        "singer": [{"name": "Hotcell"}],
                        "pay": {"paytrackprice": 200},
                    }],
                }],
            })
        ])
        result = collection(
            {"source": "qq", "action": "playlist", "id": "123", "cookie": "qm_keyst=x"},
            session=session,
        )
        songs = result["songs"]
        self.assertEqual(len(songs), 1)
        extra = songs[0]["extra"]
        # 核心断言: 没解析过下载地址, 就不许声称能拿到无损。
        self.assertNotIn(
            "has_lossless", extra,
            "歌单路径未解析下载地址, 写 has_lossless 会让 stream_quality.go 误判"
            "「在线无损」而放弃本地副本, 白白重复下载同一个有损文件",
        )
        # 但「平台上有无损版本」这个事实仍保留, 只是换个不承载取址结论的键。
        self.assertEqual(extra["lossless_available"], "1")
        # 付费标记与原行为保持一致。
        self.assertEqual(extra["is_paid"], "1")

    def test_qq_collection_songs_without_sizeflac_have_no_lossless_flag(self):
        """无 sizeflac 时不写任何无损相关键(与有 sizeflac 时形成对照)。"""
        session = FakeSession([
            ("https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg", {
                "data": {
                    "albummid": "004BYFnE3KDCpq", "albumname": "深蓝泡沫",
                    "list": [{
                        "songmid": "0008mqT01SeqJC", "songname": "深蓝泡沫",
                        "interval": 219,
                        "singer": [{"name": "Hotcell"}],
                    }],
                },
            })
        ])
        result = collection(
            {"source": "qq", "action": "album", "id": "004BYFnE3KDCpq", "cookie": "qm_keyst=x"},
            session=session,
        )
        extra = result["songs"][0]["extra"]
        self.assertNotIn("has_lossless", extra)
        self.assertNotIn("lossless_available", extra)


if __name__ == "__main__":
    unittest.main()
