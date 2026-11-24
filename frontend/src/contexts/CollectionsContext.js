import { createContext, useContext, useState, useCallback, useEffect, useMemo } from 'react';
import * as api from '../services/collections';
import { useAuth } from './AuthContext';

const Ctx = createContext(null);

// 自建歌单全局状态:列表 + 刷新 + 增删 + "加歌菜单"目标歌曲。
// 侧栏列歌单、SongRow 触发加歌菜单,共享此 context。
export const CollectionsProvider = ({ children }) => {
  const { offline } = useAuth();
  const [collections, setCollections] = useState([]);
  const [addTarget, setAddTarget] = useState(null); // 待加入歌单的歌(null=菜单关闭)

  const refresh = useCallback(async () => {
    if (offline) {
      setCollections([]);
      return [];
    }
    try {
      const list = await api.listCollections({ includeImported: true });
      setCollections(list);
      return list;
    } catch (error) {
      // 不能静默吞:否则侧栏只会显示"我的歌单为空",而用户区分不出
      // "真没建过歌单"和"加载失败了"。至少留一条可检索的日志。
      console.warn('[collections] 歌单列表加载失败', error);
    }
    return [];
  }, [offline]);

  useEffect(() => { refresh(); }, [refresh]);

  const create = useCallback(async (name) => {
    if (offline) throw new Error('offline');
    const c = await api.createCollection(name);
    await refresh();
    return c;
  }, [offline, refresh]);

  const remove = useCallback(async (id) => {
    if (offline) throw new Error('offline');
    await api.deleteCollection(id);
    await refresh();
  }, [offline, refresh]);

  const addSong = useCallback(async (id, song) => {
    if (offline) throw new Error('offline');
    await api.addSongToCollection(id, song);
  }, [offline]);

  // value 必须稳定:SongRow 等列表行消费此 context,渲染期内联对象会让
  // React.memo 完全失效(每行每次父级渲染都被判为"props 变了")。
  const value = useMemo(
    () => ({ collections, refresh, create, remove, addSong, addTarget, setAddTarget }),
    [collections, refresh, create, remove, addSong, addTarget],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
    </Ctx.Provider>
  );
};

export const useCollections = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useCollections 必须在 CollectionsProvider 内');
  return c;
};
