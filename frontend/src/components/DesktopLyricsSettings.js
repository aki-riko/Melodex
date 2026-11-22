import React from 'react';
import { MonitorUp } from 'lucide-react';
import { isDesktopShell } from '../platform/desktopShell.js';

/**
 * 桌面歌词说明。
 *
 * 2026-11 架构变更：旧版是「浏览器播放 + 独立歌词助手」，跨进程所以需要
 * 一次性配对码 + 设备令牌。新客户端里播放与歌词窗在同一进程内，
 * 壳直接转发状态，**开箱即用、无需配对**。
 *
 * 这里因此不再提供配对码生成/设备管理，只说明用法与前提。
 */
const DesktopLyricsSettings = () => {
  const inShell = isDesktopShell();

  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xl font-semibold">透明桌面歌词</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            在桌面客户端内播放时，歌词会自动显示为无边框透明窗口，始终置顶并支持鼠标穿透。
          </p>
        </div>
        <MonitorUp className="flex-shrink-0 text-primary" size={24} />
      </div>

      <div className="rounded-md border border-border surface p-4">
        {inShell ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>无需配对：客户端内播放有歌词的歌曲时会自动出现。</li>
            <li>歌词窗按钮可直接上一首 / 播放暂停 / 下一首。</li>
            <li>默认鼠标穿透；需要拖动或点按钮时，从系统托盘取消「歌词鼠标穿透」。</li>
            <li>关闭歌词窗不会退出客户端，可从托盘重新唤出主窗口。</li>
          </ul>
        ) : (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>桌面歌词需要 Melodex 桌面客户端，当前是浏览器环境，没有原生歌词窗口。</p>
            <p>
              请安装并打开桌面客户端后再播放；浏览器内仍可在播放页查看逐字歌词与留声机视图。
            </p>
          </div>
        )}
      </div>
    </section>
  );
};

export default DesktopLyricsSettings;
