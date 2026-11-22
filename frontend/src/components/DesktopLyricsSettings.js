import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MonitorUp, Lock, Type, Palette, Move, Eye } from 'lucide-react';
import {
  isDesktopShell,
  getLyricsSettings,
  updateLyricsSettings,
  resetLyricsPosition,
  attachLyricsSettingsBridge,
} from '../platform/desktopShell.js';

/**
 * 桌面歌词设置。
 *
 * 与旧 PrismQML 实现 1:1 对齐（`desktop-prismqml/qml/pages/SettingsPage.qml:44-122`）：
 * 6 项 = 显示 / 锁定 / 字体 / 字号 / 配色 / 位置。
 *
 * 放在**主窗口的设置页**里（旧版就在这），不是独立窗口——用户点「设置」即可看到。
 *
 * 真相源在壳侧（`lyrics_settings.rs`）：这里的读写都经 IPC，组件本身不持久化任何东西。
 * 浏览器环境没有原生歌词窗，只显示说明。
 */

/** 一行设置：左侧标题+说明，右侧控件。与设置页其它区块观感一致。 */
const SettingRow = ({ icon: Icon, title, description, children }) => (
  <div className="flex items-center justify-between gap-4 border-b border-border py-3 last:border-b-0">
    <div className="flex min-w-0 items-start gap-3">
      {Icon ? <Icon className="mt-0.5 flex-shrink-0 text-primary" size={18} /> : null}
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
      </div>
    </div>
    <div className="flex-shrink-0">{children}</div>
  </div>
);

