import { TestBed } from '@angular/core/testing';
import { LayoutService, MOBILE_QUERY } from './layout.service';

/** Online Stage 6A: one breakpoint (below 768 px) shared by templates and CSS. */
describe('LayoutService (Online Stage 6A)', () => {
  type Listener = (event: MediaQueryListEvent) => void;
  let matches: boolean;
  let listeners: Listener[];

  beforeEach(() => {
    listeners = [];
    // the global test setup replaces matchMedia (the Karma window is narrow): this spec brings its own
    window.matchMedia = ((query: string) => ({
      get matches() { return query === MOBILE_QUERY && matches; },
      media: query,
      addEventListener: (_: string, listener: Listener) => listeners.push(listener),
      removeEventListener: (_: string, listener: Listener) => { listeners = listeners.filter((entry) => entry !== listener); },
    })) as unknown as typeof window.matchMedia;
  });

  it('the query is "below 768 px"', () => {
    expect(MOBILE_QUERY).toBe('(max-width: 767.98px)');
  });

  it('starts from the current width and follows rotation / resize', () => {
    matches = true;
    const service = TestBed.inject(LayoutService);
    expect(service.isMobile()).toBeTrue();

    listeners.forEach((listener) => listener({ matches: false } as MediaQueryListEvent));
    expect(service.isMobile()).toBeFalse();
    listeners.forEach((listener) => listener({ matches: true } as MediaQueryListEvent));
    expect(service.isMobile()).toBeTrue();
  });

  it('is desktop at 768 px and above', () => {
    matches = false;
    expect(TestBed.inject(LayoutService).isMobile()).toBeFalse();
  });
});
