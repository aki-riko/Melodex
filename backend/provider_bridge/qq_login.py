"""QQ 音乐扫码登录: ptlogin2 扫码 -> QQ 互联授权 -> QQ 音乐强凭证。

为什么需要它: 这个入口原本是有的 —— 2026-08-15 的"后端来源脱钩"重构(d222a0c)把
backend/third_party/music-lib/qq/login.go 连同 QQ 扫码一起删掉了(当年还专门为它修过
5 次 check_sig 兼容: 650dcd3 / 192c63a / d07acc2 / d9bed20 / 21edac9), 之后
`core.GetQRLoginSourceNames()` 只剩 netease, 界面里 QQ 卡片就再没有"扫码"按钮。
本模块按新架构(provider_bridge 自有实现, 不改 third_party 快照)把这套流程重建,
步骤与参数照搬被删的那份实现:

  1. GET  ssl.ptlogin2.qq.com/ptqrshow        二维码 PNG + qrsig cookie
  2. GET  ssl.ptlogin2.qq.com/ptqrlogin       轮询; 成功时 ptuiCB 第 3 段是跳转地址,
                                               里面含 uin 与 ptsigx(必须逐字节保留, 不能
                                               URL 解码 —— '+' 会被解成空格导致 check_sig 失败)
  3. GET  <跳转地址>(最多跟 5 跳)              拿到 p_skey / skey 等授权 cookie
  4. POST graph.qq.com/oauth2.0/authorize     302 Location 里带 code(g_tk=hash33(token,5381))
  5. POST u.y.qq.com 等 musicu.fcg
          QQConnectLogin.LoginServer/QQLogin  返回 musickey/musicid/keyExpiresIn 等
  6. 归一化成 QQ 音乐 cookie(musickey/qqmusic_key/qm_keyst + musicid/qqmusic_uin/uin)

第 3 步的 token 会依次尝试 p_skey/skey/superkey/supertoken/pt_oauth_token, 最后才用
g_tk=5381 兜底 —— 这是当年那几次修复的结论, QQ 不同登录态下可用的 token 不一样。
"""

from __future__ import annotations

import base64
import json
import logging
import re
import time
from typing import Any
from urllib.parse import parse_qs, urlencode

import requests

from provider_bridge.collection_common import string

LOGGER = logging.getLogger(__name__)

QR_SHOW_URL = "https://ssl.ptlogin2.qq.com/ptqrshow"
QR_CHECK_URL = "https://ssl.ptlogin2.qq.com/ptqrlogin"
AUTHORIZE_URL = "https://graph.qq.com/oauth2.0/authorize"
LOGIN_SERVER_URLS = (
    "https://u.y.qq.com/cgi-bin/musicu.fcg",
    "https://szu.y.qq.com/cgi-bin/musicu.fcg",
    "https://shu.y.qq.com/cgi-bin/musicu.fcg",
)
LOGIN_SERVER_MODULE = "QQConnectLogin.LoginServer"
LOGIN_SERVER_METHOD = "QQLogin"

APP_ID = "716027609"
DAID = "383"
THIRD_PARTY_AID = "100497308"
AUTHORIZE_REDIRECT = "https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/"

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
PTLOGIN_REFERER = "https://xui.ptlogin2.qq.com/"
GRAPH_REFERER = "https://graph.qq.com/oauth2.0/show?which=Login&display=pc"
MUSIC_REFERER = "https://y.qq.com/"

QR_TTL_SECONDS = 120
_QUOTED = re.compile(r"'([^']*)'")
_UIN = re.compile(r"(?:\?|&)uin=([^&]+)&service")
_SIGX = re.compile(r"(?:\?|&)ptsigx=([^&]+)&s_url")

# ptuiCB 状态码 -> 前端相位(与被删实现一致)
PHASES = {"0": "success", "65": "expired", "66": "waiting", "67": "scanned"}
PHASE_MESSAGES = {"65": "二维码已过期, 请刷新", "66": "等待扫码中", "67": "已扫码, 请在手机上确认"}

# 授权 token 候选(顺序即回退顺序), 最后一项是无 token 的兜底。
TOKEN_KEYS = ("p_skey", "skey", "superkey", "supertoken", "pt_oauth_token")

