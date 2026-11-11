import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';
import { Dialog } from 'primeng/dialog';
import { LockDateService } from '../../../core/accounting-lock/lock-date.service';
import { AuthService } from '../../../core/auth/auth.service';
import { LanguageService } from '../../shared/services/translation.service';
import { NotaButtonDirective, NotaDialogShellComponent, NotaPageHeaderComponent, NotaStatusPillComponent } from '../../shared/ui';
import { formatNotaNumber } from '../../shared/ui/nota-number';
import { ChecklistItem, ChecklistKey, ClosingHistoryRow, ClosingService, ClosingState } from './closing.service';

/** Where a blocking item is fixed. */
const FIX_LINKS: Partial<Record<ChecklistKey, string>> = { openShifts: '/cashbox', manualDrafts: '/accounting/manual-entry', vatUnfiled: '/accounting/vat', openingNotFinalized: '/accounting/opening' };

/**
 * Stage 22: "إقفال الفترات" (/accounting/closing). The current lock date, the oldest open period with its pre-close checklist (blocking
 * items must be fixed first, warnings are information), a close button with a double confirm, the history of closes and reopens (who,
 * when, the closing entry), and "إعادة فتح" on the latest one (owner only, a reason required). Closing needs accounting.close.
 */
@Component({
  selector: 'app-closing',
  imports: [DatePipe, FormsModule, RouterLink, TranslatePipe, Dialog, NotaButtonDirective, NotaDialogShellComponent, NotaPageHeaderComponent, NotaStatusPillComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cl">
      <nota-page-header [title]="'closing.title' | translate" [subtitle]="'closing.subtitle' | translate" />

      @if (loadError()) { <p class="nota-error" role="alert" data-test="load-error">{{ 'closing.loadFailed' | translate }}</p> }

      @if (state(); as s) {
        <section class="nota-card cl__lock" data-test="lock">
          <span class="nota-label">{{ 'closing.lockedThrough' | translate }}</span>
          @if (s.lockedThrough) { <strong class="cl__date nota-num" dir="ltr" data-test="locked-through">{{ s.lockedThrough }}</strong> }
          @else { <strong data-test="not-locked">{{ 'closing.nothingClosed' | translate }}</strong> }
          <span class="cl__muted">{{ 'closing.settingsLine' | translate: { frequency: ('closing.frequency.' + s.settings.frequency | translate), month: s.settings.fiscalYearStartMonth } }}</span>
        </section>

        <section class="nota-card cl__next" data-test="next">
          <h2 class="cl__h">{{ 'closing.next' | translate }}</h2>
          @if (s.next; as period) {
            <p class="cl__period" data-test="next-period"><strong dir="ltr" class="nota-num">{{ period.label }}</strong>
              <span class="cl__muted nota-num" dir="ltr">{{ period.start }} → {{ period.end }}</span>
              @if (period.yearEnd) { <nota-status-pill variant="info">{{ 'closing.yearEnd' | translate }}</nota-status-pill> }</p>
            @if (!period.ended) { <p class="cl__note" data-test="not-ended">{{ 'closing.notEnded' | translate: { date: period.endsAfter } }}</p> }
            @if (period.yearEnd) { <p class="cl__muted" data-test="year-end-note">{{ 'closing.yearEndNote' | translate }}</p> }

            @if (s.checklist; as list) {
              <h3 class="cl__h3">{{ 'closing.checklist' | translate }}</h3>
              <ul class="cl__list" data-test="checklist">
                @for (item of list.blocking; track item.key) {
                  <li class="cl__item" [class.cl__item--bad]="!item.ok" [attr.data-check]="item.key" [attr.data-ok]="item.ok">
                    <span class="cl__mark" aria-hidden="true">{{ item.ok ? '✓' : '✕' }}</span>
                    <div>
                      <strong>{{ 'closing.checks.' + item.key | translate }}</strong>
                      @if (!item.ok) {
                        <p class="cl__muted">{{ 'closing.fix.' + item.key | translate }}@if (fixLink(item.key); as link) { <a class="cl__link" [routerLink]="link"> {{ 'closing.open' | translate }}</a> }</p>
                        @if (details(item).length) { <ul class="cl__details">@for (line of details(item); track $index) { <li>{{ line }}</li> }</ul> }
                      }
                    </div>
                  </li>
                }
                @for (warning of list.warnings; track warning.key) {
                  <li class="cl__item cl__item--info" [attr.data-warning]="warning.key">
                    <span class="cl__mark" aria-hidden="true">ℹ</span>
                    <div><strong>{{ 'closing.warnings.' + warning.key | translate: { count: warning.count, total: money(warning.total) } }}</strong></div>
                  </li>
                }
              </ul>
            }

            @if (canClose()) {
              <button type="button" notaButton="primary" data-action="close" [disabled]="!period.canClose || busy()" (click)="askClose()">{{ 'closing.close' | translate: { label: ltr(period.label) } }}</button>
            } @else {
              <p class="cl__muted" data-test="no-close-permission">{{ 'closing.noPermission' | translate }}</p>
            }
          } @else { <p class="cl__muted" data-test="nothing-to-close">{{ 'closing.nothingToClose' | translate }}</p> }
        </section>

        @if (error()) { <p class="nota-error" role="alert" data-test="action-error">{{ error() | translate }}</p> }

        <section class="nota-card cl__history" data-test="history">
          <h2 class="cl__h">{{ 'closing.history' | translate }}</h2>
          <div class="nota-table-wrap">
            <table class="nota-table">
              <thead><tr><th>{{ 'closing.period' | translate }}</th><th>{{ 'closing.status' | translate }}</th><th>{{ 'closing.by' | translate }}</th><th>{{ 'closing.when' | translate }}</th><th>{{ 'closing.entry' | translate }}</th><th></th></tr></thead>
              <tbody>
                @for (row of s.history; track row._id) {
                  <tr [attr.data-close]="row.label">
                    <td dir="ltr" class="nota-num"><strong>{{ row.label }}</strong> <small class="cl__muted">{{ row.periodStart }} → {{ row.periodEnd }}</small></td>
                    <td><nota-status-pill [variant]="row.status === 'closed' ? 'ok' : 'neutral'">{{ 'closing.state.' + row.status | translate }}</nota-status-pill></td>
                    <td>{{ row.closedByName || '—' }}</td>
                    <td class="nota-num">{{ row.closedAt | date: 'yyyy-MM-dd HH:mm' }}
                      @if (row.reopenedAt) { <br><small class="cl__muted" data-test="reopen-info">{{ 'closing.reopenedBy' | translate: { name: row.reopenedByName || '—', date: (row.reopenedAt | date: 'yyyy-MM-dd HH:mm'), reason: row.reopenReason } }}</small> }</td>
                    <td>
                      @if (row.entryId) { <a class="cl__link" [routerLink]="['/accounting/journal', row.entryId]" data-link="closing-entry"><span dir="ltr">{{ row.entryNumber }}</span></a> } @else { — }
                      @if (row.reversalEntryId) { <a class="cl__link" [routerLink]="['/accounting/journal', row.reversalEntryId]" data-link="reversal-entry"> {{ 'closing.reversal' | translate }}</a> }
                    </td>
                    <td>@if (isOwner() && row._id === s.latestClosedId) { <button type="button" notaButton="danger" data-action="reopen" (click)="askReopen(row)">{{ 'closing.reopen' | translate }}</button> }</td>
                  </tr>
                } @empty { <tr><td colspan="6" class="cl__muted">{{ 'closing.noHistory' | translate }}</td></tr> }
              </tbody>
            </table>
          </div>
        </section>
      }
    </div>

    <!-- The double confirm: the first click opens this, the second (typing nothing, but reading what will happen) closes. -->
    <p-dialog [visible]="confirmOpen()" (visibleChange)="confirmOpen.set($event)" [modal]="true" [showHeader]="false" [closable]="false" [draggable]="false" [resizable]="false" styleClass="nota-p-dialog">
      <nota-dialog-shell [title]="'closing.confirmTitle' | translate: { label: ltr(state()?.next?.label) }" [closeLabel]="'closing.cancel' | translate" (closed)="confirmOpen.set(false)">
        <p data-test="confirm-text">{{ 'closing.confirmText' | translate: { end: state()?.next?.end } }}</p>
        @if (state()?.next?.yearEnd) { <p class="cl__note" data-test="confirm-year-end">{{ 'closing.confirmYearEnd' | translate }}</p> }
        @if (!sure()) { <p class="cl__muted">{{ 'closing.confirmHint' | translate }}</p> }
        <ng-container notaDialogFooter>
          <button type="button" notaButton (click)="confirmOpen.set(false)">{{ 'closing.cancel' | translate }}</button>
          @if (!sure()) { <button type="button" notaButton="primary" data-action="confirm-1" (click)="sure.set(true)">{{ 'closing.sure' | translate }}</button> }
          @else { <button type="button" notaButton="danger" data-action="confirm-2" [disabled]="busy()" (click)="close()">{{ 'closing.confirmClose' | translate }}</button> }
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>

    <p-dialog [visible]="reopenOpen()" (visibleChange)="reopenOpen.set($event)" [modal]="true" [showHeader]="false" [closable]="false" [draggable]="false" [resizable]="false" styleClass="nota-p-dialog">
      <nota-dialog-shell [title]="'closing.reopenTitle' | translate: { label: ltr(reopening()?.label) }" [closeLabel]="'closing.cancel' | translate" (closed)="reopenOpen.set(false)">
        <p>{{ 'closing.reopenText' | translate }}</p>
        @if (reopening()?.entryNumber) { <p class="cl__note" data-test="reopen-reverses">{{ 'closing.reopenReverses' | translate: { number: reopening()?.entryNumber } }}</p> }
        <label class="cl__field"><span class="nota-label">{{ 'closing.reason' | translate }} *</span>
          <textarea class="nota-textarea" rows="3" maxlength="500" data-field="reopen-reason" [ngModel]="reason()" (ngModelChange)="reason.set($event)"></textarea></label>
        @if (reopenError()) { <p class="nota-error" role="alert" data-test="reopen-error">{{ reopenError() | translate }}</p> }
        <ng-container notaDialogFooter>
          <button type="button" notaButton (click)="reopenOpen.set(false)">{{ 'closing.cancel' | translate }}</button>
          <button type="button" notaButton="danger" data-action="confirm-reopen" [disabled]="reason().trim().length < 3 || busy()" (click)="reopen()">{{ 'closing.reopen' | translate }}</button>
        </ng-container>
      </nota-dialog-shell>
    </p-dialog>
  `,
  styles: `
    .cl { display: flex; flex-direction: column; gap: 16px; }
    .cl__lock, .cl__next, .cl__history { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    .cl__lock { flex-direction: row; flex-wrap: wrap; align-items: center; gap: 12px; }
    .cl__date { font-size: 20px; }
    .cl__h { margin: 0; font-size: 18px; } .cl__h3 { margin: 0; font-size: 15px; }
    .cl__muted { color: var(--text-muted); font-size: 13px; margin: 0; }
    .cl__period { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: 18px; }
    .cl__note { margin: 0; padding: 10px 14px; border-radius: var(--radius-control); background: var(--info-soft); color: var(--info-text); font-size: 13px; }
    .cl__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .cl__item { display: flex; gap: 10px; padding: 10px 12px; border-radius: var(--radius-control); background: var(--brand-soft); color: var(--brand-strong-text); }
    .cl__item--bad { background: var(--danger-soft); color: var(--danger-text); }
    .cl__item--info { background: var(--info-soft); color: var(--info-text); }
    .cl__mark { font-weight: 800; width: 20px; text-align: center; }
    .cl__details { margin: 4px 0 0; padding-inline-start: 18px; font-size: 13px; }
    .cl__link { color: var(--brand); }
    .cl__field { display: flex; flex-direction: column; gap: 4px; }
  `,
})
export class ClosingComponent implements OnInit {
  private readonly service = inject(ClosingService);
  private readonly auth = inject(AuthService);
  private readonly lock = inject(LockDateService);
  private readonly language = inject(LanguageService);

  readonly state = signal<ClosingState | null>(null);
  readonly loadError = signal(false);
  readonly error = signal('');
  readonly busy = signal(false);
  readonly confirmOpen = signal(false);
  readonly sure = signal(false);
  readonly reopenOpen = signal(false);
  readonly reopening = signal<ClosingHistoryRow | null>(null);
  readonly reason = signal('');
  readonly reopenError = signal('');

  readonly canClose = computed(() => this.auth.has('accounting.close'));
  readonly isOwner = computed(() => this.auth.user()?.role === 'owner' && this.auth.has('accounting.close'));

  ngOnInit(): void { this.load(); }

  load(): void {
    this.service.state().subscribe({
      next: (state) => { this.state.set(state); this.lock.set(state.lockedThrough); this.loadError.set(false); },
      error: () => this.loadError.set(true),
    });
  }

  /** A period label such as 2026-10 keeps its order inside Arabic text (a left-to-right isolate). */
  protected ltr(value: string | null | undefined): string { return value ? `⁦${value}⁩` : ''; }

  protected money(value: number): string { return formatNotaNumber(value, this.language.selectedLanguage(), 'money'); }

  protected fixLink(key: ChecklistKey): string | null { return FIX_LINKS[key] ?? null; }

  /** The lines under a failed item: shifts, drafts, failing health checks, unfiled VAT months. */
  protected details(item: ChecklistItem): string[] {
    const rows = (item.items ?? []) as unknown[];
    return rows.map((row) => {
      if (typeof row === 'string') return row;
      const entry = row as Record<string, unknown>;
      if (item.key === 'openShifts') return `${entry['number'] ?? ''}${entry['box'] ? ` · ${entry['box']}` : ''}`;
      if (item.key === 'manualDrafts') return `${String(entry['date'] ?? '').slice(0, 10)} · ${entry['memo'] || '—'}`;
      if (item.key === 'health') return `${entry['name']}: ${this.money(Number(entry['difference'] ?? 0))}`;
      return JSON.stringify(entry);
    });
  }

  askClose(): void { this.sure.set(false); this.error.set(''); this.confirmOpen.set(true); }

  close(): void {
    const next = this.state()?.next;
    if (!next || !this.sure()) return;
    this.busy.set(true);
    this.service.close(next.end).subscribe({
      next: (done) => { this.busy.set(false); this.confirmOpen.set(false); this.lock.set(done.lockedThrough); this.load(); },
      error: (error) => { this.busy.set(false); this.confirmOpen.set(false); this.error.set(this.messageOf(error)); this.load(); },
    });
  }

  askReopen(row: ClosingHistoryRow): void { this.reopening.set(row); this.reason.set(''); this.reopenError.set(''); this.reopenOpen.set(true); }

  reopen(): void {
    if (this.reason().trim().length < 3) return;
    this.busy.set(true);
    this.service.reopen(this.reason().trim()).subscribe({
      next: (done) => { this.busy.set(false); this.reopenOpen.set(false); this.lock.set(done.lockedThrough); this.load(); },
      error: (error) => { this.busy.set(false); this.reopenError.set(this.messageOf(error)); },
    });
  }

  private messageOf(error: unknown): string {
    const body = error instanceof HttpErrorResponse ? (error.error as { message?: string } | null) : null;
    return body?.message || 'closing.errors.generic';
  }
}
