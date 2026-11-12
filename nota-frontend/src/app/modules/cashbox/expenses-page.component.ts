import { LockDateService } from '../../core/accounting-lock/lock-date.service';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { Dialog } from 'primeng/dialog';
import { NotaCanDirective } from '../../core/auth/nota-can.directive';
import { LanguageService } from '../shared/services/translation.service';
import { NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NotaMoneyPipe, NotaPageHeaderComponent, NotaLockBannerComponent, NotaLockedDateDirective } from '../shared/ui';
import { CategoryTotal, ExpenseCategory, ExpenseRow, ExpensesResponse } from './cashbox.models';
import { ExpensesService } from './expenses.service';
import { PaymentBoxSelectComponent } from './payment-box-select.component';
import { PaymentBoxService } from './payment-box.service';
import { TranslateService } from '@ngx-translate/core';
import { PrintActionItem, PrintActionsComponent } from '../../core/print/print-actions.component';
import { PrintDataService } from '../../core/print/print-data.service';
import { localDateKey } from '../../core/utilities/local-date';
import { VatSettingsService } from '../shop-profile/services/vat-settings.service';

const thisMonth = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

/**
 * Stage 19: المصروفات (Expenses.dc.html). The form (category, amount, box, date, note), this month's list with its total,
 * and the by-category breakdown of the month before. Filters: month, category, box. expenses.create records;
 * expenses.manage cancels (a reversal with a reason) and manages the categories.
 */
