// m3u 导入任务的轮询(2026-11 全库扫描, P2-13 方案 C)。
//
// 后端已改成"提交即返回 task_id + 后台逐条匹配"(原因见
// backend/internal/web/m3u_import_task.go 的长注释:同步跑要 1000~2000 秒,
// 必然撞穿前端超时,而歌单其实已经建好 —— 用户看到"失败"但刷新后有歌单)。
//
// 这里负责把 task 契约变成可用的 UI 状态:
//   · 每 POLL_INTERVAL_MS 查一次;
//   · 终态(done/failed/cancelled)立刻停;
//   · 组件卸载 / 用户取消时停;
//   · 查询本身失败**不**立刻判死 —— 网络抖一下不该让整次导入显示失败,
//     而是继续轮询;只有连续失败超过阈值才报错(否则用户会看到"导入失败"
//     但后端还在跑,又回到原来那个体验问题)。
//
// 为什么轮询而不是 SSE:本项目此前没有任何 SSE 先例,引入它要处理 Flush 时机、
// 反代缓冲、断线重连、鉴权 cookie 路径一堆新问题;而进度是秒级更新,
// 轮询 1 秒完全够用,失败与重连天然简单。

import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelImportM3UTask, getImportM3UTask, importM3U } from '../services/collections';

/** 轮询间隔。秒级足够 —— 后端每 20 条才更新一次进度。 */
export const IMPORT_POLL_INTERVAL_MS = 1000;

/**
 * 连续多少次轮询失败才判定为出错。
 *
 * 5 次 = 约 5 秒。低于这个数就报错的话，一次网络抖动会让用户以为导入失败，
 * 而后端其实还在跑 —— 那正是这次要修掉的体验问题。
 */
export const IMPORT_POLL_MAX_FAILURES = 5;

const TERMINAL_STATES = new Set(['done', 'failed', 'cancelled']);

/**
 * 管理一次 m3u 导入的完整生命周期。
 *
 * 返回:
 *   start(name, content) —— 提交并开始轮询,返回首次响应(含 task_id/id/name)
 *   cancel()             —— 请求后端取消
 *   task                 —— 最近一次进度快照(未开始时为 null)
 *   error                —— 提交失败或轮询连续失败的文案(没有错误时为 '')
 *   running              —— 是否仍在进行
 */
export function useM3UImport({ onDone } = {}) {
  const [task, setTask] = useState(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);

  // 用 ref 存"当前正在轮询哪个任务"与"是否已被取消",
  // 避免把这两个纯运行期标记放进 state(那会多出几次无意义的重渲染)。
  const taskIdRef = useRef('');
  const cancelledRef = useRef(false);
  const timerRef = useRef(null);
  // 完成回调也放 ref:调用方每次渲染都可能传新函数,不该因此重启轮询。
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // 卸载时一定要停,否则定时器会在组件消失后继续发请求。
  useEffect(() => stopPolling, [stopPolling]);

  const poll = useCallback((taskId, failures) => {
    stopPolling();
    timerRef.current = setTimeout(async () => {
      if (cancelledRef.current) return;
      try {
        const snapshot = await getImportM3UTask(taskId);
        if (cancelledRef.current) return;
        setTask(snapshot);

        if (TERMINAL_STATES.has(snapshot.state)) {
          setRunning(false);
          if (snapshot.state === 'done') {
            setError('');
            if (onDoneRef.current) onDoneRef.current(snapshot);
          } else if (snapshot.state === 'cancelled') {
            setError('');
          } else {
            setError(snapshot.message || '导入失败');
          }
          return;
        }
        poll(taskId, 0);
      } catch (err) {
        if (cancelledRef.current) return;
        const next = failures + 1;
        if (next >= IMPORT_POLL_MAX_FAILURES) {
          setRunning(false);
          setError(
            `查询导入进度失败(已重试 ${next} 次):${err?.response?.data?.error || err?.message || '网络异常'}`,
          );
          return;
        }
        // 还没到阈值:继续轮询。后端任务不受影响,仍在逐条匹配。
        poll(taskId, next);
      }
    }, IMPORT_POLL_INTERVAL_MS);
  }, [stopPolling]);

  const start = useCallback(async (name, content) => {
    cancelledRef.current = false;
    setError('');
    setRunning(true);
    setTask(null);

    const created = await importM3U(name, content);
    taskIdRef.current = created.task_id || '';
    // 提交响应本身就是第一份进度快照(字段是它的子集),
    // 直接拿来渲染,用户立刻看到"共 N 条, 正在匹配"。
    setTask({
      task_id: created.task_id,
      collection_id: created.id,
      name: created.name,
      state: created.state || 'running',
      total: created.total || 0,
      processed: 0,
      matched: 0,
      skipped: 0,
      percent: 0,
      already_running: Boolean(created.already_running),
    });

    if (created.task_id) poll(created.task_id, 0);
    return created;
  }, [poll]);

  const cancel = useCallback(async () => {
    const taskId = taskIdRef.current;
    cancelledRef.current = true;
    stopPolling();
    setRunning(false);
    if (!taskId) return;
    try {
      const snapshot = await cancelImportM3UTask(taskId);
      setTask(snapshot);
    } catch {
      // 取消失败不打扰用户:后端任务会在跑完后自然结束,
      // 已导入的歌曲都保留,最坏情况是多花了一会儿上游请求。
    }
  }, [stopPolling]);

  return { start, cancel, task, error, running };
}

export default useM3UImport;
