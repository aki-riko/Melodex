import React from 'react';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '../theme/ThemeContext.jsx';
import { cn } from '../ui/cn';

// 设置页的「外观」区:深浅色模式切换。
//
// 设计取舍:
//   · 全站只有 Fluent 一套设计语言,所以这里选择的是**模式**(跟随系统/浅色/深色),
//     不是皮肤。切换即时生效 —— 主题只是 documentElement 上的一个属性;
//   · 「跟随系统」是默认:音乐 App 常伴随系统夜间模式使用,手选固定明暗反而更少用;
//   · 选择记在 localStorage(设备级),与音量/播放模式一致。
//
// 图标直接用 Monitor/Sun/Moon,不再做色块预览:
// 色块原本用于区分"两套皮肤",现在皮肤只有一个,色块就失去意义了 ——
// 明暗是同一套设计语言的两种取值,用图标 + 文字更直接。
const MODE_ICONS = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

export default function AppearanceSettings() {
  const { mode, setMode, modes } = useTheme();

  return (
    <section aria-labelledby="settings-appearance">
      <h3 id="settings-appearance" className="text-xl font-semibold mb-2">
        外观
      </h3>
      <p className="text-xs text-muted-foreground mb-3">
        全站使用 Fluent Design。「跟随系统」会随设备的深浅色设置自动切换。
        只影响这个设备(和音量、播放模式一样存在本机),切换即时生效。
      </p>
      <div role="radiogroup" aria-label="深浅色模式" className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
        {modes.map((item) => {
          const Icon = MODE_ICONS[item.id] || Monitor;
          const active = item.id === mode;
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setMode(item.id)}
              className={cn(
                'flex items-center gap-3 rounded-lg border p-3 text-left transition-colors duration-base ease-standard',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--ring))]',
                active
                  ? 'border-primary bg-secondary'
                  : 'border-border surface hover:border-muted-foreground/40 hover:bg-secondary/60',
              )}
            >
              <Icon
                size={20}
                aria-hidden="true"
                className={cn('flex-shrink-0', active ? 'text-primary' : 'text-muted-foreground')}
              />
              <span className="min-w-0 flex-grow">
                <span className="flex items-center gap-1.5 type-body font-semibold">
                  {item.name}
                  {active && <Check size={14} className="text-primary" aria-hidden="true" />}
                </span>
                <span className="mt-0.5 block type-micro text-muted-foreground">{item.tagline}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
