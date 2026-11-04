import { TestBed } from '@angular/core/testing';

import { THEME_STORAGE_KEY, ThemeService } from './theme.service';

describe('ThemeService', () => {
  let osDark: boolean;
  let osListener: ((e: { matches: boolean }) => void) | null;

  function create(): ThemeService {
    TestBed.configureTestingModule({});
    return TestBed.inject(ThemeService);
  }

  const isDarkClass = () => document.documentElement.classList.contains('dark');

  beforeEach(() => {
    osDark = false;
    osListener = null;
    localStorage.removeItem(THEME_STORAGE_KEY);
    spyOn(window, 'matchMedia').and.callFake(() => ({
      matches: osDark,
      addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => (osListener = cb),
    }) as unknown as MediaQueryList);
  });

  afterEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    document.documentElement.classList.remove('dark');
  });

  it('follows the OS when the user never picked a theme, without saving it', () => {
    osDark = true;
    const service = create();
    expect(service.isDarkMode).toBeTrue();
    expect(isDarkClass()).toBeTrue();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();

    osListener!({ matches: false });
    expect(service.isDarkMode).toBeFalse();
    expect(isDarkClass()).toBeFalse();
  });

  it('a saved pick wins over the OS at startup and when the OS changes', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    osDark = true;
    const service = create();
    expect(service.isDarkMode).toBeFalse();

    osListener!({ matches: true });
    expect(service.isDarkMode).toBeFalse();
    expect(isDarkClass()).toBeFalse();
  });

  it('toggling saves the pick, after which OS changes are ignored', () => {
    const service = create();
    service.toggleTheme();
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(isDarkClass()).toBeTrue();

    osListener!({ matches: false });
    expect(service.isDarkMode).toBeTrue();
  });
});
