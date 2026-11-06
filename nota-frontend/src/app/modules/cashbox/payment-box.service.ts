import { Injectable, computed, inject, signal } from '@angular/core';
import { AuthService } from '../../core/auth/auth.service';
import { CashboxService } from './cashbox.service';
import { PaymentBox } from './cashbox.models';

const STORAGE_KEY = 'nota.paymentBox';

const readChoice = (): string | null => {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

const writeChoice = (value: string | null): void => {
  try {
    if (value) sessionStorage.setItem(STORAGE_KEY, value);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private window: the choice just lasts until the page reloads */
  }
};

/**
 * Stage 19: "طريقة الدفع". The boxes this user may pay into (their PC's drawer + wallets/banks; the main box
 * only for cashbox.manage, or when the PC has no drawer) and the one a document defaults to.
 *
 * The choice is remembered for the session on this PC. `boxId()` is what goes into a request: undefined while the
 * user keeps the default (the backend then picks this PC's drawer, else the main box, exactly as before), the
 * chosen box's id otherwise.
 */
@Injectable({ providedIn: 'root' })
export class PaymentBoxService {
  private readonly cashbox = inject(CashboxService);
  private readonly auth = inject(AuthService);

  readonly boxes = signal<PaymentBox[]>([]);
  readonly defaultBoxId = signal('');
  /** The main box: always a valid deposit target for a closing shift. */
  readonly mainBox = signal<{ _id: string; name: string } | null>(null);
  readonly loaded = signal(false);
  readonly loadFailed = signal(false);
  private readonly choice = signal<string | null>(readChoice());

  /** The box documents go through now. */
  readonly effective = computed<PaymentBox | null>(() => {
    const list = this.boxes();
    return list.find((box) => box._id === this.choice()) ?? list.find((box) => box._id === this.defaultBoxId()) ?? list[0] ?? null;
  });

  /** A drawer that needs an open shift and has none. */
  readonly needsShift = computed(() => Boolean(this.effective()?.needsShift));

  /** Only an explicit, non-default choice is sent. */
  readonly boxId = computed<string | undefined>(() => {
    const chosen = this.effective();
    return chosen && chosen._id !== this.defaultBoxId() ? chosen._id : undefined;
  });

  private loading = false;

  /** Loads the list once (force = after a shift was opened or closed). */
  load(force = false): void {
    // Only a signed-in session has boxes to list (every screen that shows the selector needs one anyway).
    if (!this.auth.signedIn() || this.loading || (this.loaded() && !force)) return;
    this.loading = true;
    this.cashbox.paymentBoxes().subscribe({
      next: (response) => {
        const list = Array.isArray(response?.data) ? response.data : [];
        this.boxes.set(list);
        this.defaultBoxId.set(response?.defaultBoxId ?? '');
        this.mainBox.set(response?.mainBox ?? null);
        if (this.choice() && !list.some((box) => box._id === this.choice())) this.select(null);
        this.loaded.set(true);
        this.loadFailed.set(false);
        this.loading = false;
      },
      error: () => {
        this.loadFailed.set(true);
        this.loading = false;
      },
    });
  }

  /** null = back to the default. */
  select(id: string | null): void {
    const value = id && id !== this.defaultBoxId() ? id : null;
    this.choice.set(value);
    writeChoice(value);
  }

  /** The payload with `boxId` added when the user chose a box. */
  withBox<T extends object>(payload: T): T & { boxId?: string } {
    const id = this.boxId();
    return id ? { ...payload, boxId: id } : payload;
  }
}
