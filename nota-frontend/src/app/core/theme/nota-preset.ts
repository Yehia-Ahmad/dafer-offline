import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';

/**
 * PrimeNG preset mapped to the Nota design tokens (src/styles/_tokens.scss).
 *
 * The semantic values point at CSS variables, and those variables already flip
 * under ThemeService's `html.dark` class, so the light and dark color schemes
 * share one definition. PrimeNG's darkModeSelector is set to `.dark` too
 * (app.config.ts), so Aura's own dark-only values follow the same switch.
 */
const scheme = {
  primary: {
    color: 'var(--brand)',
    contrastColor: 'var(--on-brand)',
    hoverColor: 'var(--brand-hover)',
    activeColor: 'var(--brand-hover)',
  },
  highlight: {
    background: 'var(--brand-soft)',
    focusBackground: 'var(--brand-soft)',
    color: 'var(--brand-strong-text)',
    focusColor: 'var(--brand-strong-text)',
  },
  mask: {
    background: 'var(--overlay)',
    color: 'var(--text)',
  },
  formField: {
    background: 'var(--surface)',
    disabledBackground: 'var(--surface-2)',
    filledBackground: 'var(--surface-2)',
    filledHoverBackground: 'var(--surface-2)',
    filledFocusBackground: 'var(--surface-2)',
    borderColor: 'var(--border-strong)',
    hoverBorderColor: 'var(--text-muted)',
    focusBorderColor: 'var(--brand)',
    invalidBorderColor: 'var(--danger)',
    color: 'var(--text)',
    disabledColor: 'var(--text-muted)',
    placeholderColor: 'var(--text-muted)',
    invalidPlaceholderColor: 'var(--danger)',
    floatLabelColor: 'var(--text-muted)',
    floatLabelFocusColor: 'var(--brand-strong-text)',
    floatLabelActiveColor: 'var(--text-muted)',
    iconColor: 'var(--text-muted)',
    shadow: 'none',
  },
  text: {
    color: 'var(--text)',
    hoverColor: 'var(--text)',
    mutedColor: 'var(--text-muted)',
    hoverMutedColor: 'var(--text)',
  },
  content: {
    background: 'var(--surface)',
    hoverBackground: 'var(--surface-2)',
    borderColor: 'var(--border)',
    color: 'var(--text)',
    hoverColor: 'var(--text)',
  },
  overlay: {
    select: { background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text)' },
    popover: { background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text)' },
    modal: { background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text)' },
  },
  list: {
    option: {
      focusBackground: 'var(--surface-2)',
      selectedBackground: 'var(--brand-soft)',
      selectedFocusBackground: 'var(--brand-soft)',
      color: 'var(--text)',
      focusColor: 'var(--text)',
      selectedColor: 'var(--brand-strong-text)',
      selectedFocusColor: 'var(--brand-strong-text)',
      icon: { color: 'var(--text-muted)', focusColor: 'var(--text)' },
    },
    optionGroup: { background: 'transparent', color: 'var(--text-muted)' },
  },
};

/** Solid severity button whose text uses the surface color, so it stays readable in both themes. */
const solidButton = (color: string, hover: string) => ({
  background: color,
  hoverBackground: hover,
  activeBackground: hover,
  borderColor: color,
  hoverBorderColor: hover,
  activeBorderColor: hover,
  color: 'var(--surface)',
  hoverColor: 'var(--surface)',
  activeColor: 'var(--surface)',
  focusRing: { color, shadow: 'none' },
});

