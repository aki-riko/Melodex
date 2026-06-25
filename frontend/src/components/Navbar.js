import React from 'react';

const sections = ['Home', 'Trending', 'Artists', 'Discover', 'FAQ'];

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
      className={`bg-zinc-950/100 backdrop-blur-sm text-text sticky top-0 z-50 transition-transform duration-300 ${
        shouldShow ? 'translate-y-0' : '-translate-y-full'
      }`}
    >
      <div className="container mx-auto container-padding py-3 flex justify-between items-center">
        <a
          href="#home"
          className="text-3xl font-bold text-primary"
          onClick={(e) => {
            e.preventDefault();
            handleLinkClick('Home');
          }}
        >
          TuneScout
        </a>
        <ul className="flex space-x-10 text-lg">
          {sections.map((item) => (
            <li key={item}>
              <a
                href={`#${item.toLowerCase()}`}
                className={`transition duration-300 ease-in-out relative group ${
                  currentSection === item ? 'text-white' : 'text-primary hover:text-white'
                }`}
                onClick={(e) => {
                  e.preventDefault();
                  handleLinkClick(item);
                }}
                aria-current={currentSection === item ? 'page' : undefined}
              >
                {item}
                <span className="absolute left-0 right-0 bottom-0 h-0.5 bg-primary transform scale-x-0 group-hover:scale-x-100 transition-transform duration-300 ease-in-out"></span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

export default Navbar;
