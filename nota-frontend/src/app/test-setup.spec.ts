import { LockDateService } from './core/accounting-lock/lock-date.service';

/**
 * Every spec: the posting forms re-read GET /accounting/lock-date when they open (Stage 22 review). Specs that count HTTP calls
 * (`http.verify()`) must not see that background read, so it is stubbed for all of them; a spec that cares about it reads
 * `lockRefreshSpy()` (calls) or turns the real call on with `.and.callThrough()` (lock-date.spec.ts).
 */
beforeEach(() => {
  spyOn(LockDateService.prototype, 'refresh').and.stub();
});

export const lockRefreshSpy = (): jasmine.Spy => LockDateService.prototype.refresh as unknown as jasmine.Spy;
