import { LockDateService } from './core/accounting-lock/lock-date.service';
import { MOBILE_QUERY } from './core/layout/layout.service';

/**
 * Every spec: the posting forms re-read GET /accounting/lock-date when they open (Stage 22 review). Specs that count HTTP calls
 * (`http.verify()`) must not see that background read, so it is stubbed for all of them; a spec that cares about it reads
 * `lockRefreshSpy()` (calls) or turns the real call on with `.and.callThrough()` (lock-date.spec.ts).
 */
beforeEach(() => {
  spyOn(LockDateService.prototype, 'refresh').and.stub();
});

/**
 * Online Stage 6A: the Karma window is narrower than 768 px, which would put every existing spec on the phone layout. They are all
 * about the desktop layout, so the phone breakpoint reads "not mobile" unless a spec provides its own LayoutService (the mobile specs do).
 * Every other media query is answered by the browser as before.
 */
const realMatchMedia = window.matchMedia.bind(window);
// A plain replacement, not a spy: other specs (ThemeService) spy on matchMedia themselves.
beforeEach(() => {
  window.matchMedia = ((query: string) => (query === MOBILE_QUERY
    ? ({ matches: false, media: query, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false } as MediaQueryList)
    : realMatchMedia(query))) as typeof window.matchMedia;
});

export const lockRefreshSpy = (): jasmine.Spy => LockDateService.prototype.refresh as unknown as jasmine.Spy;
