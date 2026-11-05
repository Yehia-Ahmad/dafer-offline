import { Injectable, inject, signal } from '@angular/core';
import { CanDeactivateFn, NavigationCancel, NavigationEnd, NavigationError, Router } from '@angular/router';

/**
 * Stage 15: one place that knows whether the user would lose work. Screens register a check
 * (POS cart not empty, new credit sale started, product / user / shop profile form changed).
 * Logout, "دخول بمستخدم تاني" and leaving those routes (unsavedWorkGuard) ask first.
 * Forced navigations (session expired, backup restored) call allowNextNavigation() and do not ask.
 */
@Injectable({ providedIn: 'root' })
export class UnsavedWorkService {
  private readonly checks = new Map<string, () => boolean>();
  /** The open confirmation (UnsavedWorkDialogComponent), or null. */
  readonly prompt = signal<{ resolve: (leave: boolean) => void } | null>(null);
  private bypass = false;

  constructor() {
    inject(Router).events.subscribe((event) => {
      if (event instanceof NavigationEnd || event instanceof NavigationCancel || event instanceof NavigationError) this.bypass = false;
    });
  }

  register(key: string, check: () => boolean): () => void {
    this.checks.set(key, check);
    return () => {
      if (this.checks.get(key) === check) this.checks.delete(key);
    };
  }

  hasUnsavedWork(): boolean {
    for (const check of this.checks.values()) {
      try {
        if (check()) return true;
      } catch {
        // a screen being destroyed: nothing to lose there
      }
    }
    return false;
  }

  /** true: nothing to lose, or the user chose to leave it. */
  confirm(): Promise<boolean> {
    if (!this.hasUnsavedWork()) return Promise.resolve(true);
    const open = this.prompt();
    if (open) open.resolve(false);
    return new Promise<boolean>((resolve) => this.prompt.set({ resolve }));
  }

  answer(leave: boolean): void {
    const open = this.prompt();
    this.prompt.set(null);
    open?.resolve(leave);
  }

  /** The next navigation leaves without asking (already confirmed, or forced). */
  allowNextNavigation(): void {
    this.bypass = true;
  }

  /** For the guard: true once after allowNextNavigation(). */
  consumeBypass(): boolean {
    const allowed = this.bypass;
    this.bypass = false;
    return allowed;
  }
}

/** canDeactivate on the routes whose screens register a check. */
export const unsavedWorkGuard: CanDeactivateFn<unknown> = () => {
  const unsaved = inject(UnsavedWorkService);
  return unsaved.consumeBypass() || unsaved.confirm();
};
