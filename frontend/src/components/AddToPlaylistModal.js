import React, { useState } from 'react';
import { X, Plus, Check } from 'lucide-react';
import { useCollections } from '../contexts/CollectionsContext';

// 加歌弹窗:SongRow 点"+"设置 addTarget 后弹出,选歌单加入或新建歌单。
export default function AddToPlaylistModal() {
  const { collections, addTarget, setAddTarget, addSong, create } = useCollections();
  const [newName, setNewName] = useState('');
  const [done, setDone] = useState(null); // 刚加入的歌单 id(显示✓)
  const [busy, setBusy] = useState(false);

  if (!addTarget) return null;

  const close = () => { setAddTarget(null); setNewName(''); setDone(null); };

  const addTo = async (id) => {
    setBusy(true);
    try { await addSong(id, addTarget); setDone(id); setTimeout(close, 700); }
    catch { /* 静默 */ } finally { setBusy(false); }
  };

  const createAndAdd = async (e) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const c = await create(name);
      if (c && c.id != null) { await addSong(c.id, addTarget); setDone(c.id); setTimeout(close, 700); }
    } catch { /* 静默 */ } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={close}>
      <div className="bg-card rounded-lg w-full max-w-sm max-h-[80vh] flex flex-col shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="min-w-0">
            <p className="font-semibold">加入歌单</p>
            <p className="text-xs text-muted-foreground truncate">{addTarget.name} · {addTarget.artist}</p>
          </div>
          <button onClick={close} className="text-muted-foreground hover:text-foreground" aria-label="关闭"><X size={20} /></button>
        </div>
        <div className="overflow-y-auto app-scroll flex-grow">
          {collections.length === 0 && (
            <p className="px-4 py-3 text-sm text-muted-foreground">还没有歌单,下面新建一个吧</p>
          )}
          {collections.map((c) => (
            <button key={c.id} onClick={() => addTo(c.id)} disabled={busy}
              className="w-full flex items-center justify-between px-4 py-2.5 text-sm hover:bg-secondary transition-colors text-left">
              <span className="truncate">{c.name}</span>
              {done === c.id && <Check size={16} className="text-primary flex-shrink-0" />}
            </button>
          ))}
        </div>
        <form onSubmit={createAndAdd} className="flex gap-2 px-4 py-3 border-t border-border">
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="新建歌单名…"
            className="flex-grow bg-secondary rounded-md px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary" />
          <button type="submit" disabled={busy || !newName.trim()}
            className="flex items-center gap-1 px-3 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">
            <Plus size={16} />新建
          </button>
        </form>
      </div>
    </div>
  );
}
