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
