import React from 'react';
import { cn } from '../ui/cn';

/**
 * 设置页的**统一分区容器**。
 *
 * ## 为什么要有这个组件（2026-11 重构）
 *
 * 用户反馈「设置页面排版重构一下」。用 CDP 实测后发现四处真实缺陷，
 * **全部是「每个分区各写一套」造成的**：
 *
 * | 缺陷 | 实测证据 |
 * |---|---|
 * | 标题字号不一致 | 「账号登录」`text-lg`(18px)，其余全 `text-xl`(20px) |
 * | 分区间距不成规律 | 标题 y 间隔 324 / 126 / 126 / 524 px |
 * | 卡片圆角两套 | QR 卡 `rounded-md`(4px)，外观卡 `rounded-lg`(8px) |
 * | 描述与标题的间距不齐 | 有的 `mb-2`、有的 `mb-3`、有的 `mb-4` |
 *
 * 根因：`Settings.js` / `AppearanceSettings.js` / `DesktopLyricsSettings.js`
 * 三处各写各的 `<section><h3>...</h3><p>...</p>`。
 *
 * 现在统一走这个组件，**改一处即全局生效**，且由
 * `scripts/uiConsistency.test.mjs` 门禁守着「设置页不得再手写分区标题」。
 *
 * @param {object} props
 * @param {string} props.title   分区标题
 * @param {string} [props.desc]  标题下的说明文字
 * @param {React.ReactNode} [props.action] 标题右侧的操作（如「刷新」按钮）
 * @param {string} [props.id]    给 aria-labelledby 用；默认从 title 派生不了，显式传更稳
 */
export default function SettingsSection({
  title,
  desc,
  action,
  id,
  children,
  className = '',
}) {
  const headingId = id ? `${id}-heading` : undefined;
  return (
    <section
      aria-labelledby={headingId}
      className={cn('mb-10 last:mb-0', className)}
    >
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h3 id={headingId} className="text-xl font-semibold text-foreground">
          {title}
        </h3>
        {action}
      </div>
      {desc ? (
        <p className="mb-4 text-sm leading-relaxed text-muted-foreground">{desc}</p>
      ) : null}
      {children}
    </section>
  );
}

/**
 * 设置页里「一行设置」的统一卡片。
 *
 * 原来「播放偏好」那一条是裸的 `div.flex...border.rounded-md.surface`，
 * 「本地音乐库」的曲目行也是各写各的。统一成同一个组件后，
 * 圆角 / 描边 / 内边距 / 悬停都一致。
 *
 * ★ 用 `.surface` 而不是 `bg-card`：这是全站的卡片材质类
 *   （带 `--material-alpha` 半透明和 `--elevation-card` 阴影），
 *   直接 `bg-card` 会丢掉阴影层级，在浅色主题下与背景糊在一起。
 *
 * @param {object} props
 * @param {boolean} [props.interactive] 是否可点（可点才给 hover 反馈）
 */
export function SettingsRow({ children, className = '', interactive = false }) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 rounded-control border border-border surface px-4 py-3',
        interactive && 'transition-colors hover:bg-secondary/60',
        className,
      )}
    >
      {children}
    </div>
  );
}
