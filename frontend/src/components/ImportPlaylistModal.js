import React, { useState, useEffect, useCallback } from 'react';
import { X, Check, Download, Music, RefreshCw, LogIn } from 'lucide-react';
import { useCollections } from '../contexts/CollectionsContext';
import { useAuth } from '../contexts/AuthContext';
import { useFeedback } from '../contexts/FeedbackContext';
import { useScopedBulkState } from '../hooks/useScopedBulkState';
import { getUserPlaylists, coverProxyUrl, saveToServer, serverSaveSucceeded } from '../services/musicdl';
import { importPlaylist, getCollectionSongs } from '../services/collections';

// 自动下载进度状态挂在模块级全局 store(useScopedBulkState),
// 不随弹窗关闭丢失,且 runForKey 自带同 key 去重锁(防同歌单重复下载并发)。
const DL_IDLE = { phase: 'idle', done: 0, fail: 0, total: 0, text: '' };

const downloadTaskKey = (source, playlistId) => `${source || 'unknown'}:${playlistId ?? ''}`;

const normalizedPlaylistName = (name) => (name || '').trim().toLocaleLowerCase();

const findSameNameMergeTarget = (collections, playlistName) => {
  const name = normalizedPlaylistName(playlistName);
  if (!name) return null;
  return (collections || []).find((collection) => (
    collection?.kind !== 'imported' && normalizedPlaylistName(collection?.name) === name
  )) || null;
};

const downloadProgressText = (state) => {
  if (!state || state.phase === 'idle') return '';
  if (state.text) return state.text;
  if (state.phase === 'running') return `下载到服务器 ${state.done + state.fail}/${state.total}`;
  if (state.phase === 'done') return `已全部下载到服务器 ${state.done}/${state.total}`;
  if (state.phase === 'fail') return state.total ? `完成 ${state.done}/${state.total}(${state.fail} 首失败)` : '自动下载失败,可在歌单页手动下载';
  return '';
};