# LoginServer 返回字段 -> cookie 名(照搬被删实现的映射)。
DATA_COOKIE_FIELDS = (
    (("musicid", "musicId", "userid", "user_id", "uin"), ("musicid", "qqmusic_uin")),
    (("musickey", "music_key", "qqmusic_key", "qm_keyst", "strMusicKey"), ("musickey", "qqmusic_key", "qm_keyst")),
    (("refresh_key", "refreshKey"), ("refresh_key",)),
    (("refresh_token", "refreshToken"), ("refresh_token",)),
    (("openid", "openId", "wxopenid", "strOpenid"), ("openid", "wxopenid")),
    (("unionid", "unionId", "wxunionid", "strUnionid"), ("unionid", "wxunionid")),
    (("access_token", "accessToken", "wxaccess_token"), ("access_token", "wxaccess_token")),
    (("expired_at", "expiredAt", "expired_in", "expiredIn"), ("expired_at",)),
    (("str_musicid", "strMusicid", "strMusicID"), ("str_musicid",)),
    (("musickeyCreateTime", "musickey_create_time", "psrf_musickey_createtime"),
     ("musickeyCreateTime", "psrf_musickey_createtime")),
    (("keyExpiresIn", "key_expires_in"), ("keyExpiresIn",)),
    (("encryptUin", "encrypt_uin", "euin"), ("encryptUin", "euin")),
    (("loginType", "login_type", "tmeLoginType"), ("loginType", "tmeLoginType")),
)


def hash33(text: str, seed: int = 0) -> int:
    """QQ 的 hash33(ptqrtoken / g_tk 都用它)。"""
    value = seed
    for char in text or "":
        value += (value << 5) + ord(char)
    return value & 0x7FFFFFFF


def cookie_header(cookies: dict[str, str]) -> str:
    return "; ".join(f"{name}={value}" for name, value in cookies.items() if name)


def parse_cookie_header(raw: str) -> dict[str, str]:
    cookies: dict[str, str] = {}
    for part in (raw or "").split(";"):
        name, separator, value = part.partition("=")
        name = name.strip()
        if separator and name:
            cookies[name] = value.strip()
    return cookies


def parse_ptui_cb(raw: str) -> tuple[str, str, str, str, str]:
    """解析 ptuiCB('code','0','<跳转地址>','0','提示','')。返回 (code, message, redirect, uin, sigx)。"""
    matches = _QUOTED.findall(raw or "")
    if len(matches) < 5:
        return "", string(raw), "", "", ""
    redirect = matches[2]
    # 关键: ptsigx 必须逐字节保留 —— url 解码会把 '+' 变成空格, 导致 check_sig 失败。
    uin_match = _UIN.search(redirect)
    sigx_match = _SIGX.search(redirect)
    return (
        matches[0],
        matches[4],
        redirect,
        uin_match.group(1).strip() if uin_match else "",
        sigx_match.group(1).strip() if sigx_match else "",
    )


def data_cookies(data: Any) -> dict[str, str]:
    """LoginServer 的 data -> QQ 音乐 cookie。"""
    if not isinstance(data, dict):
        return {}
    result: dict[str, str] = {}

    def pick(keys: tuple[str, ...]) -> str:
        for key in keys:
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
            if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
                return str(int(value))
        return ""

    for sources, targets in DATA_COOKIE_FIELDS:
        value = pick(sources)
        if not value:
            continue
        for target in targets:
            result[target] = value
    return result


def _first(cookies: dict[str, str], *names: str) -> str:
    for name in names:
        value = string(cookies.get(name))
        if value:
            return value
    return ""


def normalize_cookies(cookies: dict[str, str]) -> dict[str, str]:
    """补齐 QQ 音乐的别名 cookie(与快照/旧实现口径一致)。"""
    result = {name: value for name, value in cookies.items() if name}
    music_id = _first(result, "musicid", "qqmusic_uin", "str_musicid", "uin", "ptui_loginuin",
                      "luin", "pt2gguin", "superuin", "p_uin", "userid", "wxuin")
    if music_id:
        for name in ("musicid", "qqmusic_uin", "uin"):
            result.setdefault(name, music_id)
    music_key = _first(result, "musickey", "qqmusic_key", "qm_keyst", "p_skey", "skey")
    if music_key:
        for name in ("musickey", "qqmusic_key", "qm_keyst"):
            result.setdefault(name, music_key)
    return result


def _new_session(cookies: dict[str, str] | None = None) -> requests.Session:
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    for name, value in (cookies or {}).items():
        session.cookies.set(name, value)
    return session


def _session_cookies(session: requests.Session) -> dict[str, str]:
    return {cookie.name: cookie.value for cookie in session.cookies}


