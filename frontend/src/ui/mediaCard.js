import { cn } from './cn';

/**
 * 横向轮播卡（歌单 / 专辑）的统一宽度与材质。
 *
 * ## 为什么要有这个文件（2026-11 手机端排版重做）
 *
 * 改造前全站"横滑卡片"是**三套宽度 + 两套内边距**：
 *
 * | 位置 | 宽度 | 内边距 |
 * |---|---|---|
 * | 首页「为你推荐」/ 各源分组 | `w-[9rem]` 144px | `p-2` 8px |
 * | 找歌页「推荐歌单」 | `w-[8.5rem]` 136px | `p-1.5` 6px |
 * | 找歌页「匹配到的专辑」 | `w-[8.5rem]` 136px | `p-1.5` 6px |
 *
 * 手指横向滑过两类卡片时，宽度会"抖"一下；而卡片内的封面左边缘在
 * 16/24/8/6 四种缩进之间跳，横向节奏是散的。
 *
 * ## 两条使用规则
 *
 * 1. **轮播里**用 `MEDIA_CARD_ROW_WIDTH`（手机 136px 更紧凑、一屏多半张；
 *    桌面 160px，与原来首页的 `sm:w-40` 一致）。
 * 2. **网格里**自己传 `w-full`，别复用宽度类。
 *    ⚠ 不能指望"后写的类覆盖先写的"—— 本项目 `cn()` 只拼接、**不做冲突合并**
 *    （没装 tailwind-merge），而 CSS 里 `.w-full` 与 `.w-[8.5rem]` 谁生效取决于
 *    Tailwind 的生成顺序，不是 className 里的书写顺序。实测产物中 `.w-full`
 *    排在 `w-[9rem]` 之后 —— 换个任意值就可能翻过来。所以宽度必须**二选一**传进来。
 */
export const MEDIA_CARD_BASE =
  'group rounded-lg border border-transparent text-left '
  + 'transition-colors duration-base ease-standard '
  + 'hover:border-border hover:bg-secondary/60 '
  + 'focus-visible:border-border focus-visible:bg-secondary/60';

/** 轮播行里的卡片宽度 + 内边距（手机紧凑、桌面放宽） */
export const MEDIA_CARD_ROW_WIDTH = 'w-[8.5rem] p-1.5 sm:w-40 sm:p-2';

/** 网格里的卡片：宽度交给栅格，内边距沿用轮播那套 */
export const MEDIA_CARD_GRID_WIDTH = 'w-full p-1.5 sm:p-2';

/**
 * 卡片 className 拼装。
 *
 * ⚠ 第二个参数必须显式给宽度（`MEDIA_CARD_ROW_WIDTH` 或 `MEDIA_CARD_GRID_WIDTH`），
 * 且**只能给一个**。原因是本项目 `cn()` 只拼接、不做 Tailwind 冲突合并：
 * 同时出现 `w-[8.5rem]` 与 `w-full` 时，谁生效取决于 Tailwind 生成规则的先后，
 * 而不是 className 的书写顺序（实测产物里 `.w-full` 排在 `.w-[9rem]` 之后）。
 * 所以宽度一律由调用方按场景二选一，不在这里叠。
 */
export const mediaCardClass = (widthClass, ...extra) => cn(MEDIA_CARD_BASE, widthClass, ...extra);

export default mediaCardClass;
