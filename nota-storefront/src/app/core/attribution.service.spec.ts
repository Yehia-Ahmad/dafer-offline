import { TestBed } from '@angular/core/testing';
import { ApiService } from './api.service';
import { ATTRIBUTION_KEY, AttributionService, localDay, parseLanding } from './attribution.service';

describe('attribution', () => {
  let visit: jasmine.Spy;
  let service: AttributionService;
  const at = (iso: string): Date => new Date(iso);

  beforeEach(() => {
    localStorage.clear();
    visit = jasmine.createSpy('visit').and.resolveTo({ ok: true });
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: { visit } }] });
    service = TestBed.inject(AttributionService);
  });

  it('reads utm_campaign, source and medium from a landing URL; anything else is no landing', () => {
    expect(parseLanding('?utm_source=facebook&utm_medium=paid&utm_campaign=Ramadan-1', at('2026-11-16T10:00:00Z')))
      .toEqual({ code: 'ramadan-1', source: 'facebook', medium: 'paid', landedAt: '2026-11-16T10:00:00.000Z' });
    expect(parseLanding('?utm_source=facebook')).toBeNull();
    expect(parseLanding('?utm_campaign=a')).toBeNull();
    expect(parseLanding('?utm_campaign=<script>')).toBeNull();
  });

  it('last click wins: a newer campaign landing replaces the stored one; a landing without utm keeps it', () => {
    service.capture('?utm_campaign=first1&utm_source=facebook&utm_medium=paid', at('2026-11-16T10:00:00Z'));
    service.capture('?utm_campaign=second2&utm_source=tiktok&utm_medium=organic', at('2026-11-17T10:00:00Z'));
    service.capture('?page=2', at('2026-11-18T10:00:00Z'));
    expect(service.current(7, at('2026-11-18T12:00:00Z'))?.code).toBe('second2');
  });

  it('keeps the attribution for the window (default 7 days) and then forgets it', () => {
    service.capture('?utm_campaign=camp123', at('2026-11-10T10:00:00Z'));
    expect(service.forOrder(7, at('2026-11-17T09:00:00Z'))).toEqual({ code: 'camp123', landedAt: '2026-11-10T10:00:00.000Z' });
    expect(service.forOrder(7, at('2026-11-17T11:00:00Z'))).toBeNull();
    expect(localStorage.getItem(ATTRIBUTION_KEY)).toBeNull();
    service.capture('?utm_campaign=camp123', at('2026-11-10T10:00:00Z'));
    expect(service.forOrder(14, at('2026-11-17T11:00:00Z'))).not.toBeNull();
  });

  it('an order only carries the code and the landing time, nothing personal', () => {
    service.capture('?utm_campaign=camp123&utm_source=facebook&utm_medium=paid', at('2026-11-16T10:00:00Z'));
    expect(Object.keys(service.forOrder(7, at('2026-11-16T12:00:00Z'))!).sort()).toEqual(['code', 'landedAt']);
  });

  it('rejects a tampered stored value', () => {
    localStorage.setItem(ATTRIBUTION_KEY, JSON.stringify({ code: '../x', landedAt: '2026-11-16T10:00:00Z' }));
    expect(service.current(7, at('2026-11-16T11:00:00Z'))).toBeNull();
    localStorage.setItem(ATTRIBUTION_KEY, '{not json');
    expect(service.current(7)).toBeNull();
  });

  it('counts one visit per campaign per local day, with a random session id and no personal data', () => {
    expect(service.recordVisit('camp123', new Date(2026, 10, 16, 0, 30))).toBeTrue();
    expect(service.recordVisit('camp123', new Date(2026, 10, 16, 23, 0))).toBeFalse();
    expect(service.recordVisit('other99', new Date(2026, 10, 16, 23, 0))).toBeTrue();
    expect(service.recordVisit('camp123', new Date(2026, 10, 17, 0, 5))).toBeTrue();
    expect(visit).toHaveBeenCalledTimes(3);
    const [code, session] = visit.calls.argsFor(0);
    expect(code).toBe('camp123'); expect(session).toMatch(/^[0-9a-f]{24}$/);
    expect(visit.calls.argsFor(1)[1]).toBe(session, 'the same browser session');
  });

  it('the visit day is the local day, not the UTC day (00:30 local)', () => {
    expect(localDay(new Date(2026, 10, 16, 0, 30))).toBe('2026-11-16');
  });
});
