import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { provideRouter } from '@angular/router';
import { formatMobDate } from './mob-date.pipe';
import { MobileTopBarService } from './mobile-topbar.service';

describe('formatMobDate (Online Stage 6B)', () => {
  it('writes Arabic dates with Arabic digits and the month name', () => {
    const text = formatMobDate('2026-11-16T10:00:00Z', 'ar');
    expect(text).toContain('نوفمبر');
    expect(text).toMatch(/[٠-٩]/);
  });
  it('adds the time when asked, and shows a dash for no date', () => {
    expect(formatMobDate('2026-11-16T10:00:00Z', 'ar', true).length).toBeGreaterThan(formatMobDate('2026-11-16T10:00:00Z', 'ar').length);
    expect(formatMobDate(null, 'ar')).toBe('—');
    expect(formatMobDate('not a date', 'ar')).toBe('—');
  });
});

describe('MobileTopBarService (Online Stage 6B)', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: [provideRouter([{ path: 'a', children: [] }])] }));

  it('lets a screen consume the back button, and clears on navigation', async () => {
    const bar = TestBed.inject(MobileTopBarService);
    let closed = 0;
    bar.state.set({ title: 'مورد', onBack: () => { closed++; return true; } });
    expect(bar.handleBack()).toBeTrue();
    expect(closed).toBe(1);
    await TestBed.inject(Router).navigateByUrl('/a');
    expect(bar.state()).toBeNull();
    expect(bar.handleBack()).toBeFalse();
  });
});