def create(*, session: requests.Session | None = None) -> dict[str, Any]:
    """取二维码: 返回 data-uri PNG 与承载会话 cookie 的 key。"""
    client = session or _new_session()
    params = {
        "appid": APP_ID,
        "e": "2",
        "l": "M",
        "s": "3",
        "d": "72",
        "v": "4",
        "t": f"{time.time_ns() / 1e18:.17f}",
        "daid": DAID,
        "pt_3rd_aid": THIRD_PARTY_AID,
    }
    response = client.get(
        QR_SHOW_URL, params=params, headers={"Referer": PTLOGIN_REFERER}, timeout=30
    )
    response.raise_for_status()
    cookies = _session_cookies(client)
    qrsig = string(cookies.get("qrsig"))
    if not qrsig:
        raise ValueError("qq qr show returned no qrsig cookie")
    image = response.content
    if not image:
        raise ValueError("qq qr show returned empty image")
    key = urlencode({"qrsig": qrsig, "cookies": cookie_header(cookies)})
    return {
        "challenge": {
            "source": "qq",
            "key": key,
            "image_url": "data:image/png;base64," + base64.b64encode(image).decode("ascii"),
            "expires_at": int(time.time()) + QR_TTL_SECONDS,
            "extra": {"qrsig": qrsig},
        }
    }


def _check_sig_cookies(session: requests.Session, redirect_url: str, initial: dict[str, str]) -> dict[str, str]:
    """跟随 check_sig 跳转, 收集 p_skey/skey 等授权 cookie(最多 5 跳)。"""
    cookies = dict(initial)
    current = string(redirect_url)
    referer = PTLOGIN_REFERER
    for _hop in range(5):
        if not current:
            break
        response = session.get(
            current,
            headers={"Referer": referer},
            timeout=30,
            allow_redirects=False,
        )
        cookies.update(_session_cookies(session))
        if _first(cookies, "p_skey", "skey"):
            return cookies
        location = string(response.headers.get("Location"))
        if not location or not 300 <= response.status_code < 400:
            break
        referer = current
        current = requests.compat.urljoin(current, location)
    if _first(cookies, "p_skey", "skey", "superkey", "supertoken", "pt_oauth_token"):
        return cookies
    raise RuntimeError("qq check_sig did not return auth cookies")


def _authorize_code(session: requests.Session, cookies: dict[str, str]) -> tuple[str, str]:
    """用可用 token 换取 authorize code; 返回 (code, token 名)。"""
    candidates: list[tuple[str, str]] = []
    for name in TOKEN_KEYS:
        token = string(cookies.get(name))
        if token:
            candidates.append((name, token))
    candidates.append(("default_5381", ""))
    failures: list[str] = []
    for name, token in candidates:
        form = {
            "response_type": "code",
            "client_id": THIRD_PARTY_AID,
            "redirect_uri": AUTHORIZE_REDIRECT,
            "scope": "get_user_info,get_app_friends",
            "state": "state",
            "switch": "",
            "from_ptlogin": "1",
            "src": "1",
            "update_auth": "1",
            "openapi": "1010_1030",
            "g_tk": str(hash33(token, 5381)),
            "auth_time": str(int(time.time() * 1000)),
            "ui": str(time.time_ns()),
        }
        response = session.post(
            AUTHORIZE_URL,
            data=form,
            headers={"Referer": GRAPH_REFERER, "Content-Type": "application/x-www-form-urlencoded"},
            timeout=30,
            allow_redirects=False,
        )
        cookies.update(_session_cookies(session))
        location = string(response.headers.get("Location"))
        if not location:
            failures.append(f"{name}: no redirect (status {response.status_code})")
            continue
        code = string((parse_qs(requests.compat.urlparse(location).query).get("code") or [""])[0])
        if not code:
            failures.append(f"{name}: no code in redirect")
            continue
        return code, name
    raise RuntimeError("qq authorize failed; tried=" + ", ".join(name for name, _ in candidates)
                       + "; failures=[" + " | ".join(failures) + "]")


