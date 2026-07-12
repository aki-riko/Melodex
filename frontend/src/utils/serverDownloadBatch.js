import { planServerDownloadBatch, serverSaveSucceeded } from './serverDownloads.js';

export const SERVER_DOWNLOAD_BULK_IDLE = Object.freeze({
  phase: 'idle', done: 0, fail: 0, skipped: 0, aborted: 0, total: 0,
  statusError: false, authChanged: false,
});

const emitProgress = (onProgress, state) => {
  if (typeof onProgress === 'function') onProgress(state);
};

export const serverDownloadBatchProcessed = (state) => (
  Number(state?.done || 0) + Number(state?.fail || 0)
  + Number(state?.skipped || 0) + Number(state?.aborted || 0)
);

export const serverDownloadBatchSummary = (state) => {
  if (state?.statusError) return `读取服务器已下载状态失败 · 未处理 ${Number(state?.aborted || 0)} · 共 ${Number(state?.total || 0)}`;
  const parts = [`新增 ${Number(state?.done || 0)}`, `跳过 ${Number(state?.skipped || 0)}`];
  if (state?.fail) parts.push(`失败 ${Number(state.fail)}`);
  if (state?.aborted) parts.push(`未处理 ${Number(state.aborted)}`);
  parts.push(`共 ${Number(state?.total || 0)}`);
  const summary = parts.join(' · ');
  return state?.authChanged ? `登录状态已变化，批量已停止 · ${summary}` : summary;
};

export const shouldAbortServerDownloadBatch = (error) => {
  const status = error?.response?.status;
  return status === 401 || (status === 409 && error?.response?.data?.code === 'user_changed');
};

const statusFailure = (list, onProgress, logger, message, detail) => {
  logger?.warn?.(message, detail);
  const state = {
    ...SERVER_DOWNLOAD_BULK_IDLE,
    phase: 'fail', aborted: list.length, total: list.length, statusError: true,
  };
  emitProgress(onProgress, state);
  return state;
};

const validDownloadStatusItem = (item) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const nonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
  const hasIdentity = nonEmptyString(item.source) && nonEmptyString(item.song_id);
  const hasLegacyPath = nonEmptyString(item.rel_path);
  return Boolean(hasIdentity || hasLegacyPath);
};

const loadBatchPlan = async (list, loadDownloads, onProgress, logger) => {
  let statusData;
  try {
    statusData = await loadDownloads();
  } catch (error) {
    return { failure: statusFailure(list, onProgress, logger, '读取服务器已下载状态失败，已停止本次批量下载', error) };
  }
  const malformedItems = Array.isArray(statusData?.downloads)
    && statusData.downloads.some((item) => !validDownloadStatusItem(item));
  if (!statusData || !Array.isArray(statusData.downloads) || malformedItems) {
    return { failure: statusFailure(list, onProgress, logger, '服务器已下载状态响应格式无效，已停止本次批量下载', statusData) };
  }
  return { plan: planServerDownloadBatch(list, statusData.downloads) };
};

const songIdentity = (song) => ({
  source: song?.source ?? song?.Source,
  id: song?.id ?? song?.ID,
});

const attemptSave = async (song, { saveSong, saveSucceeded, abortOnError, logger }) => {
  try {
    const result = await saveSong(song);
    if (saveSucceeded(result)) return 'done';
    logger?.warn?.('歌曲已落盘但未完成下载归属登记', songIdentity(song));
    return 'fail';
  } catch (error) {
    if (abortOnError(error)) return 'abort';
    logger?.warn?.('批量下载单曲失败', { ...songIdentity(song), error });
    return 'fail';
  }
};

const stoppedState = (state, remaining, logger) => {
  logger?.warn?.('登录状态已变化，已停止剩余批量下载', { expectedRemaining: remaining });
  return { ...state, phase: 'fail', aborted: remaining, authChanged: true };
};

const runPendingDownloads = async (plan, initialState, options) => {
  let state = initialState;
  for (let index = 0; index < plan.pending.length; index += 1) {
    const outcome = await attemptSave(plan.pending[index], options);
    if (outcome === 'abort') {
      state = stoppedState(state, plan.pending.length - index, options.logger);
      emitProgress(options.onProgress, state);
      return state;
    }
    state = { ...state, [outcome]: state[outcome] + 1 };
    emitProgress(options.onProgress, state);
  }
  state = { ...state, phase: state.fail ? 'fail' : 'done' };
  emitProgress(options.onProgress, state);
  return state;
};

// 无 React/浏览器依赖的批量执行器。调用方必须注入状态读取与单曲保存函数。
export const runServerDownloadBatchCore = async (songs, options = {}) => {
  const list = Array.isArray(songs) ? songs.slice() : [];
  if (list.length === 0) {
    const empty = { ...SERVER_DOWNLOAD_BULK_IDLE, phase: 'done' };
    emitProgress(options.onProgress, empty);
    return empty;
  }
  if (typeof options.loadDownloads !== 'function' || typeof options.saveSong !== 'function') {
    throw new TypeError('批量下载缺少状态读取或单曲保存函数');
  }

  const loaded = await loadBatchPlan(list, options.loadDownloads, options.onProgress, options.logger ?? console);
  if (loaded.failure) return loaded.failure;
  const plan = loaded.plan;
  const state = {
    ...SERVER_DOWNLOAD_BULK_IDLE,
    phase: 'running', fail: plan.invalid, skipped: plan.skipped, total: plan.total,
  };
  emitProgress(options.onProgress, state);
  return runPendingDownloads(plan, state, {
    ...options,
    saveSucceeded: options.saveSucceeded ?? serverSaveSucceeded,
    abortOnError: options.abortOnError ?? (() => false),
    logger: options.logger ?? console,
  });
};
