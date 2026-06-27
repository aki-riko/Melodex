import React from 'react';

const sections = [
  { key: 'Home', label: '首页' },
  { key: 'Trending', label: '热门' },
  { key: 'Artists', label: '艺人' },
  { key: 'Discover', label: '发现' },
  { key: 'Download', label: '下载' },
  { key: 'Settings', label: '设置' },
  { key: 'FAQ', label: '帮助' },
];

function Navbar({ onLinkClick, isVisible = true, currentSection }) {
  const shouldShow = isVisible !== false;
  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleLinkClick = (section) => {
    scrollToTop();
    onLinkClick(section);
  };

  return (
    <nav
      className={`bg-background/95 backdrop-blur border-b border-border sticky top-0 z-50 transition-transform duration-300 ${
        shouldShow ? 'translate-y-0' : '-translate-y-full'
      }`}
    >
      <div className="container mx-auto container-padding py-3 flex justify-between items-center flex-wrap gap-3">
        <a
          href="#home"
          className="text-2xl font-black tracking-tight text-primary transition-opacity hover:opacity-80"
          onClick={(e) => {
            e.preventDefault();
            handleLinkClick('Home');
          }}
        >
          TuneScout<span className="text-foreground">+</span>
        </a>
        <ul className="flex flex-wrap gap-1 text-sm">
          {sections.map((item) => (
            <li key={item.key}>
              <a
                href={`#${item.key.toLowerCase()}`}
                className={`inline-block px-3 py-1.5 rounded-full font-medium transition-colors ${
                  currentSection === item.key
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
                }`}
                onClick={(e) => {
                  e.preventDefault();
                  handleLinkClick(item.key);
                }}
                aria-current={currentSection === item.key ? 'page' : undefined}
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

export default Navbar;
