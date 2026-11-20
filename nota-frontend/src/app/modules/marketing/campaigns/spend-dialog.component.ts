import { ChangeDetectionStrategy, Component, computed, effect, inject, input, model, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslatePipe } from '@ngx-translate/core';
import { Dialog } from 'primeng/dialog';
import { LockDateService } from '../../../core/accounting-lock/lock-date.service';
import { LayoutService } from '../../../core/layout/layout.service';
import { localDateKey } from '../../../core/utilities/local-date';
import { ExpensesService } from '../../cashbox/expenses.service';
import { PaymentBoxSelectComponent } from '../../cashbox/payment-box-select.component';
import { PaymentBoxService } from '../../cashbox/payment-box.service';
import { MobSheetComponent } from '../../mobile/mob-sheet.component';
import { VatSettingsService } from '../../shop-profile/services/vat-settings.service';
import { NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NotaLockBannerComponent, NotaLockedDateDirective } from '../../shared/ui';
import { MarketingService } from '../marketing.service';

const KNOWN_ERRORS = ['INSUFFICIENT_BALANCE', 'NO_OPEN_SHIFT', 'BOX_INACTIVE', 'INVALID_CATEGORY', 'BOX_NOT_ALLOWED', 'INVALID_CAMPAIGN'];

/**
 * Online Stage 7A: «تسجيل مصروف إعلان». It is an ordinary expense (POST /api/expenses) in the «دعاية وإعلان» category, from the chosen box,
 * with the local date and the optional VAT, plus the campaign id as a label. Nothing is posted differently from the expenses page.
 */
