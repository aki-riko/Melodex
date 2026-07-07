import React, { useState, useEffect, useRef } from 'react';
import { useQuery } from 'react-query';
import { QRCodeCanvas } from 'qrcode.react';
import { AlertTriangle, CheckCircle2, ExternalLink, KeyRound, LogOut, QrCode, RefreshCw, X } from 'lucide-react';
import {
  getQRSources,
  createQRLogin,
  checkQRLogin,
  getCookieStatus,
  clearCookie,
  setCookie,
  getLocalMusic,
  deleteLocalMusic,
} from '../services/musicdl';
import { useAuth } from '../contexts/AuthContext';
import { sourceLabel } from '../utils/sourceLabels';
import LoadingState from './LoadingState';

const SOURCE_NOTES = {
  qq_mobile: '客户端入口尝试换取 QQ 音乐强凭证;如果一直失败,请使用 QQ音乐 默认入口或手填完整 Cookie。',
  qq_wx: '微信入口共用 QQ 音乐凭证;登录成功后会更新 QQ 音乐 Cookie。退出或手填 Cookie 请使用 QQ音乐卡片。',
};

// 各源手填 Cookie 的获取指引:网址 + 关键字段
const COOKIE_HELP = {
  netease: { url: 'https://music.163.com', key: 'MUSIC_U' },
  qq: { url: 'https://y.qq.com', key: 'qm_keyst' },
  qq_mobile: { url: 'https://y.qq.com', key: 'qm_keyst' },
  qq_connect: { url: 'https://y.qq.com', key: 'qm_keyst' },
  qq_wx: { url: 'https://y.qq.com', key: 'qm_keyst' },
  kugou: { url: 'https://www.kugou.com', key: 'kg_mid / token' },
  kuwo: { url: 'https://www.kuwo.cn', key: 'kw_token' },
  migu: { url: 'https://music.migu.cn', key: 'migu / passport' },
  bilibili: { url: 'https://www.bilibili.com', key: 'SESSDATA' },
  soda: { url: 'https://www.qishui.com', key: 'sessionid / passport' },
};

const STATUS_TEXT = {
  waiting: '等待扫码…',
  scanned: '已扫码,请在手机上确认',
  success: '登录成功 ✓',
  expired: '二维码已过期,请重试',
  failed: '登录失败,请重试',
};

const qrLoginNote = (source, result) => {
  if (!result || result.status !== 'success') return '';
  const extra = result.extra || {};
  if (source === 'qq' || source === 'qq_mobile' || source === 'qq_connect') {
    if (extra.credential_source === 'qq_connect_login' || extra.credential_source === 'qq_mobile_qr') {
      return '已换取 QQ 音乐强凭证,可用于 VIP/无损链路。';
    }
    if (extra.strong_login_error) {
      return `扫码成功,但强凭证换取失败:${extra.strong_login_error}`;
    }
    if (extra.credential_source === 'redirect_cookie') {
      return '扫码成功,但强凭证换取失败;这类 Cookie 可能只能拿普通音质。';
    }
  }
  if (source === 'qq_wx') {
    return '已保存 QQ 音乐微信登录凭证;能否拿无损以账号权限和 Cookie 实测为准。';
  }
  if (source === 'netease') {
    if (extra.credential_source === 'netease_qr_music_u') {
      return '已换取网易云 MUSIC_U 强凭证,可用于会员/无损链路。';
    }
    if (extra.strong_login_error) {
      return `扫码成功,但网易云强凭证确认失败:${extra.strong_login_error}`;
    }
  }
  return '';
};

