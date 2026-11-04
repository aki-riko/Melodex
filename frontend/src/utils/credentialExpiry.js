// 平台凭证「有效期 / 能否自动续期」的展示逻辑(纯函数,带 Node 契约测试)。
//
// 背景(用户反馈,2026-11):设置页 QQ 卡片显示「剩 23 小时 34 分」的黄条,
// 用户以为马上要掉线、要重新扫码。但实际上只要 cookie 里还有长期授权 token,
// Provider sidecar 会在下次搜索/播放时用它们自动换出新的 musickey
// (见 backend/provider_bridge/qq_source.py 的 refresh_musickey),用户什么都不用做。
//
// 所以界面上必须区分两种「快到期」:
//   · 能自动续期 → 是信息,不是警报。不要用红色/催促语气把用户赶去重新扫码。
//   · 不能续期   → 才是真的警报,到期后音质会悄悄变差,必须提示重新登录。
//
// 判断依据由后端给出(detail.auto_refreshable),前端**不自己猜**:
// 前端看不见 cookie 内容,任何本地推断都只会在猜错时误导用户。

// 把剩余秒数说成人话。过期显示负数时也给出"过期多久"。
export const formatRemaining = (seconds) => {
  const abs = Math.abs(Number(seconds) || 0);
  const days = Math.floor(abs / 86400);
  const hours = Math.floor((abs % 86400) / 3600);
  const mins = Math.floor((abs % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${mins} 分`;
  return `${Math.max(1, mins)} 分钟`;
};

// detail 可能来自旧后端(没有 auto_refreshable 字段),此时按"不能续期"处理 ——
// 宁可多提醒一次,也不要承诺一个后端实际做不到的自动续期。
export const isAutoRefreshable = (detail) => detail?.auto_refreshable === true;

// 徽章文案与配色。
// 配色语义:
//   expired       红色  —— 真的不可用了
//   expiring_soon 黄色  —— 需要人介入
//   ok+可续期     中性  —— 只是告知,不用管
export const expiryBadge = (detail) => {
  const state = detail?.state;
  const refreshable = isAutoRefreshable(detail);

  if (state === 'expired') {
    if (refreshable) {
      // 已经过期但能续:下一次搜索/播放会自动换回新 key,不需要用户重新扫码。
      // 用黄色而不是红色 —— 红色会让用户立刻跑去重扫,那是多余的。
      return {
        text: '已过期 · 待续期',
        className: 'border-yellow-500/35 bg-yellow-500/10 text-yellow-300',
        icon: 'alert',
      };
    }
    return {
      text: '已过期',
      className: 'border-destructive/40 bg-destructive/15 text-destructive-text',
      icon: 'alert',
    };
  }

  if (state === 'expiring_soon') {
    const remaining = formatRemaining(detail?.expires_in_seconds);
    if (refreshable) {
      return {
        text: `剩 ${remaining} · 自动续期`,
        className: 'border-sky-500/35 bg-sky-500/10 text-sky-300',
        icon: 'refresh',
      };
    }
    return {
      text: `剩 ${remaining}`,
      className: 'border-yellow-500/35 bg-yellow-500/10 text-yellow-300',
      icon: 'alert',
    };
  }

  return null;
};

// 卡片标题下方的说明(同时作为 title 提示)。
// 注意顺序:过期/续期信息优先 —— 这是用户最需要知道的("为什么音质变差了" / "我要不要重扫")。
export const expiryHint = (detail) => {
  const state = detail?.state;
  const refreshable = isAutoRefreshable(detail);

  if (state === 'expired') {
    const basis = detail?.expiry_source === 'probe' ? '在线探测确认已失效' : '凭证有效期已到';
    if (refreshable) {
      return `会员 key 已过期(${basis})，但这份 Cookie 里还有长期授权凭证，下次搜索或播放时会自动续期；若续期失败再重新扫码。`;
    }
    return `凭证已过期(${basis})。会员/无损链路已不可用，重新扫码或粘贴新 Cookie 即可恢复。`;
  }

  if (state === 'expiring_soon') {
    if (refreshable) {
      return `会员 key 约 ${formatRemaining(detail?.expires_in_seconds)} 后到期，到期时会自动续期，无需重新扫码。`;
    }
    return `凭证约 ${formatRemaining(detail?.expires_in_seconds)} 后过期，而且这份 Cookie 缺长期授权凭证、无法自动续期，请提前重新登录以保证无损可用。`;
  }

  if (state === 'ok' && detail?.expires_in_seconds > 0) {
    if (refreshable) {
      return `凭证有效，约 ${formatRemaining(detail?.expires_in_seconds)} 后到期，到期后会自动续期。`;
    }
    return `凭证有效，约 ${formatRemaining(detail?.expires_in_seconds)} 后过期。`;
  }

  return '';
};

// 全局提示条的分类:哪些源该催、哪些不该打扰。
//
// 三个桶的区别不是"状态",而是"用户要不要动手":
//   expired     已过期 + 不能续 → 必须自己重登
//   autoRetry   已过期 + 能续期 → 下次搜索会自动续;仍要提示(续期可能被上游拒绝,
//               而续期失败的表现正是"音质悄悄变差"),但措辞不能说成"请重新扫码"
//   expiringSoon 临期 + 不能续 → 提前动手最省事
//
// **临期 + 能续期不进入任何桶**:那是正常现象,下次搜索就续上了,弹出来只会
// 教用户白扫一次码。这个分支很容易写反(写成"能续期就一律不提示"),
// 那会让 expired 且续期失败的用户彻底看不到任何提示 —— 退回"静默失效"的老问题。
export const classifyCredentialNotices = (details) => {
  const expired = [];
  const expiringSoon = [];
  const autoRetry = [];
  for (const [source, detail] of Object.entries(details || {})) {
    if (!detail || detail.state === 'missing') continue;
    const refreshable = detail.auto_refreshable === true;
    if (detail.state === 'expired') {
      (refreshable ? autoRetry : expired).push(source);
    } else if (detail.state === 'expiring_soon') {
      if (!refreshable) expiringSoon.push(source);
    }
  }
  return { expired, expiringSoon, autoRetry };
};

// 全局提示条文案。优先级:真的不可用 > 会自动续期 > 临期不可续。
export const credentialNoticeText = (buckets, nameOf) => {
  const name = typeof nameOf === 'function' ? nameOf : (source) => source;
  const { expired = [], expiringSoon = [], autoRetry = [] } = buckets || {};

  if (expired.length > 0) {
    return `${expired.map(name).join('、')} 的登录凭证已过期，会员/无损音质已不可用。到「设置」重新扫码或粘贴新 Cookie 即可恢复。`;
  }
  if (autoRetry.length > 0) {
    return `${autoRetry.map(name).join('、')} 的会员 key 已过期，将在下次搜索或播放时自动续期。若续期失败（仍拿不到无损），再到「设置」重新扫码。`;
  }
  if (expiringSoon.length > 0) {
    return `${expiringSoon.map(name).join('、')} 的登录凭证即将过期（不足 24 小时）且无法自动续期，建议提前重新登录以保证无损可用。`;
  }
  return '';
};

