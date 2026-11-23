/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  // 本项目只有暗色主题(Spotify 风),不存在浅色模式。
  // 显式声明 'class' 而非默认 'media':否则使用者的 OS 若是浅色,
  // `dark:` 变体会失效(SongRow 的 amber 徽章曾因此对比度不足)。
  // 由于全站只有暗色,组件里不应再写 dark: 变体。
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        // 兼容旧用法 text-text(等同 foreground)
        text: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
          // 文字专用档:暗底上需要更亮才够对比。见 index.css 的 --destructive-text。
          text: 'hsl(var(--destructive-text))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
        },
        info: {
          DEFAULT: 'hsl(var(--info))',
          foreground: 'hsl(var(--info-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // 历史上 index.css 定义了 --popover 却没在 config 映射,
        // 于是 bg-popover 渲染成透明(踩过一次"翻层是透明的"事故)。
        // 这里补上,后续浮层统一用它。
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        // 控件圆角:随主题变化(Spotify 主题=9999px 胶囊,Fluent 主题=4px 小圆角)。
        // 可点控件(按钮/输入框/芯片/图标钮)用它,视觉圆形装饰才继续用 rounded-full。
        control: 'var(--radius-control)',
      },
      // 语义化层级:不再散落 z-[55]/z-[61]/z-[90] 这类魔法数字。
      // 顺序即叠放顺序,数字之间留足空隙以便插入新层。
      zIndex: {
        base: '0',
        nav: '20',      // 顶栏(sticky)
        tabbar: '30',   // 移动底部 Tab
        bar: '40',      // 播放条
        popover: '50',  // 行内菜单、下拉、搜索建议
        drawer: '60',   // 移动"更多"抽屉、侧栏悬浮菜单
        sheet: '70',    // 全屏播放页
        modal: '85',    // 对话框
        toast: '90',    // 提示条(必须压过对话框)
        skip: '100',    // 跳过链接
      },
      transitionDuration: {
        fast: 'var(--motion-fast)',
        base: 'var(--motion-base)',
        slow: 'var(--motion-slow)',
      },
      transitionTimingFunction: {
        standard: 'var(--ease-standard)',
        emphasized: 'var(--ease-emphasized)',
        exit: 'var(--ease-exit)',
      },
      boxShadow: {
        subtle: '0 8px 24px rgba(0,0,0,0.18)',
        elevated: '0 16px 40px rgba(0,0,0,0.28)',
        // 浮层统一阴影(替代各处 shadow-xl / shadow-2xl 混用)
        popover: '0 12px 32px rgba(0,0,0,0.5)',
        dialog: '0 24px 64px rgba(0,0,0,0.6)',
      },
      animation: {
        'spin-slow': 'spin 20s linear infinite',
        'fade-in': 'fade-in 180ms var(--ease-standard)',
        'pop-in': 'pop-in 140ms var(--ease-emphasized)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'pop-in': {
          from: { opacity: '0', transform: 'translateY(-4px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      backdropBlur: {
        'xs': '2px',
      },
      // 触控下限:移动端所有可点元素不小于 44px。
      minHeight: {
        touch: '2.75rem',
      },
      minWidth: {
        touch: '2.75rem',
      },
      // ===== 语义尺寸（2026-11 补，治「h-9/h-10/h-11/h-12 混用」）=====
      //
      // ★ 统计依据：全前端按钮高度用了 13 种、图标 18 种（16/17/18/20 混着来）。
      //   同类元素尺寸不一是「看起来乱」的头号来源 —— 不是配色问题，是节奏问题。
      //
      // 用法：`size-icon`（图标）、`size-compact`（密集行内）、
      //       `size-control`（常规按钮）、`size-touch`（移动触控）。
      // 写 `h-control w-control` 都行，值来自 index.css 的两档变量。
      spacing: {
        'size-icon-xs': 'var(--size-icon-xs)',
        'size-icon-sm': 'var(--size-icon-sm)',
        'size-icon-md': 'var(--size-icon-md)',
        'size-icon-lg': 'var(--size-icon-lg)',
        'size-compact': 'var(--size-compact)',
        'size-control': 'var(--size-control)',
        'size-touch': 'var(--size-touch)',
      },
      width: {
        'size-icon-xs': 'var(--size-icon-xs)',
        'size-icon-sm': 'var(--size-icon-sm)',
        'size-icon-md': 'var(--size-icon-md)',
        'size-icon-lg': 'var(--size-icon-lg)',
        'size-compact': 'var(--size-compact)',
        'size-control': 'var(--size-control)',
        'size-touch': 'var(--size-touch)',
      },
      height: {
        'size-icon-xs': 'var(--size-icon-xs)',
        'size-icon-sm': 'var(--size-icon-sm)',
        'size-icon-md': 'var(--size-icon-md)',
        'size-icon-lg': 'var(--size-icon-lg)',
        'size-compact': 'var(--size-compact)',
        'size-control': 'var(--size-control)',
        'size-touch': 'var(--size-touch)',
      },
    },
  },
  plugins: [],
};
