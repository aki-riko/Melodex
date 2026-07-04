import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
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
      const list = await api.listCollections();
      setCollections(list);
      return list;
    } catch { /* 忽略,UI 自行兜底 */ }
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

  return (
    <Ctx.Provider value={{ collections, refresh, create, remove, addSong, addTarget, setAddTarget }}>
      {children}
    </Ctx.Provider>
  );
};

export const useCollections = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useCollections 必须在 CollectionsProvider 内');
  return c;
};