const qrExtraFlag = (extra, key) => {
  const value = String((extra || {})[key] || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
};

const platformHint = (source, loggedIn, qrSupported) => {
  if (SOURCE_NOTES[source]) return SOURCE_NOTES[source];
  if (!qrSupported) return '该平台暂不支持扫码,请粘贴网页版 Cookie。';
  if (loggedIn) return '凭证已保存,会员链路会在验活与下载时自动使用。';
  return '优先扫码登录;需要无损时可改用完整 Cookie。';
};

const isQQCookieAlias = (source) => source === 'qq_wx' || source === 'qq_mobile' || source === 'qq_connect';

const cookieDetailFor = (details, source) => details?.[source] || (isQQCookieAlias(source) ? details?.qq : null) || {};

const loggedInFor = (status, source) => !!(status?.[source] || (isQQCookieAlias(source) && status?.qq));

const missingQQStrongCredential = (source, detail) => (
  (source === 'qq' || isQQCookieAlias(source)) && detail?.saved && detail?.hints?.has_music_key === false
);

const credentialHint = (source, loggedIn, qrSupported, detail) => {
  if (!loggedIn) return platformHint(source, loggedIn, qrSupported);
  if (detail?.error) return `已保存,但真实状态探测失败:${detail.error}`;
  if (missingQQStrongCredential(source, detail)) {
    return '已保存,但缺 QQ 音乐强凭证(qm_keyst/qqmusic_key),VIP/无损可能失效。';
  }
  if (detail?.vip_checked && detail.vip) return '真实探测:VIP 链路有效。';
  if (detail?.vip_checked && !detail.vip) return '真实探测:会员链路不可用。平台 Cookie 是会过期的会话凭证,失效后只能重新扫码或手填新的 Cookie。';
  return platformHint(source, loggedIn, qrSupported);
};

const credentialBadge = (loggedIn, detail) => {
  if (!loggedIn) {
    return {
      text: '未登录',
      className: 'border-border bg-secondary text-muted-foreground',
      icon: null,
    };
  }
  if (detail?.error || (detail?.vip_checked && !detail.vip)) {
    return {
      text: detail?.error ? '已保存' : '凭证失效',
      className: 'border-yellow-500/35 bg-yellow-500/10 text-yellow-300',
      icon: <AlertTriangle size={12} />,
    };
  }
  if (detail?.vip_checked && detail.vip) {
    return {
      text: 'VIP有效',
      className: 'border-primary/35 bg-primary/15 text-primary',
      icon: <CheckCircle2 size={12} />,
    };
  }
  return {
    text: '已保存',
    className: 'border-primary/35 bg-primary/15 text-primary',
    icon: <CheckCircle2 size={12} />,
  };
};

const actionGridClass = (count) => (
  count >= 3 ? 'grid-cols-3' : count === 2 ? 'grid-cols-2' : 'grid-cols-1'
);

// 二维码登录卡片
const QRLoginCard = ({ source, loggedIn, detail, onLoggedIn, onLogout, onRefreshStatus, checkingStatus = false, qrSupported = true }) => {
  const manualSupported = source !== 'qq_wx';
  const badge = credentialBadge(loggedIn, detail);
  const [session, setSession] = useState(null);
  const [status, setStatus] = useState('');
  const [statusNote, setStatusNote] = useState('');
  const [sodaSMS, setSodaSMS] = useState(null);
  const [sodaSMSCode, setSodaSMSCode] = useState('');
  const [sodaSMSBusy, setSodaSMSBusy] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [manualCookie, setManualCookie] = useState('');
  const [manualMsg, setManualMsg] = useState('');
  const pollRef = useRef(null);
  const loginBusyRef = useRef(false);
  const loginRunRef = useRef(0);

  const submitManual = async () => {
    if (!manualCookie.trim()) return;
    setManualMsg('保存中…');
    try {
      await setCookie(source, manualCookie.trim());
      setManualMsg('已保存 ✓');
      setManualCookie('');
      onLoggedIn();
      setTimeout(() => { setShowManual(false); setManualMsg(''); }, 700);
    } catch (e) {
      setManualMsg(e?.name === 'AuthRequiredError' ? '需先登录管理员' : '保存失败');
    }
  };

  const stopPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const closeQRSession = () => {
    loginRunRef.current += 1;
    loginBusyRef.current = false;
    stopPoll();
    setLoginBusy(false);
    setSession(null);
    setStatus('');
    setStatusNote('');
    setSodaSMS(null);
    setSodaSMSCode('');
  };

  useEffect(() => () => {
    loginRunRef.current += 1;
    loginBusyRef.current = false;
    stopPoll();
  }, []);

  const rememberSodaSMS = (result) => {
    const extra = result?.extra || {};
    if (source !== 'soda' || !qrExtraFlag(extra, 'need_sms')) return false;
    setSodaSMS({
      encryptUID: String(extra.encrypt_uid || '').trim(),
      verifyParams: String(extra.verify_params || '').trim(),
      mobile: String(extra.mobile || '').trim(),
      codeSent: qrExtraFlag(extra, 'need_sms_code'),
      mode: qrExtraFlag(extra, 'need_user_sms') || String(extra.sms_mode || '').toLowerCase() === 'up' ? 'up' : '',
      upSMSMobile: String(extra.up_sms_mobile || '').trim(),
      upSMSContent: String(extra.up_sms_content || '').trim(),
    });
    return true;
  };

  const sodaActionKey = (action, code = '') => {
    if (!session?.key || !sodaSMS?.encryptUID || !sodaSMS?.verifyParams) return '';
    const parts = [session.key, action, sodaSMS.encryptUID, sodaSMS.verifyParams];
    if (action === 'validate') parts.push(code);
    return parts.join('|');
  };

  const handleSodaSMSResult = (result) => {
    setStatus(result.status);
    setStatusNote(result.message || qrLoginNote(source, result));
    rememberSodaSMS(result);
    if (result.status === 'success') {
      setSodaSMS(null);
      setSodaSMSCode('');
      onLoggedIn();
    }
  };

  const sendSodaSMS = async () => {
    const key = sodaActionKey(sodaSMS?.mode === 'up' ? 'up_sms' : 'send_code');
    if (!key) {
      setStatusNote('缺少短信验证参数，请刷新二维码重试');
      return;
    }
    setSodaSMSBusy(true);
    try {
      handleSodaSMSResult(await checkQRLogin(source, key));
    } catch (e) {
      setStatusNote(e?.message || '短信验证请求失败');
    } finally {
      setSodaSMSBusy(false);
    }
  };

  const validateSodaSMS = async () => {
    const code = sodaSMSCode.trim();
    if (!code) {
      setStatusNote('请输入验证码');
      return;
    }
    const key = sodaActionKey('validate', code);
    if (!key) {
      setStatusNote('缺少短信验证参数，请刷新二维码重试');
      return;
    }
    setSodaSMSBusy(true);
    try {
      handleSodaSMSResult(await checkQRLogin(source, key));
    } catch (e) {
      setStatusNote(e?.message || '验证码验证失败');
    } finally {
      setSodaSMSBusy(false);
    }
  };

  const startLogin = async () => {
    if (!qrSupported || loginBusyRef.current) return;
    const runID = loginRunRef.current + 1;
    loginRunRef.current = runID;
    loginBusyRef.current = true;
    stopPoll();
    setLoginBusy(true);
    setStatus('');
    setStatusNote('');
    setSodaSMS(null);
    setSodaSMSCode('');
    try {
      const s = await createQRLogin(source);
      if (loginRunRef.current !== runID) return;
      setSession(s);
      setStatus('waiting');
      const timer = setInterval(async () => {
        if (loginRunRef.current !== runID) {
          clearInterval(timer);
          return;
        }
        try {
          const r = await checkQRLogin(source, s.key);
          if (loginRunRef.current !== runID) return;
          setStatus(r.status);
          setStatusNote(qrLoginNote(source, r) || r.message || '');
          if (r.status === 'success') {
            stopPoll();
            onLoggedIn();
          } else if (rememberSodaSMS(r)) {
            stopPoll();
          } else if (r.status === 'expired' || r.status === 'failed') {
            stopPoll();
          }
        } catch (e) {
          if (loginRunRef.current !== runID) return;
          setStatusNote(e?.message || '登录状态检查失败,稍后会自动重试');
        }
      }, 2000);
      pollRef.current = timer;
    } catch (e) {
      if (loginRunRef.current !== runID) return;
      setStatus('failed');
      setStatusNote(e?.message || '二维码创建失败');
    } finally {
      if (loginRunRef.current === runID) {
        loginBusyRef.current = false;
        setLoginBusy(false);
      }
    }
  };

  const actionCount = (qrSupported ? 1 : 0)
    + (manualSupported ? 1 : 0)
    + (loggedIn && source !== 'qq_wx' ? 1 : 0);

  return (
    <>
      <div className="flex h-full min-h-[108px] flex-col rounded-md border border-border bg-card p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{sourceLabel(source)}</p>
            <p className="mt-1 truncate text-[11px] leading-4 text-muted-foreground" title={credentialHint(source, loggedIn, qrSupported, detail)}>
              {qrSupported ? '扫码' : '手填'}{manualSupported && qrSupported ? ' / 手填' : ''}
            </p>
          </div>
          <div className="flex flex-shrink-0 items-center gap-1">
            <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${badge.className}`}>
              {badge.icon}
              {badge.text}
            </span>
            {loggedIn && (
              <button
                type="button"
                onClick={onRefreshStatus}
                disabled={checkingStatus}
                className="flex h-6 w-6 items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
                title="重新检查登录状态"
                aria-label={`重新检查 ${sourceLabel(source)} 登录状态`}
              >
                <RefreshCw size={13} className={checkingStatus ? 'animate-spin' : ''} />
              </button>
            )}
          </div>
        </div>

        <div className={`mt-auto grid gap-1.5 pt-3 ${actionGridClass(actionCount)}`}>
          {qrSupported && (
            <button
              onClick={startLogin}
              disabled={loginBusy}
              className="flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md border border-primary bg-primary px-2 text-xs font-semibold text-primary-foreground transition-colors hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
              title={`${sourceLabel(source)}扫码登录`}
            >
              <QrCode size={14} />
              <span className="truncate">{loginBusy ? '生成中' : session ? '刷新' : '扫码'}</span>
            </button>
          )}
          {manualSupported && (
            <button
              onClick={() => setShowManual(true)}
              className="flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md border border-border bg-secondary px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="扫码拿不到无损时,可手动粘贴完整 Cookie"
            >
              <KeyRound size={14} />
              <span className="truncate">手填</span>
            </button>
          )}
          {loggedIn && source !== 'qq_wx' && (
            <button
              onClick={() => onLogout(source)}
              className="flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-md border border-border bg-secondary px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={`退出 ${sourceLabel(source)} 登录`}
            >
              <LogOut size={14} />
              <span className="truncate">退出</span>
            </button>
          )}
        </div>
      </div>

      {session && (
        <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/60 p-4" onClick={closeQRSession}>
          <div className="w-full max-w-sm rounded-lg border border-border bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="min-w-0">
                <p className="font-semibold">{sourceLabel(source)} 扫码登录</p>
                <p className="text-xs text-muted-foreground">{STATUS_TEXT[status] || status || '正在生成二维码...'}</p>
              </div>
              <button onClick={closeQRSession} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="关闭二维码">
                <X size={20} />
              </button>
            </div>
            <div className="p-4">
              {(session.image_url || session.url) && status !== 'success' && (
                <div className="flex flex-col items-center">
                  <div className="rounded-md border border-border bg-white p-2">
                    {session.image_url ? (
                      <img src={session.image_url} alt="登录二维码" width={192} height={192} />
                    ) : (
                      <QRCodeCanvas value={session.url} size={192} />
                    )}
                  </div>
                </div>
              )}

              {statusNote && (
                <p className="mt-3 rounded-md bg-secondary p-3 text-xs leading-relaxed text-muted-foreground">{statusNote}</p>
              )}

              {sodaSMS && (
                <div className="mt-3 rounded-md bg-secondary p-3 text-xs leading-relaxed text-muted-foreground">
                  {sodaSMS.mode === 'up' ? (
                    <>
                      <p>请按汽水要求发送短信。</p>
                      <p>收件号码: <span className="text-foreground">{sodaSMS.upSMSMobile || '按手机提示'}</span></p>
                      <p>短信内容: <span className="text-foreground">{sodaSMS.upSMSContent || '按手机提示'}</span></p>
                      <button
                        onClick={sendSodaSMS}
                        disabled={sodaSMSBusy}
                        className="mt-3 rounded-md border border-primary bg-primary px-3 py-1.5 font-medium text-primary-foreground disabled:opacity-50"
                      >
                        {sodaSMSBusy ? '确认中...' : '我已发送'}
                      </button>
                    </>
                  ) : (
                    <>
                      <p>{sodaSMS.codeSent ? `验证码已发送${sodaSMS.mobile ? `至 ${sodaSMS.mobile}` : ''}` : `扫码成功${sodaSMS.mobile ? `,可发送验证码至 ${sodaSMS.mobile}` : ',需要短信验证'}`}</p>
                      {!sodaSMS.codeSent && (
                        <button
                          onClick={sendSodaSMS}
                          disabled={sodaSMSBusy}
                          className="mt-3 rounded-md border border-primary bg-primary px-3 py-1.5 font-medium text-primary-foreground disabled:opacity-50"
                        >
                          {sodaSMSBusy ? '发送中...' : '发送验证码'}
                        </button>
                      )}
                      {sodaSMS.codeSent && (
                        <div className="mt-3 flex items-center gap-2">
                          <input
                            value={sodaSMSCode}
                            onChange={(e) => setSodaSMSCode(e.target.value)}
                            placeholder="验证码"
                            className="min-w-0 flex-grow rounded-md border border-border bg-card px-3 py-2 text-xs outline-none focus:border-primary"
                          />
                          <button
                            onClick={validateSodaSMS}
                            disabled={sodaSMSBusy}
                            className="rounded-md border border-primary bg-primary px-3 py-2 font-medium text-primary-foreground disabled:opacity-50"
                          >
                            {sodaSMSBusy ? '验证中...' : '确认'}
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              <div className="mt-4 flex gap-2">
                <button
                  onClick={startLogin}
                  disabled={loginBusy}
                  className="flex h-10 flex-1 items-center justify-center gap-2 rounded-md border border-primary bg-primary px-3 text-sm font-semibold text-primary-foreground transition-colors hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <QrCode size={17} />
                  {loginBusy ? '生成中' : '刷新二维码'}
                </button>
                <button
                  onClick={closeQRSession}
                  className="h-10 rounded-md border border-border bg-secondary px-4 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  关闭
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showManual && manualSupported && (
        <div className="fixed inset-0 z-[76] flex items-center justify-center bg-black/60 p-4" onClick={() => setShowManual(false)}>
          <div className="flex max-h-[86vh] w-full max-w-lg flex-col rounded-lg border border-border bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="min-w-0">
                <p className="font-semibold">手动填写 Cookie</p>
                <p className="text-xs text-muted-foreground">{sourceLabel(source)}</p>
              </div>
              <button onClick={() => setShowManual(false)} className="text-muted-foreground transition-colors hover:text-foreground" aria-label="关闭手动填写 Cookie">
                <X size={20} />
              </button>
            </div>
            <div className="overflow-y-auto p-4 app-scroll">
              {COOKIE_HELP[source] && (
                <div className="mb-3 rounded-md bg-secondary p-3 text-xs leading-relaxed text-muted-foreground">
                  <p className="mb-2 font-medium text-foreground">获取方式</p>
                  <p>1. 浏览器打开 <a href={COOKIE_HELP[source].url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary underline">{COOKIE_HELP[source].url}<ExternalLink size={12} /></a> 并登录会员账号</p>
                  <p>2. 按 F12 打开开发者工具,进入「网络/Network」</p>
                  <p>3. 刷新页面,点任一请求,在「标头/Headers」里找到 <code className="rounded bg-card px-1">Cookie:</code></p>
                  <p>4. 复制整段 Cookie 值,确认包含 <code className="rounded bg-card px-1">{COOKIE_HELP[source].key}</code></p>
                  <p>5. Cookie 是会过期的会话凭证,失效后需要重新扫码或重新粘贴新的 Cookie。</p>
                </div>
              )}
              <textarea
                value={manualCookie}
                onChange={(e) => setManualCookie(e.target.value)}
                placeholder={`粘贴 ${sourceLabel(source)} 网页版登录后的完整 Cookie...`}
                rows={5}
                className="w-full resize-none rounded-md border border-border bg-secondary px-3 py-2 text-sm outline-none focus:border-primary"
              />
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={submitManual}
                  disabled={!manualCookie.trim()}
                  className="flex h-10 items-center justify-center gap-2 rounded-md border border-primary bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <KeyRound size={17} />
                  保存 Cookie
                </button>
                {manualMsg && <span className="text-xs text-muted-foreground">{manualMsg}</span>}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

const Settings = () => {
  const { isAdmin } = useAuth();
  const qrSources = useQuery(['qr-sources'], getQRSources, { enabled: isAdmin });
  const cookieStatus = useQuery(['cookie-status'], getCookieStatus, {
    enabled: isAdmin,
    retry: (count, err) => err?.name !== 'AuthRequiredError' && count < 2,
  });
  const localMusic = useQuery(['local-music'], () => getLocalMusic({ limit: 200 }));

  const handleLoggedIn = () => {
    cookieStatus.refetch();
  };

  const handleRefreshCookieStatus = () => {
    cookieStatus.refetch();
  };

  const handleLogout = async (source) => {
    await clearCookie(source);
    cookieStatus.refetch();
  };

  const handleDeleteLocal = async (id) => {
    await deleteLocalMusic(id);
    localMusic.refetch();
  };

  const sources = qrSources.data || [];
  const cookieData = cookieStatus.data || {};
  const status = cookieData.loggedIn || {};
  const details = cookieData.details || {};
  const tracks = localMusic.data?.tracks || [];

  return (
    <div className="max-w-5xl mx-auto pb-32">
      <h2 className="text-3xl font-semibold mb-2 text-foreground">设置 · Settings</h2>
      <p className="text-muted-foreground mb-6 mt-3">
        {isAdmin
          ? '扫码登录各平台以解锁会员/无损音质(全局共享),管理你的本地音乐。'
          : '管理你的本地音乐。平台会员登录由管理员统一配置。'}
      </p>

      {isAdmin && (
        <section className="mb-8">
          <h3 className="text-lg font-semibold mb-2">账号登录</h3>
          <p className="text-xs text-muted-foreground mb-3">
            平台会员 Cookie 为全局共享(所有用户共用同一会员链路),仅管理员可配置。
          </p>
          <div className="grid grid-cols-1 items-stretch gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
            {sources.map((entry) => {
              const src = typeof entry === 'string' ? entry : entry.source;
              const qrSupported = typeof entry === 'string' ? true : !!entry.qr;
              return (
                <QRLoginCard
                  key={src}
                  source={src}
                  loggedIn={loggedInFor(status, src)}
                  detail={cookieDetailFor(details, src)}
                  onLoggedIn={handleLoggedIn}
                  onLogout={handleLogout}
                  onRefreshStatus={handleRefreshCookieStatus}
                  checkingStatus={cookieStatus.isFetching}
                  qrSupported={qrSupported}
                />
              );
            })}
          </div>
        </section>
      )}

      <section>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-semibold">本地音乐库</h3>
          <button
            onClick={() => localMusic.refetch()}
            className="px-3 py-1.5 border border-border rounded-md bg-card font-medium text-sm transition-colors hover:bg-secondary"
          >
            刷新
          </button>
        </div>
        <p className="text-muted-foreground text-sm mb-3">
          下载目录:{localMusic.data?.download_dir || '—'}
          {localMusic.data && !localMusic.data.exists && '(目录不存在)'}
        </p>
        {localMusic.isLoading && (
          <LoadingState
            title="加载本地音乐库"
            detail="正在读取服务器下载目录和曲目摘要"
            rows={4}
            className="mb-4"
          />
        )}
        {tracks.length === 0 && !localMusic.isLoading && (
          <p className="text-muted-foreground">本地音乐库为空。在下载页下载歌曲后会出现在这里。</p>
        )}
        {!localMusic.isLoading && <div className="space-y-2">
          {tracks.map((t) => (
            <div key={t.id} className="flex items-center gap-3 p-3 border border-border rounded-md bg-card">
              <div className="flex-grow min-w-0">
                <p className="font-semibold truncate">{t.name}</p>
                <p className="text-sm text-muted-foreground truncate">{t.artist}{t.album ? ` · ${t.album}` : ''}</p>
              </div>
              <button
                onClick={() => handleDeleteLocal(t.id)}
                className="px-3 py-1.5 border border-border rounded-md bg-destructive text-destructive-foreground font-semibold text-sm transition-colors hover:brightness-[0.97]"
              >
                删除
              </button>
            </div>
          ))}
        </div>}
      </section>
    </div>
  );
};

export default Settings;