/** 复用的开关：与设置页风格一致 */
const Toggle = ({ checked, onChange, label, disabled }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative h-6 w-11 rounded-full transition-colors duration-150 ${
      checked ? 'bg-primary' : 'bg-muted'
    } ${disabled ? 'cursor-wait opacity-60' : 'cursor-pointer'}`}
  >
    <span
      className={`absolute top-1 h-4 w-4 rounded-full bg-white transition-transform duration-150 ${
        checked ? 'translate-x-6' : 'translate-x-1'
      }`}
    />
  </button>
);

const DesktopLyricsSettings = () => {
  const inShell = isDesktopShell();
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // 首次加载
  useEffect(() => {
    if (!inShell) return undefined;
    let cancelled = false;
    getLyricsSettings().then((value) => {
      if (!cancelled && value) setSettings(value);
    });
    return () => {
      cancelled = true;
    };
  }, [inShell]);

  // 跟随壳侧广播同步（独立设置窗或托盘改了设置时）
  useEffect(() => {
    if (!inShell) return undefined;
    return attachLyricsSettingsBridge((payload) => {
      if (payload) setSettings(payload);
    });
  }, [inShell]);

  /** 提交补丁：失败时回读壳侧真实状态，不让 UI 停留在未保存的值上 */
  const commit = useCallback(
    async (patch, message) => {
      setBusy(true);
      setError('');
      setNotice('');
      const updated = await updateLyricsSettings(patch);
      if (updated) {
        setSettings(updated);
        if (message) setNotice(message);
      } else {
        setError('保存失败，已恢复为当前实际设置');
        const fresh = await getLyricsSettings();
        if (fresh) setSettings(fresh);
      }
      setBusy(false);
    },
    [],
  );

  const handleReset = useCallback(async () => {
    setBusy(true);
    setError('');
    setNotice('');
    const updated = await resetLyricsPosition();
    if (updated) {
      setSettings(updated);
      setNotice('位置已重置为默认（水平居中、垂直 76%）');
    } else {
      setError('重置位置失败');
    }
    setBusy(false);
  }, []);

  // 字号拖动：本地立即响应，松手才落盘（避免每一步都写盘）
  const [draftSize, setDraftSize] = useState(null);
  const shownSize = draftSize ?? settings?.font_size ?? 36;

  const positionText = useMemo(() => {
    if (!settings) return '';
    if (!settings.position_set) return '未保存（解锁后可拖动歌词窗，松手即保存）';
    return `已保存到 ${settings.position_x}, ${settings.position_y}`;
  }, [settings]);

  if (!inShell) {
    return (
      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-xl font-semibold">透明桌面歌词</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              桌面歌词是桌面客户端的原生窗口，浏览器里没有。
            </p>
          </div>
          <MonitorUp className="flex-shrink-0 text-primary" size={24} />
        </div>
        <div className="space-y-2 rounded-md border border-border surface p-4 text-sm text-muted-foreground">
          <p>请安装并打开 Melodex 桌面客户端后再播放；浏览器内仍可在播放页查看逐字歌词与留声机视图。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xl font-semibold">透明桌面歌词</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            播放时显示无边框透明歌词窗，始终置顶。以下设置立即生效并自动保存。
          </p>
        </div>
        <MonitorUp className="flex-shrink-0 text-primary" size={24} />
      </div>

      <div className="rounded-md border border-border surface px-4">
        {!settings ? (
          <div className="py-6 text-center text-sm text-muted-foreground">正在读取桌面歌词设置…</div>
        ) : (
          <>
            {/* 1. 显示桌面歌词 */}
            <SettingRow
              icon={Eye}
              title="显示桌面歌词"
              description="关闭后播放时不再自动弹出，可随时在此重新打开"
            >
              <Toggle
                label="显示桌面歌词"
                checked={Boolean(settings.visible)}
                disabled={busy}
                onChange={(next) =>
                  commit(
                    { visible: next },
                    next ? '已显示桌面歌词' : '已关闭桌面歌词',
                  )
                }
              />
            </SettingRow>

            {/* 2. 锁定桌面歌词 */}
            <SettingRow
              icon={Lock}
              title="锁定桌面歌词"
              description="锁定后鼠标穿透歌词，可继续操作下面的窗口；解锁后才能拖动和点歌词窗按钮"
            >
              <Toggle
                label="锁定桌面歌词"
                checked={Boolean(settings.click_through)}
                disabled={busy}
                onChange={(next) =>
                  commit(
                    { click_through: next },
                    next ? '已锁定（鼠标穿透）' : '已解锁，鼠标移到歌词上可看到控制条',
                  )
                }
              />
            </SettingRow>

            {/* 3. 字体预设 */}
            <SettingRow
              icon={Type}
              title="字体预设"
              description="从适合中文歌词显示的系统字体中选择"
            >
              <select
                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                value={settings.font_preset}
                disabled={busy}
                onChange={(event) => commit({ font_preset: event.target.value })}
              >
                {(settings.font_presets || []).map((item) => (
                  <option key={item.name} value={item.name} style={{ fontFamily: item.family }}>
                    {item.name}
                  </option>
                ))}
              </select>
            </SettingRow>

            {/* 4. 歌词字号 */}
            <SettingRow
              icon={Type}
              title="歌词字号"
              description={`当前 ${shownSize} px（范围 ${settings.font_size_min}~${settings.font_size_max}）`}
            >
              <input
                className="w-40 accent-primary"
                type="range"
                min={settings.font_size_min}
                max={settings.font_size_max}
                step={1}
                value={shownSize}
                disabled={busy}
                onChange={(event) => setDraftSize(Number(event.target.value))}
                onMouseUp={async (event) => {
                  const value = Number(event.currentTarget.value);
                  setDraftSize(null);
                  await commit({ font_size: value });
                }}
                onKeyUp={async (event) => {
                  const value = Number(event.currentTarget.value);
                  setDraftSize(null);
                  await commit({ font_size: value });
                }}
              />
            </SettingRow>

            {/* 5. 配色方案 */}
            <SettingRow
              icon={Palette}
              title="配色方案"
              description="方案同时决定已播放与未播放歌词的颜色"
            >
              <select
                className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                value={settings.color_scheme}
                disabled={busy}
                onChange={(event) => commit({ color_scheme: event.target.value })}
              >
                {(settings.color_schemes || []).map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
            </SettingRow>

            {/* 6. 桌面歌词位置 */}
            <SettingRow
              icon={Move}
              title="桌面歌词位置"
              description={positionText}
            >
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
                disabled={busy}
                onClick={handleReset}
              >
                重置位置
              </button>
            </SettingRow>
          </>
        )}
      </div>

      {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
      {notice && !error ? <p className="mt-2 text-sm text-primary">{notice}</p> : null}

      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
        <li>歌词窗无边框、无背景、始终置顶；鼠标悬停时显示控制条（上一首 / 播放暂停 / 下一首 / 锁定 / 关闭）。</li>
        <li>锁定状态下鼠标会穿透歌词窗，此时不会显示控制条；需要操作时先在上方解除锁定。</li>
      </ul>
    </section>
  );
};

export default DesktopLyricsSettings;
