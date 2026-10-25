import React, { useEffect, useState } from 'react';
import { useQuery } from 'react-query';
import { AlertTriangle, X } from 'lucide-react';
import { getCookieStatus } from '../services/musicdl';
import { useAuth } from '../contexts/AuthContext';
import { cn } from '../ui/cn';

// 全局「凭证即将过期/已过期」提示条。
//
// 需求背景(用户反馈):「凭证过期之后能不能显示一下」。
// 现状问题是凭证失效后**没有任何提示**,只是音质从无损悄悄退回 128k,
// 用户不知道为什么变差,也就想不到要重新登录。
//
// 只在两种情况出现,其余一律不打扰:
//   · expired       已过期 —— 红色,直接说清后果与怎么修
//   · expiring_soon 剩余 <= 24h —— 黄色,提醒提前重登
//
// 可以手动关闭,但只在**本次会话**内记住:下一个页面周期(刷新/重开)
// 若仍过期会再次提示 —— 否则用户关掉一次就永久看不到了,又回到原问题。

const DISMISS_KEY = 'melodex_credential_notice_dismissed';

const SOURCE_NAMES = {
  netease: '网易云音乐',
  qq: 'QQ 音乐',
  qq_wx: 'QQ 音乐',
  kugou: '酷狗音乐',
  kuwo: '酷我音乐',
  migu: '咪咕音乐',
  bilibili: 'Bilibili',
  soda: '汽水音乐',
};

const sourceNameOf = (source) => SOURCE_NAMES[source] || source;

export default function CredentialNotice() {
  const { authenticated, offline } = useAuth();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return window.sessionStorage.getItem(DISMISS_KEY) === '1';
    } catch { /* silent-ok: 隐私模式下 sessionStorage 不可用,按"未关闭"处理即可 */}
  });

  const { data } = useQuery(['cookie-status'], getCookieStatus, {
    enabled: authenticated && !offline,
    refetchOnWindowFocus: false,
    // 凭证状态不需要频繁问:过期判断来自 cookie 自带时间戳,离线可算。
    staleTime: 10 * 60 * 1000,
  });

  const details = data?.details || {};
  const expired = [];
  const expiringSoon = [];
  for (const [source, detail] of Object.entries(details)) {
    if (!detail || detail.state === 'missing') continue;
    if (detail.state === 'expired') expired.push(source);
    else if (detail.state === 'expiring_soon') expiringSoon.push(source);
  }

  // 出现过期的源集合变化时,允许再次提示 —— 否则用户关掉一次后,
  // 即使之后又有别的源过期,也永远看不到(等于回到"静默失效"的老问题)。
  const expiredKey = expired.slice().sort().join(',');
  const lastExpiredKeyRef = React.useRef(expiredKey);
  useEffect(() => {
    if (lastExpiredKeyRef.current === expiredKey) return;
    lastExpiredKeyRef.current = expiredKey;
    if (!expiredKey) return; // 变成"没有过期项"时不需要弹
    setDismissed(false);
    try {
      window.sessionStorage.removeItem(DISMISS_KEY);
    } catch {
      /* silent-ok: sessionStorage 不可用时关闭标记本就存不下来,无需清理 */
    }
  }, [expiredKey]);

  if (dismissed) return null;

  if (expired.length === 0 && expiringSoon.length === 0) return null;

  const isError = expired.length > 0;
  const targets = (isError ? expired : expiringSoon).map(sourceNameOf).join('、');

  const text = isError
    ? `${targets} 的登录凭证已过期，会员/无损音质已不可用。到「设置」重新扫码或粘贴新 Cookie 即可恢复。`
    : `${targets} 的登录凭证即将过期（不足 24 小时），建议提前重新登录以保证无损可用。`;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex items-start gap-2 border-b px-4 py-2 type-caption md:px-6',
        isError
          ? 'border-destructive/40 bg-destructive/12 text-foreground'
          : 'border-yellow-500/35 bg-yellow-500/10 text-foreground',
      )}
    >
      <AlertTriangle
        size={16}
        className={cn('mt-0.5 flex-shrink-0', isError ? 'text-destructive' : 'text-yellow-400')}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-grow">{text}</span>
      <button
        type="button"
        onClick={() => {
          setDismissed(true);
          try {
            window.sessionStorage.setItem(DISMISS_KEY, '1');
          } catch {
            /* silent-ok: 隐私模式无法持久化关闭标记,提示会在下次渲染再出现,可接受 */
          }
        }}
        className="-mr-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-base hover:bg-secondary hover:text-foreground"
        aria-label="关闭凭证提示"
      >
        <X size={14} />
      </button>
    </div>
  );
}
