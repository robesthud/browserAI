/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // нейтральный серый (чуть светлее, без коричневого подтона) — мягче для глаз
        graphite: {
          900: '#24262b', // основной фон
          850: '#282b30', // чуть светлее
          800: '#2e3138', // сайдбар / карточки
          750: '#363a42', // hover / активный элемент
          700: '#404550',
          600: '#4d525d',
        },
        // мягкий светло-серый акцент (как текст в этом интерфейсе)
        cream: {
          DEFAULT: '#e6e8ec',
          soft: '#cfd3da',
          dim: '#a6abb5',
          faint: '#7c828d',
        },
      },
      fontFamily: {
        serif: ['Georgia', 'Cambria', '"Times New Roman"', 'serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        '2xl': '1.25rem',
        '3xl': '1.75rem',
      },
    },
  },
  plugins: [],
}
