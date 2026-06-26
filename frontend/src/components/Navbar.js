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
      className={`bg-background border-b border-border sticky top-0 z-50 transition-transform duration-300 ${
        shouldShow ? 'translate-y-0' : '-translate-y-full'
      }`}
    >
      <div className="container mx-auto container-padding py-3 flex justify-between items-center flex-wrap gap-3">
        <a
          href="#home"
          className="text-2xl font-bold bg-primary text-primary-foreground px-3 py-1 rounded-md shadow-brutal-sm transition-colors hover:bg-[#106EBE]"
          onClick={(e) => {
            e.preventDefault();
            handleLinkClick('Home');
          }}
        >
          TuneScout+
        </a>
        <ul className="flex flex-wrap gap-2 text-sm">
          {sections.map((item) => (
            <li key={item.key}>
              <a
                href={`#${item.key.toLowerCase()}`}
                className={`inline-block px-3 py-1.5 border border-border rounded-md font-medium transition-colors ${
                  currentSection === item.key
                    ? 'bg-primary text-primary-foreground shadow-brutal-sm'
                    : 'bg-card hover:bg-secondary shadow-brutal-sm'
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
