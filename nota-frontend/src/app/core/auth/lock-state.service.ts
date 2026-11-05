import { Injectable, signal } from '@angular/core';
import { BehaviorSubject, Observable, filter, map, take } from 'rxjs';
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

  /** Emits once, when the screen is (or becomes) unlocked. */
  whenUnlocked(): Observable<void> {
    return this.open$.pipe(filter(Boolean), take(1), map(() => undefined));
  }
}
