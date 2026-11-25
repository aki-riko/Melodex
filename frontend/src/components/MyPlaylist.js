import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from 'react-query';
import { Download, Ellipsis, HardDriveDownload, Play, Search, Trash2 } from 'lucide-react';
import SongRow, { SongListHeader } from './SongRow';
import { usePlayer } from '../contexts/PlayerContext';
import { useCollections } from '../contexts/CollectionsContext';
import { useAuth } from '../contexts/AuthContext';
import { useFeedback } from '../contexts/FeedbackContext';
import { onOpenPlaylist } from '../services/playlistBus';
import { getCollectionSongs, removeSongFromCollection } from '../services/collections';
import { songIdentityKey } from '../utils/songIdentity';
import { findSongIndexInList, insertSongIntoList, isFavoriteCollection, removeSongFromList } from '../utils/favoriteList';
import {
  collectionSongsQueryKey,
  mergeCollectionSelection,
  parseCollectionIdFromHash,
} from '../utils/collectionRoute';
import { useBulkActions } from '../hooks/useBulkActions';
import LoadingState from './LoadingState';
import CoverMosaic from './CoverMosaic';
import Button from '../ui/Button';
import StatusLine from '../ui/StatusLine';
import EmptyState from '../ui/EmptyState';
import { LyricDialog, useSongLyric } from './useSongLyric';
import ImportProgressBar from './ImportProgressBar';
import { MenuPopover, MenuItem } from '../ui/Menu';
import { useBackLayer } from '../contexts/backNavigation.js';
import { pushRouteEntry } from '../contexts/routeHistory.js';
import { useRegisterPageSearchFilter } from '../contexts/pageSearchFilter.js';
import { useSongFilter } from '../hooks/useSongFilter';

// 稳定的空数组引用:数据未就绪时不要每次渲染都新建 [],否则会不断改变
// useBulkActions 的 useCallback 依赖,产生无意义的重建。
const EMPTY_SONGS = [];

