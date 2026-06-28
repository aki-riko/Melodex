import React from 'react';

// 页脚:做成与 FAQ 条目一致的圆角卡片(只在帮助页底部显示),含第三方署名。
const Footer = () => {
  return (
    <div className="bg-card rounded-lg p-5 mt-4 text-sm text-muted-foreground">
      <p className="text-foreground/90">© 2024 Melodex · 仅供学习与技术交流</p>
      <p className="mt-1">音乐发现与多源下载二合一。</p>
      <p className="mt-3 text-xs opacity-70">
        基于开源项目{' '}
        <a href="https://github.com/guohuiyuan/go-music-dl" target="_blank" rel="noopener noreferrer" className="underline hover:text-primary">go-music-dl</a>
        {' '}(AGPL-3.0)与{' '}
        <a href="https://github.com/peter-bf/tunescout" target="_blank" rel="noopener noreferrer" className="underline hover:text-primary">TuneScout</a>
        {' '}构建;界面设计改编自 Adam Lowenthal 的 Spotify Artist Page UI(
        <a
          href="https://codepen.io/alowenthal/pen/rxboRv"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-primary"
        >
          CodePen
        </a>
        ,MIT 许可)。本项目整体采用 AGPL-3.0。
      </p>
    </div>
  );
};

export default Footer;
