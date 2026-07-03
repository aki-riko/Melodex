import React, { useState, useEffect, useRef } from 'react';
import { useQuery } from 'react-query';
import { QRCodeCanvas } from 'qrcode.react';
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

const SOURCE_NOTES = {
  qq_wx: '微信入口共用 QQ 音乐凭证;登录成功后会更新 QQ 音乐 Cookie。退出或手填 Cookie 请使用 QQ音乐卡片。',
};

// 各源手填 Cookie 的获取指引:网址 + 关键字段
const COOKIE_HELP = {
  netease: { url: 'https://music.163.com', key: 'MUSIC_U' },
  qq: { url: 'https://y.qq.com', key: 'qm_keyst' },
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
  if (source === 'qq') {
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

// 二维码登录卡片
const QRLoginCard = ({ source, loggedIn, onLoggedIn, qrSupported = true }) => {
  const manualSupported = source !== 'qq_wx';
  const [session, setSession] = useState(null);
  const [status, setStatus] = useState('');
  const [statusNote, setStatusNote] = useState('');
  const [sodaSMS, setSodaSMS] = useState(null);
  const [sodaSMSCode, setSodaSMSCode] = useState('');
  const [sodaSMSBusy, setSodaSMSBusy] = useState(false);
  const [showManual, setShowManual] = useState(!qrSupported && manualSupported);
  const [manualCookie, setManualCookie] = useState('');
  const [manualMsg, setManualMsg] = useState('');
  const pollRef = useRef(null);

  const submitManual = async () => {
    if (!manualCookie.trim()) return;
    setManualMsg('保存中…');
    try {
      await setCookie(source, manualCookie.trim());
      setManualMsg('已保存 ✓');
      setManualCookie('');
      onLoggedIn();
      setTimeout(() => { setShowManual(false); setManualMsg(''); }, 1200);
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

  useEffect(() => () => stopPoll(), []);

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
    if (!qrSupported) return;
    stopPoll();
    setStatus('');
    setStatusNote('');
    setSodaSMS(null);
    setSodaSMSCode('');
    try {
      const s = await createQRLogin(source);
      setSession(s);
      setStatus('waiting');
      pollRef.current = setInterval(async () => {
        try {
          const r = await checkQRLogin(source, s.key);
          setStatus(r.status);
          setStatusNote(qrLoginNote(source, r));
          if (r.status === 'success') {
            stopPoll();
            onLoggedIn();
          } else if (rememberSodaSMS(r)) {
            stopPoll();
          } else if (r.status === 'expired' || r.status === 'failed') {
            stopPoll();
          }
        } catch (e) {
          /* 轮询失败忽略,继续下一次 */
        }
      }, 2000);
    } catch (e) {
      setStatus('failed');
    }
  };

  return (
    <div className="bg-card border border-border rounded-lg shadow-brutal-sm p-4">
      <div className="flex justify-between items-center mb-3">
        <span className="font-semibold">{sourceLabel(source)}</span>
        {loggedIn ? (
          <span className="text-xs font-medium px-2 py-0.5 border border-border rounded-md bg-success text-success-foreground">已登录</span>
        ) : (
          <span className="text-xs font-medium px-2 py-0.5 border border-border rounded-md bg-muted text-muted-foreground">未登录</span>
        )}
      </div>
      {SOURCE_NOTES[source] && (
        <p className="text-xs leading-relaxed text-muted-foreground bg-muted rounded-md p-2 mb-3">{SOURCE_NOTES[source]}</p>
      )}
      {session && (session.image_url || session.url) && status !== 'success' && (
        <div className="flex flex-col items-center mb-3">
          <div className="bg-white border border-border rounded-md p-2">
            {session.image_url ? (
              /* QQ 等源直接返回画好的二维码图(base64 PNG) */
              <img src={session.image_url} alt="登录二维码" width={180} height={180} />
            ) : (
              /* 网易云等源返回二维码内容文本,前端自己画 */
              <QRCodeCanvas value={session.url} size={180} />
            )}
          </div>
          <p className="text-sm font-medium text-muted-foreground mt-2">{STATUS_TEXT[status] || status}</p>
        </div>
      )}
      {statusNote && (
        <p className="text-xs leading-relaxed text-muted-foreground bg-muted rounded-md p-2 mb-3">{statusNote}</p>
      )}
      {sodaSMS && (
        <div className="text-xs leading-relaxed text-muted-foreground bg-muted rounded-md p-2 mb-3">
          {sodaSMS.mode === 'up' ? (
            <>
              <p>请按汽水要求发送短信。</p>
              <p>收件号码: <span className="text-foreground">{sodaSMS.upSMSMobile || '按手机提示'}</span></p>
              <p>短信内容: <span className="text-foreground">{sodaSMS.upSMSContent || '按手机提示'}</span></p>
              <button
                onClick={sendSodaSMS}
                disabled={sodaSMSBusy}
                className="mt-2 px-3 py-1 border border-border rounded-md bg-primary text-primary-foreground font-medium disabled:opacity-50"
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
                  className="mt-2 px-3 py-1 border border-border rounded-md bg-primary text-primary-foreground font-medium disabled:opacity-50"
                >
                  {sodaSMSBusy ? '发送中...' : '发送验证码'}
                </button>
              )}
              {sodaSMS.codeSent && (
                <div className="mt-2 flex items-center gap-2">
                  <input
                    value={sodaSMSCode}
                    onChange={(e) => setSodaSMSCode(e.target.value)}
                    placeholder="验证码"
                    className="min-w-0 flex-grow px-2 py-1 border border-border rounded-md bg-card text-xs outline-none focus:border-primary"
                  />
                  <button
                    onClick={validateSodaSMS}
                    disabled={sodaSMSBusy}
                    className="px-3 py-1 border border-border rounded-md bg-primary text-primary-foreground font-medium disabled:opacity-50"
                  >
                    {sodaSMSBusy ? '验证中...' : '确认登录'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
      {qrSupported && (
        <button
          onClick={startLogin}
          className="w-full px-3 py-2 border border-border rounded-md bg-primary text-primary-foreground font-semibold text-sm shadow-brutal-sm transition-colors hover:bg-[#106EBE]"
        >
          {session ? '刷新二维码' : '扫码登录'}
        </button>
      )}
      {manualSupported && (
        <button
          onClick={() => setShowManual((v) => !v)}
          className={`${qrSupported ? 'mt-2' : ''} w-full text-xs text-muted-foreground hover:text-primary transition-colors`}
          title="扫码拿不到无损时,可手动粘贴完整 cookie"
        >
          {showManual ? (qrSupported ? '收起' : '收起 Cookie') : '手动填 Cookie(拿无损用)'}
        </button>
      )}
      {showManual && (
        <div className="mt-2">
          {COOKIE_HELP[source] && (
            <div className="text-xs text-muted-foreground mb-2 leading-relaxed bg-muted rounded-md p-2">
              <p className="font-medium text-foreground mb-1">如何获取 Cookie:</p>
              <p>1. 浏览器打开 <a href={COOKIE_HELP[source].url} target="_blank" rel="noreferrer" className="text-primary underline">{COOKIE_HELP[source].url}</a> 并登录(用会员账号)</p>
              <p>2. 按 F12 打开开发者工具 → 「网络/Network」标签</p>
              <p>3. 刷新页面,点任一请求 → 「标头/Headers」→ 找到请求头里的 <code className="bg-card px-1 rounded">Cookie:</code></p>
              <p>4. 复制整段 Cookie 值(需包含 <code className="bg-card px-1 rounded">{COOKIE_HELP[source].key}</code>)粘到下方</p>
            </div>
          )}
          <textarea
            value={manualCookie}
            onChange={(e) => setManualCookie(e.target.value)}
            placeholder={`粘贴 ${sourceLabel(source)} 网页版登录后的完整 Cookie…`}
            rows={3}
            className="w-full px-2 py-1.5 border border-border rounded-md bg-card text-xs outline-none focus:border-primary"
          />
          <div className="flex items-center gap-2 mt-1">
            <button
              onClick={submitManual}
              className="px-3 py-1 border border-border rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-[#106EBE] transition-colors"
            >
              保存
            </button>
            {manualMsg && <span className="text-xs text-muted-foreground">{manualMsg}</span>}
          </div>
        </div>
      )}
    </div>
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

  const handleLogout = async (source) => {
    await clearCookie(source);
    cookieStatus.refetch();
  };

  const handleDeleteLocal = async (id) => {
    await deleteLocalMusic(id);
    localMusic.refetch();
  };

  const sources = qrSources.data || [];
  const status = cookieStatus.data || {};
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
        <section className="mb-10">
          <h3 className="text-xl font-semibold mb-4">账号登录</h3>
          <p className="text-sm text-muted-foreground mb-4">
            平台会员 Cookie 为全局共享(所有用户共用同一会员链路),仅管理员可配置。
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            {sources.map((entry) => {
              const src = typeof entry === 'string' ? entry : entry.source;
              const qrSupported = typeof entry === 'string' ? true : !!entry.qr;
              return (
              <div key={src}>
                <QRLoginCard source={src} loggedIn={!!status[src]} onLoggedIn={handleLoggedIn} qrSupported={qrSupported} />
                {status[src] && src !== 'qq_wx' && (
                  <button
                    onClick={() => handleLogout(src)}
                    className="w-full mt-2 px-3 py-1.5 border border-border rounded-md bg-card font-medium text-sm shadow-brutal-sm transition-colors hover:bg-secondary"
                  >
                    退出登录
                  </button>
                )}
              </div>
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
            className="px-3 py-1.5 border border-border rounded-md bg-card font-medium text-sm shadow-brutal-sm transition-colors hover:bg-secondary"
          >
            刷新
          </button>
        </div>
        <p className="text-muted-foreground text-sm mb-3">
          下载目录:{localMusic.data?.download_dir || '—'}
          {localMusic.data && !localMusic.data.exists && '(目录不存在)'}
        </p>
        {localMusic.isLoading && <p className="text-muted-foreground font-medium">加载中…</p>}
        {tracks.length === 0 && !localMusic.isLoading && (
          <p className="text-muted-foreground">本地音乐库为空。在下载页下载歌曲后会出现在这里。</p>
        )}
        <div className="space-y-2">
          {tracks.map((t) => (
            <div key={t.id} className="flex items-center gap-3 p-3 border border-border rounded-md bg-card shadow-brutal-sm">
              <div className="flex-grow min-w-0">
                <p className="font-semibold truncate">{t.name}</p>
                <p className="text-sm text-muted-foreground truncate">{t.artist}{t.album ? ` · ${t.album}` : ''}</p>
              </div>
              <button
                onClick={() => handleDeleteLocal(t.id)}
                className="px-3 py-1.5 border border-border rounded-md bg-destructive text-destructive-foreground font-semibold text-sm shadow-brutal-sm transition-colors hover:brightness-[0.97]"
              >
                删除
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};

export default Settings;
