import React, { useState, useEffect, useCallback } from 'react';
import { X, Check, Download, Music, RefreshCw, LogIn } from 'lucide-react';
import { useCollections } from '../contexts/CollectionsContext';
import { useAuth } from '../contexts/AuthContext';
import { useFeedback } from '../contexts/FeedbackContext';
import { getUserPlaylists, coverProxyUrl } from '../services/musicdl';
import { importPlaylist } from '../services/collections';

// 从已登录平台(网易云/QQ/酷狗/汽水)导入个人歌单(引用型:只存引用,打开实时拉曲)。
// open=false 时不渲染;onNavigate 用于「去登录」跳到设置页;成功后 refresh 侧栏。
export default function ImportPlaylistModal({ open, onClose, onNavigate }) {
  const { refresh } = useCollections();
  const { offline } = useAuth();
  const feedback = useFeedback();
  const [loading, setLoading] = useState(false);
  const [tabs, setTabs] = useState([]); // [{source, source_name, playlists, error}]
  const [active, setActive] = useState(''); // 当前选中源
  const [importingId, setImportingId] = useState(null); // 正在导入的歌单 id
  const [doneIds, setDoneIds] = useState({}); // 已导入的歌单 id → true

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
      load();
    }
  }, [open, load]);

  if (!open) return null;

  const close = () => { onClose?.(); };

  const activeTab = tabs.find((t) => t.source === active);

  const doImport = async (playlist) => {
    if (offline || importingId) return;
    setImportingId(playlist.id);
    try {
      const r = await importPlaylist({ ...playlist, source: active });
      setDoneIds((m) => ({ ...m, [playlist.id]: true }));
      if (r?.duplicate) {
        feedback.info(`「${r.name || playlist.name}」已导入过`);
      } else {
        feedback.success(`已导入「${r?.name || playlist.name}」`);
      }
      await refresh();
    } catch (err) {
      feedback.error('导入失败:' + (err?.response?.data?.error || err.message || '未知错误'));
    } finally {
      setImportingId(null);
    }
  };

  const goLogin = () => { close(); onNavigate?.('Settings'); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={close}>
      <div className="bg-card rounded-lg w-full max-w-lg max-h-[82vh] flex flex-col shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="min-w-0">
            <p className="font-semibold">从平台导入歌单</p>
            <p className="text-xs text-muted-foreground">导入你在已登录平台创建/收藏的歌单,打开时实时拉取曲目,可在线听也可下载到 NAS。</p>
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
            const done = doneIds[pl.id];
            const busy = importingId === pl.id;
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
                </div>
                <button onClick={() => doImport(pl)} disabled={offline || busy || done}
                  className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-sm font-medium flex-shrink-0 transition-colors ${
                    done ? 'bg-primary/10 text-primary' : 'bg-primary text-primary-foreground disabled:opacity-50'
                  }`}>
                  {done ? <Check size={15} /> : <Download size={15} className={busy ? 'animate-pulse' : ''} />}
                  {done ? '已导入' : busy ? '导入中' : '导入'}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
