import { localDateKey } from './local-date';

describe('localDateKey', () => {
  it('uses the local calendar day, not the UTC day (00:30 in Cairo is still yesterday in UTC)', () => {
    expect(localDateKey(new Date(2026, 10, 7, 0, 30))).toBe('2026-11-07');
    expect(localDateKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(localDateKey(new Date(2026, 11, 31, 0, 0, 1))).toBe('2026-12-31');
  });
  it('pads month and day', () => {
    expect(localDateKey(new Date(2026, 2, 4, 12))).toBe('2026-03-04');
  });
});

describe('the shop day at 00:30 Africa/Cairo on 2026-11-16 (Fixes 1: no hour of the day changes the business date)', () => {
  // The clock is pinned to 00:30 LOCAL on 2026-11-16. In Cairo that instant is 22:30 UTC of 2026-11-15, so toISOString() gives the day before;
  // the shop's day is the LOCAL one in every timezone.
  beforeEach(() => jasmine.clock().install());
  afterEach(() => jasmine.clock().uninstall());
  it('"today" with no argument is 2026-11-16', () => {
    jasmine.clock().mockDate(new Date(2026, 10, 16, 0, 30));
    expect(localDateKey()).toBe('2026-11-16');
  });
  it('a datepicker value (local midnight) keeps its day', () => {
    expect(localDateKey(new Date(2026, 10, 16))).toBe('2026-11-16');
    expect(localDateKey(new Date(2026, 10, 16, 0, 30))).toBe('2026-11-16');
  });
});
