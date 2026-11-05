import { Injectable, signal } from '@angular/core';
import { BehaviorSubject, Observable, Subject, filter, map, race, take } from 'rxjs';
import { readLockedFlag, writeLockedFlag } from './session-storage';

/**
 * Stage 15: whether this window's screen is locked. No dependencies, so the HTTP interceptor and
 * AuthService can use it without a circular injection. IdleLockService decides when to lock.
 * Locking never changes the token: requests already running finish, new ones wait for unlock.
 */
@Injectable({ providedIn: 'root' })
export class LockStateService {
  readonly locked = signal(readLockedFlag());
  private readonly open$ = new BehaviorSubject<boolean>(!this.locked());
  private readonly sessionCleared$ = new Subject<void>();

  lock(): void {
    if (this.locked()) return;
    this.locked.set(true);
    writeLockedFlag(true);
    this.open$.next(false);
  }

  unlock(): void {
    if (!this.locked()) return;
    this.locked.set(false);
    writeLockedFlag(false);
    this.open$.next(true);
  }

  /** Ends the lock because the session ended. Waiting requests are cancelled, not released. */
  clear(): void {
    this.locked.set(false);
    writeLockedFlag(false);
    this.sessionCleared$.next();
    // Keep the state accurate for future subscribers; existing waiters already chose sessionCleared$.
    this.open$.next(true);
  }

  /** Emits only for a real unlock; completes without emitting when the session is cleared. */
  whenUnlocked(): Observable<void> {
    return race(
      this.open$.pipe(filter(Boolean), map(() => true as const)),
      this.sessionCleared$.pipe(map(() => false as const))
    ).pipe(
      take(1),
      filter((released) => released),
      map(() => undefined)
    );
  }
}
