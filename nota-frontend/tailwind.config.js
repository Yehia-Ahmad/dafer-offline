/** @type {import('tailwindcss').Config} */
module.exports = {
    content: ['./src/**/*.{html,ts,scss}'],
    theme: {
        screens: {
            'sm': '640px',
            'md': '768px',
            'lg': '1024px',
            'xl': '1280px',
            '2xl': '1536px',
        },
        extend: {
            fontFamily: {
                azonix: ["Azonix", "sans-serif"],
                sans: ["Roboto", "sans-serif"],
                sinkin: ['SinkinSans', 'sans-serif'],
                roboto: ['Roboto', 'sans-serif'],
            },
            fontSize: {
                'azonix-display': ['2.25rem', { lineHeight: '2.5rem' }],
                'azonix-title': ['1.5rem', { lineHeight: '1.8rem' }],
                'azonix-card': ['1.2rem', { lineHeight: '1.5rem' }],
            },
            colors: {
                orange: '#f4d80a',
                light_bg: '#f5f5f5',
                light_card_bg: '#f3eded',
                light_content: '#F8F8F8',
                light_content_bg: '#ffffff',
                light_orange: '#FFDFC2',
                gray_bg: '#252525',
                brown: '#623B14',
                blue: '#66CCFF',
                dark: '#212121',
                gray_dark: '#2F2F2F',
                gray: '#4D4D4D',
                gray_light: '#BDBDBD',
                red: '#BC4B23',
                error: '#FF0000',
            },
        },
    },
    plugins: [],
};
