import React from 'react';

const Footer = () => {
  return (
    <footer className="bg-card text-muted-foreground py-7 mt-4 border-t border-border">
      <div className="container mx-auto container-padding flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="text-sm">
          © 2024 TuneScout+. 仅供学习与技术交流。 <br />
          音乐发现与多源下载二合一。
          <br />
          <span className="text-xs opacity-70">
            界面设计改编自 Adam Lowenthal 的 Spotify Artist Page UI(
            <a
              href="https://codepen.io/alowenthal/pen/rxboRv"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-primary"
            >
              CodePen
            </a>
            ,MIT 许可)。
          </span>
        </div>
        <div className="flex space-x-4">
          <a href="/" className="hover:text-primary transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
              <path d="M24 4.557a9.93 9.93 0 01-2.828.775 4.932 4.932 0 002.165-2.724 9.865 9.865 0 01-3.127 1.195 4.92 4.92 0 00-8.384 4.482 13.96 13.96 0 01-10.141-5.143 4.92 4.92 0 001.523 6.573 4.903 4.903 0 01-2.229-.616c-.054 2.281 1.581 4.415 3.95 4.89a4.93 4.93 0 01-2.224.084 4.922 4.922 0 004.6 3.417A9.868 9.868 0 010 19.54a13.944 13.944 0 007.548 2.212c9.142 0 14.307-7.721 13.995-14.646a9.935 9.935 0 002.457-2.549z"/>
            </svg>
          </a>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