@Component({
  selector: 'app-spend-dialog',
  imports: [FormsModule, TranslatePipe, Dialog, NotaButtonDirective, NotaDialogShellComponent, NotaFormFieldComponent, NotaLockBannerComponent, NotaLockedDateDirective, PaymentBoxSelectComponent, MobSheetComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (layout.isMobile()) {
      <nota-mob-sheet [(open)]="visible" [title]="'marketing.spend.title' | translate">
        <form (ngSubmit)="save()" novalidate>
          <label class="m-field">{{ 'marketing.spend.amount' | translate }} *
            <input class="m-input nota-num" type="number" inputmode="decimal" min="0" step="0.01" name="amountM" data-test="spend-amount" [ngModel]="amount()" (ngModelChange)="amount.set($event)" />
          </label>
          @if (vatContext()) {
            <label class="m-field">{{ 'vat.expense.amount' | translate }}
              <input class="m-input nota-num" type="number" inputmode="decimal" min="0" step="0.01" name="vatM" data-test="spend-vat" [ngModel]="vatAmount()" (ngModelChange)="vatAmount.set($event === '' ? null : $event)" />
              @if (vatInvalid()) { <span class="nota-error">{{ 'vat.expense.invalid' | translate }}</span> }
            </label>
          }
          <nota-payment-box-select labelKey="cashbox.expenses.fromBox" />
          <label class="m-field">{{ 'cashbox.expenses.date' | translate }}
            <input class="m-input nota-num" type="date" notaLockedDate name="dateM" data-test="spend-date" [ngModel]="date()" (ngModelChange)="date.set($event)" />
            <nota-lock-banner [selected]="date()" />
          </label>
          <label class="m-field">{{ 'cashbox.expenses.note' | translate }}
            <input class="m-input" type="text" name="noteM" data-test="spend-note" [ngModel]="note()" (ngModelChange)="note.set($event)" />
          </label>
          @if (error()) { <p class="nota-error m-note" role="alert" data-test="spend-error">{{ error() | translate }}</p> }
          <div class="m-actions">
            <button type="button" class="m-btn" (click)="visible.set(false)">{{ 'mobile.common.cancel' | translate }}</button>
            <button type="submit" class="m-btn m-btn--primary" data-action="save-spend" [disabled]="!canSave()">{{ 'marketing.spend.record' | translate }}</button>
          </div>
        </form>
      </nota-mob-sheet>
    } @else {
      <p-dialog [(visible)]="visible" [modal]="true" [showHeader]="false" [closable]="false" [draggable]="false" [resizable]="false" styleClass="nota-p-dialog">
        <nota-dialog-shell [title]="'marketing.spend.title' | translate" [closeLabel]="'mobile.common.close' | translate" (closed)="visible.set(false)">
          <form class="spend" (ngSubmit)="save()" novalidate>
            <nota-form-field [label]="'marketing.spend.amount' | translate" forId="spAmount">
              <input id="spAmount" class="nota-input nota-num" type="number" min="0" step="0.01" name="amount" data-test="spend-amount" [ngModel]="amount()" (ngModelChange)="amount.set($event)" />
            </nota-form-field>
            @if (vatContext()) {
              <nota-form-field [label]="'vat.expense.amount' | translate" forId="spVat" [hint]="'vat.expense.hint' | translate" [error]="vatInvalid() ? ('vat.expense.invalid' | translate) : null">
                <input id="spVat" class="nota-input nota-num" type="number" min="0" step="0.01" name="vatAmount" data-test="spend-vat" [ngModel]="vatAmount()" (ngModelChange)="vatAmount.set($event === '' ? null : $event)" />
              </nota-form-field>
            }
            <nota-payment-box-select labelKey="cashbox.expenses.fromBox" />
            <nota-form-field [label]="'cashbox.expenses.date' | translate" forId="spDate">
              <input id="spDate" class="nota-input nota-num" type="date" notaLockedDate name="date" data-test="spend-date" [ngModel]="date()" (ngModelChange)="date.set($event)" />
              <nota-lock-banner [selected]="date()" />
            </nota-form-field>
            <nota-form-field [label]="'cashbox.expenses.note' | translate" forId="spNote">
              <input id="spNote" class="nota-input" type="text" name="note" data-test="spend-note" [ngModel]="note()" (ngModelChange)="note.set($event)" />
            </nota-form-field>
            @if (error()) { <p class="nota-error" role="alert" data-test="spend-error">{{ error() | translate }}</p> }
            <button type="submit" hidden></button>
          </form>
          <ng-container notaDialogFooter>
            <button type="button" notaButton (click)="visible.set(false)">{{ 'mobile.common.cancel' | translate }}</button>
            <button type="button" notaButton="primary" data-action="save-spend" [disabled]="!canSave()" (click)="save()">{{ 'marketing.spend.record' | translate }}</button>
          </ng-container>
        </nota-dialog-shell>
      </p-dialog>
    }
  `,
  styles: [`.spend { display: grid; gap: 12px; min-width: min(420px, 80vw); }`],
})
export class SpendDialogComponent {
  readonly campaignId = input.required<string>();
  readonly campaignName = input('');
  readonly visible = model(false);
  readonly saved = output<void>();

  protected readonly layout = inject(LayoutService);
  protected readonly payment = inject(PaymentBoxService);
  private readonly lock = inject(LockDateService);
  private readonly vatSettings = inject(VatSettingsService);
  private readonly expenses = inject(ExpensesService);
  private readonly marketing = inject(MarketingService);

  protected readonly amount = signal<number | null>(null);
  protected readonly date = signal(localDateKey());
  protected readonly note = signal('');
  protected readonly vatAmount = signal<number | null>(null);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  private readonly accountId = signal('');

  protected readonly vatContext = computed(() => this.vatSettings.contextFor(this.date()));
  protected readonly vatInvalid = computed(() => (this.vatAmount() ?? 0) < 0 || ((this.vatAmount() ?? 0) >= (this.amount() ?? 0) && (this.vatAmount() ?? 0) > 0));
  protected readonly canSave = computed(() => Boolean(this.accountId()) && (this.amount() ?? 0) > 0 && !this.saving() && !this.payment.needsShift()
    && !(this.vatContext() && this.vatInvalid()) && !this.lock.isLocked(this.date()));

  constructor() {
    // Opening the dialog refreshes what it depends on (boxes, VAT, closed periods) and finds the «دعاية وإعلان» category.
    effect(() => {
      if (!this.visible()) return;
      this.vatSettings.refresh();
      this.lock.refresh();
      this.payment.load();
      this.error.set('');
      this.date.set(localDateKey());
      this.marketing.adCategory().subscribe({
        next: (category) => this.accountId.set(category.accountId),
        error: () => { this.accountId.set(''); this.error.set('marketing.spend.errors.category'); },
      });
    });
  }

  protected save(): void {
    if (!this.canSave()) return;
    this.saving.set(true);
    this.error.set('');
    const note = this.note().trim() || this.campaignName();
    this.expenses.create(this.payment.withBox({
      accountId: this.accountId(), amount: this.amount() as number, date: this.date(), campaignId: this.campaignId(),
      ...(note ? { note } : {}),
      ...(this.vatContext() && (this.vatAmount() ?? 0) > 0 ? { vatAmount: this.vatAmount() as number } : {}),
    })).subscribe({
      next: () => {
        this.saving.set(false);
        this.amount.set(null); this.note.set(''); this.vatAmount.set(null);
        this.visible.set(false);
        this.payment.load(true);
        this.saved.emit();
      },
      error: (response) => {
        this.saving.set(false);
        const code = response?.error?.code;
        this.error.set(KNOWN_ERRORS.includes(code) ? (code === 'INVALID_CAMPAIGN' ? 'marketing.spend.errors.campaign' : `cashbox.errors.${code}`) : 'cashbox.errors.GENERIC');
      },
    });
  }
}
