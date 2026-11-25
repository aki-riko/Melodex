import { cn } from './cn';

/**
 * 详情页统一头部：封面 + 眉标 + 主标题 + 元信息 + 操作区。
 *
 * ## 为什么要有这个组件（2026-11 手机端排版重做）
 *
 * 同一个"详情页头部"在 7 个页面里各写了一遍，量出两组真实缺陷：
 *
 * | 缺陷 | 实测证据 |
 * |---|---|
 * | 头图尺寸两种 | 用 `CoverMosaic` 的四处 = 128px；手写的三处 = 112px，同产品差 16px |
 * | 手机端竖向浪费 | `flex-col` 让 112px 封面**独占一整行**，标题被推到下面 |
 * | 操作按钮挤在窄列 | 手机上 4 个按钮在 343px 里换行成 2~3 行 |
 *
 * 以 375×667 的手机算，改造前头部（封面 112 + 间距 16 + 眉标 17 + 标题最多 67
 * + 元信息 18 + 间距 12 + 按钮区）≈ **358px**，一首歌都还没露出来就占掉半屏。
 *
 * ## 布局规则（手机 / 桌面各一套，桌面外观与改造前一致）
 *
 * ```
 *  手机（< sm）                        桌面（>= sm）
 *  ┌──────┬────────────────┐          ┌──────┬──────────────────┐
 *  │ 封面 │ 眉标/标题/元信息 │          │      │ 眉标/标题/元信息   │
 *  ├──────┴────────────────┤          │ 封面 ├──────────────────┤
 *  │ 操作按钮（整行）        │          │      │ 操作按钮           │
 *  └───────────────────────┘          └──────┴──────────────────┘
 * ```
 *
 * 用**一份 DOM** 实现两种排布：手机上 `flex-wrap` + 操作区 `basis-full` 换行，
 * 桌面换成两行网格、封面 `row-span-2` 贴底。**不是**渲染两份按钮 ——
 * 那样会让 `ref`（如歌单页的「更多」菜单锚点）指向第二个节点，菜单会飘。
 *
 * @param {object} props
 * @param {React.ReactNode} props.cover    头图（建议传 <CoverMosaic />，尺寸它自己管）
 * @param {string} [props.eyebrow]         眉标（如「推荐歌单」「播放记录」）
 * @param {React.ReactNode} props.title    主标题（渲染为 h1，全站唯一页面标题）
 * @param {React.ReactNode} [props.meta]   元信息一行（首数、艺人、体积…）
 * @param {React.ReactNode} [props.actions] 操作按钮组
 */
export default function DetailHeader({
  cover,
  eyebrow,
  title,
  meta,
  actions,
  className = '',
}) {
  return (
    <header
      className={cn(
        // 手机：封面与标题同一行，操作区整行换到下面
        'mb-5 flex flex-wrap items-center gap-x-4 gap-y-3',
        // 桌面：两行网格，封面跨两行。行轨道写成 `minmax(0,1fr) auto` ——
        // 关键：右列内容（标题块 + 按钮组）总高通常小于封面 128px，
        // 若用默认的 auto/auto，两行会被**均匀拉伸**，标题与按钮之间凭空多出一段空隙，
        // 而改造前它们是紧邻的（只隔 mt-3）。让第 1 行吃掉全部剩余、第 2 行贴身置底后，
        // 观感与改造前 `items-end` + 右列 `mt-3` 完全一致。
        'sm:grid sm:grid-cols-[auto_minmax(0,1fr)] sm:grid-rows-[minmax(0,1fr)_auto]',
        'sm:items-end sm:gap-y-0',
        className,
      )}
    >
      <div className="flex-shrink-0 sm:row-span-2 sm:self-end">{cover}</div>

      <div className="min-w-0 flex-1 sm:col-start-2 sm:row-start-1 sm:flex-none">
        {eyebrow ? (
          <p className="type-micro uppercase tracking-wider text-muted-foreground">{eyebrow}</p>
        ) : null}
        {/* h1 必须用 type-hero 令牌（uiConsistency 门禁第 ⑦ 条）。 */}
        <h1 className="mt-0.5 line-clamp-2 type-hero text-foreground">{title}</h1>
        {meta ? <p className="mt-1 type-caption text-muted-foreground">{meta}</p> : null}
      </div>

      {actions ? (
        <div
          className={cn(
            // 手机：占满整行（basis-full），按钮在 343px 里平铺
            'flex basis-full flex-wrap items-center gap-2',
            // 桌面：回到标题列下方，补 12px 间距（手机上这段间距由 gap-y 提供）
            'sm:col-start-2 sm:row-start-2 sm:basis-auto sm:mt-3',
          )}
        >
          {actions}
        </div>
      ) : null}
    </header>
  );
}