const buttonScheme = {
  root: {
    primary: {
      background: 'var(--brand)',
      hoverBackground: 'var(--brand-hover)',
      activeBackground: 'var(--brand-hover)',
      borderColor: 'var(--brand)',
      hoverBorderColor: 'var(--brand-hover)',
      activeBorderColor: 'var(--brand-hover)',
      color: 'var(--on-brand)',
      hoverColor: 'var(--on-brand)',
      activeColor: 'var(--on-brand)',
      focusRing: { color: 'var(--brand)', shadow: 'none' },
    },
    secondary: {
      background: 'var(--surface)',
      hoverBackground: 'var(--surface-2)',
      activeBackground: 'var(--surface-2)',
      borderColor: 'var(--border-strong)',
      hoverBorderColor: 'var(--border-strong)',
      activeBorderColor: 'var(--border-strong)',
      color: 'var(--text)',
      hoverColor: 'var(--text)',
      activeColor: 'var(--text)',
      focusRing: { color: 'var(--brand)', shadow: 'none' },
    },
    success: solidButton('var(--success)', 'var(--success)'),
    danger: solidButton('var(--danger)', 'var(--danger)'),
  },
  outlined: {
    primary: { hoverBackground: 'var(--brand-soft)', activeBackground: 'var(--brand-soft)', borderColor: 'var(--brand)', color: 'var(--brand-strong-text)' },
    secondary: { hoverBackground: 'var(--surface-2)', activeBackground: 'var(--surface-2)', borderColor: 'var(--border-strong)', color: 'var(--text)' },
    danger: { hoverBackground: 'var(--danger-soft)', activeBackground: 'var(--danger-soft)', borderColor: 'var(--danger)', color: 'var(--danger)' },
  },
  text: {
    primary: { hoverBackground: 'var(--brand-soft)', activeBackground: 'var(--brand-soft)', color: 'var(--brand-strong-text)' },
    secondary: { hoverBackground: 'var(--surface-2)', activeBackground: 'var(--surface-2)', color: 'var(--text-muted)' },
    danger: { hoverBackground: 'var(--danger-soft)', activeBackground: 'var(--danger-soft)', color: 'var(--danger)' },
  },
};

const toastMessage = (background: string, color: string) => ({
  background,
  borderColor: background,
  color,
  detailColor: 'var(--text)',
  shadow: 'var(--shadow-md)',
  closeButton: { hoverBackground: 'var(--surface-2)', focusRing: { color, shadow: 'none' } },
});

const toastScheme = {
  info: toastMessage('var(--info-soft)', 'var(--info-text)'),
  success: toastMessage('var(--brand-soft)', 'var(--brand-strong-text)'),
  warn: toastMessage('var(--warning-soft)', 'var(--warning-text)'),
  error: toastMessage('var(--danger-soft)', 'var(--danger-text)'),
};

export const NotaPreset = definePreset(Aura, {
  semantic: {
    // Brand green scale around #0E4D45 (600); used where Aura reads palette steps directly.
    primary: {
      50: '#E6EFEC',
      100: '#C7DDD7',
      200: '#9FC9BE',
      300: '#6FAE9F',
      400: '#3F9180',
      500: '#1F7566',
      600: '#0E4D45',
      700: '#0B3F38',
      800: '#08302B',
      900: '#06231F',
      950: '#041714',
    },
    formField: {
      borderRadius: 'var(--radius-control)',
    },
    overlay: {
      select: { borderRadius: 'var(--radius-control-lg)', shadow: 'var(--shadow-md)' },
      popover: { borderRadius: 'var(--radius-control-lg)', shadow: 'var(--shadow-md)' },
      modal: { borderRadius: 'var(--radius-dialog)', shadow: 'var(--shadow-dialog)' },
    },
    colorScheme: {
      light: scheme,
      dark: scheme,
    },
  },
  components: {
    button: {
      colorScheme: { light: buttonScheme, dark: buttonScheme },
    },
    dialog: {
      title: { fontSize: '1.25rem', fontWeight: '800' },
    },
    datatable: {
      headerCell: { background: 'var(--surface-2)', color: 'var(--text-muted)', borderColor: 'var(--border)' },
      columnTitle: { fontWeight: '700' },
      bodyCell: { borderColor: 'var(--line)' },
      row: { background: 'var(--surface)', hoverBackground: 'var(--surface-2)', color: 'var(--text)' },
      colorScheme: {
        light: { root: { borderColor: 'var(--border)' }, row: { stripedBackground: 'var(--surface-2)' } },
        dark: { root: { borderColor: 'var(--border)' }, row: { stripedBackground: 'var(--surface-2)' } },
      },
    },
    toast: {
      colorScheme: { light: toastScheme, dark: toastScheme },
    },
  },
});
