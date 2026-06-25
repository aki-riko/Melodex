module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'text': '#121111',
        'background': '#fbf8f8',
        'primary': '#dc0f11',
        'secondary': '#e88485',
        'accent': '#f53f42',
      },
      animation: {
        'spin-slow': 'spin 20s linear infinite',
      },
      backdropBlur: {
        'xs': '2px',
      },
      userSelect: {
        none: 'none',
        text: 'text',
        all: 'all',
        auto: 'auto',
      },
    },
  },
  variants: {
    extend: {
      userSelect: ['responsive'],
    },
  },
  plugins: [],
};
