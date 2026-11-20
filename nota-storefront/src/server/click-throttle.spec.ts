import { ClickThrottle } from './click-throttle';

describe('ClickThrottle', () => {
  it('counts up to the limit per key and window, then says no; another key and the next window are fresh', () => {
    let now = 1_000;
    const throttle = new ClickThrottle(3, 60_000, () => now);
    expect([1, 2, 3, 4, 5].map(() => throttle.allow('1.2.3.4|camp'))).toEqual([true, true, true, false, false]);
    expect(throttle.allow('5.6.7.8|camp')).toBeTrue();
    expect(throttle.allow('1.2.3.4|other')).toBeTrue();
    now += 59_999;
    expect(throttle.allow('1.2.3.4|camp')).toBeFalse();
    now += 1;
    expect(throttle.allow('1.2.3.4|camp')).toBeTrue();
  });

  it('keeps memory bounded: expired windows go first, then the oldest half', () => {
    let now = 0;
    const throttle = new ClickThrottle(1, 60_000, () => now, 10);
    for (let i = 0; i < 10; i += 1) throttle.allow(`ip${i}|c`);
    expect(throttle.size()).toBe(10);
    now = 61_000;
    throttle.allow('fresh|c');
    expect(throttle.size()).toBe(1);
    now = 62_000;
    for (let i = 0; i < 40; i += 1) throttle.allow(`flood${i}|c`);
    expect(throttle.size()).toBeLessThanOrEqual(10);
  });
});
