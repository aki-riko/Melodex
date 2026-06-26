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
  adminSetupUrl,
  adminLoginUrl,
} from '../services/musicdl';

const SOURCE_LABELS = {
  netease: '网易云音乐',
  qq: 'QQ音乐',
  qq_wx: 'QQ音乐(微信)',
  kugou: '酷狗音乐',
  bilibili: '哔哩哔哩',
};

const STATUS_TEXT = {
  waiting: '等待扫码…',
  scanned: '已扫码,请在手机上确认',
  success: '登录成功 ✓',
  expired: '二维码已过期,请重试',
  failed: '登录失败,请重试',
};

// 二维码登录卡片
const QRLoginCard = ({ source, loggedIn, onLoggedIn }) => {
  const [session, setSession] = useState(null);
  const [status, setStatus] = useState('');
  const [showManual, setShowManual] = useState(false);
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

  const startLogin = async () => {
    stopPoll();
    setStatus('');
    try {
      const s = await createQRLogin(source);
      setSession(s);
      setStatus('waiting');
      pollRef.current = setInterval(async () => {
        try {
          const r = await checkQRLogin(source, s.key);
          setStatus(r.status);
          if (r.status === 'success') {
            stopPoll();
            onLoggedIn();
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
        <span className="font-semibold">{SOURCE_LABELS[source] || source}</span>
        {loggedIn ? (
          <span className="text-xs font-medium px-2 py-0.5 border border-border rounded-md bg-success text-success-foreground">已登录</span>
        ) : (
          <span className="text-xs font-medium px-2 py-0.5 border border-border rounded-md bg-muted text-muted-foreground">未登录</span>
        )}
      </div>
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
      <button
        onClick={startLogin}
        className="w-full px-3 py-2 border border-border rounded-md bg-primary text-primary-foreground font-semibold text-sm shadow-brutal-sm transition-colors hover:bg-[#106EBE]"
      >
        {session ? '刷新二维码' : '扫码登录'}
      </button>
      <button
        onClick={() => setShowManual((v) => !v)}
        className="w-full mt-2 text-xs text-muted-foreground hover:text-primary transition-colors"
        title="扫码拿不到无损时,可手动粘贴完整 cookie"
      >
        {showManual ? '收起' : '手动填 Cookie(拿无损用)'}
      </button>
      {showManual && (
        <div className="mt-2">
          <textarea
            value={manualCookie}
            onChange={(e) => setManualCookie(e.target.value)}
            placeholder="粘贴该平台网页版登录后的完整 Cookie(QQ 音乐需含 qm_keyst)…"
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
  const qrSources = useQuery(['qr-sources'], getQRSources);
  const cookieStatus = useQuery(['cookie-status'], getCookieStatus, {
    retry: (count, err) => err?.name !== 'AuthRequiredError' && count < 2,
  });
  const localMusic = useQuery(['local-music'], () => getLocalMusic({ limit: 200 }));

  const authErr = cookieStatus.error?.name === 'AuthRequiredError' ? cookieStatus.error : null;

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
      <p className="text-muted-foreground mb-6 mt-3">扫码登录各平台以解锁会员/无损音质,管理已下载的本地音乐。</p>

      {authErr && (
        <div className="mb-6 p-4 border border-border rounded-lg bg-destructive/10 shadow-brutal-sm">
          <p className="font-semibold mb-1">需要管理员身份</p>
          <p className="text-sm mb-2">
            扫码登录与 Cookie 管理属于敏感操作,后端已要求管理员鉴权。请先
            {authErr.setupRequired ? '初始化管理员账号' : '登录'}后再使用本页功能。
          </p>
          <a
            href={authErr.setupRequired ? adminSetupUrl : adminLoginUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-block px-3 py-1.5 border border-border rounded-md bg-destructive text-destructive-foreground font-semibold text-sm shadow-brutal-sm transition-colors hover:brightness-[0.97]"
          >
            前往{authErr.setupRequired ? '初始化' : '登录'}页 ↗
          </a>
        </div>
      )}

      <section className="mb-10">
        <h3 className="text-xl font-semibold mb-4">账号登录</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
          {sources.map((src) => (
            <div key={src}>
              <QRLoginCard source={src} loggedIn={!!status[src]} onLoggedIn={handleLoggedIn} />
              {status[src] && (
                <button
                  onClick={() => handleLogout(src)}
                  className="w-full mt-2 px-3 py-1.5 border border-border rounded-md bg-card font-medium text-sm shadow-brutal-sm transition-colors hover:bg-secondary"
                >
                  退出登录
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

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

