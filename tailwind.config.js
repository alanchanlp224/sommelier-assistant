/** @type {import('tailwindcss').Config} */
export default {
  content: ['./popup.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        wine: {
          50: '#fdf2f3',
          100: '#fce7e9',
          200: '#f9d2d6',
          300: '#f4adb4',
          400: '#ec7d89',
          500: '#e04d5e',
          600: '#cc2f42',
          700: '#ac2535',
          800: '#8f2230',
          900: '#722f37',
          950: '#4a1c22',
        },
      },
    },
  },
  plugins: [],
};
