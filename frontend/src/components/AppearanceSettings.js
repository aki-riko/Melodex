import React from 'react';
import { Check } from 'lucide-react';
import { useTheme } from '../theme/ThemeContext.jsx';
import { THEMES } from '../theme/themes.js';
import { cn } from '../ui/cn';

// 设置页的「外观」区:主题切换。
//
// 设计取舍:
//   · 切换即时生效(不需要保存按钮),因为主题只是 documentElement 上的一个属性;
//   · 预览色块用的是 index.css 里的 .theme-swatch--* 变量,不在这里复制色值 ——
//     否则以后调色只改一处、预览却还是旧的;
//   · 选择记在 localStorage(设备级),与音量/播放模式一致;要跨设备同步得挪到后端 user_prefs。
export default function AppearanceSettings() {
  const { themeId, setTheme } = useTheme();

  return (
    <section aria-labelledby="settings-appearance">
      <h3 id="settings-appearance" className="text-xl font-semibold mb-2">
        外观
      </h3>
      <p className="text-xs text-muted-foreground mb-3">
        只影响这个设备(和音量、播放模式一样存在本机)。切换即时生效，不需要重启。
      </p>
      <div role="radiogroup" aria-label="界面主题" className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {THEMES.map((theme) => {
          const active = theme.id === themeId;
          return (
            <button
              key={theme.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setTheme(theme.id)}
              className={cn(
                'flex items-center gap-3 rounded-lg border p-3 text-left transition-colors duration-base ease-standard',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--ring))]',
                active
                  ? 'border-primary bg-secondary'
                  : 'border-border surface hover:border-muted-foreground/40 hover:bg-secondary/60',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'h-12 w-12 flex-shrink-0 rounded-md border border-border theme-swatch',
                  theme.swatchClass,
                )}
              />
              <span className="min-w-0 flex-grow">
                <span className="flex items-center gap-1.5 type-body font-semibold">
                  {theme.name}
                  {active && <Check size={14} className="text-primary" aria-hidden="true" />}
                </span>
                <span className="mt-0.5 block type-micro text-muted-foreground">{theme.tagline}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
