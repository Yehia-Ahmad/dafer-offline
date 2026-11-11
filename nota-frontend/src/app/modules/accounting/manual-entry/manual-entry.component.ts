import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { Dialog } from 'primeng/dialog';
import { HttpErrorResponse } from '@angular/common/http';
import { LockDateService } from '../../../core/accounting-lock/lock-date.service';
import { localDateKey } from '../../../core/utilities/local-date';
import { LanguageService } from '../../shared/services/translation.service';
import { NotaButtonDirective, NotaDialogShellComponent, NotaLockBannerComponent, NotaLockedDateDirective, NotaPageHeaderComponent, NotaStatusPillComponent } from '../../shared/ui';
import { formatNotaNumber } from '../../shared/ui/nota-number';
import { ManualAccountOption, ManualEntry, ManualEntryPayload, ManualEntryService, PartyKind, PartyOption } from './manual-entry.service';

/** A line as the form edits it: amounts as text, so a half-typed number is not lost. */
interface FormLine { key: number; accountId: string; description: string; debit: string; credit: string; partyId: string }

let lineKey = 0;
const blankLine = (): FormLine => ({ key: ++lineKey, accountId: '', description: '', debit: '', credit: '', partyId: '' });
const round2 = (value: number) => Math.round(value * 100) / 100;
const amountOf = (text: string) => { const value = Number(text); return Number.isFinite(value) && value > 0 ? round2(value) : 0; };

/**
 * Stage 22: "قيد يدوي" (/accounting/manual-entry[/:id], accounting.manage). Date, memo, lines (account, description, debit/credit, a party
 * on customers/suppliers lines), live totals and a balanced indicator, "حفظ كمسودة" and "ترحيل القيد". A draft is editable and deletable
 * and is nowhere in the books; posting validates it and creates the journal entry. Accounts with their own screens (boxes, inventory,
 * VAT, the invoice accounts) are shown but disabled with the reason; a customer line is a CREDIT only (a write-off). A posted entry
 * is never edited: "قيد عكسي" (a reason required) posts the mirror.
 */
