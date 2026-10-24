import React, { useState } from 'react';
import { Check, Plus } from 'lucide-react';
import { useCollections } from '../contexts/CollectionsContext';
import { useAuth } from '../contexts/AuthContext';
import { useFeedback } from '../contexts/FeedbackContext';
import { saveToServer, serverSaveSucceeded } from '../services/musicdl';
import Dialog from '../ui/Dialog';
import Button from '../ui/Button';
import { Input } from '../ui/Input';
import StatusLine from '../ui/StatusLine';
import { cn } from '../ui/cn';

// 加歌弹窗:SongRow 点「加入歌单」设置 addTarget 后弹出,选歌单加入或新建歌单。
// 加入歌单的同时后台静默下载该歌到 NAS(不验活、不阻塞 UI)。
// 本轮:改用 ui/Dialog(Esc/焦点陷阱/焦点回归/滚动锁),并修掉"静默 catch"。
export default function AddToPlaylistModal() {
  const { collections, addTarget, setAddTarget, addSong, create } = useCollections();
  const { offline } = useAuth();
  const feedback = useFeedback();
  const [newName, setNewName] = useState('');
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);

  if (!addTarget) return null;

  const close = () => { setAddTarget(null); setNewName(''); setDone(null); };

  // 后台下载到 NAS:用户主动作是"加入歌单",下载失败不该打断流程,
  // 但也不能完全静默 —— 至少留下可查的日志,并在失败时给出可见提示。
  const autoDownload = (song) => {
    if (offline) return;
    saveToServer(song)
      .then((r) => {
        if (!serverSaveSucceeded(r)) {
          console.warn('加入歌单后的自动保存未成功', song?.name);
        }
      })
      .catch((err) => {
        console.warn('加入歌单后的自动保存失败', err);
        feedback.warning('已加入歌单,但没能存到服务器,可稍后单独下载');
      });
  };

  const addTo = async (id) => {
    if (offline || busy) return;
    setBusy(true);
    try {
      await addSong(id, addTarget);
      autoDownload(addTarget);
      setDone(id);
      feedback.success('已加入歌单');
      window.setTimeout(close, 700);
    } catch (err) {
      feedback.error(`加入歌单失败:${err?.response?.data?.error || err?.message || '请稍后重试'}`);
    } finally {
      setBusy(false);
    }
  };

  const createAndAdd = async (e) => {
    e.preventDefault();
    if (offline || busy) return;
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const c = await create(name);
      if (c && c.id != null) {
        await addSong(c.id, addTarget);
        autoDownload(addTarget);
        setDone(c.id);
        feedback.success('歌单已创建,歌曲已加入');
        window.setTimeout(close, 700);
      }
    } catch (err) {
      feedback.error(`新建歌单失败:${err?.response?.data?.error || err?.message || '请稍后重试'}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!addTarget}
      onClose={close}
      title="加入歌单"
      size="sm"
      panelClassName="flex max-h-[80dvh] flex-col"
      className="overflow-hidden"
    >
      <p className="-mt-1 mb-3 truncate type-micro text-muted-foreground">
        {addTarget.name}{addTarget.artist ? ` · ${addTarget.artist}` : ''}
      </p>

      <div className="-mx-4 max-h-64 overflow-y-auto scroll-area border-y border-border">
        {offline && (
          <div className="px-4 py-3">
            <StatusLine tone="warning">离线状态无法修改歌单</StatusLine>
          </div>
        )}
        {!offline && collections.length === 0 && (
          <div className="px-4 py-3">
            <StatusLine tone="neutral">还没有歌单,在下面新建一个</StatusLine>
          </div>
        )}
        {collections.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => addTo(c.id)}
            disabled={offline || busy}
            className={cn(
              'flex min-h-touch w-full items-center justify-between gap-2 px-4 type-body transition-colors duration-base',
              'hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            <span className="truncate text-left">{c.name}</span>
            {done === c.id && <Check size={16} className="flex-shrink-0 text-primary" aria-hidden="true" />}
          </button>
        ))}
      </div>

      <form onSubmit={createAndAdd} className="mt-3 flex gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          disabled={offline}
          placeholder="新建歌单名…"
          aria-label="新歌单名称"
          className="flex-grow"
          size="md"
        />
        <Button
          type="submit"
          variant="primary"
          size="md"
          disabled={offline || busy || !newName.trim()}
          loading={busy}
        >
          {!busy && <Plus size={16} aria-hidden="true" />}
          新建
        </Button>
      </form>
    </Dialog>
  );
}