// 从已登录平台(网易云/QQ/酷狗/汽水)导入个人歌单(引用型:只存引用,打开实时拉曲)。
// open=false 时不渲染;onNavigate 用于「去登录」跳到设置页;成功后 refresh 侧栏。
export default function ImportPlaylistModal({ open, onClose, onNavigate }) {
  const { collections, refresh } = useCollections();
  const { offline } = useAuth();
  const feedback = useFeedback();
  const [loading, setLoading] = useState(false);
  const [tabs, setTabs] = useState([]); // [{source, source_name, playlists, error}]
  const [active, setActive] = useState(''); // 当前选中源
  const [importingId, setImportingId] = useState(null); // 正在导入的平台歌单 key
  const [doneIds, setDoneIds] = useState({}); // 已导入的平台歌单 key → true
  const [mergePrompt, setMergePrompt] = useState(null); // { playlist, source, target, taskKey }
  const downloadTasks = useScopedBulkState(DL_IDLE, 'playlist-import-dl');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getUserPlaylists();
      const list = Array.isArray(data?.tabs) ? data.tabs : [];
      setTabs(list);
      setActive((prev) => (list.some((t) => t.source === prev) ? prev : (list[0]?.source || '')));
    } catch (err) {
      feedback.error('加载平台歌单失败:' + (err?.response?.data?.error || err.message || '未知错误'));
      setTabs([]);
    } finally {
      setLoading(false);
    }
  }, [feedback]);

  useEffect(() => {
    if (open) {
      setDoneIds({});
      setMergePrompt(null);
      load();
    }
  }, [open, load]);

  if (!open) return null;

  const close = () => { onClose?.(); };

  const activeTab = tabs.find((t) => t.source === active);

  // 导入成功后,后台把整单曲目逐首下载到服务器(实时从平台拉曲 → 逐首 saveToServer)。
  // 串行下载当前歌单,失败不打断(用户仍可在歌单页手动重试);进度文案挂在歌单卡片上。
  const autoDownloadAll = (taskKey, collectionId) => {
    if (offline || !taskKey || collectionId == null) return;
    void downloadTasks.runForKey(taskKey, { ...DL_IDLE, phase: 'loading', text: '拉取曲目…' }, async (update) => {
      try {
        const data = await getCollectionSongs(collectionId);
        const list = Array.isArray(data) ? data : (data?.songs || []);
        const total = list.length;
        if (total === 0) {
          update({ ...DL_IDLE, phase: 'done', text: '无可下载曲目' });
          return;
        }
        let done = 0;
        let fail = 0;
        for (const song of list) {
          try {
            const result = await saveToServer(song);
            if (serverSaveSucceeded(result)) done += 1; else fail += 1;
          } catch (err) {
            fail += 1;
            console.warn('导入歌单自动下载单曲失败', err);
          }
          update({ phase: 'running', done, fail, total, text: '' });
        }
        update({ phase: fail ? 'fail' : 'done', done, fail, total, text: '' });
      } catch (err) {
        console.warn('导入歌单自动下载失败', err);
        update({ ...DL_IDLE, phase: 'fail', text: '自动下载失败,可在歌单页手动下载' });
      }
    });
  };

  const performImport = async (playlist, { source = active, mergeInto = null } = {}) => {
    const taskKey = downloadTaskKey(source, playlist.id);
    if (offline || importingId) return;
    setImportingId(taskKey);
    try {
      const r = await importPlaylist({ ...playlist, source }, { mergeIntoId: mergeInto?.id });
      setDoneIds((m) => ({ ...m, [taskKey]: r?.merged ? 'merged' : 'imported' }));
      if (r?.merged) {
        feedback.success(`已合并到「${r.name || mergeInto?.name || playlist.name}」,新增 ${r.added ?? 0}/${r.total ?? 0} 首,开始下载到服务器`);
      } else if (r?.duplicate) {
        feedback.info(`「${r.name || playlist.name}」已导入过,继续下载到服务器`);
      } else {
        feedback.success(`已导入「${r?.name || playlist.name}」,开始下载到服务器`);
      }
      await refresh();
      // 后台整单下载到服务器(不 await,不阻塞弹窗交互)。
      if (r?.id != null) autoDownloadAll(taskKey, r.id);
    } catch (err) {
      feedback.error('导入失败:' + (err?.response?.data?.error || err.message || '未知错误'));
    } finally {
      setImportingId(null);
    }
  };

  const doImport = async (playlist) => {
    const source = active;
    const taskKey = downloadTaskKey(source, playlist.id);
    if (offline || importingId) return;
    const target = findSameNameMergeTarget(collections, playlist.name);
    if (target) {
      setMergePrompt({ playlist, source, target, taskKey });
      return;
    }
    await performImport(playlist, { source });
  };

  const goLogin = () => { close(); onNavigate?.('Settings'); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={close}>
      <div className="bg-card rounded-lg w-full max-w-lg max-h-[82vh] flex flex-col shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="min-w-0">
            <p className="font-semibold">从平台导入歌单</p>
            <p className="text-xs text-muted-foreground">导入你在已登录平台创建/收藏的歌单,导入后自动把曲目下载到服务器,也可在线播放。</p>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button onClick={load} disabled={loading} className="text-muted-foreground hover:text-foreground p-1 disabled:opacity-50" aria-label="刷新" title="刷新">
              <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
            </button>
            <button onClick={close} className="text-muted-foreground hover:text-foreground p-1" aria-label="关闭"><X size={20} /></button>
          </div>
        </div>

        {/* 源分栏 */}
        {tabs.length > 0 && (
          <div className="flex gap-1 px-4 pt-3 flex-wrap">
            {tabs.map((t) => (
              <button key={t.source} onClick={() => setActive(t.source)}
                className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
                  active === t.source ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground hover:text-foreground'
                }`}>
                {t.source_name || t.source}
                {t.playlists?.length > 0 && <span className="ml-1 opacity-70">{t.playlists.length}</span>}
              </button>
            ))}
          </div>
        )}

        {mergePrompt && (
          <div className="mx-4 mt-3 rounded-md border border-primary/40 bg-primary/10 p-3 text-sm">
            <p className="font-medium text-foreground">已存在同名歌单「{mergePrompt.target.name}」</p>
            <p className="mt-1 text-xs text-muted-foreground">
              要把「{mergePrompt.playlist.name}」的曲目合并进去吗？选择新建会保留一个独立的平台引用歌单。
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() => {
                  const prompt = mergePrompt;
                  setMergePrompt(null);
                  performImport(prompt.playlist, { source: prompt.source, mergeInto: prompt.target });
                }}
                disabled={offline || Boolean(importingId)}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                合并
              </button>
              <button
                onClick={() => {
                  const prompt = mergePrompt;
                  setMergePrompt(null);
                  performImport(prompt.playlist, { source: prompt.source });
                }}
                disabled={offline || Boolean(importingId)}
                className="rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-foreground disabled:opacity-50"
              >
                新建
              </button>
              <button
                onClick={() => setMergePrompt(null)}
                disabled={Boolean(importingId)}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-secondary disabled:opacity-50"
              >
                取消
              </button>
            </div>
          </div>
        )}

        <div className="overflow-y-auto app-scroll flex-grow px-4 py-3">
          {loading && <p className="text-sm text-muted-foreground py-6 text-center">加载中…</p>}

          {!loading && tabs.length === 0 && (
            <p className="text-sm text-muted-foreground py-6 text-center">暂无可导入的平台,请先在设置里登录网易云/QQ 等平台。</p>
          )}

          {!loading && activeTab && activeTab.error && (
            <div className="py-8 flex flex-col items-center gap-3 text-center">
              <p className="text-sm text-muted-foreground">该平台暂无个人歌单,或未登录。</p>
              <button onClick={goLogin} className="flex items-center gap-1.5 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium">
                <LogIn size={16} />去设置登录
              </button>
            </div>
          )}

          {!loading && activeTab && !activeTab.error && activeTab.playlists?.length === 0 && (
            <p className="text-sm text-muted-foreground py-6 text-center">该平台下没有歌单。</p>
          )}

          {!loading && activeTab && !activeTab.error && activeTab.playlists?.map((pl) => {
            const taskKey = downloadTaskKey(activeTab.source, pl.id);
            const dlState = downloadTasks.getState(taskKey);
            const dlText = downloadProgressText(dlState);
            const downloading = dlState.phase === 'loading' || dlState.phase === 'running';
            const doneStatus = doneIds[taskKey] || (dlState.phase === 'done' ? 'imported' : '');
            const done = Boolean(doneStatus);
            const waitingMerge = mergePrompt?.taskKey === taskKey;
            const busy = importingId === taskKey;
            const buttonLabel = doneStatus === 'merged' ? '已合并' : done ? '已导入' : waitingMerge ? '待确认' : busy ? '导入中' : downloading ? '下载中' : '导入';
            return (
              <div key={pl.id} className="flex items-center gap-3 py-2 border-b border-border/50 last:border-0">
                <div className="w-11 h-11 rounded bg-secondary flex-shrink-0 overflow-hidden flex items-center justify-center">
                  {pl.cover
                    ? <img src={coverProxyUrl({ cover: pl.cover, source: active })} alt="" loading="lazy" className="w-full h-full object-cover"
                        onError={(e) => { e.target.style.display = 'none'; }} />
                    : <Music size={18} className="text-muted-foreground" />}
                </div>
                <div className="min-w-0 flex-grow">
                  <p className="text-sm truncate">{pl.name}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {pl.track_count > 0 ? `${pl.track_count} 首` : ''}{pl.creator ? `${pl.track_count > 0 ? ' · ' : ''}${pl.creator}` : ''}
                  </p>
                  {dlText && <p className="text-xs text-primary truncate mt-0.5">{dlText}</p>}
                </div>
                <button onClick={() => doImport(pl)} disabled={offline || waitingMerge || busy || downloading || done}
                  className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-sm font-medium flex-shrink-0 transition-colors ${
                    done ? 'bg-primary/10 text-primary' : 'bg-primary text-primary-foreground disabled:opacity-50'
                  }`}>
                  {done ? <Check size={15} /> : <Download size={15} className={(busy || downloading || waitingMerge) ? 'animate-pulse' : ''} />}
                  {buttonLabel}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
