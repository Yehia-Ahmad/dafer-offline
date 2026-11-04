/** Tailwind color backed by a Nota CSS variable; supports opacity modifiers (bg-brand/10). */
const token = (name) => `color-mix(in srgb, var(--${name}) calc(<alpha-value> * 100%), transparent)`;

const tokenColors = {
    bg: token('bg'),
    surface: token('surface'),
    'surface-2': token('surface-2'),
    border: token('border'),
    'border-strong': token('border-strong'),
    line: token('line'),
    text: token('text'),
    muted: token('text-muted'),
    brand: token('brand'),
    'brand-soft': token('brand-soft'),
    'brand-strong': token('brand-strong-text'),
    accent: token('accent'),
    success: token('success'),
    danger: token('danger'),
    'danger-soft': token('danger-soft'),
    'warning-soft': token('warning-soft'),
    'info-soft': token('info-soft'),
    'neutral-soft': token('neutral-soft'),
    'sidebar-bg': token('sidebar-bg'),
    'sidebar-text': token('sidebar-text'),
    'sidebar-group': token('sidebar-group'),
};

/** @type {import('tailwindcss').Config} */
module.exports = {
    content: ['./src/**/*.{html,ts,scss}'],
    // Follow ThemeService, which toggles the `dark` class on <html>.
    darkMode: 'class',
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
                // Nota: Alexandria everywhere (src/styles/_fonts.scss).
                sans: ['var(--font-sans)'],
            },
            borderRadius: {
                card: 'var(--radius-card)',
                dialog: 'var(--radius-dialog)',
                control: 'var(--radius-control)',
                'control-lg': 'var(--radius-control-lg)',
                pill: 'var(--radius-pill)',
            },
            fontSize: {
                'azonix-display': ['2.25rem', { lineHeight: '2.5rem' }],
                'azonix-title': ['1.5rem', { lineHeight: '1.8rem' }],
                'azonix-card': ['1.2rem', { lineHeight: '1.5rem' }],
            },
            colors: {
                // Nota design tokens (src/styles/_tokens.scss); follow html.dark.
                ...tokenColors,
                // Legacy screen colors; replaced screen by screen in Stages 9-10.
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
