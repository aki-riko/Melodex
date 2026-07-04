import { useState, useEffect, useRef } from 'react';
import { inspectQuality } from '../services/musicdl';
import { songIdentityKey } from '../utils/songIdentity';

// 并发验活:对一批歌曲限并发探测真实可用性,返回每首的状态与进度。
// 状态:undefined=未验, 'pending'=验中, 'ok'=可用(带 size/bitrate), 'dead'=死链
export function useLiveCheck(rawSongs, { enabled = true, concurrency = 6 } = {}) {
  const [status, setStatus] = useState({}); // key -> {state, size?, bitrate?}
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const runIdRef = useRef(0);

  // 用稳定签名判断 songs 是否真的换了(避免排序导致重复验活)
  const sig = rawSongs.map(songIdentityKey).join(',');

  useEffect(() => {
    if (!enabled || rawSongs.length === 0) {
      setStatus({});
      setProgress({ done: 0, total: 0 });
      return;
    }
    const myRun = ++runIdRef.current;
    const list = rawSongs.slice();
    setStatus({});
    setProgress({ done: 0, total: list.length });

    let idx = 0;
    let done = 0;
    let cancelled = false;

    const worker = async () => {
      while (!cancelled) {
        const i = idx++;
        if (i >= list.length) return;
        const song = list[i];
        const key = songIdentityKey(song);
        setStatus((prev) => ({ ...prev, [key]: { state: 'pending' } }));
        let result = { state: 'dead' };
        try {
          const r = await inspectQuality(song);
          if (r && r.valid) {
            const brNum = parseInt(String(r.bitrate).replace(/[^0-9]/g, ''), 10) || 0;
            result = { state: 'ok', size: r.size, bitrate: r.bitrate, bitrateNum: brNum };
          }
        } catch {
          /* 网络错误按死链处理 */
        }
        if (cancelled || runIdRef.current !== myRun) return;
        setStatus((prev) => ({ ...prev, [key]: result }));
        done += 1;
        setProgress({ done, total: list.length });
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, list.length) }, worker);
    Promise.all(workers);

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, enabled, concurrency]);

  return { status, progress };
}
