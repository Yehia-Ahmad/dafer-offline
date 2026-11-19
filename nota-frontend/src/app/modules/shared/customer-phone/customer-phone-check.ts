import { signal } from '@angular/core';
import { CustomerPhoneService } from './customer-phone.service';

/**
 * Online Fixes 1: what a sale screen (POS, new credit sale) does when the cashier finishes typing a phone.
 * If the phone already belongs to a customer and the typed name differs, a dialog asks:
 *   «نفس العميل» (default) uses the stored name, «غيّر اسمه لـ …» (only with customers.manage) sends renameCustomer: true,
 *   «الرقم غلط» closes and focuses the phone field. An empty name field is filled with the stored name without asking.
 * The server never renames on its own; this only decides whether the request carries `renameCustomer: true`.
 */
export class CustomerPhoneCheck {
  readonly dialogOpen = signal(false);
  readonly storedName = signal('');
  readonly typedName = signal('');

  private pendingPhone = '';
  private approved: { phone: string; name: string } | null = null;

  constructor(
    private readonly lookup: CustomerPhoneService,
    private readonly canRenameCustomer: () => boolean,
    private readonly fillName: (name: string) => void,
    private readonly focusPhone: () => void,
  ) {}

  get canRename(): boolean {
    return this.canRenameCustomer();
  }

  /** Call when the phone field loses focus (or Enter). */
  check(rawPhone: string, rawName: string): void {
    const phone = (rawPhone ?? '').trim();
    const name = (rawName ?? '').trim();
    if (!phone) {
      this.approved = null;
      return;
    }
    if (this.approved && this.approved.phone === phone && this.approved.name === name) return; // already answered "rename"
    this.lookup.lookup(phone).subscribe({
      next: (found) => {
        if (!found.exists || !found.name) {
          this.approved = null;
          return;
        }
        if (!name) {
          this.fillName(found.name);
          return;
        }
        if (name === found.name) {
          this.approved = null;
          return;
        }
        this.storedName.set(found.name);
        this.typedName.set(name);
        this.pendingPhone = phone;
        this.dialogOpen.set(true);
      },
      error: () => undefined, // the server decides anyway (it never renames by default); no dialog when the lookup fails
    });
  }

  chooseSame(): void {
    this.approved = null;
    this.fillName(this.storedName());
    this.dialogOpen.set(false);
  }

  chooseRename(): void {
    if (!this.canRename) return;
    this.approved = { phone: this.pendingPhone, name: this.typedName() };
    this.dialogOpen.set(false);
  }

  chooseWrong(): void {
    this.approved = null;
    this.dialogOpen.set(false);
    this.focusPhone();
  }

  /** True when the cashier chose to rename AND the form still has that phone and name. */
  renameFlagFor(rawPhone: string, rawName: string): boolean {
    return Boolean(this.approved && this.canRename && this.approved.phone === (rawPhone ?? '').trim() && this.approved.name === (rawName ?? '').trim());
  }

  reset(): void {
    this.approved = null;
    this.dialogOpen.set(false);
  }
}