// 自建歌单详情页:侧栏点歌单 → 派发 {collectionId,name} → 这里加载歌曲并播放/移除。
// 批量下载/缓存改用共享 hooks/useBulkActions(原先这里有一份与 Download 页重复的实现)。
//
// 取数模型(修「点一次歌单发两次 GET /music/collections/:id/songs」):
//   hash 路由与 playlistBus 事件**只负责决定要打开哪个歌单**(收敛进 selection),
//   真正的取数只有 react-query 按 ['collection-songs', String(id)] 这一个 key 做一次。
//   此前两个来源各自调 load() → 必然两次请求(dev 下 React.StrictMode 再翻倍),
//   且没有缓存 → 每次点开都重放骨架。
export default function MyPlaylist() {
  // {collectionId, name?, kind?}:只是「要打开哪个歌单」,不是数据本身。
  const [selection, setSelection] = useState(null);
  const songLyric = useSongLyric();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef(null);

  // 安卓返回键 / 浏览器后退:先收歌单页的「更多操作」菜单。
  useBackLayer({
    active: moreOpen,
    name: 'playlist-more-menu',
    onBack: () => { setMoreOpen(false); },
  });

  const lastErrorRef = useRef(null);
  const { play, isPlaying, isPaused, togglePlay } = usePlayer();
  const { user, offline } = useAuth();
  const feedback = useFeedback();
  const { remove, collections } = useCollections();
  const queryClient = useQueryClient();
  const userId = user?.id || 0;
  const collectionId = selection?.collectionId != null ? selection.collectionId : null;
  const queryKey = collectionSongsQueryKey(collectionId);
  const currentCollection = collections.find((c) => c.id === collectionId);
  const currentName = selection?.name || currentCollection?.name || '歌单';
  const collectionKind = selection?.kind || currentCollection?.kind;
  const canDeleteCollection = !offline && Boolean(collectionKind) && collectionKind !== 'favorite';
  const taskKey = userId > 0 && collectionId != null
    ? `user:${userId}:collection:${collectionId}`
    : '';

  // 唯一的取数入口:同一歌单并发挂载/StrictMode 双调用都由 react-query 去重,
  // 缓存命中时不重放骨架(骨架只在 isLoading = 首次无数据时出现)。
  const state = useQuery(
    queryKey,
    async () => {
      const data = await getCollectionSongs(collectionId);
      return Array.isArray(data) ? data : (data?.songs || []);
    },
    { enabled: collectionId != null && !offline, retry: false },
  );
  const songs = offline ? EMPTY_SONGS : (state.data || EMPTY_SONGS);
  const loading = !offline && collectionId != null && state.isLoading;

  // 顶部搜索框在本页 = 筛当前歌单（用户明确要求：其他页面的搜索应对应当前歌单）。
  // 只有真正打开了一个歌单时才注册；停留在歌单列表选择界面时保持全网搜索行为。
  const [filterQuery, setFilterQuery] = useState('');
  const filter = useSongFilter(songs, filterQuery);
  useRegisterPageSearchFilter(
    collectionId != null
      ? {
        placeholder: `在「${currentName}」中搜索…`,
        count: filter.filtered.length,
        total: filter.total,
        onSearch: (keyword) => setFilterQuery(keyword || ''),
      }
      : null,
  );

  // 切换歌单时必须清掉过滤词：否则在 A 歌单筛过的词会继续作用到 B 歌单，
  // 表现为"刚点开新歌单就是空的"。
  useEffect(() => { setFilterQuery(''); }, [collectionId]);

  // 失败反馈:按错误对象去重,StrictMode 重复挂载 effect 不会连弹两次。
  useEffect(() => {
    const err = state.error;
    if (!err) { lastErrorRef.current = null; return; }
    if (lastErrorRef.current === err) return;
    lastErrorRef.current = err;
    feedback.error(`加载歌单失败:${err?.response?.data?.error || err?.message || '请稍后重试'}`);
  }, [state.error, feedback]);

  const {
    bulkDownload, bulkCache, handleDownloadAll, handleCacheAll, hasAnyState,
  } = useBulkActions({ taskKey, songs, scopePrefix: 'collection' });

  // 来源 1:playlistBus(侧栏点击后延 60ms 派发)。只决定打开哪个歌单。
  useEffect(() => onOpenPlaylist((m) => {
    if (!m || m.collectionId == null) return;
    setSelection((current) => mergeCollectionSelection(current, m));
  }), []);

  // 来源 2:哈希路由(#myplaylist/<id>,刷新/直达/前进后退)。同样只决定打开哪个歌单。
  useEffect(() => {
    const fromHash = () => {
      const id = parseCollectionIdFromHash(window.location.hash);
      if (id != null) {
        setSelection((current) => mergeCollectionSelection(current, { collectionId: id }));
      }
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);

  if (!selection) {
    return (
      <EmptyState
        icon={Play}
        title="从左侧选择一个歌单"
        description="自建歌单、「我喜欢」和导入的平台歌单都在侧栏「我的歌单」里。"
      />
    );
  }

  // 乐观更新 query 缓存 + 失败回滚。query key 必须与读取时同一个来源(collectionSongsQueryKey),
  // 否则会写到另一个 key 上,出现「移除了但刷新又回来」。
  const handleRemove = async (song) => {
    if (offline || collectionId == null) return;
    const targetKey = songIdentityKey(song);
    await queryClient.cancelQueries(queryKey);
    const prev = queryClient.getQueryData(queryKey);
    queryClient.setQueryData(queryKey, (old) => (
      (Array.isArray(old) ? old : []).filter((x) => songIdentityKey(x) !== targetKey)
    ));
    try {
      await removeSongFromCollection(collectionId, song);
      feedback.success(collectionKind === 'favorite' ? '已取消喜欢' : '已从歌单移除');
    } catch (err) {
      if (prev === undefined) queryClient.invalidateQueries(queryKey);
      else queryClient.setQueryData(queryKey, prev);
      feedback.error(`移除失败:${err?.response?.data?.error || err?.message || '请稍后重试'}`);
    }
  };

  // 行内心形 / 菜单「取消收藏」→ 本页列表同步。
  //
  // SongRow 只知道自己那一行;「我喜欢」是一张**由收藏集合驱动的列表**,
  // 所以收藏态一变,列表本身就必须跟着增删,否则用户看到"心灭了,歌还在"。
  // 走乐观更新(先改缓存再发请求),失败由 SongRow 广播回滚值,这里再插回原位。
  // 自建歌单不参与:在自建歌单里收藏/取消收藏不该让歌从该歌单消失。
  const handleRowFavoriteChange = async (song, favorited) => {
    if (collectionId == null || !isFavoriteCollection(collectionKind)) return;
    const previous = queryClient.getQueryData(queryKey);
    const removedAt = findSongIndexInList(previous, song);

    if (!favorited) {
      if (removedAt < 0) return;
      await queryClient.cancelQueries(queryKey);
      queryClient.setQueryData(queryKey, (old) => removeSongFromList(old, song));
      return;
    }

    // 收藏(加回「我喜欢」):按原下标插回,没有原位置就追加到末尾。
    queryClient.setQueryData(queryKey, (old) => insertSongIntoList(old, song, removedAt >= 0 ? removedAt : undefined));
  };

  const handleDeleteCollection = async () => {
    if (!canDeleteCollection) return;
    setMoreOpen(false);
    const ok = await feedback.confirm({
      title: `删除歌单「${currentName}」?`,
      body: '只删除歌单记录，不会删除服务器「已下载」里的歌曲文件。',
      confirmLabel: '删除歌单',
      danger: true,
    });
    if (!ok) return;
    try {
      await remove(collectionId);
      setSelection(null);
      // 歌单已不存在,清掉它的缓存,避免之后 hash 回到同一 id 时显示已删除的内容。
      queryClient.removeQueries(queryKey, { exact: true });
      feedback.success('歌单已删除');
    } catch (err) {
      feedback.error(`删除歌单失败:${err?.response?.data?.error || err?.message || '请稍后重试'}`);
    }
  };

  const downloadLabel = bulkDownload.phase === 'done' ? '已下载'
    : bulkDownload.phase === 'fail' ? '重试下载'
      : bulkDownload.phase === 'running' ? `下载中 ${bulkDownload.done || 0}/${bulkDownload.total || songs.length}`
        : '下载到服务器';
  const cacheLabel = bulkCache.phase === 'done' ? '已缓存'
    : bulkCache.phase === 'fail' ? '重试缓存'
      : bulkCache.phase === 'running' ? `缓存中 ${bulkCache.done || 0}/${bulkCache.total || songs.length}`
        : '缓存到本机';
  const collectionLabel = collectionKind === 'favorite' ? '我喜欢' : '歌单';
  const rowRemoveTitle = collectionKind === 'favorite' ? '取消喜欢' : '从歌单移除';
  const rowRemoveHint = collectionKind === 'favorite' ? '只从我喜欢里移除' : '只从当前歌单移除';

  return (
    <div>
      {/* m3u 导入进度:进度条自己订阅 importProgressBus,没有导入任务时渲染 null。
          放在 header 之前 —— 用户点完导入就被导航到这里,第一眼就能看到进度。 */}
      <ImportProgressBar />
      <header className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end">
        <CoverMosaic items={songs} icon={Play} iconSize={36} />
        <div className="min-w-0 flex-1">
          <p className="type-micro uppercase tracking-wider text-muted-foreground">{collectionLabel}</p>
          <h1 className="mt-0.5 line-clamp-2 type-hero text-foreground">{currentName}</h1>
          <p className="mt-1 type-caption text-muted-foreground nums">{songs.length} 首</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              onClick={() => songs.length && play(songs[0], songs)}
              disabled={!songs.length}
            >
              <Play size={16} fill="currentColor" aria-hidden="true" />
              播放全部
            </Button>
            <Button
              variant="secondary"
              onClick={handleDownloadAll}
              loading={bulkDownload.phase === 'running'}
              disabled={!songs.length || offline || bulkDownload.phase === 'running'}
              title={offline ? '离线状态无法下载到服务器' : '把这张歌单全部存到服务器曲库'}
            >
              <Download size={16} aria-hidden="true" />
              {downloadLabel}
            </Button>
            <Button
              variant="secondary"
              onClick={handleCacheAll}
              loading={bulkCache.phase === 'running'}
              disabled={!songs.length || offline || bulkCache.phase === 'running'}
              title={offline ? '离线状态无法缓存新歌曲' : '存到当前浏览器/PWA，可离线听'}
            >
              <HardDriveDownload size={16} aria-hidden="true" />
              {cacheLabel}
            </Button>
            {canDeleteCollection && (
              <>
                <Button
                  ref={moreRef}
                  variant="ghost"
                  onClick={() => setMoreOpen((open) => !open)}
                  aria-haspopup="menu"
                  aria-expanded={moreOpen}
                  title="更多操作"
                >
                  <Ellipsis size={16} aria-hidden="true" />
                  更多
                </Button>
                <MenuPopover anchorRef={moreRef} open={moreOpen} onClose={() => setMoreOpen(false)} width="w-52">
                  <MenuItem
                    icon={Trash2}
                    label="删除歌单"
                    hint="不会删除服务器文件"
                    onClick={handleDeleteCollection}
                    danger
                  />
                </MenuPopover>
              </>
            )}
          </div>
        </div>
      </header>

      {hasAnyState && (
        <StatusLine
          tone={[bulkDownload.phase, bulkCache.phase].includes('fail') ? 'error' : 'neutral'}
          loading={[bulkDownload.phase, bulkCache.phase].includes('running')}
          className="mb-3"
        >
          服务器 {bulkDownload.phase === 'idle' ? '—' : `${bulkDownload.done || 0}/${bulkDownload.total || 0}${bulkDownload.fail ? ` · 失败 ${bulkDownload.fail}` : ''}`}
          <span className="mx-2 text-border">|</span>
          本机 {bulkCache.phase === 'idle' ? '—' : `${bulkCache.done || 0}/${bulkCache.total || 0}${bulkCache.fail ? ` · 失败 ${bulkCache.fail}` : ''}`}
        </StatusLine>
      )}

      {loading && (
        <LoadingState title="加载歌单" detail="正在读取歌曲、专辑和封面信息" rows={5} />
      )}

      {!loading && songs.length === 0 && (
        <EmptyState
          icon={Download}
          title="这个歌单还没有歌"
          description="去「找歌」搜索后，用行内「加入歌单」把歌存进来。"
          action={(
            <Button variant="primary" onClick={() => { pushRouteEntry('download'); }}>
              去找歌
            </Button>
          )}
        />
      )}

      {/* 过滤中且一条都没命中：明确告诉用户"不是歌单空了"，并给一键清除。
          否则用户会以为歌单出问题（真实的空歌单提示在上一段）。 */}
      {!loading && songs.length > 0 && filter.active && filter.filtered.length === 0 && (
        <EmptyState
          icon={Search}
          title={`「${filterQuery.trim()}」没有匹配的歌曲`}
          description={`当前歌单共 ${filter.total} 首，换个词试试，或清除筛选看全部。`}
          action={(
            <Button variant="secondary" onClick={() => setFilterQuery('')}>
              清除筛选
            </Button>
          )}
        />
      )}

      {!loading && filter.filtered.length > 0 && (
        <>
          <SongListHeader />
          <div className="space-y-0.5">
            {filter.filtered.map((song, i) => (
              <SongRow
                key={songIdentityKey(song)}
                song={song}
                index={i}
                isPlaying={isPlaying(song)}
                // 队列必须是**过滤后**的列表：否则显示的是筛选结果，
                // 播完一首却混进没显示的歌，表现为"下一首不对劲"。
                onPlay={(s) => play(s, filter.filtered)}
                isPaused={isPaused}
                onTogglePlayback={togglePlay}
                onShowLyric={songLyric.open}
                onRemove={handleRemove}
                onFavoriteChange={handleRowFavoriteChange}
                removeTitle={rowRemoveTitle}
                removeHint={rowRemoveHint}
              />
            ))}
          </div>
        </>
      )}

      <LyricDialog {...songLyric.viewProps} />
    </div>
  );
}
