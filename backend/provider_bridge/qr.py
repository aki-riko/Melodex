"""QR login operations hosted by the provider sidecar.

netease 走网易自己的二维码协议; qq 走 ptlogin2 扫码 + QQ 互联强凭证
(见 provider_bridge/qq_login.py —— 这个入口在 2026-08 的来源脱钩重构里被删过)。

## netease: 为什么走 eapi 加密路径而不是明文网页版(2026-11-23)

真实事故(用户截图): 扫码后弹「登录失败，请重试」, 副标题是网易云自己返回的
「请切换其他登录方式或升级新版本再试」 —— 那是网易的 **8821 风控码**。

实测(本机真打接口, 2026-11-23):
  明文网页版 POST /api/login/qrcode/unikey   {"type":1}  -> {"code":200,"unikey":...}
  明文网页版 POST /api/login/qrcode/unikey   {"type":3}  -> {"code":200,"unikey":...}
  eapi 加密  POST /eapi/login/qrcode/unikey  {"type":3}  -> {"code":200,"unikey":...}
三者在**扫码前**行为完全一致(轮询都是 801 等待扫码), 所以"只把 type 从 1 改成 3"
并不构成换协议。真正的差异在于:
  * 明文网页版是**被网页端风控针对**的那条通道, 8821 正是它返回的;
  * eapi 是**客户端协议**, 需要 AES 加密参数 + 设备 cookie(os/appver/deviceId),
    这也是社区实现(如 api-enhanced)在网页版被拒后采用的路径。

因此这里改用 eapi 加密通道 + 设备指纹, 并把 type 固定为 3(客户端二维码类型)。
注意这是**协议层替换**, 不是"加个参数": 请求体从明文 form 变成
`params=<AES-ECB(hex)>`, 路径从 /api/ 变 /eapi/, 且必须带设备 cookie。

## 8821 这类风控码必须能识别

`{800,801,802,803}` 之外, 网易还会返回 8821(需要行为验证/风控)、8830 等。
旧实现一律映射成 "failed", 前端只能显示笼统的"登录失败" —— 用户不知道该做什么。
现在把风控码单独标出来, 前端据此提示"稍后重试或改用手填 Cookie"。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import requests

from provider_bridge import qq_login
from provider_bridge.collection_common import at, integer, string
from provider_bridge.platform_http import USER_AGENT


# 快照(third_party/charles-musicdl)提供 EapiCryptoUtils。server.py 启动时已把该目录
# 插进 sys.path, 但本模块也会被测试/脚本单独 import —— 那时没有 server.py 的前置动作,
# 所以要自己补一次(幂等)。与 netease_source.py 的延迟导入保持同一约定。
VENDOR_ROOT = Path(__file__).resolve().parents[1] / "third_party" / "charles-musicdl"


BASE_URL = "https://music.163.com"
# eapi 走 interface3 域名(与播放地址接口一致, 见 netease_source.py:159)。
EAPI_BASE_URL = "https://interface3.music.163.com"
# 客户端二维码类型: 网页版是 1, 客户端是 3。网页版通道已被风控针对, 故用 3。
QR_CLIENT_TYPE = 3
# eapi 要求的设备指纹 cookie。appver 用真实客户端版本号, deviceId 沿用快照里的标识
# (见 netease_source.py 的 EAPI_DEVICE_COOKIES), 保持与播放链路一致。
EAPI_DEVICE_COOKIES = {"os": "pc", "appver": "8.9.70", "osver": "", "deviceId": "pyncm!"}
EAPI_HEADERS = {
    "User-Agent": USER_AGENT,
    "Referer": "https://music.163.com/",
    "Origin": "https://music.163.com",
    "Content-Type": "application/x-www-form-urlencoded",
}

# 网易二维码登录的业务码。800/801/802/803 是正常状态机;
# 8821/8830 是风控/行为验证, 必须与"普通失败"区分开 —— 前者让用户等一下或改手填,
# 后者才是真的出错了。
QR_PHASE_BY_CODE = {800: "expired", 801: "waiting", 802: "scanned", 803: "success"}
# 风控类: 网易要求行为验证。实测文案就是 "请切换其他登录方式或升级新版本再试"。
QR_RISK_CODES = {
    8821: "网易云要求行为验证（风控），请稍等几分钟重试，或改用手填 Cookie",
    8830: "当前二维码无法继续（风控），请重新生成或改用手填 Cookie",
    8812: "登录请求被网易云拒绝，建议改用手填 Cookie",
}


def _eapi_params(path_api: str, payload: dict[str, Any]) -> str:
    """用快照的 EapiCryptoUtils 加密参数(快照只被 import, 不修改)。

    path_api 必须是 /api/ 形式: encryptparams 内部会把 /eapi/ 换成 /api/ 再算摘要,
    这里显式传 api 路径, 避免调用方再记一次这个约定。
    """
    vendor = str(VENDOR_ROOT)
    if vendor not in sys.path:
        sys.path.insert(0, vendor)
    from musicdl.modules.utils.neteaseutils import EapiCryptoUtils

    return EapiCryptoUtils.encryptparams(url=EAPI_BASE_URL + path_api, payload=payload)


def _eapi_post(path_api: str, payload: dict[str, Any], *, session=None):
    """发一次 eapi 请求: 明文 form 变 params=<hex>, 路径 /api/ -> /eapi/, 带设备 cookie。

    返回 (json_body, cookies): 803 登录成功时 MUSIC_U 是通过 **Set-Cookie** 下发的,
    只取 body 会丢掉凭据 —— 这是旧实现里 `{item.name: item.value for item in cookies}`
    那段的作用, eapi 版必须同样保留。
    """
    client = session or requests.Session()
    response = client.post(
        EAPI_BASE_URL + path_api.replace("/api/", "/eapi/", 1),
        data={"params": _eapi_params(path_api, payload)},
        headers=EAPI_HEADERS,
        # 显式传 Cookie 头: 设备指纹 + 会话已有 cookie(create 下发的 NMTID)
        cookies=EAPI_DEVICE_COOKIES,
        timeout=30,
    )
    response.raise_for_status()
    body = json.loads(response.content.decode("utf-8"))
    cookies = {item.name: item.value for item in response.cookies}
    return body, cookies


def _request(path: str, form: dict[str, Any], *, session=None):
    """明文网页版请求(仅 QQ 之外的旧兼容路径/测试使用)。"""
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
    source = string(payload.get("source")).lower()
    if source == "qq":
        return qq_login.create(session=session)
    if source != "netease":
        raise ValueError("unsupported QR login source")
    # eapi 加密通道 + 客户端二维码类型(见模块注释: 网页版明文通道是 8821 的来源)。
    data, _ = _eapi_post("/api/login/qrcode/unikey", {"type": QR_CLIENT_TYPE}, session=session)
    key = string(at(data, "unikey")) or string(at(data, "data", "unikey"))
    if not key:
        # 上游没给 key 时把真实返回带进异常, 否则只会看到一句无从下手的 "no key"。
        raise ValueError(f"netease QR endpoint returned no key: {data}")
    return {"challenge": {
        "source": "netease", "key": key,
        "url": "https://music.163.com/login?" + urlencode({"codekey": key}),
    }}


def check(payload: dict[str, Any], *, session=None) -> dict[str, Any]:
    source = string(payload.get("source")).lower()
    key = string(payload.get("key"))
    if source == "qq":
        return qq_login.check(key, session=session)
    if source != "netease":
        raise ValueError("unsupported QR login source")
    if not key:
        raise ValueError("netease QR key is required")
    data, cookies = _eapi_post(
        "/api/login/qrcode/client/login",
        {"key": key, "type": QR_CLIENT_TYPE},
        session=session,
    )
    code = integer(data.get("code"))
    message = string(data.get("message"))
    result = {
        "source": "netease", "key": key,
        # 风控码(8821 等)单独归类: 前端据此提示"稍后重试/手填 Cookie",
        # 而不是笼统一句"登录失败"。未登记的风控码仍落到 failed, 但会带上 message。
        "status": QR_PHASE_BY_CODE.get(code, "failed"),
        "message": message,
        "cookies": cookies,
    }
    if code in QR_RISK_CODES:
        result["message"] = f"{QR_RISK_CODES[code]}（上游 code={code}）"
        result["extra"] = {"risk_code": str(code)}
    # 成功(803)时网易把 MUSIC_U 放在 Set-Cookie 或 body.cookie 里, 两处都要收。
    if QR_PHASE_BY_CODE.get(code) == "success":
        raw_cookie = string(data.get("cookie")) or "; ".join(
            f"{name}={value}" for name, value in sorted(cookies.items())
        )
        if raw_cookie:
            result["cookie"] = raw_cookie
    return {"result": result}
