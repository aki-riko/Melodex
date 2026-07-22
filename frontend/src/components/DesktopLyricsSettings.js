import React, { useEffect, useState } from 'react';
import { useQuery } from 'react-query';
import { Check, Copy, MonitorUp, RefreshCw, Trash2 } from 'lucide-react';
import {
  createDesktopLyricsPairing,
  getDesktopLyricsDevices,
  revokeDesktopLyricsDevice,
} from '../services/musicdl';

const fmtDeviceTime = (value) => {
  if (!value) return '尚未连接';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : date.toLocaleString('zh-CN');
};

const DesktopLyricsSettings = () => {
  const devices = useQuery(['desktop-lyrics-devices'], getDesktopLyricsDevices);
  const [pairing, setPairing] = useState(null);
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!pairing?.expires_at) {
      setRemaining(0);
      return undefined;
    }
    const update = () => {
      const ms = new Date(pairing.expires_at).getTime() - Date.now();
      setRemaining(Math.max(0, Math.ceil(ms / 1000)));
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [pairing]);

  const createPairing = async () => {
    setBusy(true);
    setError('');
    setCopied(false);
    try {
      setPairing(await createDesktopLyricsPairing());
    } catch (requestError) {
      console.warn('生成桌面歌词配对码失败', requestError);
      setError(requestError?.response?.data?.error || requestError?.message || '生成配对码失败');
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async () => {
    if (!pairing?.code) return;
    try {
      await navigator.clipboard.writeText(pairing.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (copyError) {
      console.warn('复制桌面歌词配对码失败', copyError);
      setError('复制失败，请手动选中配对码');
    }
  };

  const revoke = async (device) => {
    if (!window.confirm(`确定移除“${device.name}”吗？移除后该助手必须重新配对。`)) return;
    try {
      await revokeDesktopLyricsDevice(device.id);
      await devices.refetch();
    } catch (requestError) {
      console.warn('移除桌面歌词设备失败', requestError);
      setError(requestError?.response?.data?.error || requestError?.message || '移除设备失败');
    }
  };

  const list = devices.data || [];
  const codeExpired = pairing && remaining <= 0;

  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xl font-semibold">透明桌面歌词</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            支持 Windows 和 macOS。浏览器继续播放，原生助手只显示无边框透明歌词并回传上/暂停/下一首。
          </p>
        </div>
        <MonitorUp className="flex-shrink-0 text-primary" size={24} />
      </div>

      <div className="rounded-md border border-border bg-card p-4">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>安装并打开 Melodex 桌面歌词助手。</li>
          <li>助手中填写当前 Melodex 服务地址；不要填写具体 API 路径。</li>
          <li>点击下方按钮，把五分钟内有效的配对码填入助手。</li>
        </ol>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={createPairing}
            disabled={busy}
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
          >
            {busy ? '正在生成…' : '生成一次性配对码'}
          </button>
          {pairing?.code && (
            <button
              type="button"
              onClick={copyCode}
              disabled={codeExpired}
              className="flex items-center gap-2 rounded-md border border-border bg-secondary px-3 py-2 font-mono text-lg font-semibold tracking-wider disabled:opacity-50"
              title="复制配对码"
            >
              {pairing.code}
              {copied ? <Check size={17} className="text-primary" /> : <Copy size={17} />}
            </button>
          )}
          {pairing?.code && (
            <span className={`text-xs ${codeExpired ? 'text-destructive' : 'text-muted-foreground'}`}>
              {codeExpired ? '已过期，请重新生成' : `${remaining} 秒后过期；使用一次即失效`}
            </span>
          )}
        </div>
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </div>

      <div className="mt-4 rounded-md border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="font-semibold">已配对助手</p>
          <button
            type="button"
            onClick={() => devices.refetch()}
            className="text-muted-foreground transition-colors hover:text-foreground"
            title="刷新设备列表"
            aria-label="刷新设备列表"
          >
            <RefreshCw size={17} className={devices.isFetching ? 'animate-spin' : ''} />
          </button>
        </div>
        {devices.isLoading && <p className="px-4 py-3 text-sm text-muted-foreground">正在读取设备…</p>}
        {!devices.isLoading && list.length === 0 && (
          <p className="px-4 py-3 text-sm text-muted-foreground">尚未配对 Windows 或 macOS 助手。</p>
        )}
        {list.map((device) => (
          <div key={device.id} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
            <div className="min-w-0 flex-grow">
              <p className="truncate font-medium">{device.name}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                最近连接：{fmtDeviceTime(device.last_seen_at)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => revoke(device)}
              className="text-muted-foreground transition-colors hover:text-destructive"
              title="移除设备"
              aria-label={`移除 ${device.name}`}
            >
              <Trash2 size={17} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
};

export default DesktopLyricsSettings;