@Component({
  selector: 'app-expenses-page',
  standalone: true,
  imports: [PrintActionsComponent, NotaLockBannerComponent, NotaLockedDateDirective, DatePipe, FormsModule, TranslatePipe, Dialog, NotaCanDirective, NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NotaMoneyPipe, NotaPageHeaderComponent, PaymentBoxSelectComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './expenses-page.component.html',
  styleUrl: './expenses-page.component.scss',
})
export class ExpensesPageComponent implements OnInit {
  /** Stage 22: a date inside a closed period cannot be submitted (the banner explains, the server refuses too). */
  private readonly lock = inject(LockDateService);
  private readonly expenses = inject(ExpensesService);
  private readonly printData = inject(PrintDataService);
  private readonly translate = inject(TranslateService);

  /** Stage 23: the A5 expense voucher (EX). A cancelled expense prints with the "ملغي" watermark and its reason. */
  printItems(row: ExpenseRow): PrintActionItem[] {
    return [{ key: 'expense', label: this.translate.instant('print.voucherA5'), load: async () => {
      const journalNumber = await this.printData.journalNumber(row.number);
      return this.printData.voucher({ type: 'EX', number: row.number, date: row.date, amount: row.amount, party: row.categoryName || '', reason: row.note || null, method: row.boxName, journalNumber, preparedBy: row.createdByName || null, ...(row.status === 'cancelled' ? { cancelled: { reason: row.cancelReason || null } } : {}) });
    } }];
  }
  private readonly language = inject(LanguageService);
  protected readonly payment = inject(PaymentBoxService);
  /** Stage 21: the optional "ضريبة على الفاتورة", only while VAT applies to the expense date. */
  private readonly vatSettings = inject(VatSettingsService);
  readonly vatContext = computed(() => this.vatSettings.contextFor(this.date()));
  readonly vatAmount = signal<number | null>(null);
  /** The VAT must be less than the bill's total (the net must stay above 0). */
  readonly vatInvalid = computed(() => (this.vatAmount() ?? 0) < 0 || (this.vatAmount() ?? 0) >= (this.amount() ?? 0) && (this.vatAmount() ?? 0) > 0);
  readonly vatNet = computed(() => Math.round(((this.amount() ?? 0) - (this.vatAmount() ?? 0)) * 100) / 100);

  readonly categories = signal<ExpenseCategory[]>([]);
  readonly data = signal<ExpensesResponse | null>(null);
  readonly loading = signal(true);
  readonly loadError = signal(false);

  // Filters
  readonly month = signal(thisMonth());
  readonly filterCategory = signal('');
  readonly filterBox = signal('');

  // Form
  readonly category = signal('');
  readonly amount = signal<number | null>(null);
  readonly date = signal(localDateKey());
  readonly note = signal('');
  readonly saving = signal(false);
  readonly formError = signal('');

  // Cancel
  readonly cancelTarget = signal<ExpenseRow | null>(null);
  readonly cancelReason = signal('');
  readonly cancelError = signal('');

  // Categories
  readonly manageOpen = signal(false);
  readonly newNameAr = signal('');
  readonly newNameEn = signal('');
  readonly categoryError = signal('');

  readonly activeCategories = computed(() => this.categories().filter((category) => category.isActive));
  readonly maxCategory = computed(() => Math.max(1, ...(this.data()?.previous.byCategory ?? []).map((row) => row.total)));
  readonly canSave = computed(() => Boolean(this.category()) && (this.amount() ?? 0) > 0 && !this.saving() && !this.payment.needsShift() && !(this.vatContext() && this.vatInvalid()) && !this.lock.isLocked(this.date()));

  ngOnInit(): void {
    // Stage 21 review: another PC may have changed the VAT settings since this one signed in.
    this.vatSettings.refresh();
    // Stage 22 review: another PC may have closed a period since this one signed in.
    this.lock.refresh();
    this.payment.load();
    this.loadCategories();
    this.load();
  }

  isEnglish(): boolean {
    return this.language.selectedLanguage() === 'en';
  }

  categoryLabel(category: Pick<ExpenseCategory, 'nameAr' | 'nameEn'> | Pick<CategoryTotal, 'nameAr' | 'nameEn'>): string {
    return (this.isEnglish() ? category.nameEn : category.nameAr) || category.nameAr || category.nameEn || '';
  }

  loadCategories(): void {
    this.expenses.categories().subscribe({ next: (response) => this.categories.set(response.data) });
  }

  load(): void {
    this.loading.set(true);
    this.loadError.set(false);
    this.expenses.list({ month: this.month(), category: this.filterCategory() || undefined, box: this.filterBox() || undefined }).subscribe({
      next: (response) => { this.data.set(response); this.loading.set(false); },
      error: () => { this.loadError.set(true); this.loading.set(false); },
    });
  }

  barWidth(row: CategoryTotal): string {
    return `${Math.round((row.total / this.maxCategory()) * 100)}%`;
  }

  save(): void {
    if (!this.canSave()) return;
    this.saving.set(true);
    this.formError.set('');
    this.expenses.create(this.payment.withBox({
      accountId: this.category(), amount: this.amount() as number,
      ...(this.date() ? { date: this.date() } : {}), ...(this.note().trim() ? { note: this.note().trim() } : {}),
      ...(this.vatContext() && (this.vatAmount() ?? 0) > 0 ? { vatAmount: this.vatAmount() as number } : {}),
    })).subscribe({
      next: () => {
        this.saving.set(false);
        this.amount.set(null); this.note.set(''); this.vatAmount.set(null);
        this.payment.load(true);
        this.load();
      },
      error: (response) => {
        this.saving.set(false);
        const code = response?.error?.code;
        this.formError.set(`cashbox.errors.${['INSUFFICIENT_BALANCE', 'NO_OPEN_SHIFT', 'BOX_INACTIVE', 'INVALID_CATEGORY', 'BOX_NOT_ALLOWED'].includes(code) ? code : 'GENERIC'}`);
      },
    });
  }

  startCancel(row: ExpenseRow): void {
    this.cancelTarget.set(row);
    this.cancelReason.set('');
    this.cancelError.set('');
  }

  confirmCancel(): void {
    const row = this.cancelTarget();
    const reason = this.cancelReason().trim();
    if (!row || reason.length < 3) return;
    this.expenses.cancel(row._id, reason).subscribe({
      next: () => { this.cancelTarget.set(null); this.load(); },
      error: () => this.cancelError.set('cashbox.expenses.cancelFailed'),
    });
  }

  addCategory(): void {
    const nameAr = this.newNameAr().trim();
    if (!nameAr) return;
    this.categoryError.set('');
    this.expenses.createCategory({ nameAr, ...(this.newNameEn().trim() ? { nameEn: this.newNameEn().trim() } : {}) }).subscribe({
      next: () => { this.newNameAr.set(''); this.newNameEn.set(''); this.loadCategories(); },
      error: () => this.categoryError.set('cashbox.expenses.categoryFailed'),
    });
  }

  renameCategory(category: ExpenseCategory, nameAr: string): void {
    const trimmed = nameAr.trim();
    if (!trimmed || trimmed === category.nameAr) return;
    // A category created with one name has the same name in English: keep them in step.
    const payload: { nameAr: string; nameEn?: string } = { nameAr: trimmed };
    if (category.nameEn === category.nameAr) payload.nameEn = trimmed;
    this.expenses.updateCategory(category._id, payload).subscribe({
      next: () => this.loadCategories(),
      error: () => this.categoryError.set('cashbox.expenses.categoryFailed'),
    });
  }

  deactivateCategory(category: ExpenseCategory): void {
    this.categoryError.set('');
    this.expenses.updateCategory(category._id, { isActive: !category.isActive }).subscribe({
      next: () => this.loadCategories(),
      error: (response) => this.categoryError.set(response?.error?.code === 'CATEGORY_HAS_LINES' ? 'cashbox.expenses.categoryHasLines' : 'cashbox.expenses.categoryFailed'),
    });
  }

  /** Filter list of boxes: every box the user may pick (the payment list). */
  boxesForFilter() {
    return this.payment.boxes();
  }
}