@Component({
  selector: 'app-manual-entry',
  imports: [DatePipe, FormsModule, RouterLink, TranslatePipe, Dialog, NotaButtonDirective, NotaDialogShellComponent, NotaLockBannerComponent, NotaLockedDateDirective, NotaPageHeaderComponent, NotaStatusPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="me">
      <nota-page-header [title]="'manual.title' | translate" [subtitle]="'manual.subtitle' | translate" [backLink]="'/accounting/accounts'" [backLabel]="'manual.back' | translate" />

      @if (loadError()) { <p class="nota-error" role="alert" data-test="load-error">{{ 'manual.loadFailed' | translate }}</p> }

      <section class="nota-card me__form" data-test="form">
        <div class="me__meta">
          <div class="me__field"><span class="nota-label">{{ 'manual.number' | translate }}</span>
            <output class="nota-input nota-num me__number" data-test="number" dir="ltr">{{ entry()?.number || ('manual.numberOnPost' | translate) }}</output></div>
          <label class="me__field"><span class="nota-label">{{ 'manual.date' | translate }} *</span>
            <input class="nota-input nota-num" type="date" notaLockedDate data-test="date" [max]="today" [disabled]="readOnly()" [ngModel]="date()" (ngModelChange)="date.set($event)" /></label>
          <label class="me__field me__field--wide"><span class="nota-label">{{ 'manual.memo' | translate }} *</span>
            <input class="nota-input" type="text" maxlength="500" data-test="memo" [disabled]="readOnly()" [ngModel]="memo()" (ngModelChange)="memo.set($event)" [placeholder]="'manual.memoHint' | translate" /></label>
        </div>
        @if (!readOnly()) { <nota-lock-banner [selected]="date()" /> }

        <div class="nota-table-wrap">
          <table class="nota-table me__lines" data-test="lines">
            <thead><tr>
              <th>{{ 'manual.account' | translate }}</th><th>{{ 'manual.description' | translate }}</th>
              <th class="nota-num">{{ 'accounting.debit' | translate }}</th><th class="nota-num">{{ 'accounting.credit' | translate }}</th><th></th>
            </tr></thead>
            <tbody>
              @for (row of lines(); track row.key; let index = $index) {
                <tr class="me__line" [class.me__line--bad]="badLine() === index + 1" [attr.data-line]="index + 1">
                  <td>
                    <select class="nota-select me__account" data-field="account" [disabled]="readOnly()" [ngModel]="row.accountId" (ngModelChange)="patch(row.key, { accountId: $event, partyId: '' })">
                      <option value="">{{ 'manual.pickAccount' | translate }}</option>
                      @for (option of options(); track option._id) {
                        <option [value]="option._id" [disabled]="!!option.blocked" [attr.data-blocked]="option.blocked?.code">{{ option.code }} · {{ accountName(option) }}@if (option.blocked) { — {{ option.blocked.message }} }</option>
                      }
                    </select>
                    @if (partyKind(row); as kind) {
                      <select class="nota-select me__party" data-field="party" [disabled]="readOnly()" [ngModel]="row.partyId" (ngModelChange)="patch(row.key, { partyId: $event })">
                        <option value="">{{ (kind === 'customer' ? 'manual.pickCustomer' : 'manual.pickSupplier') | translate }}</option>
                        @for (party of parties(kind); track party._id) { <option [value]="party._id">{{ party.name }}</option> }
                      </select>
                    }
                    @if (lineError(row, index); as problem) { <p class="nota-error" role="alert" data-test="line-error">{{ problem | translate }}</p> }
                  </td>
                  <td><input class="nota-input" type="text" maxlength="200" data-field="description" [disabled]="readOnly()" [ngModel]="row.description" (ngModelChange)="patch(row.key, { description: $event })" /></td>
                  <td><input class="nota-input nota-num" type="number" min="0" step="0.01" inputmode="decimal" data-field="debit" [disabled]="readOnly()" [ngModel]="row.debit" (ngModelChange)="patch(row.key, { debit: $event === null ? '' : String($event), credit: $event ? '' : row.credit })" /></td>
                  <td><input class="nota-input nota-num" type="number" min="0" step="0.01" inputmode="decimal" data-field="credit" [disabled]="readOnly()" [ngModel]="row.credit" (ngModelChange)="patch(row.key, { credit: $event === null ? '' : String($event), debit: $event ? '' : row.debit })" /></td>
                  <td>@if (!readOnly() && lines().length > 2) { <button type="button" notaButton="danger" data-action="remove-line" [attr.aria-label]="'manual.removeLine' | translate" (click)="removeLine(row.key)">×</button> }</td>
                </tr>
              }
            </tbody>
            <tfoot><tr class="me__totals">
              <td>@if (!readOnly()) { <button type="button" notaButton data-action="add-line" (click)="addLine()">{{ 'manual.addLine' | translate }}</button> }</td>
              <td>{{ 'manual.totals' | translate }}</td>
              <td class="nota-num" data-total="debit">{{ money(totals().debit) }}</td><td class="nota-num" data-total="credit">{{ money(totals().credit) }}</td><td></td>
            </tr></tfoot>
          </table>
        </div>

        <p class="me__balance" [class.me__balance--ok]="balanced()" [class.me__balance--bad]="!balanced()" role="status" data-test="balanced">
          @if (balanced()) { {{ 'manual.balanced' | translate }} } @else { {{ 'manual.unbalanced' | translate: { diff: money(totals().diff) } }} }
        </p>

        @if (error()) { <p class="nota-error" role="alert" data-test="action-error">{{ error() | translate }}</p> }

        @if (!readOnly()) {
          <div class="me__actions">
            <button type="button" notaButton data-action="save-draft" [disabled]="busy()" (click)="saveDraft()">{{ 'manual.saveDraft' | translate }}</button>
            <button type="button" notaButton="primary" data-action="post" [disabled]="!canPost() || busy()" (click)="post()">{{ 'manual.post' | translate }}</button>
            @if (entry()?.status === 'draft') { <button type="button" notaButton="danger" data-action="delete-draft" [disabled]="busy()" (click)="deleteDraft()">{{ 'manual.deleteDraft' | translate }}</button> }
          </div>
          <p class="me__hint">{{ 'manual.afterPost' | translate }}</p>
        }
      </section>

      @if (entry(); as posted) {
        @if (posted.status === 'posted') {
          <section class="nota-card me__posted" data-test="posted">
            <h2 class="me__h"><span dir="ltr" class="nota-num">{{ posted.number }}</span> <nota-status-pill [variant]="posted.reversal ? 'neutral' : 'ok'">{{ (posted.reversal ? 'manual.status.reversed' : 'manual.status.posted') | translate }}</nota-status-pill></h2>
            @if (posted.entryId) { <p><a class="me__link" [routerLink]="['/accounting/journal', posted.entryId]" data-link="entry">{{ 'accounting.viewEntry' | translate }}</a></p> }
            @if (posted.allocations?.length) {
              <p class="me__muted" data-test="allocations">{{ 'manual.allocated' | translate: { amount: money(allocatedTotal()), count: posted.allocations?.length } }}</p>
            }
            @if (posted.reversal; as reversal) {
              <p data-test="reversal">{{ 'manual.reversedBy' | translate: { number: reversal.number, date: (reversal.date | date: 'yyyy-MM-dd'), reason: reversal.reason } }}
                @if (reversal.entryId) { <a class="me__link" [routerLink]="['/accounting/journal', reversal.entryId]" data-link="reversal"> {{ 'accounting.viewEntry' | translate }}</a> }</p>
            } @else {
              <button type="button" notaButton="danger" data-action="reverse" (click)="openReverse()">{{ 'manual.reverse' | translate }}</button>
            }
          </section>
        }
      } @else {
        <section class="nota-card me__drafts" data-test="drafts">
          <h2 class="me__h">{{ 'manual.drafts' | translate }}</h2>
          @for (draft of drafts(); track draft._id) {
            <div class="me__draft" [attr.data-draft]="draft._id">
              <a class="me__link" [routerLink]="['/accounting/manual-entry', draft._id]">{{ draft.date | date: 'yyyy-MM-dd' }} · {{ draft.memo || ('manual.noMemo' | translate) }}</a>
              <span class="nota-num">{{ money(draft.totalDebit) }}</span>
            </div>
          } @empty { <p class="me__muted" data-test="no-drafts">{{ 'manual.noDrafts' | translate }}</p> }
        </section>
      }
    </div>

    <p-dialog [visible]="reverseOpen()" (visibleChange)="reverseOpen.set($event)" [modal]="true" [showHeader]="false" [closable]="false" [draggable]="false" [resizable]="false" styleClass="nota-p-dialog">
      <nota-dialog-shell [title]="'manual.reverse' | translate" [closeLabel]="'manual.close' | translate" (closed)="reverseOpen.set(false)">
        <p class="me__muted">{{ 'manual.reverseHint' | translate }}</p>
        <label class="me__field"><span class="nota-label">{{ 'manual.reason' | translate }} *</span>
          <textarea class="nota-textarea" rows="3" maxlength="500" data-field="reason" [ngModel]="reason()" (ngModelChange)="reason.set($event)"></textarea></label>
        <label class="me__field"><span class="nota-label">{{ 'manual.reverseDate' | translate }}</span>
          <input class="nota-input nota-num" type="date" notaLockedDate data-field="reverse-date" [max]="today" [ngModel]="reverseDate()" (ngModelChange)="reverseDate.set($event)" /></label>
        <nota-lock-banner [selected]="reverseDate()" />
        @if (reverseError()) { <p class="nota-error" role="alert" data-test="reverse-error">{{ reverseError() | translate }}</p> }
        <ng-container notaDialogFooter>
          <button type="button" notaButton (click)="reverseOpen.set(false)">{{ 'manual.cancel' | translate }}</button>
          <button type="button" notaButton="danger" data-action="confirm-reverse" [disabled]="reason().trim().length < 3 || busy() || lock.isLocked(reverseDate())" (click)="reverse()">{{ 'manual.reverse' | translate }}</button>
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>
  `,
  styles: `
    .me { display: flex; flex-direction: column; gap: 16px; }
    .me__form, .me__posted, .me__drafts { padding: 16px; display: flex; flex-direction: column; gap: 14px; }
    .me__meta { display: grid; grid-template-columns: 180px 180px 1fr; gap: 12px; }
    .me__field { display: flex; flex-direction: column; gap: 4px; }
    .me__number { display: flex; align-items: center; background: var(--surface-2); color: var(--text-muted); }
    .me__account, .me__party { margin-bottom: 6px; }
    .me__line--bad td { background: var(--danger-soft); }
    .me__totals td { font-weight: 800; border-top: 2px solid var(--text); }
    .me__balance { margin: 0; padding: 10px 14px; border-radius: var(--radius-control); font-size: 14px; }
    .me__balance--ok { background: var(--brand-soft); color: var(--brand-strong-text); }
    .me__balance--bad { background: var(--warning-soft); color: var(--warning-text); }
    .me__actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .me__hint, .me__muted { margin: 0; font-size: 13px; color: var(--text-muted); }
    .me__h { margin: 0; font-size: 18px; display: flex; align-items: center; gap: 10px; }
    .me__link { color: var(--brand); }
    .me__draft { display: flex; justify-content: space-between; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line); }
    @media (max-width: 640px) { .me__meta { grid-template-columns: 1fr; } .me__lines { min-width: 640px; } }
  `,
})
export class ManualEntryComponent implements OnInit {
  private readonly service = inject(ManualEntryService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly language = inject(LanguageService);
  protected readonly lock = inject(LockDateService);

  readonly today = localDateKey();
  protected readonly String = String;

  readonly entry = signal<ManualEntry | null>(null);
  readonly options = signal<ManualAccountOption[]>([]);
  readonly customerList = signal<PartyOption[]>([]);
  readonly supplierList = signal<PartyOption[]>([]);
  readonly drafts = signal<ManualEntry[]>([]);
  readonly date = signal(localDateKey());
  readonly memo = signal('');
  readonly lines = signal<FormLine[]>([blankLine(), blankLine()]);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly badLine = signal(0);
  readonly loadError = signal(false);
  readonly reverseOpen = signal(false);
  readonly reason = signal('');
  readonly reverseDate = signal(localDateKey());
  readonly reverseError = signal('');

  readonly readOnly = computed(() => this.entry()?.status === 'posted');
  private readonly optionById = computed(() => new Map(this.options().map((option) => [option._id, option])));
  readonly totals = computed(() => {
    const rows = this.lines();
    const debit = round2(rows.reduce((sum, row) => sum + amountOf(row.debit), 0));
    const credit = round2(rows.reduce((sum, row) => sum + amountOf(row.credit), 0));
    return { debit, credit, diff: round2(Math.abs(debit - credit)) };
  });
  readonly balanced = computed(() => this.totals().debit > 0 && this.totals().diff === 0);
  readonly allocatedTotal = computed(() => round2((this.entry()?.allocations ?? []).reduce((sum, row) => sum + row.amount, 0)));
  /** Posting needs a date, a memo and a balance (a draft may be saved unbalanced). */
  readonly canPost = computed(() => this.balanced() && !!this.date() && this.memo().trim().length > 0 && !this.lock.isLocked(this.date()) && this.lines().every((row, index) => !this.lineError(row, index)));

  ngOnInit(): void {
    this.service.accounts().subscribe({ next: (rows) => this.options.set(rows), error: () => this.loadError.set(true) });
    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      this.service.get(id).subscribe({ next: (entry) => this.show(entry), error: () => this.loadError.set(true) });
    } else {
      this.service.list('draft').subscribe({ next: (rows) => this.drafts.set(rows), error: () => this.loadError.set(true) });
    }
  }

  private show(entry: ManualEntry): void {
    this.entry.set(entry);
    this.date.set(String(entry.date).slice(0, 10));
    this.memo.set(entry.memo || '');
    const rows = entry.lines.map((row): FormLine => ({
      key: ++lineKey, accountId: row.accountId, description: row.description || '', debit: row.debit ? String(row.debit) : '', credit: row.credit ? String(row.credit) : '', partyId: row.partyId || '',
    }));
    while (rows.length < 2 && entry.status === 'draft') rows.push(blankLine());
    this.lines.set(rows);
    for (const kind of ['customer', 'supplier'] as const) if (entry.lines.some((row) => row.partyType === kind)) this.loadParties(kind);
  }

  protected accountName(option: ManualAccountOption): string {
    return this.language.selectedLanguage() === 'en' ? option.nameEn : option.nameAr;
  }

  protected money(value: number): string {
    return formatNotaNumber(value, this.language.selectedLanguage(), 'money');
  }

  protected partyKind(row: FormLine): PartyKind | null {
    return this.optionById().get(row.accountId)?.needsParty ?? null;
  }

  protected parties(kind: PartyKind): PartyOption[] {
    return kind === 'customer' ? this.customerList() : this.supplierList();
  }

  private loading = new Set<PartyKind>();
  private loadParties(kind: PartyKind): void {
    if (this.loading.has(kind) || this.parties(kind).length) return;
    this.loading.add(kind);
    (kind === 'customer' ? this.service.customers() : this.service.suppliers()).subscribe({
      next: (rows) => (kind === 'customer' ? this.customerList.set(rows) : this.supplierList.set(rows)),
      error: () => this.loading.delete(kind),
    });
  }

  /** The inline rule of a line: a customer line is a credit only, and the party is needed (the server checks all of it again). */
  protected lineError(row: FormLine, index: number): string {
    const option = this.optionById().get(row.accountId);
    void index;
    if (!option) return '';
    if (option.blocked) return '';
    if (option.needsParty === 'customer' && amountOf(row.debit) > 0) return 'manual.errors.customerDebit';
    if (option.needsParty && (amountOf(row.debit) > 0 || amountOf(row.credit) > 0) && !row.partyId) return option.needsParty === 'customer' ? 'manual.errors.customerRequired' : 'manual.errors.supplierRequired';
    return '';
  }

  patch(key: number, change: Partial<FormLine>): void {
    this.badLine.set(0);
    // the party list of a customers/suppliers account is loaded when such an account is picked
    const kind = change.accountId ? this.optionById().get(change.accountId)?.needsParty : null;
    if (kind) this.loadParties(kind);
    this.lines.update((rows) => rows.map((row) => (row.key === key ? { ...row, ...change } : row)));
  }

  addLine(): void { this.lines.update((rows) => [...rows, blankLine()]); }
  removeLine(key: number): void { this.lines.update((rows) => (rows.length > 2 ? rows.filter((row) => row.key !== key) : rows)); }

  private payload(): ManualEntryPayload {
    return {
      date: this.date(),
      memo: this.memo().trim(),
      lines: this.lines().filter((row) => row.accountId).map((row) => {
        const kind = this.optionById().get(row.accountId)?.needsParty ?? null;
        return { accountId: row.accountId, description: row.description.trim(), debit: amountOf(row.debit), credit: amountOf(row.credit), partyType: kind && row.partyId ? kind : null, partyId: kind && row.partyId ? row.partyId : null };
      }),
    };
  }

  private fail(error: unknown, into: (message: string) => void = (message) => this.error.set(message)): void {
    this.busy.set(false);
    const body = error instanceof HttpErrorResponse ? (error.error as { message?: string; line?: number } | null) : null;
    this.badLine.set(body?.line ?? 0);
    into(body?.message || 'manual.errors.generic');
  }

  /** حفظ كمسودة: a new draft, or the changes of this one. The lines may be incomplete or unbalanced. */
  saveDraft(): void {
    if (!this.date()) { this.error.set('manual.errors.dateRequired'); return; }
    this.busy.set(true); this.error.set('');
    const current = this.entry();
    const request = current ? this.service.update(current._id, this.payload()) : this.service.create(this.payload());
    request.subscribe({
      next: (saved) => { this.busy.set(false); this.show(saved); if (!current) this.router.navigate(['/accounting/manual-entry', saved._id], { replaceUrl: true }); },
      error: (error) => this.fail(error),
    });
  }

  /** ترحيل القيد: saves what is on the screen, then posts it (the server validates it again: balance, accounts, parties, the lock). */
  post(): void {
    if (!this.canPost()) return;
    this.busy.set(true); this.error.set('');
    const current = this.entry();
    const saved$ = current ? this.service.update(current._id, this.payload()) : this.service.create(this.payload());
    saved$.subscribe({
      next: (saved) => this.service.post(saved._id).subscribe({
        next: (posted) => { this.busy.set(false); this.show(posted); this.router.navigate(['/accounting/manual-entry', posted._id], { replaceUrl: true }); },
        error: (error) => { this.entry.set(saved); this.fail(error); if (!current) this.router.navigate(['/accounting/manual-entry', saved._id], { replaceUrl: true }); },
      }),
      error: (error) => this.fail(error),
    });
  }

  deleteDraft(): void {
    const current = this.entry();
    if (!current || current.status !== 'draft') return;
    this.busy.set(true);
    this.service.remove(current._id).subscribe({ next: () => { this.busy.set(false); this.router.navigate(['/accounting/manual-entry']); }, error: (error) => this.fail(error) });
  }

  openReverse(): void { this.reason.set(''); this.reverseDate.set(localDateKey()); this.reverseError.set(''); this.reverseOpen.set(true); }

  reverse(): void {
    const current = this.entry();
    if (!current || this.reason().trim().length < 3) return;
    this.busy.set(true); this.reverseError.set('');
    this.service.reverse(current._id, { reason: this.reason().trim(), date: this.reverseDate() }).subscribe({
      next: (done) => { this.busy.set(false); this.reverseOpen.set(false); this.show({ ...current, ...done }); },
      error: (error) => this.fail(error, (message) => this.reverseError.set(message)),
    });
  }
}