def _login_server_cookies(session: requests.Session, code: str) -> dict[str, str]:
    """用 code 换 QQ 音乐强凭证(musickey 等)。"""
    payload = {
        "comm": {
            "tmeAppID": "qqmusic",
            "tmeLoginType": 2,
            "g_tk": 5381,
            "platform": "yqq",
            "ct": 24,
            "cv": 0,
        },
        "req": {"module": LOGIN_SERVER_MODULE, "method": LOGIN_SERVER_METHOD, "param": {"code": code}},
    }
    last_error = ""
    for api_url in LOGIN_SERVER_URLS:
        try:
            response = session.post(
                api_url,
                data=json.dumps(payload),
                headers={"Referer": MUSIC_REFERER, "Origin": "https://y.qq.com",
                         "Accept": "*/*", "Content-Type": "application/json"},
                timeout=30,
            )
            response.raise_for_status()
            parsed = response.json()
        except Exception as error:
            last_error = f"{api_url}: {type(error).__name__} {error}"
            continue
        if not isinstance(parsed, dict):
            last_error = f"{api_url}: response is not an object"
            continue
        req = parsed.get("req") if isinstance(parsed.get("req"), dict) else {}
        if int(parsed.get("code") or 0) != 0 or int(req.get("code") or 0) != 0:
            message = string(req.get("message") or req.get("msg") or parsed.get("message") or parsed.get("msg"))
            last_error = f"{api_url}: api error {message} (code {parsed.get('code')}, req {req.get('code')})"
            continue
        cookies = dict(data_cookies(req.get("data")))
        cookies.update(_session_cookies(session))
        return cookies
    raise RuntimeError("qq connect login failed: " + (last_error or "no endpoint answered"))


def check(payload_key: str, *, session: requests.Session | None = None) -> dict[str, Any]:
    """轮询扫码状态; 成功时完成强登录并返回可保存的 cookie。"""
    values = parse_qs(payload_key or "")
    qrsig = string((values.get("qrsig") or [""])[0])
    if not qrsig:
        raise ValueError("qq qr login key is missing qrsig")
    session_cookies = parse_cookie_header((values.get("cookies") or [""])[0])
    session_cookies.setdefault("qrsig", qrsig)
    client = session or _new_session(session_cookies)
    if session is not None:
        for name, value in session_cookies.items():
            client.cookies.set(name, value)

    params = {
        "u1": "https://graph.qq.com/oauth2.0/login_jump",
        "ptqrtoken": str(hash33(qrsig)),
        "ptredirect": "0",
        "h": "1",
        "t": "1",
        "g": "1",
        "from_ui": "1",
        "ptlang": "2052",
        "action": f"0-0-{int(time.time() * 1000)}",
        "js_ver": "20102616",
        "js_type": "1",
        "pt_uistyle": "40",
        "aid": APP_ID,
        "daid": DAID,
        "pt_3rd_aid": THIRD_PARTY_AID,
        "has_onekey": "1",
    }
    response = client.get(
        QR_CHECK_URL, params=params,
        headers={"Referer": PTLOGIN_REFERER, "Cookie": cookie_header(session_cookies)},
        timeout=30, allow_redirects=False,
    )
    response.raise_for_status()
    code, message, redirect_url, uin, sigx = parse_ptui_cb(response.text)
    phase = PHASES.get(code, "failed")
    result: dict[str, Any] = {
        "source": "qq",
        "key": payload_key,
        "status": phase,
        "message": message or PHASE_MESSAGES.get(code, ""),
        "extra": {"code": code},
    }
    if phase != "success":
        return {"result": result}

    cookies = dict(session_cookies)
    cookies.update(_session_cookies(client))
    metadata = dict(result["extra"])
    try:
        if not (uin and sigx):
            raise RuntimeError("qq qr login success but redirect carried no uin/ptsigx")
        authorized = _check_sig_cookies(client, redirect_url, cookies)
        cookies.update(authorized)
        auth_code, token_name = _authorize_code(client, cookies)
        cookies.update(_login_server_cookies(client, auth_code))
        metadata["credential_source"] = "qq_connect_login"
        metadata["authorize_token"] = token_name
    except Exception as error:  # 强登录失败要留下原因, 但不能丢掉已到手的 cookie
        LOGGER.warning("[qq] 强登录失败, 退回扫码会话 cookie: %s", error)
        metadata["strong_login_error"] = str(error)
        try:
            cookies.update(_check_sig_cookies(client, redirect_url, cookies))
            metadata.setdefault("credential_source", "redirect_cookie")
        except Exception as redirect_error:
            metadata["redirect_error"] = str(redirect_error)

    normalized = normalize_cookies(cookies)
    result["cookies"] = normalized
    result["cookie"] = cookie_header(normalized)
    result["extra"] = metadata
    return {"result": result}


__all__ = ["check", "create", "data_cookies", "hash33", "normalize_cookies", "parse_ptui_cb"]
