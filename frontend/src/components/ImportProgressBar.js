// m3u 导入进度条（2026-11 全库扫描, P2-13 方案 C）。
//
// 为什么放在歌单页顶部而不是侧栏:
//   · 用户点完"导入 m3u"后，Sidebar 会立刻 `openNew()` 把他导航到新歌单页 ——
//     那里正是"看着歌一首首加进来"最自然的地方；
//   · 侧栏菜单项空间只有一行文字宽，塞进度条会挤压整个"我的歌单"布局；
//   · 歌单页顶部本来就是内容区，进度条与"共 N 首"的列表头同处一屏，关联最清楚。
//
// 数据来自 importProgressBus 的广播（订阅方晚挂载也能在下一次广播拿到全量快照）。
//
// 交互:
//   · running  → 显示进度、百分比、已匹配数、取消按钮
//   · cancelled → 显示"已取消，已导入的歌曲保留"，几秒后自动隐藏
//   · done     → 由 Sidebar 的 onDone 广播 null 收尾，这里不再单独处理
//   · failed   → 显示失败原因（后端给的固定文案），保留取消按钮位置的空白

import { useEffect, useState } from 'react';
import { CircleStop, LoaderCircle } from 'lucide-react';
import { cancelImportM3UTask } from '../services/collections';
import { onImportProgress } from '../services/importProgressBus';

/** 取消/失败后进度条再停留多久（毫秒），让用户看到结论。 */
export const IMPORT_RESULT_LINGER_MS = 4000;

export default function ImportProgressBar() {
  const [task, setTask] = useState(null);
  const [hidden, setHidden] = useState(false);
  // 取消失败要显示给用户 —— 主动操作的失败不能静默(项目 UX 门禁要求)。
  const [cancelFailed, setCancelFailed] = useState(false);

  useEffect(() => {
    return onImportProgress((snapshot) => {
      // null 是"导入结束，收尾隐藏"的信号。
      if (snapshot === null) {
        setTask(null);
        setHidden(false);
        return;
      }
      setTask(snapshot);
      // 新任务进来时解除隐藏（上一轮可能还停留在 linger 状态）。
      if (snapshot.state === 'running') setHidden(false);
    });
  }, []);

  // 终态（cancelled / failed）显示一会儿再自动隐藏 ——
  // 否则进度条会一直挂在页面上，用户不知道它是不是还在干活。
  useEffect(() => {
    if (!task) return undefined;
    if (task.state === 'running' || task.state === 'done') return undefined;
    const timer = setTimeout(() => setHidden(true), IMPORT_RESULT_LINGER_MS);
    return () => clearTimeout(timer);
  }, [task]);

  if (!task || hidden) return null;

  const running = task.state === 'running';
  const percent = Math.max(0, Math.min(100, Number(task.percent) || 0));
  const total = Number(task.total) || 0;
  const processed = Number(task.processed) || 0;
  const matched = Number(task.matched) || 0;

  const onCancel = async () => {
    if (!task.task_id) return;
    setCancelFailed(false);
    try {
      const snapshot = await cancelImportM3UTask(task.task_id);
      setTask(snapshot);
    } catch (error) {
      // ★ 门禁要求:用户**主动操作**的失败必须可见。
      // 只写 console 的话，用户点了取消没反应、以为是按钮坏了。
      // 这里在进度条里直接显示一行提示，并保留按钮让用户重试。
      console.warn('取消 m3u 导入失败', error);
      setCancelFailed(true);
    }
  };

  return (
    <div className="mb-4 surface rounded-control border border-border p-3">
      <div className="flex items-center gap-2">
        {running ? (
          <LoaderCircle className="size-icon-sm flex-shrink-0 animate-spin text-primary" aria-hidden="true" />
        ) : (
          <CircleStop className="size-icon-sm flex-shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <span className="type-caption flex-shrink-0 text-foreground">
          {running
            ? `正在导入「${task.name || '歌单'}」`
            : task.state === 'cancelled'
              ? '导入已取消'
              : '导入失败'}
        </span>
        <span className="type-caption ml-auto flex-shrink-0 tabular-nums text-muted-foreground">
          {processed} / {total}
        </span>
        {running && task.task_id && (
          <button
            type="button"
            onClick={onCancel}
            className="flex-shrink-0 rounded-control px-2 py-1 type-caption text-muted-foreground transition-colors duration-base hover:bg-secondary hover:text-foreground"
          >
            取消
          </button>
        )}
      </div>

      {/* 进度条:用 transform 缩放而不是改 width ——
          项目纪律要求动效只用 transform/opacity(逐帧改 width 会重排)。 */}
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-secondary" role="progressbar"
        aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div
          className="h-full origin-left rounded-full bg-primary transition-transform duration-base"
          style={{ transform: `scaleX(${percent / 100})` }}
        />
      </div>

      <p className="mt-1 type-caption text-muted-foreground">
        {cancelFailed
          ? '取消失败，导入仍在继续。可再点一次「取消」重试。'
          : task.state === 'cancelled'
            ? `已导入 ${matched} 首，这些歌曲会保留`
            : task.state === 'failed'
              ? (task.message || '请稍后重试')
              : `已匹配 ${matched} 首 · ${percent}%`}
      </p>
    </div>
  );
}
